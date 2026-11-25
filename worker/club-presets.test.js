import { describe, it, expect, beforeEach } from 'vitest';
import worker from './index.js';
import { handleClubPresets, normalizePresets, presetsUnchanged } from './club-presets.js';
import { handleClubState } from './club.js';
import { createClubFromPending, clubMemberKey, clubOfKey, clubPresetsKey, readMemberRole } from './club-admin.js';
import { mintSessionToken } from './session-token.js';
import { clubKey } from './entitlements.js';
import { seedMember } from './club-membership-helpers.js';

/**
 * Publishing: the first route that needs a role rather than just a club.
 *
 * Any member of the club may use its list, but publishing rewrites the list on
 * every timer's screen, so it takes an admin or an editor. Both come from the
 * account's session: the account names the club, and its member row the role.
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

const bearer = (uid) => ({ authorization: `Bearer ${mintSessionToken(uid, SIGNING_KEY)}` });

const publishReq = (uid, body) =>
  new Request('https://x/api/club/presets', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(uid ? bearer(uid) : {}) },
    body: JSON.stringify(body),
  });

/**
 * Seed a club owned by `buyer-uid` (an admin), and optionally put another
 * account in it with a role, the way a join leaves it.
 */
async function activated({ uid, role } = {}) {
  const { clubId } = await createClubFromPending(
    env,
    { clubName: 'Downtown Speakers', uid: 'buyer-uid' },
    { code: 'DTSP7K2QM9' }
  );
  if (uid && uid !== 'buyer-uid') await seedMember(env, clubId, uid, role ?? 'member');
  return { clubId };
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
    const { clubId } = await activated();

    const res = await handleClubPresets(
      publishReq('buyer-uid', { rules: RULES, order: ['Contest Speech'], hiddenBuiltins: ['Ice Breaker'] }),
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
    await activated({ uid: 'vpe-uid', role: 'editor' });
    const res = await handleClubPresets(publishReq('vpe-uid', { rules: RULES }), env);
    expect(res.status).toBe(200);
  });

  // Publishing rewrites every timer's list, so it must not be reachable by
  // whoever happens to hold a shared code.
  it('refuses a member, and an account that is in no club', async () => {
    const member = await activated({ uid: 'member-uid', role: 'member' });
    const refused = await handleClubPresets(publishReq('member-uid', { rules: RULES }), env);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'forbidden' });
    expect(await kv.get(clubPresetsKey(member.clubId), 'json')).toBeNull();

    expect((await handleClubPresets(publishReq('nobody-uid', { rules: RULES }), env)).status).toBe(403);
  });

  it('refuses a request with no session, and anything but PUT', async () => {
    await activated();

    expect((await handleClubPresets(publishReq(null, { rules: RULES }), env)).status).toBe(401);
    expect(
      (await handleClubPresets(new Request('https://x/api/club/presets', { headers: bearer('buyer-uid') }), env)).status
    ).toBe(405);
  });

  it('refuses an account removed from the club, or blocked, on the very next request', async () => {
    const { clubId } = await activated({ uid: 'vpe-uid', role: 'editor' });
    await kv.delete(clubMemberKey(clubId, 'vpe-uid'));
    expect((await handleClubPresets(publishReq('vpe-uid', { rules: RULES }), env)).status).toBe(403);

    await seedMember(env, clubId, 'ed-uid', 'editor');
    await kv.put(clubMemberKey(clubId, 'ed-uid'), JSON.stringify({ displayName: null, blockedAt: Date.now() }));
    expect((await handleClubPresets(publishReq('ed-uid', { rules: RULES }), env)).status).toBe(403);
    expect(await kv.get(clubOfKey('ed-uid'))).toBeNull();
  });

  it('refuses a lapsed club with the same 402 the rest of the paid surface uses', async () => {
    const { clubId } = await activated();
    const club = await kv.get(clubKey(clubId), 'json');
    await kv.put(clubKey(clubId), JSON.stringify({ ...club, status: 'canceled', currentPeriodEnd: Date.now() - DAY }));

    const res = await handleClubPresets(publishReq('buyer-uid', { rules: RULES }), env);
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('upgrade_required');
  });

  it('refuses an unusable list without touching the version', async () => {
    const { clubId } = await activated();

    const res = await handleClubPresets(
      publishReq('buyer-uid', { rules: { Speech: { green: 120, yellow: 90, red: 60 } } }),
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_presets' });
    expect((await kv.get(clubKey(clubId), 'json')).ver).toBe(1);
  });

  // Bumping `ver` for an identical publish would make every device in the club
  // discard its list to receive the list it already has.
  it('writes nothing when the list is unchanged', async () => {
    const { clubId } = await activated();
    const payload = { rules: RULES, order: ['Contest Speech'], hiddenBuiltins: [] };

    await handleClubPresets(publishReq('buyer-uid', payload), env);
    const firstPublishedAt = (await kv.get(clubPresetsKey(clubId), 'json')).publishedAt;

    const again = await handleClubPresets(publishReq('buyer-uid', payload), env);
    expect((await again.json()).ver).toBe(2);
    expect((await kv.get(clubKey(clubId), 'json')).ver).toBe(2);
    expect((await kv.get(clubPresetsKey(clubId), 'json')).publishedAt).toBe(firstPublishedAt);
  });

  // Phase 3 shares the record; a presets publish must not drop a placement
  // somebody already shared.
  it('keeps the badge placement the record already carried', async () => {
    const { clubId } = await activated();
    await kv.put(clubPresetsKey(clubId), JSON.stringify({ rules: {}, badge: { x: 0.1, y: 0.2, scale: 1 } }));

    await handleClubPresets(publishReq('buyer-uid', { rules: RULES }), env);
    expect((await kv.get(clubPresetsKey(clubId), 'json')).badge).toEqual({ x: 0.1, y: 0.2, scale: 1 });
  });
});

describe('the published list reaches a member', () => {
  const stateReq = (uid) => new Request('https://x/api/club', { headers: bearer(uid) });

  it('arrives in clubState with the version that carries it', async () => {
    await activated({ uid: 'member-uid' });
    await handleClubPresets(publishReq('buyer-uid', { rules: RULES, hiddenBuiltins: ['Ice Breaker'] }), env);

    const body = await (await handleClubState(stateReq('member-uid'), env)).json();

    expect(body.ver).toBe(2);
    expect(body.presets).toMatchObject({ rules: RULES, hiddenBuiltins: ['Ice Breaker'], publishedBy: 'buyer-uid' });
  });

  // Not versioned: a promotion has to take effect without anything being
  // republished.
  it('reports the caller\'s role', async () => {
    await activated({ uid: 'member-uid' });

    expect((await (await handleClubState(stateReq('buyer-uid'), env)).json()).role).toBe('admin');
    expect((await (await handleClubState(stateReq('member-uid'), env)).json()).role).toBe('member');
  });
});

describe('readMemberRole', () => {
  it('reads a blocked or legacy revoked row as no role at all', async () => {
    const { clubId } = await activated({ uid: 'vpe-uid', role: 'editor' });
    expect(await readMemberRole(env, clubId, 'vpe-uid')).toBe('editor');

    await kv.put(clubMemberKey(clubId, 'vpe-uid'), JSON.stringify({ role: 'editor', revokedAt: Date.now() }));
    expect(await readMemberRole(env, clubId, 'vpe-uid')).toBeNull();
    await kv.put(clubMemberKey(clubId, 'vpe-uid'), JSON.stringify({ role: 'editor', blockedAt: Date.now() }));
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
