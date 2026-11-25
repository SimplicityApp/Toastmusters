import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as clubAdmin from './club-admin.js';
import { createClubFromPending, rotateClubCode } from './club-admin.js';
import { clubKey } from './entitlements.js';
import { handleZoomSession } from './session.js';
import { handleMe } from './me.js';
import { encryptZoomContext } from './test-helpers.js';
import {
  activate,
  bearer,
  callClub,
  clubOfKey,
  clubState,
  leave,
  makeEnv,
  memberKey,
  seedMember,
} from './club-membership-helpers.js';

/**
 * Club Pro belongs to Zoom accounts, not devices (#167).
 *
 * A signed-in account joins with the code and takes one of 3 places (the owner
 * takes none); the club then follows the account through the session, with no
 * club token, no device row and no X-Club header anywhere.
 */

const CLIENT_SECRET = 'test-zoom-client-secret';
const CODE = 'DTSP-7K2QM9';

let env;
let kv;
let clubId;

async function seedClub(over = {}, code = 'DTSP7K2QM9') {
  const created = await createClubFromPending(env, { clubName: 'Downtown Speakers', uid: 'owner-uid', ...over }, { code });
  return created;
}

beforeEach(async () => {
  env = makeEnv();
  kv = env.PROFILES;
  ({ clubId } = await seedClub());
});

const deviceKeys = () => kv.touched.filter((key) => String(key).includes('club-device:'));

// ---------------------------------------------------------------------------

describe('POST /api/club/activate (AC-1)', () => {
  it('joins a signed-in account: member row and club-of index, club state back, no token', async () => {
    const res = await activate(env, CODE, 'ann');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      club: { id: clubId, name: 'Downtown Speakers' },
      plan: 'pro',
      entitled: true,
      source: 'club',
      role: 'member',
      placesUsed: 1,
    });
    expect(body).not.toHaveProperty('clubToken');
    expect(body).not.toHaveProperty('deviceId');

    expect(kv.json(memberKey(clubId, 'ann'))).toMatchObject({ role: 'member' });
    expect(kv.json(clubOfKey('ann'))).toMatchObject({ clubId, at: expect.any(Number) });
    expect([...kv.store.keys()].filter((k) => k.startsWith('club-device:'))).toEqual([]);
  });

  it('refuses a request with no session with 401 sign_in_required, before looking the code up', async () => {
    kv.touched.length = 0;
    const res = await activate(env, CODE, null);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'sign_in_required' });
    expect(kv.touched.filter((key) => String(key).startsWith('club-by-code:'))).toEqual([]);
    expect([...kv.store.keys()].filter((k) => k.startsWith('club-member:') && !k.endsWith(':owner-uid'))).toEqual([]);
  });

  it('still answers invalid_code for an unknown code once signed in', async () => {
    const res = await activate(env, 'NOPE-AAAAAA', 'ann');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
    expect(kv.json(clubOfKey('ann'))).toBeNull();
  });
});

describe('3 places (AC-3)', () => {
  it('turns a 4th account away with 409 full once the owner plus 3 members are in', async () => {
    for (const uid of ['a', 'b', 'c']) {
      // eslint-disable-next-line no-await-in-loop
      expect((await activate(env, CODE, uid)).status).toBe(200);
    }

    const res = await activate(env, CODE, 'd');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'full', placesUsed: 3, placesTotal: 3 });
    expect(kv.json(memberKey(clubId, 'd'))).toBeNull();
    expect(kv.json(clubOfKey('d'))).toBeNull();
  });

  it('never counts the owner: entering their own code takes no place', async () => {
    const res = await activate(env, CODE, 'owner-uid');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.placesUsed).toBe(0);
    expect(body.role).toBe('admin');

    for (const uid of ['a', 'b', 'c']) {
      // eslint-disable-next-line no-await-in-loop
      expect((await activate(env, CODE, uid)).status).toBe(200);
    }
  });

  it('lets a member re-enter the code without using another place', async () => {
    await activate(env, CODE, 'a');
    const again = await activate(env, CODE, 'a');
    expect(again.status).toBe(200);
    expect((await again.json()).placesUsed).toBe(1);

    await activate(env, CODE, 'b');
    await activate(env, CODE, 'c');
    // Full, and a member re-entering still succeeds.
    expect((await activate(env, CODE, 'c')).status).toBe(200);
  });

  it('admits the next account once a place is freed', async () => {
    for (const uid of ['a', 'b', 'c']) {
      // eslint-disable-next-line no-await-in-loop
      await activate(env, CODE, uid);
    }
    expect((await activate(env, CODE, 'd')).status).toBe(409);

    expect((await leave(env, 'b')).status).toBe(200);
    const res = await activate(env, CODE, 'd');
    expect(res.status).toBe(200);
    expect((await res.json()).placesUsed).toBe(3);
  });

  it('admits exactly 2 of 3 simultaneous joins when 2 places are free', async () => {
    await activate(env, CODE, 'a');

    const results = await Promise.all(['x', 'y', 'z'].map((uid) => activate(env, CODE, uid)));
    const statuses = results.map((r) => r.status).sort();

    expect(statuses).toEqual([200, 200, 409]);
    const joined = ['x', 'y', 'z'].filter((uid) => kv.json(memberKey(clubId, uid)));
    expect(joined).toHaveLength(2);
  });

  it('answers 503 try_again and joins nobody when the places object cannot be reached', async () => {
    const down = makeEnv({}, { placesFail: true });
    const { clubId: downClub } = await createClubFromPending(
      down,
      { clubName: 'Downtown Speakers', uid: 'owner-uid' },
      { code: 'DTSP7K2QM9' }
    );

    const res = await activate(down, CODE, 'ann');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'try_again' });
    expect(down.PROFILES.json(memberKey(downClub, 'ann'))).toBeNull();
    expect(down.PROFILES.json(clubOfKey('ann'))).toBeNull();
  });

  it('tells admins how many places are used, and nobody else', async () => {
    await activate(env, CODE, 'a');
    await activate(env, CODE, 'b');

    const admin = await (await clubState(env, 'owner-uid')).json();
    expect(admin).toMatchObject({ role: 'admin', placesUsed: 2, placesTotal: 3, code: CODE });

    const member = await (await clubState(env, 'a')).json();
    expect(member.role).toBe('member');
    expect(member.placesUsed ?? null).toBeNull();
    expect(member.placesTotal ?? null).toBeNull();
    expect(member.code).toBeNull();
  });
});

describe('POST /api/club/leave (AC-4)', () => {
  it('deletes the member row and the index, frees the place, and the club is gone for that account', async () => {
    for (const uid of ['a', 'b', 'c']) {
      // eslint-disable-next-line no-await-in-loop
      await activate(env, CODE, uid);
    }

    const res = await leave(env, 'a');
    expect(res.status).toBe(200);
    expect(kv.json(memberKey(clubId, 'a'))).toBeNull();
    expect(kv.json(clubOfKey('a'))).toBeNull();

    const state = await clubState(env, 'a');
    expect(state.status).toBe(404);
    expect(await state.json()).toEqual({ error: 'no_club' });

    // The place is free: a newcomer fits.
    expect((await activate(env, CODE, 'd')).status).toBe(200);
  });

  it('lets an account that left join again with the code', async () => {
    await activate(env, CODE, 'a');
    await leave(env, 'a');
    expect((await activate(env, CODE, 'a')).status).toBe(200);
    expect(kv.json(memberKey(clubId, 'a'))).toMatchObject({ role: 'member' });
  });

  it('needs a session', async () => {
    const res = await leave(env, null);
    expect(res.status).toBe(401);
  });

  it('refuses the last admin of a club that has no known owner', async () => {
    const ownerless = makeEnv();
    const { clubId: id } = await createClubFromPending(ownerless, { clubName: 'Orphans' }, { code: 'ORPH7K2QM9' });
    await seedMember(ownerless, id, 'officer', 'admin');

    const res = await leave(ownerless, 'officer');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'last_admin' });
    expect(ownerless.PROFILES.json(memberKey(id, 'officer'))).toMatchObject({ role: 'admin' });
  });
});

describe('one club per account (AC-5)', () => {
  it('refuses another club\'s code with 409 already_in_club and the current club\'s name', async () => {
    await createClubFromPending(env, { clubName: 'Uptown Orators', uid: 'other-owner' }, { code: 'UPTN7K2QM9' });
    expect((await activate(env, CODE, 'ann')).status).toBe(200);

    const res = await activate(env, 'UPTN-7K2QM9', 'ann');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'already_in_club', clubName: 'Downtown Speakers' });
    expect(kv.json(clubOfKey('ann'))).toMatchObject({ clubId });
  });

  it('counts an owner as in their own club', async () => {
    await createClubFromPending(env, { clubName: 'Uptown Orators', uid: 'other-owner' }, { code: 'UPTN7K2QM9' });
    const res = await activate(env, 'UPTN-7K2QM9', 'owner-uid');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'already_in_club', clubName: 'Downtown Speakers' });
  });
});

describe('a new code (AC-6)', () => {
  it('lets the old code admit nobody while every member keeps access', async () => {
    await activate(env, CODE, 'a');
    kv.touched.length = 0;

    await rotateClubCode(env, clubId, { code: 'DTSPAAAAAA' });

    const old = await activate(env, CODE, 'b');
    expect(old.status).toBe(400);
    expect(await old.json()).toEqual({ error: 'invalid_code' });

    expect((await clubState(env, 'a')).status).toBe(200);
    expect((await clubState(env, 'owner-uid')).status).toBe(200);
    expect(kv.json(memberKey(clubId, 'a'))).toMatchObject({ role: 'member' });
    expect(deviceKeys()).toEqual([]);

    expect((await activate(env, 'DTSP-AAAAAA', 'b')).status).toBe(200);
  });
});

describe('no device bindings (AC-7)', () => {
  it('reads and writes no club-device: key on join, open, leave, code change or create', async () => {
    kv.touched.length = 0;
    await activate(env, CODE, 'a');
    await clubState(env, 'a');
    await leave(env, 'a');
    await rotateClubCode(env, clubId, { code: 'DTSPAAAAAA' });

    expect(deviceKeys()).toEqual([]);
    expect([...kv.store.keys()].filter((k) => k.startsWith('club-device:'))).toEqual([]);
  });

  it('ignores an X-Club header: no session means no club', async () => {
    await activate(env, CODE, 'a');
    const res = await callClub(env, '/api/club', { headers: { 'x-club': 'anything.at.all' } });
    expect(res.status).toBe(401);
  });

  it('hands the creator of a club no token either', async () => {
    const subscriber = makeEnv();
    await subscriber.PROFILES.put('entitlement:zoom:payer', JSON.stringify({ status: 'active', currentPeriodEnd: Date.now() + 86_400_000 }));
    await subscriber.PROFILES.put('stripe:customer-by-uid:zoom:payer', 'cus_9');
    await subscriber.PROFILES.put('club-pending:cus_9', JSON.stringify({ clubName: 'New Club', email: 'pay@example.com' }));
    const res = await callClub(subscriber, '/api/club/create', {
      method: 'POST',
      headers: bearer('payer'),
      body: { clubName: 'New Club' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ created: true, role: 'admin', isOwner: true });
    expect(body).not.toHaveProperty('clubToken');
    expect(subscriber.PROFILES.touched.filter((k) => String(k).includes('club-device:'))).toEqual([]);
  });
});

describe('the club follows the account (AC-2)', () => {
  it('answers GET /api/club from the session alone, and only for a member', async () => {
    await activate(env, CODE, 'ann');

    const res = await clubState(env, 'ann');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ club: { id: clubId }, entitled: true, role: 'member' });
    expect(res.headers.get('x-club')).toBeNull();

    const stranger = await clubState(env, 'stranger');
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toEqual({ error: 'no_club' });

    expect((await clubState(env, null)).status).toBe(401);
  });

  it('puts the member\'s club on the Zoom session\'s entitlement, with no header', async () => {
    await activate(env, CODE, 'ann');
    const sessionEnv = { ...env, ZOOM_CLIENT_SECRET: CLIENT_SECRET };
    const sessionReq = (uid) =>
      new Request('https://zoom.timer.simple-tech.app/api/zoom/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ context: encryptZoomContext({ uid, exp: Date.now() + 60_000 }, { secret: CLIENT_SECRET }) }),
      });

    const member = await (await handleZoomSession(sessionReq('ann'), sessionEnv)).json();
    expect(member.entitlement).toMatchObject({
      plan: 'pro',
      entitled: true,
      source: 'club',
      club: { id: clubId, name: 'Downtown Speakers' },
    });

    const stranger = await (await handleZoomSession(sessionReq('stranger'), sessionEnv)).json();
    expect(stranger.entitlement.club).toBeNull();
    expect(stranger.entitlement.entitled).toBe(false);
  });

  it('puts the member\'s club on GET /api/me, with no header', async () => {
    await activate(env, CODE, 'ann');
    const meReq = (uid) => new Request('https://www.timer.simple-tech.app/api/me', { headers: bearer(uid) });

    const member = await (await handleMe(meReq('ann'), env)).json();
    expect(member.entitlement).toMatchObject({ entitled: true, club: { id: clubId, name: 'Downtown Speakers' } });

    const stranger = await (await handleMe(meReq('stranger'), env)).json();
    expect(stranger.entitlement.club).toBeNull();
  });

  it('drops the club from the session once the account leaves', async () => {
    await activate(env, CODE, 'ann');
    await leave(env, 'ann');
    const me = await (await handleMe(new Request('https://x/api/me', { headers: bearer('ann') }), env)).json();
    expect(me.entitlement.club).toBeNull();
  });
});

describe('a blocked account (AC-11)', () => {
  it('cannot join (invalid_code, like a wrong code) and has no club', async () => {
    await kv.put(
      memberKey(clubId, 'spam'),
      JSON.stringify({ displayName: 'Spam', blockedAt: Date.now(), blockedBy: { type: 'zoom', uid: 'owner-uid' } })
    );

    const res = await activate(env, CODE, 'spam');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
    expect(kv.json(memberKey(clubId, 'spam'))).toMatchObject({ blockedAt: expect.any(Number) });
    expect(kv.json(clubOfKey('spam'))).toBeNull();

    await kv.put(clubOfKey('spam'), JSON.stringify({ clubId, at: 1 }));
    expect((await clubState(env, 'spam')).status).toBe(404);
  });

  it('treats a legacy revokedAt row as no row: that account joins like anyone else', async () => {
    await kv.put(memberKey(clubId, 'old'), JSON.stringify({ role: 'member', displayName: null, addedAt: 1, revokedAt: 2 }));
    const res = await activate(env, CODE, 'old');
    expect(res.status).toBe(200);
    expect(kv.json(memberKey(clubId, 'old'))?.revokedAt ?? null).toBeNull();
    expect(kv.json(clubOfKey('old'))).toMatchObject({ clubId });
  });
});

describe('the owner (AC-12)', () => {
  it('is written on the club record, with an index, when the club is created', async () => {
    expect(kv.json(clubKey(clubId))).toMatchObject({ ownerUid: 'owner-uid' });
    expect(kv.json(clubOfKey('owner-uid'))).toMatchObject({ clubId });
    expect(kv.json(memberKey(clubId, 'owner-uid'))).toMatchObject({ role: 'admin' });
  });

  it('cannot leave', async () => {
    const res = await leave(env, 'owner-uid');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'owner' });
    expect(kv.json(memberKey(clubId, 'owner-uid'))).toMatchObject({ role: 'admin' });
    expect(kv.json(clubOfKey('owner-uid'))).toMatchObject({ clubId });
  });

  it('is told isOwner on the state; a member is not', async () => {
    await activate(env, CODE, 'ann');
    expect(await (await clubState(env, 'owner-uid')).json()).toMatchObject({ isOwner: true });
    expect(await (await clubState(env, 'ann')).json()).toMatchObject({ isOwner: false });
  });

  it('finds the owner of a record without ownerUid through the Stripe customer', async () => {
    const legacy = makeEnv();
    const { clubId: id } = await createClubFromPending(
      legacy,
      { clubName: 'Legacy', uid: 'payer', stripeCustomerId: 'cus_legacy' },
      { code: 'LGCY7K2QM9' }
    );
    const record = legacy.PROFILES.json(clubKey(id));
    delete record.ownerUid;
    await legacy.PROFILES.put(clubKey(id), JSON.stringify(record));
    await legacy.PROFILES.put('stripe:customer:cus_legacy', 'payer');

    const res = await leave(legacy, 'payer');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'owner' });
  });
});

describe('memberClub', () => {
  it('finds the club from the account alone, and nothing for a blocked, removed or dangling account', async () => {
    expect(clubAdmin.memberClub).toBeTypeOf('function');
    await activate(env, CODE, 'ann');

    expect(await clubAdmin.memberClub(env, 'ann')).toMatchObject({ clubId, role: 'member', club: { name: 'Downtown Speakers' } });
    expect(await clubAdmin.memberClub(env, 'nobody')).toBeNull();

    // A dangling index (no member row) reads as no club, and is cleaned up.
    await kv.put(clubOfKey('ghost'), JSON.stringify({ clubId, at: 1 }));
    expect(await clubAdmin.memberClub(env, 'ghost')).toBeNull();
    expect(kv.json(clubOfKey('ghost'))).toBeNull();

    await kv.put(memberKey(clubId, 'ann'), JSON.stringify({ displayName: null, blockedAt: 1, blockedBy: null }));
    expect(await clubAdmin.memberClub(env, 'ann')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-9: the club's features keep working for members who joined by account.

const MEETING = '20260929';
const LIVE_NOW = Date.UTC(2026, 8, 29, 23, 0);

describe('club features for an account member (AC-9)', () => {
  beforeEach(() => {
    vi.setSystemTime(LIVE_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const RULES = { 'Contest Speech': { green: 300, yellow: 360, red: 420, graceAfterRed: 30 } };
  const speech = { speechId: 's1', name: 'Alice', role: 'Standard Speech', duration: '5:50', color: 'green', comments: '', disqualified: false, finishedAt: 1_000 };

  it('lets an editor publish presets with the session alone, and refuses a plain member', async () => {
    await activate(env, CODE, 'ed');
    await activate(env, CODE, 'mem');
    await kv.put(memberKey(clubId, 'ed'), JSON.stringify({ role: 'editor', displayName: null, addedAt: 1 }));

    const publish = (uid) =>
      callClub(env, '/api/club/presets', { method: 'PUT', headers: bearer(uid), body: { rules: RULES, order: [], hiddenBuiltins: [] } });

    expect((await publish('ed')).status).toBe(200);
    expect((await publish('mem')).status).toBe(403);
    expect((await publish('stranger')).status).toBe(403);
  });

  it('archives a member\'s speech and lists it, with the session alone', async () => {
    await activate(env, CODE, 'mem');

    const append = await callClub(env, `/api/club/meetings/${MEETING}/speeches`, { method: 'POST', headers: bearer('mem'), body: speech });
    expect(append.status).toBe(200);

    const list = await callClub(env, '/api/club/meetings', { headers: bearer('mem') });
    expect(list.status).toBe(200);
    expect(JSON.stringify(await list.json())).toContain(MEETING);
  });

  it('refuses a speech from a signed-in non-member (403) and from no session (401)', async () => {
    const stranger = await callClub(env, `/api/club/meetings/${MEETING}/speeches`, { method: 'POST', headers: bearer('stranger'), body: speech });
    expect(stranger.status).toBe(403);

    const anonymous = await callClub(env, `/api/club/meetings/${MEETING}/speeches`, { method: 'POST', body: speech });
    expect(anonymous.status).toBe(401);

    expect((await callClub(env, '/api/club/meetings', { headers: bearer('stranger') })).status).toBe(403);
  });
});
