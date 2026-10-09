import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  FREE_ENTITLEMENT,
  setEntitlement,
  getEntitlement,
  isEntitlementKnown,
  isPro,
  subscribeEntitlement,
  refreshEntitlement,
  waitForPro,
  resetEntitlementForTests,
} from '../entitlement.js';

const pro = { plan: 'pro', status: 'active', entitled: true, currentPeriodEnd: 1, cancelAtPeriodEnd: false, source: 'subscription' };
const respondWith = (body, ok = true) => vi.fn(async () => ({ ok, json: async () => body }));

beforeEach(() => resetEntitlementForTests());

describe('entitlement store', () => {
  it('starts free and unknown', () => {
    expect(getEntitlement()).toEqual(FREE_ENTITLEMENT);
    expect(isEntitlementKnown()).toBe(false);
    expect(isPro()).toBe(false);
  });

  it('normalises whatever the server sends and notifies subscribers', () => {
    const seen = [];
    const unsubscribe = subscribeEntitlement((e) => seen.push(e));

    setEntitlement({ plan: 'pro', entitled: 'yes', status: 'active', source: 'grant', currentPeriodEnd: '5' });
    expect(getEntitlement()).toEqual({ plan: 'pro', status: 'active', entitled: true, currentPeriodEnd: null, cancelAtPeriodEnd: false, source: 'grant' });
    expect(isEntitlementKnown()).toBe(true);
    expect(isPro()).toBe(true);
    expect(seen).toHaveLength(1);

    unsubscribe();
    setEntitlement(null);
    expect(getEntitlement()).toEqual(FREE_ENTITLEMENT);
    expect(seen).toHaveLength(1);
  });

  it('keeps notifying when one subscriber throws', () => {
    subscribeEntitlement(() => { throw new Error('boom'); });
    const ok = vi.fn();
    subscribeEntitlement(ok);
    setEntitlement(pro);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe('refreshEntitlement', () => {
  it('does nothing without a token', async () => {
    const fetchImpl = respondWith({ entitlement: pro });
    expect(await refreshEntitlement({ getToken: () => null, fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks /api/me with the bearer token and stores the answer', async () => {
    const fetchImpl = respondWith({ uid: 'u1', entitlement: pro });
    const result = await refreshEntitlement({ getToken: () => 'tok', fetchImpl });
    expect(result.plan).toBe('pro');
    expect(getEntitlement().plan).toBe('pro');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/me');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('leaves the stored answer alone when the request fails', async () => {
    setEntitlement(pro);
    expect(await refreshEntitlement({ getToken: () => 'tok', fetchImpl: respondWith({}, false) })).toBeNull();
    expect(await refreshEntitlement({ getToken: () => 'tok', fetchImpl: vi.fn(async () => { throw new Error('offline'); }) })).toBeNull();
    expect(getEntitlement().plan).toBe('pro');
  });
});

describe('waitForPro', () => {
  it('polls until the server says pro', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ entitlement: ++calls >= 3 ? pro : FREE_ENTITLEMENT }) }));
    const sleep = vi.fn(async () => {});

    expect(await waitForPro({ getToken: () => 'tok', fetchImpl, intervalMs: 10, timeoutMs: 1000, sleep })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up at the deadline and when aborted', async () => {
    const fetchImpl = respondWith({ entitlement: FREE_ENTITLEMENT });
    expect(await waitForPro({ getToken: () => 'tok', fetchImpl, intervalMs: 1000, timeoutMs: 500, sleep: async () => {} })).toBe(false);

    const signal = { aborted: false };
    const sleep = async () => { signal.aborted = true; };
    expect(await waitForPro({ getToken: () => 'tok', fetchImpl, intervalMs: 1, timeoutMs: 60_000, signal, sleep })).toBe(false);
  });
});
