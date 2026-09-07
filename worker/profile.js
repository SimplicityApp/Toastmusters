import { verifySessionToken, readBearerToken } from './session-token.js';
import { mergeProfiles, normalizeProfile } from '../packages/shared/profileMerge.js';

/**
 * GET/PUT /api/profile — the settings that follow a user between devices.
 *
 * Everything here hangs off a verified session token, never off a uid the
 * client named. That is the whole security boundary: a client that could pick
 * its own uid could read and overwrite anyone's agenda, rules and artwork.
 *
 * The merge runs server-side and the merged document comes back in the
 * response, so two devices editing at once converge on one answer rather than
 * each believing its own. It is the same merge the client runs locally — one
 * implementation, shared — so the two can never disagree.
 */

// Generous for a document of preferences (the real one is a few KB), small
// enough that this endpoint cannot be used as free storage.
const MAX_BODY_BYTES = 128 * 1024;

const KEY_PREFIX = 'profile:zoom:';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
    },
  });
}

/**
 * @returns {{uid: string}|null} the caller's verified identity, or null
 */
function authenticate(request, env) {
  return verifySessionToken(readBearerToken(request), env.SESSION_SIGNING_KEY);
}

async function readProfile(env, uid) {
  const stored = await env.PROFILES.get(`${KEY_PREFIX}${uid}`, 'json');
  return normalizeProfile(stored);
}

/**
 * @param {Request} request
 * @param {Object} env - Worker env (PROFILES KV namespace, SESSION_SIGNING_KEY)
 * @returns {Promise<Response>}
 */
export async function handleProfile(request, env) {
  if (!env.PROFILES) {
    // The KV binding is not attached yet. Say so plainly rather than 500ing:
    // identity ships before storage, so this is a real intermediate state.
    return json({ error: 'Profile storage is not configured' }, 503);
  }

  const session = authenticate(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  if (request.method === 'GET') {
    return json({ profile: await readProfile(env, session.uid) });
  }

  if (request.method !== 'PUT') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Checked before reading: an oversized body should cost us nothing to refuse.
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ error: 'Profile too large' }, 413);
  }

  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: 'Profile too large' }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const stored = await readProfile(env, session.uid);
  const { profile, changed } = mergeProfiles(stored, body?.profile);

  // Writing only when something actually changed keeps a device that polls on
  // every load from burning KV's per-key write rate on no-op updates.
  if (changed) {
    await env.PROFILES.put(`${KEY_PREFIX}${session.uid}`, JSON.stringify(profile));
  }

  return json({ profile, changed });
}
