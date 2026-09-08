import { describe, it, expect } from 'vitest';
import { handleMe } from './me.js';
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

function req({ uid, method = 'GET' } = {}) {
  return new Request('https://zoom.example.test/api/me', {
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
