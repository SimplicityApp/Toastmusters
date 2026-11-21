import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * #167: after the user approves the app in Zoom (guest mode → authorized), the
 * identity has to be resolved again so the club code they typed can be sent.
 * `refreshZoomIdentity()` drops the single-flight answer and asks once more.
 *
 * Also AC-7: the session request carries no `X-Club`, even on a device that
 * still holds an old token-shaped club entry.
 */

vi.mock('./zoomSdk', () => ({
  readAppContext: vi.fn(),
  readZoomUserSummary: vi.fn(),
}));

const { readAppContext, readZoomUserSummary } = await import('./zoomSdk');
const { resetClubForTests } = await import('@toastmaster-timer/shared');
const identityModule = await import('./zoomIdentity');
const { resolveZoomIdentity, resetZoomIdentityForTests } = identityModule;

const response = (body) => ({ ok: true, status: 200, json: async () => body });

const guest = { identified: false, isGuest: true, flags: { pro: true } };
const member = {
  identified: true,
  isGuest: false,
  uid: 'uid-1',
  token: 'tok-1',
  entitlement: { plan: 'pro', entitled: true, source: 'club', club: { id: 'club-1', name: 'Downtown Speakers' } },
  flags: { pro: true },
  contactKnown: false,
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetClubForTests();
  resetZoomIdentityForTests();
  readAppContext.mockResolvedValue('encrypted-context');
  readZoomUserSummary.mockResolvedValue({ status: 'authenticated', role: 'host' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('refreshZoomIdentity', () => {
  it('is exported', () => {
    expect(identityModule.refreshZoomIdentity).toBeTypeOf('function');
  });

  it('drops the single-flight answer and resolves again, so an approval is seen', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(guest))
      .mockResolvedValueOnce(response(member));
    vi.stubGlobal('fetch', fetchMock);

    const first = await resolveZoomIdentity();
    expect(first).toMatchObject({ identified: false, isGuest: true, authStatus: 'authenticated' });
    // Single-flight: asking again without a refresh is the same answer.
    await resolveZoomIdentity();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The user approved the app in Zoom.
    readZoomUserSummary.mockResolvedValue({ status: 'authorized', role: 'host' });
    const second = await identityModule.refreshZoomIdentity?.();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({ identified: true, uid: 'uid-1', authStatus: 'authorized' });
    // And from now on everyone who asks gets the new answer.
    expect(await resolveZoomIdentity()).toMatchObject({ identified: true, uid: 'uid-1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('the session request (AC-7, AC-8)', () => {
  it('carries no X-Club, even with an old token-shaped club entry on the device', async () => {
    localStorage.setItem(
      'toastmaster_club',
      JSON.stringify({
        clubToken: 'old.tok',
        lastRefreshAt: Date.now(),
        ver: 1,
        club: { id: 'club-1', name: 'Downtown Speakers' },
        plan: 'pro',
        entitled: true,
        source: 'club',
      })
    );
    resetClubForTests();
    const fetchMock = vi.fn().mockResolvedValue(response(member));
    vi.stubGlobal('fetch', fetchMock);

    await resolveZoomIdentity();

    const headers = Object.fromEntries(
      Object.entries(fetchMock.mock.calls[0][1]?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    );
    expect(headers['x-club']).toBeUndefined();
  });

  it('makes no club request of its own: the session is the only call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(member));
    vi.stubGlobal('fetch', fetchMock);

    await resolveZoomIdentity();

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/api/zoom/session']);
  });
});
