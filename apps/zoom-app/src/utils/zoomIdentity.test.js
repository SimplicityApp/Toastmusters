import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mocked at the zoomSdk boundary rather than the SDK: these tests are about
// what the app does with a context, not about how it was fetched. It also keeps
// @zoom/appssdk out of the module graph entirely, which is what hangs jsdom.
vi.mock('./zoomSdk', () => ({
  readAppContext: vi.fn(),
  readZoomUserStatus: vi.fn(),
}));

const { readAppContext, readZoomUserStatus } = await import('./zoomSdk');
const { resolveZoomIdentity, getSessionToken, resetZoomIdentityForTests } = await import(
  './zoomIdentity'
);

function respondWith(body, { ok = true, status = 200 } = {}) {
  return vi.fn(() => Promise.resolve({ ok, status, json: () => Promise.resolve(body) }));
}

beforeEach(() => {
  resetZoomIdentityForTests();
  readAppContext.mockResolvedValue('encrypted-context');
  readZoomUserStatus.mockResolvedValue('authorized');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('resolveZoomIdentity', () => {
  it('identifies the user and keeps the session token', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith({ identified: true, isGuest: false, uid: 'uid-1', token: 'tok-1' })
    );

    expect(await resolveZoomIdentity()).toEqual({
      identified: true,
      isGuest: false,
      uid: 'uid-1',
      token: 'tok-1',
      authStatus: 'authorized',
    });
    expect(getSessionToken()).toBe('tok-1');
  });

  it('posts the context the SDK handed it', async () => {
    const fetchMock = respondWith({ identified: true, uid: 'u', token: null });
    vi.stubGlobal('fetch', fetchMock);

    await resolveZoomIdentity();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/zoom/session');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ context: 'encrypted-context' });
  });

  // The header path: the client gave us nothing, but Zoom set the context on the
  // document request and the Worker already has it. Posting anyway is what makes
  // that path work without any SDK capability.
  it('still calls the endpoint when the SDK offers no context', async () => {
    readAppContext.mockResolvedValue(null);
    const fetchMock = respondWith({ identified: true, uid: 'uid-h', token: 't' });
    vi.stubGlobal('fetch', fetchMock);

    const identity = await resolveZoomIdentity();

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({});
    expect(identity.uid).toBe('uid-h');
  });

  it('reports a guest as unidentified, with the status that explains why', async () => {
    readZoomUserStatus.mockResolvedValue('unauthenticated');
    vi.stubGlobal('fetch', respondWith({ identified: false, isGuest: true }));

    expect(await resolveZoomIdentity()).toEqual({
      identified: false,
      isGuest: true,
      uid: null,
      token: null,
      authStatus: 'unauthenticated',
    });
    expect(getSessionToken()).toBeNull();
  });

  it('falls back to anonymous when the endpoint fails', async () => {
    vi.stubGlobal('fetch', respondWith({}, { ok: false, status: 500 }));

    expect(await resolveZoomIdentity()).toMatchObject({ identified: false, uid: null });
  });

  it('falls back to anonymous when the network is gone', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));

    expect(await resolveZoomIdentity()).toMatchObject({ identified: false, uid: null });
  });

  // A failure here sits next to a timer someone is about to run in front of
  // their club. It must never reject into the caller.
  it('never rejects, whatever the SDK does', async () => {
    readAppContext.mockRejectedValue(new Error('sdk exploded'));
    readZoomUserStatus.mockRejectedValue(new Error('sdk exploded'));
    vi.stubGlobal('fetch', respondWith({ identified: false, isGuest: false }));

    await expect(resolveZoomIdentity()).resolves.toMatchObject({ identified: false });
  });

  it('resolves once and shares the result with every caller', async () => {
    const fetchMock = respondWith({ identified: true, uid: 'uid-1', token: 't' });
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([resolveZoomIdentity(), resolveZoomIdentity()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readAppContext).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('survives sessionStorage being unavailable', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    vi.stubGlobal('fetch', respondWith({ identified: true, uid: 'uid-1', token: 'tok' }));

    try {
      expect((await resolveZoomIdentity()).token).toBe('tok');
    } finally {
      getItem.mockRestore();
    }
  });
});
