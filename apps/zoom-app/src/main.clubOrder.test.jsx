import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * #167, AC-8: app start in the Zoom client.
 *
 * - No club request goes out before the Zoom session exists: the club refresh
 *   and the speech outbox wait for `resolveZoomIdentity()`, and run through
 *   `syncClubWithIdentity` with what it resolved.
 * - The club copy is not applied before the first paint (Q4).
 * - A session call that failed (offline) does not set FREE over club Pro.
 *
 * main.jsx is imported for its side effects with everything it renders or
 * talks to stubbed, and the identity held open until the test resolves it.
 */

let resolveIdentity;

vi.mock('react-dom/client', () => ({
  default: { createRoot: () => ({ render: vi.fn() }) },
  createRoot: () => ({ render: vi.fn() }),
}));
vi.mock('./App.jsx', () => ({ default: () => null }));
vi.mock('./index.css', () => ({}));
vi.mock('posthog-js', () => ({ default: {} }));
vi.mock('@posthog/react', () => ({ PostHogProvider: ({ children }) => children }));
vi.mock('./utils/posthog', () => ({
  initPostHog: vi.fn(),
  identifyUser: vi.fn(),
  setUserProperties: vi.fn(),
  registerSessionProperties: vi.fn(),
  trackEvent: vi.fn(),
}));
vi.mock('./utils/zoomSdk', () => ({
  initializeZoomSdk: vi.fn(async () => {}),
  preloadBackgroundImages: vi.fn(),
  setOverlayTimingReporter: vi.fn(),
}));
vi.mock('./utils/zoomIdentity', () => ({
  resolveZoomIdentity: vi.fn(
    () =>
      new Promise((resolve) => {
        resolveIdentity = resolve;
      })
  ),
  refreshZoomIdentity: vi.fn(),
  getSessionToken: vi.fn(() => 'session-token'),
}));
vi.mock('@toastmaster-timer/shared', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initCardImages: vi.fn(async () => {}),
    initProfileSync: vi.fn(async () => {}),
    syncCardAssets: vi.fn(async () => {}),
    startClubCardSync: vi.fn(),
    warmClubLogo: vi.fn(),
    setArchiveReporter: vi.fn(),
    setFlags: vi.fn(),
    setEntitlement: vi.fn(),
    subscribeEntitlement: vi.fn(() => () => {}),
    refreshClub: vi.fn(async () => null),
    drainOutbox: vi.fn(async () => ({ sent: 0, pending: 0 })),
    syncClubWithIdentity: vi.fn(async () => null),
  };
});

const AUTHORIZED_MEMBER = {
  identified: true,
  isGuest: false,
  uid: 'u1',
  token: 'session-token',
  authStatus: 'authorized',
  role: 'host',
  contextType: 'panel',
  meetingId: null,
  entitlement: { plan: 'pro', status: 'active', entitled: true, currentPeriodEnd: null, cancelAtPeriodEnd: false, source: 'club', club: { id: 'club-1', name: 'Downtown Speakers' } },
  flags: { pro: true },
  contactKnown: false,
};

/** What resolveZoomIdentity answers when the session call failed: offline. */
const UNREACHABLE_AUTHORIZED = {
  identified: false,
  isGuest: false,
  uid: null,
  token: null,
  authStatus: 'authorized',
  role: 'host',
  contextType: null,
  meetingId: null,
  entitlement: null,
  flags: null,
  contactKnown: false,
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let fetchMock;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  resolveIdentity = undefined;
  document.body.innerHTML = '<div id="root"></div>';
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  vi.stubGlobal('fetch', fetchMock);
  // A member's club copy from the last open.
  localStorage.setItem(
    'toastmaster_club',
    JSON.stringify({
      uid: 'u1',
      lastRefreshAt: Date.now(),
      ver: 1,
      club: { id: 'club-1', name: 'Downtown Speakers' },
      role: 'member',
      isOwner: false,
      plan: 'pro',
      entitled: true,
      status: 'active',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      source: 'club',
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function start() {
  await import('./main.jsx');
  await flush();
  return import('@toastmaster-timer/shared');
}

describe('app start (AC-8)', () => {
  it('sends no club request and drains no outbox before the Zoom session exists', async () => {
    const shared = await start();

    expect(resolveIdentity).toBeTypeOf('function');
    expect(shared.refreshClub).not.toHaveBeenCalled();
    expect(shared.drainOutbox).not.toHaveBeenCalled();
    expect(shared.syncClubWithIdentity).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/club'))).toEqual([]);
  });

  it('does not apply the club copy before the first paint', async () => {
    const shared = await start();

    // Neither through the stubbed setter nor inside the shared module itself
    // (initClubFromCache sets the real store directly).
    const applied = shared.setEntitlement.mock.calls.filter(([value]) => value?.entitled);
    expect(applied).toEqual([]);
    expect(shared.getEntitlement()).toMatchObject({ entitled: false });
  });

  it('syncs the club with the identity once it resolves, then drains the outbox', async () => {
    const shared = await start();

    resolveIdentity(AUTHORIZED_MEMBER);
    await flush();
    await flush();

    expect(shared.syncClubWithIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ identified: true, uid: 'u1', authStatus: 'authorized' })
    );
    expect(shared.drainOutbox).toHaveBeenCalled();
  });

  it('does not set FREE over club Pro when the session call failed', async () => {
    const shared = await start();

    resolveIdentity(UNREACHABLE_AUTHORIZED);
    await flush();
    await flush();

    expect(shared.syncClubWithIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ authStatus: 'authorized', reachable: false })
    );
    const downgrades = shared.setEntitlement.mock.calls.filter(([value]) => value && value.entitled === false);
    expect(downgrades).toEqual([]);
  });
});
