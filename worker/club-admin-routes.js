import crypto from 'node:crypto';
import { readSession, readClub } from './auth.js';
import { json, methodNotAllowed } from './http.js';
import { entitlementStore, clubKey, readClubRecord, resolveAccess } from './entitlements.js';
import {
  clubDeviceKey,
  clubMemberKey,
  clubByEmailKey,
  formatCode,
  normalizeEmail,
  readMemberRole,
} from './club-admin.js';
import { buildKit, DEFAULT_PRIMARY_COLOR } from './club.js';
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
 *   GET  /api/club/roster                  devices grouped under their person
 *   POST /api/club/members/<uid>/role      grant, demote, revoke, restore
 *   POST /api/club/devices/<id>/revoke     the only handle a guest device has
 *   PUT  /api/club/kit                     name, colour, toggles, logo
 *
 * Enforcement of a revocation is already in place from the earlier phases — the
 * write paths read `club-device:` — so a revoked device stops publishing,
 * appending and consuming the club's R2 quota immediately, and loses read
 * access when its 24-hour token expires.
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
 * reachable under a uid. The billing-address session answers for everything
 * else, including the browser that never activated a club code at all — which
 * is precisely the situation it exists for.
 *
 * Note what the Zoom door does *not* consult: the device record. Access
 * attaches to a device, authorization attaches to a person, and the console is
 * entirely about the second. Revoking a person clears their role — that is one
 * KV read away in `readMemberRole` — while revoking a device is about what that
 * laptop may do with the club's content, not about who may run the club.
 *
 * @returns {Promise<{clubId: string, actor: Object, role: string}|null>}
 */
export async function readAdminContext(request, env) {
  const claims = readClub(request, env);
  const session = readSession(request, env);

  let zoom = null;
  if (claims?.clubId && session?.uid) {
    zoom = {
      clubId: claims.clubId,
      actor: { type: 'zoom', uid: session.uid },
      // Reported rather than filtered, so the caller can tell "not an admin"
      // (403, and the console can say why) from "not signed in at all" (401).
      role: await readMemberRole(env, claims.clubId, session.uid),
    };
  }
  // A named person is the better actor whenever there is one: the audit trail
  // reads better, and the Stripe portal is only reachable under a uid.
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
const bySeen = (a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);

/**
 * Devices grouped under the person they belong to, with unidentified devices
 * listed on their own.
 *
 * The guest row is not an oversight: a device that activated with no Zoom
 * identity is the only handle an admin has on whoever is using their code, so
 * it has to be visible and revocable even though there is no name to put on it.
 */
export async function handleClubRoster(request, env) {
  if (request.method !== 'GET') return methodNotAllowed();

  const gate = await requireAdmin(request, env);
  if (gate.response) return gate.response;
  const { store, club, clubId, actor } = gate;

  const [deviceKeys, memberKeys] = await Promise.all([
    listAll(store, `club-device:${clubId}:`),
    listAll(store, `club-member:${clubId}:zoom:`),
  ]);
  const [devices, members] = await Promise.all([readAll(store, deviceKeys), readAll(store, memberKeys)]);

  const byUid = new Map();
  for (const { name, value } of members) {
    const uid = name.slice(`club-member:${clubId}:zoom:`.length);
    if (!uid) continue;
    byUid.set(uid, {
      uid,
      role: ROLES.has(value.role) ? value.role : 'member',
      displayName: value.displayName ?? null,
      addedAt: value.addedAt ?? null,
      revokedAt: value.revokedAt ?? null,
      devices: [],
    });
  }

  const guestDevices = [];
  for (const { name, value } of devices) {
    const deviceId = name.slice(`club-device:${clubId}:`.length);
    if (!deviceId) continue;
    const row = {
      deviceId,
      label: value.label || 'Unknown device',
      activatedAt: value.activatedAt ?? null,
      lastSeenAt: value.lastSeenAt ?? null,
      revokedAt: value.revokedAt ?? null,
    };
    const uid = typeof value.uid === 'string' && value.uid ? value.uid : null;
    if (!uid) {
      guestDevices.push(row);
      continue;
    }
    // A device whose member record was never written (or was deleted by hand)
    // still belongs to someone; showing it under an implied member beats
    // dropping it out of the roster entirely.
    if (!byUid.has(uid)) {
      byUid.set(uid, { uid, role: 'member', displayName: null, addedAt: null, revokedAt: null, devices: [] });
    }
    byUid.get(uid).devices.push(row);
  }

  const people = [...byUid.values()];
  for (const person of people) person.devices.sort(bySeen);
  people.sort((a, b) => {
    const rank = (ROLE_RANK[a.role] ?? 3) - (ROLE_RANK[b.role] ?? 3);
    if (rank) return rank;
    return (b.devices[0]?.lastSeenAt ?? 0) - (a.devices[0]?.lastSeenAt ?? 0);
  });
  guestDevices.sort(bySeen);

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
    actor,
    role: 'admin',
    plan: access.plan,
    entitled: access.entitled,
    status: access.status,
    currentPeriodEnd: access.currentPeriodEnd,
    cancelAtPeriodEnd: access.cancelAtPeriodEnd,
    counts: {
      devices: devices.length,
      people: people.length,
      guestDevices: guestDevices.length,
    },
    members: people,
    guestDevices,
  });
}

// ---------------------------------------------------------------------------
// Roles and revocation
// ---------------------------------------------------------------------------

async function readJsonBody(request) {
  try {
    return (await request.json()) ?? {};
  } catch {
    return {};
  }
}

/** How many people can still administer this club. */
async function activeAdmins(store, clubId) {
  const keys = await listAll(store, `club-member:${clubId}:zoom:`);
  const records = await readAll(store, keys);
  return records.filter(({ value }) => value.role === 'admin' && !value.revokedAt).length;
}

/**
 * POST /api/club/members/<uid>/role — promote, demote, revoke or restore.
 *
 * One route for all four because they are one write. Revocation is a `role` of
 * its own rather than a second endpoint: "this person is out" and "this person
 * is an editor" are the same field from the console's point of view, and
 * splitting them would let the two drift.
 *
 * Revoking a person cascades to every device linked to them — a person who is
 * out is out on all of their laptops, and asking an admin to hunt down the rows
 * by hand is how someone stays half-revoked.
 */
export async function handleMemberRole(request, env, uid) {
  if (request.method !== 'POST') return methodNotAllowed();

  const gate = await requireAdmin(request, env);
  if (gate.response) return gate.response;
  const { store, clubId, actor } = gate;

  if (!uid) return notFound();

  const body = await readJsonBody(request);
  const requested = body?.role === REVOKED ? REVOKED : ROLES.has(body?.role) ? body.role : null;
  if (!requested) return json({ error: 'invalid_role' }, 400);

  const key = clubMemberKey(clubId, uid);
  const existing = (await store.get(key, 'json').catch(() => null)) ?? null;
  const now = Date.now();

  // A club with nobody who can administer it is a club that needs a support
  // ticket to fix, so the last admin cannot demote or revoke themselves. The
  // way out is to promote someone else first — which is also the way an
  // officer hands the club over.
  const losingAdmin = existing?.role === 'admin' && !existing?.revokedAt && requested !== 'admin';
  if (losingAdmin && (await activeAdmins(store, clubId)) <= 1) {
    return json({ error: 'last_admin' }, 409);
  }

  const member = {
    role: requested === REVOKED ? (existing?.role && ROLES.has(existing.role) ? existing.role : 'member') : requested,
    displayName: existing?.displayName ?? null,
    addedAt: existing?.addedAt ?? now,
    // Restoring is the same write with the mark cleared, so an accidental
    // revocation costs one tap rather than a re-activation.
    revokedAt: requested === REVOKED ? now : null,
  };
  await store.put(key, JSON.stringify(member));

  let cascaded = 0;
  if (requested === REVOKED) {
    const deviceKeys = await listAll(store, `club-device:${clubId}:`);
    for (const entry of deviceKeys) {
      // eslint-disable-next-line no-await-in-loop
      const device = await store.get(entry.name, 'json').catch(() => null);
      if (!device || device.uid !== uid || device.revokedAt) continue;
      // eslint-disable-next-line no-await-in-loop
      await store.put(entry.name, JSON.stringify({ ...device, revokedAt: now }));
      cascaded += 1;
    }
  }

  return json({ uid, member, devicesRevoked: cascaded, actor });
}

/**
 * POST /api/club/devices/<deviceId>/revoke — cut one laptop off.
 *
 * The only handle a guest device has: it has no person to revoke, so the row
 * itself is the unit. `{ revoked: false }` puts it back, because the single
 * commonest mistake here is revoking the wrong row.
 */
export async function handleDeviceRevoke(request, env, deviceId) {
  if (request.method !== 'POST') return methodNotAllowed();

  const gate = await requireAdmin(request, env);
  if (gate.response) return gate.response;
  const { store, clubId, actor } = gate;

  if (!deviceId) return notFound();

  const key = clubDeviceKey(clubId, deviceId);
  const device = await store.get(key, 'json').catch(() => null);
  if (!device) return notFound();

  const body = await readJsonBody(request);
  const revoked = body?.revoked !== false;
  const next = { ...device, revokedAt: revoked ? Date.now() : null };
  await store.put(key, JSON.stringify(next));

  return json({ deviceId, device: { ...next, deviceId }, actor });
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
    if (extra.length || tail !== 'role') return json({ error: 'Not found' }, 404);
    return handleMemberRole(request, env, decodeURIComponent(uid || ''));
  }

  if (route.startsWith('devices/')) {
    const [deviceId, tail, ...extra] = route.slice('devices/'.length).split('/');
    if (extra.length || tail !== 'revoke') return json({ error: 'Not found' }, 404);
    return handleDeviceRevoke(request, env, decodeURIComponent(deviceId || ''));
  }

  return null;
}
