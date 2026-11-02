import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleZoomWebhook } from './zoom-webhook.js';

const TEST_SECRET = 'test-webhook-secret-token';

const env = {
  ZOOM_WEBHOOK_SECRET_TOKEN: TEST_SECRET,
  ZOOM_CLIENT_ID: 'client-id',
  ZOOM_CLIENT_SECRET: 'client-secret',
  POSTHOG_API_KEY: 'phc_test',
};

// Mock fetch globally (PostHog + Zoom compliance calls)
const mockFetch = vi.fn(() =>
  Promise.resolve({ json: () => Promise.resolve({ access_token: 'mock-token' }) })
);
vi.stubGlobal('fetch', mockFetch);

// Minimal ExecutionContext stub — run waitUntil promises so we can await them.
function createCtx() {
  const promises = [];
  return {
    waitUntil: (p) => promises.push(p),
    _settle: () => Promise.allSettled(promises),
  };
}

// Map-backed KV and R2 fakes, so a purge can be checked by what is left.
function makeKv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    store,
    get: async (key, type) => {
      const raw = store.has(key) ? store.get(key) : null;
      return raw !== null && type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
  };
}

function makeBucket(keys) {
  const objects = new Set(keys);
  return {
    objects,
    list: async ({ prefix }) => ({
      objects: [...objects].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: 1 })),
      truncated: false,
    }),
    delete: async (ks) => { for (const k of Array.isArray(ks) ? ks : [ks]) objects.delete(k); },
  };
}

function userDataEnv() {
  return {
    ...env,
    PROFILES: makeKv({
      'profile:zoom:u1': { rev: 1, fields: {} },
      'contact:zoom:u1': { email: 'a@b.c', firstName: 'A', lastName: 'B', updatedAt: 1 },
      'entitlement:zoom:u1': { plan: 'pro', status: 'active' },
      'profile:zoom:u2': { rev: 1, fields: {} },
      'contact:zoom:u2': { email: 'c@d.e', firstName: null, lastName: null, updatedAt: 1 },
    }),
    CARD_ASSETS: makeBucket(['card/u1/aaa', 'card/u1/bbb', 'card/u2/ccc']),
  };
}

function signRequest(rawBody, timestamp = '1234567890') {
  const message = `v0:${timestamp}:${rawBody}`;
  const hash = crypto.createHmac('sha256', TEST_SECRET).update(message).digest('hex');
  return { signature: `v0=${hash}`, timestamp };
}

function makeRequest(body, { method = 'POST', signed = false } = {}) {
  const rawBody = JSON.stringify(body);
  const headers = { 'content-type': 'application/json' };
  if (signed) {
    const { signature, timestamp } = signRequest(rawBody);
    headers['x-zm-signature'] = signature;
    headers['x-zm-request-timestamp'] = timestamp;
  }
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') init.body = rawBody;
  return new Request('https://example.com/api/zoom/webhook', init);
}

describe('handleZoomWebhook', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  it('rejects non-POST requests', async () => {
    const res = await handleZoomWebhook(makeRequest({}, { method: 'GET' }), env, createCtx());
    expect(res.status).toBe(405);
  });

  it('answers CRC url_validation without a signature', async () => {
    const body = { event: 'endpoint.url_validation', payload: { plainToken: 'abc123' } };
    const res = await handleZoomWebhook(makeRequest(body), env, createCtx());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.plainToken).toBe('abc123');
    expect(data.encryptedToken).toBe(
      crypto.createHmac('sha256', TEST_SECRET).update('abc123').digest('hex')
    );
  });

  it('rejects events with an invalid signature', async () => {
    const body = { event: 'app_deauthorized', payload: { user_id: 'u1' } };
    const res = await handleZoomWebhook(makeRequest(body), env, createCtx());
    expect(res.status).toBe(401);
  });

  it('tracks app_deauthorized and fires the compliance call', async () => {
    const body = { event: 'app_deauthorized', payload: { user_id: 'u1', account_id: 'a1' } };
    const ctx = createCtx();
    const res = await handleZoomWebhook(makeRequest(body, { signed: true }), env, ctx);
    expect(res.status).toBe(200);
    await ctx._settle();
    // PostHog capture + Zoom token + Zoom compliance = 3 fetches
    expect(mockFetch).toHaveBeenCalled();
    const urls = mockFetch.mock.calls.map((c) => c[0]);
    expect(urls).toContain('https://us.i.posthog.com/capture/');
    expect(urls).toContain('https://api.zoom.us/oauth/data/compliance');
  });

  it('purges the profile, contact and card artwork when the user asked not to retain data', async () => {
    const purgeEnv = userDataEnv();
    const body = {
      event: 'app_deauthorized',
      payload: { user_id: 'u1', account_id: 'a1', user_data_retention: 'false' },
    };
    const ctx = createCtx();
    const res = await handleZoomWebhook(makeRequest(body, { signed: true }), purgeEnv, ctx);
    expect(res.status).toBe(200);
    await ctx._settle();

    const keys = [...purgeEnv.PROFILES.store.keys()];
    expect(keys).not.toContain('profile:zoom:u1');
    expect(keys).not.toContain('contact:zoom:u1');
    expect([...purgeEnv.CARD_ASSETS.objects]).toEqual(['card/u2/ccc']);
    // Billing records are ours and stay; other users are untouched.
    expect(keys).toEqual(expect.arrayContaining(['entitlement:zoom:u1', 'profile:zoom:u2', 'contact:zoom:u2']));
  });

  it('leaves user data alone when Zoom says to retain it', async () => {
    const retainEnv = userDataEnv();
    const before = [...retainEnv.PROFILES.store.keys()];
    const body = {
      event: 'app_deauthorized',
      payload: { user_id: 'u1', account_id: 'a1', user_data_retention: 'true' },
    };
    const ctx = createCtx();
    const res = await handleZoomWebhook(makeRequest(body, { signed: true }), retainEnv, ctx);
    expect(res.status).toBe(200);
    await ctx._settle();

    expect([...retainEnv.PROFILES.store.keys()]).toEqual(before);
    expect([...retainEnv.CARD_ASSETS.objects]).toEqual(['card/u1/aaa', 'card/u1/bbb', 'card/u2/ccc']);
  });

  it('tracks meeting.started', async () => {
    const body = { event: 'meeting.started', payload: { object: { id: '9', host_id: 'h1' } } };
    const res = await handleZoomWebhook(makeRequest(body, { signed: true }), env, createCtx());
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://us.i.posthog.com/capture/',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('returns 200 for unknown but signed events', async () => {
    const body = { event: 'some.other.event', payload: {} };
    const res = await handleZoomWebhook(makeRequest(body, { signed: true }), env, createCtx());
    expect(res.status).toBe(200);
  });
});
