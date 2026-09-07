import { describe, it, expect } from 'vitest';
import { handleZoomSession } from './session.js';
import { verifySessionToken } from './session-token.js';
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
    expect(body).toEqual({ identified: false, isGuest: true });
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
      expect(await res.json()).toEqual({ identified: false, isGuest: false });
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
