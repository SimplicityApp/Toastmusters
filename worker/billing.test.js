import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleBilling, customerByUidKey, uidByCustomerKey } from './billing.js';
import { mintSessionToken } from './session-token.js';

const SIGNING_KEY = 'test-session-signing-key';

function makeKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (key, type) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key, value) => { store.set(key, value); },
  };
}

function fakeStripe(over = {}) {
  return {
    findPriceByLookupKey: vi.fn(async (key) => (key === 'pro_monthly' ? 'price_m' : key === 'pro_yearly' ? 'price_y' : null)),
    createCustomer: vi.fn(async () => ({ id: 'cus_new' })),
    createCheckoutSession: vi.fn(async () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' })),
    retrieveCheckoutSession: vi.fn(async () => ({ id: 'cs_1', payment_status: 'paid', status: 'complete' })),
    createPortalSession: vi.fn(async () => ({ url: 'https://billing.stripe.com/p/1' })),
    retrieveSubscription: vi.fn(),
    ...over,
  };
}

let kv;
let env;
let stripe;

beforeEach(() => {
  kv = makeKv();
  env = { PROFILES: kv, SESSION_SIGNING_KEY: SIGNING_KEY, STRIPE_SECRET_KEY: 'sk_test', WEB_ORIGIN: 'https://www.example.test' };
  stripe = fakeStripe();
});

function call(path, { method = 'POST', uid, body, token, query = '' } = {}) {
  const bearer = token ?? (uid ? mintSessionToken(uid, SIGNING_KEY) : null);
  const url = new URL(`https://zoom.example.test${path}${query}`);
  const request = new Request(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return handleBilling(request, url, env, { stripe });
}

describe('handleBilling configuration', () => {
  it('answers 503 when Stripe or WEB_ORIGIN is not configured', async () => {
    const noKey = new URL('https://x/api/billing/checkout');
    expect((await handleBilling(new Request(noKey, { method: 'POST' }), noKey, { ...env, STRIPE_SECRET_KEY: undefined })).status).toBe(503);
    expect((await handleBilling(new Request(noKey, { method: 'POST' }), noKey, { ...env, WEB_ORIGIN: undefined }, { stripe })).status).toBe(503);
  });
});

describe('POST /api/billing/checkout', () => {
  it('requires a session', async () => {
    expect((await call('/api/billing/checkout', { body: { interval: 'monthly' } })).status).toBe(401);
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('rejects an unknown interval', async () => {
    const res = await call('/api/billing/checkout', { uid: 'u1', body: { interval: 'weekly' } });
    expect(res.status).toBe(400);
  });

  it('creates a customer once, then a subscription checkout bound to the uid', async () => {
    const res = await call('/api/billing/checkout', { uid: 'u1', body: { interval: 'yearly' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://checkout.stripe.com/c/cs_1', sessionId: 'cs_1' });

    expect(stripe.createCustomer).toHaveBeenCalledWith({ metadata: { uid: 'u1', zoom_uid: 'u1' } });
    expect(kv.store.get(customerByUidKey('u1'))).toBe('cus_new');
    expect(kv.store.get(uidByCustomerKey('cus_new'))).toBe('u1');

    const params = stripe.createCheckoutSession.mock.calls[0][0];
    expect(params).toMatchObject({
      mode: 'subscription',
      customer: 'cus_new',
      client_reference_id: 'u1',
      line_items: [{ price: 'price_y', quantity: 1 }],
      metadata: { uid: 'u1' },
      subscription_data: { metadata: { uid: 'u1' } },
      success_url: 'https://www.example.test/billing/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://www.example.test/billing/cancel',
    });
    expect(params.automatic_tax).toBeUndefined();
  });

  it('reuses the remembered customer on a second checkout', async () => {
    kv.store.set(customerByUidKey('u1'), 'cus_existing');
    await call('/api/billing/checkout', { uid: 'u1', body: { interval: 'monthly' } });
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect(stripe.createCheckoutSession.mock.calls[0][0].customer).toBe('cus_existing');
  });

  it('enables automatic tax only when the environment opts in', async () => {
    env.STRIPE_AUTOMATIC_TAX = '1';
    await call('/api/billing/checkout', { uid: 'u1', body: { interval: 'monthly' } });
    expect(stripe.createCheckoutSession.mock.calls[0][0].automatic_tax).toEqual({ enabled: true });
  });

  it('answers 503 when the price for the plan does not exist yet', async () => {
    stripe.findPriceByLookupKey.mockResolvedValue(null);
    expect((await call('/api/billing/checkout', { uid: 'u1', body: { interval: 'monthly' } })).status).toBe(503);
  });
});

describe('POST /api/billing/portal', () => {
  it('requires a session and an existing customer', async () => {
    expect((await call('/api/billing/portal')).status).toBe(401);
    expect((await call('/api/billing/portal', { uid: 'u1' })).status).toBe(404);
  });

  it('opens the portal for the remembered customer, returning to the account page', async () => {
    kv.store.set(customerByUidKey('u1'), 'cus_1');
    const res = await call('/api/billing/portal', { uid: 'u1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://billing.stripe.com/p/1' });
    expect(stripe.createPortalSession).toHaveBeenCalledWith({ customer: 'cus_1', return_url: 'https://www.example.test/account' });
  });
});

describe('GET /api/billing/checkout-status', () => {
  it('needs no session and reveals only whether the session was paid', async () => {
    const res = await call('/api/billing/checkout-status', { method: 'GET', query: '?session_id=cs_test_abc' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paid: true });
  });

  it('rejects ids that are not Checkout session ids', async () => {
    expect((await call('/api/billing/checkout-status', { method: 'GET', query: '?session_id=../etc' })).status).toBe(400);
    expect((await call('/api/billing/checkout-status', { method: 'GET' })).status).toBe(400);
    expect(stripe.retrieveCheckoutSession).not.toHaveBeenCalled();
  });

  it('reports unpaid sessions as not paid', async () => {
    stripe.retrieveCheckoutSession.mockResolvedValue({ id: 'cs_1', payment_status: 'unpaid', status: 'open' });
    expect(await (await call('/api/billing/checkout-status', { method: 'GET', query: '?session_id=cs_1' })).json()).toEqual({ paid: false });
  });
});
