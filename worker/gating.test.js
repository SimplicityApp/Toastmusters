import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { handleProfile } from './profile.js';
import { handleAsset } from './assets.js';
import { mintSessionToken } from './session-token.js';
import { grantKey, entitlementKey } from './entitlements.js';

/**
 * The paywall, end to end through the two gated handlers: reads stay open for
 * everyone we can identify, writes need an entitlement.
 */

const SIGNING_KEY = 'test-session-signing-key';

function makeKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (key, type) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key, value) => { store.set(key, value); },
  };
}

function makeBucket() {
  const store = new Map();
  return {
    store,
    get: async (key) => (store.has(key) ? { body: store.get(key), httpMetadata: {} } : null),
    head: async (key) => (store.has(key) ? { size: 1 } : null),
    put: async (key, bytes) => { store.set(key, bytes); },
    list: async () => ({ objects: [], truncated: false }),
  };
}

let kv;
let env;

beforeEach(() => {
  kv = makeKv();
  env = { PROFILES: kv, CARD_ASSETS: makeBucket(), SESSION_SIGNING_KEY: SIGNING_KEY, ENTITLEMENT_ENFORCE: '1' };
});

const bearer = (uid) => ({ authorization: `Bearer ${mintSessionToken(uid, SIGNING_KEY)}` });

const profileReq = (method, uid, body) =>
  new Request('https://x/api/profile', {
    method,
    headers: { 'content-type': 'application/json', ...bearer(uid) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const bytes = new TextEncoder().encode('png-bytes');
const hash = crypto.createHash('sha256').update(bytes).digest('hex');
const assetReq = (method, uid) => {
  const url = new URL(`https://x/api/assets/${hash}`);
  return [new Request(url, { method, headers: bearer(uid), ...(method === 'PUT' ? { body: bytes } : {}) }), url];
};

const profileBody = { profile: { rev: 0, fields: { toastmaster_agenda: { value: '[]', updatedAt: 1 } } } };

describe('free users', () => {
  it('can read their profile but not push it', async () => {
    expect((await handleProfile(profileReq('GET', 'free'), env)).status).toBe(200);

    const res = await handleProfile(profileReq('PUT', 'free', profileBody), env);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: 'upgrade_required', entitlement: { plan: 'free', entitled: false } });
    expect(kv.store.has('profile:zoom:free')).toBe(false);
  });

  it('can download artwork but not upload it', async () => {
    env.CARD_ASSETS.store.set(`card/free/${hash}`, bytes);
    expect((await handleAsset(...assetReq('GET', 'free'), env)).status).toBe(200);

    const res = await handleAsset(...assetReq('PUT', 'free'), env);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: 'upgrade_required' });
  });
});

describe('entitled users', () => {
  it('push profiles with a subscription record', async () => {
    kv.store.set(entitlementKey('pro'), JSON.stringify({ status: 'active', currentPeriodEnd: Date.now() + 1e6 }));
    expect((await handleProfile(profileReq('PUT', 'pro', profileBody), env)).status).toBe(200);
  });

  it('upload artwork with a grant', async () => {
    kv.store.set(grantKey('comp'), JSON.stringify({ reason: 'owner' }));
    expect((await handleAsset(...assetReq('PUT', 'comp'), env)).status).toBe(200);
  });

  it('are everyone when enforcement is off', async () => {
    env.ENTITLEMENT_ENFORCE = '0';
    expect((await handleProfile(profileReq('PUT', 'anyone', profileBody), env)).status).toBe(200);
    expect((await handleAsset(...assetReq('PUT', 'anyone'), env)).status).toBe(200);
  });
});
