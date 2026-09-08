import { readSession, sessionCookie, REISSUE_AFTER_MS, WEB_SESSION_TTL_MS } from './auth.js';
import { mintSessionToken } from './session-token.js';
import { resolveEntitlement } from './entitlements.js';
import { json, unauthorized, methodNotAllowed } from './http.js';

/**
 * GET /api/me — who the caller is and what they may use.
 *
 * The Zoom app gets the same answer from /api/zoom/session on load; this is
 * the cheap way to ask again (after a purchase, on a poll) without re-sending
 * the app context. The web app will use it as its only identity call.
 */
export async function handleMe(request, env) {
  if (request.method !== 'GET') return methodNotAllowed();
  const session = readSession(request, env);
  if (!session) return unauthorized();

  // Sliding web session: a cookie older than a day is re-issued for another
  // 30, so someone who uses the timer every week never has to sign in again.
  const headers = {};
  if (session.via === 'cookie' && typeof session.iat === 'number' && Date.now() - session.iat > REISSUE_AFTER_MS) {
    const fresh = mintSessionToken(session.uid, env.SESSION_SIGNING_KEY, Date.now(), WEB_SESSION_TTL_MS);
    if (fresh) headers['Set-Cookie'] = sessionCookie(fresh);
  }

  return json(
    {
      uid: session.uid,
      entitlement: await resolveEntitlement(env, session.uid),
    },
    200,
    headers
  );
}
