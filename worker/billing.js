import { readSession } from './auth.js';
import { entitlementStore } from './entitlements.js';
import { createStripeClient, StripeError } from './stripe.js';
import { flagEnabled } from './flags.js';
import { json, unauthorized, notFound, methodNotAllowed, notConfigured } from './http.js';

/**
 * Buying and managing the paid plan.
 *
 *  POST /api/billing/checkout        {interval: 'monthly'|'yearly'} → {url}
 *  POST /api/billing/portal                                         → {url}
 *  GET  /api/billing/checkout-status?session_id=cs_…                → {paid}
 *
 * Checkout and the Billing Portal are Stripe-hosted pages. The Zoom app opens
 * them in the system browser (Zoom's webview does not run payment forms), so
 * every URL Stripe sends the user back to is on the web host: WEB_ORIGIN, a
 * per-environment var, never the request's Host header.
 *
 * Prices are found by lookup key (`pro_monthly`, `pro_yearly`), so the same
 * code runs against test and live accounts; only the secret differs.
 *
 * Checkout and the portal sit behind the `pro` release flag
 * (worker/flags.js): while it is off for a caller, both answer a bare 404.
 */

export const LOOKUP_KEYS = Object.freeze({ monthly: 'pro_monthly', yearly: 'pro_yearly' });

const KEY_CUSTOMER_BY_UID = (uid) => `stripe:customer-by-uid:zoom:${uid}`;
const KEY_UID_BY_CUSTOMER = (customerId) => `stripe:customer:${customerId}`;

/** @param {string} uid */
export const customerByUidKey = KEY_CUSTOMER_BY_UID;
/** @param {string} customerId */
export const uidByCustomerKey = KEY_UID_BY_CUSTOMER;

/** Remember both directions of the Stripe customer ↔ Zoom user link. */
export async function rememberCustomer(env, uid, customerId) {
  const store = entitlementStore(env);
  if (!store || !uid || !customerId) return;
  await Promise.all([
    store.put(KEY_CUSTOMER_BY_UID(uid), customerId),
    store.put(KEY_UID_BY_CUSTOMER(customerId), uid),
  ]);
}

export async function lookupCustomerId(env, uid) {
  const store = entitlementStore(env);
  if (!store || !uid) return null;
  try {
    return (await store.get(KEY_CUSTOMER_BY_UID(uid))) || null;
  } catch {
    return null;
  }
}

export async function lookupUidByCustomer(env, customerId) {
  const store = entitlementStore(env);
  if (!store || !customerId) return null;
  try {
    return (await store.get(KEY_UID_BY_CUSTOMER(customerId))) || null;
  } catch {
    return null;
  }
}

async function findOrCreateCustomer(stripe, env, uid) {
  const existing = await lookupCustomerId(env, uid);
  if (existing) return existing;
  const customer = await stripe.createCustomer({ metadata: { uid, zoom_uid: uid } });
  await rememberCustomer(env, uid, customer.id);
  return customer.id;
}

async function readJsonBody(request) {
  try {
    return (await request.json()) ?? {};
  } catch {
    return {};
  }
}

function stripeFailure(error, what) {
  if (error instanceof StripeError) {
    console.error(`Stripe ${what} failed:`, error.status, error.code, error.message);
    return json({ error: `Could not ${what}` }, 502);
  }
  console.error(`${what} failed:`, error?.message || error);
  return json({ error: `Could not ${what}` }, 500);
}

const CHECKOUT_SESSION_ID = /^cs_[A-Za-z0-9_]+$/;

/**
 * Long enough for "Downtown Toastmasters Speakers Club of Greater Toronto",
 * short enough that a pasted paragraph cannot approach Stripe's 500-character
 * metadata-value limit and get the whole Checkout session rejected.
 */
export const MAX_CLUB_NAME_LENGTH = 80;

/**
 * The club's name, as it is safe to carry into Stripe metadata.
 *
 * Optional by design: an empty field must never block a purchase. The club is
 * minted with a generated placeholder instead, and renaming is a one-field
 * edit — whereas a buyer stopped at a required field is a sale lost.
 *
 * @param {unknown} value
 * @returns {string|null} null when there is nothing worth sending
 */
export function readClubName(value) {
  if (typeof value !== 'string') return null;
  const collapsed = value.trim().replace(/\s+/g, ' ');
  return collapsed ? collapsed.slice(0, MAX_CLUB_NAME_LENGTH) : null;
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {Object} env
 * @param {{stripe?: Object, ctx?: Object}} [deps] - injectable client for tests;
 *   ctx lets the flag answer be cached at the edge
 */
export async function handleBilling(request, url, env, deps = {}) {
  const stripe = deps.stripe ?? createStripeClient(env);
  if (!stripe) return notConfigured('Billing');
  if (!env.WEB_ORIGIN) return notConfigured('Billing (WEB_ORIGIN)');

  const route = url.pathname.slice('/api/billing/'.length);

  // Unauthenticated on purpose: the success page in the system browser has no
  // session (the token lives in the Zoom webview). It learns one bit — whether
  // this specific Checkout session was paid — from an id only Stripe and the
  // buyer's browser have seen.
  if (route === 'checkout-status') {
    if (request.method !== 'GET') return methodNotAllowed();
    const sessionId = url.searchParams.get('session_id') || '';
    if (!CHECKOUT_SESSION_ID.test(sessionId)) return json({ error: 'Invalid session id' }, 400);
    try {
      const session = await stripe.retrieveCheckoutSession(sessionId);
      const paid = session?.payment_status === 'paid' || session?.status === 'complete';
      return json({ paid: Boolean(paid) });
    } catch (error) {
      if (error instanceof StripeError && error.status === 404) return json({ paid: false }, 404);
      return stripeFailure(error, 'read checkout status');
    }
  }

  const session = readSession(request, env);
  if (!session) return unauthorized();

  // Until pro is released, checkout and the portal do not exist. After the
  // session check, so an unauthenticated caller still gets 401 as before;
  // checkout-status above stays open because Stripe's success page polls it.
  if (!(await flagEnabled(env, 'pro', { uid: session.uid }, deps.ctx))) {
    console.log('flag off: pro', route);
    return notFound();
  }

  if (request.method !== 'POST') return methodNotAllowed();

  if (route === 'checkout') {
    const body = await readJsonBody(request);
    const interval = body.interval === 'yearly' ? 'yearly' : body.interval === 'monthly' ? 'monthly' : null;
    if (!interval) return json({ error: 'interval must be monthly or yearly' }, 400);

    try {
      const priceId = await stripe.findPriceByLookupKey(LOOKUP_KEYS[interval]);
      if (!priceId) {
        console.error(`No active Stripe price with lookup key ${LOOKUP_KEYS[interval]}`);
        return json({ error: 'Plan is not available' }, 503);
      }
      const customer = await findOrCreateCustomer(stripe, env, session.uid);

      // Payment is the one moment the club's name naturally exists, so it rides
      // along with it. Both bags, because the two are read at different times:
      // the session's on `checkout.session.completed`, the subscription's by
      // every later subscription event and by anyone reading the dashboard.
      const clubName = readClubName(body.clubName);
      const metadata = () => ({ uid: session.uid, ...(clubName ? { club_name: clubName } : {}) });

      const checkout = await stripe.createCheckoutSession({
        mode: 'subscription',
        customer,
        client_reference_id: session.uid,
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: metadata(),
        subscription_data: { metadata: metadata() },
        allow_promotion_codes: true,
        // Stripe Tax has to be switched on in the dashboard first, and Checkout
        // refuses the session if it is not. Opt in per environment.
        ...(env.STRIPE_AUTOMATIC_TAX === '1' ? { automatic_tax: { enabled: true } } : {}),
        success_url: `${env.WEB_ORIGIN}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${env.WEB_ORIGIN}/billing/cancel`,
      });

      if (!checkout?.url) return json({ error: 'Could not start checkout' }, 502);
      return json({ url: checkout.url, sessionId: checkout.id ?? null });
    } catch (error) {
      return stripeFailure(error, 'start checkout');
    }
  }

  if (route === 'portal') {
    const customer = await lookupCustomerId(env, session.uid);
    if (!customer) return json({ error: 'No billing account yet' }, 404);
    try {
      const portal = await stripe.createPortalSession({
        customer,
        return_url: `${env.WEB_ORIGIN}/account`,
      });
      if (!portal?.url) return json({ error: 'Could not open billing portal' }, 502);
      return json({ url: portal.url });
    } catch (error) {
      return stripeFailure(error, 'open billing portal');
    }
  }

  return notFound();
}
