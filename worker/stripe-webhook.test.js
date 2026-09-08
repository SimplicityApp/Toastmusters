import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleStripeWebhook } from './stripe-webhook.js';
import { signStripePayload } from './stripe.js';
import { entitlementKey, resolveEntitlement } from './entitlements.js';
import { uidByCustomerKey, customerByUidKey } from './billing.js';

const WEBHOOK_SECRET = 'whsec_test';
const NOW = 1_800_000_000_000;

function makeKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  const puts = [];
  return {
    store,
    puts,
    get: async (key, type) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key, value, options) => { store.set(key, value); puts.push({ key, options }); },
  };
}

const activeSub = (over = {}) => ({
  id: 'sub_1',
  status: 'active',
  customer: 'cus_1',
  cancel_at_period_end: false,
  metadata: { uid: 'u1' },
  items: { data: [{ price: { id: 'price_m', lookup_key: 'pro_monthly' }, current_period_end: 1_900_000_000 }] },
  ...over,
});

let kv;
let env;
let stripe;

beforeEach(() => {
  kv = makeKv();
  env = { PROFILES: kv, STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, ENTITLEMENT_ENFORCE: '1' };
  stripe = { retrieveSubscription: vi.fn(async () => activeSub()) };
});

function deliver(event, { sign = true, at = NOW, secret = WEBHOOK_SECRET, method = 'POST' } = {}) {
  const body = JSON.stringify(event);
  const headers = { 'content-type': 'application/json' };
  if (sign) headers['stripe-signature'] = signStripePayload(body, secret, Math.floor(at / 1000));
  const request = new Request('https://www.example.test/api/stripe/webhook', {
    method,
    headers,
    ...(method === 'GET' ? {} : { body }),
  });
  return handleStripeWebhook(request, env, { stripe, now: NOW });
}

const event = (type, object, id = 'evt_1') => ({ id, type, data: { object } });

describe('handleStripeWebhook security', () => {
  it('rejects unsigned, mis-signed and stale deliveries', async () => {
    const e = event('customer.subscription.updated', activeSub());
    expect((await deliver(e, { sign: false })).status).toBe(400);
    expect((await deliver(e, { secret: 'whsec_wrong' })).status).toBe(400);
    expect((await deliver(e, { at: NOW - 10 * 60 * 1000 })).status).toBe(400);
    expect(kv.store.has(entitlementKey('u1'))).toBe(false);
  });

  it('only accepts POST and needs its secret configured', async () => {
    expect((await deliver(event('x', {}), { method: 'GET' })).status).toBe(405);
    env.STRIPE_WEBHOOK_SECRET = undefined;
    expect((await deliver(event('x', {}))).status).toBe(503);
  });
});

describe('subscription lifecycle', () => {
  it('projects a checkout completion into a pro entitlement and links the customer', async () => {
    const res = await deliver(
      event('checkout.session.completed', { id: 'cs_1', client_reference_id: 'u1', customer: 'cus_1', subscription: 'sub_1' })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, applied: true, uid: 'u1' });
    expect(stripe.retrieveSubscription).toHaveBeenCalledWith('sub_1');
    expect(kv.store.get(customerByUidKey('u1'))).toBe('cus_1');
    expect(kv.store.get(uidByCustomerKey('cus_1'))).toBe('u1');
    expect(await resolveEntitlement(env, 'u1', NOW)).toMatchObject({ plan: 'pro', entitled: true, source: 'subscription' });
  });

  // The event body is never the final word: the subscription is re-fetched, so
  // an old "active" arriving after a newer "canceled" cannot resurrect access.
  it('re-fetches the subscription so out-of-order events converge', async () => {
    stripe.retrieveSubscription.mockResolvedValue(activeSub({ status: 'canceled', items: { data: [{ current_period_end: 1_700_000_000 }] } }));
    await deliver(event('customer.subscription.updated', activeSub({ status: 'active' }), 'evt_late_active'));

    const stored = JSON.parse(kv.store.get(entitlementKey('u1')));
    expect(stored.status).toBe('canceled');
    expect((await resolveEntitlement(env, 'u1', NOW)).entitled).toBe(false);
  });

  it('finds the uid through the customer link when metadata is missing', async () => {
    kv.store.set(uidByCustomerKey('cus_1'), 'u1');
    stripe.retrieveSubscription.mockResolvedValue(activeSub({ metadata: {} }));
    const res = await deliver(event('customer.subscription.created', activeSub({ metadata: {} })));
    expect(await res.json()).toMatchObject({ applied: true, uid: 'u1' });
  });

  it('acknowledges but cannot apply a subscription with no known user', async () => {
    stripe.retrieveSubscription.mockResolvedValue(activeSub({ metadata: {}, customer: 'cus_stranger' }));
    const res = await deliver(event('customer.subscription.created', activeSub({ metadata: {}, customer: 'cus_stranger' })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: false, reason: 'no_uid' });
  });

  it('marks deletion by projecting the canceled subscription', async () => {
    kv.store.set(entitlementKey('u1'), JSON.stringify({ status: 'active', currentPeriodEnd: NOW + 1 }));
    stripe.retrieveSubscription.mockResolvedValue(activeSub({ status: 'canceled', items: { data: [{ current_period_end: Math.floor(NOW / 1000) - 60 }] } }));
    await deliver(event('customer.subscription.deleted', activeSub({ status: 'canceled' })));
    expect((await resolveEntitlement(env, 'u1', NOW)).entitled).toBe(false);
  });

  it('treats a payment failure as a signal only', async () => {
    const res = await deliver(event('invoice.payment_failed', { customer: 'cus_1' }));
    expect(res.status).toBe(200);
    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
    expect(kv.store.has(entitlementKey('u1'))).toBe(false);
  });

  it('falls back to the event body when no secret key is available to re-fetch', async () => {
    env.STRIPE_SECRET_KEY = undefined;
    const res = await handleStripeWebhook(
      new Request('https://x/api/stripe/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': signStripePayload(JSON.stringify(event('customer.subscription.updated', activeSub())), WEBHOOK_SECRET, Math.floor(NOW / 1000)) },
        body: JSON.stringify(event('customer.subscription.updated', activeSub())),
      }),
      env,
      { now: NOW }
    );
    expect(await res.json()).toMatchObject({ applied: true, uid: 'u1' });
  });
});

describe('idempotency and retries', () => {
  it('processes an event once and treats redelivery as a no-op', async () => {
    await deliver(event('customer.subscription.updated', activeSub(), 'evt_same'));
    const again = await deliver(event('customer.subscription.updated', activeSub(), 'evt_same'));
    expect(await again.json()).toEqual({ received: true, duplicate: true });
    expect(stripe.retrieveSubscription).toHaveBeenCalledTimes(1);

    const marker = kv.puts.find((p) => p.key === 'stripe:event:evt_same');
    expect(marker.options).toEqual({ expirationTtl: 30 * 24 * 60 * 60 });
  });

  it('returns 500 without remembering the event when processing fails, so Stripe retries', async () => {
    stripe.retrieveSubscription.mockRejectedValue(new Error('stripe down'));
    const res = await deliver(event('customer.subscription.updated', activeSub(), 'evt_fail'));
    expect(res.status).toBe(500);
    expect(kv.store.has('stripe:event:evt_fail')).toBe(false);
  });

  it('rejects malformed JSON and events without an id', async () => {
    const raw = 'not json';
    const res = await handleStripeWebhook(
      new Request('https://x/api/stripe/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': signStripePayload(raw, WEBHOOK_SECRET, Math.floor(NOW / 1000)) },
        body: raw,
      }),
      env,
      { stripe, now: NOW }
    );
    expect(res.status).toBe(400);
    expect((await deliver({ type: 'x', data: {} })).status).toBe(400);
  });
});
