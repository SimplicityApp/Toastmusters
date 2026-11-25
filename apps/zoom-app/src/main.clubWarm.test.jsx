import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * #167, AC-8: the club's logo and card set wait for the Zoom session too.
 *
 * Both used to start at module load from the cached copy, which can belong to
 * another account, and the card sync could send a session token left over
 * from an earlier load. They now start once `syncClubWithIdentity` has settled
 * which club this account is in.
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

let settleSync;
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
    drainOutbox: vi.fn(async () => ({ sent: 0, pending: 0 })),
    syncClubWithIdentity: vi.fn(
      () =>
        new Promise((resolve) => {
          settleSync = resolve;
        })
    ),
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  resolveIdentity = undefined;
  settleSync = undefined;
  document.body.innerHTML = '<div id="root"></div>';
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the club logo and card set at app start (AC-8)', () => {
  it('wait for the session, then for the club sync, before they start', async () => {
    await import('./main.jsx');
    await flush();
    const shared = await import('@toastmaster-timer/shared');

    expect(shared.warmClubLogo).not.toHaveBeenCalled();
    expect(shared.startClubCardSync).not.toHaveBeenCalled();

    resolveIdentity(AUTHORIZED_MEMBER);
    await flush();
    expect(shared.syncClubWithIdentity).toHaveBeenCalled();
    expect(shared.warmClubLogo).not.toHaveBeenCalled();
    expect(shared.startClubCardSync).not.toHaveBeenCalled();

    settleSync(null);
    await flush();
    await flush();
    expect(shared.warmClubLogo).toHaveBeenCalledTimes(1);
    expect(shared.startClubCardSync).toHaveBeenCalledWith(expect.objectContaining({ getToken: expect.any(Function) }));
  });
});
