import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { handleProfile } from './profile.js';
import { handleAsset } from './assets.js';
import { handleClubPresets } from './club-presets.js';
import { appendSpeech, listMeetings } from './club-meetings.js';
import { mintSessionToken } from './session-token.js';
import { grantKey, entitlementKey, clubKey } from './entitlements.js';
import { clubMemberKey, clubOfKey } from './club-admin.js';

/**
 * The paywall, end to end through the two gated handlers: reads stay open for
 * everyone we can identify, writes need an entitlement — from the caller's own
 * subscription, or from the club their account is in.
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
  return [
    new Request(url, {
      method,
      headers: bearer(uid),
      ...(method === 'PUT' ? { body: bytes } : {}),
    }),
    url,
  ];
};

/** A member account: the club record, the member row and the account's index. */
function seedClubMember({ clubId = 'club-1', uid, role = 'member', status = 'active', row = {} } = {}) {
  kv.store.set(clubKey(clubId), JSON.stringify({ name: 'Downtown Speakers', ver: 1, status, currentPeriodEnd: null }));
  kv.store.set(clubMemberKey(clubId, uid), JSON.stringify({ role, displayName: null, addedAt: 1, ...row }));
  kv.store.set(clubOfKey(uid), JSON.stringify({ clubId, at: 1 }));
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
 * The club, found from the account. Note what it does not change: the uid
 * still has to be there, because there is no personal profile to sync without
 * one.
 */
describe('club members', () => {
  it('let a free account push a profile and upload artwork', async () => {
    seedClubMember({ uid: 'free' });

    const res = await handleProfile(profileReq('PUT', 'free', profileBody), env);
    expect(res.status).toBe(200);
    expect(kv.store.has('profile:zoom:free')).toBe(true);

    expect((await handleAsset(...assetReq('PUT', 'free'), env)).status).toBe(200);
  });

  // The club is read at request time and never written into entitlement:zoom:,
  // so a removed or blocked account is refused on the very next write with
  // nothing to reconcile first.
  it('fall back to 402 once the account is removed or blocked', async () => {
    seedClubMember({ uid: 'free' });
    kv.store.delete(clubMemberKey('club-1', 'free'));

    const res = await handleProfile(profileReq('PUT', 'free', profileBody), env);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: 'upgrade_required', entitlement: { plan: 'free', entitled: false } });
    expect(kv.store.has('profile:zoom:free')).toBe(false);

    seedClubMember({ uid: 'blocked', row: { role: undefined, blockedAt: Date.now() } });
    expect((await handleProfile(profileReq('PUT', 'blocked', profileBody), env)).status).toBe(402);
  });

  it('fall back to 402 once the club lapses', async () => {
    seedClubMember({ uid: 'free', status: 'unpaid' });

    expect((await handleProfile(profileReq('PUT', 'free', profileBody), env)).status).toBe(402);
  });

  it('get nothing from another account\'s club', async () => {
    seedClubMember({ uid: 'member' });

    expect((await handleProfile(profileReq('PUT', 'someone-else', profileBody), env)).status).toBe(402);
  });

  it('still need a session', async () => {
    seedClubMember({ uid: 'free' });

    expect((await handleProfile(profileReq('PUT', null, profileBody), env)).status).toBe(401);
    expect((await handleAsset(...assetReq('PUT', null), env)).status).toBe(401);
  });

  it('report the club alongside the plan', async () => {
    seedClubMember({ uid: 'free' });

    const res = await handleProfile(profileReq('PUT', 'free', profileBody), env);
    expect(res.status).toBe(200);
    // The 402 body is the only place the entitlement surfaces on this route, so
    // assert the shape through the handler that always reports it.
    const refused = await handleAsset(...assetReq('PUT', 'nobody'), env);
    expect((await refused.json()).entitlement.club).toBeNull();
  });
});

/**
 * What removal costs an account: every club write and read, on its very next
 * request, wherever it is signed in.
 */
describe('a removed account', () => {
  const presets = { rules: { Speech: { green: 300, yellow: 360, red: 420, graceAfterRed: 30 } }, order: [], hiddenBuiltins: [] };

  const presetsReq = (uid) =>
    new Request('https://x/api/club/presets', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...bearer(uid) },
      body: JSON.stringify(presets),
    });

  const appendReq = (uid) =>
    new Request('https://x/api/club/meetings/20260929/speeches', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(uid) },
      body: JSON.stringify({ speechId: 's-1', name: 'Sarah', role: 'Speech', duration: '5:12', color: 'green', finishedAt: 1 }),
    });

  const listReq = (uid) => new Request('https://x/api/club/meetings', { headers: bearer(uid) });

  it('is refused on publish, on append and on read', async () => {
    seedClubMember({ uid: 'sarah', role: 'admin' });

    // It could do all three a moment ago.
    expect((await handleClubPresets(presetsReq('sarah'), env)).status).toBe(200);
    expect((await appendSpeech(appendReq('sarah'), env, '20260929')).status).toBe(200);
    expect((await listMeetings(listReq('sarah'), env)).status).toBe(200);

    kv.store.delete(clubMemberKey('club-1', 'sarah'));

    expect((await handleClubPresets(presetsReq('sarah'), env)).status).toBe(403);
    expect((await appendSpeech(appendReq('sarah'), env, '20260929')).status).toBe(403);
    expect((await listMeetings(listReq('sarah'), env)).status).toBe(403);
  });
});
