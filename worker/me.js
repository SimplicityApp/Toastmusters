import { readSession, readClub, sessionCookie, REISSUE_AFTER_MS, WEB_SESSION_TTL_MS } from './auth.js';
import { mintSessionToken } from './session-token.js';
import { resolveAccess } from './entitlements.js';
import { resolveFlags } from './flags.js';
import { json, unauthorized, methodNotAllowed } from './http.js';

/**
 * GET /api/me — who the caller is and what they may use.
 *
 * The Zoom app gets the same answer from /api/zoom/session on load; this is
 * the cheap way to ask again (after a purchase, on a poll) without re-sending
 * the app context. The web app will use it as its only identity call.
 *
 * `?flags=1` is how that identity call asks for the release flags too (see
 * worker/flags.js). Only it sends the param: refreshEntitlement and waitForPro
 * poll this same endpoint, and leaving them out is what keeps flag resolution
 * at about one request per page load rather than one per poll. With the param,
 * a caller with no session gets `{ uid: null, flags }` instead of a 401, so a
 * signed-out visitor still ends the load knowing which features to show.
 *
 * @param {Request} request
 * @param {Object} env
 * @param {Object} [ctx] - lets the flag answer be cached at the edge
 */
export async function handleMe(request, env, ctx) {
  if (request.method !== 'GET') return methodNotAllowed();
  const withFlags = new URL(request.url).searchParams.get('flags') === '1';
  const session = readSession(request, env);
  if (!session) {
    // Without the param this is exactly the 401 the pollers have always read
    // as "no session, leave the stored answer alone".
    if (!withFlags) return unauthorized();
    return json({ uid: null, flags: await resolveFlags(env, {}, ctx) });
  }

  // Sliding web session: a cookie older than a day is re-issued for another
  // 30, so someone who uses the timer every week never has to sign in again.
  const headers = {};
  if (session.via === 'cookie' && typeof session.iat === 'number' && Date.now() - session.iat > REISSUE_AFTER_MS) {
    const fresh = mintSessionToken(session.uid, env.SESSION_SIGNING_KEY, Date.now(), WEB_SESSION_TTL_MS);
    if (fresh) headers['Set-Cookie'] = sessionCookie(fresh);
  }

  // Both never throw, and neither needs the other, so neither waits.
  const [entitlement, flags] = await Promise.all([
    // Combined: a club member's plan is simply correct at the source, so
    // every client that already reads this keeps working unchanged.
    resolveAccess(env, { uid: session.uid, clubId: readClub(request, env)?.clubId ?? null }),
    withFlags ? resolveFlags(env, { uid: session.uid }, ctx) : null,
  ]);

  return json(
    {
      uid: session.uid,
      entitlement,
      // Only for the identity call; a poll's answer has no `flags` at all.
      ...(withFlags ? { flags } : {}),
    },
    200,
    headers
  );
}
