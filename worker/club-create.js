import {
  clubByCodeKey,
  clubByCustomerKey,
  clubPendingKey,
  createClubFromPending,
} from './club-admin.js';
import { entitlementStore, clubKey, isEnforced, resolveEntitlement } from './entitlements.js';
import { lookupCustomerId } from './billing.js';

/**
 * Turning a payment into a club.
 *
 * Before this existed the only path ran through an operator: the webhook parked
 * `club-pending:<cus>` and a human ran `scripts/club-cli.mjs`. That left every
 * subscriber from before the club bundle with personal Pro and no way to reach
 * any of the features the plan is sold on, because the club is the unit of Pro
 * and nothing in the product created one.
 *
 * One function, two callers — the checkout webhook and the self-serve endpoint
 * — so "create a club" cannot come to mean two different things. Both are
 * idempotent on the Stripe customer, which is what makes a double-click, a
 * webhook retry, and a buyer who presses the button while the webhook is still
 * in flight all resolve to the same club.
 */

/**
 * A short advisory lock around creation.
 *
 * KV has no compare-and-set, so this is not a mutex and is not treated as one:
 * it closes the common window (a double-click, or the webhook and the button
 * racing seconds apart) while `club-by-customer:<cus>` remains the actual
 * guard, re-read after the write below.
 */
const clubCreatingKey = (customerId) => `club-creating:${customerId}`;
const LOCK_TTL_SEC = 60;

/** Sources that may mint a club. Comp grants stay operator-only, through the CLI. */
function mayCreate(env, entitlement) {
  if (entitlement.source === 'subscription') return true;
  // A deployment with ENTITLEMENT_ENFORCE=0 (dev) reports 'unenforced' for
  // anyone without a real subscription. Refusing it there would make this
  // endpoint untestable on the only deployment it can safely be tested on.
  return !isEnforced(env) && entitlement.source === 'unenforced';
}

const failure = (error, status) => ({ ok: false, error, status });

/**
 * Mint the club a paying subscriber is entitled to, or return the one they have.
 *
 * @param {Object} env
 * @param {{uid: string, clubName?: string|null, timezone?: string|null,
 *   email?: string|null, stripe?: Object|null, now?: number}} input
 *   `email` is what checkout collected, when the caller has it; otherwise the
 *   pending record and then the Stripe customer are consulted.
 * @returns {Promise<{ok: true, clubId: string, code: string, club: Object,
 *   created: boolean} | {ok: false, error: string, status: number}>}
 */
export async function createClubForSubscriber(env, input = {}) {
  const { uid, clubName = null, timezone = null, email = null, stripe = null } = input;
  const now = input.now ?? Date.now();

  const store = entitlementStore(env);
  if (!store) return failure('club_storage_unavailable', 503);
  if (!uid) return failure('not_a_subscriber', 403);

  const entitlement = await resolveEntitlement(env, uid, now);
  if (!mayCreate(env, entitlement)) return failure('not_a_subscriber', 403);

  // The club is keyed by the Stripe customer, so a buyer the product has never
  // seen pay has nothing to key it on. This is also what stops an unenforced
  // dev deployment from minting clubs with no billing behind them.
  const customerId = await lookupCustomerId(env, uid);
  if (!customerId) return failure('no_billing_account', 409);

  const existing = await readExistingClub(store, customerId);
  if (existing) return { ok: true, ...existing, created: false };

  if (await store.get(clubCreatingKey(customerId))) return failure('creation_in_progress', 409);
  await store.put(clubCreatingKey(customerId), '1', { expirationTtl: LOCK_TTL_SEC });

  try {
    const pending = await readJson(store, clubPendingKey(customerId));

    const created = await createClubFromPending(
      env,
      {
        uid,
        // What the officer typed now beats what they typed at checkout, which
        // beats the placeholder createClubFromPending names after the code.
        clubName: clubName?.trim() || pending?.clubName || null,
        email: email || pending?.email || (await stripeEmail(stripe, customerId)),
        stripeCustomerId: customerId,
        // Copied from the plan the buyer actually has, never assumed active: a
        // club minted during a grace period must lapse when that period ends.
        status: entitlement.status ?? undefined,
        currentPeriodEnd: entitlement.currentPeriodEnd,
        cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd,
        timezone,
      },
      { now }
    );

    // Lost a race? The lock is advisory, so this is the check that actually
    // decides. Whoever the customer index names is the club; the other one is
    // unreachable by code or customer and is cleaned up rather than left behind.
    const winner = await readExistingClub(store, customerId);
    if (winner && winner.clubId !== created.clubId) {
      await discard(store, created);
      return { ok: true, ...winner, created: false };
    }

    // Housekeeping, not part of the transaction: the club exists either way,
    // and a leftover pending record only means an operator sees a row the CLI
    // will refuse as already-created.
    await safeDelete(store, clubPendingKey(customerId));
    return { ok: true, clubId: created.clubId, code: created.code, club: created.club, created: true };
  } finally {
    await safeDelete(store, clubCreatingKey(customerId));
  }
}

/**
 * Keep a club's plan in step with the subscription that pays for it.
 *
 * `clubEntitlement` already runs a club record through the same
 * `subscriptionGrantsAccess` as a user record, so cancellation, the seven-day
 * past-due grace and renewal all work the moment these three fields arrive.
 * Until they did, a club stayed entitled forever.
 *
 * @returns {Promise<boolean>} whether a club was found and updated
 */
export async function syncClubToSubscription(env, customerId, projected) {
  if (!customerId || !projected) return false;
  const store = entitlementStore(env);
  if (!store) return false;

  const clubId = await store.get(clubByCustomerKey(customerId)).catch(() => null);
  if (!clubId) return false;
  const club = await readJson(store, clubKey(clubId));
  if (!club) return false;

  // `ver` is left alone on purpose: it tracks content, and bumping it here
  // would make every device in the club re-fetch presets nothing changed.
  await store.put(
    clubKey(clubId),
    JSON.stringify({
      ...club,
      status: projected.status,
      currentPeriodEnd: projected.currentPeriodEnd,
      cancelAtPeriodEnd: Boolean(projected.cancelAtPeriodEnd),
    })
  );
  return true;
}

// ---------------------------------------------------------------------------

/** A delete whose failure must never undo work that already succeeded. */
async function safeDelete(store, key) {
  try {
    await store.delete(key);
  } catch {
    // Nothing here is load-bearing: the lock expires on its own, and a stale
    // pending record is refused by the CLI rather than acted on.
  }
}

async function readJson(store, key) {
  try {
    return (await store.get(key, 'json')) ?? null;
  } catch {
    return null;
  }
}

async function readExistingClub(store, customerId) {
  const clubId = await store.get(clubByCustomerKey(customerId)).catch(() => null);
  if (!clubId) return null;
  const club = await readJson(store, clubKey(clubId));
  if (!club) return null;
  return { clubId, code: club.code, club };
}

/** The buyer's address, when only Stripe knows it. Never fatal. */
async function stripeEmail(stripe, customerId) {
  if (!stripe?.retrieveCustomer) return null;
  try {
    const customer = await stripe.retrieveCustomer(customerId);
    return typeof customer?.email === 'string' ? customer.email : null;
  } catch {
    return null;
  }
}

/** Unpick a club that lost the race. Its code index is the only way back to it. */
async function discard(store, created) {
  await safeDelete(store, clubKey(created.clubId));
  await safeDelete(store, clubByCodeKey(created.code));
}
