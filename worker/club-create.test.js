import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleClubCreate } from './club.js';
import { createClubForSubscriber, syncClubToSubscription } from './club-create.js';
import { createClubFromPending, clubByCustomerKey, clubPendingKey, clubMemberKey } from './club-admin.js';
import { clubKey, entitlementKey, resolveAccess } from './entitlements.js';
import { customerByUidKey } from './billing.js';
import { mintSessionToken } from './session-token.js';
import { verifyClubToken } from './club-token.js';

/**
 * Turning a payment into a club, without an operator in the loop.
 *
 * The club is the unit of Pro, so a subscriber who has none can reach none of
 * the features the plan is sold on. These cover who may mint one, what happens
 * when two callers try at once, and the plan fields the club inherits.
 */

const SIGNING_KEY = 'test-session-signing-key';
const NOW = 1_800_000_000_000;
const PERIOD_END = 1_900_000_000_000;

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

let kv;
let env;

beforeEach(() => {
  kv = makeKv();
  env = {
    PROFILES: kv,
    SESSION_SIGNING_KEY: SIGNING_KEY,
    ENTITLEMENT_ENFORCE: '1',
    WEB_ORIGIN: 'https://www.example.test',
  };
});

/** A subscriber who has paid: an entitlement record and a Stripe customer. */
function seedSubscriber(uid = 'u1', over = {}) {
  kv.store.set(
    entitlementKey(uid),
    JSON.stringify({
      plan: 'pro',
      status: 'active',
      currentPeriodEnd: PERIOD_END,
      cancelAtPeriodEnd: false,
      stripeCustomerId: 'cus_1',
      ...over,
    })
  );
  kv.store.set(customerByUidKey(uid), 'cus_1');
}

const createReq = (body = {}, { uid = 'u1' } = {}) =>
  new Request('https://www.example.test/api/club/create', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(uid ? { authorization: `Bearer ${mintSessionToken(uid, SIGNING_KEY)}` } : {}),
    },
    body: JSON.stringify(body),
  });

const clubOf = (clubId) => JSON.parse(kv.store.get(clubKey(clubId)));

// ---------------------------------------------------------------------------

describe('who may mint a club', () => {
  it('lets a paying subscriber create one', async () => {
    seedSubscriber();
    const result = await createClubForSubscriber(env, { uid: 'u1', clubName: 'Downtown Speakers', now: NOW });

    expect(result).toMatchObject({ ok: true, created: true });
    expect(clubOf(result.clubId)).toMatchObject({ name: 'Downtown Speakers', stripeCustomerId: 'cus_1' });
  });

  it('makes the creator the club admin', async () => {
    seedSubscriber();
    const { clubId } = await createClubForSubscriber(env, { uid: 'u1', now: NOW });
    expect(JSON.parse(kv.store.get(clubMemberKey(clubId, 'u1')))).toMatchObject({ role: 'admin' });
  });

  // Comp access is hand-written by an operator, and so are the clubs that go
  // with it: a grant must not become a way to mint unlimited clubs.
  it('refuses a comp grant', async () => {
    kv.store.set(`grant:zoom:u1`, JSON.stringify({ note: 'tester' }));
    kv.store.set(customerByUidKey('u1'), 'cus_1');
    expect(await createClubForSubscriber(env, { uid: 'u1', now: NOW })).toEqual({
      ok: false,
      error: 'not_a_subscriber',
      status: 403,
    });
  });

  it('refuses someone on a club code rather than their own subscription', async () => {
    // A club member has no entitlement record of their own at all.
    expect(await createClubForSubscriber(env, { uid: 'member-uid', now: NOW })).toMatchObject({
      error: 'not_a_subscriber',
      status: 403,
    });
  });

  it('refuses a subscriber the product has never seen pay', async () => {
    seedSubscriber();
    kv.store.delete(customerByUidKey('u1'));
    expect(await createClubForSubscriber(env, { uid: 'u1', now: NOW })).toMatchObject({
      error: 'no_billing_account',
      status: 409,
    });
  });

  // ENTITLEMENT_ENFORCE=0 reports 'unenforced' for anyone without a real
  // subscription. Refusing it would make this untestable on dev, which is the
  // only deployment it can safely be tested on.
  it('accepts an unenforced deployment, but still needs a billing account', async () => {
    env.ENTITLEMENT_ENFORCE = '0';
    kv.store.set(customerByUidKey('u1'), 'cus_1');
    expect(await createClubForSubscriber(env, { uid: 'u1', now: NOW })).toMatchObject({ ok: true });

    kv.store.delete(customerByUidKey('u2'));
    expect(await createClubForSubscriber(env, { uid: 'u2', now: NOW })).toMatchObject({
      error: 'no_billing_account',
    });
  });
});

describe('creating twice', () => {
  it('returns the club that exists rather than minting a second', async () => {
    seedSubscriber();
    const first = await createClubForSubscriber(env, { uid: 'u1', clubName: 'Downtown', now: NOW });
    const second = await createClubForSubscriber(env, { uid: 'u1', clubName: 'Something Else', now: NOW });

    expect(second).toMatchObject({ ok: true, clubId: first.clubId, created: false });
    expect(clubOf(second.clubId).name).toBe('Downtown');
  });

  it('refuses a second caller while the first is still in flight', async () => {
    seedSubscriber();
    kv.store.set('club-creating:cus_1', '1');
    expect(await createClubForSubscriber(env, { uid: 'u1', now: NOW })).toMatchObject({
      error: 'creation_in_progress',
      status: 409,
    });
  });

  // The lock is advisory — KV has no compare-and-set — so the customer index is
  // what actually decides, and the club that lost is cleaned up.
  it('yields to the winner when two creations raced past the lock', async () => {
    seedSubscriber();
    const rival = await createClubFromPending(
      env,
      { uid: 'u1', clubName: 'Rival', stripeCustomerId: 'cus_1' },
      { code: 'RVAL000001' }
    );
    // Undo the lock the rival never took, and point the index at it as a
    // concurrent writer would have.
    kv.store.delete('club-creating:cus_1');

    const late = await createClubForSubscriber(env, { uid: 'u1', clubName: 'Late', now: NOW });
    expect(late).toMatchObject({ ok: true, clubId: rival.clubId, created: false });
    expect(kv.store.has(clubKey(rival.clubId))).toBe(true);
  });
});

describe('what the club inherits', () => {
  it('consumes the pending record left by checkout', async () => {
    seedSubscriber();
    kv.store.set(
      clubPendingKey('cus_1'),
      JSON.stringify({ uid: 'u1', clubName: 'From Checkout', email: 'treasurer@downtown.example' })
    );

    const { clubId } = await createClubForSubscriber(env, { uid: 'u1', now: NOW });
    expect(clubOf(clubId)).toMatchObject({ name: 'From Checkout', billingEmail: 'treasurer@downtown.example' });
    expect(kv.store.has(clubPendingKey('cus_1'))).toBe(false);
  });

  it('prefers the name typed now over the one typed at checkout', async () => {
    seedSubscriber();
    kv.store.set(clubPendingKey('cus_1'), JSON.stringify({ clubName: 'From Checkout' }));
    const { clubId } = await createClubForSubscriber(env, { uid: 'u1', clubName: 'Typed Now', now: NOW });
    expect(clubOf(clubId).name).toBe('Typed Now');
  });

  it('falls back to the Stripe customer for an address nobody parked', async () => {
    seedSubscriber();
    const stripe = { retrieveCustomer: vi.fn(async () => ({ email: 'billing@downtown.example' })) };
    const { clubId } = await createClubForSubscriber(env, { uid: 'u1', stripe, now: NOW });

    expect(stripe.retrieveCustomer).toHaveBeenCalledWith('cus_1');
    expect(clubOf(clubId).billingEmail).toBe('billing@downtown.example');
  });

  it('survives Stripe being unreachable for the address', async () => {
    seedSubscriber();
    const stripe = { retrieveCustomer: vi.fn(async () => { throw new Error('stripe down'); }) };
    const { clubId } = await createClubForSubscriber(env, { uid: 'u1', stripe, now: NOW });
    expect(clubOf(clubId).billingEmail).toBeNull();
  });

  // Never 'active' by assumption: a club minted during a grace period has to
  // lapse when that period ends.
  it('copies the plan off the subscriber rather than assuming it is active', async () => {
    seedSubscriber('u1', { status: 'past_due', cancelAtPeriodEnd: true });
    const { clubId } = await createClubForSubscriber(env, { uid: 'u1', now: NOW });

    expect(clubOf(clubId)).toMatchObject({
      status: 'past_due',
      currentPeriodEnd: PERIOD_END,
      cancelAtPeriodEnd: true,
    });
  });
});

describe('POST /api/club/create', () => {
  it('needs a session: a guest device has nobody to make an admin', async () => {
    const res = await handleClubCreate(createReq({}, { uid: null }), env);
    expect(res.status).toBe(401);
  });

  it('hands the creator a working club token, so nobody types their own code', async () => {
    seedSubscriber();
    const res = await handleClubCreate(createReq({ clubName: 'Downtown Speakers' }), env);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ created: true, role: 'admin', entitled: true });
    expect(verifyClubToken(body.clubToken, SIGNING_KEY)).toMatchObject({ uid: 'u1' });
  });

  it('shows the admin the code and a link they can send', async () => {
    seedSubscriber();
    const body = await (await handleClubCreate(createReq({ clubName: 'Downtown Speakers' }), env)).json();

    expect(body.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{6}$/);
    expect(body.shareUrl).toBe(`https://www.example.test/pro/${body.code}`);
  });

  it('carries the device timezone onto the club', async () => {
    seedSubscriber();
    const body = await (await handleClubCreate(createReq({ timezone: 'America/Toronto' }), env)).json();
    expect(body.timezone).toBe('America/Toronto');
  });

  it('answers 403 for a club member and 409 for a subscriber with no customer', async () => {
    expect((await handleClubCreate(createReq({}, { uid: 'member-uid' }), env)).status).toBe(403);

    seedSubscriber('u2');
    kv.store.delete(customerByUidKey('u2'));
    expect((await handleClubCreate(createReq({}, { uid: 'u2' }), env)).status).toBe(409);
  });

  it('is safe to press twice', async () => {
    seedSubscriber();
    const first = await (await handleClubCreate(createReq({ clubName: 'Downtown' }), env)).json();
    const second = await (await handleClubCreate(createReq({ clubName: 'Downtown' }), env)).json();

    expect(second.created).toBe(false);
    expect(second.club.id).toBe(first.club.id);
  });
});

describe('the club follows the subscription', () => {
  async function seedClubForCustomer(over = {}) {
    return createClubFromPending(
      env,
      { uid: 'u1', clubName: 'Downtown Speakers', stripeCustomerId: 'cus_1', ...over },
      { code: 'DTSP7K2QM9' }
    );
  }

  const project = (over = {}) => ({
    status: 'active',
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    ...over,
  });

  it('writes the plan through to the club', async () => {
    const { clubId } = await seedClubForCustomer();
    expect(await syncClubToSubscription(env, 'cus_1', project({ status: 'canceled' }))).toBe(true);
    expect(clubOf(clubId)).toMatchObject({ status: 'canceled', currentPeriodEnd: PERIOD_END });
  });

  it('leaves ver alone, so no device re-fetches presets nothing changed', async () => {
    const { clubId } = await seedClubForCustomer();
    kv.store.set(clubKey(clubId), JSON.stringify({ ...clubOf(clubId), ver: 7 }));
    await syncClubToSubscription(env, 'cus_1', project({ status: 'past_due' }));
    expect(clubOf(clubId).ver).toBe(7);
  });

  it('does nothing for a customer with no club', async () => {
    expect(await syncClubToSubscription(env, 'cus_nobody', project())).toBe(false);
  });

  // The whole point: a cancelled subscription has to take the club's Pro with
  // it, which is what every device reads on its next refresh.
  it('lapses the club once the paid-for period has run out', async () => {
    const { clubId } = await seedClubForCustomer();
    await syncClubToSubscription(env, 'cus_1', project({ status: 'canceled' }));

    const during = await resolveAccess(env, { clubId }, PERIOD_END - 1);
    const after = await resolveAccess(env, { clubId }, PERIOD_END + 1);
    expect(during.entitled).toBe(true);
    expect(after.entitled).toBe(false);
  });

  it('gives a failed payment seven days of grace, then stops', async () => {
    const { clubId } = await seedClubForCustomer();
    await syncClubToSubscription(env, 'cus_1', project({ status: 'past_due' }));

    const WEEK = 7 * 24 * 60 * 60 * 1000;
    expect((await resolveAccess(env, { clubId }, PERIOD_END + WEEK - 1)).entitled).toBe(true);
    expect((await resolveAccess(env, { clubId }, PERIOD_END + WEEK + 1)).entitled).toBe(false);
  });

  it('restores the club on renewal, with nothing re-entered', async () => {
    const { clubId } = await seedClubForCustomer();
    await syncClubToSubscription(env, 'cus_1', project({ status: 'canceled' }));
    expect((await resolveAccess(env, { clubId }, PERIOD_END + 1)).entitled).toBe(false);

    await syncClubToSubscription(env, 'cus_1', project({ currentPeriodEnd: PERIOD_END * 2 }));
    expect((await resolveAccess(env, { clubId }, PERIOD_END + 1)).entitled).toBe(true);
    expect(clubOf(clubId).name).toBe('Downtown Speakers');
  });
});

// KV is eventually consistent, and the member row making the creator an admin
// was written moments earlier. The one response that must always carry the code
// is the one that just minted it.
describe('the create response does not depend on a fresh role read', () => {
  it('returns the code even when the role lookup has not caught up', async () => {
    kv.store.set(
      entitlementKey('u1'),
      JSON.stringify({ plan: 'pro', status: 'active', currentPeriodEnd: PERIOD_END, stripeCustomerId: 'cus_1' })
    );
    kv.store.set(customerByUidKey('u1'), 'cus_1');

    // A store that never returns the member row: the worst the lag can do.
    const laggy = { ...kv, get: async (key, type) => (key.startsWith('club-member:') ? null : kv.get(key, type)) };
    const body = await (await handleClubCreate(createReq({ clubName: 'Downtown' }), { ...env, PROFILES: laggy })).json();

    expect(body.role).toBeNull();
    expect(body.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{6}$/);
    expect(body.shareUrl).toContain('/pro/');
  });
});
