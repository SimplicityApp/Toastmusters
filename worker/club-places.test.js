import { describe, it, expect, beforeEach } from 'vitest';
import { ClubPlaces, makePlacesCtx } from './club-places-fake.js';
import { makeKv } from './club-membership-helpers.js';

/**
 * The 3-place cap, from the Durable Object's side (#167, AC-3 and AC-12).
 *
 * One object per club holds the set of uids that hold a place. A claim checks
 * and adds before any await, so concurrent joins cannot make a 4th place; the
 * owner never takes one; and the first use seeds the set from KV once.
 */

const CLUB_ID = 'club-1';

let kv;
let env;

beforeEach(() => {
  kv = makeKv();
  env = { PROFILES: kv, SESSION_SIGNING_KEY: 'test-session-signing-key', ENTITLEMENT_ENFORCE: '1' };
});

async function seedClubRecord(over = {}) {
  await kv.put(
    `club:${CLUB_ID}`,
    JSON.stringify({ name: 'Downtown Speakers', code: 'DTSP7K2QM9', ver: 1, plan: 'pro', status: 'active', ownerUid: 'owner-uid', ...over })
  );
}

const member = (uid, row) => kv.put(`club-member:${CLUB_ID}:zoom:${uid}`, JSON.stringify(row));

function makePlaces() {
  expect(ClubPlaces, 'worker/club-places.js exports a ClubPlaces class').toBeTypeOf('function');
  const ctx = makePlacesCtx(CLUB_ID);
  return { ctx, places: new ClubPlaces(ctx, env) };
}

describe('ClubPlaces', () => {
  it('is exported with a cap of 3', async () => {
    const mod = await import('./club-places.js').catch(() => ({}));
    expect(mod.CLUB_PLACES).toBe(3);
    expect(mod.ClubPlaces).toBeTypeOf('function');
  });

  it('admits exactly 3 of 5 simultaneous claims', async () => {
    await seedClubRecord();
    const { places } = makePlaces();

    const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((uid) => places.claim(uid)));

    expect(results.filter((r) => r?.ok === true)).toHaveLength(3);
    expect(results.filter((r) => r?.full === true)).toHaveLength(2);
    expect(results.filter((r) => r?.full === true).every((r) => r.placesUsed === 3)).toBe(true);
    expect(await places.count()).toBe(3);
  });

  it('counts a uid that already holds a place as ok, taking no new place', async () => {
    await seedClubRecord();
    const { places } = makePlaces();

    expect(await places.claim('a')).toMatchObject({ ok: true, placesUsed: 1 });
    expect(await places.claim('a')).toMatchObject({ ok: true, placesUsed: 1 });
    expect(await places.count()).toBe(1);

    await places.claim('b');
    await places.claim('c');
    // Full, but a holder re-claiming is still ok.
    expect(await places.claim('c')).toMatchObject({ ok: true, placesUsed: 3 });
    expect(await places.claim('d')).toMatchObject({ full: true, placesUsed: 3 });
  });

  it('frees a place on release, and the next claim takes it', async () => {
    await seedClubRecord();
    const { places } = makePlaces();
    await Promise.all(['a', 'b', 'c'].map((uid) => places.claim(uid)));
    expect(await places.claim('d')).toMatchObject({ full: true });

    await places.release('b');
    expect(await places.count()).toBe(2);
    expect(await places.claim('d')).toMatchObject({ ok: true, placesUsed: 3 });
    expect(await places.claim('b')).toMatchObject({ full: true });

    // Releasing someone who holds no place changes nothing.
    await places.release('nobody');
    expect(await places.count()).toBe(3);
  });

  it('keeps its set across a restart of the object (storage, not memory)', async () => {
    await seedClubRecord();
    const { ctx, places } = makePlaces();
    await places.claim('a');
    await places.claim('b');

    const again = new ClubPlaces(ctx, env);
    expect(await again.count()).toBe(2);
    expect(await again.claim('a')).toMatchObject({ ok: true, placesUsed: 2 });
  });

  it('seeds itself once from live member rows, skipping the owner, blocked and legacy revoked rows', async () => {
    await seedClubRecord();
    await member('owner-uid', { role: 'admin', displayName: null, addedAt: 1 });
    await member('m1', { role: 'member', displayName: null, addedAt: 2 });
    await member('m2', { role: 'editor', displayName: null, addedAt: 3 });
    await member('blocked', { displayName: 'Spam', blockedAt: 4, blockedBy: { type: 'zoom', uid: 'owner-uid' } });
    await member('legacy', { role: 'member', displayName: null, addedAt: 5, revokedAt: 6 });

    const { places } = makePlaces();

    expect(await places.count()).toBe(2);
    expect(await places.claim('m1')).toMatchObject({ ok: true, placesUsed: 2 });
    expect(await places.claim('new')).toMatchObject({ ok: true, placesUsed: 3 });
    expect(await places.claim('another')).toMatchObject({ full: true, placesUsed: 3 });

    // Seeded once: rows written after first use are not counted again.
    await member('late', { role: 'member', displayName: null, addedAt: 7 });
    expect(await places.count()).toBe(3);
  });

  it('seeds correctly when the first calls arrive together', async () => {
    await seedClubRecord();
    await member('m1', { role: 'member', displayName: null, addedAt: 2 });
    await member('m2', { role: 'member', displayName: null, addedAt: 3 });

    const { places } = makePlaces();
    const results = await Promise.all(['x', 'y', 'z'].map((uid) => places.claim(uid)));

    expect(results.filter((r) => r?.ok === true)).toHaveLength(1);
    expect(await places.count()).toBe(3);
  });
});
