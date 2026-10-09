import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleZoomSession } from './session.js';
import { verifySessionToken } from './session-token.js';
import { FLAG_FALLBACKS } from './flags.js';
import { encryptZoomContext } from './test-helpers.js';

const CLIENT_SECRET = 'test-zoom-client-secret';
const SIGNING_KEY = 'test-session-signing-key';

const env = { ZOOM_CLIENT_SECRET: CLIENT_SECRET, SESSION_SIGNING_KEY: SIGNING_KEY };

// Real clock: handleZoomSession does not take an injectable now, so contexts
// are minted with a genuinely future expiry.
const futureExp = () => Date.now() + 60_000;

const context = (payload) => encryptZoomContext(payload, { secret: CLIENT_SECRET });

function request({ body, headers = {}, method = 'POST' } = {}) {
  return new Request('https://zoom.timer.simple-tech.app/api/zoom/session', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('handleZoomSession', () => {
  it('identifies a user from a context in the body', async () => {
    const res = await handleZoomSession(
      request({ body: { context: context({ uid: 'uid-1', mid: 'm-1', typ: 'meeting', exp: futureExp() }) } }),
      env
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.identified).toBe(true);
    expect(body.uid).toBe('uid-1');
    expect(body.meetingId).toBe('m-1');
    expect(verifySessionToken(body.token, SIGNING_KEY)).toMatchObject({ uid: 'uid-1' });
    // No storage bound and enforcement on: free, so the app can offer the
    // upgrade. `club` is null because this request carried no X-Club header —
    // the answer is the combined one, and there was nothing to combine.
    expect(body.entitlement).toEqual({
      plan: 'free', status: null, entitled: false, currentPeriodEnd: null, cancelAtPeriodEnd: false, source: 'none', club: null,
    });
  });

  it('reports a pro entitlement when a grant exists for the user', async () => {
    const store = new Map([['grant:zoom:uid-1', JSON.stringify({ reason: 'owner' })]]);
    const kvEnv = { ...env, PROFILES: { get: async (k, t) => (store.has(k) ? (t === 'json' ? JSON.parse(store.get(k)) : store.get(k)) : null) } };
    const res = await handleZoomSession(
      request({ body: { context: context({ uid: 'uid-1', exp: futureExp() }) } }),
      kvEnv
    );
    expect((await res.json()).entitlement).toMatchObject({ plan: 'pro', entitled: true, source: 'grant' });
  });

  // The path that needs no SDK capability and no Marketplace change.
  it('identifies a user from the X-Zoom-App-Context header when the body has none', async () => {
    const res = await handleZoomSession(
      request({
        body: {},
        headers: { 'x-zoom-app-context': context({ uid: 'uid-2', exp: futureExp() }) },
      }),
      env
    );
    const body = await res.json();

    expect(body.identified).toBe(true);
    expect(body.uid).toBe('uid-2');
  });

  it('identifies from the header when there is no body at all', async () => {
    const res = await handleZoomSession(
      request({ headers: { 'x-zoom-app-context': context({ uid: 'uid-3', exp: futureExp() }) } }),
      env
    );

    expect((await res.json()).uid).toBe('uid-3');
  });

  it('prefers the body context over the header', async () => {
    const res = await handleZoomSession(
      request({
        body: { context: context({ uid: 'from-body', exp: futureExp() }) },
        headers: { 'x-zoom-app-context': context({ uid: 'from-header', exp: futureExp() }) },
      }),
      env
    );

    expect((await res.json()).uid).toBe('from-body');
  });

  it('reports a guest as unidentified but recognised, and mints no token', async () => {
    const res = await handleZoomSession(
      request({ body: { context: context({ mid: 'm', typ: 'meeting', exp: futureExp() }) } }),
      env
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ identified: false, isGuest: true, flags: FLAG_FALLBACKS });
  });

  // Not knowing who someone is must never look like an error: it is the normal
  // state in local development and on any client that sends us nothing.
  it('answers 200 and stays anonymous when there is no usable context', async () => {
    for (const req of [
      request({ body: {} }),
      request({ body: { context: 'garbage' } }),
      request({ headers: { 'x-zoom-app-context': 'garbage' } }),
      request(),
    ]) {
      const res = await handleZoomSession(req, env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ identified: false, isGuest: false, flags: FLAG_FALLBACKS });
    }
  });

  it('refuses a context encrypted with someone else\'s secret', async () => {
    const foreign = encryptZoomContext({ uid: 'attacker', exp: futureExp() }, { secret: 'wrong' });
    const res = await handleZoomSession(request({ body: { context: foreign } }), env);

    expect((await res.json()).identified).toBe(false);
  });

  it('refuses an expired context', async () => {
    const stale = context({ uid: 'uid-1', exp: Date.now() - 1 });
    const res = await handleZoomSession(request({ body: { context: stale } }), env);

    expect((await res.json()).identified).toBe(false);
  });

  // Identity is useful for analytics before the signing key exists, so Phase 1
  // can deploy ahead of the storage secret.
  it('still identifies, with a null token, when SESSION_SIGNING_KEY is unset', async () => {
    const res = await handleZoomSession(
      request({ body: { context: context({ uid: 'uid-1', exp: futureExp() }) } }),
      { ZOOM_CLIENT_SECRET: CLIENT_SECRET }
    );
    const body = await res.json();

    expect(body.identified).toBe(true);
    expect(body.uid).toBe('uid-1');
    expect(body.token).toBeNull();
  });

  it('identifies nobody when ZOOM_CLIENT_SECRET is unset', async () => {
    const res = await handleZoomSession(
      request({ body: { context: context({ uid: 'uid-1', exp: futureExp() }) } }),
      { SESSION_SIGNING_KEY: SIGNING_KEY }
    );

    expect((await res.json()).identified).toBe(false);
  });

  it('rejects non-POST methods', async () => {
    const res = await handleZoomSession(request({ method: 'GET' }), env);

    expect(res.status).toBe(405);
  });

  describe('release flags', () => {
    const ctx = { waitUntil: () => {} };
    const identifiedReq = () => request({ body: { context: context({ uid: 'uid-1', exp: futureExp() }) } });
    const guestReq = () => request({ body: { context: context({ mid: 'm', exp: futureExp() }) } });
    const anonymousReq = () => request({ body: {} });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // Every branch, so the client always ends the load knowing its flags —
    // including the loads where it will never know who this is.
    it('come back in every branch', async () => {
      for (const FLAGS_FORCE of ['1', '0']) {
        const expected = Object.fromEntries(Object.keys(FLAG_FALLBACKS).map((key) => [key, FLAGS_FORCE === '1']));
        for (const req of [identifiedReq(), guestReq(), anonymousReq()]) {
          const body = await (await handleZoomSession(req, { ...env, FLAGS_FORCE }, ctx)).json();
          expect(body.flags).toEqual(expected);
        }
      }
    });

    it('fall back to the checked-in values when nothing is configured', async () => {
      const body = await (await handleZoomSession(identifiedReq(), env, ctx)).json();
      expect(body.flags).toEqual(FLAG_FALLBACKS);
    });

    // Targeting is by uid for identified users; guests and anonymous loads all
    // ask as the one shared anonymous id.
    it('are asked for as zoom:<uid> when identified, and as anonymous otherwise', async () => {
      const asked = [];
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        const { distinct_id: id } = JSON.parse(init.body);
        asked.push(id);
        return new Response(JSON.stringify({ flags: { pro: { key: 'pro', enabled: id === 'zoom:uid-1' } } }));
      }));
      const posthogEnv = { ...env, POSTHOG_API_KEY: 'phc_test' };

      expect((await (await handleZoomSession(identifiedReq(), posthogEnv, ctx)).json()).flags).toEqual({ ...FLAG_FALLBACKS, pro: true });
      expect((await (await handleZoomSession(guestReq(), posthogEnv, ctx)).json()).flags).toEqual({ ...FLAG_FALLBACKS, pro: false });
      expect((await (await handleZoomSession(anonymousReq(), posthogEnv, ctx)).json()).flags).toEqual({ ...FLAG_FALLBACKS, pro: false });
      expect(asked).toEqual(['zoom:uid-1', 'anonymous', 'anonymous']);
    });

    it('do not cost the identified user their entitlement when PostHog is down', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const body = await (await handleZoomSession(identifiedReq(), { ...env, POSTHOG_API_KEY: 'phc_test' }, ctx)).json();
        expect(body.identified).toBe(true);
        expect(body.entitlement).toMatchObject({ plan: 'free' });
        expect(body.flags).toEqual(FLAG_FALLBACKS);
      } finally {
        warn.mockRestore();
      }
    });
  });

  // Per-user payload: the edge must never hand one person's uid to the next caller.
  it('marks every response private and uncacheable', async () => {
    for (const req of [
      request({ body: { context: context({ uid: 'uid-1', exp: futureExp() }) } }),
      request({ body: {} }),
      request({ method: 'GET' }),
    ]) {
      const res = await handleZoomSession(req, env);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    }
  });
});
