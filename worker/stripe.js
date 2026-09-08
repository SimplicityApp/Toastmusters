import crypto from 'node:crypto';

/**
 * A thin Stripe client for the Worker.
 *
 * Raw fetch rather than the `stripe` package. The API surface we use is four
 * endpoints, Stripe's form encoding is a few lines, and the Worker already
 * verifies Zoom's webhooks by hand in exactly the same way. It also keeps the
 * Worker bundle free of a dependency that has to be tested under workerd.
 *
 * Everything is injectable (fetch, clock) so tests never touch the network.
 */

const API_BASE = 'https://api.stripe.com/v1';

/**
 * Stripe's form encoding: nested objects as `a[b]=`, arrays as `a[0]=`,
 * booleans and numbers as strings. Undefined/null values are dropped.
 *
 * @param {Object} params
 * @returns {string}
 */
export function encodeForm(params) {
  const pairs = [];
  const walk = (value, prefix) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${prefix}[${i}]`));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        walk(inner, prefix ? `${prefix}[${key}]` : key);
      }
      return;
    }
    pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  };
  walk(params, '');
  return pairs.join('&');
}

export class StripeError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Stripe request failed (${status})`);
    this.name = 'StripeError';
    this.status = status;
    this.code = body?.error?.code ?? null;
    this.type = body?.error?.type ?? null;
  }
}

/**
 * @param {Object} env - STRIPE_SECRET_KEY
 * @param {{fetchImpl?: typeof fetch}} [options]
 */
export function createStripeClient(env, { fetchImpl } = {}) {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const doFetch = fetchImpl ?? fetch;

  async function request(method, path, params) {
    const url = new URL(`${API_BASE}${path}`);
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
    };
    if (method === 'GET') {
      if (params) url.search = encodeForm(params);
    } else {
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = encodeForm(params ?? {});
    }

    const response = await doFetch(url.toString(), init);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) throw new StripeError(response.status, body);
    return body;
  }

  return {
    request,

    /** Price id for a lookup key, or null when none is active. */
    async findPriceByLookupKey(lookupKey) {
      const result = await request('GET', '/prices', { lookup_keys: [lookupKey], active: true });
      return result?.data?.[0]?.id ?? null;
    },

    createCustomer(params) {
      return request('POST', '/customers', params);
    },

    createCheckoutSession(params) {
      return request('POST', '/checkout/sessions', params);
    },

    retrieveCheckoutSession(id) {
      return request('GET', `/checkout/sessions/${encodeURIComponent(id)}`);
    },

    createPortalSession(params) {
      return request('POST', '/billing_portal/sessions', params);
    },

    retrieveSubscription(id) {
      return request('GET', `/subscriptions/${encodeURIComponent(id)}`);
    },
  };
}

/** Stripe rejects events whose timestamp is further from now than this. */
export const WEBHOOK_TOLERANCE_SEC = 300;

/**
 * Verify a `Stripe-Signature` header against the raw request body.
 *
 * Scheme: header is `t=<unix seconds>,v1=<hex hmac>[,v1=...]`; the signed
 * payload is `${t}.${rawBody}`; HMAC-SHA256 with the endpoint secret. Any v1
 * may match (Stripe sends several during a secret rotation). The timestamp
 * must be within tolerance so a captured request cannot be replayed later.
 *
 * @param {string} rawBody - exactly as received, before any parsing
 * @param {string|null} header
 * @param {string|undefined} secret - STRIPE_WEBHOOK_SECRET
 * @param {number} [nowSec]
 * @returns {boolean}
 */
export function verifyStripeSignature(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!rawBody || typeof rawBody !== 'string' || !header || !secret) return false;

  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') timestamp = Number(v);
    else if (k === 'v1') signatures.push(v);
  }
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSec - timestamp) > WEBHOOK_TOLERANCE_SEC) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  return signatures.some((sig) => {
    const buf = Buffer.from(sig, 'utf8');
    if (buf.length !== expectedBuf.length) return false;
    try {
      return crypto.timingSafeEqual(buf, expectedBuf);
    } catch {
      return false;
    }
  });
}

/** Build a valid `Stripe-Signature` header. Exported for tests only. */
export function signStripePayload(rawBody, secret, timestampSec) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`).digest('hex');
  return `t=${timestampSec},v1=${v1}`;
}
