import { describe, it, expect } from 'vitest';
import {
  resolveEntitlement,
  resolveClubEntitlement,
  resolveAccess,
  subscriptionGrantsAccess,
  projectSubscription,
  entitlementKey,
  grantKey,
  clubKey,
  PAST_DUE_GRACE_MS,
} from './entitlements.js';

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
  };
}

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const record = (over = {}) => ({
  plan: 'pro', status: 'active', currentPeriodEnd: NOW + 10 * DAY, cancelAtPeriodEnd: false,
  stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', updatedAt: NOW - DAY, ...over,
});

describe('subscriptionGrantsAccess', () => {
  it('grants for active and trialing regardless of period end', () => {
    expect(subscriptionGrantsAccess(record({ status: 'active', currentPeriodEnd: NOW - DAY }), NOW)).toBe(true);
    expect(subscriptionGrantsAccess(record({ status: 'trialing' }), NOW)).toBe(true);
  });

  // A bounced card must not lock someone out minutes before their club meets.
  it('keeps past_due users for the grace period, then locks', () => {
    const periodEnd = NOW - DAY;
    expect(subscriptionGrantsAccess(record({ status: 'past_due', currentPeriodEnd: periodEnd }), NOW)).toBe(true);
    expect(
      subscriptionGrantsAccess(record({ status: 'past_due', currentPeriodEnd: periodEnd }), periodEnd + PAST_DUE_GRACE_MS + 1)
    ).toBe(false);
  });

  it('keeps canceled users until the paid period runs out', () => {
    expect(subscriptionGrantsAccess(record({ status: 'canceled', currentPeriodEnd: NOW + DAY }), NOW)).toBe(true);
    expect(subscriptionGrantsAccess(record({ status: 'canceled', currentPeriodEnd: NOW - 1 }), NOW)).toBe(false);
    expect(subscriptionGrantsAccess(record({ status: 'canceled', currentPeriodEnd: null }), NOW)).toBe(false);
  });

  it('denies unpaid, incomplete, paused and garbage', () => {
    for (const status of ['unpaid', 'incomplete', 'incomplete_expired', 'paused', 'unknown']) {
      expect(subscriptionGrantsAccess(record({ status }), NOW)).toBe(false);
    }
    expect(subscriptionGrantsAccess(null, NOW)).toBe(false);
    expect(subscriptionGrantsAccess('active', NOW)).toBe(false);
  });
});

describe('resolveEntitlement', () => {
  const enforced = (kv) => ({ PROFILES: kv, ENTITLEMENT_ENFORCE: '1' });

  it('is free and not entitled with no record', async () => {
    expect(await resolveEntitlement(enforced(makeKv()), 'u1', NOW)).toEqual({
      plan: 'free', status: null, entitled: false, currentPeriodEnd: null, cancelAtPeriodEnd: false, source: 'none',
    });
  });

  it('is pro from an active subscription record', async () => {
    const kv = makeKv({ [entitlementKey('u1')]: record() });
    const e = await resolveEntitlement(enforced(kv), 'u1', NOW);
    expect(e).toMatchObject({ plan: 'pro', entitled: true, status: 'active', source: 'subscription', currentPeriodEnd: NOW + 10 * DAY });
  });

  it('reports a lapsed subscription as free, but says when it ended', async () => {
    const kv = makeKv({ [entitlementKey('u1')]: record({ status: 'canceled', currentPeriodEnd: NOW - DAY }) });
    expect(await resolveEntitlement(enforced(kv), 'u1', NOW)).toMatchObject({
      plan: 'free', entitled: false, status: 'canceled', currentPeriodEnd: NOW - DAY, source: 'none',
    });
  });

  it('honours a hand grant, with and without expiry', async () => {
    const kv = makeKv({ [grantKey('u1')]: { reason: 'owner' }, [grantKey('u2')]: { reason: 'trial', exp: NOW - 1 } });
    expect(await resolveEntitlement(enforced(kv), 'u1', NOW)).toMatchObject({ plan: 'pro', entitled: true, source: 'grant', currentPeriodEnd: null });
    expect(await resolveEntitlement(enforced(kv), 'u2', NOW)).toMatchObject({ plan: 'free', entitled: false });
  });

  it('prefers a live subscription over a grant', async () => {
    const kv = makeKv({ [entitlementKey('u1')]: record(), [grantKey('u1')]: { reason: 'owner' } });
    expect((await resolveEntitlement(enforced(kv), 'u1', NOW)).source).toBe('subscription');
  });

  // Dev runs unenforced: everyone may use the paid features, but the plan still
  // reads "free" so the UI shows the upgrade path and Checkout can be tested.
  it('grants everyone when enforcement is off, without lying about the plan', async () => {
    const env = { PROFILES: makeKv(), ENTITLEMENT_ENFORCE: '0' };
    expect(await resolveEntitlement(env, 'u1', NOW)).toMatchObject({ plan: 'free', entitled: true, source: 'unenforced' });
    expect(await resolveEntitlement(env, null, NOW)).toMatchObject({ plan: 'free', entitled: true });
  });

  it('uses a dedicated ENTITLEMENTS namespace when one is bound', async () => {
    const ent = makeKv({ [entitlementKey('u1')]: record() });
    const env = { PROFILES: makeKv(), ENTITLEMENTS: ent, ENTITLEMENT_ENFORCE: '1' };
    expect((await resolveEntitlement(env, 'u1', NOW)).entitled).toBe(true);
  });

  it('degrades to free when storage is missing or throws', async () => {
    expect(await resolveEntitlement({ ENTITLEMENT_ENFORCE: '1' }, 'u1', NOW)).toMatchObject({ plan: 'free', entitled: false });
    const broken = { get: async () => { throw new Error('kv down'); } };
    expect(await resolveEntitlement({ PROFILES: broken, ENTITLEMENT_ENFORCE: '1' }, 'u1', NOW)).toMatchObject({ plan: 'free', entitled: false });
  });

  it('is free for a missing uid', async () => {
    expect((await resolveEntitlement(enforced(makeKv()), null, NOW)).entitled).toBe(false);
  });
});

/**
 * The club is the same question asked of a club instead of a person, so it has
 * to reproduce the user table row for row — otherwise grace would mean one
 * thing when the money is attached to a person and another when it is attached
 * to a club.
 */
describe('resolveClubEntitlement', () => {
  const enforced = (kv) => ({ PROFILES: kv, ENTITLEMENT_ENFORCE: '1' });
  const club = (over = {}) => ({ name: 'Downtown Speakers', ver: 1, status: 'active', currentPeriodEnd: NOW + 10 * DAY, ...over });

  it('is free with no club, no clubId and no storage', async () => {
    expect(await resolveClubEntitlement(enforced(makeKv()), 'c1', NOW)).toMatchObject({ plan: 'free', entitled: false });
    expect(await resolveClubEntitlement(enforced(makeKv()), null, NOW)).toMatchObject({ plan: 'free', entitled: false });
    expect(await resolveClubEntitlement({ ENTITLEMENT_ENFORCE: '1' }, 'c1', NOW)).toMatchObject({ entitled: false });
  });

  it('reproduces every row of the grace table', async () => {
    const rows = [
      [{ status: 'active', currentPeriodEnd: NOW - DAY }, true],
      [{ status: 'trialing' }, true],
      [{ status: 'past_due', currentPeriodEnd: NOW - DAY }, true],
      [{ status: 'past_due', currentPeriodEnd: NOW - DAY - PAST_DUE_GRACE_MS - 1 }, false],
      [{ status: 'canceled', currentPeriodEnd: NOW + DAY }, true],
      [{ status: 'canceled', currentPeriodEnd: NOW - 1 }, false],
      [{ status: 'canceled', currentPeriodEnd: null }, false],
      [{ status: 'unpaid' }, false],
      [{ status: 'incomplete' }, false],
      [{ status: 'paused' }, false],
    ];

    for (const [over, expected] of rows) {
      const kv = makeKv({ [clubKey('c1')]: club(over) });
      // eslint-disable-next-line no-await-in-loop
      const e = await resolveClubEntitlement(enforced(kv), 'c1', NOW);
      expect(e.entitled, JSON.stringify(over)).toBe(expected);
      expect(e.plan).toBe(expected ? 'pro' : 'free');
      if (expected) expect(e.source).toBe('club');
    }
  });

  // Dev must keep letting club writes through without claiming the device is
  // on Pro: the client keys on `plan`, the server keys on `entitled`.
  it('entitles without lying about the plan when enforcement is off', async () => {
    const env = { PROFILES: makeKv({ [clubKey('c1')]: club({ status: 'unpaid' }) }), ENTITLEMENT_ENFORCE: '0' };
    expect(await resolveClubEntitlement(env, 'c1', NOW)).toMatchObject({ plan: 'free', entitled: true, source: 'unenforced' });
    expect(await resolveClubEntitlement(env, null, NOW)).toMatchObject({ plan: 'free', entitled: true });
  });

  it('still reports when a lapsed club ended', async () => {
    const kv = makeKv({ [clubKey('c1')]: club({ status: 'canceled', currentPeriodEnd: NOW - DAY }) });
    expect(await resolveClubEntitlement(enforced(kv), 'c1', NOW)).toMatchObject({
      plan: 'free', entitled: false, status: 'canceled', currentPeriodEnd: NOW - DAY,
    });
  });
});

describe('resolveAccess', () => {
  const enforced = (kv) => ({ PROFILES: kv, ENTITLEMENT_ENFORCE: '1' });
  const liveClub = { name: 'Downtown Speakers', ver: 1, status: 'active', currentPeriodEnd: null };

  it('is free when the request carried neither credential', async () => {
    expect(await resolveAccess(enforced(makeKv()), {}, NOW)).toMatchObject({ plan: 'free', entitled: false, club: null });
  });

  it('entitles on the club alone, and names it', async () => {
    const kv = makeKv({ [clubKey('c1')]: liveClub });
    expect(await resolveAccess(enforced(kv), { uid: 'u1', clubId: 'c1' }, NOW)).toMatchObject({
      plan: 'pro', entitled: true, source: 'club', club: { id: 'c1', name: 'Downtown Speakers' },
    });
  });

  it('entitles on the subscription alone, with no club to name', async () => {
    const kv = makeKv({ [entitlementKey('u1')]: record() });
    expect(await resolveAccess(enforced(kv), { uid: 'u1' }, NOW)).toMatchObject({
      plan: 'pro', entitled: true, source: 'subscription', club: null,
    });
  });

  // The buyer's own subscription wins ties: it is the one they can manage, and
  // the one the billing portal belongs to.
  it('prefers the caller\'s own subscription when both say yes', async () => {
    const kv = makeKv({ [entitlementKey('u1')]: record(), [clubKey('c1')]: liveClub });
    expect((await resolveAccess(enforced(kv), { uid: 'u1', clubId: 'c1' }, NOW)).source).toBe('subscription');
  });

  it('falls back to the club when the caller\'s own plan lapsed', async () => {
    const kv = makeKv({
      [entitlementKey('u1')]: record({ status: 'canceled', currentPeriodEnd: NOW - DAY }),
      [clubKey('c1')]: liveClub,
    });
    expect(await resolveAccess(enforced(kv), { uid: 'u1', clubId: 'c1' }, NOW)).toMatchObject({ entitled: true, source: 'club' });
  });

  // A guest: no uid at all, club only.
  it('works with no uid', async () => {
    const kv = makeKv({ [clubKey('c1')]: liveClub });
    expect(await resolveAccess(enforced(kv), { clubId: 'c1' }, NOW)).toMatchObject({ entitled: true, source: 'club' });
  });

  it('accepts an already-read club record rather than reading it twice', async () => {
    const kv = makeKv();
    expect(await resolveAccess(enforced(kv), { clubId: 'c1', club: liveClub }, NOW)).toMatchObject({ entitled: true });
  });

  it('reports the lapsed side that has history to show', async () => {
    const kv = makeKv({ [clubKey('c1')]: { ...liveClub, status: 'canceled', currentPeriodEnd: NOW - DAY } });
    expect(await resolveAccess(enforced(kv), { uid: 'u1', clubId: 'c1' }, NOW)).toMatchObject({
      plan: 'free', entitled: false, status: 'canceled', currentPeriodEnd: NOW - DAY,
    });
  });
});

describe('projectSubscription', () => {
  const base = {
    id: 'sub_1', status: 'active', customer: 'cus_1', cancel_at_period_end: false,
    metadata: { uid: 'u1' },
    items: { data: [{ price: { id: 'price_1', lookup_key: 'pro_monthly' }, current_period_end: 1_900_000_000 }] },
  };

  it('reads current_period_end from the subscription when present (older API versions)', () => {
    const r = projectSubscription({ ...base, current_period_end: 1_850_000_000 }, NOW);
    expect(r.currentPeriodEnd).toBe(1_850_000_000 * 1000);
  });

  it('falls back to the first item when the subscription has no period end (2025-03+)', () => {
    const r = projectSubscription(base, NOW);
    expect(r).toMatchObject({
      plan: 'pro', status: 'active', currentPeriodEnd: 1_900_000_000 * 1000, cancelAtPeriodEnd: false,
      stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', priceLookupKey: 'pro_monthly', updatedAt: NOW,
    });
  });

  it('accepts an expanded customer object and tolerates missing fields', () => {
    const r = projectSubscription({ id: 'sub_2', status: 'canceled', customer: { id: 'cus_9' } }, NOW);
    expect(r).toMatchObject({ status: 'canceled', stripeCustomerId: 'cus_9', currentPeriodEnd: null, priceLookupKey: null });
  });
});
