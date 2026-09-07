import zoomSdk from '@zoom/appssdk';
import { loadOverlayMode, loadOverlayTimeReadout, saveOverlayTimeReadout, resolveCardImage, CARD_ASSET_VERSION, hasOwnBackground, getOwnBackgroundUrl } from '@toastmaster-timer/shared';

// Production base URL for background images
const PRODUCTION_BASE_URL = 'https://www.timer.simple-tech.app';

/**
 * Path the app is served under, with leading and trailing slashes. This app is
 * built with Vite base '/zoom/', so its static files live under that prefix, not
 * at the origin root — origin + '/backgrounds/...' hits the SPA catch-all rewrite
 * and returns index.html, which then fails to decode as an image.
 * Exported for testing.
 */
export function getBasePath() {
  const base = import.meta.env?.BASE_URL || '/';
  const withLeading = base.startsWith('/') ? base : `/${base}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

// Absolute URL of one built-in card file — what the picker shows as a
// thumbnail and what the overlay fetches (works in both dev and production).
export function getCardFileUrl(file) {
  const path = `${getBasePath()}backgrounds/${file}?v=${CARD_ASSET_VERSION}`;

  // In browser, use the current origin (works automatically in production)
  if (typeof window !== 'undefined') {
    return `${window.location.origin}${path}`;
  }
  // Fallback to production URL if window is not available
  return `${PRODUCTION_BASE_URL}${path}`;
}

// Get the URL for a background image, from whichever card set the organizer
// selected. A custom set yields an object URL (or a legacy data: URL), which
// every consumer here accepts — the <img>/CSS paths directly, and the overlay
// path through its pixel decode; the built-in sets yield a file URL.
export function getBackgroundUrl(color) {
  const resolved = resolveCardImage(color);
  return resolved.url || getCardFileUrl(resolved.file);
}

// Every overlay pixel costs 4 bytes of ImageData across the webview -> native
// bridge, and that transfer is what makes the color change take seconds on slower
// clients. setVideoFilter documents a 15MB ceiling, which the old 2560x1440 asset
// nearly hit at 14.7MB. Sizes for reference:
//   2560x1440 = 14.7MB   1280x720 = 3.7MB   960x540 = 2.1MB   640x360 = 0.9MB
//
// The overlay is a flat color plus a logo, so it needs far fewer pixels than a
// camera feed: the color carries the timing signal and stays exact at any size.
// 640x360 was picked by rendering the shipped asset through a downscale-then-
// upscale round trip; it is where the "TOASTMASTERS" wordmark stops being crisp,
// and below it the logo breaks down. Raising this costs bytes on every push.
const OVERLAY_CEILING_WIDTH = 640;
const OVERLAY_CEILING_HEIGHT = 360;

/**
 * Every SDK method the app calls: what to request for it, whether the timer can
 * work without it, and what breaks when it is missing.
 *
 * One list, feeding both the config() request and the debug panel, because these
 * two drifted apart badly. The panel reported on a hand-kept subset, so a client
 * missing appPopout or openUrl read as all-green — and config() asked for
 * "videoFilter" and "virtualBackground", which are not capabilities at all.
 *
 * A capability is the exact name of the API or event being granted; there is no
 * grouped name covering a family of calls. Those two invented names granted
 * nothing, which is why removeVirtualBackground came back refused while applying
 * a background appeared to work.
 *
 * `required` keeps config() alive on a limited client: reject the full request
 * and it is retried with these alone, so only what the timer genuinely cannot run
 * without belongs here. The video filter is the core function: Timer + Camera is
 * the default, but it degrades to the filter pipeline on clients that refuse
 * setVirtualBackground, so the filter APIs are the ones nothing can stand in for.
 *
 * Keep in step with the zoomSdk.* calls below — a test asserts it, both ways.
 */
export const USED_SDK_APIS = [
  { name: 'config', capability: null, required: true, purpose: 'Grants every capability below' },
  { name: 'callZoomApi', capability: null, required: true, purpose: 'Reaching APIs the npm SDK has no wrapper for' },
  { name: 'setVideoFilter', capability: 'setVideoFilter', required: true, purpose: 'Timer Only' },
  { name: 'deleteVideoFilter', capability: 'deleteVideoFilter', required: true, purpose: 'Clearing Timer Only' },
  { name: 'setVirtualBackground', capability: 'setVirtualBackground', required: false, purpose: 'Timer + Camera' },
  { name: 'removeVirtualBackground', capability: 'removeVirtualBackground', required: false, purpose: 'Clearing Timer + Camera' },
  { name: 'setVirtualForeground', capability: 'setVirtualForeground', required: false, purpose: 'Count-up readout over Timer + Camera' },
  { name: 'removeVirtualForeground', capability: 'removeVirtualForeground', required: false, purpose: 'Clearing the count-up readout' },
  { name: 'getCurrentVirtualBackground', capability: 'getCurrentVirtualBackground', required: false, purpose: 'Leaving the user\'s own background alone' },
  { name: 'getVirtualBackgrounds', capability: 'getVirtualBackgrounds', required: false, purpose: 'Naming the background being restored' },
  { name: 'getVirtualBackgroundData', capability: 'getVirtualBackgroundData', required: false, purpose: 'Putting the user\'s own background image back' },
  { name: 'getVideoState', capability: 'getVideoState', required: false, purpose: 'Video-off warning' },
  { name: 'setVideoState', capability: 'setVideoState', required: false, purpose: 'Turn my video on' },
  { name: 'getMeetingParticipants', capability: 'getMeetingParticipants', required: false, purpose: 'Speaker suggestions' },
  { name: 'getUserContext', capability: 'getUserContext', required: false, purpose: 'Putting yourself in the speaker list' },
  { name: 'getAppContext', capability: 'getAppContext', required: false, purpose: 'Recognising a returning user across meetings and devices' },
  { name: 'shareApp', capability: 'shareApp', required: false, purpose: 'Sharing the stage to the meeting' },
  { name: 'onShareApp', capability: 'onShareApp', required: false, purpose: 'Following Zoom\'s own sharing toolbar' },
  { name: 'onShareScreen', capability: 'onShareScreen', required: false, purpose: 'Noticing Zoom\'s own Stop Share' },
  { name: 'getMeetingView', capability: 'getMeetingView', required: false, purpose: 'Checking whether a share is really still up' },
  { name: 'onMeetingViewChange', capability: 'onMeetingViewChange', required: false, purpose: 'Noticing a share ending' },
  { name: 'appPopout', capability: 'appPopout', required: false, purpose: 'Opening the stage in its own window' },
  { name: 'onAppPopout', capability: 'onAppPopout', required: false, purpose: 'Following Zoom\'s own popout menu' },
  { name: 'onAppVisibilityChange', capability: 'onAppVisibilityChange', required: false, purpose: 'Noticing background changes' },
  { name: 'onMyMediaChange', capability: 'onMyMediaChange', required: false, purpose: 'Overlay sizing' },
  { name: 'openUrl', capability: 'openUrl', required: false, purpose: 'Marketplace review link' },
];

const capabilitiesWhere = (required) =>
  USED_SDK_APIS.filter((api) => api.capability && api.required === required).map(
    (api) => api.capability
  );

const REQUIRED_CAPABILITIES = capabilitiesWhere(true);
const OPTIONAL_CAPABILITIES = capabilitiesWhere(false);

// APIs this client refused, as reported by config(). Empty until config resolves.
//
// This is the only truthful answer to "can I call this?". `typeof zoomSdk.foo ===
// 'function'` is not: the npm SDK defines every documented method on its
// prototype, granted or not, so that check passes on every client and every
// guard written against it is dead code. config() does not reject when a
// capability is refused either — it resolves and names the refusals here.
//
// Calling a refused API rejects at the bridge, which is what made "clear my
// video" report a hard failure on clients that never granted
// removeVirtualBackground in the first place.
let unsupportedApis = new Set();

// APIs the Zoom client supports and the Marketplace grants, but that the npm SDK
// ships no wrapper method for. Checked against @zoom/appssdk 0.16.36 (installed)
// and 0.16.41 (latest): absent from the `Apis` union and from the runtime bundle
// alike, while the Marketplace lists all three under Add API.
//
// The typings lagging is not the same as the client not supporting them, and
// treating it as the same is what made every read below dead code:
// isApiAvailable required `typeof zoomSdk[name] === 'function'`, which no client
// could ever satisfy for these, so readCurrentVirtualBackground always answered
// "cannot say" and the blur-restore branch never once ran in production.
//
// Delete a name from here the moment the SDK defines it; callSdkApi then routes
// it through the real wrapper with no other change.
const BRIDGE_ONLY_APIS = new Set([
  'getCurrentVirtualBackground',
  'getVirtualBackgrounds',
  'getVirtualBackgroundData',
]);

/**
 * Whether this client actually granted an API, as opposed to the SDK merely
 * defining it. Optimistic before config() resolves, which only affects calls
 * made during initialization.
 *
 * @param {string} name - SDK method name, e.g. 'removeVirtualBackground'
 * @returns {boolean}
 */
export function isApiAvailable(name) {
  if (!zoomSdk) return false;
  // A bridge-only API has no wrapper to look for, so the generic dispatcher is
  // what has to exist. config() still gets the last word through unsupportedApis.
  if (BRIDGE_ONLY_APIS.has(name)) {
    if (typeof zoomSdk.callZoomApi !== 'function') return false;
  } else if (typeof zoomSdk[name] !== 'function') {
    return false;
  }
  return !unsupportedApis.has(name);
}

/**
 * Call an SDK method by name, through its wrapper where one exists and through
 * the generic bridge where one does not.
 *
 * callZoomApi(apiName, data) is public on the SDK prototype. It stamps a call id
 * onto `{apiName, data}` and posts it to the native client; an apiName with no
 * compatibility entry passes through untouched rather than being rejected. So a
 * granted capability is callable whether or not the npm package caught up.
 *
 * Callers must still gate on isApiAvailable. This only makes the call possible,
 * not safe: an ungranted API rejects at the bridge exactly as it always did.
 *
 * @param {string} name - SDK method name
 * @param {object} [data] - Request payload, omitted for the getters that take none
 * @param {number} [timeoutMs] - Bridge path only; the wrappers take no timeout
 * @returns {Promise<any>}
 */
function callSdkApi(name, data, timeoutMs) {
  if (typeof zoomSdk[name] === 'function') {
    return data === undefined ? zoomSdk[name]() : zoomSdk[name](data);
  }
  return zoomSdk.callZoomApi(name, data, timeoutMs);
}

// How long to wait for the pixels of the user's own background.
//
// callZoomApi rejects on its own after 10s, which is correct for a call the user
// is waiting on and far too long for this one: it sits between pressing FINISH
// and the video coming back. A client that takes the call but never answers —
// which is what an unrecognised apiName looks like from here — would freeze the
// handover for ten seconds and then remove anyway.
//
// Short is safe because this is almost always a cache hit: the prefetch starts
// when the speech starts, minutes before any restore needs it.
const BACKGROUND_PIXELS_TIMEOUT_MS = 4000;

// Overlay mode constants.
//
// Two families, and the difference matters at every call site below:
//   card / camera - push an image into the video pipeline (videoFilter or
//                   virtualBackground). The color rides on the user's tile.
//   stage         - puts the app's own UI on screen instead, pushing no pixels at
//                   all: the color is DOM rendered by the app, and the user's
//                   camera and background are left untouched.
export const OVERLAY_MODE_CARD = 'card';
export const OVERLAY_MODE_CAMERA = 'camera';
export const OVERLAY_MODE_STAGE = 'stage';
// What the Live tab starts in when nothing is saved. Timer + Camera is the pick
// because it keeps the organizer's face on screen: the color goes behind them
// rather than over them, which is what a first-time organizer expects a video
// timer to do. Like the card it changes nothing about the meeting on its own —
// no window undocks and no share starts. The stage is a deliberate choice the
// organizer makes from the menu, never where they land. On clients that never
// granted setVirtualBackground, camera mode degrades to the card pipeline.
export const DEFAULT_OVERLAY_MODE = OVERLAY_MODE_CAMERA;

// Modes an older build may have persisted, before sharing and popping out became
// actions taken from inside the stage rather than modes of their own. Only the
// window one is carried over: a saved preference must never start a screen share.
export const LEGACY_OVERLAY_MODES = { popout: OVERLAY_MODE_STAGE };

/**
 * The organizer's saved mode, migrated and validated, or the default.
 * Exported so the Live tab seeds its menu from the same answer.
 */
export function resolvePersistedOverlayMode() {
  const persisted = loadOverlayMode();
  const migrated = LEGACY_OVERLAY_MODES[persisted] || persisted;
  const known = [OVERLAY_MODE_STAGE, OVERLAY_MODE_CARD, OVERLAY_MODE_CAMERA];
  return known.includes(migrated) ? migrated : DEFAULT_OVERLAY_MODE;
}

// Starts on the *persisted* mode, never blindly on the default. Zoom re-creates
// this webview every time the panel is closed and reopened, and the Live tab
// restores the saved mode into its menu — so waking up on the default here put
// the two out of agreement, and every push then drove the wrong pipeline. With
// Timer + Camera saved, that meant setVideoFilter covering the organizer's face
// with the full card while the menu promised their face would show; clearing
// could not stick, because the running timer re-pushed the filter on the next
// status change.
let currentOverlayMode = resolvePersistedOverlayMode();

/**
 * Whether a mode drives the video pipeline. The stage shows the color through the
 * app's own UI, so pushing a background as well would put it in two places.
 * @param {string} [mode] - Defaults to the current mode
 * @returns {boolean}
 */
export function isVideoOverlayMode(mode = currentOverlayMode) {
  return mode === OVERLAY_MODE_CARD || mode === OVERLAY_MODE_CAMERA;
}

// Track SDK initialization state
let sdkInitialized = false;
let sdkAvailable = false;
// The in-flight or settled initialization, so everyone awaits the same one.
// sdkInitialized says init has *started*; only this says when it has finished.
let sdkInitPromise = null;

// Track last error for debugging
let lastError = null;

// Log callback function - will be set by LiveTab component
let logCallback = null;

// Cache of in-flight and resolved ImageData loads, keyed by image URL. Storing
// the promise (not just the result) means a preload and a concurrent apply share
// one download + decode instead of each doing the whole job.
const imageDataCache = new Map();

// The overlay currently pushed to Zoom, or null if none:
//   { url, mode, budget, pipeline, label }
// budget is the overlay size the pixels were rendered for, or null for a fileUrl
// push, which carries no pixels and so never goes stale on a resolution change.
// pipeline says which SDK pipeline the push went through ('filter' or
// 'background'), which is no longer implied by the mode: Timer + Camera
// degrades to the filter on clients that refused setVirtualBackground. label is
// the elapsed-time readout baked into a filter frame, or null for a plain card
// — background frames never carry one; camera mode's readout is a virtual
// foreground tracked in activeForeground instead.
let activeOverlay = null;

// The elapsed-time readout to render onto pushed frames, e.g. '02:35', or null
// while no speech is being timed. In card mode the readout is baked into the
// filter frame, so each advance re-pushes the pixels. In camera mode it rides
// its own virtual-foreground layer instead: the Zoom client saves every image
// handed to setVirtualBackground to the user's disk as a new custom
// background, so baking a per-second readout into background frames was
// leaving thousands of one-second background files behind. The foreground
// replaces rather than accumulates, and the background stays one of four
// fixed files the client fetches by URL.
let overlayTimeLabel = null;

// Where the readout sits on the frame: normalized (0-1) center of the text.
// Upper-left by default, just below the badge that occupies the
// card's actual top-left corner. Not centered: the middle of the tile is
// where camera mode puts the organizer's head, which would hide a centered
// readout. The organizer repositions it by dragging the badge on the Live
// tab's preview; persisted because the choice is about where their own face
// is, which does not change between meetings.
export const DEFAULT_OVERLAY_TIME_POSITION = { x: 0.18, y: 0.3 };

// How tall the readout is, as a fraction of the frame. The +/- buttons beside
// the drag badge step through this range; the floor keeps the text a readable
// sliver rather than nothing, the ceiling keeps it from filling the tile.
export const DEFAULT_OVERLAY_TIME_SCALE = 0.18;
export const OVERLAY_TIME_SCALE_MIN = 0.06;
export const OVERLAY_TIME_SCALE_MAX = 0.33;

const storedReadout = loadOverlayTimeReadout();
let overlayTimePosition =
  storedReadout?.x !== undefined && storedReadout?.y !== undefined
    ? { x: storedReadout.x, y: storedReadout.y }
    : DEFAULT_OVERLAY_TIME_POSITION;
let overlayTimeScale = storedReadout?.scale ?? DEFAULT_OVERLAY_TIME_SCALE;
let overlayTimeVisible = storedReadout?.visible ?? true;

function persistOverlayTimeReadout() {
  saveOverlayTimeReadout({
    x: overlayTimePosition.x,
    y: overlayTimePosition.y,
    scale: overlayTimeScale,
    visible: overlayTimeVisible,
  });
}

/**
 * The readout the next frame should carry: the elapsed time, or null when
 * there is none to show — no speech, or the organizer switched it off.
 */
function effectiveTimeLabel() {
  return overlayTimeVisible ? overlayTimeLabel : null;
}

/**
 * Whether the camera-mode background pipeline is what is (or would be) on the
 * user's video — the pipeline whose readout rides the foreground layer.
 *
 * Falls back to the persisted flag when the in-memory record is gone: Zoom
 * re-creates the webview whenever the panel is closed and reopened, which
 * wipes activeOverlay while the background it described is still on the
 * video. Without the fallback, dragging the readout right after reopening
 * the panel repainted nothing until a color change rebuilt the record.
 */
function backgroundPipelineActive() {
  // 'band' is camera mode over a video background: no card was pushed, but the
  // readout still rides the foreground layer rather than a filter frame.
  if (activeOverlay) return activeOverlay.pipeline === 'background' || activeOverlay.pipeline === 'band';
  return (
    (virtualBackgroundApplied || virtualForegroundApplied) &&
    currentOverlayMode === OVERLAY_MODE_CAMERA
  );
}

/** Repaint the readout participants see, wherever it currently lives. */
function repaintOverlayFrame() {
  if (!isVideoOverlayMode()) return;
  // The background pipeline never carries the readout — it rides its own
  // foreground layer — so a ticking clock must only touch that layer. Pushing
  // the background here instead would hand the Zoom client an image to save
  // to the user's disk once a second.
  if (backgroundPipelineActive()) {
    enqueueOverlayOp(() => syncForegroundReadout());
    return;
  }
  if (activeOverlay?.url) applyOverlay(activeOverlay.url);
}

/** @returns {{x: number, y: number}} Normalized center of the readout */
export function getOverlayTimePosition() {
  return { ...overlayTimePosition };
}

/**
 * Move the readout and repaint the frame participants are watching.
 * @param {{x: number, y: number}} position - Normalized (0-1) center
 */
export function setOverlayTimePosition(position) {
  const x = Number(position?.x);
  const y = Number(position?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const next = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  if (next.x === overlayTimePosition.x && next.y === overlayTimePosition.y) return;
  overlayTimePosition = next;
  persistOverlayTimeReadout();
  // Only a frame that is actually carrying the readout needs repainting.
  if (effectiveTimeLabel()) repaintOverlayFrame();
}

/** @returns {number} Readout height as a fraction of the frame */
export function getOverlayTimeScale() {
  return overlayTimeScale;
}

/**
 * Resize the readout and repaint the frame participants are watching.
 * @param {number} scale - Text height as a fraction of the frame; clamped
 * @returns {number} The scale actually applied
 */
export function setOverlayTimeScale(scale) {
  const value = Number(scale);
  if (!Number.isFinite(value)) return overlayTimeScale;
  const next = Math.min(OVERLAY_TIME_SCALE_MAX, Math.max(OVERLAY_TIME_SCALE_MIN, value));
  if (next === overlayTimeScale) return overlayTimeScale;
  overlayTimeScale = next;
  persistOverlayTimeReadout();
  if (effectiveTimeLabel()) repaintOverlayFrame();
  return overlayTimeScale;
}

/** @returns {boolean} Whether the readout is shown on pushed frames */
export function isOverlayTimeVisible() {
  return overlayTimeVisible;
}

/**
 * Show or hide the readout, repainting the frame either way: hiding a readout
 * that is up must push a plain frame, not merely stop updating.
 * @param {boolean} visible
 */
export function setOverlayTimeVisible(visible) {
  const next = Boolean(visible);
  if (next === overlayTimeVisible) return;
  overlayTimeVisible = next;
  persistOverlayTimeReadout();
  if (overlayTimeLabel) repaintOverlayFrame();
}

/**
 * Set the elapsed-time readout and repaint what other participants see.
 *
 * Driven by the timer once per second while a speech runs. Each change
 * repaints the readout where it lives — baked into the filter frame in card
 * mode, on its own virtual-foreground layer in camera mode; the overlay queue
 * coalesces pushes a slow client cannot keep up with, so the readout skips
 * ahead rather than lagging behind. Clearing the label never re-pushes — null
 * means the speech is over, and whatever teardown or status push follows owns
 * the tile. A hidden readout never re-pushes either: the frame it would
 * repaint is identical.
 *
 * @param {string|null} label - Formatted elapsed time, or null between speeches
 */
export function setOverlayTimeLabel(label) {
  const next = label ?? null;
  if (next === overlayTimeLabel) return;
  overlayTimeLabel = next;
  if (next && overlayTimeVisible) repaintOverlayFrame();
}

/**
 * Bake the elapsed-time readout into a frame. Exported for testing.
 *
 * Drawn at the organizer's chosen position, clamped so the text never runs off
 * the frame. White digits over a dark keyline stay readable on all four
 * colors, yellow included — and over whatever the camera mode's cutout leaves
 * visible around the face.
 *
 * @param {ImageData} base - Decoded background (not mutated; it is cached)
 * @param {string} label - Formatted elapsed time
 * @param {{x: number, y: number}} [position] - Normalized center of the text
 * @param {number} [scale] - Text height as a fraction of the frame
 * @returns {ImageData} A new frame with the readout drawn on
 */
export function renderTimeOnFrame(base, label, position = overlayTimePosition, scale = overlayTimeScale) {
  const canvas = document.createElement('canvas');
  canvas.width = base.width;
  canvas.height = base.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(base, 0, 0);
  drawTimeReadout(ctx, base.width, base.height, label, position, scale);
  return ctx.getImageData(0, 0, base.width, base.height);
}

/** The drawing itself, shared by the baked (card) and layered (camera) paths. */
function drawTimeReadout(ctx, width, height, label, position, scale) {
  const fontSize = Math.round(height * scale);
  ctx.font = `bold ${fontSize}px 'Helvetica Neue', Helvetica, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const pad = Math.round(height * 0.04);
  const textWidth = ctx.measureText(label).width;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const x = Math.round(clamp(position.x * width, pad + textWidth / 2, width - pad - textWidth / 2));
  const y = Math.round(clamp(position.y * height, pad + fontSize / 2, height - pad - fontSize / 2));
  ctx.lineWidth = Math.max(2, Math.round(fontSize / 12));
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.strokeText(label, x, y);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, x, y);
}

// What the foreground layer is sized to when the camera has not reported.
// 720p is what Zoom sends for most cameras; the ceiling keeps a 4K report
// under the SDK's 15MB encoding limit (1920x1080 RGBA is ~8MB).
const FOREGROUND_FALLBACK_SIZE = { width: 1280, height: 720 };
const FOREGROUND_CEILING_WIDTH = 1920;
const FOREGROUND_CEILING_HEIGHT = 1080;

/**
 * The frame size for the foreground layer: the camera resolution, exactly.
 *
 * Deliberately NOT getOverlayBudget(). The 640x360 overlay ceiling is right
 * for backgrounds and filters, which the client scales to fill the video —
 * but the foreground is composited onto the video 1:1 from the top-left
 * corner. Rendered at the budget size on a 720p stream, the layer covered
 * only the top-left quadrant, so the readout's right edge was the video's
 * center: dragging it toward the bottom-right pinned it just left of middle.
 * This is why the SDK recommends the resolution from onMyMediaChange here.
 */
function getForegroundBudget() {
  if (!cameraResolution) return { ...FOREGROUND_FALLBACK_SIZE };
  return {
    width: Math.min(cameraResolution.width, FOREGROUND_CEILING_WIDTH),
    height: Math.min(cameraResolution.height, FOREGROUND_CEILING_HEIGHT),
  };
}

// How thick the color band is, as a fraction of the frame's shorter side. The
// band is only used where the card cannot be: an organizer whose own
// background is a video. It has to carry the same signal the card does, read
// from a gallery tile a couple of centimetres across.
const CAMERA_BAND_THICKNESS = 0.075;

/**
 * Render the foreground layer: the readout, and — when a color is given — a
 * band framing the video behind it. Transparent everywhere else. Exported for
 * testing.
 *
 * The band is drawn only for an organizer whose own background is a video.
 * Every other background is replaced by the timing card outright, which is
 * what participants have always seen; a video cannot be replaced, because
 * nothing in the SDK puts one back, so its color signal rides the foreground
 * instead and the video keeps playing underneath.
 *
 * @param {string|null} color - CSS color for the band, or null for no band
 * @param {string|null} label - Formatted elapsed time, or null for no readout
 * @param {{width: number, height: number}} [budget] - Frame size
 * @param {{x: number, y: number}} [position] - Normalized center of the text
 * @param {number} [scale] - Text height as a fraction of the frame
 * @returns {ImageData} A transparent frame carrying the band and the readout
 */
export function renderTimeForeground(
  color,
  label,
  budget = getForegroundBudget(),
  position = overlayTimePosition,
  scale = overlayTimeScale
) {
  const canvas = document.createElement('canvas');
  canvas.width = budget.width;
  canvas.height = budget.height;
  const ctx = canvas.getContext('2d');
  if (color) {
    const thickness = Math.max(
      2,
      Math.round(Math.min(budget.width, budget.height) * CAMERA_BAND_THICKNESS)
    );
    ctx.fillStyle = color;
    // Four rects rather than a stroked rectangle: a stroke straddles the path,
    // so half of it would fall outside the frame and every edge would read as
    // half the thickness asked for.
    ctx.fillRect(0, 0, budget.width, thickness);
    ctx.fillRect(0, budget.height - thickness, budget.width, thickness);
    ctx.fillRect(0, thickness, thickness, budget.height - 2 * thickness);
    ctx.fillRect(budget.width - thickness, thickness, thickness, budget.height - 2 * thickness);
  }
  if (label) drawTimeReadout(ctx, budget.width, budget.height, label, position, scale);
  return ctx.getImageData(0, 0, budget.width, budget.height);
}

/**
 * The band color for a timing card: the average of its outer edge. Exported
 * for testing.
 *
 * Sampled rather than looked up by status name, because the organizer can
 * upload their own card artwork — a table of four hex values would paint a
 * custom red card in the built-in red. The edge is sampled, not the whole
 * image, so the wordmark in the middle of every built-in card cannot drag the
 * average toward grey.
 *
 * @param {ImageData} imageData - Decoded card
 * @returns {string|null} A CSS rgb() color, or null if nothing was sampleable
 */
export function sampleCardBandColor(imageData) {
  const { width, height, data } = imageData;
  if (!width || !height) return null;
  // Inset a little: a card may carry a border of its own, and the very outermost
  // row is where an antialiased edge would be.
  const inset = Math.min(
    Math.floor(Math.min(width, height) / 2),
    Math.max(1, Math.round(Math.min(width, height) * 0.06))
  );
  let red = 0;
  let green = 0;
  let blue = 0;
  let counted = 0;
  const take = (x, y) => {
    const i = (y * width + x) * 4;
    // A transparent pixel has no color to contribute; averaging its zeroes in
    // would darken the band.
    if (data[i + 3] < 128) return;
    red += data[i];
    green += data[i + 1];
    blue += data[i + 2];
    counted += 1;
  };
  // Every pixel of the ring is far more than an average needs.
  const step = Math.max(1, Math.round(Math.min(width, height) / 64));
  for (let x = 0; x < width; x += step) {
    take(x, inset);
    take(x, height - 1 - inset);
  }
  for (let y = 0; y < height; y += step) {
    take(inset, y);
    take(width - 1 - inset, y);
  }
  if (!counted) return null;
  return `rgb(${Math.round(red / counted)}, ${Math.round(green / counted)}, ${Math.round(blue / counted)})`;
}

// Band colors already sampled, keyed by card URL, so a color change costs a
// cache hit rather than a re-decode. Cleared with the decoded pixels whenever
// the artwork changes.
const cardBandColorCache = new Map();

/**
 * The band color for a card URL, decoding it once and remembering the answer.
 * @param {string} imageUrl
 * @returns {Promise<string|null>}
 */
async function loadCardBandColor(imageUrl) {
  if (cardBandColorCache.has(imageUrl)) return cardBandColorCache.get(imageUrl);
  const color = sampleCardBandColor(await loadImageAsImageData(imageUrl));
  cardBandColorCache.set(imageUrl, color);
  return color;
}

// Camera resolution reported by onMyMediaChange, or the last one persisted.
//
// Persisted because Zoom re-creates the webview whenever the panel is closed
// and reopened, and onMyMediaChange only fires on changes — a reopened panel
// may never hear the resolution again. The foreground layer is composited
// onto the video 1:1, so rendering it at the 720p fallback on any other
// stream maps the readout to the wrong spot, or off the video entirely; the
// last-known real value beats a guess.
const CAMERA_RESOLUTION_KEY = 'toastmaster_zoom_camera_resolution';

function readPersistedCameraResolution() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CAMERA_RESOLUTION_KEY));
    const width = Number(parsed?.width);
    const height = Number(parsed?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

let cameraResolution = readPersistedCameraResolution();

// Whether a virtual background of ours is currently on the user's video.
//
// Tracked separately from activeOverlay because it gates a user-visible cost:
// removeVirtualBackground always raises a confirmation dialog in the client, by
// Zoom's design, returning 10017 if the user declines. Calling it blindly means
// a "remove the video filter?" prompt every time, so it is only called when
// there is genuinely something of ours to remove. setVideoFilter's counterpart,
// deleteVideoFilter, prompts for nothing and needs no such guard.
//
// Persisted, because Zoom reloads the app's webview every time the panel is
// closed and reopened. A purely in-memory flag reads false in precisely the
// situation the "Clear Background" button exists for: a background of ours left
// on the tile by an earlier session.
const VIRTUAL_BACKGROUND_APPLIED_KEY = 'toastmaster_zoom_virtual_background_applied';

function readVirtualBackgroundApplied() {
  try {
    return localStorage.getItem(VIRTUAL_BACKGROUND_APPLIED_KEY) === 'true';
  } catch {
    return false;
  }
}

let virtualBackgroundApplied = readVirtualBackgroundApplied();

/**
 * Record whether one of our virtual backgrounds is on the user's video.
 * @param {boolean} applied
 */
function markVirtualBackgroundApplied(applied) {
  virtualBackgroundApplied = applied;
  try {
    if (applied) localStorage.setItem(VIRTUAL_BACKGROUND_APPLIED_KEY, 'true');
    else localStorage.removeItem(VIRTUAL_BACKGROUND_APPLIED_KEY);
  } catch {
    // Storage unavailable (private mode). The in-memory flag still holds for
    // this session, which is the pre-existing behaviour.
  }
}

// Whether a count-up readout of ours is on the user's video as a virtual
// foreground. Persisted for the same reason as the background flag: Zoom
// re-creates the webview whenever the panel is reopened, and a readout left
// up by the previous webview still needs taking down.
const VIRTUAL_FOREGROUND_APPLIED_KEY = 'toastmaster_zoom_virtual_foreground_applied';

function readVirtualForegroundApplied() {
  try {
    return localStorage.getItem(VIRTUAL_FOREGROUND_APPLIED_KEY) === 'true';
  } catch {
    return false;
  }
}

let virtualForegroundApplied = readVirtualForegroundApplied();

// What the pushed foreground currently shows, so a repaint that would draw the
// identical layer skips the bridge call. In-memory only: after a webview
// reload the next sync simply pushes fresh over whatever is there.
let activeForeground = null;

// The band color the foreground is carrying, or null when the layer is a bare
// readout over one of our cards. Non-null only for an organizer whose own
// background is a video — the one background camera mode will not replace.
let cameraBandColor = null;

/**
 * Record whether a count-up readout of ours is on the user's video.
 * @param {boolean} applied
 */
function markVirtualForegroundApplied(applied) {
  virtualForegroundApplied = applied;
  if (!applied) activeForeground = null;
  try {
    if (applied) localStorage.setItem(VIRTUAL_FOREGROUND_APPLIED_KEY, 'true');
    else localStorage.removeItem(VIRTUAL_FOREGROUND_APPLIED_KEY);
  } catch {
    // See markVirtualBackgroundApplied.
  }
}

/**
 * Make the virtual foreground match the readout that should be showing: push
 * the current label as a transparent layer over the camera-mode background,
 * or take the layer off when there is nothing left to show.
 *
 * Never throws — the readout is a bonus, and failing to draw the time must
 * never take the color signal down with it. Runs inside the overlay queue:
 * applyOverlayInternal and removeOverlayInternal call it from their own
 * queued turns, and repaintOverlayFrame enqueues it directly.
 */
async function syncForegroundReadout() {
  if (!sdkAvailable || !zoomSdk) return;

  // Only the camera pipeline pairs the readout with a foreground layer; the
  // card bakes it into the filter frame instead.
  const live = backgroundPipelineActive();
  const label = live ? effectiveTimeLabel() : null;
  // The band is the whole timing signal where it is used, so unlike the readout
  // it must stay up for the entire speech — including the stretches where the
  // organizer has hidden the clock.
  const color = live ? cameraBandColor : null;

  if (!label && !color) {
    await removeForegroundReadout();
    return;
  }

  // The refusal is warned about at push time, where the organizer acted.
  if (!isApiAvailable('setVirtualForeground')) return;

  const budget = getForegroundBudget();
  if (
    activeForeground &&
    activeForeground.color === color &&
    activeForeground.label === label &&
    activeForeground.position.x === overlayTimePosition.x &&
    activeForeground.position.y === overlayTimePosition.y &&
    activeForeground.scale === overlayTimeScale &&
    activeForeground.width === budget.width &&
    activeForeground.height === budget.height
  ) {
    return;
  }

  // Once per size, not per second: this is the number to compare against
  // where the readout actually lands when its position looks wrong.
  if (!activeForeground || activeForeground.width !== budget.width || activeForeground.height !== budget.height) {
    const cameraNote = cameraResolution
      ? `camera ${cameraResolution.width}x${cameraResolution.height}`
      : 'camera unreported, assuming 720p';
    log(`Count-up readout frame: ${budget.width}x${budget.height} (${cameraNote})`, 'info');
    if (cameraResolution && (cameraResolution.width > budget.width || cameraResolution.height > budget.height)) {
      log('Camera exceeds the readout frame ceiling; the readout can only reach the top-left part of the video', 'warn');
    }
  }

  try {
    const frame = renderTimeForeground(color, label, budget);
    // "meeting" persistence: the client takes the layer down itself when the
    // meeting ends, so a closed panel or a crashed app strands nothing.
    await zoomSdk.setVirtualForeground({ imageData: frame, persistence: 'meeting' });
    markVirtualForegroundApplied(true);
    activeForeground = {
      color,
      label,
      position: { ...overlayTimePosition },
      scale: overlayTimeScale,
      width: budget.width,
      height: budget.height,
    };
  } catch (error) {
    log(`Could not push the count-up readout: ${error.message || error.name}`, 'warn');
  }
}

/**
 * Take the readout layer off the user's video, if one of ours is up. Explicit
 * rather than inferred, so teardown never depends on the label heuristic — a
 * mode switch mid-speech still has a ticking label, and the removal must win.
 * Never throws.
 */
async function removeForegroundReadout() {
  cameraBandColor = null;
  if (!sdkAvailable || !zoomSdk) return;
  if (!virtualForegroundApplied) return;
  if (!isApiAvailable('removeVirtualForeground')) {
    log('Client did not grant removeVirtualForeground; leaving the readout in place', 'warn');
    return;
  }
  try {
    await zoomSdk.removeVirtualForeground();
    markVirtualForegroundApplied(false);
    log('Removed the count-up readout', 'info');
  } catch (error) {
    if (error.code === ERROR_NOTHING_APPLIED) {
      markVirtualForegroundApplied(false);
    } else {
      log(`Could not remove the count-up readout: ${error.message || error.name}`, 'warn');
    }
  }
}

// What the user had on their video before ours replaced it, so that clearing
// puts them back where they were instead of stripping them to a bare camera.
//
// Shape: { type: 'none' | 'blur' | 'image', id?: string, name?: string }, or
// null when the client could not say — in which case nothing here applies and
// the old remove-and-hope path runs unchanged.
const PREVIOUS_BACKGROUND_KEY = 'toastmaster_zoom_previous_background';

// The user's own background image as pixels, keyed by the id it came from.
//
// Not persisted, and deliberately so. An ImageData is megabytes — a 1920x1080
// frame is about 8MB of RGBA — which is past what localStorage takes at all and
// enough to make IndexedDB a real cost for something re-fetchable. The id under
// PREVIOUS_BACKGROUND_KEY is the durable half; this is only a cache in front of
// it, so a webview reload costs one more getVirtualBackgroundData call and
// nothing else.
let previousBackgroundPixels = null;

// The id whose pixels this client refused, so the restore path does not repeat a
// run of failed calls while the organizer waits for their video back. Discarded
// with the record it belongs to, since a new background deserves a fresh try.
let unfetchableBackgroundId = null;

function readPreviousBackground() {
  try {
    const raw = localStorage.getItem(PREVIOUS_BACKGROUND_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writePreviousBackground(background) {
  // Drop the pixels only when they stop describing what is recorded. Re-reading
  // the same background before every speech is the normal case — the organizer
  // keeps one background all meeting — and dropping the cache on each of those
  // would re-fetch megabytes for the image we just put back.
  if (background?.type !== 'image' || previousBackgroundPixels?.id !== background.id) {
    previousBackgroundPixels = null;
  }
  if (background?.type !== 'image' || unfetchableBackgroundId !== background.id) {
    unfetchableBackgroundId = null;
  }
  try {
    if (background) localStorage.setItem(PREVIOUS_BACKGROUND_KEY, JSON.stringify(background));
    else localStorage.removeItem(PREVIOUS_BACKGROUND_KEY);
  } catch {
    // See markVirtualBackgroundApplied.
  }
}

/** The first of these that is a usable, non-empty string. */
function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim();
}

/**
 * Reduce whatever the client reports to { type, id, name }.
 *
 * The real shape, from a 5.17 desktop client, is:
 *
 *   { currentBackground: {...} | null, currentBackgroundSetting: 'none' | 'blur' | ... }
 *
 * with currentBackgroundSetting saying which of the three states applies and
 * currentBackground identifying the image when one is up. That is what the
 * documentation describes in prose — "the virtual background that is currently
 * applied, or if the current background setting is None or Blur" — and it is two
 * fields, not one. Reading only the object was what made a real answer look
 * unrecognisable, and the clear then removed the organizer's bookshelf instead of
 * putting it back.
 *
 * Still deliberately tolerant, and still gives up rather than guesses. These APIs
 * are grantable in the Marketplace but absent from @zoom/appssdk 0.16.36,
 * 0.16.40, 0.16.41 and the CDN bundle, so nothing here can be pinned to a typing
 * — the shape above is what a client was observed to send, not what a contract
 * promises. The older key spellings stay accepted for that reason. Returning null
 * means "the client did not tell us", which every caller treats as the old
 * behaviour rather than as an answer. A wrong guess would be worse than no guess:
 * it decides whether the user gets a confirmation dialog they did not need.
 *
 * @param {any} raw
 * @returns {{type: string, id?: string, name?: string}|null}
 */
export function normalizeVirtualBackground(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // getVirtualBackgrounds returns the saved list alongside the applied one; the
  // single getter returns the applied one alone. Both carry it under these keys.
  const applied =
    raw.currentBackground ?? raw.currentVirtualBackground ?? raw.current ?? raw.virtualBackground ?? raw;
  // Zoom may name the applied background by object or by bare id.
  const asObject = applied && typeof applied === 'object' ? applied : null;
  // currentBackgroundId is how getVirtualBackgrounds names it — that response has
  // no applied-background object at all, only an id beside the saved list. Without
  // this, a client granting only that getter reads as "did not say".
  const id = firstString(
    asObject?.id,
    typeof applied === 'string' ? applied : undefined,
    raw.currentBackgroundId
  );
  // The list is the only place a name for that id exists, and a name is what the
  // organizer is told about when a restore cannot happen.
  const listed = [raw.backgrounds, raw.virtualBackgrounds, raw.list]
    .find(Array.isArray)
    ?.find((entry) => entry && typeof entry === 'object' && firstString(entry.id) === id);
  const name = firstString(asObject?.name, asObject?.fileName, listed?.name, listed?.fileName);

  // The setting is the authority on which of the three states is up, because it
  // is the only field that distinguishes "none" from "the client did not say".
  const setting = firstString(raw.currentBackgroundSetting, raw.backgroundSetting, raw.setting);
  const state = (setting || firstString(asObject?.type, id, name) || '').toLowerCase();
  if (state === 'none') return { type: 'none' };
  if (state === 'blur') return { type: 'blur' };

  if (!id && !name) return null;

  // A video is called out separately because it is the one background nothing
  // can put back: setVirtualBackground takes imageData, a fileUrl or blur, and
  // none of those is a video. Collapsing it into 'image' is what made the clear
  // path promise a restore it could not perform and then drop the organizer to
  // None — their looping beach gone, with no way to notice until they saw it.
  // Named as what it is, camera mode declines to replace it at all.
  const isVideo =
    state === 'video' ||
    asObject?.isVideo === true ||
    listed?.isVideo === true ||
    VIDEO_BACKGROUND_FILE.test(name || '');
  if (isVideo) return { type: 'video', ...(id && { id }), ...(name && { name }) };

  // Anything else is an actual image: the id identifies it, the name is for
  // telling the user which one we could not put back.
  return { type: 'image', ...(id && { id }), ...(name && { name }) };
}

// Extensions Zoom accepts for a video background. Only consulted when the
// client did not say outright — the explicit fields above are the answer
// wherever they are present, and this is the fallback for a client that names
// the file and nothing more.
const VIDEO_BACKGROUND_FILE = /\.(mp4|mov|m4v|avi|wmv|webm|mkv)$/i;

/** Whether two reads describe the same background. */
function sameBackground(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type !== 'image' && a.type !== 'video') return true;
  return a.id ? a.id === b.id : a.name === b.name;
}

/**
 * Normalize a getter's response, and say what it was when that fails.
 *
 * The shape is not in any shipped typing, so a response we do not recognise is a
 * real possibility rather than a theoretical one — and it is indistinguishable
 * from an ungranted API at the call site. Naming the keys turns one debug-panel
 * read into the answer, without dumping an ImageData into the log.
 *
 * @param {string} api - Which getter answered, for the message
 * @param {any} raw
 * @returns {{type: string, id?: string, name?: string}|null}
 */
function readingFrom(api, raw) {
  const reading = normalizeVirtualBackground(raw);
  if (!reading) {
    log(`${api} answered in a shape this app does not recognise: ${describeShape(raw)}`, 'warn');
  }
  return reading;
}

/**
 * A one-line sketch of a response: keys and leaf values, two levels deep.
 *
 * Top-level keys alone are not enough. They said `currentBackground,
 * currentBackgroundSetting` and cost a second round-trip to learn what was inside
 * them — which is exactly the information needed to fix the parser.
 *
 * Bounded on purpose. Typed arrays are named rather than walked, because an
 * ImageData's `data` holds millions of entries and would bury the panel; strings
 * are cut short, because a data URI is not worth a screenful.
 */
function describeShape(value, depth = 0) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (typeof value !== 'object') return String(value);
  if (ArrayBuffer.isView(value)) return `${value.constructor?.name || 'TypedArray'}(${value.length})`;
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return depth >= 1 ? `array(${value.length})` : `[${describeShape(value[0], depth + 1)}, …${value.length}]`;
  }
  const keys = Object.keys(value);
  if (!keys.length) return '{}';
  if (depth >= 2) return `{${keys.join(', ')}}`;
  return `{ ${keys.map((key) => `${key}: ${describeShape(value[key], depth + 1)}`).join(', ')} }`;
}

/**
 * What is on the user's video right now, or null when the client cannot say.
 * @returns {Promise<{type: string, id?: string, name?: string}|null>}
 */
async function readCurrentVirtualBackground() {
  try {
    // Spelled out rather than indexed, so a test can see which methods this
    // module calls and hold USED_SDK_APIS to them.
    if (isApiAvailable('getCurrentVirtualBackground')) {
      return readingFrom('getCurrentVirtualBackground', await callSdkApi('getCurrentVirtualBackground'));
    }
    if (isApiAvailable('getVirtualBackgrounds')) {
      return readingFrom('getVirtualBackgrounds', await callSdkApi('getVirtualBackgrounds'));
    }
    log(
      'Client granted neither getCurrentVirtualBackground nor getVirtualBackgrounds; what the user had cannot be read at all',
      'warn'
    );
    return null;
  } catch (error) {
    log(`Could not read the current virtual background: ${error.message || error.name}`, 'warn');
    return null;
  }
}

// The organizer's uploaded background, decoded once and kept for the session.
// Same reasoning as previousBackgroundPixels: an ImageData is megabytes, and
// the Blob it came from is already durable, so this is a cache and not a store.
let ownBackgroundPixels = null;

/**
 * The pixels of the background the organizer gave us, or null when they have
 * not set one — or set one whose image cannot be decoded.
 *
 * This is the whole of the restore when it answers. No id, no getter, no saved
 * list, and nothing to identify: the organizer said which background is theirs,
 * so there is no background to pick wrongly and none to fall through to None.
 *
 * @returns {Promise<ImageData|null>}
 */
async function readOwnBackgroundPixels() {
  if (!hasOwnBackground()) return null;
  const url = getOwnBackgroundUrl();
  if (!url) {
    // initCardImages has not minted the object URL yet, or storage refused it.
    // Nothing is cached against this, because the next call may well succeed.
    log('An own background is set but its image is not loaded yet; falling back to reading what Zoom reports', 'warn');
    return null;
  }
  if (ownBackgroundPixels?.url === url) return ownBackgroundPixels.imageData;
  try {
    const imageData = await decodeToImageData(url, RESTORED_BACKGROUND_MAX);
    ownBackgroundPixels = { url, imageData };
    log(`Decoded the organizer's own background (${imageData.width}x${imageData.height})`, 'info');
    return imageData;
  } catch (error) {
    log(`Could not decode the organizer's own background: ${error.message || error.name}`, 'warn');
    return null;
  }
}

/** Drop the decoded own background, so a replacement is picked up. */
export function notifyOwnBackgroundChanged() {
  ownBackgroundPixels = null;
}

/**
 * Put the organizer's own background on their video now, so setting one shows
 * them what they set rather than a promise about the end of the next speech.
 *
 * Declines while anything of ours is on the video. A timing card is the whole
 * point of the app being on screen, and replacing one mid-speech would take the
 * color the room is reading away to show the organizer a preview — so the
 * setting waits for the video to be theirs again, which is when it applies
 * anyway. The caller is told which happened, because "nothing visibly changed"
 * and "it worked" need different words.
 *
 * Queued as a non-supersedable operation: it is a push at the same layer the
 * overlay pushes use, and dropping it would leave the organizer looking at the
 * background they just replaced.
 *
 * @returns {Promise<'applied'|'busy'|'unavailable'>}
 */
export async function applyOwnBackground() {
  await initializeZoomSdk();
  if (!sdkAvailable || !zoomSdk || !isApiAvailable('setVirtualBackground')) return 'unavailable';
  // Asked before the queue rather than inside it: what matters is whether the
  // organizer is looking at a card right now, which is what they can see.
  if (isOverlayActive()) return 'busy';

  let outcome = 'unavailable';
  await enqueueOverlayOp(
    async () => {
      const own = await readOwnBackgroundPixels();
      if (!own) return;
      try {
        await zoomSdk.setVirtualBackground({ imageData: own });
        // Deliberately not recorded as one of ours. It is the organizer's own
        // background, and a teardown must never take it off.
        log('Applied the organizer\'s own background to their video', 'info');
        outcome = 'applied';
      } catch (error) {
        log(`Could not apply the organizer's own background: ${error.message || error.name}`, 'warn');
      }
    },
    { supersedable: false }
  );
  return outcome;
}

/**
 * Take the organizer's own background off their video, for when they clear the
 * setting that put it there.
 *
 * The mirror of applyOwnBackground, and it declines in the same place: while a
 * timing card is on the video the card owns it, and the background underneath
 * is not what the organizer is looking at anyway.
 *
 * A removal is a removal — this hands them their camera, not a guess at what
 * they had before the setting existed. Nothing here knows that, and inventing
 * it is what the whole feature exists to stop doing.
 *
 * Zoom always asks the organizer to confirm a removal, so declining is a normal
 * outcome rather than a failure: the setting is still gone, and only their video
 * is unchanged. Reported separately so the caller can say which happened.
 *
 * @returns {Promise<'removed'|'declined'|'busy'|'unavailable'>}
 */
export async function removeOwnBackground() {
  await initializeZoomSdk();
  if (!sdkAvailable || !zoomSdk || !isApiAvailable('removeVirtualBackground')) return 'unavailable';
  if (isOverlayActive()) return 'busy';

  let outcome = 'unavailable';
  await enqueueOverlayOp(
    async () => {
      try {
        await zoomSdk.removeVirtualBackground();
        log('Took the organizer\'s own background off their video', 'info');
        outcome = 'removed';
      } catch (error) {
        if (error.code === ERROR_REMOVAL_DECLINED) {
          log('The organizer declined Zoom\'s removal confirmation; their video is unchanged', 'info');
          outcome = 'declined';
        } else if (error.code === ERROR_NOTHING_APPLIED) {
          // Already bare, which is the state being asked for.
          outcome = 'removed';
        } else {
          log(`Could not take the own background off: ${error.message || error.name}`, 'warn');
        }
      }
    },
    { supersedable: false }
  );
  return outcome;
}

/**
 * Turn a background id into the pixels needed to re-apply it.
 *
 * This is the call that makes restoring an image possible at all.
 * setVirtualBackground takes imageData, a fileUrl or blur, and never an id, so
 * without this step an id names a background we cannot put back.
 *
 * @param {string} id - Identifier from the current-background read
 * @param {string} [name] - Its display name, used to find it in the saved list
 * @returns {Promise<ImageData|null>} null when the client cannot supply them
 */
async function readBackgroundPixels(id, name) {
  if (!id) return null;
  // Said out loud, because this is the difference between the organizer getting
  // their bookshelf back and getting Zoom's "reset to none" dialog. It used to
  // return null in silence, which made an un-ticked Marketplace capability look
  // exactly like a broken restore.
  if (!isApiAvailable('getVirtualBackgroundData')) {
    log(
      'Client did not grant getVirtualBackgroundData, so the pixels of the user\'s own background cannot be read. Enable it for the app in the Zoom Marketplace; without it a clear can only remove.',
      'warn'
    );
    return null;
  }
  if (previousBackgroundPixels?.id === id) return previousBackgroundPixels.imageData;
  // A failure is cached as firmly as a success. Without this, the run of attempts
  // below repeats on the restore path — at the one moment the organizer is waiting
  // for their video back, and to reach the same answer it already had.
  if (unfetchableBackgroundId === id) return null;

  const tryCandidate = async (candidate) => {
    for (const build of BACKGROUND_DATA_PAYLOADS) {
      const payload = build(candidate);
      const imageData = await fetchBackgroundPixels(payload);
      if (!imageData) continue;
      previousBackgroundPixels = { id, imageData };
      log(
        `Fetched pixels for the user's own background (${imageData.width}x${imageData.height}) using ${describeShape(payload)}`,
        'info'
      );
      return imageData;
    }
    return null;
  };

  // The id from the current-background read first, so a client that accepts it
  // costs exactly one call. The saved list is consulted only once that is refused.
  const direct = await tryCandidate(id);
  if (direct) return direct;

  for (const candidate of await otherIdsFor(name, id)) {
    log(`Retrying with the id the saved list uses for "${name}": ${candidate}`, 'info');
    const viaList = await tryCandidate(candidate);
    if (viaList) return viaList;
  }

  unfetchableBackgroundId = id;
  return null;
}

// Payload spellings to try for getVirtualBackgroundData, best first.
//
// backgroundId is the one a 7.1.5 desktop client accepts; id and
// virtualBackgroundId are both refused with code 10002, "Validation error, please
// check API parameters". No shipped typing names the field, so the others stay as
// fallbacks rather than being deleted — a wrong key on a getter errors and
// changes nothing, and the log names whichever one answered.
const BACKGROUND_DATA_PAYLOADS = [
  (id) => ({ backgroundId: id }),
  (id) => ({ id }),
  (id) => ({ virtualBackgroundId: id }),
];

// Ceiling for a restored background, in pixels per side.
//
// setVirtualBackground documents imageData as "limited to 15MB after encoding",
// and RGBA costs 4 bytes a pixel: 1920x1080 is 8.3MB, and 2560x1440 would be
// 14.7MB with nothing to spare. The overlay budget is not used here — it is
// 640x360, sized for a card that is about to be overwritten every second, and
// handing someone's own background back at that size would visibly degrade it.
const RESTORED_BACKGROUND_MAX = { width: 1920, height: 1080 };

/**
 * One attempt at the pixels. Logs exactly what it sent, so a rejection says which
 * payload was rejected rather than only that something was.
 *
 * @param {object} payload
 * @returns {Promise<ImageData|null>}
 */
async function fetchBackgroundPixels(payload) {
  try {
    const raw = await callSdkApi('getVirtualBackgroundData', payload, BACKGROUND_PIXELS_TIMEOUT_MS);

    // What a 7.1.5 desktop client actually sends back is an encoded image, not
    // pixels: { imageData: { data: "/9j/4AAQSkZJRgABAQAASABIAAD…" } }, which is a
    // base64 JPEG. The name `imageData` is misleading — it is not the ImageData
    // that setVirtualBackground takes, and reading it as one is what turned a
    // successful call into "returned no usable pixels".
    const encoded = firstString(
      raw?.imageData?.data,
      raw?.imageData,
      raw?.data?.data,
      raw?.data,
      typeof raw === 'string' ? raw : undefined
    );
    if (encoded) return await decodeEncodedBackground(encoded);

    // Still accepted, in case another client answers with real pixels. Shape-tested
    // rather than picked by key order, because an ImageData has a `data` property
    // of its own: reaching for `raw.data` first would unwrap a good ImageData down
    // to its byte array and then reject it as unusable.
    const isImageData = (value) =>
      !!value && typeof value.width === 'number' && typeof value.height === 'number' && !!value.data;
    const imageData = [raw, raw?.imageData, raw?.virtualBackgroundData].find(isImageData);
    if (imageData) return imageData;

    log(
      `getVirtualBackgroundData(${describeShape(payload)}) returned no usable pixels: ${describeShape(raw)}`,
      'warn'
    );
    return null;
  } catch (error) {
    const code = error.code ? ` (code ${error.code})` : '';
    log(
      `getVirtualBackgroundData(${describeShape(payload)}) failed${code}: ${error.message || error.name}`,
      'warn'
    );
    return null;
  }
}

/**
 * Turn the client's encoded image into the ImageData setVirtualBackground needs.
 *
 * Accepts a bare base64 payload or a full data URI, since only the former was
 * observed and the difference is one prefix. The format is sniffed from the base64
 * signature rather than assumed: "/9j/" is JPEG, "iVBORw0" is PNG. An Image
 * element decodes either, and the existing canvas helper reads the pixels out.
 *
 * @param {string} encoded - base64 image data, with or without a data: prefix
 * @returns {Promise<ImageData|null>}
 */
async function decodeEncodedBackground(encoded) {
  const uri = encoded.startsWith('data:')
    ? encoded
    : `data:${encoded.startsWith('iVBORw0') ? 'image/png' : 'image/jpeg'};base64,${encoded}`;
  try {
    const imageData = await decodeToImageData(uri, RESTORED_BACKGROUND_MAX);
    log(`Decoded the user's background from ${encoded.length} base64 chars`, 'info');
    return imageData;
  } catch (error) {
    log(`Could not decode the user's background image: ${error.message || error.name}`, 'warn');
    return null;
  }
}

/**
 * Other identifiers the *same* background might be known by, from the saved list.
 *
 * The documentation is explicit that ids for getVirtualBackgroundData "are
 * obtained through the getVirtualBackgrounds response" — not from
 * getCurrentVirtualBackground, which is where ours comes from. Those two need not
 * agree, and a stock background like "San Francisco" is exactly where they would
 * not. So when the id in hand is rejected, ask the list what it calls the same
 * background and try that instead.
 *
 * Every candidate returned here gets applied to the organizer's video if its
 * pixels come back, so a candidate that is not provably the same background is
 * not a guess worth making — it is someone else's beach on their tile. Two
 * things identify it, and nothing else counts:
 *
 *   1. An entry that lists the id we already tried, under any of its spellings.
 *      Same background, spelled the way this API wants it.
 *   2. Failing that, an entry with the same name.
 *
 * With neither — the client named the background only by an id the list does not
 * carry — the honest answer is no candidates at all. This is what the reported
 * bug was: the name filter read `!name || <matches>`, so a background the client
 * reported without a name kept *every* saved entry instead of none, and the
 * restore applied whichever unrelated one answered first. When none of them
 * answered it fell through to removal, and the organizer landed on None.
 *
 * Logs the list's shape either way. Its entries are where the correct id field
 * is named, and that is worth having in the panel when a restore misbehaves.
 *
 * @param {string} [name] - What the current background is called
 * @param {string} tried - The id already attempted, so it is not repeated
 * @returns {Promise<string[]>}
 */
async function otherIdsFor(name, tried) {
  if (!isApiAvailable('getVirtualBackgrounds')) return [];
  try {
    const raw = await callSdkApi('getVirtualBackgrounds', undefined, BACKGROUND_PIXELS_TIMEOUT_MS);
    log(`getVirtualBackgrounds answered: ${describeShape(raw)}`, 'info');
    const list = [raw?.virtualBackgrounds, raw?.backgrounds, raw?.list, raw].find(Array.isArray) || [];
    const entries = list.filter((entry) => entry && typeof entry === 'object');
    const spellings = (entry) =>
      [entry.id, entry.backgroundId, entry.virtualBackgroundId]
        .map((value) => firstString(value))
        .filter(Boolean);

    // The entry that already knows the id we tried is the same background by
    // construction, whatever it is called.
    const sameEntry = entries.find((entry) => spellings(entry).includes(tried));
    if (sameEntry) {
      return spellings(sameEntry).filter((value) => value !== tried);
    }

    if (!name) {
      log(
        `The saved list does not carry "${tried}" and the client gave no name for it, so there is no way to tell which saved background is the organizer's; not guessing`,
        'warn'
      );
      return [];
    }

    return entries
      .filter((entry) => firstString(entry.name, entry.fileName) === name)
      .flatMap(spellings)
      .filter((value) => value !== tried);
  } catch (error) {
    log(`Could not read the saved background list: ${error.message || error.name}`, 'warn');
    return [];
  }
}

/**
 * Remember what the user had, just before ours goes over the top of it.
 *
 * Only ever called when we do not believe one of ours is already applied, so
 * the snapshot is always of theirs and never of our own branded image.
 *
 * The pixel fetch is started but not awaited. It is several megabytes across the
 * bridge, and this runs immediately before the tile turns blue — making the
 * speaker wait for it would trade the thing the timer is for against a tidier
 * finish. Restoring re-fetches from the persisted id if this has not landed yet.
 */
async function snapshotUserBackground() {
  const current = await readCurrentVirtualBackground();
  if (!current) {
    // Also said out loud. With no snapshot there is nothing to restore to, and
    // every clear from here can only remove — which reads to the organizer as the
    // restore being broken rather than as the read never having happened.
    log('Could not read what the user had, so a clear will only be able to remove', 'warn');
    return;
  }
  writePreviousBackground(current);
  // Only an image has pixels worth fetching. A video has none this API can
  // return, and camera mode will leave it alone rather than try.
  if (current.type === 'image') {
    if (current.id) readBackgroundPixels(current.id, current.name).catch(() => {});
    else log(`Zoom named the user's background "${current.name}" but gave no id, so its pixels cannot be fetched`, 'warn');
  }
  log(`Remembered the user's background before replacing it: ${current.name || current.type}`, 'info');
}

/**
 * Whether one of ours is genuinely on the video, as opposed to merely recorded
 * as being there.
 *
 * The record goes stale the moment the user visits Background & Effects, and a
 * stale record is expensive: removing costs a confirmation dialog, and being
 * refused for a background that was never there is what reported "Zoom would
 * not clear your video" over a video that was already fine.
 *
 * Whenever the answer is "not ours", what is on the video is by definition the
 * user's own, so it is recorded on the way past. This is the only place that
 * learns about a background the user chose while ours was up — nothing reports
 * that change — and it is free here, because the read has already happened.
 *
 * @returns {Promise<boolean|null>} null when the client cannot say
 */
async function isOurBackgroundApplied() {
  const current = await readCurrentVirtualBackground();
  if (!current) return null;
  // Nothing at all is applied, so ours certainly is not. Worth recording as
  // theirs: someone who times a speech on a bare camera wants it bare again, and
  // "none" restores as a removal.
  if (current.type === 'none') {
    writePreviousBackground(current);
    return false;
  }
  // Their own is back up — they changed it themselves, or ours never took.
  if (sameBackground(current, readPreviousBackground())) return false;
  return true;
}

// Whether a video filter of ours is currently on the user's video.
//
// Persisted for the same reason as the background flag, and tracked separately
// from activeOverlay because the two answer different questions. activeOverlay
// answers "would this push be redundant?", and is deliberately dropped whenever
// the app comes back to the front — the user may have been in Background &
// Effects. Reading it as "is a filter of ours up?" made the clear button treat a
// genuine deleteVideoFilter failure as "there was nothing there anyway" and
// report success over a card that was still on the tile.
const VIDEO_FILTER_APPLIED_KEY = 'toastmaster_zoom_video_filter_applied';

function readVideoFilterApplied() {
  try {
    return localStorage.getItem(VIDEO_FILTER_APPLIED_KEY) === 'true';
  } catch {
    return false;
  }
}

let videoFilterApplied = readVideoFilterApplied();

/**
 * Record whether one of our video filters is on the user's video.
 * @param {boolean} applied
 */
function markVideoFilterApplied(applied) {
  videoFilterApplied = applied;
  try {
    if (applied) localStorage.setItem(VIDEO_FILTER_APPLIED_KEY, 'true');
    else localStorage.removeItem(VIDEO_FILTER_APPLIED_KEY);
  } catch {
    // See markVirtualBackgroundApplied.
  }
}

// What the app itself is doing, as opposed to what it has put on the video.
// Neither is an overlay, so neither is tracked by activeOverlay: appShareActive
// means the app is screen-shared into the meeting, appPoppedOut means it is
// undocked into its own window. Independent of each other and of the mode — they
// are actions the organizer takes from the stage, not modes.
let appShareActive = false;
let appPoppedOut = false;

// Notified when either changes, including when the user drives it from Zoom's own
// UI — the ellipsis menu for the window, the sharing toolbar for the share —
// rather than from our buttons.
let popoutChangeCallback = null;
let shareChangeCallback = null;

// Monotonic id used to drop overlay requests that a newer one has superseded.
let overlayRequestId = 0;

// Serializes SDK overlay calls; see enqueueOverlayOp.
let overlayQueue = Promise.resolve();

/**
 * Set log callback for debug panel
 * @param {Function} callback - Function to call with log messages
 */
export function setLogCallback(callback) {
  logCallback = callback;
}

/**
 * A URL as it should appear in a log line. A custom card is a data: URL that
 * can run to a megabyte; interpolating it verbatim would bury the debug panel
 * under one entry.
 */
function describeUrl(url) {
  if (typeof url === 'string' && url.startsWith('data:')) {
    return `${url.slice(0, 32)}… (custom image, ${url.length} chars)`;
  }
  return url;
}

/**
 * Internal logging function
 */
function log(message, type = 'info') {
  if (logCallback) {
    logCallback(message, type);
  }
  // Also log to console
  if (type === 'error') {
    console.error(message);
  } else if (type === 'warn') {
    console.warn(message);
  } else {
    console.log(message);
  }
}

/**
 * Initialize Zoom SDK
 */
export function initializeZoomSdk() {
  // Single-flight. The old shape flipped sdkInitialized synchronously and then
  // awaited config(), so a second caller arriving during that await saw
  // "initialized" and carried straight on with sdkAvailable still false. Every
  // guard in this module is written as `if (!sdkInitialized) await
  // initializeZoomSdk()`, which made them protect only the never-started case
  // and not the far more common started-but-not-finished one.
  //
  // main.jsx renders before it starts init, on purpose, so the whole first
  // paint happens inside that window: mount effects run, ask the SDK for
  // something, and are told it is unavailable. Returning the same promise to
  // everyone makes waiting for it the default rather than something each
  // caller has to arrange.
  if (!sdkInitPromise) sdkInitPromise = initializeZoomSdkOnce();
  return sdkInitPromise;
}

async function initializeZoomSdkOnce() {
  sdkInitialized = true;

  try {
    // Check if we're in a Zoom environment
    // The SDK will be available when running in Zoom client
    log('Initializing Zoom SDK...', 'info');
    // Landscape 16:9, matching the branded backgrounds, so Timer Window mode
    // opens close to the asset's shape instead of the old 400x600 portrait that
    // letterboxed it badly. The client clamps this: documented minimums are
    // 336x342 on Windows and 320x760 on Mac, with a 75%-of-screen maximum, so a
    // small Mac display may still force a taller window. The layered backdrop in
    // TimerStage is what keeps those cases presentable — this only improves the
    // starting point, and the user can always resize.
    const baseOptions = { popoutSize: { width: 1152, height: 648 }, version: '1.0.0' };
    let configResult;
    try {
      configResult = await zoomSdk.config({
        ...baseOptions,
        capabilities: [...REQUIRED_CAPABILITIES, ...OPTIONAL_CAPABILITIES],
      });
    } catch (optionalCapabilityError) {
      log(
        `Config failed with optional capabilities (${optionalCapabilityError.message || optionalCapabilityError.name}). Retrying with required only.`,
        'warn'
      );
      configResult = await zoomSdk.config({
        ...baseOptions,
        capabilities: [...REQUIRED_CAPABILITIES],
      });
    }

    sdkAvailable = true;
    // config() resolves whether or not every capability was granted; the
    // refusals arrive here rather than as a rejection.
    unsupportedApis = new Set(configResult?.unsupportedApis || []);
    log(`Zoom SDK initialized successfully. Config: ${JSON.stringify(configResult)}`, 'info');
    const refused = USED_SDK_APIS.filter((api) => unsupportedApis.has(api.name));
    if (refused.length) {
      log(`Client refused: ${refused.map((api) => `${api.name} (${api.purpose})`).join(', ')}`, 'warn');
    }
    subscribeToCameraResolution();
    subscribeToAppPopout();
    subscribeToAppVisibility();
    subscribeToShareApp();
    subscribeToShareScreen();
    subscribeToMeetingView();
    return true;
  } catch (error) {
    // SDK not available (running locally or not in Zoom environment)
    sdkAvailable = false;
    log('[MOCK] Zoom SDK: Running in mock mode (not in Zoom environment)', 'warn');
    log(`SDK initialization error: ${error.message || error.name} (Code: ${error.code || 'N/A'})`, 'warn');
    log('Note: Virtual backgrounds will only work when running inside Zoom client', 'warn');
    return false;
  }
}

/**
 * Open a link outside the app. The Zoom client webview ignores a plain
 * target="_blank" anchor, so links have to go through the SDK; window.open is
 * the fallback for local development and for clients that refused the openUrl
 * capability.
 *
 * @param {string} url - Absolute URL to open
 * @returns {Promise<boolean>} True if the URL was handed off successfully
 */
export async function openExternalUrl(url) {
  if (sdkAvailable && typeof zoomSdk.openUrl === 'function') {
    try {
      await zoomSdk.openUrl({ url });
      return true;
    } catch (error) {
      log(`openUrl failed, falling back to window.open: ${error.message || error.name}`, 'warn');
    }
  }

  try {
    // The Zoom webview usually refuses window.open and returns null, so the
    // return value is the only way to know the link actually went somewhere.
    if (window.open(url, '_blank', 'noopener,noreferrer')) return true;
    log(`window.open was blocked for ${url}`, 'warn');
    return false;
  } catch (error) {
    log(`Failed to open ${url}: ${error.message || error.name}`, 'error');
    return false;
  }
}

/**
 * Read Zoom's signed app context — the encrypted blob that says who opened us.
 *
 * Opaque here on purpose: it can only be decrypted with the client secret, which
 * lives in the Worker and must never reach the browser. All this does is fetch
 * it and hand it over.
 *
 * Wanted because it is the only durable identity Zoom offers without asking the
 * user for anything. getUserContext's participantUUID is meeting-scoped (see
 * readSelfParticipantUUID) and cannot recognise the same person next week, which
 * is exactly the question the app needs answered.
 *
 * Optional in every direction: an older client, a refused capability, or a guest
 * all end here with null, and the app runs anonymously.
 *
 * @returns {Promise<string|null>} base64 context string, or null
 */
export async function readAppContext() {
  await initializeZoomSdk();
  if (!sdkAvailable) return null;
  if (!isApiAvailable('getAppContext')) {
    log('getAppContext not granted by this client; staying anonymous', 'info');
    return null;
  }

  try {
    const result = await zoomSdk.getAppContext();
    const context = result?.context;
    if (typeof context === 'string' && context) return context;
    log('getAppContext returned no context string; staying anonymous', 'warn');
    return null;
  } catch (error) {
    log(`Could not read the app context: ${error.message || error.name}`, 'warn');
    return null;
  }
}

/**
 * How signed-in this user is, as Zoom sees them: 'unauthenticated' (not signed
 * into Zoom), 'authenticated' (signed in, has not added the app), or
 * 'authorized' (added the app).
 *
 * Recorded because only 'authorized' users carry a durable uid, so this is what
 * says whether an unidentifiable session is a guest or a failure on our side —
 * a distinction the retention numbers currently cannot make.
 *
 * @returns {Promise<string|null>}
 */
export async function readZoomUserStatus() {
  await initializeZoomSdk();
  if (!sdkAvailable || !isApiAvailable('getUserContext')) return null;

  try {
    const context = await zoomSdk.getUserContext();
    return typeof context?.status === 'string' ? context.status : null;
  } catch (error) {
    log(`Could not read your Zoom sign-in status: ${error.message || error.name}`, 'warn');
    return null;
  }
}

/**
 * Camera resolution reported by the client, or null if never reported.
 * @returns {{width: number, height: number}|null}
 */
export function getCameraResolution() {
  return cameraResolution ? { ...cameraResolution } : null;
}

/**
 * Track the camera resolution from an onMyMediaChange event and resize the
 * visible overlay to match. Exported for testing.
 * @param {Object} event - OnMyMediaChangeEvent
 */
export function handleMyMediaChange(event) {
  const video = event?.media?.video;
  // A payload may carry only { state } when the camera is toggled, and audio
  // events carry no video key at all.
  const width = Number(video?.width);
  const height = Number(video?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return;
  }
  if (cameraResolution && cameraResolution.width === width && cameraResolution.height === height) {
    return;
  }

  cameraResolution = { width, height };
  try {
    localStorage.setItem(CAMERA_RESOLUTION_KEY, JSON.stringify(cameraResolution));
  } catch {
    // Worst case the next webview starts from the 720p guess again.
  }
  log(`Camera resolution reported: ${width}x${height}`, 'info');

  // Anything decoded for the previous resolution is the wrong size now.
  imageDataCache.clear();

  // Re-push so what participants see matches the new resolution, but only if
  // pixels were actually rendered for the old one. A fileUrl push carries no
  // pixels — Zoom scales the file itself — so resolution has no bearing on it,
  // and a null budget is what marks that case.
  if (activeOverlay?.budget) {
    applyOverlay(activeOverlay.url);
  } else if (backgroundPipelineActive() && virtualForegroundApplied) {
    // The background needed nothing, but the readout layer is pixels rendered
    // for the old camera size — and the foreground is composited 1:1, so a
    // wrong size lands the readout in the wrong place. The sync compares
    // sizes itself and repaints only when they differ.
    enqueueOverlayOp(() => syncForegroundReadout());
  }
}

/**
 * Subscribe to camera resolution updates. Failure is non-fatal: the overlay just
 * stays at the default size.
 */
function subscribeToCameraResolution() {
  if (!zoomSdk || typeof zoomSdk.onMyMediaChange !== 'function') {
    log('onMyMediaChange unavailable; overlay stays at the default size', 'warn');
    return;
  }
  try {
    zoomSdk.onMyMediaChange(handleMyMediaChange);
    log('Subscribed to onMyMediaChange for camera resolution', 'info');
  } catch (error) {
    log(`Failed to subscribe to onMyMediaChange: ${error.message || error.name}`, 'warn');
  }
}

/**
 * Whether the app is currently screen-shared into the meeting.
 * @returns {boolean}
 */
export function isAppShareActive() {
  return appShareActive;
}

/**
 * Whether the app is currently undocked into its own window.
 * @returns {boolean}
 */
export function isAppPoppedOut() {
  return appPoppedOut;
}

// Zoom's codes for a stop aimed at a share that is not there. Both are the
// expected answer once the user has pressed Zoom's own Stop Share, not failures.
const ERROR_SHARE_NOT_STARTED = 10025;
const ERROR_NO_ONGOING_SHARE = 10189;

/**
 * Whether the client says this user is presenting, or null when it cannot say.
 *
 * Note what this can and cannot settle. `presenting` covers any share — ours, or
 * a screen share the user started themselves from Zoom's toolbar — so a true
 * never proves the thing on screen is our app. A false does prove the opposite:
 * nothing is being shared at all, so our share is certainly over. Only that
 * direction is acted on anywhere below.
 *
 * @returns {Promise<boolean|null>}
 */
async function readPresentingState() {
  if (!isApiAvailable('getMeetingView')) return null;
  try {
    const view = await zoomSdk.getMeetingView();
    return typeof view?.presenting === 'boolean' ? view.presenting : null;
  } catch (error) {
    // Documented desktop-only, and unavailable in some running contexts.
    log(`Could not read the meeting view: ${error.message || error.name}`, 'warn');
    return null;
  }
}

// When the share was last started, on the monotonic clock. The client's own view
// state does not update in the same instant the share begins, so a read taken
// just after a start can say "nobody is presenting" about a share that is coming
// up — and starting a share can hide and re-show the app, which is exactly what
// triggers the refocus check. Believing that read would flip the button back to
// "Screenshare" mid-share, which is worse than the stale label this all exists to
// fix: pressing it then asks Zoom to start a second share.
let appShareStartedAt = 0;
const SHARE_SETTLE_MS = 3000;

/** Monotonic where available; the wall clock is only a fallback. */
function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Record that the share is over, and tell whoever is showing a button for it.
 * @param {string} reason - For the debug log
 */
function markShareStopped(reason) {
  if (!appShareActive) return;
  appShareActive = false;
  log(`App share is no longer active (${reason})`, 'info');
  if (shareChangeCallback) shareChangeCallback(false);
}

/**
 * Reconcile our record of the share against what the client actually has on
 * screen, and report what is true.
 *
 * The backstop behind the three share events, for the one moment they cannot
 * cover: while the app is in the background, an event may be missed outright.
 * Called on refocus, so it is a check made when something might have changed
 * unseen — never a poll.
 *
 * Asks nothing of the client unless a share is believed to be up, and nothing at
 * all in the moments just after one starts, when the answer cannot be trusted
 * yet.
 *
 * @returns {Promise<boolean>} Whether the app share is still believed to be up
 */
export async function syncAppShareState() {
  await initializeZoomSdk();
  if (!sdkAvailable || !appShareActive) return appShareActive;
  if (now() - appShareStartedAt < SHARE_SETTLE_MS) return appShareActive;

  if ((await readPresentingState()) === false) {
    markShareStopped('Zoom reports nothing being shared');
  }
  return appShareActive;
}

/**
 * Start or stop sharing the app itself into the meeting.
 *
 * This is a screen share of the app's own webview, not a video effect: the
 * camera pipeline is untouched, so the user keeps their face and whatever
 * background they already chose. What participants see is whatever the app
 * panel is showing, which is why the stage view has to carry its own controls.
 *
 * A stop refused *because there was nothing to stop* is success rather than
 * failure: the share the organizer wanted gone is gone either way. That is the
 * common case once they have pressed Zoom's own Stop Share button, and calling
 * it an error put a toast in front of them for doing so.
 *
 * @param {boolean} active - True to start sharing, false to stop
 * @param {{withSound?: boolean}} [options]
 * @returns {Promise<boolean>} True if the client accepted the request
 */
export async function setAppShare(active, { withSound = false } = {}) {
  await initializeZoomSdk();

  if (!sdkAvailable || !zoomSdk || typeof zoomSdk.shareApp !== 'function') {
    log(`[MOCK] Would ${active ? 'start' : 'stop'} sharing the app`, 'warn');
    appShareActive = active;
    return false;
  }

  // Asked before the stop, but never instead of it. A read saying nothing is
  // being shared makes a failed stop the expected answer rather than a problem
  // to report — and the stop still goes to Zoom, because a read that has gone
  // stale must never leave the meeting watching a share we declared over.
  const nothingToStop = !active && (await readPresentingState()) === false;

  try {
    await zoomSdk.shareApp(active ? { action: 'start', withSound } : { action: 'stop' });
    appShareActive = active;
    if (active) appShareStartedAt = now();
    log(`App share ${active ? 'started' : 'stopped'}`, 'info');
    return true;
  } catch (error) {
    if (!active && (nothingToStop || error.code === ERROR_SHARE_NOT_STARTED || error.code === ERROR_NO_ONGOING_SHARE)) {
      // The share was stopped from Zoom's own toolbar, so there was nothing left
      // for this call to stop. Either the client told us so up front, or it is
      // saying so now by refusing. Nothing is wrong: the share is over, which is
      // what was asked for — and reporting a failure for it is what put a "Zoom
      // would not stop the share" toast in front of someone who had just
      // stopped it themselves.
      markShareStopped(`nothing left to stop${error.code ? ` (code ${error.code})` : ''}`);
      return true;
    }
    log(`Failed to ${active ? 'start' : 'stop'} app share: ${error.message || error.name}`, 'error');
    if (error.code) log(`Error code: ${error.code}`, 'error');
    // Only a start can leave the meeting sharing; a failed stop means the share
    // is either already gone or still up, and the next state change re-reconciles.
    if (active) appShareActive = false;
    return false;
  }
}

/**
 * Pop the app out into its own window, or merge it back into the main client.
 * Equivalent to "Popout" / "Merge Back to Main Window" in the app's ellipsis
 * menu. Desktop only: other clients report 10247, or reject the capability
 * outright at config() time.
 *
 * @param {boolean} popped - True to undock, false to dock back
 * @returns {Promise<boolean>} True if the client accepted the request
 */
export async function setAppPopout(popped) {
  await initializeZoomSdk();

  if (!sdkAvailable || !zoomSdk || typeof zoomSdk.appPopout !== 'function') {
    log(`[MOCK] Would ${popped ? 'undock' : 'dock'} the app window`, 'warn');
    appPoppedOut = popped;
    return false;
  }

  try {
    await zoomSdk.appPopout({ action: popped ? 'undock' : 'dock' });
    // onAppPopout also reports this, but the event does not arrive on every
    // client, so the requested state is recorded here too.
    appPoppedOut = popped;
    log(`App window ${popped ? 'undocked' : 'docked'}`, 'info');
    return true;
  } catch (error) {
    log(`Failed to ${popped ? 'undock' : 'dock'} the app: ${error.message || error.name}`, 'error');
    if (error.code) {
      log(`Error code: ${error.code}`, 'error');
      if (error.code === 10247) {
        log('This client or running context does not support popping the app out', 'warn');
      }
    }
    return false;
  }
}

/**
 * Register a callback for popout state changes, so the UI stays in sync when the
 * user pops the app out from Zoom's own menu instead of from our toggle.
 * @param {Function|null} callback - Receives the new popped-out boolean
 */
export function setPopoutChangeCallback(callback) {
  popoutChangeCallback = callback;
}

/**
 * Register a callback for share state changes, so the stage's share button shows
 * what is true rather than what we last asked for. The organizer can stop a share
 * from Zoom's own sharing toolbar, which never goes near our button.
 * @param {Function|null} callback - Receives the new sharing boolean
 */
export function setShareChangeCallback(callback) {
  shareChangeCallback = callback;
}

/**
 * Track sharing from an onShareApp event. Exported for testing.
 * @param {Object|string} event - OnShareAppEvent: 'start' | 'stop', or an object
 *   carrying one under `action`, depending on client version
 */
export function handleShareApp(event) {
  const action = typeof event === 'string' ? event : event?.action;
  if (action !== 'start' && action !== 'stop') return;

  const sharing = action === 'start';
  if (sharing === appShareActive) return;

  appShareActive = sharing;
  if (sharing) appShareStartedAt = now();
  log(`App share ${sharing ? 'started' : 'stopped'} by the client`, 'info');
  if (shareChangeCallback) shareChangeCallback(sharing);
}

/**
 * Subscribe to share updates. Failure is non-fatal: the button still starts and
 * stops the share, it just will not follow a stop made from Zoom's own toolbar.
 */
function subscribeToShareApp() {
  if (!zoomSdk || typeof zoomSdk.onShareApp !== 'function') {
    log('onShareApp unavailable; share state will not track the Zoom toolbar', 'warn');
    return;
  }
  try {
    zoomSdk.onShareApp(handleShareApp);
    log('Subscribed to onShareApp', 'info');
  } catch (error) {
    log(`Failed to subscribe to onShareApp: ${error.message || error.name}`, 'warn');
  }
}

// Who we are in this meeting, so a share event can be told apart from someone
// else's. Null until read, and null forever on a client that refuses
// getUserContext — in which case share events are left alone rather than guessed
// at. Meeting-specific and stable across breakout rooms, unlike participantId.
let selfParticipantUUID = null;

/**
 * Read and cache this user's participant UUID.
 *
 * Wanted before any share event arrives, which is why it is read at init rather
 * than on demand: an event handler cannot wait for it, and the first Stop Share
 * is exactly the one that matters.
 *
 * @returns {Promise<string|null>}
 */
async function readSelfParticipantUUID() {
  if (selfParticipantUUID) return selfParticipantUUID;
  if (!isApiAvailable('getUserContext')) return null;
  try {
    const context = await zoomSdk.getUserContext();
    selfParticipantUUID = context?.participantUUID || context?.participantId || null;
    return selfParticipantUUID;
  } catch (error) {
    log(`Could not read your own participant id: ${error.message || error.name}`, 'warn');
    return null;
  }
}

/**
 * Track our share ending from an onShareScreen event. Exported for testing.
 *
 * This is the event that actually reports Zoom's own Stop Share button, and the
 * reason the stage no longer has to poll for it. onShareApp is the documented
 * event for an app share and is subscribed as well, but it is not delivered on
 * every client; onShareScreen is meeting-wide, supported further back, and an app
 * share is a screen share as far as the meeting is concerned.
 *
 * Meeting-wide is also the catch: it fires for everybody, so it is only acted on
 * when the UUID is ours. Where we could not learn our own UUID the event is
 * ignored outright — mistaking someone else's share ending for ours would leave
 * the button offering "Screenshare" over a stage the meeting is still watching,
 * and pressing it would then ask Zoom to start a second share.
 *
 * @param {Object} event - OnShareScreenEvent
 */
export function handleShareScreen(event) {
  if (event?.action !== 'stop') return;
  if (!appShareActive) return;

  const who = event.participantUUID;
  if (!selfParticipantUUID) {
    log('A screen share stopped, but this client never told us who we are; leaving the share state alone', 'warn');
    return;
  }
  if (who && who !== selfParticipantUUID) return;

  markShareStopped('Zoom reports our screen share stopped');
}

/**
 * Subscribe to meeting-wide screen share updates, and learn who we are so the
 * events can be attributed. Non-fatal where either is missing: the share state
 * then falls back to onShareApp, to onMeetingViewChange, and to the check made
 * before each stop.
 */
function subscribeToShareScreen() {
  if (!zoomSdk || typeof zoomSdk.onShareScreen !== 'function') {
    log('onShareScreen unavailable; share state will not follow Zoom\'s Stop Share', 'warn');
    return;
  }
  // Not awaited: init should not wait on it, and it only has to land before the
  // organizer stops a share they have not started yet.
  readSelfParticipantUUID();
  try {
    zoomSdk.onShareScreen(handleShareScreen);
    log('Subscribed to onShareScreen', 'info');
  } catch (error) {
    log(`Failed to subscribe to onShareScreen: ${error.message || error.name}`, 'warn');
  }
}

/**
 * Track a share ending from an onMeetingViewChange event. Exported for testing.
 *
 * The third of the three events that can report a share ending, kept because the
 * other two are refusable independently of it and none of them is delivered
 * everywhere. Only `presenting: false` is acted on — the event carries only the
 * parameters that changed, and a true would not tell us whose share it is (see
 * readPresentingState).
 *
 * @param {Object} event - OnMeetingViewChangeEvent
 */
export function handleMeetingViewChange(event) {
  if (event?.presenting !== false) return;
  markShareStopped('the meeting view reports no one presenting');
}

/**
 * Subscribe to meeting view updates. Desktop only, and non-fatal where it is
 * missing: the share state then falls back to onShareApp, to onShareScreen, and
 * to the check made before each stop.
 */
function subscribeToMeetingView() {
  if (!zoomSdk || typeof zoomSdk.onMeetingViewChange !== 'function') {
    log('onMeetingViewChange unavailable; share state will not follow Zoom\'s Stop Share', 'warn');
    return;
  }
  try {
    zoomSdk.onMeetingViewChange(handleMeetingViewChange);
    log('Subscribed to onMeetingViewChange', 'info');
  } catch (error) {
    log(`Failed to subscribe to onMeetingViewChange: ${error.message || error.name}`, 'warn');
  }
}

/**
 * Track the docked/undocked state from an onAppPopout event. Exported for testing.
 * @param {Object} event - OnAppPopoutEvent
 */
export function handleAppPopout(event) {
  const action = event?.action;
  if (action !== 'dock' && action !== 'undock') return;

  const popped = action === 'undock';
  if (popped === appPoppedOut) return;

  appPoppedOut = popped;
  log(`App window ${popped ? 'undocked' : 'docked'} by the client`, 'info');
  if (popoutChangeCallback) popoutChangeCallback(popped);
}

/**
 * Track the app being hidden and shown again. Exported for testing.
 *
 * Coming back to the front is the one moment we know the user has been somewhere
 * else in Zoom — quite possibly Background & Effects, swapping the branded image
 * for one of their own or clearing it. Nothing reports that, so the only safe
 * move is to stop believing our record of what is on their video: the next push
 * then reapplies for real instead of being skipped as redundant.
 *
 * The same reasoning covers the share, which they may equally have stopped from
 * Zoom's toolbar while they were away — except that one the client can be asked
 * about outright, so it is reconciled rather than forgotten.
 *
 * @param {Object} event - OnAppVisibilityChangeEvent
 */
export function handleAppVisibilityChange(event) {
  if (event?.visible !== true) return;
  // Deliberately not awaited: this is an event handler, and the answer only has
  // to arrive before the organizer reaches for the share button.
  syncAppShareState();
  if (!activeOverlay) return;
  log('App back in front; forgetting what we believed was on the video', 'info');
  activeOverlay = null;
}

/**
 * Subscribe to app visibility. Desktop only, and non-fatal where it is missing:
 * camera mode never trusts the record anyway, so the loss is limited to card mode
 * skipping a redundant-looking push after the user edited their video filters.
 */
function subscribeToAppVisibility() {
  if (!zoomSdk || typeof zoomSdk.onAppVisibilityChange !== 'function') {
    log('onAppVisibilityChange unavailable; overlay state will not reset on refocus', 'warn');
    return;
  }
  try {
    zoomSdk.onAppVisibilityChange(handleAppVisibilityChange);
    log('Subscribed to onAppVisibilityChange', 'info');
  } catch (error) {
    log(`Failed to subscribe to onAppVisibilityChange: ${error.message || error.name}`, 'warn');
  }
}

/**
 * Subscribe to popout updates. Failure is non-fatal: the toggle still drives the
 * window, it just will not follow changes made from Zoom's own menu.
 */
function subscribeToAppPopout() {
  if (!zoomSdk || typeof zoomSdk.onAppPopout !== 'function') {
    log('onAppPopout unavailable; popout state will not track the client menu', 'warn');
    return;
  }
  try {
    zoomSdk.onAppPopout(handleAppPopout);
    log('Subscribed to onAppPopout', 'info');
  } catch (error) {
    log(`Failed to subscribe to onAppPopout: ${error.message || error.name}`, 'warn');
  }
}

/**
 * Check if SDK is available (for debugging)
 */
export function isSdkAvailable() {
  return sdkAvailable;
}

/**
 * Which of the APIs the app uses this client does not offer.
 *
 * Answered from config()'s refusal list, not from the presence of the method:
 * the npm SDK defines all of them on every client, so a presence check reported
 * a limited client as all-green.
 *
 * @returns {Array<{name: string, required: boolean, purpose: string}>}
 */
export function getMissingSdkApis() {
  if (!zoomSdk) return USED_SDK_APIS;
  return USED_SDK_APIS.filter((api) => !isApiAvailable(api.name));
}

/**
 * Get SDK status for debugging
 */
export function getSdkStatus() {
  const missingApis = getMissingSdkApis();
  const status = {
    initialized: sdkInitialized,
    available: sdkAvailable,
    sdkExists: typeof zoomSdk !== 'undefined',
    apiCount: USED_SDK_APIS.length,
    missingApis,
    // Kept because the video-off banner branches on it by name.
    hasSetVideoFilter: zoomSdk && typeof zoomSdk.setVideoFilter === 'function',
    overlayMode: currentOverlayMode,
    appShareActive,
    appPoppedOut,
    // Overlay sizing, so a slow-color-change report can be diagnosed from the
    // debug panel without a code change.
    cameraResolution: cameraResolution ? `${cameraResolution.width}x${cameraResolution.height}` : 'unreported',
    overlayBudget: (() => {
      const b = getOverlayBudget();
      return `${b.width}x${b.height}`;
    })(),
  };
  
  // Get available methods for debugging
  if (zoomSdk && typeof zoomSdk === 'object') {
    status.availableMethods = Object.keys(zoomSdk).filter(key => typeof zoomSdk[key] === 'function');
  }
  
  return status;
}

/**
 * Size to aim the overlay at, before the source image is considered.
 * Exported for testing.
 * @returns {{width: number, height: number}}
 */
export function getOverlayBudget() {
  // The SDK suggests matching the camera resolution, but that advice assumes
  // camera-like content. For a flat color plus a logo the camera resolution is
  // only useful as an *upper* bound — never send more pixels than the stream can
  // display, and never more than the content needs. Treating it as a target
  // instead would make a 720p camera cost more than sending nothing at all.
  if (cameraResolution) {
    return {
      width: Math.min(cameraResolution.width, OVERLAY_CEILING_WIDTH),
      height: Math.min(cameraResolution.height, OVERLAY_CEILING_HEIGHT),
    };
  }
  return { width: OVERLAY_CEILING_WIDTH, height: OVERLAY_CEILING_HEIGHT };
}

/**
 * Fit a source image inside the overlay budget, preserving aspect ratio.
 * Never upscales, and never exceeds the ceiling. Exported for testing.
 * @param {number} naturalWidth
 * @param {number} naturalHeight
 * @param {{width: number, height: number}} [budget] - Defaults to getOverlayBudget()
 * @returns {{width: number, height: number}}
 */
export function getOverlayDimensions(naturalWidth, naturalHeight, budget = getOverlayBudget()) {
  const maxWidth = Math.min(budget.width, OVERLAY_CEILING_WIDTH);
  const maxHeight = Math.min(budget.height, OVERLAY_CEILING_HEIGHT);
  const scale = Math.min(1, maxWidth / naturalWidth, maxHeight / naturalHeight);
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale)),
  };
}

/**
 * Convert a drawable source (HTMLImageElement, HTMLCanvasElement, etc.) to ImageData
 * by drawing it onto an offscreen canvas at the requested size. Exported for testing.
 */
export function imageToImageData(drawable, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  // Pass the destination size so an oversized source is scaled down rather than
  // cropped. Note that omitting it would draw at natural size.
  ctx.drawImage(drawable, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/**
 * Decode an image to ImageData, fitting within `max` and never scaling up.
 *
 * Separate from loadImageAsImageData on purpose. That path clamps to the overlay
 * ceiling of 640x360, which is right for a card about to be overwritten every
 * second and wrong for handing someone their own background back — it would come
 * back visibly softer than they left it.
 *
 * @param {string} uri - Any src an Image accepts, including a data: URI
 * @param {{width: number, height: number}} max - Bounding box to fit within
 * @returns {Promise<ImageData>}
 */
function decodeToImageData(uri, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`decode timed out after ${BACKGROUND_PIXELS_TIMEOUT_MS}ms`)),
      BACKGROUND_PIXELS_TIMEOUT_MS
    );

    img.onload = () => {
      const { naturalWidth: width, naturalHeight: height } = img;
      if (!width || !height) {
        finish(reject, new Error(`decoded to ${width}x${height}`));
        return;
      }
      const scale = Math.min(1, max.width / width, max.height / height);
      try {
        finish(
          resolve,
          imageToImageData(img, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)))
        );
      } catch (error) {
        finish(reject, error);
      }
    };
    img.onerror = () => finish(reject, new Error('image failed to decode'));
    // No crossOrigin: a data: URI is same-origin, and setting it on one is
    // pointless rather than harmless on some clients.
    img.src = uri;
  });
}

/**
 * Load image from URL and convert to ImageData, sharing one download + decode
 * across concurrent callers. Exported for testing.
 * @param {string} imageUrl - URL of the image
 * @returns {Promise<ImageData>} ImageData object
 */
export function loadImageAsImageData(imageUrl) {
  const budget = getOverlayBudget();
  // Keyed by budget as well as URL: the same image decoded for a 640x360 camera
  // is not reusable once the camera reports 1280x720.
  const key = `${imageUrl}@${budget.width}x${budget.height}`;

  const cached = imageDataCache.get(key);
  if (cached) {
    log(`Using cached ImageData for: ${describeUrl(imageUrl)}`, 'info');
    return cached;
  }

  const pending = decodeImage(imageUrl, budget);
  imageDataCache.set(key, pending);
  // Drop failed loads from the cache so a later attempt can retry.
  pending.catch(() => imageDataCache.delete(key));
  return pending;
}

/**
 * Read width/height from a PNG's IHDR chunk without decoding the pixels.
 * Returns null if the bytes are not a PNG. Exported for testing.
 * @param {ArrayBuffer} buffer
 * @returns {{width: number, height: number}|null}
 */
export function readPngSize(buffer) {
  const bytes = new Uint8Array(buffer);
  const signature = [0x89, 0x50, 0x4e, 0x47];
  if (bytes.length < 24 || !signature.every((byte, i) => bytes[i] === byte)) {
    return null;
  }
  const view = new DataView(buffer);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Whether this environment can decode straight to a target size. */
function canDecodeAtTargetSize() {
  return typeof createImageBitmap === 'function' && typeof fetch === 'function';
}

/**
 * Download an image and decode it to ImageData.
 * @param {string} imageUrl - URL of the image
 * @param {{width: number, height: number}} budget - Target size to fit within
 * @returns {Promise<ImageData>} ImageData object
 */
function decodeImage(imageUrl, budget) {
  log(`Loading image: ${describeUrl(imageUrl)}`, 'info');

  // A custom card (blob: object URL, or a legacy data: URL) is a JPEG, so the
  // PNG-header fast-path would only fetch it and then fail into the element
  // decode anyway.
  if (imageUrl.startsWith('data:') || imageUrl.startsWith('blob:')) {
    return decodeViaImageElement(imageUrl, budget);
  }

  if (canDecodeAtTargetSize()) {
    return decodeAtTargetSize(imageUrl, budget).catch((error) => {
      log(`Target-size decode failed (${error.message || error.name}); falling back to Image()`, 'warn');
      return decodeViaImageElement(imageUrl, budget);
    });
  }
  return decodeViaImageElement(imageUrl, budget);
}

/**
 * Decode directly to the target size, so the browser never materializes the
 * full-resolution bitmap. The source dimensions come from the PNG header rather
 * than a decode, which keeps the scale aspect-correct even when the camera
 * reports a different aspect ratio than the asset.
 * @param {string} imageUrl - URL of the image
 * @param {{width: number, height: number}} budget - Target size to fit within
 * @returns {Promise<ImageData>} ImageData object
 */
async function decodeAtTargetSize(imageUrl, budget) {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${imageUrl}`);
  }
  const buffer = await response.arrayBuffer();

  const natural = readPngSize(buffer);
  if (!natural) {
    // Without the header we cannot compute a target size without decoding first,
    // which is the very thing this path exists to avoid.
    throw new Error('response is not a PNG');
  }

  const { width, height } = getOverlayDimensions(natural.width, natural.height, budget);
  const bitmap = await createImageBitmap(new Blob([buffer]), {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'high',
  });

  try {
    const imageData = imageToImageData(bitmap, width, height);
    log(
      `Decoded ${natural.width}x${natural.height} straight to ${width}x${height}, ImageData size: ${imageData.data.length} bytes (cached)`,
      'info'
    );
    return imageData;
  } finally {
    // Release the native bitmap rather than waiting for GC.
    bitmap.close?.();
  }
}

/**
 * Decode via an Image element, then downscale on the canvas. Kept as the fallback
 * because a direct Image() load has historically behaved better than fetch inside
 * the Zoom client.
 * @param {string} imageUrl - URL of the image
 * @param {{width: number, height: number}} budget - Target size to fit within
 * @returns {Promise<ImageData>} ImageData object
 */
function decodeViaImageElement(imageUrl, budget) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let resolved = false;
    
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Image load timeout after 10 seconds: ${describeUrl(imageUrl)}`));
      }
    }, 10000);
    
    img.onload = () => {
      if (resolved) return;
      clearTimeout(timeout);
      
      // Verify image actually loaded
      if (img.naturalWidth === 0 || img.naturalHeight === 0) {
        resolved = true;
        reject(new Error(`Image loaded but has invalid dimensions: ${img.naturalWidth}x${img.naturalHeight}`));
        return;
      }
      
      try {
        const { width, height } = getOverlayDimensions(img.naturalWidth, img.naturalHeight, budget);
        const imageData = imageToImageData(img, width, height);

        log(`Loaded image: ${img.naturalWidth}x${img.naturalHeight} -> ${width}x${height}, ImageData size: ${imageData.data.length} bytes (cached)`, 'info');
        resolved = true;
        resolve(imageData);
      } catch (error) {
        log(`Error converting image to ImageData: ${error.message}`, 'error');
        resolved = true;
        reject(error);
      }
    };
    
    img.onerror = (event) => {
      if (resolved) return;
      clearTimeout(timeout);
      const errorMsg = `Image load failed: ${event.message || event.type || 'Unknown error'}`;
      log(`Image onerror event: ${errorMsg}`, 'error');
      log(`Image naturalWidth: ${img.naturalWidth}, naturalHeight: ${img.naturalHeight}`, 'error');
      log(`Image complete: ${img.complete}, width: ${img.width}, height: ${img.height}`, 'error');
      resolved = true;
      reject(new Error(`Failed to load image from ${describeUrl(imageUrl)}: ${errorMsg}`));
    };
    
    // Set src to load image (works like UI images in Zoom client)
    img.src = imageUrl;
  });
}

/**
 * Pre-load all background images and cache them as ImageData
 * This should be called when the app initializes
 */
export async function preloadBackgroundImages() {
  // Blue is what the card shows first, so decode it before the others. Loading
  // all four at once puts three decodes the user is not waiting on ahead of the
  // one they are.
  const colors = ['blue', 'green', 'yellow', 'red'];
  log('Pre-loading background images...', 'info');

  for (const color of colors) {
    try {
      await loadImageAsImageData(getBackgroundUrl(color));
      log(`Pre-loaded ${color} status`, 'info');
    } catch (error) {
      log(`Failed to pre-load ${color} status: ${error.message}`, 'warn');
    }
  }

  log(`Pre-loading complete. Cached ${imageDataCache.size} images.`, 'info');
}

/**
 * Called after the organizer changes a custom card image. Decoded pixels for
 * a replaced image are keyed by its old data: URL, so they can never be hit
 * again — clearing just releases the megabytes instead of holding them for
 * the session.
 */
export function notifyCardImagesChanged() {
  imageDataCache.clear();
  cardBandColorCache.clear();
}

/**
 * Get current overlay mode
 * @returns {string} Current overlay mode ('card' or 'camera')
 */
export function getOverlayMode() {
  return currentOverlayMode;
}

/**
 * Whether something of ours is currently on the user's video.
 *
 * Callers use this to decide whether taking the overlay down is worth a
 * confirmation dialog, so it has to survive a reload. Zoom re-creates the app's
 * webview every time the panel is closed and reopened, which zeroes activeOverlay
 * while the virtual background it describes is still sitting on the organizer's
 * face. Reading only that in-memory record is what left a branded background up
 * for a whole meeting: idle or not, nothing believed there was anything to remove.
 *
 * Covers both pipelines, so callers no longer need a "card mode always clears"
 * special case to compensate for the filter being invisible here.
 *
 * @returns {boolean}
 */
export function isOverlayActive() {
  // virtualForegroundApplied counts on its own: over a video background there
  // is no card and no filter, so the band is the only trace of us on the video
  // — and after a webview reload the persisted flag is all that knows it.
  return (
    activeOverlay !== null || virtualBackgroundApplied || virtualForegroundApplied || videoFilterApplied
  );
}

/**
 * Run an overlay SDK operation, one at a time, dropping any *push* that a newer
 * request has already superseded.
 *
 * Each push is multiple MB across the webview -> native bridge and takes as long
 * as it takes. Without this, several pushes run concurrently and can land out of
 * order, leaving a stale color on screen after a newer one was requested.
 *
 * Only pushes are droppable. A queued removal must always run: it targets a
 * different pipeline than the push that outran it, so skipping it leaves a card
 * on the tile that nothing will ever take down. That is exactly how switching
 * to Timer + Camera could trap the full card over the organizer's face — the
 * mode switch queued the filter teardown, a status push landed behind it and
 * superseded it, and the teardown never ran. Per-second count-up pushes make
 * that race routine rather than rare.
 *
 * @param {Function} op - Async operation to run
 * @param {{supersedable?: boolean}} [options] - supersedable false marks a
 *   removal, which newer requests must never skip
 * @returns {Promise<void>}
 */
function enqueueOverlayOp(op, { supersedable = true } = {}) {
  const requestId = ++overlayRequestId;
  const run = () => {
    if (supersedable && requestId !== overlayRequestId) {
      log('Skipping overlay request superseded by a newer one', 'info');
      return undefined;
    }
    return op();
  };
  // Same handler for both outcomes: one failed op must not stall the queue.
  overlayQueue = overlayQueue.then(run, run);
  return overlayQueue;
}

/**
 * Set overlay mode, tearing down whatever the previous mode had on screen and
 * bringing up the new one.
 *
 * Entering the stage starts nothing on its own — no share, no undocked window.
 * Those are actions the organizer takes from the stage itself, so that a screen
 * share is always something they pressed a button for. Leaving the stage does
 * unwind both, since neither should outlive the view that offered it.
 *
 * @param {string} mode - New overlay mode ('card', 'camera' or 'stage')
 * @param {string|null} currentImageUrl - Current image URL to reapply, or null to skip reapply
 * @returns {Promise<void>}
 */
export async function setOverlayMode(mode, currentImageUrl) {
  if (mode === currentOverlayMode) return;
  // Remove overlay using the old mode, captured now because currentOverlayMode
  // changes before the queued operation runs.
  const previousMode = currentOverlayMode;
  if (!isVideoOverlayMode(previousMode)) {
    await leaveStage();
  } else if (!isVideoOverlayMode(mode)) {
    // Entering the stage: clear both pipelines rather than just unwinding the
    // previous one, and do it outside the queue so no concurrent push can drop it.
    await clearVideoPipelines();
  } else {
    // Only the outgoing mode's pipeline: the incoming one is about to overwrite
    // its own, and setVirtualBackground replaces without a removal first.
    await enqueueOverlayOp(
      () => removeOverlayInternal(pipelinesForMode(previousMode), previousMode),
      { supersedable: false }
    );
  }
  currentOverlayMode = mode;

  // Reapply with new mode if an image URL is provided
  if (currentImageUrl) {
    await applyOverlay(currentImageUrl);
  }
}

// Zoom's code for "there was nothing applied", which is a normal outcome here,
// not a failure.
const ERROR_NOTHING_APPLIED = 10195;

/**
 * Which API putting the user's background back will actually need.
 *
 * Only "none" — and the case where we never learned what they had — is a
 * removal. A blur or an image goes back with setVirtualBackground, so gating
 * those on removeVirtualBackground refuses to restore anything on a client that
 * granted the setter and not the remover. That gate is why the caller has to ask
 * rather than assume: the two APIs are granted independently.
 *
 * @returns {'setVirtualBackground'|'removeVirtualBackground'}
 */
function restoreBackgroundApi() {
  // An own background is always put back with the setter, whatever Zoom
  // reports and whatever it was replaced over.
  if (hasOwnBackground() && isApiAvailable('setVirtualBackground')) return 'setVirtualBackground';
  const previous = readPreviousBackground();
  // A video is deliberately absent here. No spelling of setVirtualBackground
  // re-applies one, so routing it to the setter would only pick a call that
  // must fail. Camera mode does not replace one in the first place; this is the
  // guard for a record written before that was true.
  const bySet = previous?.type === 'blur' || (previous?.type === 'image' && previous.id);
  return bySet && isApiAvailable('setVirtualBackground')
    ? 'setVirtualBackground'
    : 'removeVirtualBackground';
}

/**
 * Take our branded background off by putting the user's own back, rather than
 * stripping their video to a bare camera.
 *
 * Replacing beats removing wherever it can. Someone who joined the meeting
 * blurred wants to leave it blurred; wiping them to None is a change they never
 * asked for and have to undo themselves, in a panel, mid-meeting.
 *
 * Every caller reaches this — the eraser, RESET, a finished speech, the idle
 * reveal, a mode switch — so all of them hand back the same video: whatever the
 * organizer had before the timer touched it.
 *
 * What is actually restorable is narrower than it looks, and the ceiling is
 * Zoom's, not ours:
 *
 * - Blur goes back exactly. It costs a confirmation dialog — setVirtualBackground
 *   documents the same 10017-on-deny as removal does for blur: true — so this is
 *   a better outcome for the same price, not a cheaper one.
 * - None is removal, which is what removal already means.
 * - One of their own images goes back too, via getVirtualBackgroundData. That is
 *   the API that turns the id we snapshotted into the pixels setVirtualBackground
 *   needs, and it closes the case this function used to give up on: someone who
 *   joined on a bookshelf was left staring at their own office the moment a
 *   speech ended. It costs no confirmation dialog, where removal always does, so
 *   the restore is cheaper than the giving-up it replaces.
 *
 * Removal remains the fallback for every case the client will not answer —
 * getVirtualBackgroundData ungranted, an id the client no longer knows, a stock
 * background it declines to hand over. The caller is told when that happens, so
 * the organizer hears it from us rather than discovering it on their own tile.
 *
 * @returns {Promise<{lost: boolean}>} lost is true when the user's own image was
 *   dropped because Zoom would not give it back.
 */
async function restoreOrRemoveBackground() {
  // The organizer's own upload outranks everything below it. They named the
  // background they want to end on, so there is nothing to read, nothing to
  // identify, and no way to land on someone else's picture or on None. Only a
  // client that refuses setVirtualBackground, or an image that will not decode,
  // falls past this into the guessing.
  if (hasOwnBackground() && isApiAvailable('setVirtualBackground')) {
    const own = await readOwnBackgroundPixels();
    if (own) {
      try {
        log('Restoring the background the organizer set in the app', 'info');
        await zoomSdk.setVirtualBackground({ imageData: own });
        return { lost: false };
      } catch (error) {
        log(`Could not apply the organizer's own background: ${error.message || error.name}. Falling back.`, 'warn');
      }
    }
  }

  const previous = readPreviousBackground();

  if (previous?.type === 'blur' && isApiAvailable('setVirtualBackground')) {
    log('Restoring the blur the user had before', 'info');
    await zoomSdk.setVirtualBackground({ blur: true });
    return { lost: false };
  }

  if (previous?.type === 'image' && previous.id && isApiAvailable('setVirtualBackground')) {
    // Falls through to removal on a null answer rather than throwing: a
    // background we cannot restore must still come off, or the speech's last
    // color stays on the tile for the rest of the meeting.
    const imageData = await readBackgroundPixels(previous.id, previous.name);
    if (imageData) {
      try {
        log(`Restoring the user's own background: ${previous.name || previous.id}`, 'info');
        await zoomSdk.setVirtualBackground({ imageData });
        return { lost: false };
      } catch (error) {
        log(`Could not re-apply "${previous.name || previous.id}": ${error.message || error.name}. Removing instead.`, 'warn');
      }
    }
  }

  if (previous?.type === 'video') {
    log(
      `"${previous.name || 'The user\'s own background'}" is a video background, which Zoom offers no way to re-apply; removing instead`,
      'warn'
    );
  }

  const lost = previous?.type === 'image' || previous?.type === 'video';
  if (lost && previous?.type !== 'video') {
    log(`No way to put "${previous.name || 'the user\'s own background'}" back; removing instead`, 'warn');
  }
  await zoomSdk.removeVirtualBackground();
  return { lost };
}
// removeVirtualBackground always asks the user to confirm. This is them saying no.
const ERROR_REMOVAL_DECLINED = 10017;

/**
 * Clear the video pipelines: the timer card, and any virtual background of ours.
 *
 * Three callers, same requirement. Entering a stage mode must leave the user's
 * video completely untouched — that is the whole promise of share and popout:
 * your own face, your own background. The "Clear Background" button is the
 * organizer's way out when something of ours is stuck on their tile. And RESET
 * hands the video back on its way to zeroing the clock, since undoing a speech
 * that should not have started has to undo what the meeting could see of it.
 *
 * Only applicable pipelines are touched, and only genuine failures are reported:
 *
 * - The video filter is always attempted. Deleting one prompts for nothing and
 *   costs nothing, and it is the pipeline card mode uses.
 * - The virtual background is attempted only when one is believed to be up, or
 *   when the user asks from camera mode — the only mode that applies one. Asking
 *   Zoom to remove a background that was never there raises a pointless
 *   confirmation dialog and then errors.
 * - An error on a pipeline we did not believe was holding anything is not a
 *   failure, whatever code it carries. "Remove the thing that was not there"
 *   failing is the expected answer, and different clients word it differently;
 *   treating it as an error is what made the button report failure in card mode.
 * - A pipeline this client never granted us is reported as such rather than
 *   attempted. Calling a refused API rejects at the bridge with a code that
 *   looks like any other failure, and the advice that follows from it is
 *   completely different: no retry will ever work, and the only way out is
 *   Zoom's own Background & Effects panel.
 * - The background is checked against the video before being touched, on clients
 *   that can answer. A record that has gone stale — the user changed their
 *   background themselves, which nothing reports — otherwise costs them a
 *   confirmation dialog for a background of ours that is not even there.
 *
 * Runs on the overlay queue, as a removal that can never be superseded — the
 * same footing removeOverlay is on. It used to bypass the queue, for the reason
 * leaveStage still does: the queue drops a request a newer one has superseded,
 * which would silently skip a teardown. But `supersedable: false` already says
 * "never drop this", and bypassing bought nothing else while costing the one
 * thing that matters here.
 *
 * What it cost: this and removeOverlay could run at once, and they read the same
 * records. Both would see virtualBackgroundApplied still true, both would ask
 * isOurBackgroundApplied, and both would set out to restore. The second one then
 * finds a background it does not recognise — the first has already put the
 * organizer's own back — concludes ours must still be up, and restores or
 * removes over the top of a video that was already correct. Serialized, the
 * second reads the records the first left behind and correctly does nothing.
 *
 * Safe to enqueue: every caller is outside the queue. setOverlayMode drives the
 * queue rather than running on it, and the UI calls this straight from a button.
 * Nothing queued calls it, so it cannot wait on itself.
 *
 * @returns {Promise<{ok: boolean, declined: boolean, ungranted: string[], lostBackground: boolean}>}
 *   ok is false only when something we believed was applied would not come off;
 *   declined is true when the user dismissed Zoom's removal confirmation, which
 *   changed nothing; ungranted names the pipelines this client refuses to let the
 *   app touch while something of ours is believed to be on them; lostBackground
 *   is true when the user's own image could not be put back.
 */
export async function clearVideoPipelines() {
  await initializeZoomSdk();
  // Dropped now rather than inside the queued turn: a push that lands between
  // this call and its turn must not be treated as still showing.
  activeOverlay = null;

  // enqueueOverlayOp reports a failed op by resolving, not rejecting, so the
  // result has to come out through a binding. This default is what a caller
  // sees if the body somehow never runs — the same shape, claiming nothing.
  let outcome = { ok: false, declined: false, ungranted: [], lostBackground: false };
  await enqueueOverlayOp(
    async () => {
      outcome = await clearVideoPipelinesInternal();
    },
    { supersedable: false }
  );
  return outcome;
}

/** The body of clearVideoPipelines, run on the overlay queue. */
async function clearVideoPipelinesInternal() {
  // What we believe is on each pipeline. Both records are persisted, because
  // Zoom reloads the webview whenever the panel is reopened — which is exactly
  // when an organizer reaches for this button.
  const hadFilter = videoFilterApplied;
  let hadBackground = virtualBackgroundApplied;
  activeOverlay = null;

  if (!sdkAvailable || !zoomSdk) {
    log('[MOCK] Would clear video filter and virtual background', 'warn');
    markVirtualBackgroundApplied(false);
    markVirtualForegroundApplied(false);
    markVideoFilterApplied(false);
    return { ok: false, declined: false, ungranted: [], lostBackground: false };
  }

  // Ask the video rather than the record, where the client will answer. Only a
  // definite "no" is acted on: null means it could not say, which leaves the
  // record in charge exactly as before.
  // Skipped entirely with an own background set: the check exists to avoid
  // acting on a background that is already the organizer's, and there the
  // answer is "put mine back" whatever is currently up.
  if (hadBackground && !hasOwnBackground() && (await isOurBackgroundApplied()) === false) {
    log('Zoom reports nothing of ours on the video; leaving the background alone', 'info');
    markVirtualBackgroundApplied(false);
    hadBackground = false;
  }

  let lostBackground = false;

  // Independently attempted: one failing must not leave the other applied.
  //
  // Each pipeline is attempted only when it is holding something of ours. The
  // filter used to be attempted unconditionally, on the grounds that deleting
  // one is silent and free. It is neither: Zoom errors when there is nothing to
  // delete, and deleteVideoFilter is documented to delete filters set by other
  // apps and to set the user's Video Filters setting to None — so pressing the
  // eraser in camera mode reached past our own overlay and turned off a filter
  // the organizer had chosen themselves.
  const attempts = [];
  // The readout layer comes off first, so the time never floats over a video
  // that has just been handed back. removeVirtualForeground raises no
  // confirmation dialog, so on the record is guard enough.
  if (virtualForegroundApplied) {
    attempts.push({
      what: 'count-up readout',
      expected: true,
      api: 'removeVirtualForeground',
      run: () => zoomSdk.removeVirtualForeground(),
    });
  }
  if (hadFilter) {
    attempts.push({
      what: 'video filter',
      expected: true,
      // deleteVideoFilter is the documented removal. setVideoFilter(null) is the
      // fallback for clients that granted the setter but not the deleter.
      api: isApiAvailable('deleteVideoFilter') ? 'deleteVideoFilter' : 'setVideoFilter',
      run: () =>
        isApiAvailable('deleteVideoFilter')
          ? zoomSdk.deleteVideoFilter()
          : zoomSdk.setVideoFilter({ fileUrl: null }),
    });
  }
  // On the record, never speculatively — the guard above has already downgraded
  // the record to a definite no wherever the client could answer. On clients
  // that cannot, the record is all there is: getVideoSettings reports camera,
  // HD, mirror and ratio, but nothing about the background. Asking anyway means
  // a "remove your virtual background?" dialog in front of someone who has no
  // virtual background at all.
  if (hadBackground) {
    attempts.push({
      what: 'virtual background',
      expected: true,
      // Whichever API the restore will genuinely use. Putting their blur or their
      // own image back is a set, not a removal.
      api: restoreBackgroundApi(),
      run: async () => { lostBackground = (await restoreOrRemoveBackground()).lost; },
    });
  }

  let ok = true;
  let declined = false;
  const ungranted = [];
  // Only forget a pipeline once it is genuinely clear: a declined, refused or
  // failed removal leaves it up, and the next attempt still needs to know that.
  let backgroundGone = true;
  let filterGone = true;
  let foregroundGone = true;

  const stillThere = (what) => {
    if (what === 'virtual background') backgroundGone = false;
    else if (what === 'count-up readout') foregroundGone = false;
    else filterGone = false;
  };

  for (const { what, expected, api, run } of attempts) {
    if (!isApiAvailable(api)) {
      // Nothing to retry and nothing to apologise for when the pipeline was
      // empty anyway — this only matters when something of ours is on it.
      log(`Client did not grant ${api}; cannot clear the ${what}`, expected ? 'warn' : 'info');
      if (expected) {
        ungranted.push(what);
        stillThere(what);
      }
      continue;
    }
    try {
      const result = run();
      if (result) await result;
      log(`Cleared ${what}`, 'info');
    } catch (error) {
      const code = error.code ?? 'none';
      if (error.code === ERROR_REMOVAL_DECLINED) {
        log(`User declined to remove the ${what}`, 'info');
        declined = true;
        stillThere(what);
      } else if (error.code === ERROR_NOTHING_APPLIED || !expected) {
        log(`No ${what} to clear (code ${code})`, 'info');
      } else {
        log(`Could not clear ${what} (code ${code}): ${error.message || error.name}`, 'warn');
        ok = false;
        stillThere(what);
      }
    }
  }

  if (backgroundGone) {
    markVirtualBackgroundApplied(false);
    // The record is deliberately kept. It used to be cleared here, on the grounds
    // that a background already restored is nothing left to restore to — which
    // held only while the next speech could always re-read it. It cannot: the
    // read needs getCurrentVirtualBackground, which not every client grants, and
    // a single failed read then dropped the organizer to a bare camera for the
    // rest of the meeting. Kept, it is the durable answer to "what is theirs",
    // and staleness is covered from both ends: snapshotUserBackground refreshes
    // it before every push, and isOurBackgroundApplied refreshes it whenever it
    // finds the video is already their own.
  }
  if (filterGone) markVideoFilterApplied(false);
  if (foregroundGone) markVirtualForegroundApplied(false);
  return { ok, declined, ungranted, lostBackground };
}

/**
 * Leave the stage: stop any share it started, and dock the window if it is out.
 * Neither should outlive the view that offered it — closing the stage while the
 * meeting is still watching it would be the worst kind of surprise.
 *
 * Deliberately NOT routed through enqueueOverlayOp. That queue drops any request
 * a newer one has superseded, which is right for image pushes and wrong here:
 * leaving the stage also flips React state, whose effects fire an applyOverlay
 * for the incoming mode. That push bumps the request id and the queued teardown
 * is skipped — the visible symptom being an X button that closes the stage while
 * the meeting is still being shared.
 */
export async function leaveStage() {
  await initializeZoomSdk();
  activeOverlay = null;

  // Stop first, dock second: the share is what the meeting can see.
  if (appShareActive) await setAppShare(false);
  if (appPoppedOut) await setAppPopout(false);
}

/**
 * Which pipeline a video mode drives. Used to tear down only what the outgoing
 * mode put up: the incoming one overwrites its own pipeline on the next push, so
 * removing it first would be a confirmation dialog in exchange for nothing.
 *
 * @param {string} mode
 * @returns {{filter: boolean, background: boolean}}
 */
function pipelinesForMode(mode) {
  return { filter: mode === OVERLAY_MODE_CARD, background: mode === OVERLAY_MODE_CAMERA };
}

// Both pipelines, for callers that want the video handed back whole rather than
// one mode's worth of it.
const ALL_PIPELINES = { filter: true, background: true };

/**
 * Take our overlay off the pipelines named, and only where one of ours is up.
 *
 * Nothing is removed speculatively. A removal aimed at an empty pipeline is not
 * free: Zoom errors on it, a background removal costs the user a confirmation
 * dialog before it even fails, and deleteVideoFilter is documented to delete
 * filters set by other apps and to set the user's Video Filters setting to None
 * — so an unconditional call reaches past our own overlay into their setup.
 *
 * Which pipelines to consider is the caller's to say, because the two callers
 * genuinely differ. A mode switch tears down the mode it is leaving. Handing the
 * video back — a finished speech, the eraser — takes off whatever is there,
 * since to the organizer a filter and a background are the same branded card.
 *
 * @param {{filter: boolean, background: boolean}} pipelines
 * @param {string} label - What is being torn down, for the log
 */
async function removeOverlayInternal(pipelines, label) {
  await initializeZoomSdk();

  const hadFilter = pipelines.filter && videoFilterApplied;
  const hadBackground = pipelines.background && virtualBackgroundApplied;
  const mode = label;

  // Clear this up front: once removal is requested, nothing is considered
  // applied, even if the removal itself fails because there was no overlay.
  activeOverlay = null;

  try {
    if (sdkAvailable && zoomSdk) {
      if (!hadFilter && !hadBackground) {
        log(`Nothing of ours on the video; nothing to remove (mode: ${mode})`, 'info');
      }
      // The readout layer belongs to camera mode, so it comes down with the
      // background — and first, so the time never floats over a background
      // that has just been handed back to its owner.
      if (pipelines.background && virtualForegroundApplied) {
        await removeForegroundReadout();
      }
      if (hadBackground) {
        const api = restoreBackgroundApi();
        if (!isApiAvailable(api)) {
          log(`Client did not grant ${api}; leaving the background in place`, 'warn');
        } else if (!hasOwnBackground() && (await isOurBackgroundApplied()) === false) {
          // Must not put a dialog in front of someone whose background is
          // already their own. Not consulted with an own background set — see
          // the same skip in clearVideoPipelinesInternal.
          log('Zoom reports the background is not ours; leaving it alone', 'info');
          markVirtualBackgroundApplied(false);
        } else {
          log('Putting the user\'s own background back', 'info');
          await restoreOrRemoveBackground();
          markVirtualBackgroundApplied(false);
          log('Successfully cleared our virtual background', 'info');
        }
      }
      if (hadFilter) {
        if (isApiAvailable('deleteVideoFilter')) {
          log('Deleting video filter', 'info');
          await zoomSdk.deleteVideoFilter();
          markVideoFilterApplied(false);
          log('Successfully deleted video filter', 'info');
        } else if (isApiAvailable('setVideoFilter')) {
          log('Removing video filter via setVideoFilter(null)', 'info');
          await zoomSdk.setVideoFilter({ fileUrl: null });
          markVideoFilterApplied(false);
          log('Successfully removed video filter', 'info');
        } else {
          log('Client did not grant deleteVideoFilter; leaving the filter in place', 'warn');
        }
      }
    } else {
      log(`[MOCK] Would remove overlay (mode: ${mode}, SDK not available)`, 'warn');
    }
  } catch (error) {
    log(`Failed to remove overlay (mode: ${mode}): ${error.message || error.name}`, 'error');
    if (error.code) {
      log(`Error code: ${error.code}`, 'error');
      if (error.code === ERROR_NOTHING_APPLIED) {
        log('No overlay exists to remove', 'warn');
        // Nothing was there, so stop recording one. Otherwise a flag left true
        // by an overlay the user cleared themselves would ask Zoom to remove it
        // — and prompt them for it — on every idle moment from here on. Only
        // the pipelines this call was asked about: the other was never touched
        // and its record is still the best thing we have.
        if (pipelines.background) markVirtualBackgroundApplied(false);
        if (pipelines.filter) markVideoFilterApplied(false);
      }
    }
  }
}

/**
 * Apply video filter overlay using Zoom SDK. Queued behind any overlay call
 * already in flight, and dropped if a newer overlay call supersedes it.
 * @param {string} imageUrl - URL of the image to use as overlay
 * @returns {Promise<void>}
 */
export function applyOverlay(imageUrl) {
  return enqueueOverlayOp(() => applyOverlayInternal(imageUrl));
}

/**
 * Whether what is already on screen matches what we are about to push.
 *
 * This is only ever an optimization, and a distrusted one: what is on the user's
 * video is Zoom's state, not ours, and the user can change it at any time through
 * Zoom's own UI without a word to the app. Skipping a push on the strength of a
 * record that has quietly gone stale is what left the branded image off for the
 * rest of a meeting.
 *
 * So it never speaks for camera mode: Background & Effects is a panel the user
 * visits, and a virtual background is pushed by fileUrl, costing no pixels across
 * the bridge — there is nothing worth protecting there. Card mode keeps the guard
 * because a video filter ships megabytes of ImageData, and the record is dropped
 * there too whenever the app comes back to the front.
 *
 * Two call sites pushing the same color at once are collapsed by the overlay
 * queue, which drops superseded requests, so that is not this function's job.
 *
 * @param {string} imageUrl
 * @returns {boolean}
 */
function isAlreadyShowing(imageUrl) {
  if (currentOverlayMode === OVERLAY_MODE_CAMERA) return false;
  if (!activeOverlay) return false;
  if (activeOverlay.url !== imageUrl || activeOverlay.mode !== currentOverlayMode) return false;
  // A frame carrying a different time readout is a different frame — and so is
  // one carrying the same readout somewhere else or at another size, right
  // after a drag or a +/- press.
  if ((activeOverlay.label ?? null) !== effectiveTimeLabel()) return false;
  if (
    activeOverlay.label &&
    (activeOverlay.position?.x !== overlayTimePosition.x ||
      activeOverlay.position?.y !== overlayTimePosition.y ||
      activeOverlay.scale !== overlayTimeScale)
  ) {
    return false;
  }
  // A fileUrl push is size-independent, so it is never stale.
  if (!activeOverlay.budget) return true;
  const budget = getOverlayBudget();
  return activeOverlay.budget.width === budget.width && activeOverlay.budget.height === budget.height;
}

/**
 * @param {string} imageUrl - URL of the image to use as overlay
 */
async function applyOverlayInternal(imageUrl) {
  // Ensure SDK is initialized before attempting to set filter
  await initializeZoomSdk();

  // In a stage mode the app renders the color itself. TimerContext calls this on
  // every status change regardless of mode, so the guard lives here rather than
  // at each call site.
  if (!isVideoOverlayMode()) {
    log(`Stage mode (${currentOverlayMode}) renders the color in-app; skipping video push`, 'info');
    return;
  }

  if (!imageUrl) {
    log('No image URL provided for overlay', 'warn');
    return;
  }

  if (isAlreadyShowing(imageUrl)) {
    log(`Overlay already showing ${describeUrl(imageUrl)}, skipping redundant push`, 'info');
    return;
  }

  try {
    if (sdkAvailable && zoomSdk) {
      // Camera mode degrades to the filter pipeline on clients that refuse
      // setVirtualBackground: the face is lost but the color signal — the whole
      // point of the timer — survives. Camera is the default mode now, so a
      // silent no-op here would mean a first-run organizer sees nothing at all.
      const cameraModeGranted =
        currentOverlayMode === OVERLAY_MODE_CAMERA && isApiAvailable('setVirtualBackground');
      if (currentOverlayMode === OVERLAY_MODE_CAMERA && !cameraModeGranted && isApiAvailable('setVideoFilter')) {
        log('Client did not grant setVirtualBackground; showing Timer + Camera as a plain card', 'warn');
      }
      if (cameraModeGranted) {
        // Before the first push of a session, and never once ours is up: what
        // is on the video now is theirs, and it is the only chance to learn
        // what to put back. No-ops on clients that cannot report it.
        // Reading what they had is only worth a round-trip when it is what we
        // will put back. With an own background set it never is.
        if (!virtualBackgroundApplied && !hasOwnBackground()) await snapshotUserBackground();

        // A video background is never replaced, because nothing in the SDK
        // replaces it back: setVirtualBackground takes imageData, a fileUrl or
        // blur, so a clear could only remove, and the organizer's looping beach
        // became None with no way to undo it but Zoom's own panel. Left alone,
        // it plays through the whole speech. The color signal moves to a band
        // on the foreground layer, which composites over their video rather
        // than replacing anything, and their face stays visible behind it.
        //
        // Unless they have set an own background, which is the answer to "what
        // should I be on" however they arrived at the meeting — so the card
        // replaces the video like any other, and the speech ends on the still
        // they chose. Deliberate: it is the one case where the app changes what
        // kind of background they are using, and they asked for it by setting
        // one.
        //
        // Only for a video. Every other background is still replaced by the
        // card outright, which is what the room has always seen.
        if (
          !hasOwnBackground() &&
          readPreviousBackground()?.type === 'video' &&
          isApiAvailable('setVirtualForeground')
        ) {
          const budget = getForegroundBudget();
          log(`Own background is a video; banding the card color instead of replacing it: ${describeUrl(imageUrl)}`, 'info');
          cameraBandColor = await loadCardBandColor(imageUrl);
          // Set before the push: syncForegroundReadout reads the pipeline off
          // this record to decide the layer is camera mode's to draw.
          activeOverlay = {
            url: imageUrl,
            mode: currentOverlayMode,
            budget,
            pipeline: 'band',
            label: effectiveTimeLabel(),
            position: { ...overlayTimePosition },
            scale: overlayTimeScale,
          };
          // Forced past the identical-layer check: an explicit apply always
          // re-pushes, because the organizer can wipe the layer from Zoom's own
          // UI without a word to the app.
          activeForeground = null;
          await syncForegroundReadout();
          log(`Applied the camera band in ${cameraBandColor || 'no color'}`, 'info');
          lastError = null;
          return;
        }
        // The background is always pushed label-free: the count-up rides its
        // own virtual-foreground layer. The Zoom client saves every image
        // handed to setVirtualBackground to the user's disk as a new custom
        // background, so baking the readout in here — a new image every
        // second — is what once filled organizers' machines with thousands of
        // one-second background files. Label-free, the frame is one of four
        // fixed files, and the fileUrl shortcut can serve a running speech.
        if (effectiveTimeLabel() && !isApiAvailable('setVirtualForeground')) {
          log('Client did not grant setVirtualForeground; showing Timer + Camera without the count-up', 'warn');
        }
        // Only a real http(s) URL takes the fileUrl shortcut. A custom card is
        // a data: URL — there is no file for the native client to fetch, and
        // handing it the whole payload as a "URL" is untested territory — so it
        // ships as pixels below, the path the fallback has always exercised.
        if (/^https?:/i.test(imageUrl)) {
          try {
            log(`Applying virtual background by fileUrl: ${imageUrl}`, 'info');
            const result = await zoomSdk.setVirtualBackground({ fileUrl: imageUrl });
            log(`Successfully applied virtual background by fileUrl. Result: ${JSON.stringify(result)}`, 'info');
            // No pixels pushed, so no budget to go stale.
            activeOverlay = { url: imageUrl, mode: currentOverlayMode, budget: null, pipeline: 'background' };
            markVirtualBackgroundApplied(true);
            lastError = null;
            await syncForegroundReadout();
            return;
          } catch (fileUrlError) {
            // The native client may not be able to reach the URL (restricted
            // network, proxy, TLS inspection). Fall back to shipping the pixels.
            log(`fileUrl virtual background failed: ${fileUrlError.message || fileUrlError.name}. Falling back to imageData.`, 'warn');
          }
        }

        log(`Loading image for overlay (mode: ${currentOverlayMode}): ${describeUrl(imageUrl)}`, 'info');
        const budget = getOverlayBudget();
        const imageData = await loadImageAsImageData(imageUrl);
        log(`Loaded ImageData: ${imageData.width}x${imageData.height}`, 'info');
        const result = await zoomSdk.setVirtualBackground({ imageData });
        log(`Successfully applied virtual background. Result: ${JSON.stringify(result)}`, 'info');
        activeOverlay = { url: imageUrl, mode: currentOverlayMode, budget, pipeline: 'background' };
        markVirtualBackgroundApplied(true);
        lastError = null;
        await syncForegroundReadout();
        return;
      } else {
        // Card pipeline: setVideoFilter covers the entire video. Both Timer
        // Only and a degraded Timer + Camera land here.
        if (isApiAvailable('setVideoFilter')) {
          log(`Loading image for overlay (mode: ${currentOverlayMode}): ${describeUrl(imageUrl)}`, 'info');
          const budget = getOverlayBudget();
          const imageData = await loadImageAsImageData(imageUrl);
          log(`Loaded ImageData: ${imageData.width}x${imageData.height}`, 'info');
          // Bake the count-up into the frame while a speech is running, so the
          // participants watching the card see the time too, not just the color.
          const label = effectiveTimeLabel();
          let frame = imageData;
          if (label) {
            try {
              frame = renderTimeOnFrame(imageData, label);
            } catch (error) {
              // The readout is a bonus; the color is the signal. Push the
              // plain card rather than nothing.
              log(`Could not render the time onto the card: ${error.message || error.name}`, 'warn');
            }
          }
          const result = await zoomSdk.setVideoFilter({ imageData: frame });
          log(`Successfully applied video filter overlay. Result: ${JSON.stringify(result)}`, 'info');
          activeOverlay = { url: imageUrl, mode: currentOverlayMode, budget, pipeline: 'filter', label, position: overlayTimePosition, scale: overlayTimeScale };
          markVideoFilterApplied(true);
          lastError = null;
          if (result && result.status) {
            log(`Filter set status: ${result.status}`, 'info');
          }
          return;
        }
      }
    }

    // SDK not available or function not found
    log(`[MOCK] Would apply overlay (mode: ${currentOverlayMode}, ${describeUrl(imageUrl)})`, 'warn');
    if (!sdkAvailable) {
      log(`[MOCK] SDK is not available. Make sure you're running this app inside Zoom client.`, 'warn');
    }
    if (!zoomSdk) {
      log(`[MOCK] zoomSdk object is not available`, 'warn');
    } else {
      const availableMethods = Object.keys(zoomSdk).filter(key => typeof zoomSdk[key] === 'function');
      log(`[MOCK] Required overlay function not available. Available methods: ${availableMethods.join(', ')}`, 'warn');
    }
  } catch (error) {
    log(`Failed to apply video filter overlay: ${error.message || error.name}`, 'error');
    log(`Error details: ${JSON.stringify({ message: error.message, code: error.code, name: error.name })}`, 'error');
    
    // Store error for debug panel
    let errorMessage = `Failed to apply overlay: ${error.message || error.name || 'Unknown error'}`;
    if (error.code) {
      errorMessage += ` (Code: ${error.code})`;
    }
    
    // Provide helpful error message
    if (error.message && error.message.includes('permission')) {
      errorMessage = 'Permission error: Make sure video filters are enabled in your Zoom settings';
      log('⚠️ ' + errorMessage, 'error');
    } else if (error.message && error.message.includes('video')) {
      errorMessage = 'Video error: Make sure your video is turned on in the Zoom meeting';
      log('⚠️ ' + errorMessage, 'error');
    } else if (error.code) {
      errorMessage = `Error code: ${error.code}. Check Zoom SDK documentation for this error code.`;
      log(`⚠️ ${errorMessage}`, 'error');
    }
    
    lastError = errorMessage;
    
    // Don't throw - allow app to continue functioning
  }
}

/**
 * Hand the organizer their video back: take off whichever pipeline is holding
 * our card.
 *
 * Both are considered, not just the current mode's. "Show your own background"
 * is a promise about their face, and an organizer who was in camera mode earlier
 * in the meeting does not think of the leftover as a background — they think of
 * it as the timer still being on them.
 *
 * @returns {Promise<void>}
 */
export function removeOverlay() {
  const mode = currentOverlayMode;
  // On the stage there is no overlay to remove: the color is DOM, and the share
  // and the window are the organizer's to end, not something a status change or
  // a finished speech should tear down under them.
  if (!isVideoOverlayMode(mode)) return Promise.resolve();
  return enqueueOverlayOp(() => removeOverlayInternal(ALL_PIPELINES, mode), { supersedable: false });
}

/**
 * Get current video state (on/off)
 * @returns {Promise<boolean | null>} True if video is on, false if off, null if unable to determine
 */
export async function getVideoState() {
  // Ensure SDK is initialized first
  await initializeZoomSdk();

  try {
    if (sdkAvailable && zoomSdk && typeof zoomSdk.getVideoState === 'function') {
      const result = await zoomSdk.getVideoState();
      
      // According to Zoom SDK: GetVideoStateResponse = { video: boolean }
      // video: false means off, true means on
      const videoState = result?.video;
      
      // Only return false if explicitly false, otherwise return null if undefined
      if (videoState === false) {
        console.log('Zoom SDK: Video state: OFF');
        log('Zoom SDK: Video state: OFF', 'info');
        return false;
      } else if (videoState === true) {
        console.log('Zoom SDK: Video state: ON');
        log('Zoom SDK: Video state: ON', 'info');
        return true;
      } else {
        console.warn('Zoom SDK: Video state is undefined, cannot determine. Result:', result);
        log(`Zoom SDK: Video state is undefined, cannot determine. Result: ${JSON.stringify(result)}`, 'warn');
        return null; // Return null if we can't determine
      }
    } else {
      console.warn('[MOCK] Zoom SDK: Would get video state (SDK not available)');
      log('[MOCK] Zoom SDK: Would get video state (SDK not available)', 'warn');
      // Return null in mock mode to indicate we can't determine (don't show warning)
      return null;
    }
  } catch (error) {
    console.error('Failed to get video state:', error);
    log(`Failed to get video state: ${error.message || error.name}`, 'error');
    // Return null on error to indicate we can't determine (don't show warning)
    return null;
  }
}

/**
 * Set video state (turn video on/off)
 * @param {boolean} enabled - True to turn video on, false to turn off
 */
export async function setVideoState(enabled) {
  // Ensure SDK is initialized
  await initializeZoomSdk();

  try {
    if (sdkAvailable && zoomSdk && typeof zoomSdk.setVideoState === 'function') {
      // According to Zoom SDK: SetVideoStateOptions = { video: boolean }
      console.log(`Zoom SDK: Attempting to set video state to ${enabled ? 'ON' : 'OFF'}`);
      log(`Zoom SDK: Attempting to set video state to ${enabled ? 'ON' : 'OFF'}`, 'info');
      const result = await zoomSdk.setVideoState({ video: enabled });
      console.log(`Zoom SDK: Successfully set video state to ${enabled ? 'ON' : 'OFF'}`, result);
      log(`Zoom SDK: Successfully set video state to ${enabled ? 'ON' : 'OFF'}`, 'info');
      return result;
    } else {
      console.warn(`[MOCK] Zoom SDK: Would set video state to ${enabled ? 'ON' : 'OFF'} (SDK not available)`);
      log(`[MOCK] Zoom SDK: Would set video state to ${enabled ? 'ON' : 'OFF'} (SDK not available)`, 'warn');
      if (!sdkAvailable) {
        console.warn(`[MOCK] SDK is not available. Make sure you're running this app inside Zoom client.`);
        log(`[MOCK] SDK is not available. Make sure you're running this app inside Zoom client.`, 'warn');
      }
      if (!zoomSdk || typeof zoomSdk.setVideoState !== 'function') {
        console.warn(`[MOCK] setVideoState function is not available on zoomSdk object`);
        log(`[MOCK] setVideoState function is not available on zoomSdk object`, 'warn');
      }
      return null;
    }
  } catch (error) {
    console.error('Failed to set video state:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      name: error.name
    });
    
    // Provide helpful error message
    if (error.message && error.message.includes('permission')) {
      console.error('⚠️ Permission error: Video state control may require user permission');
    }
    
    throw error; // Re-throw so caller can handle it
  }
}

// Roles Zoom lets call getMeetingParticipants. The SDK documents role as
// 'host' | 'coHost' | 'attendee' | 'panelist'; compared case- and
// punctuation-insensitively because clients have spelled co-host both ways.
const ROLES_THAT_CAN_LIST_PARTICIPANTS = ['host', 'cohost'];

const normalizeRole = (role) =>
  typeof role === 'string' ? role.toLowerCase().replace(/[^a-z]/g, '') : '';

/** One participant, from either API's field names. */
const toParticipant = (p, index) => ({
  id: p.participantUUID || p.participantId || p.userId || p.id || `user-${index}`,
  name: p.screenName || p.displayName || p.userName || p.name || 'Unknown',
});

/**
 * Everyone in the meeting, the app's own user included.
 *
 * Two APIs, because neither covers the room on its own: getMeetingParticipants
 * returns everybody *except* the caller, and getUserContext returns only the
 * caller. Merging them is what puts the organizer in their own speaker list,
 * which is where the name they most often need to time actually lives.
 *
 * They also differ in who may call them, and that is what `restricted` reports.
 * getUserContext works for every role; getMeetingParticipants is documented
 * host and co-host only. A timer run by someone who is neither used to get an
 * empty list and no reason for it.
 *
 * @returns {Promise<{participants: Array<{id: string, name: string}>, role: string, restricted: boolean}>}
 *   restricted is true when the full list was withheld because of the caller's
 *   role, which is the one cause the organizer can do something about.
 */
export async function getZoomParticipants() {
  // Waited on, not merely checked. SpeakerInput asks for this from a mount
  // effect, and main.jsx deliberately renders before it starts SDK init — so
  // this call has always landed inside that gap, read sdkAvailable as false and
  // returned an empty list. It is fetched once, so there was no second attempt
  // to correct it, and the suggestions stayed empty for the whole meeting.
  await initializeZoomSdk();

  if (!sdkAvailable) {
    log('[MOCK] SDK is not available; no participants to report.', 'warn');
    return { participants: [], role: '', restricted: false };
  }

  // Self first: it works for every role, so the list is never empty just
  // because the organizer is not hosting.
  let self = null;
  let role = '';
  if (isApiAvailable('getUserContext')) {
    try {
      const context = await zoomSdk.getUserContext();
      role = normalizeRole(context?.role);
      // Same read the share events need to tell our own share from anyone
      // else's; caching it here spares a second call for it.
      selfParticipantUUID = selfParticipantUUID || context?.participantUUID || context?.participantId || null;
      if (context?.screenName) self = toParticipant(context, 0);
      else log('getUserContext returned no screenName; leaving yourself out of the list', 'warn');
    } catch (error) {
      log(`Could not read your own user context: ${error.message || error.name} (code ${error.code ?? 'none'})`, 'warn');
    }
  } else {
    // Silent before: the one branch that produces a missing name with nothing
    // in the log to explain it. Almost always the capability not being enabled
    // on the Marketplace listing, which no amount of retrying fixes.
    log('getUserContext not granted by this client; your own name will be missing from the list', 'warn');
  }

  // getMeetingParticipants, not getParticipants: the latter is not an API the
  // SDK has, so this call threw every time and the suggestions were always
  // empty.
  let others = [];
  let listFailed = false;
  try {
    const response = await zoomSdk.getMeetingParticipants();
    if (Array.isArray(response?.participants)) {
      others = response.participants.map(toParticipant);
    }
  } catch (error) {
    listFailed = true;
    log(`Could not list meeting participants: ${error.message || error.name} (code ${error.code ?? 'none'})`, 'warn');
  }

  // Attempted regardless of role rather than skipped on one: the role string is
  // the client's to spell, and a refusal we can see beats a list we withheld on
  // a guess. The role only decides what the organizer is told afterwards.
  const restricted =
    listFailed && Boolean(role) && !ROLES_THAT_CAN_LIST_PARTICIPANTS.includes(role);
  if (restricted) {
    log(`Participant list needs host or co-host; this account is "${role}"`, 'warn');
  }

  // Self first so the organizer's own name leads the list, then dedupe: a
  // client that does include the caller in getMeetingParticipants must not
  // produce them twice.
  const seen = new Set();
  const participants = [self, ...others].filter(Boolean).filter((person) => {
    const key = person.id || person.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { participants, role, restricted };
}
