import { createStripeClient, verifyStripeSignature } from './stripe.js';
import { entitlementStore, projectSubscription, writeEntitlement } from './entitlements.js';
import { rememberCustomer, lookupUidByCustomer } from './billing.js';
import { clubByCustomerKey, clubPendingKey } from './club-admin.js';
import { createClubForSubscriber, syncClubToSubscription } from './club-create.js';
import { json, methodNotAllowed, notConfigured } from './http.js';

/**
 * POST /api/stripe/webhook — Stripe telling us a subscription changed.
 *
 * The only writer of entitlement records besides a hand grant.
 *
 * Order-independent on purpose. Stripe delivers events out of order and more
 * than once, so nothing here trusts the event body for the final state. Every
 * subscription event re-fetches the subscription from Stripe and projects that
 * into the record. Two events for the same subscription therefore converge on
 * the same answer whichever arrives last.
 *
 * Idempotency: each event id is remembered for 30 days once it has been fully
 * processed. A redelivery of a processed event is a 200 no-op. A failure
 * returns 500 without remembering, so Stripe retries.
 */

const EVENT_TTL_SEC = 30 * 24 * 60 * 60;
const KEY_EVENT = (id) => `stripe:event:${id}`;

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);

function idOf(ref) {
  return typeof ref === 'string' ? ref : (ref?.id ?? null);
}

/** The Zoom user a subscription belongs to, from metadata or the customer link. */
async function resolveUid(env, { metadata, customerId }) {
  const fromMeta = metadata?.uid;
  if (typeof fromMeta === 'string' && fromMeta) return fromMeta;
  return lookupUidByCustomer(env, customerId);
}

/**
 * Park what only checkout knows: what the buyer called their club, and an
 * address to reach them at.
 *
 * This is the first time the product stores an email address, and it is stored
 * here because this is the one moment it exists — leaving it in Stripe means
 * someone digs it out by hand later, from a dashboard the person minting clubs
 * may not even have access to.
 *
 * A human then runs `scripts/club-cli.mjs pending` over this prefix and calls
 * `createClubFromPending()`. Automating that is a one-line change: call the
 * same function from here.
 *
 * Skipped once the customer already owns a club, so a buyer who re-subscribes
 * after a lapse does not queue a second club for an operator to mistakenly mint.
 *
 * @returns {Promise<boolean>} whether a pending record was written
 */
async function rememberPendingClub(env, store, session, customerId, uid, now) {
  if (!customerId) return false;
  try {
    if (await store.get(clubByCustomerKey(customerId))) return false;
  } catch {
    // A read that failed must not cost us the record: fall through and write.
  }
  await store.put(
    clubPendingKey(customerId),
    JSON.stringify({
      uid: uid ?? null,
      clubName: session.metadata?.club_name ?? null,
      // Stripe collects this on its own page; we never ask for it ourselves.
      email: session.customer_details?.email ?? null,
      stripeCustomerId: customerId,
      checkoutSessionId: session.id ?? null,
      paidAt: now,
    })
  );
  return true;
}

/**
 * Create the buyer's club as part of the sale.
 *
 * Checkout is the one moment the club's name and an address to reach the buyer
 * both exist, and it is also the moment the buyer is paying attention — so the
 * club exists before they go looking for it, and nobody has to wait on an
 * operator. A failure here is never fatal to the sale: the caller falls back to
 * the pending record and the CLI, which is what that path is now for.
 *
 * @returns {Promise<boolean>} whether the club exists after this
 */
async function mintClubAtCheckout(env, stripe, session, customerId, uid, now) {
  if (!uid || !customerId) return false;
  try {
    const result = await createClubForSubscriber(env, {
      uid,
      clubName: session.metadata?.club_name ?? null,
      // Stripe collects this on its own page; we never ask for it ourselves.
      email: session.customer_details?.email ?? null,
      stripe,
      now,
    });
    if (!result.ok) {
      console.error(`Club creation at checkout refused for ${customerId}: ${result.error}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`Club creation at checkout failed for ${customerId}:`, error?.message || error);
    return false;
  }
}

async function applySubscription(env, stripe, subscriptionId, hintUid, now) {
  const fresh = await stripe.retrieveSubscription(subscriptionId);
  const customerId = idOf(fresh.customer);
  const uid = hintUid || (await resolveUid(env, { metadata: fresh.metadata, customerId }));
  if (!uid) {
    console.error(`Stripe subscription ${subscriptionId} has no uid; cannot project`);
    return { applied: false, reason: 'no_uid' };
  }
  const projected = projectSubscription(fresh, now);
  await rememberCustomer(env, uid, customerId);
  await writeEntitlement(env, uid, projected);
  // The club is the unit of Pro, so the buyer's record is only half the answer:
  // without this a club stays entitled long after the subscription paying for
  // it has gone, and every device in it keeps its presets, branding and archive.
  await syncClubToSubscription(env, customerId, projected);
  return { applied: true, uid };
}

/**
 * @param {Request} request
 * @param {Object} env - STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, PROFILES/ENTITLEMENTS
 * @param {{stripe?: Object, now?: number}} [deps]
 */
export async function handleStripeWebhook(request, env, deps = {}) {
  if (request.method !== 'POST') return methodNotAllowed();
  if (!env.STRIPE_WEBHOOK_SECRET) return notConfigured('Stripe webhook');
  const store = entitlementStore(env);
  if (!store) return notConfigured('Entitlement storage');

  const now = deps.now ?? Date.now();
  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature');
  if (!verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET, Math.floor(now / 1000))) {
    return json({ error: 'Invalid signature' }, 400);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!event?.id || typeof event.type !== 'string') return json({ error: 'Malformed event' }, 400);

  if (await store.get(KEY_EVENT(event.id))) {
    return json({ received: true, duplicate: true });
  }

  const stripe = deps.stripe ?? createStripeClient(env);
  const object = event.data?.object ?? {};

  try {
    let outcome = { applied: false, reason: 'ignored' };

    if (event.type === 'checkout.session.completed') {
      const uid = object.client_reference_id || object.metadata?.uid || null;
      const customerId = idOf(object.customer);
      if (uid && customerId) await rememberCustomer(env, uid, customerId);

      // Ahead of the club: creation copies the plan off the buyer's entitlement
      // record, so that record has to exist first.
      const subscriptionId = idOf(object.subscription);
      if (subscriptionId && stripe) {
        outcome = await applySubscription(env, stripe, subscriptionId, uid, now);
      }

      const minted = await mintClubAtCheckout(env, stripe, object, customerId, uid, now);
      // The operator path is now the exception rather than the rule: the
      // pending record is written only when creation could not happen, so
      // `scripts/club-cli.mjs pending` lists real failures instead of every sale.
      if (!minted) await rememberPendingClub(env, store, object, customerId, uid, now);
    } else if (SUBSCRIPTION_EVENTS.has(event.type)) {
      if (stripe && object.id) {
        outcome = await applySubscription(env, stripe, object.id, null, now);
      } else if (object.id) {
        // No secret key to re-fetch with: fall back to the event's own copy.
        const customerId = idOf(object.customer);
        const uid = await resolveUid(env, { metadata: object.metadata, customerId });
        if (uid) {
          await rememberCustomer(env, uid, customerId);
          await writeEntitlement(env, uid, projectSubscription(object, now));
          outcome = { applied: true, uid };
        }
      }
    } else if (event.type === 'invoice.payment_failed') {
      // The subscription moves to past_due on its own and arrives as
      // customer.subscription.updated; this event is a signal, not state.
      console.log('Stripe payment failed for customer', idOf(object.customer));
    }

    await store.put(KEY_EVENT(event.id), '1', { expirationTtl: EVENT_TTL_SEC });
    return json({ received: true, ...outcome });
  } catch (error) {
    console.error(`Stripe webhook ${event.type} (${event.id}) failed:`, error?.message || error);
    return json({ error: 'Processing failed' }, 500);
  }
}
