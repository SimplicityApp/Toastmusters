import { describe, it, expect, vi } from 'vitest';
import {
  encodeForm,
  createStripeClient,
  verifyStripeSignature,
  signStripePayload,
  StripeError,
  WEBHOOK_TOLERANCE_SEC,
} from './stripe.js';

describe('encodeForm', () => {
  it('encodes Stripe nested objects and arrays the way Stripe expects', () => {
    const encoded = encodeForm({
      mode: 'subscription',
      line_items: [{ price: 'price_1', quantity: 1 }],
      metadata: { uid: 'u 1' },
      subscription_data: { metadata: { uid: 'u&1' } },
      allow_promotion_codes: true,
      skipped: undefined,
      alsoSkipped: null,
    });
    expect(encoded.split('&').sort()).toEqual(
      [
        'mode=subscription',
        'line_items%5B0%5D%5Bprice%5D=price_1',
        'line_items%5B0%5D%5Bquantity%5D=1',
        'metadata%5Buid%5D=u%201',
        'subscription_data%5Bmetadata%5D%5Buid%5D=u%261',
        'allow_promotion_codes=true',
      ].sort()
    );
  });
});

describe('createStripeClient', () => {
  it('returns null without a secret key, so callers can answer 503', () => {
    expect(createStripeClient({})).toBeNull();
  });

  it('sends form-encoded POSTs with the bearer key and parses JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout' }), { status: 200 }));
    const stripe = createStripeClient({ STRIPE_SECRET_KEY: 'sk_test_x' }, { fetchImpl });

    const result = await stripe.createCheckoutSession({ mode: 'subscription', customer: 'cus_1' });

    expect(result).toEqual({ id: 'cs_1', url: 'https://checkout' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk_test_x');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toBe('mode=subscription&customer=cus_1');
  });

  it('puts GET params in the query string', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'price_1' }] }), { status: 200 }));
    const stripe = createStripeClient({ STRIPE_SECRET_KEY: 'sk' }, { fetchImpl });

    expect(await stripe.findPriceByLookupKey('pro_monthly')).toBe('price_1');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/prices?lookup_keys%5B0%5D=pro_monthly&active=true');
    expect(init.body).toBeUndefined();
  });

  it('throws a StripeError carrying status and code on a non-2xx answer', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: 'No such customer', code: 'resource_missing', type: 'invalid_request_error' } }), { status: 404 })
    );
    const stripe = createStripeClient({ STRIPE_SECRET_KEY: 'sk' }, { fetchImpl });

    await expect(stripe.retrieveSubscription('sub_x')).rejects.toMatchObject({
      name: 'StripeError', status: 404, code: 'resource_missing', message: 'No such customer',
    });
    await expect(stripe.retrieveSubscription('sub_x')).rejects.toBeInstanceOf(StripeError);
  });
});

describe('verifyStripeSignature', () => {
  const secret = 'whsec_test';
  const body = '{"id":"evt_1","type":"x"}';
  const now = 1_800_000_000;

  it('accepts a correctly signed, fresh payload', () => {
    expect(verifyStripeSignature(body, signStripePayload(body, secret, now), secret, now)).toBe(true);
  });

  it('accepts when any one of several v1 signatures matches (secret rotation)', () => {
    const good = signStripePayload(body, secret, now).split(',')[1];
    const header = `t=${now},v1=${'0'.repeat(64)},${good}`;
    expect(verifyStripeSignature(body, header, secret, now)).toBe(true);
  });

  it('rejects a tampered body, a wrong secret and a malformed header', () => {
    const header = signStripePayload(body, secret, now);
    expect(verifyStripeSignature(body + ' ', header, secret, now)).toBe(false);
    expect(verifyStripeSignature(body, header, 'whsec_other', now)).toBe(false);
    expect(verifyStripeSignature(body, 'v1=abc', secret, now)).toBe(false);
    expect(verifyStripeSignature(body, `t=${now}`, secret, now)).toBe(false);
    expect(verifyStripeSignature(body, null, secret, now)).toBe(false);
    expect(verifyStripeSignature(body, header, undefined, now)).toBe(false);
  });

  // Without this, a captured webhook is a permanent "make this user pro" button.
  it('rejects a payload older than the tolerance window', () => {
    const header = signStripePayload(body, secret, now);
    expect(verifyStripeSignature(body, header, secret, now + WEBHOOK_TOLERANCE_SEC)).toBe(true);
    expect(verifyStripeSignature(body, header, secret, now + WEBHOOK_TOLERANCE_SEC + 1)).toBe(false);
    expect(verifyStripeSignature(body, header, secret, now - WEBHOOK_TOLERANCE_SEC - 1)).toBe(false);
  });
});
