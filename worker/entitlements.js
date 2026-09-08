/**
 * What a user is allowed to use, and where that answer comes from.
 *
 * Paid tier = settings that follow you between devices + custom card artwork.
 * The timer itself is free, always.
 *
 * Stored server-side only. The profile document is client-writable with a
 * session token, so an entitlement flag in there would be a flag the client
 * sets on itself. These records are written by the Stripe webhook and by
 * hand (grants); no request handler lets a client touch them.
 *
 * Storage: a KV namespace bound as ENTITLEMENTS, falling back to PROFILES with
 * distinct key prefixes. Same Worker, same trust: the prefixes are what keep
 * the profile handler (which only ever reads `profile:zoom:<uid>`) away from
 * these keys. Binding a dedicated namespace later needs no code change.
 */

export const PLAN_FREE = 'free';
export const PLAN_PRO = 'pro';

/** After a failed renewal, keep the paid features this long before locking. */
export const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const KEY_ENTITLEMENT = (uid) => `entitlement:zoom:${uid}`;
const KEY_GRANT = (uid) => `grant:zoom:${uid}`;

/** @param {Object} env */
export function entitlementStore(env) {
  return env.ENTITLEMENTS ?? env.PROFILES ?? null;
}

/**
 * Enforcement is on unless the environment says "0". Dev runs with it off
 * until launch so testers are never locked out, while the UI still shows the
 * upgrade path for anyone on the free plan (the client keys on `plan`, the
 * server keys on `entitled`).
 */
export function isEnforced(env) {
  return env.ENTITLEMENT_ENFORCE !== '0';
}

const FREE = Object.freeze({
  plan: PLAN_FREE,
  status: null,
  entitled: false,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  source: 'none',
});

/**
 * Whether a stored subscription record still grants access at `now`.
 *
 * `active` and `trialing` obviously do. `past_due` keeps access for a grace
 * period past the period end so a bounced card does not lock someone out
 * minutes before their club meets. `canceled` keeps access until the paid-for
 * period runs out. Everything else (`unpaid`, `incomplete`, `paused`) does not.
 */
export function subscriptionGrantsAccess(record, now = Date.now()) {
  if (!record || typeof record !== 'object') return false;
  const periodEnd = typeof record.currentPeriodEnd === 'number' ? record.currentPeriodEnd : null;
  switch (record.status) {
    case 'active':
    case 'trialing':
      return true;
    case 'past_due':
      return periodEnd === null ? true : now < periodEnd + PAST_DUE_GRACE_MS;
    case 'canceled':
      return periodEnd !== null && now < periodEnd;
    default:
      return false;
  }
}

async function readJson(store, key) {
  try {
    return (await store.get(key, 'json')) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the caller's entitlement.
 *
 * Never throws and never rejects: this runs inside the session endpoint on
 * every app load, and a KV hiccup must degrade to "free", not to an error the
 * app has to handle.
 *
 * @param {Object} env
 * @param {string|null|undefined} uid
 * @param {number} [now]
 * @returns {Promise<{plan: string, status: string|null, entitled: boolean,
 *   currentPeriodEnd: number|null, cancelAtPeriodEnd: boolean, source: string}>}
 */
export async function resolveEntitlement(env, uid, now = Date.now()) {
  const enforced = isEnforced(env);
  const unenforced = (base) => (enforced ? base : { ...base, entitled: true, source: base.entitled ? base.source : 'unenforced' });

  if (!uid || typeof uid !== 'string') return unenforced({ ...FREE });

  const store = entitlementStore(env);
  if (!store) return unenforced({ ...FREE });

  const [record, grant] = await Promise.all([
    readJson(store, KEY_ENTITLEMENT(uid)),
    readJson(store, KEY_GRANT(uid)),
  ]);

  if (record && subscriptionGrantsAccess(record, now)) {
    return {
      plan: PLAN_PRO,
      status: record.status,
      entitled: true,
      currentPeriodEnd: record.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: Boolean(record.cancelAtPeriodEnd),
      source: 'subscription',
    };
  }

  // A grant is a hand-written comp: the owner, testers, a club that helped.
  // Optional expiry; no expiry means "until removed".
  if (grant && (typeof grant.exp !== 'number' || grant.exp > now)) {
    return {
      plan: PLAN_PRO,
      status: 'granted',
      entitled: true,
      currentPeriodEnd: typeof grant.exp === 'number' ? grant.exp : null,
      cancelAtPeriodEnd: false,
      source: 'grant',
    };
  }

  // A lapsed subscription is still worth reporting: the client can say
  // "your plan ended on …" instead of pretending it never existed.
  if (record) {
    return unenforced({
      plan: PLAN_FREE,
      status: record.status ?? null,
      entitled: false,
      currentPeriodEnd: record.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: Boolean(record.cancelAtPeriodEnd),
      source: 'none',
    });
  }

  return unenforced({ ...FREE });
}

/**
 * Turn a Stripe subscription object into the record we store.
 *
 * Accepts both shapes Stripe has used: `current_period_end` on the
 * subscription (API versions before 2025-03) and on each subscription item
 * (after). Seconds in, milliseconds out.
 *
 * @param {Object} subscription - Stripe Subscription
 * @param {number} [now]
 */
export function projectSubscription(subscription, now = Date.now()) {
  const item = subscription?.items?.data?.[0] ?? null;
  const periodEndSec =
    typeof subscription?.current_period_end === 'number'
      ? subscription.current_period_end
      : typeof item?.current_period_end === 'number'
        ? item.current_period_end
        : null;
  const customer = subscription?.customer;

  return {
    plan: PLAN_PRO,
    status: typeof subscription?.status === 'string' ? subscription.status : 'unknown',
    currentPeriodEnd: periodEndSec === null ? null : periodEndSec * 1000,
    cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
    stripeCustomerId: typeof customer === 'string' ? customer : (customer?.id ?? null),
    stripeSubscriptionId: subscription?.id ?? null,
    priceLookupKey: item?.price?.lookup_key ?? null,
    updatedAt: now,
  };
}

/** Persist a projected record for a user. */
export async function writeEntitlement(env, uid, record) {
  const store = entitlementStore(env);
  if (!store || !uid) return false;
  await store.put(KEY_ENTITLEMENT(uid), JSON.stringify(record));
  return true;
}

export const entitlementKey = KEY_ENTITLEMENT;
export const grantKey = KEY_GRANT;
