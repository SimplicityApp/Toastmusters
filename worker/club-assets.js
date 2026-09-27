import { json, methodNotAllowed } from './http.js';

/**
 * GET /api/club-assets/<clubId>/<name> — the club's logo, served to anyone.
 *
 * Card artwork is deliberately private: `GET /api/assets/:hash` requires a
 * session and resolves to `card/<uid>/<hash>`, so a hash is never a global
 * capability. This route breaks that pattern on purpose, because the club
 * logo's audience is wider than any credential we could check — a guest with no
 * uid, the Zoom badge compositor running before identity has resolved, and
 * whoever opens a shared report link having never heard of us.
 *
 * The privacy given up is notional: it is the club's own logo, public the
 * moment a branded report is shared, and a clubId plus a 64-character digest is
 * not enumerable.
 *
 * The caching is the load-bearing part. Content-addressed and immutable means
 * the CDN answers nearly every request without waking the Worker at all, which
 * is what keeps this fetch out of the 25 ms warm budget that
 * `e2e/zoom.card-switch-perf.spec.js` holds card switching to.
 */

/** A uuid today, but nothing about the route depends on that shape. */
const CLUB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/**
 * A content hash, or a share token's `r-<token>.png` in Phase 5. Dots are
 * allowed for the extension; `..` and `/` are not, so nothing a client sends
 * can shape the object key into another prefix.
 */
const OBJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const objectKey = (clubId, name) => `club/${clubId}/${name}`;

const notFound = () => json({ error: 'Not found' }, 404);

/**
 * @param {Request} request
 * @param {URL} url
 * @param {Object} env - Worker env (CARD_ASSETS R2 bucket)
 * @returns {Promise<Response>}
 */
export async function handleClubAsset(request, url, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed();
  if (!env.CARD_ASSETS) return json({ error: 'Asset storage is not configured' }, 503);

  const rest = url.pathname.slice('/api/club-assets/'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return notFound();

  const clubId = rest.slice(0, slash);
  const name = rest.slice(slash + 1);
  if (!CLUB_ID_PATTERN.test(clubId) || !OBJECT_NAME_PATTERN.test(name) || name.includes('..')) {
    return notFound();
  }

  const key = objectKey(clubId, name);
  const object = request.method === 'HEAD' ? await env.CARD_ASSETS.head(key) : await env.CARD_ASSETS.get(key);
  if (!object) return notFound();

  const headers = {
    'Content-Type': object.httpMetadata?.contentType || 'image/png',
    // Public, unlike the per-user card assets: the whole point of this route is
    // that the edge answers it for everyone, including callers with no session.
    'Cache-Control': 'public, max-age=31536000, immutable',
    // The bytes at this key can never change, so a revalidation is pure waste —
    // but say so anyway, since a proxy that ignores immutable will use it.
    ...(object.httpEtag ? { ETag: object.httpEtag } : {}),
  };

  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}
