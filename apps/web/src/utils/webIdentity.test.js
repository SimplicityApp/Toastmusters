import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveWebIdentity, signInUrl, signOut, startWebSession, resetWebIdentityForTests } from './webIdentity';
import { identifyUser } from './posthog';
import { getEntitlement, resetEntitlementForTests } from '@toastmaster-timer/shared';

beforeEach(() => {
  resetWebIdentityForTests();
  resetEntitlementForTests();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveWebIdentity', () => {
  it('is anonymous on 401, network failure, or a body without a uid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    expect(await resolveWebIdentity()).toEqual({ identified: false, uid: null, entitlement: null });

    resetWebIdentityForTests();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await resolveWebIdentity()).toMatchObject({ identified: false });
  });

  it('identifies from /api/me using the cookie, once per page load', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ uid: 'u1', entitlement: { plan: 'pro', entitled: true } }) }));
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([resolveWebIdentity(), resolveWebIdentity()]);
    expect(a).toEqual({ identified: true, uid: 'u1', entitlement: { plan: 'pro', entitled: true } });
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/me');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin' });
  });
});

describe('signInUrl / signOut', () => {
  it('builds the start URL with the return path encoded', () => {
    expect(signInUrl('/account?x=1')).toBe('/api/auth/zoom/start?returnTo=%2Faccount%3Fx%3D1');
    expect(signInUrl()).toBe('/api/auth/zoom/start?returnTo=%2Fapp');
  });

  it('posts to logout and survives failure', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await signOut();
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(signOut()).resolves.toBeUndefined();
  });
});

describe('startWebSession', () => {
  it('identifies the person in PostHog and seeds the entitlement when signed in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (String(url) === '/api/me') return { ok: true, status: 200, json: async () => ({ uid: 'u1', entitlement: { plan: 'pro', entitled: true } }) };
        return { ok: true, status: 200, json: async () => ({ profile: { rev: 0, fields: {} } }) };
      })
    );

    const identity = await startWebSession();
    expect(identity.identified).toBe(true);
    expect(identifyUser).toHaveBeenCalledWith('zoom:u1');
    expect(getEntitlement().plan).toBe('pro');
  });

  it('stays anonymous and free without a session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    const identity = await startWebSession();
    expect(identity.identified).toBe(false);
    expect(identifyUser).not.toHaveBeenCalled();
    expect(getEntitlement().plan).toBe('free');
  });
});
