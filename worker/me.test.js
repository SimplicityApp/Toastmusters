import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleMe } from './me.js';
import { FLAG_FALLBACKS } from './flags.js';
import { mintSessionToken } from './session-token.js';
import { grantKey } from './entitlements.js';
import { SESSION_COOKIE, WEB_SESSION_TTL_MS } from './auth.js';

const SIGNING_KEY = 'test-session-signing-key';

function makeKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    get: async (key, type) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key, value) => { store.set(key, value); },
  };
}

function req({ uid, method = 'GET', query = '' } = {}) {
  return new Request(`https://zoom.example.test/api/me${query}`, {
    method,
    headers: uid ? { authorization: `Bearer ${mintSessionToken(uid, SIGNING_KEY)}` } : {},
  });
}

describe('GET /api/me', () => {
  it('requires a session and only answers GET', async () => {
    const env = { PROFILES: makeKv(), SESSION_SIGNING_KEY: SIGNING_KEY };
    expect((await handleMe(req(), env)).status).toBe(401);
    expect((await handleMe(req({ uid: 'u1', method: 'POST' }), env)).status).toBe(405);
  });

  it('re-issues a cookie session older than a day, and leaves fresh ones and bearers alone', async () => {
    const env = { PROFILES: makeKv(), SESSION_SIGNING_KEY: SIGNING_KEY };
    const cookieReq = (iat) =>
      new Request('https://www.example.test/api/me', {
        headers: { cookie: `${SESSION_COOKIE}=${mintSessionToken('u1', SIGNING_KEY, iat, WEB_SESSION_TTL_MS)}`, host: 'www.example.test' },
      });

    const old = await handleMe(cookieReq(Date.now() - 2 * 24 * 60 * 60 * 1000), env);
    expect(old.status).toBe(200);
    expect(old.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=.+HttpOnly; Secure; SameSite=Lax`));

    const fresh = await handleMe(cookieReq(Date.now()), env);
    expect(fresh.headers.get('set-cookie')).toBeNull();

    expect((await handleMe(req({ uid: 'u1' }), env)).headers.get('set-cookie')).toBeNull();
  });

  it('returns the uid and the resolved entitlement', async () => {
    const env = { PROFILES: makeKv({ [grantKey('u1')]: JSON.stringify({ reason: 'owner' }) }), SESSION_SIGNING_KEY: SIGNING_KEY, ENTITLEMENT_ENFORCE: '1' };
    const res = await handleMe(req({ uid: 'u1' }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toMatchObject({ uid: 'u1', entitlement: { plan: 'pro', entitled: true, source: 'grant' } });
  });
});

/**
 * The release flags ride on this endpoint only for the web app's identity
 * call, which asks with ?flags=1. refreshEntitlement and waitForPro poll the
 * same URL without it, and must neither pay for a flag resolution nor see
 * their 401 turn into a 200.
 */
describe('GET /api/me?flags=1', () => {
  const ctx = { waitUntil: () => {} };
  const baseEnv = () => ({ PROFILES: makeKv(), SESSION_SIGNING_KEY: SIGNING_KEY });
  // Every declared flag in one position, as FLAGS_FORCE sets them.
  const allFlags = (on) => Object.fromEntries(Object.keys(FLAG_FALLBACKS).map((key) => [key, on]));

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds the flags for a signed-in caller', async () => {
    for (const FLAGS_FORCE of ['1', '0']) {
      const res = await handleMe(req({ uid: 'u1', query: '?flags=1' }), { ...baseEnv(), FLAGS_FORCE }, ctx);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ uid: 'u1', entitlement: { plan: 'free' } });
      expect(body.flags).toEqual(allFlags(FLAGS_FORCE === '1'));
    }
  });

  // A signed-out visitor still has to end the load knowing which features to
  // show, so with the param "no session" is an answer rather than an error.
  it('answers a caller with no session with 200, a null uid and the flags', async () => {
    for (const FLAGS_FORCE of ['1', '0']) {
      const res = await handleMe(req({ query: '?flags=1' }), { ...baseEnv(), FLAGS_FORCE }, ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(await res.json()).toEqual({ uid: null, flags: allFlags(FLAGS_FORCE === '1') });
    }
  });

  it('falls back to the checked-in values when nothing is configured', async () => {
    expect((await (await handleMe(req({ query: '?flags=1' }), baseEnv(), ctx)).json()).flags).toEqual(FLAG_FALLBACKS);
    expect((await (await handleMe(req({ uid: 'u1', query: '?flags=1' }), baseEnv(), ctx)).json()).flags).toEqual(FLAG_FALLBACKS);
  });

  // Targeting is by uid for a signed-in caller; a signed-out one asks as the
  // shared anonymous id and only ever gets the everyone position.
  it('asks PostHog as zoom:<uid> when signed in, and as anonymous otherwise', async () => {
    const asked = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const { distinct_id: id } = JSON.parse(init.body);
      asked.push(id);
      return new Response(JSON.stringify({ flags: { pro_billing: { key: 'pro_billing', enabled: id === 'zoom:u1' } } }));
    }));
    const env = { ...baseEnv(), POSTHOG_API_KEY: 'phc_test' };

    expect((await (await handleMe(req({ uid: 'u1', query: '?flags=1' }), env, ctx)).json()).flags).toEqual({ ...FLAG_FALLBACKS, pro_billing: true });
    expect((await (await handleMe(req({ query: '?flags=1' }), env, ctx)).json()).flags).toEqual({ ...FLAG_FALLBACKS, pro_billing: false });
    expect(asked).toEqual(['zoom:u1', 'anonymous']);
  });

  // The poller contract: exactly what it was before flags existed.
  describe('without the param', () => {
    it('still answers 401 to a caller with no session', async () => {
      expect((await handleMe(req(), { ...baseEnv(), FLAGS_FORCE: '1' }, ctx)).status).toBe(401);
      expect((await handleMe(req({ query: '?flags=0' }), { ...baseEnv(), FLAGS_FORCE: '1' }, ctx)).status).toBe(401);
    });

    it('carries no flags and never asks PostHog', async () => {
      const fetchMock = vi.fn(async () => new Response('{}'));
      vi.stubGlobal('fetch', fetchMock);
      const env = { ...baseEnv(), POSTHOG_API_KEY: 'phc_test' };

      const res = await handleMe(req({ uid: 'u1' }), env, ctx);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).not.toHaveProperty('flags');
      expect(body).toMatchObject({ uid: 'u1', entitlement: { plan: 'free' } });

      expect((await handleMe(req(), env, ctx)).status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
