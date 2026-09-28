import { describe, it, expect, beforeEach } from 'vitest';
import worker from './index.js';
import { handleClubPresets, normalizePresets, presetsUnchanged } from './club-presets.js';
import { handleClubActivate, handleClubState } from './club.js';
import { createClubFromPending, clubMemberKey, clubPresetsKey, readMemberRole } from './club-admin.js';
import { mintSessionToken } from './session-token.js';
import { verifyClubToken } from './club-token.js';
import { clubKey } from './entitlements.js';

/**
 * Publishing: the first route that needs a role rather than just a club.
 *
 * Access attaches to a device — anyone with the code may use the club's list —
 * but authorization attaches to a person, because publishing rewrites the list
 * on every timer's screen.
 */

const SIGNING_KEY = 'test-session-signing-key';
const DAY = 24 * 60 * 60 * 1000;

function makeKv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
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

const RULES = {
  'Standard Speech': { green: 300, yellow: 360, red: 420, graceAfterRed: 30 },
  'Contest Speech': { green: 300, yellow: 360, red: 420, graceAfterRed: 30 },
};

let kv;
let env;

beforeEach(() => {
  kv = makeKv();
  env = { PROFILES: kv, SESSION_SIGNING_KEY: SIGNING_KEY, ENTITLEMENT_ENFORCE: '1' };
});

const publishReq = (clubToken, body, { uid } = {}) =>
  new Request('https://x/api/club/presets', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(clubToken ? { 'x-club': clubToken } : {}),
      ...(uid ? { authorization: `Bearer ${mintSessionToken(uid, SIGNING_KEY)}` } : {}),
    },
    body: JSON.stringify(body),
  });

/** Seed a club and activate one device on it, optionally carrying a uid. */
async function activated({ uid, role } = {}) {
  const { clubId } = await createClubFromPending(
    env,
    { clubName: 'Downtown Speakers', uid: 'buyer-uid' },
    { code: 'DTSP7K2QM9' }
  );
  if (uid && role) {
    await kv.put(clubMemberKey(clubId, uid), JSON.stringify({ role, displayName: null, addedAt: 1, revokedAt: null }));
  }
  const res = await handleClubActivate(
    new Request('https://x/api/club/activate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(uid ? { authorization: `Bearer ${mintSessionToken(uid, SIGNING_KEY)}` } : {}),
      },
      body: JSON.stringify({ code: 'DTSP-7K2QM9' }),
    }),
    env
  );
  const body = await res.json();
  return { clubId, ...body, claims: verifyClubToken(body.clubToken, SIGNING_KEY) };
}

// ---------------------------------------------------------------------------

describe('normalizePresets', () => {
  it('keeps a well-formed list and rounds its seconds', () => {
    expect(normalizePresets({ rules: { Speech: { green: 60.4, yellow: 90, red: 120 } } })).toEqual({
      rules: { Speech: { green: 60, yellow: 90, red: 120, graceAfterRed: 0 } },
      order: [],
      hiddenBuiltins: [],
    });
  });

  // The same invariant the editor enforces, re-checked here because a list that
  // breaks it would land on every device in the club with no UI to repair it.
  it('refuses a list whose colours are out of order, or that is empty', () => {
    expect(normalizePresets({ rules: { Speech: { green: 120, yellow: 90, red: 60 } } })).toBeNull();
    expect(normalizePresets({ rules: { Speech: { green: 0, yellow: 90, red: 120 } } })).toBeNull();
    expect(normalizePresets({ rules: {} })).toBeNull();
    expect(normalizePresets({ rules: { '': { green: 1, yellow: 2, red: 3 } } })).toBeNull();
    expect(normalizePresets(null)).toBeNull();
  });

  // Noise, not an error: a stale name in `order` should not refuse the publish.
  it('drops order entries naming a role that is not in the list', () => {
    const next = normalizePresets({ rules: RULES, order: ['Contest Speech', 'Gone'], hiddenBuiltins: ['Ice Breaker', 'Ice Breaker'] });
    expect(next.order).toEqual(['Contest Speech']);
    expect(next.hiddenBuiltins).toEqual(['Ice Breaker']);
  });
});

describe('PUT /api/club/presets', () => {
  it('lets an admin publish, and bumps the club version once', async () => {
    const { clubId, clubToken } = await activated({ uid: 'buyer-uid' });

    const res = await handleClubPresets(
      publishReq(clubToken, { rules: RULES, order: ['Contest Speech'], hiddenBuiltins: ['Ice Breaker'] }, { uid: 'buyer-uid' }),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ver).toBe(2);
    expect(body.presets).toMatchObject({ rules: RULES, order: ['Contest Speech'], hiddenBuiltins: ['Ice Breaker'], publishedBy: 'buyer-uid' });
    expect((await kv.get(clubKey(clubId), 'json')).ver).toBe(2);
    expect(await kv.get(clubPresetsKey(clubId), 'json')).toMatchObject({ publishedBy: 'buyer-uid' });
  });

  it('lets an editor publish', async () => {
    const { clubToken } = await activated({ uid: 'vpe-uid', role: 'editor' });
    const res = await handleClubPresets(publishReq(clubToken, { rules: RULES }, { uid: 'vpe-uid' }), env);
    expect(res.status).toBe(200);
  });

  // Publishing rewrites every timer's list, so it must not be reachable by
  // whoever happens to hold a shared code.
  it('refuses a member, and refuses a guest device outright', async () => {
    const member = await activated({ uid: 'member-uid', role: 'member' });
    const refused = await handleClubPresets(publishReq(member.clubToken, { rules: RULES }, { uid: 'member-uid' }), env);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'forbidden' });
    expect(await kv.get(clubPresetsKey(member.clubId), 'json')).toBeNull();

    // A guest has no member record at all, so there is no role to hold.
    const guest = await activated();
    expect((await handleClubPresets(publishReq(guest.clubToken, { rules: RULES }), env)).status).toBe(401);
    expect(
      (await handleClubPresets(publishReq(guest.clubToken, { rules: RULES }, { uid: 'nobody-uid' }), env)).status
    ).toBe(403);
  });

  it('refuses a request missing either credential, and anything but PUT', async () => {
    const { clubToken } = await activated({ uid: 'buyer-uid' });

    expect((await handleClubPresets(publishReq(clubToken, { rules: RULES }), env)).status).toBe(401);
    expect((await handleClubPresets(publishReq(null, { rules: RULES }, { uid: 'buyer-uid' }), env)).status).toBe(401);
    expect(
      (await handleClubPresets(new Request('https://x/api/club/presets', { headers: { 'x-club': clubToken } }), env)).status
    ).toBe(405);
  });

  it('refuses a revoked device on the very next request', async () => {
    const { clubId, clubToken, claims } = await activated({ uid: 'buyer-uid' });
    const key = `club-device:${clubId}:${claims.deviceId}`;
    await kv.put(key, JSON.stringify({ ...(await kv.get(key, 'json')), revokedAt: Date.now() }));

    expect((await handleClubPresets(publishReq(clubToken, { rules: RULES }, { uid: 'buyer-uid' }), env)).status).toBe(403);
  });

  it('refuses a lapsed club with the same 402 the rest of the paid surface uses', async () => {
    const { clubId, clubToken } = await activated({ uid: 'buyer-uid' });
    const club = await kv.get(clubKey(clubId), 'json');
    await kv.put(clubKey(clubId), JSON.stringify({ ...club, status: 'canceled', currentPeriodEnd: Date.now() - DAY }));

    const res = await handleClubPresets(publishReq(clubToken, { rules: RULES }, { uid: 'buyer-uid' }), env);
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('upgrade_required');
  });

  it('refuses an unusable list without touching the version', async () => {
    const { clubId, clubToken } = await activated({ uid: 'buyer-uid' });

    const res = await handleClubPresets(
      publishReq(clubToken, { rules: { Speech: { green: 120, yellow: 90, red: 60 } } }, { uid: 'buyer-uid' }),
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_presets' });
    expect((await kv.get(clubKey(clubId), 'json')).ver).toBe(1);
  });

  // Bumping `ver` for an identical publish would make every device in the club
  // discard its list to receive the list it already has.
  it('writes nothing when the list is unchanged', async () => {
    const { clubId, clubToken } = await activated({ uid: 'buyer-uid' });
    const payload = { rules: RULES, order: ['Contest Speech'], hiddenBuiltins: [] };

    await handleClubPresets(publishReq(clubToken, payload, { uid: 'buyer-uid' }), env);
    const firstPublishedAt = (await kv.get(clubPresetsKey(clubId), 'json')).publishedAt;

    const again = await handleClubPresets(publishReq(clubToken, payload, { uid: 'buyer-uid' }), env);
    expect((await again.json()).ver).toBe(2);
    expect((await kv.get(clubKey(clubId), 'json')).ver).toBe(2);
    expect((await kv.get(clubPresetsKey(clubId), 'json')).publishedAt).toBe(firstPublishedAt);
  });

  // Phase 3 shares the record; a presets publish must not drop a placement
  // somebody already shared.
  it('keeps the badge placement the record already carried', async () => {
    const { clubId, clubToken } = await activated({ uid: 'buyer-uid' });
    await kv.put(clubPresetsKey(clubId), JSON.stringify({ rules: {}, badge: { x: 0.1, y: 0.2, scale: 1 } }));

    await handleClubPresets(publishReq(clubToken, { rules: RULES }, { uid: 'buyer-uid' }), env);
    expect((await kv.get(clubPresetsKey(clubId), 'json')).badge).toEqual({ x: 0.1, y: 0.2, scale: 1 });
  });
});

describe('the published list reaches a device', () => {
  it('arrives in clubState with the version that carries it', async () => {
    const { clubToken } = await activated({ uid: 'buyer-uid' });
    await handleClubPresets(publishReq(clubToken, { rules: RULES, hiddenBuiltins: ['Ice Breaker'] }, { uid: 'buyer-uid' }), env);

    const body = await (await handleClubState(new Request('https://x/api/club', { headers: { 'x-club': clubToken } }), env)).json();

    expect(body.ver).toBe(2);
    expect(body.presets).toMatchObject({ rules: RULES, hiddenBuiltins: ['Ice Breaker'], publishedBy: 'buyer-uid' });
  });

  // Not versioned: a promotion has to take effect without anything being
  // republished, and a guest device must never be told it holds a role.
  it('reports the caller\'s role, and null for a guest device', async () => {
    const { clubToken } = await activated({ uid: 'buyer-uid' });

    const withUid = await (await handleClubState(
      new Request('https://x/api/club', {
        headers: { 'x-club': clubToken, authorization: `Bearer ${mintSessionToken('buyer-uid', SIGNING_KEY)}` },
      }),
      env
    )).json();
    expect(withUid.role).toBe('admin');

    const guest = await (await handleClubState(new Request('https://x/api/club', { headers: { 'x-club': clubToken } }), env)).json();
    expect(guest.role).toBeNull();
  });
});

describe('readMemberRole', () => {
  it('reads a revoked member as no role at all', async () => {
    const { clubId } = await activated({ uid: 'vpe-uid', role: 'editor' });
    expect(await readMemberRole(env, clubId, 'vpe-uid')).toBe('editor');

    await kv.put(clubMemberKey(clubId, 'vpe-uid'), JSON.stringify({ role: 'editor', revokedAt: Date.now() }));
    expect(await readMemberRole(env, clubId, 'vpe-uid')).toBeNull();
    expect(await readMemberRole(env, clubId, 'stranger')).toBeNull();
  });

  it('folds an unrecognised role down to member rather than trusting it', async () => {
    const { clubId } = await activated({ uid: 'odd-uid', role: 'owner' });
    expect(await readMemberRole(env, clubId, 'odd-uid')).toBe('member');
  });
});

describe('presetsUnchanged', () => {
  it('is false when there is nothing stored yet', () => {
    expect(presetsUnchanged(null, { rules: RULES, order: [], hiddenBuiltins: [] })).toBe(false);
  });
});

describe('routing', () => {
  it('dispatches /api/club/presets with the other API routes', async () => {
    const res = await worker.fetch(
      new Request('https://timer.simple-tech.app/api/club/presets', {
        method: 'PUT',
        headers: { host: 'timer.simple-tech.app', 'content-type': 'application/json' },
        body: '{}',
      }),
      env,
      { waitUntil: () => {} }
    );
    // Ahead of the apex redirect: a 301 here would drop the body.
    expect(res.status).toBe(401);
  });
});
