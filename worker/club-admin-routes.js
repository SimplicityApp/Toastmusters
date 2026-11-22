import crypto from 'node:crypto';
import { readSession } from './auth.js';
import { json, methodNotAllowed } from './http.js';
import { entitlementStore, clubKey, readClubRecord, resolveAccess } from './entitlements.js';
import {
  activeAdmins,
  clubMemberKey,
  clubByEmailKey,
  clubOwnerUid,
  clearClubIndex,
  formatCode,
  isLiveMember,
  memberClub,
  normalizeEmail,
} from './club-admin.js';
import { CLUB_PLACES, clubPlaces, countPlaces } from './club-places.js';
import { buildKit, DEFAULT_PRIMARY_COLOR } from './club.js';
import { buildCards, readClubCards } from './club-cards.js';
import { readAdminSession } from './club-magic.js';

/**
 * The officer's console: who is in the club, what they may do, and the kit.
 *
 * Two doors, one permission check. Zoom sign-in carries a uid whose `admin`
 * role lives on a member record; the magic link carries the billing address and
 * is `admin` implicitly, because the address that paid is the one credential
 * that outlives whoever holds the office. They differ only in the **actor**
 * they produce, which is what an audit trail needs — a club should be able to
 * see whether a change came from a named member or from whoever holds the
 * billing mailbox.
 *
 *   GET  /api/club/roster                  the people in the club, and the blocked
 *   POST /api/club/members/<uid>/role      promote, demote, or `revoked` to remove
 *   POST /api/club/members/<uid>/block     `{blocked}`: keep an account out, or let it back
 *   POST /api/club/members/<uid>/name      what the roster calls them
 *   PUT  /api/club/kit                     name, colour, toggles, logo
 *
 * The owner (the account that pays) is fixed: no request from either door
 * removes, blocks or changes the role of them (`409 owner`). Remove frees the
 * place and lets the account rejoin with the code; Block frees it too but keeps
 * a row that makes the code refuse that account until it is unblocked. Either
 * lands on the person's next app open, wherever they are signed in.
 */

const forbidden = () => json({ error: 'forbidden' }, 403);
const unauthorized = () => json({ error: 'Unauthorized' }, 401);
const notFound = () => json({ error: 'not_found' }, 404);

/** A logo is a mark, not a photograph. Card artwork gets 2 MB; this needs less. */
const MAX_LOGO_BYTES = 1024 * 1024;
const MAX_CLUB_NAME_LENGTH = 80;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Raster only.
 *
 * SVG is deliberately absent: `/api/club-assets/*` is public, same-origin and
 * serves whatever content type was stored, and an SVG is a document that can
 * carry script. One club's logo must never be a way to run code on the origin
 * every other club's session cookie belongs to.
 */
const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const ROLES = new Set(['admin', 'editor', 'member']);
/** Not a role: the way this route says "this person is out". */
const REVOKED = 'revoked';

const logoKey = (clubId, hash) => `club/${clubId}/${hash}`;

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

/**
 * The club this request may administer, and on whose behalf.
 *
 * The Zoom door is preferred when it yields an admin, because a named person is
 * the better actor: the audit trail reads better, and the Stripe portal is only
 * reachable under a uid. The club is the one the session's account is in
 * (`memberClub`), so *Manage your club* works in a system browser that has
 * never seen the code. The billing-address session answers for everything
 * else.
 *
 * A signed-in account in no club comes back with no role rather than as null,
 * so the console can tell "not an admin" (403) from "not signed in" (401).
 *
 * @returns {Promise<{clubId: string|null, actor: Object, role: string|null}|null>}
 */
export async function readAdminContext(request, env) {
  const session = readSession(request, env);

  let zoom = null;
  if (session?.uid) {
    const membership = await memberClub(env, session.uid);
    zoom = {
      clubId: membership?.clubId ?? null,
      actor: { type: 'zoom', uid: session.uid },
      role: membership?.role ?? null,
    };
  }
  if (zoom?.role === 'admin') return zoom;

  const billing = readAdminSession(request, env);
  if (billing?.clubId) {
    return { clubId: billing.clubId, actor: { type: 'billing', email: billing.email ?? null }, role: 'admin' };
  }

  return zoom;
}

/**
 * Both doors, one answer: the club and the actor, or the response to send back.
 *
 * @returns {Promise<{club: Object, clubId: string, actor: Object, store: Object}|{response: Response}>}
 */
async function requireAdmin(request, env) {
  const store = entitlementStore(env);
  if (!store) return { response: json({ error: 'Club storage is not configured' }, 503) };

  const context = await readAdminContext(request, env);
  // No credential at all reads as 401 so the console knows to offer its two
  // doors; a credential that is simply not an admin's reads as 403.
  if (!context) return { response: unauthorized() };
  if (context.role !== 'admin') return { response: forbidden() };

  const club = await readClubRecord(env, context.clubId);
  if (!club) return { response: json({ error: 'club_not_found' }, 404) };

  return { store, club, clubId: context.clubId, actor: context.actor };
}

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

/** Every key under a prefix, following the cursor. */
async function listAll(store, prefix) {
  const keys = [];
  let cursor;
  do {
    // eslint-disable-next-line no-await-in-loop
    const listed = await store.list({ prefix, cursor });
    keys.push(...(listed.keys ?? []));
    cursor = listed.list_complete === false ? listed.cursor : undefined;
  } while (cursor);
  return keys;
}

async function readAll(store, keys) {
  const out = [];
  for (const entry of keys) {
    // eslint-disable-next-line no-await-in-loop
    const value = await store.get(entry.name, 'json').catch(() => null);
    if (value) out.push({ name: entry.name, value });
  }
  return out;
}

const ROLE_RANK = { admin: 0, editor: 1, member: 2 };

/**
 * The people in the club, the place count, and the accounts kept out.
 *
 * People are live member rows: the owner first, marked and never counted, then
 * by role and by when they joined. Blocked accounts come back on their own
 * list, so an admin can let one back in. Legacy rows from device-era removals
 * are neither.
 */
export async function handleClubRoster(request, env) {
  if (request.method !== 'GET') return methodNotAllowed();

  const gate = await requireAdmin(request, env);
  if (gate.response) return gate.response;
  const { store, club, clubId, actor } = gate;

  const prefix = clubMemberKey(clubId, '');
  const [rows, owner, placesUsed] = await Promise.all([
    listAll(store, prefix).then((keys) => readAll(store, keys)),
    clubOwnerUid(env, club),
    countPlaces(env, clubId),
  ]);

  const people = [];
  const blocked = [];
  for (const { name, value } of rows) {
    const uid = name.slice(prefix.length);
    if (!uid) continue;
    if (value.blockedAt) {
      blocked.push({ uid, displayName: value.displayName ?? null, blockedAt: value.blockedAt });
      continue;
    }
    if (!isLiveMember(value)) continue;
    people.push({
      uid,
      role: ROLES.has(value.role) ? value.role : 'member',
      displayName: value.displayName ?? null,
      addedAt: value.addedAt ?? null,
      isOwner: uid === owner,
    });
  }

  people.sort((a, b) => {
    if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
    const rank = (ROLE_RANK[a.role] ?? 3) - (ROLE_RANK[b.role] ?? 3);
    if (rank) return rank;
    return (a.addedAt ?? 0) - (b.addedAt ?? 0);
  });
  blocked.sort((a, b) => (b.blockedAt ?? 0) - (a.blockedAt ?? 0));

  const access = await resolveAccess(env, { clubId, club });

  return json({
    club: {
      id: clubId,
      name: club.name ?? null,
      code: club.code ? formatCode(club.code) : null,
      timezone: club.timezone ?? null,
      billingEmail: club.billingEmail ?? null,
      createdAt: club.createdAt ?? null,
      ver: club.ver ?? 1,
    },
    kit: buildKit(clubId, club),
    cards: buildCards(await readClubCards(env, clubId)),
    actor,
    role: 'admin',
    plan: access.plan,
    entitled: access.entitled,
    status: access.status,
    currentPeriodEnd: access.currentPeriodEnd,
    cancelAtPeriodEnd: access.cancelAtPeriodEnd,
    counts: { people: people.length, placesUsed, placesTotal: CLUB_PLACES },
    members: people,
    blocked,
  });
}

// ---------------------------------------------------------------------------
// Roles, removal and blocking
// ---------------------------------------------------------------------------

async function readJsonBody(request) {
  try {
    return (await request.json()) ?? {};
  } catch {
    return {};
  }
}

const ownerRefused = () => json({ error: 'owner' }, 409);

/**
 * Free a place, or say the counter could not be reached. Called before the
 * member row goes, so a failure changes nothing and the admin can retry.
 *
 * @returns {Promise<boolean>}
 */
async function releasePlace(env, clubId, uid) {
  try {
    await clubPlaces(env, clubId).release(uid);
    return true;
  } catch {
    return false;
  }
}

/**
 * POST /api/club/members/<uid>/role — promote, demote, or remove.
 *
 * Removal is the `revoked` role rather than a second endpoint: "this person is
 * out" and "this person is an editor" are the same field from the console's
 * point of view. A removed account loses its row, its index and its place, and
 * may rejoin with the code while a place is free; keeping someone out is
 * Block's job. Only a live member's role changes: there is no "restore",
 * because a removed person has no row, and a role here never creates one —
 * that would take a place without a join.
 */
export async function handleMemberRole(request, env, uid) {
  if (request.method !== 'POST') return methodNotAllowed();

  const gate = await requireAdmin(request, env);
  if (gate.response) return gate.response;
  const { store, club, clubId, actor } = gate;

  if (!uid) return notFound();

  const body = await readJsonBody(request);
  const requested = body?.role === REVOKED ? REVOKED : ROLES.has(body?.role) ? body.role : null;
  if (!requested) return json({ error: 'invalid_role' }, 400);

  if (uid === (await clubOwnerUid(env, club))) return ownerRefused();

  const key = clubMemberKey(clubId, uid);
  const existing = (await store.get(key, 'json').catch(() => null)) ?? null;
  if (!isLiveMember(existing)) return notFound();

  // A club with nobody who can administer it is a club that needs a support
  // ticket to fix, so the last admin cannot demote or remove themselves. Only
  // a club with no known owner can get here: the owner is always an admin.
  if (existing.role === 'admin' && requested !== 'admin' && (await activeAdmins(store, clubId)) <= 1) {
    return json({ error: 'last_admin' }, 409);
  }

  if (requested === REVOKED) {
    if (!(await releasePlace(env, clubId, uid))) return json({ error: 'try_again' }, 503);
    await store.delete(key);
    await clearClubIndex(store, uid, clubId);
    return json({ uid, removed: true, actor });
  }

  const member = { ...existing, role: requested };
  await store.put(key, JSON.stringify(member));
  return json({ uid, member, actor });
}

/**
 * POST /api/club/members/<uid>/block — `{ blocked: true }` keeps an account
 * out of the club, `{ blocked: false }` lets it join with the code again.
 *
 * Blocking keeps (or creates) the account's row as `{ displayName, blockedAt,
 * blockedBy }` with no role, and drops its index and its place. It works on an
 * account that already left, so an admin can block someone after the fact.
 * Unblocking deletes the row and nothing more: the account is not put back,
 * it may simply use the code again.
 */
export async function handleMemberBlock(request, env, uid) {
  if (request.method !== 'POST') return methodNotAllowed();

  const gate = await requireAdmin(request, env);
  if (gate.response) return gate.response;
  const { store, club, clubId, actor } = gate;

  if (!uid) return notFound();

  const body = await readJsonBody(request);
  if (typeof body?.blocked !== 'boolean') return json({ error: 'invalid_block' }, 400);

  if (uid === (await clubOwnerUid(env, club))) return ownerRefused();

  const key = clubMemberKey(clubId, uid);
  const existing = (await store.get(key, 'json').catch(() => null)) ?? null;

  if (!body.blocked) {
    if (existing?.blockedAt) await store.delete(key);
    return json({ uid, blocked: false, actor });
  }

  const live = isLiveMember(existing);
  if (live && existing.role === 'admin' && (await activeAdmins(store, clubId)) <= 1) {
    return json({ error: 'last_admin' }, 409);
  }
  // Someone who holds no place has nothing to release, so an unreachable
  // counter only matters for a live member.
  if (!(await releasePlace(env, clubId, uid)) && live) return json({ error: 'try_again' }, 503);

  if (!existing?.blockedAt) {
    await store.put(
      key,
      JSON.stringify({ displayName: existing?.displayName ?? null, blockedAt: Date.now(), blockedBy: actor })
    );
  }
  await clearClubIndex(store, uid, clubId);
  return json({ uid, blocked: true, actor });
}

/** Long enough for "Sarah (VPE)", short enough that nobody writes an essay. */
const MAX_DISPLAY_NAME_LENGTH = 60;

/**
 * POST /api/club/members/<uid>/name — what this person is called in the roster.
 *
 * A nickname an admin types, not an identity we harvest. Zoom will tell us a
 * `screenName` through `getUserContext`, and reading it would fill the roster
 * in by itself — but it is personal data this product has never collected, and
 * collecting it is a privacy-policy change rather than a code change. Until
 * then a raw uid is a bad label, and an officer typing "Sarah" once fixes it
 * for everybody without anyone's name leaving the club.
 *
 * Renames an existing row only (a member or a blocked account): writing a row
 * here would take a place without a join. An empty name clears it, which is
 * the undo.
 */
export async function handleMemberName(request, env, uid) {
  if (request.method !== 'POST') return methodNotAllowed();

  const gate = await requireAdmin(request, env);
  if (gate.response) return gate.response;
  const { store, clubId, actor } = gate;

  if (!uid) return notFound();

  const body = await readJsonBody(request);
  const raw = typeof body?.name === 'string' ? body.name.trim() : '';
  if (raw.length > MAX_DISPLAY_NAME_LENGTH) return json({ error: 'invalid_name' }, 400);

  const key = clubMemberKey(clubId, uid);
  const existing = (await store.get(key, 'json').catch(() => null)) ?? null;
  if (!existing) return notFound();

  const member = { ...existing, displayName: raw || null };
  await store.put(key, JSON.stringify(member));

  return json({ uid, member, actor });
}

// ---------------------------------------------------------------------------
// The brand kit
// ---------------------------------------------------------------------------

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** `'true'`/`'false'`/`'1'`/`'0'` from a form, or a real boolean from JSON. */
function readBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 'on') return true;
  if (value === 'false' || value === '0' || value === 'off') return false;
  return null;
}

/**
 * Both shapes, because the editor has both jobs: a colour change is JSON and a
 * logo change has to be multipart, and making every colour change carry a
 * multipart envelope would be ceremony for its own sake.
 *
 * @returns {Promise<{fields: Object, logo: {bytes: Uint8Array, type: string}|null}|null>}
 */
async function readKitBody(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('multipart/form-data')) {
    const body = await readJsonBody(request);
    return { fields: body ?? {}, logo: null };
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return null;
  }

  const fields = {};
  for (const name of ['name', 'primaryColor', 'showOnCards', 'showOnReports', 'removeLogo']) {
    const value = form.get(name);
    if (typeof value === 'string') fields[name] = value;
  }

  const file = form.get('logo');
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    return { fields, logo: null };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { fields, logo: { bytes, type: file.type || '' } };
}

/**
 * PUT /api/club/kit — the self-serve kit editor.
 *
 * Patch semantics: a field that is absent is a field nobody touched. The whole
 * write bumps `ver`, and only when something a device would actually see has
 * changed — bumping it for a no-op would make every device in the club discard
 * its presets to receive the presets it already has.
 */
export async function handleClubKit(request, env) {
  if (request.method !== 'PUT' && request.method !== 'POST') return methodNotAllowed();

  const gate = await requireAdmin(request, env);
  if (gate.response) return gate.response;
  const { store, club, clubId, actor } = gate;

  const parsed = await readKitBody(request);
  if (!parsed) return json({ error: 'invalid_kit' }, 400);
  const { fields, logo } = parsed;

  const kit = club.kit && typeof club.kit === 'object' ? { ...club.kit } : {};
  let name = club.name ?? null;

  if (fields.name !== undefined) {
    const trimmed = String(fields.name ?? '').trim();
    if (!trimmed || trimmed.length > MAX_CLUB_NAME_LENGTH) return json({ error: 'invalid_name' }, 400);
    name = trimmed;
  }

  if (fields.primaryColor !== undefined) {
    const color = String(fields.primaryColor ?? '').trim();
    if (!HEX_COLOR.test(color)) return json({ error: 'invalid_color' }, 400);
    kit.primaryColor = color.toLowerCase();
  } else if (!kit.primaryColor) {
    kit.primaryColor = DEFAULT_PRIMARY_COLOR;
  }

  for (const toggle of ['showOnCards', 'showOnReports']) {
    if (fields[toggle] === undefined) continue;
    const value = readBoolean(fields[toggle]);
    if (value === null) return json({ error: 'invalid_toggle' }, 400);
    kit[toggle] = value;
  }

  const previousLogo = typeof kit.logoHash === 'string' && kit.logoHash ? kit.logoHash : null;

  if (logo) {
    if (!env.CARD_ASSETS) return json({ error: 'Asset storage is not configured' }, 503);
    if (!logo.bytes.byteLength || logo.bytes.byteLength > MAX_LOGO_BYTES) return json({ error: 'logo_too_large' }, 413);
    if (!LOGO_TYPES.has(logo.type)) return json({ error: 'invalid_logo_type' }, 415);

    // Content-addressed, like the card artwork: re-uploading the same mark is
    // free, a retry after a dropped connection is idempotent, and the URL the
    // badge compositor caches for a year can never point at different bytes.
    const hash = sha256(logo.bytes);
    if (hash !== previousLogo) {
      await env.CARD_ASSETS.put(logoKey(clubId, hash), logo.bytes, { httpMetadata: { contentType: logo.type } });
    }
    kit.logoHash = hash;
  } else if (readBoolean(fields.removeLogo) === true) {
    kit.logoHash = null;
  }

  // The old object goes only once the record pointing at it is about to stop
  // doing so, and never when the new logo is the same bytes.
  const droppedLogo = previousLogo && kit.logoHash !== previousLogo ? previousLogo : null;

  const changed =
    name !== (club.name ?? null) || JSON.stringify(kit) !== JSON.stringify(club.kit ?? null);
  if (!changed) {
    return json({ ver: club.ver ?? 1, kit: buildKit(clubId, club), club: { id: clubId, name }, actor });
  }

  const ver = (club.ver ?? 1) + 1;
  const next = { ...club, name, kit, ver };
  await store.put(clubKey(clubId), JSON.stringify(next));

  // The billing index is keyed by address, and a rename does not move it — but
  // a club that has never had one indexed (a hand-made record) gets it now, so
  // the magic-link door works without a second migration step.
  if (next.billingEmail && !(await store.get(clubByEmailKey(next.billingEmail)).catch(() => null))) {
    await store.put(clubByEmailKey(normalizeEmail(next.billingEmail)), clubId);
  }

  if (droppedLogo && env.CARD_ASSETS?.delete) {
    // Best effort: an orphaned object costs pennies, a failed edit costs trust.
    await env.CARD_ASSETS.delete(logoKey(clubId, droppedLogo)).catch(() => {});
  }

  return json({ ver, kit: buildKit(clubId, next), club: { id: clubId, name }, actor });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * The console's routes, reached from `handleClub`.
 *
 * @param {Request} request
 * @param {string} route - the path after `/api/club/`, e.g. `members/<uid>/role`
 * @param {Object} env
 * @returns {Promise<Response>|Response|null} null when this is not a console route
 */
export function handleClubAdminRoutes(request, route, env) {
  if (route === 'roster') return handleClubRoster(request, env);
  if (route === 'kit') return handleClubKit(request, env);

  if (route.startsWith('members/')) {
    const [uid, tail, ...extra] = route.slice('members/'.length).split('/');
    if (extra.length) return json({ error: 'Not found' }, 404);
    if (tail === 'role') return handleMemberRole(request, env, decodeURIComponent(uid || ''));
    if (tail === 'block') return handleMemberBlock(request, env, decodeURIComponent(uid || ''));
    if (tail === 'name') return handleMemberName(request, env, decodeURIComponent(uid || ''));
    return json({ error: 'Not found' }, 404);
  }

  return null;
}
