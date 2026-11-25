import { describe, it, expect, beforeEach } from 'vitest';
import { createClubFromPending } from './club-admin.js';
import { ADMIN_COOKIE, mintAdminSession } from './club-magic.js';
import {
  activate,
  bearer,
  callClub,
  clubOfKey,
  clubState,
  makeEnv,
  memberKey,
  SIGNING_KEY,
} from './club-membership-helpers.js';

/**
 * The console with account membership (#167): a people-only roster with the
 * place count, Remove (the account may rejoin), Block (it may not, until
 * unblocked), and an owner nobody can remove, block, demote or count.
 *
 * Both doors are used without any X-Club header: the Zoom admin's session
 * alone, and the billing-address cookie.
 */

const BILLING_EMAIL = 'treasurer@downtownspeakers.org';
const CODE = 'DTSP-7K2QM9';

let env;
let kv;
let clubId;

beforeEach(async () => {
  env = makeEnv();
  kv = env.PROFILES;
  ({ clubId } = await createClubFromPending(
    env,
    { clubName: 'Downtown Speakers', uid: 'owner-uid', email: BILLING_EMAIL },
    { code: 'DTSP7K2QM9' }
  ));
});

const billingDoor = () => ({
  cookie: `${ADMIN_COOKIE}=${mintAdminSession({ clubId, email: BILLING_EMAIL }, SIGNING_KEY)}`,
});

const roster = (headers = bearer('owner-uid')) => callClub(env, '/api/club/roster', { headers });
const setRole = (uid, role, headers = bearer('owner-uid')) =>
  callClub(env, `/api/club/members/${encodeURIComponent(uid)}/role`, { method: 'POST', headers, body: { role } });
const setBlocked = (uid, blocked, headers = bearer('owner-uid')) =>
  callClub(env, `/api/club/members/${encodeURIComponent(uid)}/block`, { method: 'POST', headers, body: { blocked } });
const rename = (uid, name, headers = bearer('owner-uid')) =>
  callClub(env, `/api/club/members/${encodeURIComponent(uid)}/name`, { method: 'POST', headers, body: { name } });

async function joinAll(...uids) {
  for (const uid of uids) {
    // eslint-disable-next-line no-await-in-loop
    const res = await activate(env, CODE, uid);
    expect(res.status, `${uid} joins`).toBe(200);
  }
}

const placesUsed = async () => (await (await clubState(env, 'owner-uid')).json()).placesUsed;

// ---------------------------------------------------------------------------

describe('GET /api/club/roster', () => {
  it('lists people only, with the place count and the owner marked', async () => {
    await joinAll('ann', 'bob');

    const res = await roster();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.counts).toEqual({ people: 3, placesUsed: 2, placesTotal: 3 });
    expect(body).not.toHaveProperty('guestDevices');
    expect(body.members.map((m) => m.uid).sort()).toEqual(['ann', 'bob', 'owner-uid']);
    for (const member of body.members) {
      expect(member).not.toHaveProperty('devices');
      expect(member.isOwner).toBe(member.uid === 'owner-uid');
    }
    expect(body.blocked).toEqual([]);
  });

  it('opens for the billing door too, with the same counts', async () => {
    await joinAll('ann');
    const body = await (await roster(billingDoor())).json();
    expect(body.counts).toEqual({ people: 2, placesUsed: 1, placesTotal: 3 });
  });

  it('refuses a plain member', async () => {
    await joinAll('ann');
    expect((await roster(bearer('ann'))).status).toBe(403);
  });
});

describe('Remove (role revoked)', () => {
  it('deletes the row and the index, frees the place, and drops them off the roster', async () => {
    await joinAll('ann', 'bob', 'cat');
    expect((await activate(env, CODE, 'dan')).status).toBe(409);

    const res = await setRole('ann', 'revoked');
    expect(res.status).toBe(200);

    expect(kv.json(memberKey(clubId, 'ann'))).toBeNull();
    expect(kv.json(clubOfKey('ann'))).toBeNull();
    expect(await placesUsed()).toBe(2);

    const body = await (await roster()).json();
    expect(body.members.map((m) => m.uid)).not.toContain('ann');
    expect(body.blocked).toEqual([]);

    expect((await clubState(env, 'ann')).status).toBe(404);
  });

  it('lets the removed account join again with the code while a place is free', async () => {
    await joinAll('ann');
    await setRole('ann', 'revoked', billingDoor());

    const res = await activate(env, CODE, 'ann');
    expect(res.status).toBe(200);
    expect(kv.json(memberKey(clubId, 'ann'))).toMatchObject({ role: 'member' });
    expect(kv.json(clubOfKey('ann'))).toMatchObject({ clubId });
  });

  it('still changes the role of a live row', async () => {
    await joinAll('ann');
    const res = await setRole('ann', 'editor');
    expect(res.status).toBe(200);
    expect(kv.json(memberKey(clubId, 'ann'))).toMatchObject({ role: 'editor' });
    expect(await placesUsed()).toBe(1);
  });

  it('does not invent a member: a role for an account that never joined takes no place', async () => {
    const res = await setRole('stranger', 'member');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(kv.json(memberKey(clubId, 'stranger'))).toBeNull();
    expect(await placesUsed()).toBe(0);
  });

  it('refuses the last admin of a club with no known owner', async () => {
    const ownerless = makeEnv();
    const { clubId: id } = await createClubFromPending(ownerless, { clubName: 'Orphans', email: 'o@example.com' }, { code: 'ORPH7K2QM9' });
    await ownerless.PROFILES.put(memberKey(id, 'officer'), JSON.stringify({ role: 'admin', displayName: null, addedAt: 1 }));
    await ownerless.PROFILES.put(clubOfKey('officer'), JSON.stringify({ clubId: id, at: 1 }));
    const cookie = { cookie: `${ADMIN_COOKIE}=${mintAdminSession({ clubId: id, email: 'o@example.com' }, SIGNING_KEY)}` };

    const res = await callClub(ownerless, '/api/club/members/officer/role', { method: 'POST', headers: cookie, body: { role: 'revoked' } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'last_admin' });
  });
});

describe('the owner', () => {
  it('cannot be removed, demoted or blocked, from either door', async () => {
    await kv.put(memberKey(clubId, 'second-admin'), JSON.stringify({ role: 'admin', displayName: null, addedAt: 1 }));
    await kv.put(clubOfKey('second-admin'), JSON.stringify({ clubId, at: 1 }));

    for (const headers of [billingDoor(), bearer('second-admin'), bearer('owner-uid')]) {
      for (const role of ['revoked', 'editor', 'member']) {
        // eslint-disable-next-line no-await-in-loop
        const res = await setRole('owner-uid', role, headers);
        expect(res.status, `role ${role}`).toBe(409);
        // eslint-disable-next-line no-await-in-loop
        expect(await res.json()).toEqual({ error: 'owner' });
      }
      // eslint-disable-next-line no-await-in-loop
      const block = await setBlocked('owner-uid', true, headers);
      expect(block.status).toBe(409);
      // eslint-disable-next-line no-await-in-loop
      expect(await block.json()).toEqual({ error: 'owner' });
    }

    expect(kv.json(memberKey(clubId, 'owner-uid'))).toMatchObject({ role: 'admin' });
    expect(kv.json(memberKey(clubId, 'owner-uid'))?.blockedAt ?? null).toBeNull();
    expect(kv.json(clubOfKey('owner-uid'))).toMatchObject({ clubId });
  });
});

describe('Block and Unblock', () => {
  it('keeps a blocked row with no role, deletes the index, frees the place and lists them under blocked', async () => {
    await joinAll('ann', 'bob', 'cat');
    await callClub(env, '/api/club/members/ann/name', { method: 'POST', headers: bearer('owner-uid'), body: { name: 'Ann' } });

    const res = await setBlocked('ann', true);
    expect(res.status).toBe(200);

    const row = kv.json(memberKey(clubId, 'ann'));
    expect(row).toMatchObject({ displayName: 'Ann', blockedAt: expect.any(Number), blockedBy: expect.anything() });
    expect(row.role ?? null).toBeNull();
    expect(kv.json(clubOfKey('ann'))).toBeNull();
    expect(await placesUsed()).toBe(2);

    const body = await (await roster()).json();
    expect(body.members.map((m) => m.uid)).not.toContain('ann');
    expect(body.blocked).toEqual([{ uid: 'ann', displayName: 'Ann', blockedAt: row.blockedAt }]);
    expect(body.counts).toEqual({ people: 3, placesUsed: 2, placesTotal: 3 });

    expect((await clubState(env, 'ann')).status).toBe(404);
    const again = await activate(env, CODE, 'ann');
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: 'invalid_code' });
  });

  it('blocks an account that is not a member (one who already left)', async () => {
    const res = await setBlocked('gone', true, billingDoor());
    expect(res.status).toBe(200);
    expect(kv.json(memberKey(clubId, 'gone'))).toMatchObject({ blockedAt: expect.any(Number) });
    expect(await placesUsed()).toBe(0);
    expect((await activate(env, CODE, 'gone')).status).toBe(400);
  });

  it('unblocks by deleting the row: not put back, but free to join with the code', async () => {
    await joinAll('ann');
    await setBlocked('ann', true);

    const res = await setBlocked('ann', false);
    expect(res.status).toBe(200);
    expect(kv.json(memberKey(clubId, 'ann'))).toBeNull();
    expect(kv.json(clubOfKey('ann'))).toBeNull();
    expect((await clubState(env, 'ann')).status).toBe(404);
    expect((await (await roster()).json()).blocked).toEqual([]);

    expect((await activate(env, CODE, 'ann')).status).toBe(200);
    expect(kv.json(memberKey(clubId, 'ann'))).toMatchObject({ role: 'member' });
  });

  it('is for admins only', async () => {
    await joinAll('ann', 'ed');
    await setRole('ed', 'editor');

    expect((await setBlocked('ann', true, bearer('ed'))).status).toBe(403);
    expect((await setBlocked('ed', true, bearer('ann'))).status).toBe(403);
    expect((await setBlocked('ann', true, {})).status).toBe(401);
    expect(kv.json(memberKey(clubId, 'ann'))).toMatchObject({ role: 'member' });
  });

  it('takes a blocked former admin out of the console', async () => {
    await joinAll('ann');
    await setRole('ann', 'admin');
    expect((await roster(bearer('ann'))).status).toBe(200);

    await setBlocked('ann', true);
    expect((await roster(bearer('ann'))).status).toBe(403);
  });

  it('leaves a blocked admin out of the last-admin count', async () => {
    const ownerless = makeEnv();
    const { clubId: id } = await createClubFromPending(ownerless, { clubName: 'Orphans', email: 'o@example.com' }, { code: 'ORPH7K2QM9' });
    const put = (uid, row) => ownerless.PROFILES.put(memberKey(id, uid), JSON.stringify(row));
    await put('officer', { role: 'admin', displayName: null, addedAt: 1 });
    await ownerless.PROFILES.put(clubOfKey('officer'), JSON.stringify({ clubId: id, at: 1 }));
    // Blocked rows carry no role; one that still says admin must not count either.
    await put('was-admin', { role: 'admin', displayName: null, addedAt: 1, blockedAt: 2, blockedBy: null });

    const res = await callClub(ownerless, '/api/club/leave', { method: 'POST', headers: bearer('officer') });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'last_admin' });
  });
});

describe('names, and what is gone', () => {
  it('renames an existing row only', async () => {
    await joinAll('ann');
    expect((await rename('ann', 'Ann')).status).toBe(200);
    expect(kv.json(memberKey(clubId, 'ann'))).toMatchObject({ displayName: 'Ann', role: 'member' });

    const res = await rename('stranger', 'Nobody');
    expect(res.status).toBe(404);
    expect(kv.json(memberKey(clubId, 'stranger'))).toBeNull();
  });

  it('has no per-device revoke route', async () => {
    const res = await callClub(env, '/api/club/devices/some-device/revoke', {
      method: 'POST',
      headers: billingDoor(),
      body: { revoked: true },
    });
    expect(res.status).toBe(404);
  });
});
