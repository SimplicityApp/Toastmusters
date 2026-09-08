/**
 * How this app instance stands with Zoom.
 *
 * The SDK handshake alone cannot answer that question. `zoomSdk.config()`
 * rejects identically whether Zoom pulled our authorization, whether the page
 * is simply open in a browser tab, or whether this is `npm run dev` — and the
 * app used to treat all three as "running in mock mode", log it to the console
 * and say nothing. The organizer whose access Zoom revoked got a timer that
 * quietly stopped driving their video, with no hint that re-adding the app was
 * the fix.
 *
 * The missing half comes from the Worker, which stamps the launch context into
 * the shell's <head> from Zoom's `x-zoom-app-context` request header
 * (worker/index.js). Handshake result + launch context pins the state down.
 */

export const LAUNCH_CLIENT = 'client';
export const LAUNCH_BROWSER = 'browser';
export const LAUNCH_UNKNOWN = 'unknown';

/** Fully working: the SDK answered and Zoom is ours to drive. */
export const CONNECTION_CONNECTED = 'connected';
/** In the Zoom client, but the SDK refused us — authorization is gone. */
export const CONNECTION_REVOKED = 'revoked';
/** An ordinary browser tab. Includes Zoom bouncing a user to the home URL. */
export const CONNECTION_OUTSIDE_ZOOM = 'outside_zoom';
/** Local development. Never worth a notice. */
export const CONNECTION_DEV = 'dev';

/**
 * Read the launch context the Worker stamped into the document head.
 *
 * Absent means the shell was served by something that does not stamp it — the
 * Vite dev server, or a stale cached copy from before this shipped. That is
 * deliberately its own value rather than a default of 'browser': claiming to
 * know is how a working organizer ends up being told to reinstall.
 *
 * @param {Document} doc
 * @returns {'client'|'browser'|'unknown'}
 */
export function readLaunchContext(doc = typeof document === 'undefined' ? null : document) {
  const content = doc?.querySelector('meta[name="zoom-launch"]')?.getAttribute('content');
  if (content === LAUNCH_CLIENT) return LAUNCH_CLIENT;
  if (content === LAUNCH_BROWSER) return LAUNCH_BROWSER;
  return LAUNCH_UNKNOWN;
}

/**
 * @param {Object} input
 * @param {boolean} input.sdkReady - Did initializeZoomSdk() resolve true?
 * @param {'client'|'browser'|'unknown'} input.launch
 * @param {boolean} input.isDev - Running against the local dev server.
 * @returns {string} One of the CONNECTION_* constants.
 */
export function resolveConnectionState({ sdkReady, launch, isDev = false }) {
  if (sdkReady) return CONNECTION_CONNECTED;
  if (launch === LAUNCH_CLIENT) return CONNECTION_REVOKED;
  if (launch === LAUNCH_BROWSER) return CONNECTION_OUTSIDE_ZOOM;

  // Unmarked shell. Every deployed path goes through the Worker, which always
  // stamps, so in a dev build this is the Vite server and worth no notice —
  // nagging on `npm run dev` is how a warning gets trained into wallpaper.
  // Deployed, an unmarked shell is a stale cached copy: it is not in the Zoom
  // client (the handshake just failed), and the out-of-Zoom copy says only
  // that, without asserting a revocation it cannot see.
  return isDev ? CONNECTION_DEV : CONNECTION_OUTSIDE_ZOOM;
}

/** Does this state warrant telling the organizer something? */
export function needsAttention(state) {
  return state === CONNECTION_REVOKED || state === CONNECTION_OUTSIDE_ZOOM;
}

// Organizer state this app writes on its own origin. Any of them means the
// person has used the timer before, which changes the message from "add this
// app" to "your access was dropped, and your data is still here".
const RETURNING_USER_KEYS = [
  'toastmaster_agenda',
  'toastmaster_reports',
  'toastmaster_role_rules',
  'toastmaster_prompts',
];

/**
 * @param {Storage} storage
 * @returns {boolean} True if this origin holds work from a previous meeting.
 */
export function isReturningUser(storage = typeof localStorage === 'undefined' ? null : localStorage) {
  try {
    return RETURNING_USER_KEYS.some((key) => {
      const value = storage?.getItem(key);
      return Boolean(value) && value !== '[]' && value !== '{}';
    });
  } catch {
    // Storage can throw outright when the client blocks it. Assume new user:
    // the install copy is correct for them either way, only less warm.
    return false;
  }
}
