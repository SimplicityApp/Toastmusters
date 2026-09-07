import crypto from 'node:crypto';
import { verifySessionToken, readBearerToken } from './session-token.js';

/**
 * GET/PUT /api/assets/:hash — the custom card artwork a user uploaded.
 *
 * Card images are Blobs measured in megabytes, which is the wrong shape for KV
 * and the right shape for R2. Only the hashes travel in the profile document.
 *
 * Content-addressed, so re-uploading the same picture is free and a retry after
 * a dropped connection is idempotent rather than a duplicate.
 *
 * Stored under the caller's uid, not under the bare hash. A global namespace
 * would make the hash itself a capability: anyone who learned one could fetch
 * another user's artwork. Scoping by uid costs cross-user dedupe, which is
 * worth nothing here, and buys a boundary that cannot be guessed past.
 */

const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES_PER_USER = 20 * 1024 * 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

const objectKey = (uid, hash) => `card/${uid}/${hash}`;

async function usedBytes(env, uid) {
  let total = 0;
  let cursor;
  do {
    const listed = await env.CARD_ASSETS.list({ prefix: `card/${uid}/`, cursor });
    for (const object of listed.objects) total += object.size ?? 0;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return total;
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {Object} env - Worker env (CARD_ASSETS R2 bucket, SESSION_SIGNING_KEY)
 * @returns {Promise<Response>}
 */
export async function handleAsset(request, url, env) {
  if (!env.CARD_ASSETS) {
    return json({ error: 'Asset storage is not configured' }, 503);
  }

  const session = verifySessionToken(readBearerToken(request), env.SESSION_SIGNING_KEY);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const hash = url.pathname.slice('/api/assets/'.length);
  // Constrained to a literal SHA-256 digest, so nothing a client sends can
  // shape the object key — no traversal, no prefix games, no unbounded names.
  if (!HASH_PATTERN.test(hash)) return json({ error: 'Invalid asset id' }, 400);

  const key = objectKey(session.uid, hash);

  if (request.method === 'GET') {
    const object = await env.CARD_ASSETS.get(key);
    if (!object) return json({ error: 'Not found' }, 404);

    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
        // Content-addressed, so the bytes for this key can never change — but
        // they are one user's, so the cache must be theirs alone.
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  }

  if (request.method !== 'PUT') return json({ error: 'Method not allowed' }, 405);

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
    return json({ error: 'Asset too large' }, 413);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return json({ error: 'Empty asset' }, 400);
  if (bytes.byteLength > MAX_ASSET_BYTES) return json({ error: 'Asset too large' }, 413);

  // The claimed name must be the real digest of the bytes. Without this the
  // store is not content-addressed at all — a client could park arbitrary
  // content under any id, including one another device is about to fetch.
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== hash) return json({ error: 'Asset does not match its id' }, 400);

  // Idempotent: the same picture uploaded twice is already there, and skipping
  // the write also keeps a retry from counting twice against the quota.
  if (await env.CARD_ASSETS.head(key)) return json({ stored: true, deduped: true });

  if ((await usedBytes(env, session.uid)) + bytes.byteLength > MAX_TOTAL_BYTES_PER_USER) {
    return json({ error: 'Storage limit reached' }, 507);
  }

  await env.CARD_ASSETS.put(key, bytes, {
    httpMetadata: {
      contentType: request.headers.get('content-type') || 'application/octet-stream',
    },
  });

  return json({ stored: true, deduped: false });
}
