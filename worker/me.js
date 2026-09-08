import { readSession } from './auth.js';
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

  return json({
    uid: session.uid,
    entitlement: await resolveEntitlement(env, session.uid),
  });
}
