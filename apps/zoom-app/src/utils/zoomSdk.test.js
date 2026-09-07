import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { saveOverlayMode } from '@toastmaster-timer/shared';
// The module's own source, so the API list can be checked against the calls it
// actually makes rather than against a second hand-kept list.
import zoomSdkSource from './zoomSdk.js?raw';

// The Zoom Apps SDK touches browser globals at import time and deadlocks under
// vitest + jsdom, so stub it out. hoisted() keeps the fake reachable from the
// hoisted vi.mock factory.
const { sdkMock } = vi.hoisted(() => ({
  sdkMock: {
    config: vi.fn(),
    // The generic dispatcher, which the real SDK does define. It is how the
    // module reaches the virtual-background getters that have no wrapper method,
    // so leaving it off would make every one of them read as ungranted.
    callZoomApi: vi.fn(),
    setVideoFilter: vi.fn(),
    deleteVideoFilter: vi.fn(),
    setVirtualBackground: vi.fn(),
    removeVirtualBackground: vi.fn(),
    setVirtualForeground: vi.fn(),
    removeVirtualForeground: vi.fn(),
    shareApp: vi.fn(),
    appPopout: vi.fn(),
    onAppPopout: vi.fn(),
    onShareScreen: vi.fn(),
    getMeetingView: vi.fn(),
    onMeetingViewChange: vi.fn(),
  },
}));

vi.mock('@zoom/appssdk', () => ({ default: sdkMock }));

// jsdom has neither IndexedDB nor object URLs, so the Blob the picker would
// have stored cannot be minted into a URL here. Only that one function is stood
// in for: hasOwnBackground stays real, because it is localStorage-backed and
// behaves under jsdom exactly as it does in the client — so a test sets the
// feature the same way the picker does, by writing the flag.
vi.mock('@toastmaster-timer/shared', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getOwnBackgroundUrl: () => (actual.hasOwnBackground() ? 'blob:own-background' : null),
  };
});

/**
 * jsdom has no real 2D canvas, so route createElement('canvas') to a fake whose
 * context records every operation performed on it.
 */
function stubCanvas() {
  const operations = [];
  const ctx = {
    scale: (...args) => operations.push(['scale', ...args]),
    drawImage: (...args) => operations.push(['drawImage', ...args.slice(1)]),
    putImageData: () => operations.push(['putImageData']),
    strokeText: (text, x, y) => operations.push(['strokeText', text, x, y]),
    fillText: (text, x, y) => operations.push(['fillText', text, x, y]),
    // The band over a video background is four fillRects; the color is read off
    // fillStyle at the moment of the call, as a real 2D context would.
    fillRect: (x, y, w, h) => operations.push(['fillRect', x, y, w, h, ctx.fillStyle]),
    measureText: (text) => ({ width: String(text).length * 40 }),
    getImageData: (x, y, w, h) => ({
      width: w,
      height: h,
      // Opaque, so sampleCardBandColor has something to average. A fully
      // transparent buffer would make every card sample as "no color".
      data: new Uint8ClampedArray(w * h * 4).fill(255),
    }),
  };
  const fakeCanvas = { width: 0, height: 0, getContext: () => ctx };
  vi.spyOn(document, 'createElement').mockImplementation((tag) => {
    if (tag === 'canvas') return fakeCanvas;
    throw new Error(`Unexpected createElement('${tag}')`);
  });
  return { operations, fakeCanvas };
}

/** The time readouts drawn onto frames, in the order they were rendered. */
function renderedLabels(operations) {
  return operations.filter(([op]) => op === 'fillText').map(([, text]) => text);
}

/** Whether a color band was drawn onto the frame. */
function drewBand(operations) {
  return operations.some(([op]) => op === 'fillRect');
}

/**
 * Replace global Image with a stub that reports a fixed natural size and fires
 * onload asynchronously. Returns the list of src values that were requested.
 */
function stubImage(naturalWidth = 2560, naturalHeight = 1440) {
  const loads = [];
  class FakeImage {
    constructor() {
      this.naturalWidth = naturalWidth;
      this.naturalHeight = naturalHeight;
      this.complete = true;
    }
    set src(value) {
      loads.push(value);
      setTimeout(() => this.onload && this.onload(), 0);
    }
  }
  vi.stubGlobal('Image', FakeImage);
  return loads;
}

/** Minimal PNG-shaped buffer: signature plus an IHDR carrying width/height. */
function fakePngBuffer(width, height) {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes.buffer;
}

/**
 * Stub fetch + createImageBitmap so decoding takes the target-size path.
 * Returns the recorded createImageBitmap options.
 */
function stubTargetSizeDecode(buffer = fakePngBuffer(1280, 720)) {
  const calls = [];
  const closed = [];
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(buffer),
  }));
  vi.stubGlobal('createImageBitmap', vi.fn(async (_blob, options) => {
    calls.push(options);
    return {
      width: options.resizeWidth,
      height: options.resizeHeight,
      close: () => closed.push(true),
    };
  }));
  return { calls, closed };
}

/** Fresh module instance, so module-level caches and queues do not leak. */
async function loadModule() {
  vi.resetModules();
  return import('./zoomSdk');
}

// The module reads its "a background of ours is applied" flag from localStorage
// at import time, so a leftover value would follow the next loadModule().
beforeEach(() => {
  localStorage.clear();
  // Most of this suite predates Timer + Camera becoming the default and
  // exercises the card pipeline's mechanics, so start in card mode explicitly.
  // Tests about the persisted mode or the default save their own mode after
  // this, or clear storage again.
  saveOverlayMode('card');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  sdkMock.config.mockReset();
  sdkMock.callZoomApi.mockReset();
  sdkMock.setVideoFilter.mockReset();
  sdkMock.deleteVideoFilter.mockReset();
  sdkMock.setVirtualBackground.mockReset();
  sdkMock.removeVirtualBackground.mockReset();
  sdkMock.setVirtualForeground.mockReset();
  sdkMock.removeVirtualForeground.mockReset();
  sdkMock.shareApp.mockReset();
  sdkMock.appPopout.mockReset();
  sdkMock.onAppPopout.mockReset();
  sdkMock.onShareScreen.mockReset();
  sdkMock.getMeetingView.mockReset();
  sdkMock.onMeetingViewChange.mockReset();
});

describe('getBackgroundUrl', () => {
  it('places backgrounds under the app base path, not the origin root', async () => {
    const { getBackgroundUrl, getBasePath } = await loadModule();

    const url = getBackgroundUrl('blue');

    // The app is built with Vite base '/zoom/' in production. Requesting
    // origin + '/backgrounds/...' instead hits the SPA catch-all rewrite and
    // returns index.html, which fails to decode as an image and leaves the
    // meeting with no background at all.
    // Version-agnostic: BACKGROUND_VERSION is bumped whenever the assets change.
    expect(url).toMatch(
      new RegExp(
        `^${window.location.origin}${getBasePath()}backgrounds/timer-blue-background\\.png\\?v=\\d+$`
      )
    );
  });

  it('falls back to the blue background for an unknown color', async () => {
    const { getBackgroundUrl } = await loadModule();
    expect(getBackgroundUrl('chartreuse')).toContain('timer-blue-background.png');
  });

  it('normalizes a base path that is missing its trailing slash', async () => {
    const { getBasePath } = await loadModule();
    vi.stubEnv('BASE_URL', '/zoom');
    // Vite normally guarantees the trailing slash; do not depend on it, since a
    // missing one silently yields '/zoombackgrounds/...'.
    expect(getBasePath()).toBe('/zoom/');
  });
});

describe('getOverlayDimensions', () => {
  it('scales an oversized background down to the default budget', async () => {
    const { getOverlayDimensions } = await loadModule();
    // 2560x1440 is 14.7 MB of ImageData across the Zoom bridge, against a
    // documented 15 MB limit; 640x360 is 0.9 MB for the same visible result.
    expect(getOverlayDimensions(2560, 1440)).toEqual({ width: 640, height: 360 });
  });

  it('never upscales a source that already fits', async () => {
    const { getOverlayDimensions } = await loadModule();
    expect(getOverlayDimensions(640, 360)).toEqual({ width: 640, height: 360 });
  });

  it('preserves aspect ratio for non-16:9 sources', async () => {
    const { getOverlayDimensions } = await loadModule();
    // Height is the binding constraint here, so width scales by the same factor.
    expect(getOverlayDimensions(2000, 2000)).toEqual({ width: 360, height: 360 });
  });

  it('honours a caller-supplied budget', async () => {
    const { getOverlayDimensions } = await loadModule();
    expect(getOverlayDimensions(1280, 720, { width: 480, height: 270 })).toEqual({
      width: 480,
      height: 270,
    });
  });

  it('clamps a budget larger than the ceiling', async () => {
    const { getOverlayDimensions } = await loadModule();
    // A camera reporting 4K must not produce a 33 MB push that Zoom would reject.
    expect(getOverlayDimensions(3840, 2160, { width: 3840, height: 2160 })).toEqual({
      width: 640,
      height: 360,
    });
  });

  it('defaults to the 640x360 ceiling when no camera has reported', async () => {
    const { getOverlayBudget } = await loadModule();
    expect(getOverlayBudget()).toEqual({ width: 640, height: 360 });
  });
});

describe('imageToImageData', () => {
  it('does not horizontally mirror the source image', async () => {
    // Zoom only mirrors video in the local self-view; mirroring the background
    // here would make the Toastmasters logo appear backwards to every other
    // participant.
    const { imageToImageData } = await loadModule();
    const { operations } = stubCanvas();

    imageToImageData({ naturalWidth: 4, naturalHeight: 1 }, 4, 1);

    const horizontalFlips = operations.filter(
      ([op, sx, sy]) => op === 'scale' && sx === -1 && sy === 1
    );
    expect(horizontalFlips).toHaveLength(0);
  });

  it('draws at the requested size so oversized sources scale instead of cropping', async () => {
    const { imageToImageData } = await loadModule();
    const { operations, fakeCanvas } = stubCanvas();

    const result = imageToImageData({ naturalWidth: 2560, naturalHeight: 1440 }, 1280, 720);

    // Destination width/height must be passed; without them drawImage renders at
    // natural size and getImageData returns the top-left crop.
    expect(operations.filter(([op]) => op === 'drawImage')).toEqual([
      ['drawImage', 0, 0, 1280, 720],
    ]);
    expect(fakeCanvas).toMatchObject({ width: 1280, height: 720 });
    expect(result).toMatchObject({ width: 1280, height: 720 });
  });
});

describe('loadImageAsImageData', () => {
  beforeEach(() => {
    stubCanvas();
  });

  it('shares one download and decode between concurrent callers', async () => {
    const { loadImageAsImageData } = await loadModule();
    const loads = stubImage();

    const [first, second] = await Promise.all([
      loadImageAsImageData('/backgrounds/blue.png'),
      loadImageAsImageData('/backgrounds/blue.png'),
    ]);

    // A preload and a concurrent apply must not each decode 2560x1440.
    expect(loads).toEqual(['/backgrounds/blue.png']);
    expect(second).toBe(first);
  });

  it('reuses the resolved ImageData on later calls', async () => {
    const { loadImageAsImageData } = await loadModule();
    const loads = stubImage();

    const first = await loadImageAsImageData('/backgrounds/blue.png');
    const second = await loadImageAsImageData('/backgrounds/blue.png');

    expect(loads).toHaveLength(1);
    expect(second).toBe(first);
  });

  it('does not cache a failed load, so a later attempt can retry', async () => {
    const { loadImageAsImageData } = await loadModule();
    const loads = [];
    class FailingImage {
      set src(value) {
        loads.push(value);
        setTimeout(() => this.onerror && this.onerror({ type: 'error' }), 0);
      }
    }
    vi.stubGlobal('Image', FailingImage);

    await expect(loadImageAsImageData('/backgrounds/blue.png')).rejects.toThrow();
    await expect(loadImageAsImageData('/backgrounds/blue.png')).rejects.toThrow();

    expect(loads).toHaveLength(2);
  });
});

describe('applyOverlay', () => {
  beforeEach(() => {
    stubCanvas();
    stubImage();
    sdkMock.config.mockResolvedValue({});
    sdkMock.setVideoFilter.mockResolvedValue({ status: 'ok' });
    sdkMock.deleteVideoFilter.mockResolvedValue({});
  });

  it('skips a push when the same overlay is already showing', async () => {
    const { initializeZoomSdk, applyOverlay, isOverlayActive } = await loadModule();
    await initializeZoomSdk();

    await applyOverlay('/backgrounds/blue.png');
    await applyOverlay('/backgrounds/blue.png');

    // resetTimer runs on every speaker/role change; re-pushing an identical
    // background costs seconds on a slow client for no visible change.
    expect(sdkMock.setVideoFilter).toHaveBeenCalledTimes(1);
    expect(isOverlayActive()).toBe(true);
  });

  it('pushes again after the overlay has been removed', async () => {
    const { initializeZoomSdk, applyOverlay, removeOverlay, isOverlayActive } = await loadModule();
    await initializeZoomSdk();

    await applyOverlay('/backgrounds/blue.png');
    await removeOverlay();
    expect(isOverlayActive()).toBe(false);

    await applyOverlay('/backgrounds/blue.png');
    expect(sdkMock.setVideoFilter).toHaveBeenCalledTimes(2);
  });

  it('collapses queued color changes to the newest one', async () => {
    const { initializeZoomSdk, applyOverlay } = await loadModule();
    await initializeZoomSdk();

    // Fired without awaiting, the way the rAF timer tick does on a fast
    // green -> yellow -> red run.
    const pushes = [
      applyOverlay('/backgrounds/green.png'),
      applyOverlay('/backgrounds/yellow.png'),
      applyOverlay('/backgrounds/red.png'),
    ];
    await Promise.all(pushes);

    // Superseded colors are dropped rather than pushed late and out of order.
    expect(sdkMock.setVideoFilter).toHaveBeenCalledTimes(1);
  });

  it('sends imageData in card mode, since setVideoFilter has no fileUrl option', async () => {
    const { initializeZoomSdk, applyOverlay, getOverlayDimensions } = await loadModule();
    await initializeZoomSdk();

    await applyOverlay('/backgrounds/blue.png');

    const [options] = sdkMock.setVideoFilter.mock.calls[0];
    // Sized by the overlay budget, not the 2560x1440 the stub image reports.
    expect(options.imageData).toMatchObject(getOverlayDimensions(2560, 1440));
    expect(options.fileUrl).toBeUndefined();
  });

  it('keeps working after a failed push', async () => {
    const { initializeZoomSdk, applyOverlay } = await loadModule();
    await initializeZoomSdk();

    sdkMock.setVideoFilter.mockRejectedValueOnce(new Error('bridge error'));
    await applyOverlay('/backgrounds/green.png');

    sdkMock.setVideoFilter.mockResolvedValue({ status: 'ok' });
    await applyOverlay('/backgrounds/red.png');

    // A rejected op must not leave the shared queue in a rejected state.
    expect(sdkMock.setVideoFilter).toHaveBeenCalledTimes(2);
  });
});

describe('readPngSize', () => {
  it('reads dimensions from the IHDR chunk', async () => {
    const { readPngSize } = await loadModule();
    expect(readPngSize(fakePngBuffer(2560, 1440))).toEqual({ width: 2560, height: 1440 });
  });

  it('returns null for bytes that are not a PNG', async () => {
    const { readPngSize } = await loadModule();
    const notPng = new Uint8Array(32);
    notPng.set([0xff, 0xd8, 0xff, 0xe0], 0); // JPEG
    expect(readPngSize(notPng.buffer)).toBeNull();
  });

  it('returns null for a buffer too short to hold an IHDR', async () => {
    const { readPngSize } = await loadModule();
    expect(readPngSize(new Uint8Array(8).buffer)).toBeNull();
  });
});

describe('decoding at target size', () => {
  beforeEach(() => {
    stubCanvas();
  });

  it('decodes straight to the budget size instead of full resolution', async () => {
    const { loadImageAsImageData } = await loadModule();
    const { calls } = stubTargetSizeDecode(fakePngBuffer(1280, 720));
    const loads = stubImage();

    const imageData = await loadImageAsImageData('/backgrounds/blue.png');

    // 1280x720 source fitted into the 640x360 default budget, decoded once at
    // that size rather than decoded large and resampled.
    expect(calls).toEqual([{ resizeWidth: 640, resizeHeight: 360, resizeQuality: 'high' }]);
    expect(imageData).toMatchObject({ width: 640, height: 360 });
    expect(loads).toEqual([]); // the Image() path was not used
  });

  it('keeps the asset aspect ratio when the camera reports a different one', async () => {
    const { loadImageAsImageData, handleMyMediaChange } = await loadModule();
    const { calls } = stubTargetSizeDecode(fakePngBuffer(1280, 720));

    // 4:3 camera against a 16:9 asset. Naively resizing to 480x360 would stretch
    // the logo; the fit must stay 16:9.
    handleMyMediaChange({ media: { video: { width: 480, height: 360 } }, timestamp: 1 });
    await loadImageAsImageData('/backgrounds/blue.png');

    expect(calls[0]).toMatchObject({ resizeWidth: 480, resizeHeight: 270 });
  });

  it('releases the native bitmap after reading the pixels', async () => {
    const { loadImageAsImageData } = await loadModule();
    const { closed } = stubTargetSizeDecode();

    await loadImageAsImageData('/backgrounds/blue.png');

    expect(closed).toEqual([true]);
  });

  it.each([
    ['fetch rejects', () => vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))],
    [
      'the response is not ok',
      () => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, arrayBuffer: () => Promise.resolve(new ArrayBuffer(32)) })),
    ],
    [
      'the response is not a PNG',
      () => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(32)) })),
    ],
    [
      'createImageBitmap throws',
      () => vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode failed'))),
    ],
  ])('falls back to the Image() path when %s', async (_label, breakIt) => {
    const { loadImageAsImageData } = await loadModule();
    stubTargetSizeDecode();
    breakIt();
    const loads = stubImage(1280, 720);

    const imageData = await loadImageAsImageData('/backgrounds/blue.png');

    // A direct Image() load has historically behaved better inside the Zoom
    // client, so it must remain a working escape hatch.
    expect(loads).toEqual(['/backgrounds/blue.png']);
    expect(imageData).toMatchObject({ width: 640, height: 360 });
  });

  it('uses the Image() path when the environment lacks createImageBitmap', async () => {
    const { loadImageAsImageData } = await loadModule();
    vi.stubGlobal('createImageBitmap', undefined);
    const loads = stubImage(1280, 720);

    const imageData = await loadImageAsImageData('/backgrounds/blue.png');

    expect(loads).toEqual(['/backgrounds/blue.png']);
    expect(imageData).toMatchObject({ width: 640, height: 360 });
  });
});

describe('camera resolution tracking', () => {
  beforeEach(() => {
    stubCanvas();
    sdkMock.config.mockResolvedValue({});
    sdkMock.setVideoFilter.mockResolvedValue({ status: 'ok' });
    sdkMock.deleteVideoFilter.mockResolvedValue({});
  });

  it('subscribes to onMyMediaChange and requests it as a capability', async () => {
    const { initializeZoomSdk } = await loadModule();
    sdkMock.onMyMediaChange = vi.fn();

    await initializeZoomSdk();

    expect(sdkMock.config.mock.calls[0][0].capabilities).toContain('onMyMediaChange');
    expect(sdkMock.onMyMediaChange).toHaveBeenCalledWith(expect.any(Function));
    delete sdkMock.onMyMediaChange;
  });

  it('still initializes when the client rejects the optional capability', async () => {
    const { initializeZoomSdk, isSdkAvailable } = await loadModule();
    sdkMock.config.mockRejectedValueOnce(new Error('unsupported capability'));

    await initializeZoomSdk();

    // Losing config() entirely would disable every overlay, so the retry drops
    // the optional capability rather than the whole SDK.
    expect(isSdkAvailable()).toBe(true);
    expect(sdkMock.config.mock.calls[1][0].capabilities).not.toContain('onMyMediaChange');
    // The filter pipeline is what the retry has to preserve: every video mode
    // degrades to it, including the Timer + Camera default.
    expect(sdkMock.config.mock.calls[1][0].capabilities).toContain('setVideoFilter');
    expect(sdkMock.config.mock.calls[1][0].capabilities).toContain('deleteVideoFilter');
  });

  it('sizes the overlay to the reported camera resolution', async () => {
    const { handleMyMediaChange, getOverlayBudget, getOverlayDimensions } = await loadModule();

    handleMyMediaChange({ media: { video: { width: 480, height: 270 } }, timestamp: 1 });

    expect(getOverlayBudget()).toEqual({ width: 480, height: 270 });
    // Below the ceiling, so the camera resolution binds: 0.5 MB instead of 0.9 MB.
    expect(getOverlayDimensions(1280, 720)).toEqual({ width: 480, height: 270 });
  });

  it.each([
    ['720p', 1280, 720],
    ['1080p', 1920, 1080],
    ['4K', 3840, 2160],
  ])('treats a %s camera as an upper bound, not a target', async (_label, width, height) => {
    const { handleMyMediaChange, getOverlayBudget, getOverlayDimensions } = await loadModule();

    handleMyMediaChange({ media: { video: { width, height } }, timestamp: 1 });

    // Matching the camera would make a 720p webcam cost 3.7 MB per push, worse
    // than sending nothing camera-shaped at all. The content sets the ceiling.
    expect(getOverlayBudget()).toEqual({ width: 640, height: 360 });
    expect(getOverlayDimensions(1280, 720)).toEqual({ width: 640, height: 360 });
  });

  it.each([
    ['video with only a state flag', { media: { video: { state: false } }, timestamp: 1 }],
    ['an audio-only payload', { media: { audio: { state: true } }, timestamp: 1 }],
    ['a zero dimension', { media: { video: { width: 0, height: 0 } }, timestamp: 1 }],
    ['a missing media key', { timestamp: 1 }],
    ['no event at all', undefined],
  ])('ignores %s', async (_label, event) => {
    const { handleMyMediaChange, getOverlayBudget, getCameraResolution } = await loadModule();

    expect(() => handleMyMediaChange(event)).not.toThrow();

    expect(getCameraResolution()).toBeNull();
    expect(getOverlayBudget()).toEqual({ width: 640, height: 360 });
  });

  it('re-pushes the visible overlay when the resolution changes', async () => {
    const { initializeZoomSdk, applyOverlay, handleMyMediaChange } = await loadModule();
    await initializeZoomSdk();
    stubImage();

    await applyOverlay('/backgrounds/blue.png');
    expect(sdkMock.setVideoFilter).toHaveBeenCalledTimes(1);

    // Below the ceiling, so this genuinely changes the effective budget.
    handleMyMediaChange({ media: { video: { width: 480, height: 270 } }, timestamp: 2 });
    await applyOverlay('/backgrounds/blue.png'); // drains the queue

    // Same URL, so this only happens because the guard compares the budget the
    // pixels were rendered for. The new push must carry the new size.
    expect(sdkMock.setVideoFilter).toHaveBeenCalledTimes(2);
    const [options] = sdkMock.setVideoFilter.mock.calls[1];
    expect(options.imageData).toMatchObject({ width: 480, height: 270 });
  });

  it('does not push anything when no overlay is showing', async () => {
    const { initializeZoomSdk, handleMyMediaChange } = await loadModule();
    await initializeZoomSdk();
    stubImage();

    handleMyMediaChange({ media: { video: { width: 480, height: 270 } }, timestamp: 2 });
    await Promise.resolve();

    expect(sdkMock.setVideoFilter).not.toHaveBeenCalled();
  });

  it('ignores a repeat of the resolution it already has', async () => {
    const { initializeZoomSdk, applyOverlay, handleMyMediaChange } = await loadModule();
    await initializeZoomSdk();
    stubImage();
    await applyOverlay('/backgrounds/blue.png');

    const event = { media: { video: { width: 480, height: 270 } }, timestamp: 2 };
    handleMyMediaChange(event);
    handleMyMediaChange(event);
    await applyOverlay('/backgrounds/blue.png');

    // Two pushes: the original and one re-push. Not three.
    expect(sdkMock.setVideoFilter).toHaveBeenCalledTimes(2);
  });
});

describe('applyOverlay in camera mode', () => {
  beforeEach(() => {
    stubCanvas();
    sdkMock.config.mockResolvedValue({});
    sdkMock.deleteVideoFilter.mockResolvedValue({});
    sdkMock.removeVirtualBackground.mockResolvedValue({});
    sdkMock.setVirtualBackground.mockResolvedValue({});
  });

  it('passes a fileUrl and never downloads or decodes the image', async () => {
    const { initializeZoomSdk, setOverlayMode, applyOverlay, OVERLAY_MODE_CAMERA } = await loadModule();
    await initializeZoomSdk();
    const loads = stubImage();
    await setOverlayMode(OVERLAY_MODE_CAMERA, null);

    await applyOverlay('https://zoom.example/backgrounds/blue.png');

    // The Zoom client fetches the image itself, so no pixels cross the bridge.
    expect(sdkMock.setVirtualBackground).toHaveBeenCalledWith({
      fileUrl: 'https://zoom.example/backgrounds/blue.png',
    });
    expect(loads).toEqual([]);
  });

  it('falls back to imageData when the client cannot fetch the fileUrl', async () => {
    const { initializeZoomSdk, setOverlayMode, applyOverlay, getOverlayDimensions, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    const loads = stubImage();
    await setOverlayMode(OVERLAY_MODE_CAMERA, null);

    // A restricted network or proxy can stop the native client reaching the URL.
    sdkMock.setVirtualBackground.mockRejectedValueOnce(new Error('fetch failed'));

    await applyOverlay('https://zoom.example/backgrounds/blue.png');

    expect(loads).toEqual(['https://zoom.example/backgrounds/blue.png']);
    const [options] = sdkMock.setVirtualBackground.mock.calls[1];
    expect(options.imageData).toMatchObject(getOverlayDimensions(2560, 1440));
  });

  it('does not re-push on a resolution change, since a fileUrl carries no pixels', async () => {
    const { initializeZoomSdk, setOverlayMode, applyOverlay, handleMyMediaChange, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    await setOverlayMode(OVERLAY_MODE_CAMERA, null);
    await applyOverlay('https://zoom.example/backgrounds/blue.png');
    expect(sdkMock.setVirtualBackground).toHaveBeenCalledTimes(1);

    handleMyMediaChange({ media: { video: { width: 480, height: 270 } }, timestamp: 2 });
    // The re-push, if there were one, is queued rather than awaited.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Zoom scales the file itself, so resolution has no bearing on this push.
    // Checked on the resolution event alone: camera mode deliberately no longer
    // dedupes an explicit apply, since the user may have changed the background
    // in Zoom without telling us.
    expect(sdkMock.setVirtualBackground).toHaveBeenCalledTimes(1);
  });

  it('marks the overlay active after a fileUrl push, so removal still works', async () => {
    const { initializeZoomSdk, setOverlayMode, applyOverlay, removeOverlay, isOverlayActive, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    await setOverlayMode(OVERLAY_MODE_CAMERA, null);

    await applyOverlay('https://zoom.example/backgrounds/blue.png');
    expect(isOverlayActive()).toBe(true);

    await removeOverlay();
    expect(sdkMock.removeVirtualBackground).toHaveBeenCalled();
    expect(isOverlayActive()).toBe(false);
  });
});

describe('stage modes (share and popout)', () => {
  beforeEach(() => {
    stubCanvas();
    sdkMock.config.mockResolvedValue({});
    sdkMock.deleteVideoFilter.mockResolvedValue({});
    sdkMock.removeVirtualBackground.mockResolvedValue({});
    sdkMock.setVirtualBackground.mockResolvedValue({});
    sdkMock.shareApp.mockResolvedValue({});
    sdkMock.appPopout.mockResolvedValue({});
  });

  // Added per-test rather than to the shared mock, which stays a picture of what
  // the SDK itself defines — getUserContext reaches the client through its proxy.
  const withUserContext = (context) => {
    sdkMock.getUserContext = vi.fn().mockResolvedValue(context);
  };

  afterEach(() => {
    delete sdkMock.getUserContext;
  });

  it('starts nothing on its own when the stage opens', async () => {
    const { initializeZoomSdk, setOverlayMode, isAppShareActive, isAppPoppedOut, OVERLAY_MODE_STAGE } =
      await loadModule();
    await initializeZoomSdk();

    await setOverlayMode(OVERLAY_MODE_STAGE, 'https://zoom.example/backgrounds/blue.png');

    // Opening a view must never broadcast anything. Sharing and popping out are
    // buttons on the stage, so a screen share is always something the organizer
    // pressed rather than a consequence of picking a mode.
    expect(sdkMock.shareApp).not.toHaveBeenCalled();
    expect(sdkMock.appPopout).not.toHaveBeenCalled();
    expect(isAppShareActive()).toBe(false);
    expect(isAppPoppedOut()).toBe(false);
    // And the camera is left alone, which is the whole point of the stage.
    expect(sdkMock.setVirtualBackground).not.toHaveBeenCalled();
    expect(sdkMock.setVideoFilter).not.toHaveBeenCalled();
  });

  it('shares the stage without touching the camera', async () => {
    const { initializeZoomSdk, setOverlayMode, setAppShare, isAppShareActive, OVERLAY_MODE_STAGE } =
      await loadModule();
    await initializeZoomSdk();
    await setOverlayMode(OVERLAY_MODE_STAGE, null);

    expect(await setAppShare(true)).toBe(true);

    expect(sdkMock.shareApp).toHaveBeenCalledWith({ action: 'start', withSound: false });
    expect(isAppShareActive()).toBe(true);
    expect(sdkMock.setVirtualBackground).not.toHaveBeenCalled();
    expect(sdkMock.setVideoFilter).not.toHaveBeenCalled();
  });

  it('keeps the share when a popout is refused mid-share', async () => {
    const { initializeZoomSdk, setOverlayMode, setAppShare, setAppPopout, isAppShareActive, isAppPoppedOut, OVERLAY_MODE_STAGE } =
      await loadModule();
    await initializeZoomSdk();
    await setOverlayMode(OVERLAY_MODE_STAGE, null);
    await setAppShare(true);
    // Zoom will not undock an app that is being shared. The stage hides the
    // button while sharing for that reason; this covers the request arriving
    // anyway, and the share surviving it.
    sdkMock.appPopout.mockRejectedValueOnce(Object.assign(new Error('cannot popout'), { code: 10247 }));

    expect(await setAppPopout(true)).toBe(false);

    expect(isAppPoppedOut()).toBe(false);
    expect(isAppShareActive()).toBe(true);
  });

  it('pushes no pixels while the stage is up, whoever asks', async () => {
    const { initializeZoomSdk, setOverlayMode, applyOverlay, OVERLAY_MODE_STAGE } = await loadModule();
    await initializeZoomSdk();
    const loads = stubImage();
    await setOverlayMode(OVERLAY_MODE_STAGE, null);

    // TimerContext calls applyOverlay on every status change regardless of mode.
    await applyOverlay('https://zoom.example/backgrounds/red.png');

    expect(sdkMock.setVideoFilter).not.toHaveBeenCalled();
    expect(sdkMock.setVirtualBackground).not.toHaveBeenCalled();
    expect(loads).toEqual([]);
  });

  it('stops a share and docks the window when the stage closes', async () => {
    const { initializeZoomSdk, setOverlayMode, setAppShare, setAppPopout, isAppShareActive, isAppPoppedOut, OVERLAY_MODE_STAGE, OVERLAY_MODE_CARD } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    await setOverlayMode(OVERLAY_MODE_STAGE, null);
    await setAppShare(true);
    await setAppPopout(true);

    await setOverlayMode(OVERLAY_MODE_CARD, null);

    // Neither should outlive the view that offered it — least of all the share,
    // which would leave the meeting watching a stage that is no longer there.
    expect(sdkMock.shareApp).toHaveBeenLastCalledWith({ action: 'stop' });
    expect(sdkMock.appPopout).toHaveBeenLastCalledWith({ action: 'dock' });
    expect(isAppShareActive()).toBe(false);
    expect(isAppPoppedOut()).toBe(false);
  });

  it('reports a refused popout rather than claiming the window opened', async () => {
    const { initializeZoomSdk, setAppPopout, isAppPoppedOut } = await loadModule();
    await initializeZoomSdk();
    // 10247: the running context cannot pop out. Mobile clients also reject the
    // capability outright at config() time.
    sdkMock.appPopout.mockRejectedValueOnce(Object.assign(new Error('cannot popout'), { code: 10247 }));

    expect(await setAppPopout(true)).toBe(false);
    expect(isAppPoppedOut()).toBe(false);
  });

  it('does not dock a window the client already docked itself', async () => {
    const { initializeZoomSdk, setOverlayMode, setAppPopout, handleAppPopout, isAppPoppedOut, OVERLAY_MODE_STAGE, OVERLAY_MODE_CARD } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    await setOverlayMode(OVERLAY_MODE_STAGE, null);
    await setAppPopout(true);

    // The user merged the window back from Zoom's own ellipsis menu.
    handleAppPopout({ action: 'dock', timestamp: 1 });
    expect(isAppPoppedOut()).toBe(false);
    sdkMock.appPopout.mockClear();

    await setOverlayMode(OVERLAY_MODE_CARD, null);

    expect(sdkMock.appPopout).not.toHaveBeenCalled();
  });

  it('follows a share stopped from Zoom\'s own toolbar', async () => {
    const { initializeZoomSdk, setAppShare, setShareChangeCallback, handleShareApp, isAppShareActive } =
      await loadModule();
    await initializeZoomSdk();
    const seen = [];
    setShareChangeCallback((sharing) => seen.push(sharing));
    await setAppShare(true);

    // Zoom's sharing toolbar never goes near our button, so without the event the
    // stage would keep offering "Stop sharing" for a share that already ended.
    handleShareApp('stop');
    expect(isAppShareActive()).toBe(false);

    handleShareApp('stop'); // duplicate, no second call
    handleShareApp({ action: 'start' }); // object form, seen on some clients
    handleShareApp('nonsense'); // malformed payload

    expect(seen).toEqual([false, true]);
  });

  it('follows Zoom\'s own Stop Share through onShareScreen', async () => {
    const { initializeZoomSdk, setAppShare, setShareChangeCallback, handleShareScreen, isAppShareActive } =
      await loadModule();
    // An app share is a screen share as far as the meeting is concerned, and this
    // event reaches clients that deliver neither onShareApp nor the meeting view.
    // It is what lets the stage follow Zoom's toolbar without polling for it.
    withUserContext({ participantUUID: 'me', screenName: 'Priya', role: 'host' });
    await initializeZoomSdk();
    const seen = [];
    setShareChangeCallback((sharing) => seen.push(sharing));
    await setAppShare(true);

    handleShareScreen({ participantUUID: 'me', action: 'stop', withSound: false, timestamp: 1 });

    expect(isAppShareActive()).toBe(false);
    expect(seen).toEqual([false]);
  });

  it('ignores a share of someone else\'s that stopped', async () => {
    const { initializeZoomSdk, setAppShare, handleShareScreen, isAppShareActive } = await loadModule();
    withUserContext({ participantUUID: 'me', screenName: 'Priya', role: 'host' });
    await initializeZoomSdk();
    await setAppShare(true);

    // The event is meeting-wide: it fires for everybody. Reading someone else's
    // share ending as ours would offer "Screenshare" over a stage the meeting is
    // still watching, and pressing it would ask Zoom for a second share.
    handleShareScreen({ participantUUID: 'someone-else', action: 'stop', timestamp: 1 });
    handleShareScreen({ participantUUID: 'me', action: 'start', timestamp: 2 });

    expect(isAppShareActive()).toBe(true);
  });

  it('leaves the share alone when it cannot tell whose it is', async () => {
    const { initializeZoomSdk, setAppShare, handleShareScreen, isAppShareActive } = await loadModule();
    // getUserContext refused — not defined on this client at all — so there is no
    // UUID to match against. Guessing is worse than the stale label: the other two
    // events and the check made before each stop still cover this client.
    await initializeZoomSdk();
    await setAppShare(true);

    handleShareScreen({ participantUUID: 'me', action: 'stop', timestamp: 1 });

    expect(isAppShareActive()).toBe(true);
  });

  it('follows a share stopped from Zoom\'s own toolbar through the meeting view', async () => {
    const { initializeZoomSdk, setAppShare, setShareChangeCallback, handleMeetingViewChange, isAppShareActive } =
      await loadModule();
    await initializeZoomSdk();
    const seen = [];
    setShareChangeCallback((sharing) => seen.push(sharing));
    await setAppShare(true);

    // onShareApp is the event for this, but it is not delivered by every client.
    handleMeetingViewChange({ presenting: false, timestamp: 1 });

    expect(isAppShareActive()).toBe(false);
    expect(seen).toEqual([false]);
  });

  it('reads nothing into a presenting flag that is on or absent', async () => {
    const { initializeZoomSdk, setAppShare, handleMeetingViewChange, isAppShareActive } = await loadModule();
    await initializeZoomSdk();
    await setAppShare(true);

    // Only the parameters that changed are present, so an event about the view
    // switching to gallery says nothing about sharing. And `presenting: true`
    // covers any share, ours or the user's own screen — never a reason to claim
    // the app is the thing on screen.
    handleMeetingViewChange({ view: 'gallery', timestamp: 1 });
    handleMeetingViewChange({ presenting: true, timestamp: 2 });

    expect(isAppShareActive()).toBe(true);
  });

  it('treats stopping an already-ended share as done, not as a failure', async () => {
    const { initializeZoomSdk, setAppShare, setShareChangeCallback, isAppShareActive } = await loadModule();
    await initializeZoomSdk();
    const seen = [];
    setShareChangeCallback((sharing) => seen.push(sharing));
    await setAppShare(true);
    sdkMock.shareApp.mockClear();
    // The organizer pressed Zoom's own Stop Share, and this client reported it
    // through neither onShareApp nor onMeetingViewChange. Whatever code the
    // refusal carries — clients word this differently — it is not a failure.
    sdkMock.getMeetingView.mockResolvedValue({ view: 'speaker', presenting: false });
    sdkMock.shareApp.mockRejectedValueOnce(Object.assign(new Error('failed to share'), { code: 10018 }));

    // The share they wanted gone is gone, so the button must not report failure.
    expect(await setAppShare(false)).toBe(true);
    expect(isAppShareActive()).toBe(false);
    expect(seen).toEqual([false]);
  });

  it('still asks Zoom to stop, in case the read had gone stale', async () => {
    const { initializeZoomSdk, setAppShare, isAppShareActive } = await loadModule();
    await initializeZoomSdk();
    await setAppShare(true);
    sdkMock.shareApp.mockClear();
    // A "nobody is presenting" read is never grounds for skipping the stop: if it
    // is wrong, skipping leaves the meeting watching a share we declared over.
    sdkMock.getMeetingView.mockResolvedValue({ view: 'speaker', presenting: false });

    expect(await setAppShare(false)).toBe(true);

    expect(sdkMock.shareApp).toHaveBeenCalledWith({ action: 'stop' });
    expect(isAppShareActive()).toBe(false);
  });

  it('accepts Zoom saying there was no share to stop', async () => {
    const { initializeZoomSdk, setAppShare, isAppShareActive } = await loadModule();
    await initializeZoomSdk();
    await setAppShare(true);
    // A client that cannot answer getMeetingView, so the truth only arrives as a
    // rejection from the stop itself. 10189: no ongoing screen share by this user.
    sdkMock.getMeetingView.mockRejectedValue(Object.assign(new Error('unsupported'), { code: 10116 }));
    sdkMock.shareApp.mockRejectedValueOnce(Object.assign(new Error('no share'), { code: 10189 }));

    expect(await setAppShare(false)).toBe(true);
    expect(isAppShareActive()).toBe(false);
  });

  it('still reports a stop the client genuinely refused', async () => {
    const { initializeZoomSdk, setAppShare } = await loadModule();
    await initializeZoomSdk();
    await setAppShare(true);
    sdkMock.getMeetingView.mockResolvedValue({ view: 'standard', presenting: true });
    sdkMock.shareApp.mockRejectedValueOnce(Object.assign(new Error('failed'), { code: 10018 }));

    // A share that is up and would not come down is exactly what the toast is
    // for; swallowing it would leave the meeting watching the stage.
    expect(await setAppShare(false)).toBe(false);
  });

  it('reconciles the share when the app comes back to the front', async () => {
    const { initializeZoomSdk, setAppShare, handleAppVisibilityChange, syncAppShareState, isAppShareActive } =
      await loadModule();
    await initializeZoomSdk();
    await setAppShare(true);
    sdkMock.getMeetingView.mockResolvedValue({ view: 'speaker', presenting: false });
    // Well past the settle window below, so this is the steady-state answer.
    vi.spyOn(performance, 'now').mockReturnValue(60_000);

    handleAppVisibilityChange({ visible: true, timestamp: 1 });
    // The handler cannot await; the state settles on the same check.
    await syncAppShareState();

    expect(isAppShareActive()).toBe(false);
  });

  it('ignores a poll that lands in the moments just after a share starts', async () => {
    const { initializeZoomSdk, setAppShare, syncAppShareState, isAppShareActive } = await loadModule();
    await initializeZoomSdk();
    await setAppShare(true);
    // The client's view state does not update in the same instant the share
    // begins. Believing this read would flip the button back to "Screenshare"
    // mid-share, and pressing it would then ask Zoom to start a second one.
    sdkMock.getMeetingView.mockResolvedValue({ view: 'speaker', presenting: false });

    expect(await syncAppShareState()).toBe(true);
    expect(sdkMock.getMeetingView).not.toHaveBeenCalled();
    expect(isAppShareActive()).toBe(true);
  });

  it('notifies the popout callback when the client docks the window', async () => {
    const { initializeZoomSdk, setPopoutChangeCallback, handleAppPopout } = await loadModule();
    await initializeZoomSdk();
    const seen = [];
    setPopoutChangeCallback((popped) => seen.push(popped));

    handleAppPopout({ action: 'undock', timestamp: 1 });
    handleAppPopout({ action: 'undock', timestamp: 2 }); // duplicate, no second call
    handleAppPopout({ action: 'dock', timestamp: 3 });
    handleAppPopout({ timestamp: 4 }); // malformed payload

    expect(seen).toEqual([true, false]);
  });

  it('restores the video overlay when returning from the stage', async () => {
    const { initializeZoomSdk, setOverlayMode, OVERLAY_MODE_STAGE, OVERLAY_MODE_CAMERA } = await loadModule();
    await initializeZoomSdk();
    stubImage();
    await setOverlayMode(OVERLAY_MODE_STAGE, null);

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');

    expect(sdkMock.setVirtualBackground).toHaveBeenCalledWith({
      fileUrl: 'https://zoom.example/backgrounds/green.png',
    });
  });
});

describe('getZoomParticipants', () => {
  it('returns an empty list without logging a bogus error when the SDK is unavailable', async () => {
    // A fresh module has sdkAvailable === false, which is also what every
    // dev-server page load sees (SpeakerInput calls this on mount). The
    // unavailable branch used to log a variable that was not bound in its
    // scope, so the call threw a ReferenceError that the outer catch swallowed
    // and relogged as 'Failed to get Zoom participants: ReferenceError'.
    const { getZoomParticipants } = await loadModule();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(getZoomParticipants()).resolves.toEqual({
      participants: [],
      role: '',
      restricted: false,
    });

    expect(errorSpy).not.toHaveBeenCalled();
  });

  // getUserContext is grantable in the Marketplace but reaches the client
  // through the SDK's proxy, so it is added to the mock per-test rather than to
  // the shared one — which stays a picture of what the SDK itself defines.
  function withUserContext(context) {
    sdkMock.getUserContext = vi.fn().mockResolvedValue(context);
    return sdkMock.getUserContext;
  }

  async function initialized() {
    sdkMock.config.mockResolvedValue({});
    const module = await loadModule();
    await module.initializeZoomSdk();
    return module;
  }

  afterEach(() => {
    delete sdkMock.getUserContext;
    delete sdkMock.getMeetingParticipants;
  });

  it('puts the organizer in their own speaker list', async () => {
    // getMeetingParticipants returns everybody except the caller, so on its own
    // it never offers the organizer the one name they most often have to time.
    withUserContext({ screenName: 'Priya', role: 'host', participantUUID: 'me' });
    sdkMock.getMeetingParticipants = vi.fn().mockResolvedValue({
      participants: [{ screenName: 'Sam', participantUUID: 'p2' }],
    });
    const { getZoomParticipants } = await initialized();

    const result = await getZoomParticipants();

    // Self leads: it is the name most likely to be wanted.
    expect(result.participants).toEqual([
      { id: 'me', name: 'Priya' },
      { id: 'p2', name: 'Sam' },
    ]);
    expect(result.restricted).toBe(false);
  });

  it('does not list the organizer twice if the client already included them', async () => {
    withUserContext({ screenName: 'Priya', role: 'coHost', participantUUID: 'me' });
    sdkMock.getMeetingParticipants = vi.fn().mockResolvedValue({
      participants: [
        { screenName: 'Priya', participantUUID: 'me' },
        { screenName: 'Sam', participantUUID: 'p2' },
      ],
    });
    const { getZoomParticipants } = await initialized();

    expect((await getZoomParticipants()).participants).toEqual([
      { id: 'me', name: 'Priya' },
      { id: 'p2', name: 'Sam' },
    ]);
  });

  it('still offers the organizer their own name when they are not hosting', async () => {
    // getMeetingParticipants is host and co-host only. An attendee running the
    // timer used to get an empty list and no reason for it.
    withUserContext({ screenName: 'Priya', role: 'attendee', participantUUID: 'me' });
    sdkMock.getMeetingParticipants = vi.fn().mockRejectedValue(
      Object.assign(new Error('not allowed'), { code: 10102 })
    );
    const { getZoomParticipants } = await initialized();

    const result = await getZoomParticipants();

    expect(result.participants).toEqual([{ id: 'me', name: 'Priya' }]);
    // The one cause the organizer can act on, and the only one worth telling
    // them about.
    expect(result.restricted).toBe(true);
  });

  it('does not blame the role when a host\'s list fails for another reason', async () => {
    withUserContext({ screenName: 'Priya', role: 'host', participantUUID: 'me' });
    sdkMock.getMeetingParticipants = vi.fn().mockRejectedValue(new Error('bridge timeout'));
    const { getZoomParticipants } = await initialized();

    const result = await getZoomParticipants();

    // Telling a host to ask for co-host would be nonsense advice.
    expect(result.restricted).toBe(false);
    expect(result.participants).toEqual([{ id: 'me', name: 'Priya' }]);
  });
});

describe('leaving a stage mode is never dropped by the overlay queue', () => {
  beforeEach(() => {
    stubCanvas();
    sdkMock.config.mockResolvedValue({});
    sdkMock.deleteVideoFilter.mockResolvedValue({});
    sdkMock.setVideoFilter.mockResolvedValue({});
    sdkMock.removeVirtualBackground.mockResolvedValue({});
    sdkMock.setVirtualBackground.mockResolvedValue({});
    sdkMock.shareApp.mockResolvedValue({});
    sdkMock.appPopout.mockResolvedValue({});
  });

  it('stops the share even when a newer overlay push supersedes the teardown', async () => {
    const { initializeZoomSdk, setOverlayMode, setAppShare, applyOverlay, isAppShareActive, OVERLAY_MODE_STAGE, OVERLAY_MODE_CARD } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    await setOverlayMode(OVERLAY_MODE_STAGE, null);
    await setAppShare(true);
    expect(isAppShareActive()).toBe(true);

    // Exactly what the UI does on exit: React flips the mode, whose effect fires
    // an applyOverlay for the incoming card mode while the teardown is in flight.
    // Routed through the queue, that push would bump the request id and the
    // teardown would be skipped, leaving the meeting shared with no stage on
    // screen and no way back to it.
    const exiting = setOverlayMode(OVERLAY_MODE_CARD, 'https://zoom.example/backgrounds/blue.png');
    applyOverlay('https://zoom.example/backgrounds/blue.png');
    await exiting;

    expect(sdkMock.shareApp).toHaveBeenCalledWith({ action: 'stop' });
    expect(isAppShareActive()).toBe(false);
  });

  it('does not stop a share the client already ended', async () => {
    const { initializeZoomSdk, setOverlayMode, setAppShare, handleShareApp, OVERLAY_MODE_STAGE, OVERLAY_MODE_CARD } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    await setOverlayMode(OVERLAY_MODE_STAGE, null);
    await setAppShare(true);

    // onShareApp reports a stop from Zoom's own toolbar, so the flag is
    // trustworthy now and a redundant stop is not needed to cover for it.
    handleShareApp('stop');
    sdkMock.shareApp.mockClear();

    await setOverlayMode(OVERLAY_MODE_CARD, null);

    expect(sdkMock.shareApp).not.toHaveBeenCalled();
  });
});

describe('entering a stage mode leaves the camera untouched', () => {
  beforeEach(() => {
    stubCanvas();
    sdkMock.config.mockResolvedValue({});
    sdkMock.deleteVideoFilter.mockResolvedValue({});
    sdkMock.setVideoFilter.mockResolvedValue({});
    sdkMock.removeVirtualBackground.mockResolvedValue({});
    sdkMock.setVirtualBackground.mockResolvedValue({});
    sdkMock.shareApp.mockResolvedValue({});
    sdkMock.appPopout.mockResolvedValue({});
  });

  it('clears the virtual background when switching from camera mode to the stage', async () => {
    const { initializeZoomSdk, setOverlayMode, OVERLAY_MODE_CAMERA, OVERLAY_MODE_STAGE } = await loadModule();
    await initializeZoomSdk();
    stubImage();
    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    sdkMock.removeVirtualBackground.mockClear();

    await setOverlayMode(OVERLAY_MODE_STAGE, null);

    // Otherwise the color stays behind the user's face while the stage is shared.
    expect(sdkMock.removeVirtualBackground).toHaveBeenCalled();
  });

  it('touches neither pipeline when nothing of ours is applied', async () => {
    const { initializeZoomSdk, setOverlayMode, OVERLAY_MODE_STAGE } = await loadModule();
    await initializeZoomSdk();
    stubImage();
    // Card mode from the start and no speech yet, so nothing was ever pushed.
    await setOverlayMode(OVERLAY_MODE_STAGE, null);

    // Neither removal is free. The background one raises a confirmation dialog
    // every single time. deleteVideoFilter looked free, but Zoom documents it as
    // deleting filters set by other apps and setting the user's Video Filters
    // setting to None — so calling it on the way to the stage turned off a
    // filter the organizer had chosen for themselves.
    expect(sdkMock.deleteVideoFilter).not.toHaveBeenCalled();
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
  });

  it('takes down the card mode filter it did apply', async () => {
    const { initializeZoomSdk, applyOverlay, setOverlayMode, OVERLAY_MODE_STAGE } = await loadModule();
    await initializeZoomSdk();
    stubImage();
    await applyOverlay('https://zoom.example/backgrounds/blue.png');

    await setOverlayMode(OVERLAY_MODE_STAGE, null);

    expect(sdkMock.deleteVideoFilter).toHaveBeenCalled();
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
  });

  it('stops prompting once the virtual background has been removed', async () => {
    const { initializeZoomSdk, setOverlayMode, OVERLAY_MODE_CAMERA, OVERLAY_MODE_STAGE, OVERLAY_MODE_CARD } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    await setOverlayMode(OVERLAY_MODE_STAGE, null);
    expect(sdkMock.removeVirtualBackground).toHaveBeenCalledTimes(1);
    sdkMock.removeVirtualBackground.mockClear();

    // Returning to the stage must not re-prompt: it is already gone.
    await setOverlayMode(OVERLAY_MODE_CARD, null);
    await setOverlayMode(OVERLAY_MODE_STAGE, null);

    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
  });

  it('still clears the camera when a newer overlay push supersedes the switch', async () => {
    const { initializeZoomSdk, setOverlayMode, applyOverlay, OVERLAY_MODE_CAMERA, OVERLAY_MODE_STAGE } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    sdkMock.removeVirtualBackground.mockClear();

    const switching = setOverlayMode(OVERLAY_MODE_STAGE, null);
    applyOverlay('https://zoom.example/backgrounds/red.png');
    await switching;

    expect(sdkMock.removeVirtualBackground).toHaveBeenCalled();
  });

  it('carries on when the client reports there was nothing to clear', async () => {
    const { initializeZoomSdk, setOverlayMode, getOverlayMode, OVERLAY_MODE_STAGE } = await loadModule();
    await initializeZoomSdk();
    stubImage();
    // 10195: no overlay exists to remove. Expected, not a reason to abort.
    sdkMock.deleteVideoFilter.mockRejectedValueOnce(Object.assign(new Error('none'), { code: 10195 }));
    sdkMock.removeVirtualBackground.mockRejectedValueOnce(Object.assign(new Error('none'), { code: 10195 }));

    await setOverlayMode(OVERLAY_MODE_STAGE, null);

    expect(getOverlayMode()).toBe(OVERLAY_MODE_STAGE);
  });
});

describe('the debug panel reports on every API the app uses', () => {
  it('covers every zoomSdk call in the module', async () => {
    const called = new Set([
      ...[...zoomSdkSource.matchAll(/zoomSdk\.([a-zA-Z]+)\s*(?:\(|\?\.\()/g)].map(([, name]) => name),
      // Reached by name through callSdkApi rather than as a property, because the
      // npm SDK defines no wrapper for them. Invisible to the pattern above, and
      // just as much a call the debug panel has to report on.
      ...[...zoomSdkSource.matchAll(/callSdkApi\(\s*'([a-zA-Z]+)'/g)].map(([, name]) => name),
    ]);
    const { USED_SDK_APIS } = await loadModule();
    const declared = new Set(USED_SDK_APIS.map((api) => api.name));

    // A method called but not declared is one the panel stays silent about, so a
    // client missing it reads as all-green. Add it to USED_SDK_APIS.
    expect([...called].filter((name) => !declared.has(name))).toEqual([]);
    // And the reverse, so the list does not accumulate APIs we stopped calling.
    expect([...declared].filter((name) => !called.has(name))).toEqual([]);
  });

  // Grantable in the Marketplace, absent from the npm typings — checked against
  // @zoom/appssdk 0.16.36, 0.16.40, 0.16.41 (latest) and the CDN bundle in
  // August 2026. Requesting them is what makes the grant arrive on a client that
  // has them, so the app asks ahead of the SDK on purpose; config() lists any
  // refusal in unsupportedApis and isApiAvailable keeps every call site honest.
  // Delete an entry once the typings catch up — the assertion below covers it
  // again from that moment.
  const AHEAD_OF_SDK_CAPABILITIES = [
    'getCurrentVirtualBackground',
    'getVirtualBackgrounds',
    'getVirtualBackgroundData',
  ];

  it('requests capabilities the SDK actually defines', async () => {
    // A capability is the exact API or event name. "videoFilter" and
    // "virtualBackground" look like they cover a family of calls but are not
    // capabilities at all, so requesting them granted nothing — and
    // removeVirtualBackground, never requested, came back refused.
    const typings = await import('@zoom/appssdk/dist/sdk.d.ts?raw').then((m) => m.default);
    const known = new Set(
      typings
        .match(/declare type Apis = ([^;]+);/)[1]
        .split('|')
        .map((name) => name.trim().replace(/'/g, ''))
    );
    const { USED_SDK_APIS } = await loadModule();

    const requested = USED_SDK_APIS
      .map((api) => api.capability)
      .filter(Boolean)
      .filter((name) => !AHEAD_OF_SDK_CAPABILITIES.includes(name));
    expect(requested.filter((name) => !known.has(name))).toEqual([]);
    // Guard the allowance itself: an entry that the SDK has since defined is
    // stale and should go back under the assertion above.
    expect(AHEAD_OF_SDK_CAPABILITIES.filter((name) => known.has(name))).toEqual([]);
    // And the method we call has to be the one we asked for.
    USED_SDK_APIS.filter((api) => api.capability).forEach((api) => {
      expect(api.capability).toBe(api.name);
    });
  });

  it('reports what a bare-bones client is missing, with a reason', async () => {
    const { getMissingSdkApis, USED_SDK_APIS } = await loadModule();
    // Nothing configured yet: every API reads as missing, each with its purpose.
    const missing = getMissingSdkApis();
    expect(missing.length).toBeGreaterThan(0);
    missing.forEach((api) => {
      expect(api.purpose).toBeTruthy();
      expect(typeof api.required).toBe('boolean');
    });
    expect(missing.length).toBeLessThanOrEqual(USED_SDK_APIS.length);
  });

  it('lists nothing once the client offers everything', async () => {
    const { getMissingSdkApis, USED_SDK_APIS } = await loadModule();
    // Added for this test only: sdkMock is shared, and leaving methods on it
    // would quietly change what every later test's client appears to support.
    const added = USED_SDK_APIS.map((api) => api.name).filter(
      (name) => typeof sdkMock[name] !== 'function'
    );
    added.forEach((name) => { sdkMock[name] = vi.fn(); });

    try {
      expect(getMissingSdkApis()).toEqual([]);
    } finally {
      added.forEach((name) => { delete sdkMock[name]; });
    }
  });
});

describe('the client owns the background, so our record of it goes stale', () => {
  beforeEach(() => {
    stubCanvas();
    sdkMock.config.mockResolvedValue({});
    sdkMock.deleteVideoFilter.mockResolvedValue({});
    sdkMock.setVideoFilter.mockResolvedValue({});
    sdkMock.removeVirtualBackground.mockResolvedValue({});
    sdkMock.setVirtualBackground.mockResolvedValue({});
  });

  it('re-applies the branded background after the user swaps it in Zoom', async () => {
    const { initializeZoomSdk, setOverlayMode, applyOverlay, OVERLAY_MODE_CAMERA } = await loadModule();
    await initializeZoomSdk();
    stubImage();
    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    expect(sdkMock.setVirtualBackground).toHaveBeenCalled();
    sdkMock.setVirtualBackground.mockClear();

    // The organizer opens Zoom's own Background & Effects panel and picks
    // something else, or clears it. Nothing reports that to the app, so our
    // record still claims green is up — and skipping the push on the strength of
    // that record leaves the branded image gone for the rest of the meeting.
    await applyOverlay('https://zoom.example/backgrounds/green.png');

    expect(sdkMock.setVirtualBackground).toHaveBeenCalled();
  });

  it('forgets what it believed once the app is brought back to the front', async () => {
    const { initializeZoomSdk, applyOverlay, isOverlayActive, handleAppVisibilityChange } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    await applyOverlay('https://zoom.example/backgrounds/blue.png');
    expect(isOverlayActive()).toBe(true);
    sdkMock.setVideoFilter.mockClear();

    // Away and back: time enough to have changed anything in Zoom's own settings.
    handleAppVisibilityChange({ visible: false });
    handleAppVisibilityChange({ visible: true });

    await applyOverlay('https://zoom.example/backgrounds/blue.png');
    expect(sdkMock.setVideoFilter).toHaveBeenCalled();
  });

  it('knows a background of ours is up even after the webview was re-created', async () => {
    // Camera mode, branded background applied, then the organizer closes and
    // reopens the app panel. Zoom re-creates the webview, so the in-memory record
    // is gone while the background is still on their face. Callers ask
    // isOverlayActive() before paying for a removal dialog, so a false here is
    // what left the branded image up whether or not the timer was running.
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    const { initializeZoomSdk, setOverlayMode, isOverlayActive, removeOverlay, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    await setOverlayMode(OVERLAY_MODE_CAMERA, null);

    expect(isOverlayActive()).toBe(true);

    await removeOverlay();
    expect(sdkMock.removeVirtualBackground).toHaveBeenCalled();
    expect(isOverlayActive()).toBe(false);
  });

  it('stops believing in a background the user has already cleared themselves', async () => {
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    const { initializeZoomSdk, setOverlayMode, isOverlayActive, removeOverlay, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    await setOverlayMode(OVERLAY_MODE_CAMERA, null);
    // 10195: there was nothing to remove, because they cleared it in Zoom.
    sdkMock.removeVirtualBackground.mockRejectedValueOnce(
      Object.assign(new Error('none'), { code: 10195 })
    );

    await removeOverlay();

    // isOverlayActive is the gate callers check before paying for a removal.
    // Left true, every idle moment from here on would ask Zoom to remove a
    // background that is not there, prompting the organizer each time.
    expect(isOverlayActive()).toBe(false);
  });

  it('still collapses the duplicate push two call sites make for one change', async () => {
    const { initializeZoomSdk, applyOverlay } = await loadModule();
    await initializeZoomSdk();
    stubImage();

    // TimerContext and LiveTab both react to the same status change. The queue
    // drops the superseded request, so this must stay one push.
    await Promise.all([
      applyOverlay('https://zoom.example/backgrounds/red.png'),
      applyOverlay('https://zoom.example/backgrounds/red.png'),
    ]);

    expect(sdkMock.setVideoFilter).toHaveBeenCalledTimes(1);
  });
});

describe('clearing the video on request', () => {
  beforeEach(() => {
    stubCanvas();
    sdkMock.config.mockResolvedValue({});
    sdkMock.deleteVideoFilter.mockResolvedValue({});
    sdkMock.setVideoFilter.mockResolvedValue({});
    sdkMock.removeVirtualBackground.mockResolvedValue({});
    sdkMock.setVirtualBackground.mockResolvedValue({});
  });

  it('removes only the pipeline that is actually holding our card', async () => {
    const { initializeZoomSdk, applyOverlay, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();
    stubImage();
    // Card mode: a filter of ours, and no background at any point.
    await applyOverlay('https://zoom.example/backgrounds/blue.png');

    const result = await clearVideoPipelines();

    expect(sdkMock.deleteVideoFilter).toHaveBeenCalled();
    // Asking to remove a background that was never applied costs the user a
    // confirmation dialog and then fails.
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, declined: false, ungranted: [], lostBackground: false });
  });

  it('touches neither pipeline when the video is already the user\'s own', async () => {
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();

    const result = await clearVideoPipelines();

    // Pressing the eraser on an untouched video must be a no-op, not a pair of
    // removals aimed at empty pipelines — deleteVideoFilter would take the
    // organizer's own filter down with it.
    expect(sdkMock.deleteVideoFilter).not.toHaveBeenCalled();
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, declined: false, ungranted: [], lostBackground: false });
  });

  it('does not ask about a virtual background in camera mode when none is ours', async () => {
    const { initializeZoomSdk, setOverlayMode, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    await setOverlayMode(OVERLAY_MODE_CAMERA, null);
    sdkMock.removeVirtualBackground.mockClear();

    const result = await clearVideoPipelines();

    // Being in camera mode is not evidence that a background is applied. Zoom
    // offers no way to ask, so the record is all there is — and asking anyway
    // puts a "remove your virtual background?" dialog in front of someone who
    // does not have one.
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, declined: false, ungranted: [], lostBackground: false });
  });

  it('reports success when a pipeline we never touched refuses to clear', async () => {
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();
    // Whatever the client calls it, "nothing was there" is the expected answer,
    // not a failure the organizer should see a red toast about.
    sdkMock.deleteVideoFilter.mockRejectedValueOnce(
      Object.assign(new Error('no filter'), { code: 99999 })
    );

    expect(await clearVideoPipelines()).toEqual({ ok: true, declined: false, ungranted: [], lostBackground: false });
  });

  it('reports failure when something we did apply will not come off', async () => {
    const { initializeZoomSdk, applyOverlay, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();
    stubImage();
    await applyOverlay('https://zoom.example/backgrounds/green.png');
    sdkMock.deleteVideoFilter.mockRejectedValueOnce(
      Object.assign(new Error('busy'), { code: 99999 })
    );

    expect(await clearVideoPipelines()).toEqual({ ok: false, declined: false, ungranted: [], lostBackground: false });
  });

  it('removes a background applied in camera mode, and only asks once', async () => {
    const { initializeZoomSdk, setOverlayMode, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    sdkMock.removeVirtualBackground.mockClear();

    expect(await clearVideoPipelines()).toEqual({ ok: true, declined: false, ungranted: [], lostBackground: false });
    expect(sdkMock.removeVirtualBackground).toHaveBeenCalledTimes(1);

    // Already gone: clearing again must not re-prompt.
    sdkMock.removeVirtualBackground.mockClear();
    await clearVideoPipelines();
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
  });

  it('reports a declined confirmation as declined, not as a failure', async () => {
    const { initializeZoomSdk, setOverlayMode, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    // 10017: the user dismissed Zoom's "remove background?" dialog.
    sdkMock.removeVirtualBackground.mockRejectedValueOnce(
      Object.assign(new Error('declined'), { code: 10017 })
    );

    expect(await clearVideoPipelines()).toEqual({ ok: true, declined: true, ungranted: [], lostBackground: false });

    // Still up, so a second press must try again rather than assume it is gone.
    sdkMock.removeVirtualBackground.mockClear();
    await clearVideoPipelines();
    expect(sdkMock.removeVirtualBackground).toHaveBeenCalled();
  });

  it('still finds a background left behind by an earlier session', async () => {
    // Zoom reloads the webview whenever the panel is reopened, which is exactly
    // when an organizer reaches for this button. An in-memory flag would be false
    // here and the stuck background would survive the clear.
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();

    expect(await clearVideoPipelines()).toEqual({ ok: true, declined: false, ungranted: [], lostBackground: false });
    expect(sdkMock.removeVirtualBackground).toHaveBeenCalled();
    expect(localStorage.getItem('toastmaster_zoom_virtual_background_applied')).toBeNull();
  });

  it('still finds a filter left behind by an earlier session', async () => {
    // Same reload, the other pipeline. Reading activeOverlay for this made a
    // failed delete look like "there was nothing there", so the button reported
    // success over a card that was still on the tile.
    localStorage.setItem('toastmaster_zoom_video_filter_applied', 'true');
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();
    sdkMock.deleteVideoFilter.mockRejectedValueOnce(
      Object.assign(new Error('busy'), { code: 99999 })
    );

    expect(await clearVideoPipelines()).toEqual({ ok: false, declined: false, ungranted: [], lostBackground: false });
    // Still up, so the record must survive for the next attempt.
    expect(localStorage.getItem('toastmaster_zoom_video_filter_applied')).toBe('true');
  });

  it('names a pipeline the client refuses to let the app touch', async () => {
    // config() resolves even when a capability is refused; the refusal arrives
    // in unsupportedApis. Calling the API anyway rejects at the bridge, which
    // read as an ordinary failure and sent the organizer to check settings that
    // were never the problem.
    sdkMock.config.mockResolvedValue({ unsupportedApis: ['removeVirtualBackground'] });
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();

    expect(await clearVideoPipelines()).toEqual({
      ok: true,
      declined: false,
      ungranted: ['virtual background'],
      lostBackground: false,
    });
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
    // Nothing was removed, so the record must not claim otherwise.
    expect(localStorage.getItem('toastmaster_zoom_virtual_background_applied')).toBe('true');
  });

  it('says nothing about a refused pipeline that was holding nothing', async () => {
    sdkMock.config.mockResolvedValue({ unsupportedApis: ['deleteVideoFilter', 'setVideoFilter'] });
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();

    // No filter of ours is up, so a missing removal API costs the organizer
    // nothing and is not worth a red toast.
    expect(await clearVideoPipelines()).toEqual({ ok: true, declined: false, ungranted: [], lostBackground: false });
  });

  it('falls back to setVideoFilter(null) when only the deleter is refused', async () => {
    sdkMock.config.mockResolvedValue({ unsupportedApis: ['deleteVideoFilter'] });
    localStorage.setItem('toastmaster_zoom_video_filter_applied', 'true');
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();

    expect(await clearVideoPipelines()).toEqual({ ok: true, declined: false, ungranted: [], lostBackground: false });
    expect(sdkMock.deleteVideoFilter).not.toHaveBeenCalled();
    expect(sdkMock.setVideoFilter).toHaveBeenCalledWith({ fileUrl: null });
  });
});

describe('capability reporting', () => {
  beforeEach(() => {
    stubCanvas();
    sdkMock.config.mockResolvedValue({});
  });

  it('reports a refused API as missing, not as present', async () => {
    // The npm SDK defines every documented method on its prototype whether or
    // not the client granted it, so a typeof check reported a limited client as
    // all-green. unsupportedApis is the only truthful signal.
    sdkMock.config.mockResolvedValue({ unsupportedApis: ['setVirtualBackground'] });
    const { initializeZoomSdk, getMissingSdkApis, isApiAvailable } = await loadModule();
    await initializeZoomSdk();

    expect(isApiAvailable('setVirtualBackground')).toBe(false);
    expect(isApiAvailable('setVideoFilter')).toBe(true);
    expect(getMissingSdkApis().map((api) => api.name)).toContain('setVirtualBackground');
  });
});

describe('putting the user back on their own background', () => {
  // getCurrentVirtualBackground is grantable in the Marketplace but absent from
  // the shipped SDK, so it is added to the mock here rather than to the shared
  // one — the module reaches it through isApiAvailable either way, and the
  // shared mock stays an honest picture of what a real client offers today.
  function withBackgroundReader(current) {
    sdkMock.getCurrentVirtualBackground = vi.fn().mockResolvedValue(current);
    return sdkMock.getCurrentVirtualBackground;
  }

  beforeEach(() => {
    stubCanvas();
    sdkMock.config.mockResolvedValue({});
    sdkMock.deleteVideoFilter.mockResolvedValue({});
    sdkMock.setVideoFilter.mockResolvedValue({});
    sdkMock.removeVirtualBackground.mockResolvedValue({});
    sdkMock.setVirtualBackground.mockResolvedValue({});
  });

  afterEach(() => {
    delete sdkMock.getCurrentVirtualBackground;
    delete sdkMock.getVirtualBackgrounds;
  });

  it('restores the blur the user arrived with instead of stripping them bare', async () => {
    const { initializeZoomSdk, setOverlayMode, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    const read = withBackgroundReader({ id: 'Blur' });

    // Snapshot happens on the first push, while their blur is still up.
    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    expect(read).toHaveBeenCalled();

    // Ours is up now, so the read reports something that is not their blur.
    read.mockResolvedValue({ id: 'timer-green' });
    const result = await clearVideoPipelines();

    expect(sdkMock.setVirtualBackground).toHaveBeenLastCalledWith({ blur: true });
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.lostBackground).toBe(false);
  });

  /** An ImageData-shaped payload, as getVirtualBackgroundData returns. */
  function fakePixels(width = 1920, height = 1080) {
    return { width, height, data: new Uint8ClampedArray(4) };
  }

  it('puts the user back on their own background image', async () => {
    // The report that prompted this: someone joins on a bookshelf, times a
    // speech, and the last color hands them back their bare office.
    const { initializeZoomSdk, setOverlayMode, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    const read = withBackgroundReader({ id: 'vb-77', name: 'bookshelf.png' });
    const pixels = fakePixels();
    sdkMock.callZoomApi.mockResolvedValue({ imageData: pixels });

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    read.mockResolvedValue({ id: 'timer-green' });
    const result = await clearVideoPipelines();

    // getVirtualBackgroundData turns the snapshotted id into pixels, which is the
    // only input setVirtualBackground accepts for an image.
    expect(sdkMock.callZoomApi).toHaveBeenCalledWith('getVirtualBackgroundData', { backgroundId: 'vb-77' }, expect.any(Number));
    expect(sdkMock.setVirtualBackground).toHaveBeenLastCalledWith({ imageData: pixels });
    // Removal is what used to strip them bare, and it is also the one call here
    // that costs a confirmation dialog.
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, lostBackground: false });
  });

  it('accepts a bare ImageData response, not only a wrapped one', async () => {
    // An ImageData has a `data` property of its own, so unwrapping by key order
    // would reach past the ImageData to its byte array and then reject that as
    // unusable — dropping the background for a response that was perfectly good.
    const { initializeZoomSdk, setOverlayMode, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    const read = withBackgroundReader({ id: 'vb-77', name: 'bookshelf.png' });
    const pixels = fakePixels();
    sdkMock.callZoomApi.mockResolvedValue(pixels);

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    read.mockResolvedValue({ id: 'timer-green' });
    const result = await clearVideoPipelines();

    expect(sdkMock.setVirtualBackground).toHaveBeenLastCalledWith({ imageData: pixels });
    expect(result).toMatchObject({ ok: true, lostBackground: false });
  });

  it('restores from the stored id after the webview reloads', async () => {
    // Zoom reloads the app whenever the panel is reopened, which drops the pixel
    // cache. The id is persisted precisely so the pixels can be fetched again.
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    localStorage.setItem(
      'toastmaster_zoom_previous_background',
      JSON.stringify({ type: 'image', id: 'vb-77', name: 'bookshelf.png' })
    );
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();
    withBackgroundReader({ id: 'timer-red' });
    const pixels = fakePixels();
    sdkMock.callZoomApi.mockResolvedValue({ imageData: pixels });

    const result = await clearVideoPipelines();

    expect(sdkMock.callZoomApi).toHaveBeenCalledWith('getVirtualBackgroundData', { backgroundId: 'vb-77' }, expect.any(Number));
    expect(sdkMock.setVirtualBackground).toHaveBeenLastCalledWith({ imageData: pixels });
    expect(result).toMatchObject({ ok: true, lostBackground: false });
  });

  it('removes and says so when Zoom will not hand the pixels over', async () => {
    // A stock background the client declines, or an id it no longer knows. The
    // color still has to come off, so removal stays the fallback — and the
    // organizer is told rather than left to notice on their own tile.
    const { initializeZoomSdk, setOverlayMode, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    const read = withBackgroundReader({ id: 'vb-77', name: 'beach.png' });
    sdkMock.callZoomApi.mockRejectedValue(new Error('not available'));

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    read.mockResolvedValue({ id: 'timer-green' });
    const result = await clearVideoPipelines();

    expect(sdkMock.removeVirtualBackground).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, lostBackground: true });
  });

  it('removes rather than restoring a response it cannot read as pixels', async () => {
    const { initializeZoomSdk, setOverlayMode, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    const read = withBackgroundReader({ id: 'vb-77', name: 'beach.png' });
    // Neither an ImageData nor anything wrapping one. Guessing here would push
    // rubbish onto the user's video.
    sdkMock.callZoomApi.mockResolvedValue({ status: 'ok' });

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    read.mockResolvedValue({ id: 'timer-green' });
    const result = await clearVideoPipelines();

    expect(sdkMock.setVirtualBackground).not.toHaveBeenCalledWith(
      expect.objectContaining({ imageData: expect.anything() })
    );
    expect(sdkMock.removeVirtualBackground).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, lostBackground: true });
  });

  /** How many times the pixels were asked for, across every id. */
  function pixelFetches() {
    return sdkMock.callZoomApi.mock.calls.filter(([api]) => api === 'getVirtualBackgroundData').length;
  }

  it('keeps the record so a later speech restores even after the read stops working', async () => {
    // The record used to be cleared once spent, on the grounds that the next
    // speech could always re-read it. It cannot: the read needs a getter not
    // every client grants, and one failure then dropped the organizer to a bare
    // camera for the rest of the meeting.
    const { initializeZoomSdk, setOverlayMode, applyOverlay, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    const read = withBackgroundReader({ id: 'vb-77', name: 'bookshelf.png' });
    const pixels = fakePixels();
    sdkMock.callZoomApi.mockResolvedValue({ imageData: pixels });

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    read.mockResolvedValue({ id: 'timer-green' });
    await clearVideoPipelines();
    expect(sdkMock.setVirtualBackground).toHaveBeenLastCalledWith({ imageData: pixels });

    // Second speaker, with the client no longer answering at all. Pushed through
    // applyOverlay rather than setOverlayMode, which returns early once the mode
    // is already camera and would leave this asserting on the first speech.
    read.mockRejectedValue(new Error('not supported'));
    sdkMock.setVirtualBackground.mockClear();
    await applyOverlay('https://zoom.example/backgrounds/red.png');
    const result = await clearVideoPipelines();

    expect(sdkMock.setVirtualBackground).toHaveBeenLastCalledWith({ imageData: pixels });
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, lostBackground: false });
  });

  it('does not re-fetch the pixels for a background that has not changed', async () => {
    // The organizer keeps one background all meeting, so the re-read before every
    // push finds the same one. Dropping the cache on each would ship megabytes
    // across the bridge once per speaker for no gain.
    const { initializeZoomSdk, setOverlayMode, applyOverlay, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    const bookshelf = { id: 'vb-77', name: 'bookshelf.png' };
    const read = withBackgroundReader(bookshelf);
    const pixels = fakePixels();
    sdkMock.callZoomApi.mockResolvedValue({ imageData: pixels });

    // The reader has to move with the video, or the second clear correctly
    // decides the background is already theirs and skips — which is what made an
    // earlier version of this test pass while proving nothing.
    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    read.mockResolvedValue({ id: 'timer-green' });
    await clearVideoPipelines();

    // Second speaker, back on the same bookshelf the restore just put up.
    read.mockResolvedValue(bookshelf);
    await applyOverlay('https://zoom.example/backgrounds/red.png');
    read.mockResolvedValue({ id: 'timer-red' });
    await clearVideoPipelines();

    // Both speeches genuinely restored, so the single fetch is a cache hit and
    // not a clear that quietly did nothing.
    expect(sdkMock.setVirtualBackground).toHaveBeenLastCalledWith({ imageData: pixels });
    expect(pixelFetches()).toBe(1);
  });

  it('re-fetches once the user picks a different background themselves', async () => {
    const { initializeZoomSdk, setOverlayMode, applyOverlay, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    const read = withBackgroundReader({ id: 'vb-77', name: 'bookshelf.png' });
    const kitchen = fakePixels(1280, 720);
    sdkMock.callZoomApi.mockResolvedValue({ imageData: fakePixels() });

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    read.mockResolvedValue({ id: 'timer-green' });
    await clearVideoPipelines();

    // They visited Background & Effects between speakers. Nothing reports that,
    // so the next snapshot is the only thing that can notice.
    read.mockResolvedValue({ id: 'vb-99', name: 'kitchen.png' });
    sdkMock.callZoomApi.mockResolvedValue({ imageData: kitchen });
    await applyOverlay('https://zoom.example/backgrounds/red.png');
    read.mockResolvedValue({ id: 'timer-red' });
    await clearVideoPipelines();

    // The kitchen goes back, not the cached bookshelf.
    expect(sdkMock.callZoomApi).toHaveBeenLastCalledWith('getVirtualBackgroundData', { backgroundId: 'vb-99' }, expect.any(Number));
    expect(sdkMock.setVirtualBackground).toHaveBeenLastCalledWith({ imageData: kitchen });
    expect(pixelFetches()).toBe(2);
  });

  it('restores an image on a client that granted the setter but not the remover', async () => {
    // The two capabilities are granted independently, and putting an image back
    // is a set. Gating it on the remover reported the pipeline ungranted and left
    // the last speech color on the tile.
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    localStorage.setItem(
      'toastmaster_zoom_previous_background',
      JSON.stringify({ type: 'image', id: 'vb-77', name: 'bookshelf.png' })
    );
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    sdkMock.config.mockResolvedValue({ unsupportedApis: ['removeVirtualBackground'] });
    await initializeZoomSdk();
    withBackgroundReader({ id: 'timer-red' });
    const pixels = fakePixels();
    sdkMock.callZoomApi.mockResolvedValue({ imageData: pixels });

    const result = await clearVideoPipelines();

    expect(sdkMock.setVirtualBackground).toHaveBeenCalledWith({ imageData: pixels });
    expect(result).toMatchObject({ ok: true, ungranted: [], lostBackground: false });
  });

  it('records a bare camera as theirs, so a later clear aims at bare rather than nothing', async () => {
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();
    withBackgroundReader({ id: 'None' });

    await clearVideoPipelines();

    expect(JSON.parse(localStorage.getItem('toastmaster_zoom_previous_background'))).toEqual({
      type: 'none',
    });
  });

  it('bounds the pixel fetch well under the SDK default, so FINISH cannot stall on it', async () => {
    // A client that takes the call and never answers is what an apiName it does
    // not recognise looks like from here. callZoomApi gives up on its own after
    // 10s, which would freeze the handover between pressing FINISH and the video
    // coming back, then remove anyway.
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    localStorage.setItem(
      'toastmaster_zoom_previous_background',
      JSON.stringify({ type: 'image', id: 'vb-77', name: 'bookshelf.png' })
    );
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();
    withBackgroundReader({ id: 'timer-red' });
    sdkMock.callZoomApi.mockResolvedValue({ imageData: fakePixels() });

    await clearVideoPipelines();

    const [, , timeout] = sdkMock.callZoomApi.mock.calls.find(
      ([api]) => api === 'getVirtualBackgroundData'
    );
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThan(10000);
  });

  /** Reject like a client that dislikes the payload, not the id. */
  function validationError() {
    return Object.assign(new Error('Validation error, please check API parameters.'), { code: -1 });
  }

  it('decodes the base64 JPEG a real client returns, not a bare ImageData', async () => {
    // What a 7.1.5 desktop client sends is { imageData: { data: "/9j/4AAQ…" } } —
    // a base64 JPEG, despite the field being called imageData. Reading it as the
    // ImageData that setVirtualBackground takes is what turned a call that had
    // genuinely succeeded into "returned no usable pixels".
    const { initializeZoomSdk, setOverlayMode, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    // 2560x1440 source, so the 1920x1080 ceiling is exercised: an ImageData that
    // large would pass setVirtualBackground's documented 15MB limit.
    stubImage(2560, 1440);
    const read = withBackgroundReader({
      currentBackground: { id: 'AD3E044A', name: 'San Francisco' },
      currentBackgroundSetting: 'background',
    });
    sdkMock.callZoomApi.mockResolvedValue({ imageData: { data: '/9j/4AAQSkZJRgABAQAASABIAAD' } });

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    read.mockResolvedValue({ currentBackground: { id: 'timer-green' }, currentBackgroundSetting: 'background' });
    const result = await clearVideoPipelines();

    const [applied] = sdkMock.setVirtualBackground.mock.lastCall;
    expect(applied.imageData).toMatchObject({ width: 1920, height: 1080 });
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, lostBackground: false });
  });

  it('does not shrink a restored background to the overlay ceiling', async () => {
    // The overlay path clamps to 640x360, which is right for a card overwritten
    // every second and wrong for handing someone their own background back.
    const { initializeZoomSdk, setOverlayMode, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage(1280, 720);
    const read = withBackgroundReader({
      currentBackground: { id: 'AD3E044A', name: 'San Francisco' },
      currentBackgroundSetting: 'background',
    });
    sdkMock.callZoomApi.mockResolvedValue({ imageData: { data: '/9j/4AAQSkZJRg' } });

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    read.mockResolvedValue({ currentBackground: { id: 'timer-green' }, currentBackgroundSetting: 'background' });
    await clearVideoPipelines();

    // Under the ceiling, so it comes back at its own size rather than upscaled.
    const [applied] = sdkMock.setVirtualBackground.mock.lastCall;
    expect(applied.imageData).toMatchObject({ width: 1280, height: 720 });
  });

  it('reads the id from the saved-list response, which names it differently', async () => {
    // getVirtualBackgrounds answers { backgrounds, currentBackgroundId,
    // currentBackgroundSetting } — no applied-background object at all. A client
    // granting only this getter used to read as "did not say".
    const { normalizeVirtualBackground } = await loadModule();

    expect(
      normalizeVirtualBackground({
        backgrounds: [
          { id: '732EE50D', name: 'Golden Gate' },
          { id: 'AD3E044A', name: 'San Francisco' },
        ],
        currentBackgroundId: 'AD3E044A',
        currentBackgroundSetting: 'background',
      })
    ).toEqual({ type: 'image', id: 'AD3E044A', name: 'San Francisco' });

    // 'background' is the client's word for "an image is up", and it must not be
    // mistaken for none or blur.
    expect(
      normalizeVirtualBackground({ currentBackgroundId: 'AD3E044A', currentBackgroundSetting: 'background' })
    ).toEqual({ type: 'image', id: 'AD3E044A' });
  });

  it('names the payload it sent when the client rejects it', async () => {
    // "Validation error, please check API parameters" with no record of what was
    // sent leaves nothing to act on. The log has to decompose the call.
    const { initializeZoomSdk, setLogCallback, setOverlayMode, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    const lines = [];
    setLogCallback((message) => lines.push(message));
    await initializeZoomSdk();
    stubImage();
    withBackgroundReader({
      currentBackground: { id: 'vb-77', name: 'San Francisco' },
      currentBackgroundSetting: 'image',
    });
    sdkMock.callZoomApi.mockRejectedValue(validationError());

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    await clearVideoPipelines();

    expect(lines.some((line) => line.includes('getVirtualBackgroundData({ id: "vb-77" }) failed'))).toBe(true);
  });

  it('tries other payload spellings before giving up', async () => {
    const { initializeZoomSdk, setOverlayMode, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    const read = withBackgroundReader({
      currentBackground: { id: 'vb-77', name: 'San Francisco' },
      currentBackgroundSetting: 'image',
    });
    const pixels = fakePixels();
    // This client wants virtualBackgroundId, not id.
    sdkMock.callZoomApi.mockImplementation((api, payload) => {
      if (api !== 'getVirtualBackgroundData') return Promise.resolve({});
      if (payload?.virtualBackgroundId === 'vb-77') return Promise.resolve({ imageData: pixels });
      return Promise.reject(validationError());
    });

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    read.mockResolvedValue({ currentBackground: { id: 'timer-green' }, currentBackgroundSetting: 'image' });
    const result = await clearVideoPipelines();

    expect(sdkMock.setVirtualBackground).toHaveBeenLastCalledWith({ imageData: pixels });
    expect(result).toMatchObject({ ok: true, lostBackground: false });
  });

  it('falls back to the id the saved list uses for the same background', async () => {
    // The docs say ids for getVirtualBackgroundData come from getVirtualBackgrounds,
    // not from getCurrentVirtualBackground. The two need not agree, and a stock
    // background is where they would not.
    const { initializeZoomSdk, setOverlayMode, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    const read = withBackgroundReader({
      currentBackground: { id: 'current-77', name: 'San Francisco' },
      currentBackgroundSetting: 'image',
    });
    const pixels = fakePixels();
    sdkMock.callZoomApi.mockImplementation((api, payload) => {
      if (api === 'getVirtualBackgrounds') {
        return Promise.resolve({
          virtualBackgrounds: [
            { id: 'list-99', name: 'San Francisco' },
            { id: 'list-11', name: 'Golden Gate' },
          ],
        });
      }
      if (payload?.backgroundId === 'list-99') return Promise.resolve({ imageData: pixels });
      return Promise.reject(validationError());
    });

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    read.mockResolvedValue({ currentBackground: { id: 'timer-green' }, currentBackgroundSetting: 'image' });
    const result = await clearVideoPipelines();

    expect(sdkMock.setVirtualBackground).toHaveBeenLastCalledWith({ imageData: pixels });
    // Only the entry that matches by name. Feeding every saved background to the
    // getter in turn would be a lot of calls to land on one the user never had up.
    expect(sdkMock.callZoomApi).not.toHaveBeenCalledWith(
      'getVirtualBackgroundData',
      { backgroundId: 'list-11' },
      expect.any(Number)
    );
    expect(result).toMatchObject({ ok: true, lostBackground: false });
  });

  it('does not repeat a failed run of calls while the organizer waits', async () => {
    // The prefetch at speech start has already established the answer. Repeating
    // it on the restore path stalls the handover to learn nothing new.
    const { initializeZoomSdk, setOverlayMode, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    const read = withBackgroundReader({
      currentBackground: { id: 'vb-77', name: 'San Francisco' },
      currentBackgroundSetting: 'image',
    });
    sdkMock.callZoomApi.mockRejectedValue(validationError());

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    const afterPrefetch = pixelFetches();
    expect(afterPrefetch).toBeGreaterThan(0);

    read.mockResolvedValue({ currentBackground: { id: 'timer-green' }, currentBackgroundSetting: 'image' });
    const result = await clearVideoPipelines();

    expect(pixelFetches()).toBe(afterPrefetch);
    // Still removes, so the speech color cannot outlive the speech.
    expect(sdkMock.removeVirtualBackground).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, lostBackground: true });
  });

  it('reaches the getters that have no wrapper method through the bridge', async () => {
    // The bug this whole path had: isApiAvailable demanded typeof
    // zoomSdk[name] === 'function', which no client can satisfy for an API the
    // npm SDK never defines. Every read below was dead code as a result.
    const { initializeZoomSdk, isApiAvailable } = await loadModule();
    await initializeZoomSdk();

    expect(typeof sdkMock.getVirtualBackgroundData).not.toBe('function');
    expect(isApiAvailable('getVirtualBackgroundData')).toBe(true);
    expect(isApiAvailable('getVirtualBackgrounds')).toBe(true);
  });

  it('treats a refused getter as refused even though it has no wrapper', async () => {
    const { initializeZoomSdk, isApiAvailable } = await loadModule();
    sdkMock.config.mockResolvedValue({ unsupportedApis: ['getVirtualBackgroundData'] });
    await initializeZoomSdk();

    expect(isApiAvailable('getVirtualBackgroundData')).toBe(false);
    expect(isApiAvailable('getVirtualBackgrounds')).toBe(true);
  });

  it('leaves a background that is no longer ours completely alone', async () => {
    const { initializeZoomSdk, setOverlayMode, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    const read = withBackgroundReader({ id: 'vb-77', name: 'beach.png' });

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    sdkMock.removeVirtualBackground.mockClear();
    sdkMock.setVirtualBackground.mockClear();
    // The user went to Background & Effects and put their own back. Nothing
    // reports that, so the record still says one of ours is up.
    read.mockResolvedValue({ id: 'vb-77', name: 'beach.png' });

    const result = await clearVideoPipelines();

    // Removing here would raise a confirmation dialog over a video that is
    // already exactly how they want it.
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
    expect(sdkMock.setVirtualBackground).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, declined: false });
  });

  it('leaves a bare camera alone rather than removing nothing', async () => {
    // Set before the module loads: it reads the record at import time, so a
    // later write would leave the flag false and the test would pass for the
    // wrong reason.
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();
    withBackgroundReader({ id: 'None' });

    const result = await clearVideoPipelines();

    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true });
    expect(localStorage.getItem('toastmaster_zoom_virtual_background_applied')).toBeNull();
  });

  it('falls back to the old removal when the client cannot report the background', async () => {
    // No reader granted: exactly today's clients. The record stays in charge.
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();

    expect(await clearVideoPipelines()).toMatchObject({ ok: true });
    expect(sdkMock.removeVirtualBackground).toHaveBeenCalled();
  });

  it('names the nested keys of a shape it cannot read, without dumping the pixels', async () => {
    // Top-level keys alone cost a round-trip: they said "currentBackground,
    // currentBackgroundSetting" without saying what was inside, which is the part
    // that fixes the parser. An ImageData's byte array must stay out of it — the
    // panel would be unreadable and the real answer buried.
    const { initializeZoomSdk, setLogCallback, setOverlayMode, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    const lines = [];
    setLogCallback((message) => lines.push(message));
    await initializeZoomSdk();
    stubImage();
    withBackgroundReader({
      unexpected: { deeper: 'value' },
      pixels: { width: 4, height: 4, data: new Uint8ClampedArray(64) },
    });

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    await clearVideoPipelines();

    const complaint = lines.find((line) => line.includes('does not recognise'));
    expect(complaint).toContain('unexpected: { deeper: "value" }');
    expect(complaint).toContain('Uint8ClampedArray(64)');
    expect(complaint).not.toMatch(/0, 0, 0/);
  });

  it('reads the shape a real client actually sends', async () => {
    // Observed on a 5.17 desktop client, from the debug log of a restore that
    // failed: getCurrentVirtualBackground answers with two fields, not one. The
    // parser read only the object and called a perfectly good answer
    // unrecognisable, so the clear removed the organizer's background instead of
    // putting it back.
    const { normalizeVirtualBackground } = await loadModule();

    expect(
      normalizeVirtualBackground({
        currentBackground: { id: 'vb-77', name: 'bookshelf.png' },
        currentBackgroundSetting: 'image',
      })
    ).toEqual({ type: 'image', id: 'vb-77', name: 'bookshelf.png' });

    // The setting is the only field that separates "none" from "did not say".
    expect(
      normalizeVirtualBackground({ currentBackground: null, currentBackgroundSetting: 'none' })
    ).toEqual({ type: 'none' });
    expect(
      normalizeVirtualBackground({ currentBackground: null, currentBackgroundSetting: 'blur' })
    ).toEqual({ type: 'blur' });
    // Case and padding are the client's business, not ours.
    expect(
      normalizeVirtualBackground({ currentBackground: null, currentBackgroundSetting: ' Blur ' })
    ).toEqual({ type: 'blur' });
    // It wins over an image left in the object, since it says what is applied.
    expect(
      normalizeVirtualBackground({
        currentBackground: { id: 'vb-77', name: 'bookshelf.png' },
        currentBackgroundSetting: 'None',
      })
    ).toEqual({ type: 'none' });
  });

  it('restores end to end from the real client shape', async () => {
    const { initializeZoomSdk, setOverlayMode, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    const read = withBackgroundReader({
      currentBackground: { id: 'vb-77', name: 'bookshelf.png' },
      currentBackgroundSetting: 'image',
    });
    const pixels = fakePixels();
    sdkMock.callZoomApi.mockResolvedValue({ imageData: pixels });

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    read.mockResolvedValue({
      currentBackground: { id: 'timer-green' },
      currentBackgroundSetting: 'image',
    });
    const result = await clearVideoPipelines();

    expect(sdkMock.setVirtualBackground).toHaveBeenLastCalledWith({ imageData: pixels });
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, lostBackground: false });
  });

  it('gives up rather than guessing at a response it does not recognise', async () => {
    // The response shape cannot be pinned down while the API is absent from the
    // SDK, so anything unfamiliar has to mean "the client did not say" — never
    // an answer that decides whether the user gets a dialog.
    const { normalizeVirtualBackground } = await loadModule();

    expect(normalizeVirtualBackground({ id: 'None' })).toEqual({ type: 'none' });
    expect(normalizeVirtualBackground({ type: 'blur' })).toEqual({ type: 'blur' });
    expect(normalizeVirtualBackground({ currentVirtualBackground: { id: 'Blur' } })).toEqual({ type: 'blur' });
    expect(normalizeVirtualBackground({ id: 'vb-1', name: 'beach.png' })).toEqual({
      type: 'image', id: 'vb-1', name: 'beach.png',
    });
    expect(normalizeVirtualBackground(undefined)).toBeNull();
    expect(normalizeVirtualBackground({})).toBeNull();
    expect(normalizeVirtualBackground({ somethingElse: 42 })).toBeNull();
  });
});

// The organizer's own background is a looping video. Zoom will hand one back
// through no API at all — setVirtualBackground takes imageData, a fileUrl or
// blur, and none of those is a video — so replacing it means losing it. The
// reported bug: a speech ended and their beach was gone, replaced by None,
// recoverable only from Zoom's own Background & Effects panel.
describe('an organizer whose own background is a video', () => {
  function withBackgroundReader(current) {
    sdkMock.getCurrentVirtualBackground = vi.fn().mockResolvedValue(current);
    return sdkMock.getCurrentVirtualBackground;
  }

  beforeEach(() => {
    sdkMock.config.mockResolvedValue({});
    sdkMock.setVideoFilter.mockResolvedValue({});
    sdkMock.deleteVideoFilter.mockResolvedValue({});
    sdkMock.setVirtualBackground.mockResolvedValue({});
    sdkMock.removeVirtualBackground.mockResolvedValue({});
    sdkMock.setVirtualForeground.mockResolvedValue({});
    sdkMock.removeVirtualForeground.mockResolvedValue({});
  });

  afterEach(() => {
    delete sdkMock.getCurrentVirtualBackground;
    delete sdkMock.getVirtualBackgrounds;
  });

  it('recognises a video background rather than calling it an image', async () => {
    const { normalizeVirtualBackground } = await loadModule();

    // However the client says it: an explicit setting...
    expect(
      normalizeVirtualBackground({
        currentBackground: { id: 'vb-9', name: 'Waves' },
        currentBackgroundSetting: 'video',
      })
    ).toEqual({ type: 'video', id: 'vb-9', name: 'Waves' });
    // ...a flag on the entry...
    expect(
      normalizeVirtualBackground({
        currentBackground: { id: 'vb-9', name: 'Waves', isVideo: true },
        currentBackgroundSetting: 'background',
      })
    ).toEqual({ type: 'video', id: 'vb-9', name: 'Waves' });
    // ...or nothing but the file name, which is all some clients give.
    expect(
      normalizeVirtualBackground({
        currentBackground: { id: 'vb-9', name: 'beach-loop.mp4' },
        currentBackgroundSetting: 'background',
      })
    ).toEqual({ type: 'video', id: 'vb-9', name: 'beach-loop.mp4' });

    // A still is still a still, and must keep going down the replace-and-restore
    // path that every other organizer gets.
    expect(
      normalizeVirtualBackground({
        currentBackground: { id: 'vb-9', name: 'beach.png' },
        currentBackgroundSetting: 'background',
      })
    ).toEqual({ type: 'image', id: 'vb-9', name: 'beach.png' });
  });

  it('never replaces it, banding the card color over the video instead', async () => {
    const { operations } = stubCanvas();
    const { initializeZoomSdk, setOverlayMode, applyOverlay, OVERLAY_MODE_CAMERA } = await loadModule();
    await initializeZoomSdk();
    stubImage();
    withBackgroundReader({
      currentBackground: { id: 'vb-9', name: 'beach-loop.mp4' },
      currentBackgroundSetting: 'video',
    });

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    await applyOverlay('https://zoom.example/backgrounds/red.png');

    // Not once, across two colors. This is the whole fix: what is never taken
    // away cannot fail to come back.
    expect(sdkMock.setVirtualBackground).not.toHaveBeenCalled();
    expect(sdkMock.setVirtualForeground).toHaveBeenCalledWith({
      imageData: expect.anything(),
      persistence: 'meeting',
    });
    expect(drewBand(operations)).toBe(true);
  });

  it('leaves the video playing when the speech ends', async () => {
    // The report, exactly: finish or clear, and the beach was replaced by None.
    const { initializeZoomSdk, setOverlayMode, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubCanvas();
    stubImage();
    withBackgroundReader({
      currentBackground: { id: 'vb-9', name: 'beach-loop.mp4' },
      currentBackgroundSetting: 'video',
    });

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    const result = await clearVideoPipelines();

    // Only our own band comes off. The background is never addressed, so it
    // cannot be reset to None — and the organizer is never asked to confirm a
    // removal either, since that dialog belongs to removeVirtualBackground.
    expect(sdkMock.removeVirtualForeground).toHaveBeenCalled();
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, lostBackground: false });
  });

  it('keeps the band up while the organizer has the clock hidden', async () => {
    // Over a video the band is the entire timing signal, where normally the
    // card behind them is. Hiding the readout must not take the color with it.
    const { operations } = stubCanvas();
    const { initializeZoomSdk, setOverlayMode, setOverlayTimeLabel, setOverlayTimeVisible, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    withBackgroundReader({
      currentBackground: { id: 'vb-9', name: 'beach-loop.mp4' },
      currentBackgroundSetting: 'video',
    });
    setOverlayTimeLabel('00:05');
    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');

    setOverlayTimeVisible(false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sdkMock.removeVirtualForeground).not.toHaveBeenCalled();
    expect(drewBand(operations)).toBe(true);
  });

  it('still finds the band after a webview reload, so the eraser can clear it', async () => {
    // Over a video there is no card and no filter: the foreground flag is the
    // only trace of us, and Zoom wipes the in-memory record on every reopen.
    localStorage.setItem('toastmaster_zoom_virtual_foreground_applied', 'true');
    const { initializeZoomSdk, isOverlayActive } = await loadModule();
    await initializeZoomSdk();

    expect(isOverlayActive()).toBe(true);
  });

  it('declines the setter and says why for a video an older build displaced', async () => {
    // Reachable only from a record written before camera mode stopped replacing
    // one. There is no call that puts a video back, so the branded background
    // still has to come off — but the organizer is told, not left to notice.
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    localStorage.setItem(
      'toastmaster_zoom_previous_background',
      JSON.stringify({ type: 'video', id: 'vb-9', name: 'beach-loop.mp4' })
    );
    const { initializeZoomSdk, setLogCallback, clearVideoPipelines } = await loadModule();
    const lines = [];
    setLogCallback((message) => lines.push(message));
    await initializeZoomSdk();
    stubCanvas();
    withBackgroundReader({ id: 'timer-green' });

    const result = await clearVideoPipelines();

    // Never handed to the setter: every spelling of it would fail. And never
    // even asked for as pixels — a video has none this API can return.
    expect(sdkMock.setVirtualBackground).not.toHaveBeenCalled();
    expect(sdkMock.callZoomApi).not.toHaveBeenCalledWith(
      'getVirtualBackgroundData',
      expect.anything(),
      expect.anything()
    );
    expect(sdkMock.removeVirtualBackground).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, lostBackground: true });
    expect(lines.some((line) => line.includes('video background'))).toBe(true);
  });

  it('still replaces a still image outright, which is what the room expects', async () => {
    // The guard on the fix. Only a video takes the band; every other organizer
    // keeps the full timing card behind their face, and keeps the restore.
    const { initializeZoomSdk, setOverlayMode, OVERLAY_MODE_CAMERA } = await loadModule();
    await initializeZoomSdk();
    stubCanvas();
    stubImage();
    withBackgroundReader({
      currentBackground: { id: 'vb-77', name: 'bookshelf.png' },
      currentBackgroundSetting: 'background',
    });

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');

    expect(sdkMock.setVirtualBackground).toHaveBeenCalledWith({
      fileUrl: 'https://zoom.example/backgrounds/green.png',
    });
  });

  it('samples the band color from the card edge, not the wordmark in the middle', async () => {
    const { sampleCardBandColor } = await loadModule();
    // A 8x8 card: red edge, grey block in the middle where the logo sits.
    const width = 8;
    const height = 8;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const middle = x > 1 && x < 6 && y > 1 && y < 6;
        data[i] = middle ? 128 : 215;
        data[i + 1] = middle ? 128 : 8;
        data[i + 2] = middle ? 128 : 6;
        data[i + 3] = 255;
      }
    }

    expect(sampleCardBandColor({ width, height, data })).toBe('rgb(215, 8, 6)');
    // Nothing opaque to average is an honest "no color", not black.
    expect(
      sampleCardBandColor({ width: 2, height: 2, data: new Uint8ClampedArray(16) })
    ).toBeNull();
  });
});

// Reported from production: an organizer on his own custom image background
// finished a speech with "show my own background" on, and was handed somebody
// else's custom background — then, later, None. One defect produces both, and
// which one he saw depended only on whether the background it picked at random
// happened to answer.
describe('restoring a background the client named but did not describe', () => {
  function withBackgroundReader(current) {
    sdkMock.getCurrentVirtualBackground = vi.fn().mockResolvedValue(current);
    return sdkMock.getCurrentVirtualBackground;
  }

  /** The state a build that replaced the background left behind. */
  function seedReplacedBackground(previous) {
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    localStorage.setItem('toastmaster_zoom_previous_background', JSON.stringify(previous));
  }

  function fakePixels(width = 1920, height = 1080) {
    return { width, height, data: new Uint8ClampedArray(4) };
  }

  // The organizer's own background, reported by id with no name — which is all
  // some clients give — plus a saved list that does not carry that id.
  const SAVED_LIST = {
    virtualBackgrounds: [
      { id: 'someone-elses-beach', name: 'Beach' },
      { id: 'someone-elses-office', name: 'Office' },
    ],
  };

  beforeEach(() => {
    stubCanvas();
    sdkMock.config.mockResolvedValue({});
    sdkMock.setVideoFilter.mockResolvedValue({});
    sdkMock.deleteVideoFilter.mockResolvedValue({});
    sdkMock.setVirtualBackground.mockResolvedValue({});
    sdkMock.removeVirtualBackground.mockResolvedValue({});
  });

  afterEach(() => {
    delete sdkMock.getCurrentVirtualBackground;
    delete sdkMock.getVirtualBackgrounds;
  });

  it('never applies a saved background it cannot tie to the one it is restoring', async () => {
    // The bug: the name filter read `!name || <matches>`, so no name kept every
    // entry. The first that answered went onto his video — a stranger's beach.
    seedReplacedBackground({ type: 'image', id: 'his-own-photo' });
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();
    withBackgroundReader({ id: 'timer-green' });
    sdkMock.callZoomApi.mockImplementation((api, payload) => {
      if (api === 'getVirtualBackgrounds') return Promise.resolve(SAVED_LIST);
      // His own id is refused, which is the documented normal case; every other
      // id in the list would answer perfectly well.
      if (payload?.backgroundId === 'his-own-photo' || payload?.id === 'his-own-photo'
          || payload?.virtualBackgroundId === 'his-own-photo') {
        return Promise.reject(Object.assign(new Error('Validation error'), { code: -1 }));
      }
      return Promise.resolve({ imageData: fakePixels() });
    });

    const result = await clearVideoPipelines();

    // Not one unrelated background was fetched, let alone applied.
    for (const id of ['someone-elses-beach', 'someone-elses-office']) {
      expect(sdkMock.callZoomApi).not.toHaveBeenCalledWith(
        'getVirtualBackgroundData', expect.objectContaining({ backgroundId: id }), expect.anything()
      );
    }
    expect(sdkMock.setVirtualBackground).not.toHaveBeenCalled();
    // Honest outcome: it could not be put back, and that is reported rather
    // than papered over with someone else's picture.
    expect(sdkMock.removeVirtualBackground).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, lostBackground: true });
  });

  it('still follows the saved list when the entry carries the id it tried', async () => {
    // The case the fallback exists for, and the one worth keeping: the list
    // knows this exact background under a second spelling.
    seedReplacedBackground({ type: 'image', id: 'current-77' });
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();
    withBackgroundReader({ id: 'timer-green' });
    const pixels = fakePixels();
    sdkMock.callZoomApi.mockImplementation((api, payload) => {
      if (api === 'getVirtualBackgrounds') {
        return Promise.resolve({
          virtualBackgrounds: [
            { id: 'current-77', backgroundId: 'list-99', name: 'Bookshelf' },
            { id: 'someone-elses-office', name: 'Office' },
          ],
        });
      }
      if (payload?.backgroundId === 'list-99') return Promise.resolve({ imageData: pixels });
      return Promise.reject(Object.assign(new Error('Validation error'), { code: -1 }));
    });

    const result = await clearVideoPipelines();

    // Same background, spelled the way getVirtualBackgroundData wants it — and
    // no name was needed to establish that.
    expect(sdkMock.setVirtualBackground).toHaveBeenLastCalledWith({ imageData: pixels });
    expect(result).toMatchObject({ ok: true, lostBackground: false });
  });

  it('says in the log why it would not guess, so this is diagnosable next time', async () => {
    seedReplacedBackground({ type: 'image', id: 'his-own-photo' });
    const { initializeZoomSdk, setLogCallback, clearVideoPipelines } = await loadModule();
    const lines = [];
    setLogCallback((message) => lines.push(message));
    await initializeZoomSdk();
    withBackgroundReader({ id: 'timer-green' });
    sdkMock.callZoomApi.mockImplementation((api) =>
      api === 'getVirtualBackgrounds'
        ? Promise.resolve(SAVED_LIST)
        : Promise.reject(Object.assign(new Error('Validation error'), { code: -1 }))
    );

    await clearVideoPipelines();

    expect(lines.some((line) => line.includes('not guessing'))).toBe(true);
  });
});

// clearVideoPipelines used to bypass the overlay queue while removeOverlay ran
// on it, so the two could interleave over the same records.
describe('a clear and a teardown asked for at the same moment', () => {
  beforeEach(() => {
    stubCanvas();
    sdkMock.config.mockResolvedValue({});
    sdkMock.setVideoFilter.mockResolvedValue({});
    sdkMock.deleteVideoFilter.mockResolvedValue({});
    sdkMock.setVirtualBackground.mockResolvedValue({});
    sdkMock.removeVirtualBackground.mockResolvedValue({});
    sdkMock.setVirtualForeground.mockResolvedValue({});
    sdkMock.removeVirtualForeground.mockResolvedValue({});
  });

  afterEach(() => {
    delete sdkMock.getCurrentVirtualBackground;
  });

  it('restores once, however many teardowns are in flight', async () => {
    // Both used to read virtualBackgroundApplied before either cleared it, so
    // both set out to restore. The second then met a background it did not
    // recognise — the first had already handed his own back — decided ours must
    // still be up, and went over the top of a video that was already correct.
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    localStorage.setItem(
      'toastmaster_zoom_previous_background',
      JSON.stringify({ type: 'image', id: 'vb-77', name: 'bookshelf.png' })
    );
    const { initializeZoomSdk, clearVideoPipelines, removeOverlay } = await loadModule();
    await initializeZoomSdk();
    stubImage();

    const own = { currentBackground: { id: 'vb-77', name: 'bookshelf.png' }, currentBackgroundSetting: 'image' };
    const ours = { currentBackground: { id: 'timer-green' }, currentBackgroundSetting: 'image' };
    let applied = ours;
    sdkMock.getCurrentVirtualBackground = vi.fn(() => Promise.resolve(applied));
    sdkMock.callZoomApi.mockResolvedValue({ imageData: { width: 1920, height: 1080, data: new Uint8ClampedArray(4) } });
    // Putting his background back is what the client would then report.
    sdkMock.setVirtualBackground.mockImplementation(() => {
      applied = own;
      return Promise.resolve({});
    });

    // Fired together, the way a finished speech and its reveal effect do.
    await Promise.all([clearVideoPipelines(), removeOverlay()]);

    // One restore, and no removal chasing it.
    expect(sdkMock.setVirtualBackground).toHaveBeenCalledTimes(1);
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
  });
});

// The organizer hands the app the background they want to end on, so the
// restore has nothing left to get wrong. Everything the guessing path could
// fail at — an id the pixel call refuses, a client that grants none of the
// getters, a name it never reported — stops applying the moment one is set.
describe('an own background the organizer set in the app', () => {
  function withBackgroundReader(current) {
    sdkMock.getCurrentVirtualBackground = vi.fn().mockResolvedValue(current);
    return sdkMock.getCurrentVirtualBackground;
  }

  /** Set one, the way OwnBackgroundPicker does. */
  function setOwnBackground() {
    localStorage.setItem('toastmaster_own_background', '1');
  }

  beforeEach(() => {
    stubCanvas();
    sdkMock.config.mockResolvedValue({});
    sdkMock.setVideoFilter.mockResolvedValue({});
    sdkMock.deleteVideoFilter.mockResolvedValue({});
    sdkMock.setVirtualBackground.mockResolvedValue({});
    sdkMock.removeVirtualBackground.mockResolvedValue({});
    sdkMock.setVirtualForeground.mockResolvedValue({});
    sdkMock.removeVirtualForeground.mockResolvedValue({});
  });

  afterEach(() => {
    delete sdkMock.getCurrentVirtualBackground;
    delete sdkMock.getVirtualBackgrounds;
  });

  it('restores it without asking Zoom anything at all', async () => {
    setOwnBackground();
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();
    stubImage();
    const read = withBackgroundReader({ id: 'timer-green' });

    const result = await clearVideoPipelines();

    // Their image goes back...
    expect(sdkMock.setVirtualBackground).toHaveBeenCalledWith({ imageData: expect.anything() });
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
    // ...and none of the three fragile getters was consulted to do it. This is
    // the point: they are absent from the shipped SDK typing and a client may
    // grant none of them, and every reported failure ran through one.
    expect(read).not.toHaveBeenCalled();
    expect(sdkMock.callZoomApi).not.toHaveBeenCalledWith(
      'getVirtualBackgroundData', expect.anything(), expect.anything()
    );
    expect(result).toMatchObject({ ok: true, lostBackground: false });
  });

  it('outranks a snapshot that says the organizer had something else', async () => {
    // The record says bookshelf; they told the app to end on their upload. The
    // upload wins, and the pixels for the bookshelf are never even fetched.
    setOwnBackground();
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    localStorage.setItem(
      'toastmaster_zoom_previous_background',
      JSON.stringify({ type: 'image', id: 'vb-77', name: 'bookshelf.png' })
    );
    const bookshelf = { width: 1920, height: 1080, data: new Uint8ClampedArray(4) };
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();
    stubImage();
    withBackgroundReader({ id: 'timer-green' });
    sdkMock.callZoomApi.mockResolvedValue({ imageData: bookshelf });

    await clearVideoPipelines();

    const [applied] = sdkMock.setVirtualBackground.mock.lastCall;
    expect(applied.imageData).not.toBe(bookshelf);
  });

  it('outranks a blur, which the guessing path would have restored exactly', async () => {
    setOwnBackground();
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    localStorage.setItem('toastmaster_zoom_previous_background', JSON.stringify({ type: 'blur' }));
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();
    stubImage();
    withBackgroundReader({ id: 'timer-green' });

    await clearVideoPipelines();

    expect(sdkMock.setVirtualBackground).not.toHaveBeenCalledWith({ blur: true });
    expect(sdkMock.setVirtualBackground).toHaveBeenCalledWith({ imageData: expect.anything() });
  });

  it('replaces a video background too, since they said where to land', async () => {
    // The one case where setting this changes what kind of background they run
    // on. Without it a video is left alone, because nothing can put one back;
    // with it there is somewhere to land, so the card replaces it like any
    // other and the speech ends on the still they chose.
    setOwnBackground();
    const { initializeZoomSdk, setOverlayMode, clearVideoPipelines, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    withBackgroundReader({
      currentBackground: { id: 'vb-9', name: 'beach-loop.mp4' },
      currentBackgroundSetting: 'video',
    });

    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    // The card replaces it, rather than banding over the top.
    expect(sdkMock.setVirtualBackground).toHaveBeenCalledWith({
      fileUrl: 'https://zoom.example/backgrounds/green.png',
    });

    sdkMock.setVirtualBackground.mockClear();
    const result = await clearVideoPipelines();

    expect(sdkMock.setVirtualBackground).toHaveBeenCalledWith({ imageData: expect.anything() });
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, lostBackground: false });
  });

  it('falls back to the old path when the image will not decode', async () => {
    // The flag promises pixels; a browser that cannot hand them over must not
    // turn that into a background that never comes off.
    setOwnBackground();
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    localStorage.setItem(
      'toastmaster_zoom_previous_background',
      JSON.stringify({ type: 'image', id: 'vb-77', name: 'bookshelf.png' })
    );
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();
    // No Image stub, so every decode rejects.
    withBackgroundReader({ id: 'timer-green' });
    const pixels = { width: 1920, height: 1080, data: new Uint8ClampedArray(4) };
    sdkMock.callZoomApi.mockResolvedValue({ imageData: pixels });

    const result = await clearVideoPipelines();

    // Back to asking Zoom, exactly as before the setting existed.
    expect(sdkMock.setVirtualBackground).toHaveBeenCalledWith({ imageData: pixels });
    expect(result).toMatchObject({ ok: true, lostBackground: false });
  });

  it('goes onto the video the moment it is set', async () => {
    // Picking a background and seeing nothing happen reads as a setting that
    // did not take. This is the one moment the organizer is looking at it.
    setOwnBackground();
    const { initializeZoomSdk, applyOwnBackground } = await loadModule();
    await initializeZoomSdk();
    stubImage();

    expect(await applyOwnBackground()).toBe('applied');
    expect(sdkMock.setVirtualBackground).toHaveBeenCalledWith({ imageData: expect.anything() });
  });

  it('is not recorded as ours, so a later teardown cannot take it off', async () => {
    setOwnBackground();
    const { initializeZoomSdk, applyOwnBackground, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();
    stubImage();
    await applyOwnBackground();
    sdkMock.setVirtualBackground.mockClear();

    // Their own background is on the video and nothing of ours is; clearing
    // must leave it exactly where it is.
    const result = await clearVideoPipelines();

    expect(sdkMock.setVirtualBackground).not.toHaveBeenCalled();
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true });
  });

  it('declines while a timing card is on the video rather than replacing it', async () => {
    // Mid-speech the card is the whole reason the app is on screen. Showing the
    // organizer a preview by taking the color away from the room is a bad
    // trade, and the setting applies when the card comes off anyway.
    setOwnBackground();
    const { initializeZoomSdk, setOverlayMode, applyOwnBackground, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    sdkMock.setVirtualBackground.mockClear();

    expect(await applyOwnBackground()).toBe('busy');
    expect(sdkMock.setVirtualBackground).not.toHaveBeenCalled();
  });

  it('says so rather than claiming success when the client will not take it', async () => {
    setOwnBackground();
    sdkMock.config.mockResolvedValue({ unsupportedApis: ['setVirtualBackground'] });
    const { initializeZoomSdk, applyOwnBackground } = await loadModule();
    await initializeZoomSdk();
    stubImage();

    expect(await applyOwnBackground()).toBe('unavailable');
    expect(sdkMock.setVirtualBackground).not.toHaveBeenCalled();
  });

  it('comes off the video when the organizer clears the setting', async () => {
    // The mirror of setting one. A setting that put an image on their video
    // should take it off again, rather than leaving it there with nothing left
    // that will ever remove it.
    const { initializeZoomSdk, removeOwnBackground } = await loadModule();
    await initializeZoomSdk();
    stubImage();

    expect(await removeOwnBackground()).toBe('removed');
    expect(sdkMock.removeVirtualBackground).toHaveBeenCalled();
  });

  it('reports a declined removal as declined, not as a failure', async () => {
    // Zoom always asks before removing a background. Saying no leaves the
    // video alone, which is a normal outcome — the setting is gone either way.
    const { initializeZoomSdk, removeOwnBackground } = await loadModule();
    await initializeZoomSdk();
    stubImage();
    sdkMock.removeVirtualBackground.mockRejectedValueOnce(
      Object.assign(new Error('declined'), { code: 10017 })
    );

    expect(await removeOwnBackground()).toBe('declined');
  });

  it('treats an already-bare camera as removed, since that is the state asked for', async () => {
    const { initializeZoomSdk, removeOwnBackground } = await loadModule();
    await initializeZoomSdk();
    stubImage();
    sdkMock.removeVirtualBackground.mockRejectedValueOnce(
      Object.assign(new Error('nothing applied'), { code: 10195 })
    );

    expect(await removeOwnBackground()).toBe('removed');
  });

  it('declines to strip the video while a timing card is on it', async () => {
    // Same guard as applying: mid-speech the card owns the video, and the
    // background underneath is not what anyone is looking at.
    const { initializeZoomSdk, setOverlayMode, removeOwnBackground, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    stubImage();
    setOwnBackground();
    await setOverlayMode(OVERLAY_MODE_CAMERA, 'https://zoom.example/backgrounds/green.png');
    sdkMock.removeVirtualBackground.mockClear();

    expect(await removeOwnBackground()).toBe('busy');
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
  });

  it('does nothing differently while none is set', async () => {
    // The guard on the whole feature: an organizer who never opens the modal
    // keeps the behaviour they have today.
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    const { initializeZoomSdk, clearVideoPipelines } = await loadModule();
    await initializeZoomSdk();
    stubImage();
    const read = withBackgroundReader({ id: 'timer-green' });

    await clearVideoPipelines();

    expect(read).toHaveBeenCalled();
    expect(sdkMock.removeVirtualBackground).toHaveBeenCalled();
  });
});

describe('handing the video back while the timer is idle', () => {
  // "Show your own background" is a promise about the organizer's face. Which of
  // the two pipelines happens to be holding the card is an implementation detail
  // they neither see nor care about, so the idle path has to take off whichever
  // one is up rather than whichever one the current mode would use.
  beforeEach(() => {
    stubCanvas();
    sdkMock.config.mockResolvedValue({});
    sdkMock.deleteVideoFilter.mockResolvedValue({});
    sdkMock.setVideoFilter.mockResolvedValue({});
    sdkMock.removeVirtualBackground.mockResolvedValue({});
    sdkMock.setVirtualBackground.mockResolvedValue({});
  });

  it('takes off a filter left over from card mode', async () => {
    const { initializeZoomSdk, applyOverlay, removeOverlay, isOverlayActive } = await loadModule();
    await initializeZoomSdk();
    stubImage();
    await applyOverlay('https://zoom.example/backgrounds/green.png');
    expect(isOverlayActive()).toBe(true);

    await removeOverlay();

    expect(sdkMock.deleteVideoFilter).toHaveBeenCalled();
    expect(isOverlayActive()).toBe(false);
  });

  it('takes off a background even when the mode has since moved to card', async () => {
    // Camera mode earlier in the meeting, then a reload that lands in card mode
    // with the branded background still on their face. Dispatching on the
    // current mode alone left it there for the rest of the meeting.
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    const { initializeZoomSdk, removeOverlay, isOverlayActive, getOverlayMode, OVERLAY_MODE_CARD } =
      await loadModule();
    await initializeZoomSdk();
    expect(getOverlayMode()).toBe(OVERLAY_MODE_CARD);

    await removeOverlay();

    expect(sdkMock.removeVirtualBackground).toHaveBeenCalled();
    expect(isOverlayActive()).toBe(false);
  });

  it('does nothing at all when nothing of ours is up', async () => {
    // resetTimer runs on every speaker and role change, so this is the common
    // case, not the edge one.
    const { initializeZoomSdk, removeOverlay } = await loadModule();
    await initializeZoomSdk();

    await removeOverlay();

    expect(sdkMock.deleteVideoFilter).not.toHaveBeenCalled();
    expect(sdkMock.removeVirtualBackground).not.toHaveBeenCalled();
  });
});

describe('asking the SDK for something before init has finished', () => {
  it('waits for the in-flight init instead of reporting the SDK unavailable', async () => {
    // main.jsx renders the app and *then* starts init, on purpose, so every
    // mount effect runs inside that gap. SpeakerInput fetches participants from
    // one, once — so landing in the gap left the suggestions empty for the whole
    // meeting, whatever the caller's role or capabilities.
    let resolveConfig;
    sdkMock.config.mockReturnValue(new Promise((resolve) => { resolveConfig = resolve; }));
    sdkMock.getUserContext = vi.fn().mockResolvedValue({
      screenName: 'Priya', role: 'host', participantUUID: 'me',
    });
    sdkMock.getMeetingParticipants = vi.fn().mockResolvedValue({
      participants: [{ screenName: 'Sam', participantUUID: 'p2' }],
    });

    const { initializeZoomSdk, getZoomParticipants } = await loadModule();

    // Init started but not settled — exactly where the mount effect lands.
    const initializing = initializeZoomSdk();
    const fetching = getZoomParticipants();

    resolveConfig({});
    await initializing;

    expect((await fetching).participants).toEqual([
      { id: 'me', name: 'Priya' },
      { id: 'p2', name: 'Sam' },
    ]);

    delete sdkMock.getUserContext;
    delete sdkMock.getMeetingParticipants;
  });

  it('runs config once however many callers arrive at the same time', async () => {
    sdkMock.config.mockResolvedValue({});
    const { initializeZoomSdk } = await loadModule();

    await Promise.all([initializeZoomSdk(), initializeZoomSdk(), initializeZoomSdk()]);

    expect(sdkMock.config).toHaveBeenCalledTimes(1);
  });
});

describe('the overlay mode survives a webview reload', () => {
  beforeEach(() => {
    stubCanvas();
    sdkMock.config.mockResolvedValue({});
    sdkMock.setVirtualBackground.mockResolvedValue({});
    sdkMock.setVideoFilter.mockResolvedValue({ status: 'ok' });
  });

  it('pushes through the pipeline of the persisted mode, not the default', async () => {
    // Zoom re-creates the app webview every time the panel is closed and
    // reopened. The Live tab restores the organizer's saved mode into its menu,
    // but this module used to wake up in the default mode regardless — so with
    // Timer + Camera saved, the menu said "Timer + Camera" while every push
    // went through setVideoFilter, covering the organizer's face with the full
    // card. The clear button could not help: the running timer re-pushed the
    // filter on the next status change. Only RESET recovered, because it stops
    // the speech before clearing.
    saveOverlayMode('camera');
    const { initializeZoomSdk, applyOverlay, getOverlayMode, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();

    expect(getOverlayMode()).toBe(OVERLAY_MODE_CAMERA);
    await applyOverlay('https://zoom.example/backgrounds/green.png');

    expect(sdkMock.setVirtualBackground).toHaveBeenCalledWith({
      fileUrl: 'https://zoom.example/backgrounds/green.png',
    });
    expect(sdkMock.setVideoFilter).not.toHaveBeenCalled();
  });

  it('migrates the legacy popout mode to the stage', async () => {
    saveOverlayMode('popout');
    const { getOverlayMode, OVERLAY_MODE_STAGE } = await loadModule();
    expect(getOverlayMode()).toBe(OVERLAY_MODE_STAGE);
  });

  it('falls back to the default for a mode no build ever saved', async () => {
    // 'share' was a mode once; a saved preference must never start a share, so
    // it maps to the default rather than to anything outward-facing.
    saveOverlayMode('share');
    const { getOverlayMode, DEFAULT_OVERLAY_MODE } = await loadModule();
    expect(getOverlayMode()).toBe(DEFAULT_OVERLAY_MODE);
  });

  it('starts a fresh install in Timer + Camera', async () => {
    // The default keeps the organizer's face on screen: color behind them, not
    // over them.
    localStorage.clear();
    const { getOverlayMode, DEFAULT_OVERLAY_MODE, OVERLAY_MODE_CAMERA } = await loadModule();
    expect(DEFAULT_OVERLAY_MODE).toBe(OVERLAY_MODE_CAMERA);
    expect(getOverlayMode()).toBe(OVERLAY_MODE_CAMERA);
  });

  it('degrades Timer + Camera to the card pipeline when the client refused setVirtualBackground', async () => {
    // Camera is the default now, so a client without setVirtualBackground must
    // still show the color signal — as a plain card — rather than nothing.
    localStorage.clear();
    stubImage();
    sdkMock.config.mockResolvedValue({ unsupportedApis: ['setVirtualBackground'] });
    const { initializeZoomSdk, applyOverlay } = await loadModule();
    await initializeZoomSdk();

    await applyOverlay('https://zoom.example/backgrounds/green.png');

    expect(sdkMock.setVirtualBackground).not.toHaveBeenCalled();
    expect(sdkMock.setVideoFilter).toHaveBeenCalledWith({ imageData: expect.anything() });
  });
});

describe('the count-up on the pushed card', () => {
  beforeEach(() => {
    stubImage();
    sdkMock.config.mockResolvedValue({});
    sdkMock.setVideoFilter.mockResolvedValue({ status: 'ok' });
    sdkMock.setVirtualBackground.mockResolvedValue({});
  });

  it('bakes the elapsed time into card-mode frames', async () => {
    const { operations } = stubCanvas();
    const { initializeZoomSdk, setOverlayTimeLabel, applyOverlay } = await loadModule();
    await initializeZoomSdk();

    setOverlayTimeLabel('00:05');
    await applyOverlay('https://zoom.example/backgrounds/green.png');

    // Participants watching the card see the time, not just the color.
    expect(renderedLabels(operations)).toContain('00:05');
    expect(sdkMock.setVideoFilter).toHaveBeenCalledTimes(1);
  });

  it('re-pushes the frame each time the readout advances', async () => {
    const { operations } = stubCanvas();
    const { initializeZoomSdk, setOverlayTimeLabel, applyOverlay } = await loadModule();
    await initializeZoomSdk();
    setOverlayTimeLabel('00:05');
    await applyOverlay('https://zoom.example/backgrounds/green.png');

    setOverlayTimeLabel('00:06');
    // The setter re-pushes through the queue; let it drain.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(renderedLabels(operations)).toContain('00:06');
    expect(sdkMock.setVideoFilter).toHaveBeenCalledTimes(2);
  });

  it('does not re-push just because the readout was cleared', async () => {
    stubCanvas();
    const { initializeZoomSdk, setOverlayTimeLabel, applyOverlay } = await loadModule();
    await initializeZoomSdk();
    setOverlayTimeLabel('00:05');
    await applyOverlay('https://zoom.example/backgrounds/green.png');

    // Null means the speech is over; the teardown that follows owns the tile,
    // and a repaint here would race it.
    setOverlayTimeLabel(null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sdkMock.setVideoFilter).toHaveBeenCalledTimes(1);
  });

  it('rides the Timer + Camera readout on a foreground layer, never a baked background', async () => {
    const { operations } = stubCanvas();
    saveOverlayMode('camera');
    sdkMock.setVirtualForeground.mockResolvedValue({});
    const { initializeZoomSdk, setOverlayTimeLabel, applyOverlay } = await loadModule();
    await initializeZoomSdk();

    setOverlayTimeLabel('00:05');
    await applyOverlay('https://zoom.example/backgrounds/green.png');

    // The Zoom client saves every image handed to setVirtualBackground to the
    // user's disk, so a running speech must not turn the background into a
    // new image every second. The color stays a fixed file the client fetches
    // itself; the time crosses as a transparent foreground layer.
    expect(sdkMock.setVirtualBackground).toHaveBeenCalledWith({
      fileUrl: 'https://zoom.example/backgrounds/green.png',
    });
    expect(sdkMock.setVirtualForeground).toHaveBeenCalledWith({
      imageData: expect.anything(),
      // Zoom takes the layer down itself when the meeting ends, so a crashed
      // app strands nothing on the user's video.
      persistence: 'meeting',
    });
    expect(renderedLabels(operations)).toContain('00:05');
    expect(sdkMock.setVideoFilter).not.toHaveBeenCalled();
  });

  it('advances the camera-mode readout without pushing a single new background', async () => {
    const { operations } = stubCanvas();
    saveOverlayMode('camera');
    sdkMock.setVirtualForeground.mockResolvedValue({});
    const { initializeZoomSdk, setOverlayTimeLabel, applyOverlay } = await loadModule();
    await initializeZoomSdk();
    setOverlayTimeLabel('00:05');
    await applyOverlay('https://zoom.example/backgrounds/green.png');

    setOverlayTimeLabel('00:06');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(renderedLabels(operations)).toContain('00:06');
    expect(sdkMock.setVirtualForeground).toHaveBeenCalledTimes(2);
    // One push per color, however long the speech: each background the client
    // is handed becomes a file saved on the user's machine.
    expect(sdkMock.setVirtualBackground).toHaveBeenCalledTimes(1);
  });

  it('shows the color alone when the client refuses the foreground layer', async () => {
    stubCanvas();
    saveOverlayMode('camera');
    sdkMock.config.mockResolvedValue({ unsupportedApis: ['setVirtualForeground'] });
    const { initializeZoomSdk, setOverlayTimeLabel, applyOverlay } = await loadModule();
    await initializeZoomSdk();

    setOverlayTimeLabel('00:05');
    await applyOverlay('https://zoom.example/backgrounds/green.png');
    setOverlayTimeLabel('00:06');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Degrading to per-second background pushes is exactly the disk pollution
    // the foreground exists to avoid, so the count-up is simply not shown.
    expect(sdkMock.setVirtualForeground).not.toHaveBeenCalled();
    expect(sdkMock.setVirtualBackground).toHaveBeenCalledTimes(1);
    expect(sdkMock.setVirtualBackground).toHaveBeenCalledWith({
      fileUrl: 'https://zoom.example/backgrounds/green.png',
    });
  });

  it('takes the readout layer down with the camera overlay', async () => {
    stubCanvas();
    saveOverlayMode('camera');
    sdkMock.setVirtualForeground.mockResolvedValue({});
    sdkMock.removeVirtualForeground.mockResolvedValue({});
    sdkMock.removeVirtualBackground.mockResolvedValue({});
    const { initializeZoomSdk, setOverlayTimeLabel, applyOverlay, removeOverlay } = await loadModule();
    await initializeZoomSdk();
    setOverlayTimeLabel('00:05');
    await applyOverlay('https://zoom.example/backgrounds/green.png');

    setOverlayTimeLabel(null);
    await removeOverlay();

    expect(sdkMock.removeVirtualForeground).toHaveBeenCalled();
    // The layer belongs to the speech, and it comes off before the background
    // goes back to its owner.
    expect(sdkMock.removeVirtualForeground.mock.invocationCallOrder[0]).toBeLessThan(
      sdkMock.removeVirtualBackground.mock.invocationCallOrder[0]
    );
  });

  it('sizes the readout layer to the camera stream, not the background budget', async () => {
    stubCanvas();
    saveOverlayMode('camera');
    sdkMock.setVirtualForeground.mockResolvedValue({});
    const { initializeZoomSdk, setOverlayTimeLabel, applyOverlay, handleMyMediaChange } =
      await loadModule();
    await initializeZoomSdk();
    handleMyMediaChange({ media: { video: { width: 1280, height: 720 } }, timestamp: 1 });

    setOverlayTimeLabel('00:05');
    await applyOverlay('https://zoom.example/backgrounds/green.png');

    // The client composites the foreground onto the video 1:1 from the
    // top-left. At the 640x360 background budget on a 720p stream, the layer
    // covered only the top-left quadrant and the readout could never move
    // past the video's center.
    const [options] = sdkMock.setVirtualForeground.mock.calls.at(-1);
    expect(options.imageData).toMatchObject({ width: 1280, height: 720 });
  });

  it('assumes a 720p stream until the camera reports its resolution', async () => {
    stubCanvas();
    saveOverlayMode('camera');
    sdkMock.setVirtualForeground.mockResolvedValue({});
    const { initializeZoomSdk, setOverlayTimeLabel, applyOverlay } = await loadModule();
    await initializeZoomSdk();

    setOverlayTimeLabel('00:05');
    await applyOverlay('https://zoom.example/backgrounds/green.png');

    const [options] = sdkMock.setVirtualForeground.mock.calls.at(-1);
    expect(options.imageData).toMatchObject({ width: 1280, height: 720 });
  });

  it('remembers the camera resolution across a webview reload', async () => {
    stubCanvas();
    saveOverlayMode('camera');
    sdkMock.setVirtualForeground.mockResolvedValue({});
    // The first webview hears the report...
    const first = await loadModule();
    first.handleMyMediaChange({ media: { video: { width: 640, height: 360 } }, timestamp: 1 });

    // ...then Zoom re-creates the webview (panel closed and reopened), and no
    // new onMyMediaChange arrives — it only fires on changes. Rendered at the
    // 720p fallback, the frame would be twice the 360p stream: composited 1:1,
    // the readout's reachable area would be the video's top-left quadrant and
    // anything past it invisible.
    const second = await loadModule();
    expect(second.getCameraResolution()).toEqual({ width: 640, height: 360 });
    await second.initializeZoomSdk();
    second.setOverlayTimeLabel('00:05');
    await second.applyOverlay('https://zoom.example/backgrounds/green.png');

    const [options] = sdkMock.setVirtualForeground.mock.calls.at(-1);
    expect(options.imageData).toMatchObject({ width: 640, height: 360 });
  });

  it.each([
    ['corrupt JSON', '{not json'],
    ['non-numeric dimensions', '{"width":"wide","height":"tall"}'],
    ['a zero dimension', '{"width":0,"height":720}'],
  ])('ignores a persisted camera resolution holding %s', async (_label, stored) => {
    localStorage.setItem('toastmaster_zoom_camera_resolution', stored);
    const { getCameraResolution } = await loadModule();
    expect(getCameraResolution()).toBeNull();
  });

  it('re-renders the readout layer when the camera resolution changes', async () => {
    stubCanvas();
    saveOverlayMode('camera');
    sdkMock.setVirtualForeground.mockResolvedValue({});
    const { initializeZoomSdk, setOverlayTimeLabel, applyOverlay, handleMyMediaChange } =
      await loadModule();
    await initializeZoomSdk();
    setOverlayTimeLabel('00:05');
    await applyOverlay('https://zoom.example/backgrounds/green.png');

    handleMyMediaChange({ media: { video: { width: 1920, height: 1080 } }, timestamp: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Composited 1:1, a layer of the wrong size puts the readout in the
    // wrong place — but the fileUrl background still needs no re-push.
    const [options] = sdkMock.setVirtualForeground.mock.calls.at(-1);
    expect(options.imageData).toMatchObject({ width: 1920, height: 1080 });
    expect(sdkMock.setVirtualBackground).toHaveBeenCalledTimes(1);
  });

  it('still repaints the readout after a webview reload wiped the in-memory record', async () => {
    stubCanvas();
    saveOverlayMode('camera');
    // A background of ours is on the video from before the panel was closed;
    // only the persisted flag knows it.
    localStorage.setItem('toastmaster_zoom_virtual_background_applied', 'true');
    sdkMock.setVirtualForeground.mockResolvedValue({});
    const { initializeZoomSdk, setOverlayTimeLabel, setOverlayTimePosition } = await loadModule();
    await initializeZoomSdk();

    setOverlayTimeLabel('00:07');
    setOverlayTimePosition({ x: 0.9, y: 0.9 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The drag reaches the video without waiting for a color change to
    // rebuild the record — and without pushing any background at all.
    expect(sdkMock.setVirtualForeground).toHaveBeenCalled();
    expect(sdkMock.setVirtualBackground).not.toHaveBeenCalled();
  });

  it('removes the readout on a mode switch even while the label is still ticking', async () => {
    stubCanvas();
    saveOverlayMode('camera');
    sdkMock.setVirtualForeground.mockResolvedValue({});
    sdkMock.removeVirtualForeground.mockResolvedValue({});
    sdkMock.removeVirtualBackground.mockResolvedValue({});
    const { initializeZoomSdk, setOverlayTimeLabel, applyOverlay, setOverlayMode, OVERLAY_MODE_CARD } =
      await loadModule();
    await initializeZoomSdk();
    setOverlayTimeLabel('00:05');
    await applyOverlay('https://zoom.example/backgrounds/green.png');

    // Mid-speech switch to card mode: the teardown must win over the label
    // heuristic, or the layer floats over the filter card forever.
    await setOverlayMode(OVERLAY_MODE_CARD, 'https://zoom.example/backgrounds/green.png');

    expect(sdkMock.removeVirtualForeground).toHaveBeenCalled();
  });

  it('hiding the readout removes the layer instead of re-pushing the background', async () => {
    stubCanvas();
    saveOverlayMode('camera');
    sdkMock.setVirtualForeground.mockResolvedValue({});
    sdkMock.removeVirtualForeground.mockResolvedValue({});
    const { initializeZoomSdk, setOverlayTimeLabel, setOverlayTimeVisible, applyOverlay } =
      await loadModule();
    await initializeZoomSdk();
    setOverlayTimeLabel('00:05');
    await applyOverlay('https://zoom.example/backgrounds/green.png');

    setOverlayTimeVisible(false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sdkMock.removeVirtualForeground).toHaveBeenCalledTimes(1);
    expect(sdkMock.setVirtualBackground).toHaveBeenCalledTimes(1);
  });

  it('keeps the cheap fileUrl push while camera mode is idle', async () => {
    stubCanvas();
    saveOverlayMode('camera');
    const { initializeZoomSdk, applyOverlay } = await loadModule();
    await initializeZoomSdk();

    // No speech, no readout — the Zoom client fetches the image itself.
    await applyOverlay('https://zoom.example/backgrounds/blue.png');

    expect(sdkMock.setVirtualBackground).toHaveBeenCalledWith({
      fileUrl: 'https://zoom.example/backgrounds/blue.png',
    });
  });

  it('moves the readout where the organizer dragged it, and remembers it', async () => {
    const { operations } = stubCanvas();
    const { initializeZoomSdk, setOverlayTimeLabel, setOverlayTimePosition, applyOverlay } =
      await loadModule();
    await initializeZoomSdk();
    setOverlayTimeLabel('00:05');
    await applyOverlay('https://zoom.example/backgrounds/green.png');
    const firstX = operations.find(([op]) => op === 'fillText')[2];

    setOverlayTimePosition({ x: 0.85, y: 0.85 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const laterX = operations.filter(([op]) => op === 'fillText').at(-1)[2];
    expect(laterX).toBeGreaterThan(firstX);
    // Persisted: where the organizer's face is does not change between
    // meetings, so neither should where the readout dodges it to.
    const { loadOverlayTimeReadout } = await import('@toastmaster-timer/shared');
    expect(loadOverlayTimeReadout()).toMatchObject({ x: 0.85, y: 0.85 });
  });

  it('resizes the readout from the +/- controls, clamped and remembered', async () => {
    stubCanvas();
    const {
      initializeZoomSdk, setOverlayTimeLabel, setOverlayTimeScale, applyOverlay,
      OVERLAY_TIME_SCALE_MAX,
    } = await loadModule();
    await initializeZoomSdk();
    setOverlayTimeLabel('00:05');
    await applyOverlay('https://zoom.example/backgrounds/green.png');

    // Absurd values stop at the bound rather than filling the frame.
    const applied = setOverlayTimeScale(5);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(applied).toBe(OVERLAY_TIME_SCALE_MAX);
    // The size change repaints the frame participants are watching.
    expect(sdkMock.setVideoFilter).toHaveBeenCalledTimes(2);
    const { loadOverlayTimeReadout } = await import('@toastmaster-timer/shared');
    expect(loadOverlayTimeReadout()).toMatchObject({ scale: OVERLAY_TIME_SCALE_MAX });
  });

  it('hides the readout on request, and stops repainting while hidden', async () => {
    const { operations } = stubCanvas();
    const { initializeZoomSdk, setOverlayTimeLabel, setOverlayTimeVisible, applyOverlay } =
      await loadModule();
    await initializeZoomSdk();
    setOverlayTimeLabel('00:05');
    await applyOverlay('https://zoom.example/backgrounds/green.png');

    // Hiding must push a plain frame — the readout is up and has to come off.
    setOverlayTimeVisible(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sdkMock.setVideoFilter).toHaveBeenCalledTimes(2);
    const labelsBefore = renderedLabels(operations).length;

    // While hidden, the ticking clock repaints nothing: every frame it would
    // push is identical to the one already showing.
    setOverlayTimeLabel('00:06');
    setOverlayTimeLabel('00:07');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sdkMock.setVideoFilter).toHaveBeenCalledTimes(2);
    expect(renderedLabels(operations)).toHaveLength(labelsBefore);

    // Showing again brings the current time back, not the one from before.
    setOverlayTimeVisible(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sdkMock.setVideoFilter).toHaveBeenCalledTimes(3);
    expect(renderedLabels(operations)).toContain('00:07');
  });

  it('clamps the readout inside the frame however far it is dragged', async () => {
    const { operations } = stubCanvas();
    const { renderTimeOnFrame } = await loadModule();
    const base = { width: 640, height: 360, data: new Uint8ClampedArray(640 * 360 * 4) };

    renderTimeOnFrame(base, '00:05', { x: 0, y: 0 });

    const [, , x, y] = operations.find(([op]) => op === 'fillText');
    // measureText stubs '00:05' at 200px wide; pad is 4% of height. Dragged to
    // the corner, the text center still keeps the whole readout on the frame.
    expect(x).toBeGreaterThanOrEqual(100);
    expect(y).toBeGreaterThanOrEqual(Math.round(360 * 0.18) / 2);
  });

  it('still pushes the plain card when text rendering fails', async () => {
    // The readout is a bonus; the color signal must survive a broken canvas.
    const { operations } = stubCanvas();
    const { initializeZoomSdk, setOverlayTimeLabel, applyOverlay, isOverlayActive } = await loadModule();
    await initializeZoomSdk();
    const brokenCtx = document.createElement('canvas').getContext('2d');
    brokenCtx.putImageData = () => { throw new Error('no canvas here'); };

    setOverlayTimeLabel('00:05');
    await applyOverlay('https://zoom.example/backgrounds/green.png');

    expect(renderedLabels(operations)).not.toContain('00:05');
    expect(sdkMock.setVideoFilter).toHaveBeenCalledTimes(1);
    expect(isOverlayActive()).toBe(true);
  });
});

describe('switching video modes never drops the teardown', () => {
  it('still deletes the filter when a newer push supersedes the queued teardown', async () => {
    // Switching card -> camera queues the filter teardown. A status push
    // landing right behind it used to supersede it, so the full card stayed
    // over the organizer's face while the camera-mode background went up
    // underneath — with per-second count-up pushes, a routine race.
    stubCanvas();
    stubImage();
    sdkMock.config.mockResolvedValue({});
    sdkMock.setVideoFilter.mockResolvedValue({ status: 'ok' });
    sdkMock.deleteVideoFilter.mockResolvedValue({});
    sdkMock.setVirtualBackground.mockResolvedValue({});
    const { initializeZoomSdk, applyOverlay, setOverlayMode, OVERLAY_MODE_CAMERA } =
      await loadModule();
    await initializeZoomSdk();
    await applyOverlay('https://zoom.example/backgrounds/green.png');

    const switching = setOverlayMode(OVERLAY_MODE_CAMERA, null);
    // Enqueued before the teardown has run, so it holds the newest request id.
    const newerPush = applyOverlay('https://zoom.example/backgrounds/yellow.png');
    await Promise.all([switching, newerPush]);

    expect(sdkMock.deleteVideoFilter).toHaveBeenCalled();
  });
});

describe('reading who Zoom says this is', () => {
  beforeEach(() => {
    sdkMock.config.mockResolvedValue({});
  });

  afterEach(() => {
    delete sdkMock.getAppContext;
    delete sdkMock.getUserContext;
  });

  it('hands back the signed app context', async () => {
    sdkMock.getAppContext = vi.fn().mockResolvedValue({ context: 'encrypted-blob' });
    const { readAppContext } = await loadModule();

    expect(await readAppContext()).toBe('encrypted-blob');
  });

  // config() resolves whether or not a capability was granted, listing refusals
  // in unsupportedApis. Identity is optional, so a refusal is anonymity, not an
  // error — and the call must not be attempted anyway.
  it('stays anonymous when the client refuses getAppContext', async () => {
    sdkMock.config.mockResolvedValue({ unsupportedApis: ['getAppContext'] });
    sdkMock.getAppContext = vi.fn().mockResolvedValue({ context: 'never-read' });
    const { readAppContext } = await loadModule();

    expect(await readAppContext()).toBeNull();
    expect(sdkMock.getAppContext).not.toHaveBeenCalled();
  });

  it('stays anonymous when the SDK is not there at all', async () => {
    sdkMock.config.mockRejectedValue(new Error('not in Zoom'));
    const { readAppContext, readZoomUserStatus } = await loadModule();

    expect(await readAppContext()).toBeNull();
    expect(await readZoomUserStatus()).toBeNull();
  });

  it('stays anonymous when getAppContext throws or returns nothing usable', async () => {
    sdkMock.getAppContext = vi.fn().mockRejectedValue(new Error('10118'));
    const { readAppContext } = await loadModule();
    expect(await readAppContext()).toBeNull();

    sdkMock.getAppContext = vi.fn().mockResolvedValue({});
    const again = await loadModule();
    expect(await again.readAppContext()).toBeNull();
  });

  it('reports the Zoom sign-in status, which is what tells a guest apart', async () => {
    sdkMock.getUserContext = vi.fn().mockResolvedValue({
      screenName: 'Someone',
      status: 'authorized',
    });
    const { readZoomUserStatus } = await loadModule();

    expect(await readZoomUserStatus()).toBe('authorized');
  });

  it('reports no status rather than guessing when getUserContext fails', async () => {
    sdkMock.getUserContext = vi.fn().mockRejectedValue(new Error('refused'));
    const { readZoomUserStatus } = await loadModule();

    expect(await readZoomUserStatus()).toBeNull();
  });
});
