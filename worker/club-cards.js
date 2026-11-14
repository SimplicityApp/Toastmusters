import crypto from 'node:crypto';
import { readSession, readClub } from './auth.js';
import { json, methodNotAllowed, unauthorized } from './http.js';
import { entitlementStore, clubKey, readClubRecord, resolveAccess } from './entitlements.js';
import { canPublish, clubCardsKey, readMemberRole } from './club-admin.js';
import { verifiedClubId } from './club.js';
import { readAdminContext } from './club-admin-routes.js';

/**
 * The club's card set: one set of timing-card artwork every club device can show.
 *
 * Custom card images used to follow a *person* between their own computers. The
 * timer role rotates every week, so the person who uploaded the club's artwork
 * was rarely the person timing with it. A set published here reaches every
 * device holding the club code instead, the same way the club's presets do.
 *
 *   PUT    /api/club/cards/<hash>   upload one image (admin or editor)
 *   GET    /api/club/cards/<hash>   download one image (any club device, or the console)
 *   PUT    /api/club/cards          publish { label, images: { color: hash } } (admin or editor)
 *   DELETE /api/club/cards          take the set down (admin)
 *
 * Images live at `club-card/<clubId>/<hash>`, deliberately outside `club/<clubId>/`:
 * `/api/club-assets/*` serves everything under that prefix to anyone, and card
 * artwork is private. Devices keep a copy in IndexedDB, so they never need the
 * public CDN path the logo needs.
 *
 * Publishing and removing bump `club:<clubId>.ver`, which is what makes devices
 * replace their copy, exactly as a presets publish does.
 */

export const CARD_COLORS = Object.freeze(['blue', 'green', 'yellow', 'red']);

/** The same limit personal card artwork had: a 1280×720 JPEG is a fraction of it. */
export const MAX_CARD_BYTES = 2 * 1024 * 1024;
/** Per club. Ten full sets of four, which is far more than one published set ever holds. */
export const MAX_CLUB_CARD_BYTES = 20 * 1024 * 1024;
const MAX_LABEL_LENGTH = 40;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Images uploaded this recently are never pruned. A second publisher's uploads
 * land before their publish does; without this window, a publish in between
 * would delete them and their publish would fail.
 */
export const PRUNE_GRACE_MS = 15 * 60 * 1000;

export const clubCardObjectKey = (clubId, hash) => `club-card/${clubId}/${hash}`;
const clubCardPrefix = (clubId) => `club-card/${clubId}/`;

const forbidden = () => json({ error: 'forbidden' }, 403);

/**
 * The image type from the bytes themselves, never from the header the client
 * sent. Raster only, for the reason the logo is: an SVG is a document that can
 * carry script, and this route answers on the same origin as every session.
 *
 * @param {Uint8Array} bytes
 * @returns {'image/jpeg'|'image/png'|'image/webp'|null}
 */
export function sniffImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  const ascii = (from, to) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * A published body as we store it, or null if it is unusable. A set needs at
 * least one colour; the colours it skips show the Classic card on every device,
 * the same rule a personal custom set follows.
 *
 * @param {unknown} body
 * @returns {{label: string|null, images: Object<string, string>}|null}
 */
export function normalizeCardSet(body) {
  if (!body || typeof body !== 'object') return null;
  const raw = body.images;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const images = {};
  for (const [color, hash] of Object.entries(raw)) {
    if (!CARD_COLORS.includes(color)) return null;
    if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) return null;
    images[color] = hash;
  }
  if (!Object.keys(images).length) return null;

  const label = typeof body.label === 'string' ? body.label.trim().slice(0, MAX_LABEL_LENGTH) : '';
  return { label: label || null, images };
}

/** Whether a publish would change anything a device would see. */
export function cardSetUnchanged(stored, next) {
  if (!stored) return false;
  return (
    (stored.label ?? null) === next.label &&
    CARD_COLORS.every((color) => (stored.images?.[color] ?? null) === (next.images[color] ?? null))
  );
}

/**
 * The club's published set, or null. Never throws: it runs on the app-start
 * refresh, which must not fail because of a card set.
 *
 * @returns {Promise<Object|null>}
 */
export async function readClubCards(env, clubId) {
  if (!clubId) return null;
  const store = entitlementStore(env);
  if (!store) return null;
  try {
    return (await store.get(clubCardsKey(clubId), 'json')) ?? null;
  } catch {
    return null;
  }
}

/**
 * The set as a device needs it: hashes, not URLs. A device already knows the
 * route, and the hashes are what it compares against what it holds.
 *
 * @returns {{label: string|null, images: Object<string, string>, publishedBy: string|null,
 *   publishedAt: number|null}|null}
 */
export function buildCards(record) {
  if (!record?.images || typeof record.images !== 'object') return null;
  const images = {};
  for (const color of CARD_COLORS) {
    const hash = record.images[color];
    if (typeof hash === 'string' && HASH_PATTERN.test(hash)) images[color] = hash;
  }
  if (!Object.keys(images).length) return null;
  return {
    label: record.label ?? null,
    images,
    publishedBy: record.publishedBy ?? null,
    publishedAt: record.publishedAt ?? null,
  };
}

/**
 * Who may upload or publish: a named admin or editor on a device that still
 * holds the club. The same checks, in the same order, as a presets publish.
 *
 * @returns {Promise<{store: Object, clubId: string, club: Object, uid: string}|{response: Response}>}
 */
async function requirePublisher(request, env) {
  const session = readSession(request, env);
  if (!session?.uid) return { response: unauthorized() };
  const claims = readClub(request, env);
  if (!claims) return { response: unauthorized() };

  const store = entitlementStore(env);
  if (!store) return { response: json({ error: 'Club storage is not configured' }, 503) };
  if (!env.CARD_ASSETS) return { response: json({ error: 'Asset storage is not configured' }, 503) };

  const clubId = await verifiedClubId(env, claims);
  if (!clubId) return { response: forbidden() };

  const club = await readClubRecord(env, clubId);
  if (!club) return { response: json({ error: 'club_not_found' }, 404) };

  const access = await resolveAccess(env, { uid: session.uid, clubId, club });
  if (!access.entitled) return { response: json({ error: 'upgrade_required', entitlement: access }, 402) };

  if (!canPublish(await readMemberRole(env, clubId, session.uid))) return { response: forbidden() };

  return { store, clubId, club, uid: session.uid };
}

async function usedBytes(env, clubId) {
  let total = 0;
  let cursor;
  do {
    // eslint-disable-next-line no-await-in-loop
    const listed = await env.CARD_ASSETS.list({ prefix: clubCardPrefix(clubId), cursor });
    for (const object of listed.objects ?? []) total += object.size ?? 0;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return total;
}

/**
 * Delete the club's images that no published set names any more. Best effort:
 * an orphan costs pennies, and a failed publish costs trust.
 */
async function pruneUnreferenced(env, clubId, keep, now = Date.now()) {
  try {
    let cursor;
    do {
      // eslint-disable-next-line no-await-in-loop
      const listed = await env.CARD_ASSETS.list({ prefix: clubCardPrefix(clubId), cursor });
      for (const object of listed.objects ?? []) {
        const hash = object.key.slice(clubCardPrefix(clubId).length);
        if (keep.has(hash)) continue;
        const uploaded = object.uploaded ? new Date(object.uploaded).getTime() : 0;
        if (now - uploaded < PRUNE_GRACE_MS) continue;
        // eslint-disable-next-line no-await-in-loop
        await env.CARD_ASSETS.delete(object.key);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch {
    // Nothing a publisher can do about it, and nothing they need to know.
  }
}

async function bumpVer(store, clubId, club) {
  const ver = (club.ver ?? 1) + 1;
  await store.put(clubKey(clubId), JSON.stringify({ ...club, ver }));
  return ver;
}

/** PUT /api/club/cards/<hash> — one image, content-addressed. */
async function handleCardUpload(request, env, hash) {
  const ctx = await requirePublisher(request, env);
  if (ctx.response) return ctx.response;
  const { clubId } = ctx;

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_CARD_BYTES) return json({ error: 'image_too_large' }, 413);

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength) return json({ error: 'empty_image' }, 400);
  if (bytes.byteLength > MAX_CARD_BYTES) return json({ error: 'image_too_large' }, 413);

  // The name must be the real digest, or the store is not content-addressed:
  // a client could park anything under a hash another device is about to fetch.
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== hash) return json({ error: 'hash_mismatch' }, 400);

  const type = sniffImageType(bytes);
  if (!type) return json({ error: 'unsupported_image' }, 415);

  const key = clubCardObjectKey(clubId, hash);
  // Idempotent, and a retry never counts twice against the quota.
  if (await env.CARD_ASSETS.head(key)) return json({ stored: true, deduped: true });

  if ((await usedBytes(env, clubId)) + bytes.byteLength > MAX_CLUB_CARD_BYTES) {
    return json({ error: 'storage_limit' }, 507);
  }

  await env.CARD_ASSETS.put(key, bytes, { httpMetadata: { contentType: type } });
  return json({ stored: true, deduped: false });
}

/**
 * GET /api/club/cards/<hash> — for any device holding the club, or for the
 * console, which may reach it through a sign-in or the billing link and carry
 * no club token at all.
 *
 * A read, so revocation is not consulted: a revoked device keeps reading the
 * club it was already reading until its token expires, as it does everywhere else.
 */
async function handleCardDownload(request, env, hash) {
  if (!env.CARD_ASSETS) return json({ error: 'Asset storage is not configured' }, 503);

  let clubId = readClub(request, env)?.clubId ?? null;
  if (!clubId) {
    const admin = await readAdminContext(request, env);
    if (admin?.role === 'admin') clubId = admin.clubId;
  }
  if (!clubId) return unauthorized();

  const key = clubCardObjectKey(clubId, hash);
  const object = request.method === 'HEAD' ? await env.CARD_ASSETS.head(key) : await env.CARD_ASSETS.get(key);
  if (!object) return json({ error: 'not_found' }, 404);

  return new Response(request.method === 'HEAD' ? null : object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
      // Content-addressed, so the bytes behind this URL never change — but they
      // are one club's, so no shared cache may keep them.
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** PUT /api/club/cards — make a set of uploaded images the club's. */
async function handleCardPublish(request, env) {
  const ctx = await requirePublisher(request, env);
  if (ctx.response) return ctx.response;
  const { store, clubId, club, uid } = ctx;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const next = normalizeCardSet(body);
  if (!next) return json({ error: 'invalid_card_set' }, 400);

  // Every image must already be here. A set naming one that is not would land
  // on every device as a card that can never load.
  const hashes = [...new Set(Object.values(next.images))];
  const heads = await Promise.all(hashes.map((hash) => env.CARD_ASSETS.head(clubCardObjectKey(clubId, hash))));
  const missing = hashes.filter((_, i) => !heads[i]);
  if (missing.length) return json({ error: 'missing_images', missing }, 409);

  const stored = await readClubCards(env, clubId);
  // An identical publish writes nothing: bumping `ver` for it would have every
  // device in the club re-download the set it already has.
  if (cardSetUnchanged(stored, next)) return json({ ver: club.ver ?? 1, cards: buildCards(stored) });

  const record = { ...next, publishedBy: uid, publishedAt: Date.now() };
  await store.put(clubCardsKey(clubId), JSON.stringify(record));
  const ver = await bumpVer(store, clubId, club);

  await pruneUnreferenced(env, clubId, new Set(hashes));
  return json({ ver, cards: buildCards(record) });
}

/**
 * DELETE /api/club/cards — admin only, from either door into the console.
 * Every device goes back to its own choice of cards on its next refresh.
 */
async function handleCardRemove(request, env) {
  const store = entitlementStore(env);
  if (!store) return json({ error: 'Club storage is not configured' }, 503);

  const context = await readAdminContext(request, env);
  if (!context) return unauthorized();
  if (context.role !== 'admin') return forbidden();

  const club = await readClubRecord(env, context.clubId);
  if (!club) return json({ error: 'club_not_found' }, 404);

  if (!(await readClubCards(env, context.clubId))) return json({ ver: club.ver ?? 1, cards: null });

  await store.delete(clubCardsKey(context.clubId));
  const ver = await bumpVer(store, context.clubId, club);
  if (env.CARD_ASSETS) await pruneUnreferenced(env, context.clubId, new Set());
  return json({ ver, cards: null });
}

/**
 * The card routes, reached from `handleClub`.
 *
 * @param {Request} request
 * @param {string} route - `cards` or `cards/<hash>`
 * @param {Object} env
 * @returns {Promise<Response>}
 */
export async function handleClubCards(request, route, env) {
  if (route === 'cards') {
    if (request.method === 'PUT') return handleCardPublish(request, env);
    if (request.method === 'DELETE') return handleCardRemove(request, env);
    return methodNotAllowed();
  }

  const hash = route.slice('cards/'.length);
  // A literal digest only, so nothing a client sends can shape the object key.
  if (!HASH_PATTERN.test(hash)) return json({ error: 'not_found' }, 404);
  if (request.method === 'GET' || request.method === 'HEAD') return handleCardDownload(request, env, hash);
  if (request.method === 'PUT') return handleCardUpload(request, env, hash);
  return methodNotAllowed();
}
