import { readSession, exchangeZoomCode, fetchZoomMe } from './auth.js';
import { json, methodNotAllowed, notConfigured, unauthorized } from './http.js';
import { isEmailish, normalizeEmail } from './email.js';

/**
 * The Zoom account email and name of each user, kept so we can follow up with
 * them about the app (GitHub issue #83).
 *
 *   contact:zoom:<uid>  →  { email, firstName, lastName, updatedAt }
 *
 * Its own key, never a field of the synced profile document: /api/profile
 * hands that document back to the client, and nothing ever returns this one.
 * The app learns only whether a record exists (`contactKnown` on
 * /api/zoom/session), so it can stop asking. Operators read records with
 * `wrangler kv`.
 *
 * Every door that sees a Zoom `users/me` answer saves through
 * saveZoomContact, so the merge rule lives in exactly one place. Three doors:
 *  - in-client, POST /api/zoom/contact (handleZoomContact): the Zoom app runs
 *    zoomSdk.authorize() with PKCE and sends us the code it is handed;
 *  - browser install or re-add, /oauth/redirect?code with no state
 *    (captureInstallContact), in the background;
 *  - web sign-in, the callback in auth.js, before the session is minted.
 *
 * In PROFILES by name, like profile.js and user-data.js: this is the user's
 * own data, not billing, so it does not move with a future ENTITLEMENTS
 * binding.
 */

export const contactKey = (uid) => `contact:zoom:${uid}`;

/** A trimmed, non-empty string, or null. */
function cleanName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Merge what Zoom just told us into the stored record.
 *
 * Field by field, carrying forward anything the new answer lacks, so an empty
 * or invalid email never overwrites a good one. Nothing is written when the
 * merged record is the one already stored: `updatedAt` means "last time the
 * contact changed", and a user who opens the app daily must not burn the
 * key's write rate on no-op puts.
 *
 * Rejects when KV does. Every caller decides what a failure costs it: the
 * sign-in callback must never lose the sign-in over this.
 *
 * @param {Object} env - PROFILES
 * @param {string} uid - the Zoom user id, from a verified session or users/me
 * @param {Object} me - a Zoom users/me body (email, first_name, last_name)
 * @param {number} [now]
 * @returns {Promise<{saved: boolean, reason?: 'unbound'|'empty'|'unchanged'}>}
 */
export async function saveZoomContact(env, uid, me, now = Date.now()) {
  const store = env?.PROFILES;
  if (!store) return { saved: false, reason: 'unbound' };

  const incoming = {
    email: isEmailish(me?.email) ? normalizeEmail(me.email) : null,
    firstName: cleanName(me?.first_name),
    lastName: cleanName(me?.last_name),
  };
  if (incoming.email === null && incoming.firstName === null && incoming.lastName === null) {
    return { saved: false, reason: 'empty' };
  }

  const key = contactKey(uid);
  const stored = await store.get(key, 'json');
  const existing = stored && typeof stored === 'object' ? stored : null;
  const next = {
    email: incoming.email ?? existing?.email ?? null,
    firstName: incoming.firstName ?? existing?.firstName ?? null,
    lastName: incoming.lastName ?? existing?.lastName ?? null,
  };

  if (
    existing &&
    next.email === (existing.email ?? null) &&
    next.firstName === (existing.firstName ?? null) &&
    next.lastName === (existing.lastName ?? null)
  ) {
    return { saved: false, reason: 'unchanged' };
  }

  await store.put(key, JSON.stringify({ ...next, updatedAt: now }));
  return { saved: true };
}

/**
 * Whether a contact record exists for this user. One KV read; false when the
 * binding is missing or the read fails, which at worst lets the app ask again.
 *
 * @param {Object} env - PROFILES
 * @param {string} uid
 * @returns {Promise<boolean>}
 */
export async function readContactKnown(env, uid) {
  const store = env?.PROFILES;
  if (!store || !uid) return false;
  try {
    return (await store.get(contactKey(uid))) !== null;
  } catch (error) {
    console.error('Failed to read contact for', uid, error?.message || error);
    return false;
  }
}

// A Zoom authorization code is a few dozen characters; a PKCE verifier is
// 43–128 characters of the RFC 7636 unreserved set. Anything else is not a
// request this endpoint can do anything with, and is refused before any
// round trip to Zoom.
const MAX_CODE_LENGTH = 2048;
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const MAX_BODY_BYTES = 8 * 1024;

async function readCodeBody(request) {
  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return null;
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const code = body?.code;
  const codeVerifier = body?.codeVerifier;
  if (typeof code !== 'string' || !code || code.length > MAX_CODE_LENGTH) return null;
  if (typeof codeVerifier !== 'string' || !VERIFIER_PATTERN.test(codeVerifier)) return null;
  return { code, codeVerifier };
}

/**
 * POST /api/zoom/contact — the in-client door.
 *
 *   Authorization: Bearer <zoom session token>
 *   { code, codeVerifier }  →  200 { saved }   (never the email)
 *
 * The uid comes from the signed session, never from the body. The code is
 * exchanged with the app's Home URL as the redirect URI (Zoom's rule for an
 * in-client authorize), and the users/me answer must belong to that same uid:
 * a code for another Zoom account never lands on this user's record.
 *
 * Any non-200 tells the app to back off for a week, so every failure here is
 * a plain status and nothing more.
 *
 * @param {Request} request
 * @param {Object} env - PROFILES, SESSION_SIGNING_KEY, ZOOM_CLIENT_ID,
 *   ZOOM_CLIENT_SECRET, ZOOM_APP_HOME_URL
 * @param {{fetchImpl?: typeof fetch, now?: number}} [options]
 * @returns {Promise<Response>}
 */
export async function handleZoomContact(request, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (request.method !== 'POST') return methodNotAllowed();

  const session = readSession(request, env);
  if (!session) return unauthorized();

  const body = await readCodeBody(request);
  if (!body) return json({ error: 'Bad request' }, 400);

  if (!env.PROFILES) return notConfigured('Contact storage');
  if (!env.ZOOM_CLIENT_ID || !env.ZOOM_CLIENT_SECRET || !env.ZOOM_APP_HOME_URL) {
    return notConfigured('Zoom authorization');
  }

  let accessToken;
  try {
    const tokens = await exchangeZoomCode(env, body.code, env.ZOOM_APP_HOME_URL, {
      codeVerifier: body.codeVerifier,
      fetchImpl,
    });
    if (!tokens.ok) return json({ error: 'exchange' }, 502);
    accessToken = tokens.accessToken;
  } catch (error) {
    console.error('Zoom contact exchange failed:', error?.message || error);
    return json({ error: 'exchange' }, 502);
  }

  let me;
  try {
    const profile = await fetchZoomMe(accessToken, fetchImpl);
    if (!profile.ok) return json({ error: 'profile' }, 502);
    me = profile.me;
  } catch (error) {
    console.error('Zoom contact users/me failed:', error?.message || error);
    return json({ error: 'profile' }, 502);
  }

  const zoomId = typeof me?.id === 'string' && me.id ? me.id : null;
  if (!zoomId) return json({ error: 'profile' }, 502);
  if (zoomId !== session.uid) {
    console.warn('Zoom contact code belongs to another user; not saved');
    return json({ error: 'Forbidden' }, 403);
  }

  try {
    const result = await saveZoomContact(env, session.uid, me, now);
    return json({ saved: result.saved });
  } catch (error) {
    // A KV failure is the app's cue to try again next week, not an outage.
    console.error('Failed to save Zoom contact for', session.uid, error?.message || error);
    return json({ error: 'storage' }, 503);
  }
}

/**
 * /oauth/redirect?code=… with no state — the browser install and re-add door.
 *
 * The Marketplace "Add" flow (and the stamped /add-to-zoom link) lands on the
 * SPA's install-success page with Zoom's one-time code, which nothing else
 * spends. index.js hands it here in ctx.waitUntil, so the page is served
 * exactly as fast as before, and this spends the code only to learn who
 * installed: no session is minted from it. That is why it needs no state of
 * ours: a forged or replayed code can at most save its own owner's details
 * under their own uid.
 *
 * The redirect URI must be the one the authorize request named, and the code
 * landed on exactly that URI, so url.origin is right by construction.
 *
 * Logs and stops on any failure; nothing here ever reaches the user. A reload
 * re-sends a code already spent, and that exchange fails harmlessly. Before
 * the user:read:user scope is granted it is users/me that fails. Network
 * failures and KV errors reject, for the caller's .catch to log.
 *
 * @param {Object} env - PROFILES, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET
 * @param {URL} url - the /oauth/redirect request URL
 * @param {{fetchImpl?: typeof fetch, now?: number}} [options]
 * @returns {Promise<{saved: boolean, reason?: string}>}
 */
export async function captureInstallContact(env, url, { fetchImpl = fetch, now = Date.now() } = {}) {
  const code = url.searchParams.get('code');
  if (!code || code.length > MAX_CODE_LENGTH) return { saved: false, reason: 'no_code' };
  // Checked before any round trip: nowhere to keep the answer, or no way to
  // ask, means there is nothing worth spending the code on.
  if (!env?.PROFILES) return { saved: false, reason: 'unbound' };
  if (!env.ZOOM_CLIENT_ID || !env.ZOOM_CLIENT_SECRET) return { saved: false, reason: 'not_configured' };

  const tokens = await exchangeZoomCode(env, code, `${url.origin}/oauth/redirect`, { fetchImpl });
  if (!tokens.ok) return { saved: false, reason: 'exchange' };

  const profile = await fetchZoomMe(tokens.accessToken, fetchImpl);
  if (!profile.ok) return { saved: false, reason: 'profile' };
  const uid = typeof profile.me?.id === 'string' && profile.me.id ? profile.me.id : null;
  if (!uid) return { saved: false, reason: 'profile' };

  return saveZoomContact(env, uid, profile.me, now);
}
