import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveWebIdentity, signInUrl, signOut, startWebSession, resetWebIdentityForTests } from './webIdentity';
import { identifyUser } from './posthog';
import {
  getEntitlement,
  resetEntitlementForTests,
  getFlags,
  areFlagsKnown,
  resetFlagsForTests,
} from '@toastmaster-timer/shared';

beforeEach(() => {
  resetWebIdentityForTests();
  resetEntitlementForTests();
  resetFlagsForTests();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveWebIdentity', () => {
  it('is anonymous on 401, network failure, or a body without a uid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    expect(await resolveWebIdentity()).toEqual({ identified: false, uid: null, entitlement: null, flags: null });

    resetWebIdentityForTests();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await resolveWebIdentity()).toMatchObject({ identified: false });
  });

  it('identifies from /api/me using the cookie, once per page load', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ uid: 'u1', entitlement: { plan: 'pro', entitled: true }, flags: { pro: true } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([resolveWebIdentity(), resolveWebIdentity()]);
    expect(a).toEqual({ identified: true, uid: 'u1', entitlement: { plan: 'pro', entitled: true }, flags: { pro: true } });
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The identity call is the one that asks for flags; the entitlement polls
    // hit the bare /api/me and never do.
    expect(fetchMock.mock.calls[0][0]).toBe('/api/me?flags=1');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin' });
  });

  // The Worker answers a signed-out ?flags=1 with 200 and a null uid, so the
  // flags have to be read before the uid decides this is anonymous.
  it('keeps the flags for a signed-out visitor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ uid: null, flags: { pro: true } }) })));
    expect(await resolveWebIdentity()).toEqual({ identified: false, uid: null, entitlement: null, flags: { pro: true } });
  });

  it('survives a body that is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('not json'); } })));
    expect(await resolveWebIdentity()).toEqual({ identified: false, uid: null, entitlement: null, flags: null });
  });
});

describe('signInUrl / signOut', () => {
  it('builds the start URL with the return path encoded', () => {
    expect(signInUrl('/account?x=1')).toBe('/api/auth/zoom/start?returnTo=%2Faccount%3Fx%3D1');
    expect(signInUrl()).toBe('/api/auth/zoom/start?returnTo=%2Ftimer');
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
        if (String(url) === '/api/me?flags=1') {
          return { ok: true, status: 200, json: async () => ({ uid: 'u1', entitlement: { plan: 'pro', entitled: true }, flags: { pro: true } }) };
        }
        return { ok: true, status: 200, json: async () => ({ profile: { rev: 0, fields: {} } }) };
      })
    );

    const identity = await startWebSession();
    expect(identity.identified).toBe(true);
    expect(identifyUser).toHaveBeenCalledWith('zoom:u1');
    expect(getEntitlement().plan).toBe('pro');
    expect(areFlagsKnown()).toBe(true);
    expect(getFlags()).toEqual({ pro: true });
  });

  it('stays anonymous and free without a session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    const identity = await startWebSession();
    expect(identity.identified).toBe(false);
    expect(identifyUser).not.toHaveBeenCalled();
    expect(getEntitlement().plan).toBe('free');
    // Answered, all off: nothing gated waits for a flag that is never coming.
    expect(areFlagsKnown()).toBe(true);
    expect(getFlags()).toEqual({});
  });

  it('seeds the flags for a signed-out visitor too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ uid: null, flags: { pro: true } }) })));
    const identity = await startWebSession();
    expect(identity.identified).toBe(false);
    expect(identifyUser).not.toHaveBeenCalled();
    expect(areFlagsKnown()).toBe(true);
    expect(getFlags()).toEqual({ pro: true });
  });

  it('marks the flags known, all off, when the Worker cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await startWebSession();
    expect(areFlagsKnown()).toBe(true);
    expect(getFlags()).toEqual({});
  });
});
