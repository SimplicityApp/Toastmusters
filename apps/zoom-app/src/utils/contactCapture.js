import { isApiAvailable, requestZoomAuthorizeCode } from './zoomSdk';
import { trackEvent } from './posthog';

/**
 * Asking Zoom, from inside the client, for the user's email and name.
 *
 * Most users only ever open the app inside Zoom and never pass through a
 * browser OAuth flow, so the Worker can learn their Zoom account email only if
 * the app asks Zoom for an authorization code (zoomSdk.authorize) and hands it
 * over (POST /api/zoom/contact, worker/contact.js). The Worker exchanges it,
 * checks it belongs to this session's uid, and saves the record. The email
 * never comes back to the app.
 *
 * The first ask is automatic: silent for a user who has already approved the
 * app's scopes, Zoom's consent screen for one who has not. A user who skips
 * that screen is never shown it unprompted again; they move to "card" mode,
 * where an in-app card offers the same approval (components/ContactCapture).
 *
 * The per-uid state lives in localStorage under tt_contact_capture:<uid> as
 * { mode: 'auto' | 'card', nextAt }. `contactKnown` from /api/zoom/session
 * stops all of this on every device once any door has saved the contact.
 *
 * Nothing here throws, and nothing here may get in the way of the timer.
 */

export const CONTACT_ENDPOINT = '/api/zoom/contact';
export const CAPTURE_STATE_PREFIX = 'tt_contact_capture:';
/** A failed save, a "Not now" or a second skip waits this long. */
export const CAPTURE_BACKOFF_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_STATE = Object.freeze({ mode: 'auto', nextAt: 0 });
const MODES = new Set(['auto', 'card']);

/**
 * The stored state for a uid, or the starting state when there is none or it
 * cannot be read.
 *
 * @param {string} uid
 * @returns {{mode: 'auto'|'card', nextAt: number}}
 */
export function readCaptureState(uid) {
  if (!uid) return { ...DEFAULT_STATE };
  try {
    const raw = localStorage.getItem(`${CAPTURE_STATE_PREFIX}${uid}`);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    return {
      mode: MODES.has(parsed?.mode) ? parsed.mode : DEFAULT_STATE.mode,
      nextAt: Number.isFinite(parsed?.nextAt) ? parsed.nextAt : DEFAULT_STATE.nextAt,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/**
 * Store the state for a uid; null clears it.
 *
 * @param {string} uid
 * @param {{mode: 'auto'|'card', nextAt: number}|null} state
 */
export function writeCaptureState(uid, state) {
  if (!uid) return;
  try {
    const key = `${CAPTURE_STATE_PREFIX}${uid}`;
    if (state) localStorage.setItem(key, JSON.stringify({ mode: state.mode, nextAt: state.nextAt }));
    else localStorage.removeItem(key);
  } catch {
    // Private mode, or storage disabled: the worst case is asking again on
    // the next load, which contactKnown stops once the contact is saved.
  }
}

/**
 * Whether the app should ask Zoom for this user's approval at all right now.
 *
 * An identified user with a session token (the POST needs it), no contact on
 * file, the release flag on, a client that granted authorize, and no backoff
 * running.
 *
 * @param {Object|null} session - from resolveZoomIdentity()
 * @param {boolean} flagOn - useFlag('contact_capture').enabled
 * @param {number} [now]
 * @returns {boolean}
 */
export function eligible(session, flagOn, now = Date.now()) {
  if (!session?.identified || !session.uid || !session.token) return false;
  if (session.contactKnown !== false) return false;
  if (!flagOn) return false;
  if (!isApiAvailable('authorize')) return false;
  return now >= readCaptureState(session.uid).nextAt;
}

/**
 * Hand a code to the Worker. True only for a 200; anything else (a scope not
 * yet approved, a code for another account, the network) is a failure the
 * caller backs off from.
 *
 * @param {string} token - the session token from /api/zoom/session
 * @param {{code: string, codeVerifier: string}} codes
 * @returns {Promise<boolean>}
 */
export async function postContactCode(token, { code, codeVerifier }) {
  try {
    const response = await fetch(CONTACT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code, codeVerifier }),
      cache: 'no-store',
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

/**
 * One ask: Zoom's authorize(), then the POST.
 *
 *   'unavailable' — the client cannot ask; the state is left alone.
 *   'skipped'     — the user skipped Zoom's screen; from now on they get the
 *                   card instead, starting at the next idle moment.
 *   'saved'       — the Worker saved the contact; the state is cleared.
 *   'failed'      — a code came back but the save did not; wait a week.
 *
 * A code that arrives after the 2-minute timeout is still posted; a 200 then
 * clears the state and calls `onLateSaved`.
 *
 * @param {'auto'|'card'} source
 * @param {Object} session - from resolveZoomIdentity()
 * @param {{now?: () => number, onLateSaved?: () => void}} [options]
 * @returns {Promise<'unavailable'|'skipped'|'saved'|'failed'>}
 */
export async function attempt(source, session, { now = Date.now, onLateSaved } = {}) {
  const uid = session?.uid;
  if (!uid || !session.token) return 'unavailable';

  trackEvent('contact_capture_prompted', { source });

  const onLateCode = async (codes) => {
    if (!(await postContactCode(session.token, codes))) return;
    trackEvent('contact_capture_saved', { source, late: true });
    writeCaptureState(uid, null);
    onLateSaved?.();
  };

  const result = await requestZoomAuthorizeCode({ onLateCode });

  if (result.status === 'unavailable') return 'unavailable';

  if (result.status === 'skipped') {
    trackEvent('contact_capture_skipped', { source });
    writeCaptureState(uid, { mode: 'card', nextAt: now() });
    return 'skipped';
  }

  if (await postContactCode(session.token, result)) {
    trackEvent('contact_capture_saved', { source });
    writeCaptureState(uid, null);
    return 'saved';
  }

  writeCaptureState(uid, { ...readCaptureState(uid), nextAt: now() + CAPTURE_BACKOFF_MS });
  return 'failed';
}
