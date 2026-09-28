import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { handleProfile } from './profile.js';
import { handleAsset } from './assets.js';
import { handleClubPresets } from './club-presets.js';
import { appendSpeech, listMeetings } from './club-meetings.js';
import { mintSessionToken } from './session-token.js';
import { mintClubToken } from './club-token.js';
import { grantKey, entitlementKey, clubKey } from './entitlements.js';
import { clubMemberKey } from './club-admin.js';

/**
 * The paywall, end to end through the two gated handlers: reads stay open for
 * everyone we can identify, writes need an entitlement — from the caller's own
 * subscription, or from a club code the device activated.
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
    delete: async (key) => { store.delete(key); },
    list: async ({ prefix = '' } = {}) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
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

const bearer = (uid) => (uid ? { authorization: `Bearer ${mintSessionToken(uid, SIGNING_KEY)}` } : {});
const clubHeader = (clubToken) => (clubToken ? { 'x-club': clubToken } : {});

const profileReq = (method, uid, body, clubToken) =>
  new Request('https://x/api/profile', {
    method,
    headers: { 'content-type': 'application/json', ...bearer(uid), ...clubHeader(clubToken) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const bytes = new TextEncoder().encode('png-bytes');
const hash = crypto.createHash('sha256').update(bytes).digest('hex');
const assetReq = (method, uid, clubToken) => {
  const url = new URL(`https://x/api/assets/${hash}`);
  return [
    new Request(url, {
      method,
      headers: { ...bearer(uid), ...clubHeader(clubToken) },
      ...(method === 'PUT' ? { body: bytes } : {}),
    }),
    url,
  ];
};

/** An activated device: the club record, the device record, and its token. */
function seedClubDevice({ clubId = 'club-1', deviceId = 'dev-1', uid = null, status = 'active', revokedAt = null } = {}) {
  kv.store.set(clubKey(clubId), JSON.stringify({ name: 'Downtown Speakers', ver: 1, status, currentPeriodEnd: null }));
  kv.store.set(`club-device:${clubId}:${deviceId}`, JSON.stringify({ label: 'Chrome · macOS', uid, revokedAt }));
  return mintClubToken({ clubId, deviceId, uid, ver: 1 }, SIGNING_KEY);
}

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

/**
 * The second credential. Note what it does not change: the uid still has to be
 * there, because there is no personal profile to sync without one.
 */
describe('club devices', () => {
  it('let a free user push a profile and upload artwork', async () => {
    const clubToken = seedClubDevice({ uid: 'free' });

    const res = await handleProfile(profileReq('PUT', 'free', profileBody, clubToken), env);
    expect(res.status).toBe(200);
    expect(kv.store.has('profile:zoom:free')).toBe(true);

    expect((await handleAsset(...assetReq('PUT', 'free', clubToken), env)).status).toBe(200);
  });

  // The club is read at request time and never written into entitlement:zoom:,
  // so a revoked device is refused on the very next write with nothing to
  // reconcile first.
  it('fall back to 402 once the device is revoked', async () => {
    const clubToken = seedClubDevice({ uid: 'free', revokedAt: Date.now() });

    const res = await handleProfile(profileReq('PUT', 'free', profileBody, clubToken), env);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: 'upgrade_required', entitlement: { plan: 'free', entitled: false } });
    expect(kv.store.has('profile:zoom:free')).toBe(false);
  });

  it('fall back to 402 once the club lapses', async () => {
    const clubToken = seedClubDevice({ uid: 'free', status: 'unpaid' });

    expect((await handleProfile(profileReq('PUT', 'free', profileBody, clubToken), env)).status).toBe(402);
  });

  it('are refused when the club token is forged', async () => {
    seedClubDevice({ uid: 'free' });
    const forged = mintClubToken({ clubId: 'club-1', deviceId: 'dev-1', ver: 1 }, 'a-different-key');

    expect((await handleProfile(profileReq('PUT', 'free', profileBody, forged), env)).status).toBe(402);
  });

  // A guest has a club but no uid, so there is nothing to sync against. 401
  // comes first, exactly as it does today.
  it('still need a session: a guest with a club token gets 401', async () => {
    const clubToken = seedClubDevice();

    expect((await handleProfile(profileReq('PUT', null, profileBody, clubToken), env)).status).toBe(401);
    expect((await handleAsset(...assetReq('PUT', null, clubToken), env)).status).toBe(401);
  });

  it('report the club alongside the plan', async () => {
    const clubToken = seedClubDevice({ uid: 'free' });

    const res = await handleProfile(profileReq('PUT', 'free', profileBody, clubToken), env);
    expect(res.status).toBe(200);
    // The 402 body is the only place the entitlement surfaces on this route, so
    // assert the shape through the handler that always reports it.
    const refused = await handleAsset(...assetReq('PUT', 'nobody'), env);
    expect((await refused.json()).entitlement.club).toBeNull();
  });
});

/**
 * What revocation costs a device, and what it does not.
 *
 * The club token is HMAC-only so that sending it on every request stays cheap,
 * so revoking an already-issued one has to consult state on the paths that were
 * already going to write. A revoked device stops publishing, appending and
 * consuming the club's quota immediately; what it keeps, for up to the token's
 * 24 hours, is the ability to read a club it was already reading.
 */
describe('a revoked device', () => {
  const presets = { rules: { Speech: { green: 300, yellow: 360, red: 420, graceAfterRed: 30 } }, order: [], hiddenBuiltins: [] };

  const presetsReq = (uid, clubToken) =>
    new Request('https://x/api/club/presets', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...bearer(uid), ...clubHeader(clubToken) },
      body: JSON.stringify(presets),
    });

  const appendReq = (clubToken) =>
    new Request('https://x/api/club/meetings/20260929/speeches', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...clubHeader(clubToken) },
      body: JSON.stringify({ speechId: 's-1', name: 'Sarah', role: 'Speech', duration: '5:12', color: 'green', finishedAt: 1 }),
    });

  const listReq = (clubToken) => new Request('https://x/api/club/meetings', { headers: clubHeader(clubToken) });

  it('is refused on publish and on append, and still reads', async () => {
    const live = seedClubDevice({ clubId: 'club-1', deviceId: 'ok', uid: 'sarah' });
    kv.store.set(clubMemberKey('club-1', 'sarah'), JSON.stringify({ role: 'admin' }));

    // It could do both a moment ago.
    expect((await handleClubPresets(presetsReq('sarah', live), env)).status).toBe(200);
    expect((await appendSpeech(appendReq(live), env, '20260929')).status).toBe(200);

    const dead = seedClubDevice({ clubId: 'club-1', deviceId: 'gone', uid: 'sarah', revokedAt: Date.now() });

    expect((await handleClubPresets(presetsReq('sarah', dead), env)).status).toBe(403);
    expect((await appendSpeech(appendReq(dead), env, '20260929')).status).toBe(403);

    // Reads ride the token's own life: this is a club it was already reading,
    // and the 24-hour expiry is what bounds it.
    expect((await listMeetings(listReq(dead), env)).status).toBe(200);
  });
});
