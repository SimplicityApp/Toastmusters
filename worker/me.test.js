import { describe, it, expect } from 'vitest';
import { handleMe } from './me.js';
import { mintSessionToken } from './session-token.js';
import { grantKey } from './entitlements.js';

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

  it('returns the uid and the resolved entitlement', async () => {
    const env = { PROFILES: makeKv({ [grantKey('u1')]: JSON.stringify({ reason: 'owner' }) }), SESSION_SIGNING_KEY: SIGNING_KEY, ENTITLEMENT_ENFORCE: '1' };
    const res = await handleMe(req({ uid: 'u1' }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toMatchObject({ uid: 'u1', entitlement: { plan: 'pro', entitled: true, source: 'grant' } });
  });
});
