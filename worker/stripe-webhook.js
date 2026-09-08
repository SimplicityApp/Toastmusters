import { createStripeClient, verifyStripeSignature } from './stripe.js';
import { entitlementStore, projectSubscription, writeEntitlement } from './entitlements.js';
import { rememberCustomer, lookupUidByCustomer } from './billing.js';
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

async function applySubscription(env, stripe, subscriptionId, hintUid, now) {
  const fresh = await stripe.retrieveSubscription(subscriptionId);
  const customerId = idOf(fresh.customer);
  const uid = hintUid || (await resolveUid(env, { metadata: fresh.metadata, customerId }));
  if (!uid) {
    console.error(`Stripe subscription ${subscriptionId} has no uid; cannot project`);
    return { applied: false, reason: 'no_uid' };
  }
  await rememberCustomer(env, uid, customerId);
  await writeEntitlement(env, uid, projectSubscription(fresh, now));
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
      const subscriptionId = idOf(object.subscription);
      if (subscriptionId && stripe) {
        outcome = await applySubscription(env, stripe, subscriptionId, uid, now);
      }
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
