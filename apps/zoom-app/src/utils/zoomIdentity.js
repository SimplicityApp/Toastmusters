import { readAppContext, readZoomUserStatus } from './zoomSdk';

/**
 * Recognising a returning user, without ever asking them to sign in.
 *
 * Anyone running this app has already signed into Zoom and already granted a
 * consent by installing us. Zoom hands that identity over in a signed context
 * blob; we were simply not reading it. So there is no login form here and there
 * is not going to be one — the whole mechanism is invisible.
 *
 * Why it matters: every user setting lives in localStorage on one device, and
 * analytics identity was an anonymous cookie that the Zoom webview, popouts,
 * desktop-vs-web clients and reinstalls each reset. Churn and cookie-loss were
 * indistinguishable, which made the retention numbers unreadable.
 *
 * Failure is always silent and always anonymous. This runs on every app load,
 * beside a timer someone is about to use in front of their club, so nothing here
 * may block rendering, retry in a loop, or surface an error.
 */

const SESSION_ENDPOINT = '/api/zoom/session';
const TOKEN_STORAGE_KEY = 'toastmaster_session_token';

/** @type {Promise<Object>|null} */
let identityPromise = null;

const ANONYMOUS = Object.freeze({
  identified: false,
  isGuest: false,
  uid: null,
  token: null,
  authStatus: null,
});

/**
 * The context is only decryptable with the client secret, which lives in the
 * Worker. The browser posts the blob and is told who it belongs to.
 *
 * Sent even when the SDK gave us nothing: Zoom also sets the context as a header
 * on the document request, and on that path the Worker has it already.
 */
async function requestSession(context) {
  const response = await fetch(SESSION_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(context ? { context } : {}),
    // Identity is per-user; a cached response would hand us someone else's.
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Session endpoint returned ${response.status}`);
  return response.json();
}

/**
 * Kept for the sync layer, which needs it on every request. sessionStorage
 * rather than localStorage: a short-lived credential should not outlive the tab
 * that earned it, and it is re-minted on the next load for free.
 */
function rememberToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    else sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Private mode, or storage disabled. The in-memory copy still works for
    // this page load, which is all the sync layer needs.
  }
}

/**
 * The current session token, or null when we have none.
 *
 * @returns {string|null}
 */
export function getSessionToken() {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

async function resolveOnce() {
  // Status is read alongside the context, not after it: it is the thing that
  // tells a guest apart from a client that failed us, and it is worth having
  // even when there is no identity to be had.
  const [context, authStatus] = await Promise.all([
    readAppContext().catch(() => null),
    readZoomUserStatus().catch(() => null),
  ]);

  try {
    const session = await requestSession(context);
    rememberToken(session.token);

    return {
      identified: Boolean(session.identified),
      isGuest: Boolean(session.isGuest),
      uid: session.uid ?? null,
      token: session.token ?? null,
      authStatus,
    };
  } catch {
    // Offline, the Worker is down, or local development with no endpoint. The
    // app is fully usable without an identity, so this is not worth surfacing.
    return { ...ANONYMOUS, authStatus };
  }
}

/**
 * Resolve who this is, once per page load.
 *
 * Single-flight, mirroring initializeZoomSdk: several callers may want the
 * identity before the first has finished, and each must wait for that one
 * answer rather than starting another round trip.
 *
 * @returns {Promise<{identified: boolean, isGuest: boolean, uid: string|null,
 *   token: string|null, authStatus: string|null}>} never rejects
 */
export function resolveZoomIdentity() {
  if (!identityPromise) {
    identityPromise = resolveOnce().catch(() => ({ ...ANONYMOUS }));
  }
  return identityPromise;
}

/** Test seam: drop the cached single-flight result. */
export function resetZoomIdentityForTests() {
  identityPromise = null;
  rememberToken(null);
}
