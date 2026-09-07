import { decryptAppContext } from './zoom-context.js';
import { mintSessionToken } from './session-token.js';

/**
 * POST /api/zoom/session — turn Zoom's app context into an identity.
 *
 * The only place a Zoom uid is ever established. Two ingress paths land here
 * because neither covers every load on its own:
 *
 *  - `context` in the body, from the SDK's getAppContext(). Works on any load,
 *    including popouts and client-side navigation.
 *  - the `X-Zoom-App-Context` header, which Zoom sets on the document request
 *    and the Worker sees for free. Needs no SDK capability and no Marketplace
 *    change, so it keeps working on clients that refuse getAppContext.
 *
 * Never 4xx for an unknown user. "We don't know who this is" is the normal
 * state for a guest, for local development, and for any client that gave us
 * nothing — the app is built to run anonymously, and an error status here would
 * turn routine operation into something the client has to treat as a failure.
 */

/**
 * Per-user, and therefore never cacheable. The edge would otherwise be free to
 * hand one person's uid and token to the next caller of the same URL.
 */
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
 * Read the context the client sent, if it sent one. A missing or unparseable
 * body is not an error: the header path deliberately posts nothing.
 *
 * @returns {Promise<string|null>}
 */
async function readContextFromBody(request) {
  try {
    const body = await request.json();
    const context = body?.context;
    return typeof context === 'string' && context ? context : null;
  } catch {
    return null;
  }
}

/**
 * @param {Request} request
 * @param {Object} env - Worker env (ZOOM_CLIENT_SECRET, SESSION_SIGNING_KEY)
 * @returns {Promise<Response>}
 */
export async function handleZoomSession(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const context = (await readContextFromBody(request)) || request.headers.get('x-zoom-app-context');
  const payload = decryptAppContext(context, env.ZOOM_CLIENT_SECRET);

  if (!payload) {
    // Either nothing was sent, or what was sent could not be trusted. The
    // client stays anonymous; `isGuest` stays false because we genuinely do not
    // know whether this is a guest or a client that simply told us nothing.
    return json({ identified: false, isGuest: false });
  }

  // A successful decrypt with no uid is Zoom telling us this is a guest: they
  // are signed out, and no amount of retrying will produce an identity.
  if (!payload.uid) {
    return json({ identified: false, isGuest: true });
  }

  // Minting is best-effort on purpose. Identity is useful for analytics even
  // before SESSION_SIGNING_KEY exists, so a missing signing key costs the sync
  // features and nothing else — which lets identity ship ahead of storage.
  const token = mintSessionToken(payload.uid, env.SESSION_SIGNING_KEY);

  return json({
    identified: true,
    isGuest: false,
    uid: payload.uid,
    meetingId: payload.mid,
    contextType: payload.typ,
    token,
  });
}
