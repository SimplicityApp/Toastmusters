import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mocked at the zoomSdk boundary: these tests are about what the app does with
// Zoom's answer, and the real module pulls in @zoom/appssdk, which hangs jsdom.
vi.mock('./zoomSdk', () => ({
  isApiAvailable: vi.fn(),
  requestZoomAuthorizeCode: vi.fn(),
}));
vi.mock('./posthog', () => ({ trackEvent: vi.fn() }));

const { isApiAvailable, requestZoomAuthorizeCode } = await import('./zoomSdk');
const { trackEvent } = await import('./posthog');
const {
  CAPTURE_BACKOFF_MS,
  CONTACT_ENDPOINT,
  attempt,
  eligible,
  readCaptureState,
  writeCaptureState,
} = await import('./contactCapture');

const NOW = 1_800_000_000_000;
const session = (over = {}) => ({ identified: true, uid: 'uid-1', token: 'tok-1', contactKnown: false, ...over });
const stored = () => JSON.parse(localStorage.getItem('tt_contact_capture:uid-1'));

function respondWith(status) {
  return vi.fn(() => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve({}) }));
}

beforeEach(() => {
  localStorage.clear();
  isApiAvailable.mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('capture state', () => {
  it('starts in auto mode with no backoff', () => {
    expect(readCaptureState('uid-1')).toEqual({ mode: 'auto', nextAt: 0 });
  });

  it('round-trips per uid, and clears on null', () => {
    writeCaptureState('uid-1', { mode: 'card', nextAt: 5 });
    expect(readCaptureState('uid-1')).toEqual({ mode: 'card', nextAt: 5 });
    expect(readCaptureState('uid-2')).toEqual({ mode: 'auto', nextAt: 0 });

    writeCaptureState('uid-1', null);
    expect(localStorage.getItem('tt_contact_capture:uid-1')).toBeNull();
  });

  it('reads a corrupt or foreign value as the starting state', () => {
    localStorage.setItem('tt_contact_capture:uid-1', 'not json');
    expect(readCaptureState('uid-1')).toEqual({ mode: 'auto', nextAt: 0 });
    localStorage.setItem('tt_contact_capture:uid-1', JSON.stringify({ mode: 'nag', nextAt: 'soon' }));
    expect(readCaptureState('uid-1')).toEqual({ mode: 'auto', nextAt: 0 });
  });
});

describe('eligible', () => {
  it('is true for an identified user with no contact, the flag on and authorize granted', () => {
    expect(eligible(session(), true, NOW)).toBe(true);
  });

  it('is false whenever any gate is closed', () => {
    expect(eligible(null, true, NOW)).toBe(false);
    expect(eligible(session({ identified: false }), true, NOW)).toBe(false);
    expect(eligible(session({ uid: null }), true, NOW)).toBe(false);
    expect(eligible(session({ token: null }), true, NOW)).toBe(false);
    expect(eligible(session({ contactKnown: true }), true, NOW)).toBe(false);
    expect(eligible(session({ contactKnown: undefined }), true, NOW)).toBe(false);
    expect(eligible(session(), false, NOW)).toBe(false);

    isApiAvailable.mockReturnValue(false);
    expect(eligible(session(), true, NOW)).toBe(false);
    expect(isApiAvailable).toHaveBeenCalledWith('authorize');
  });

  it('waits out a backoff', () => {
    writeCaptureState('uid-1', { mode: 'auto', nextAt: NOW + 1 });
    expect(eligible(session(), true, NOW)).toBe(false);
    expect(eligible(session(), true, NOW + 1)).toBe(true);
  });
});

describe('attempt', () => {
  const now = () => NOW;

  it('posts the code and verifier with the session token, and clears the state on a 200', async () => {
    writeCaptureState('uid-1', { mode: 'auto', nextAt: 0 });
    requestZoomAuthorizeCode.mockResolvedValue({ status: 'code', code: 'the-code', codeVerifier: 'the-verifier' });
    const fetchMock = respondWith(200);
    vi.stubGlobal('fetch', fetchMock);

    expect(await attempt('auto', session(), { now })).toBe('saved');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(CONTACT_ENDPOINT);
    expect(url).toBe('/api/zoom/contact');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok-1');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ code: 'the-code', codeVerifier: 'the-verifier' });
    expect(localStorage.getItem('tt_contact_capture:uid-1')).toBeNull();
    expect(trackEvent.mock.calls).toEqual([
      ['contact_capture_prompted', { source: 'auto' }],
      ['contact_capture_saved', { source: 'auto' }],
    ]);
  });

  // The user said no to Zoom's screen: never show it to them unprompted again.
  it('moves a skip to card mode, due at the next idle moment', async () => {
    requestZoomAuthorizeCode.mockResolvedValue({ status: 'skipped' });
    const fetchMock = respondWith(200);
    vi.stubGlobal('fetch', fetchMock);

    expect(await attempt('auto', session(), { now })).toBe('skipped');

    expect(stored()).toEqual({ mode: 'card', nextAt: NOW });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(trackEvent.mock.calls).toEqual([
      ['contact_capture_prompted', { source: 'auto' }],
      ['contact_capture_skipped', { source: 'auto' }],
    ]);
  });

  // Typically the scope is not approved yet, so users/me fails in the Worker.
  it('backs off for seven days when the save fails, keeping the mode', async () => {
    requestZoomAuthorizeCode.mockResolvedValue({ status: 'code', code: 'c', codeVerifier: 'v' });
    for (const status of [502, 401, 403, 503]) {
      localStorage.clear();
      vi.stubGlobal('fetch', respondWith(status));

      expect(await attempt('auto', session(), { now })).toBe('failed');
      expect(stored(), String(status)).toEqual({ mode: 'auto', nextAt: NOW + CAPTURE_BACKOFF_MS });
    }
    expect(CAPTURE_BACKOFF_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(trackEvent).not.toHaveBeenCalledWith('contact_capture_saved', expect.anything());
  });

  it('backs off when the network is gone', async () => {
    requestZoomAuthorizeCode.mockResolvedValue({ status: 'code', code: 'c', codeVerifier: 'v' });
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));

    expect(await attempt('auto', session(), { now })).toBe('failed');
    expect(stored()).toEqual({ mode: 'auto', nextAt: NOW + CAPTURE_BACKOFF_MS });
  });

  it('changes nothing when the client cannot ask', async () => {
    writeCaptureState('uid-1', { mode: 'auto', nextAt: 0 });
    requestZoomAuthorizeCode.mockResolvedValue({ status: 'unavailable' });
    const fetchMock = respondWith(200);
    vi.stubGlobal('fetch', fetchMock);

    expect(await attempt('auto', session(), { now })).toBe('unavailable');
    expect(stored()).toEqual({ mode: 'auto', nextAt: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks nothing without a uid or a token', async () => {
    expect(await attempt('auto', session({ uid: null }), { now })).toBe('unavailable');
    expect(await attempt('auto', session({ token: null }), { now })).toBe('unavailable');
    expect(requestZoomAuthorizeCode).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('posts a code that arrives after the timeout, and clears the state on a 200', async () => {
    let lateCode;
    requestZoomAuthorizeCode.mockImplementation(async ({ onLateCode }) => {
      lateCode = onLateCode;
      return { status: 'skipped' };
    });
    const fetchMock = respondWith(200);
    vi.stubGlobal('fetch', fetchMock);
    const onLateSaved = vi.fn();

    expect(await attempt('auto', session(), { now, onLateSaved })).toBe('skipped');
    expect(stored()).toEqual({ mode: 'card', nextAt: NOW });

    await lateCode({ code: 'late', codeVerifier: 'v' });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ code: 'late', codeVerifier: 'v' });
    expect(localStorage.getItem('tt_contact_capture:uid-1')).toBeNull();
    expect(onLateSaved).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('contact_capture_saved', { source: 'auto', late: true });
  });
});
