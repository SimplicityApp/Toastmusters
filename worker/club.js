import crypto from 'node:crypto';
import { readSession, readClub, proReleased } from './auth.js';
import { json, methodNotAllowed, notConfigured, notFound, unauthorized } from './http.js';
import { entitlementStore, readClubRecord, resolveAccess } from './entitlements.js';
import { mintClubToken } from './club-token.js';
import { normalizeCode, formatCode, clubByCodeKey, clubDeviceKey, clubMemberKey, readMemberRole } from './club-admin.js';
import { createClubForSubscriber } from './club-create.js';
import { readClubName } from './billing.js';
import { createStripeClient } from './stripe.js';
import { handleClubPresets, readClubPresets } from './club-presets.js';
import { handleClubMeetings } from './club-meetings.js';
import { handleClubAdminRoutes } from './club-admin-routes.js';
import { handleMagicLinkRequest, handleClubManage, handleClubManageSignOut } from './club-magic.js';

/**
 * Joining a club from a device, and asking the club what it looks like today.
 *
 * Two routes answer with the same document. POST /api/club/activate takes a
 * code and hands back a clubToken; GET /api/club takes that token and is
 * called on app start, at most once a day. Splitting content from plan is the
 * point of the shape: content is versioned and replaces a device's copy only
 * when `ver` moves, while plan and `entitled` carry no version and are applied
 * every time — a club can lapse with nothing having been written, because a
 * grace window just expires against the clock.
 *
 * The doors into a club sit behind the `pro` release flag (worker/flags.js):
 * while it is off, activate, create, magic-link and manage answer a bare 404.
 * The refresh and every route that needs an existing club stay open, so a
 * device already in a club keeps working (see CLUB_DOORS below).
 */

/**
 * Codes are not usefully guessable (1.07 billion suffixes) but they are short
 * enough to be worth throttling anyway: entropy does nothing against a leaked
 * code, throttling does nothing against a short one, and they fail differently.
 */
async function throttled(request, env) {
  if (!env.CLUB_ACTIVATE_LIMITER?.limit) return false;
  const key = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  try {
    const { success } = await env.CLUB_ACTIVATE_LIMITER.limit({ key });
    return !success;
  } catch {
    // A limiter that is down must not take activation down with it.
    return false;
  }
}

/**
 * Unknown, revoked and lapsed codes all answer with this, so probing cannot
 * confirm that a club exists — which is also the one line of copy the product
 * asks for: "That code isn't active. Check with your club officer."
 */
const invalidCode = () => json({ error: 'invalid_code' }, 400);

async function readJsonBody(request) {
  try {
    return (await request.json()) ?? {};
  } catch {
    return {};
  }
}

/**
 * A human-readable name for the device row in the club roster. Derived from the
 * user agent because there is nothing else to derive it from — activation is
 * anonymous by design, and "Firefox · Windows" is enough for an admin to
 * recognise the laptop they are about to revoke.
 */
export function deviceLabel(request) {
  const ua = request.headers.get('user-agent') || '';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
      : /OPR\//.test(ua) ? 'Opera'
        : /Chrome\//.test(ua) ? 'Chrome'
          : /Firefox\//.test(ua) ? 'Firefox'
            : /Safari\//.test(ua) ? 'Safari'
              : null;
  const os =
    /Windows/.test(ua) ? 'Windows'
      : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
          : /Android/.test(ua) ? 'Android'
            : /Linux/.test(ua) ? 'Linux'
              : null;
  if (browser && os) return `${browser} · ${os}`;
  return browser || os || 'Unknown device';
}

/** Toastmasters maroon: the kit's colour until a club chooses its own. */
export const DEFAULT_PRIMARY_COLOR = '#772432';

/**
 * Top-right, mirroring the Toastmasters International logo on the other side of
 * the card, and the only corner that stays visible in camera mode — the centre
 * and the bottom of that frame are where the organizer is.
 */
export const DEFAULT_BADGE_PLACEMENT = Object.freeze({ x: 0.8, y: 0.12, scale: 0.12 });

/**
 * The club's brand kit, as a device needs it: structured identity rather than
 * another image upload.
 *
 * The logo is handed over as a URL rather than a hash because its reader is a
 * canvas compositor and a report page, neither of which should have to know how
 * our object keys are built. Public and immutable, so the edge serves it.
 */
export function buildKit(clubId, club) {
  const name = String(club?.name ?? '').trim();
  if (!name) return null;
  const kit = club?.kit && typeof club.kit === 'object' ? club.kit : {};
  const logoHash = typeof kit.logoHash === 'string' && kit.logoHash ? kit.logoHash : null;
  return {
    name,
    logoHash,
    logoUrl: logoHash ? `/api/club-assets/${clubId}/${logoHash}` : null,
    primaryColor: typeof kit.primaryColor === 'string' && kit.primaryColor ? kit.primaryColor : DEFAULT_PRIMARY_COLOR,
    // Default on, both of them: a club that set a kit wants to see it, and a
    // club that has no kit never reaches here at all.
    showOnCards: kit.showOnCards !== false,
    showOnReports: kit.showOnReports !== false,
  };
}

/**
 * The club's badge placement — the default every device starts from.
 *
 * It rides along with the published presets because an admin sets it the same
 * way they set the presets: by positioning it on their own device and choosing
 * "Share with my club". A device that later moves it keeps that move in a key
 * of its own, so a republish reaches every device that never touched it.
 */
export function buildBadge(presets) {
  const badge = presets?.badge;
  if (!badge || typeof badge !== 'object') return { ...DEFAULT_BADGE_PLACEMENT };
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    x: Math.min(1, Math.max(0, number(badge.x, DEFAULT_BADGE_PLACEMENT.x))),
    y: Math.min(1, Math.max(0, number(badge.y, DEFAULT_BADGE_PLACEMENT.y))),
    scale: Math.min(1, Math.max(0.01, number(badge.scale, DEFAULT_BADGE_PLACEMENT.scale))),
  };
}

/**
 * The officer's shareable activation link for a code.
 *
 * Built here rather than in each client because only the Worker knows the
 * canonical web host. Nothing in the product produced this link before, which
 * left the one documented way to discover the code field with no producer.
 */
export function shareUrlFor(env, code) {
  if (!env?.WEB_ORIGIN || !code) return null;
  try {
    return new URL(`/pro/${formatCode(code)}`, env.WEB_ORIGIN).toString();
  } catch {
    return null;
  }
}

/**
 * The whole club, as a device needs to see it.
 *
 * The split down the middle of this document is the point. Content — the
 * presets, the brand kit, and the badge default — is versioned,
 * and a device replaces its copy only when `ver` moves, which is what lets a
 * timer's local list survive a daily refresh and lose only to an actual
 * publish. Everything below `timezone` carries no version and is applied every
 * time, because it can change with nothing having been written: a club lapses
 * when a grace window expires against the clock, and a member's role changes
 * under a different uid entirely.
 *
 * @param {Object} env
 * @param {string} clubId
 * @param {Object|null} club - the already-read club record
 * @param {Object} access - the combined entitlement from resolveAccess
 * @param {{uid?: string|null}} [caller] - whose role to report, if anyone's
 */
export async function buildClubState(env, clubId, club, access, { uid = null } = {}) {
  const [presets, role] = await Promise.all([
    readClubPresets(env, clubId),
    readMemberRole(env, clubId, uid),
  ]);

  return {
    ver: club?.ver ?? 1,
    club: { id: clubId, name: club?.name ?? null },
    kit: buildKit(clubId, club),
    presets: presets
      ? {
        rules: presets.rules ?? {},
        order: presets.order ?? [],
        hiddenBuiltins: presets.hiddenBuiltins ?? [],
        publishedBy: presets.publishedBy ?? null,
        publishedAt: presets.publishedAt ?? null,
      }
      : null,
    badge: buildBadge(presets),
    timezone: club?.timezone ?? null,
    // Not versioned: a guest device sees null and a promotion takes effect on
    // the next refresh without anything being republished.
    role,
    // The code is the club's password, so only an admin is told it — but an
    // admin is told it *here*, on the refresh every surface already makes,
    // rather than only by the web console. Without this the one person who
    // needs to share the code cannot read it anywhere inside the Zoom app.
    code: role === 'admin' && club?.code ? formatCode(club.code) : null,
    shareUrl: role === 'admin' && club?.code ? shareUrlFor(env, club.code) : null,
    plan: access.plan,
    entitled: access.entitled,
    status: access.status,
    currentPeriodEnd: access.currentPeriodEnd,
    cancelAtPeriodEnd: access.cancelAtPeriodEnd,
    source: access.source,
  };
}

/**
 * The clubId a write may be credited to: verified, present, and not revoked.
 *
 * The club token is HMAC-only so that sending it on every request stays cheap,
 * which means revoking an already-issued one has to consult state somewhere.
 * Here is the cheapest place that still makes revocation *mean* something — it
 * rides only on requests that were already going to write, and it takes a
 * revoked device's ability to publish, append or consume quota away
 * immediately. What that device keeps, for up to the token's 24 hours, is the
 * ability to read a club it was already reading.
 *
 * @returns {Promise<string|null>}
 */
export async function verifiedClubId(env, claims) {
  if (!claims?.clubId || !claims?.deviceId) return null;
  const store = entitlementStore(env);
  if (!store) return null;
  let device;
  try {
    device = await store.get(clubDeviceKey(claims.clubId, claims.deviceId), 'json');
  } catch {
    return null;
  }
  if (!device || device.revokedAt) return null;
  return claims.clubId;
}

/**
 * POST /api/club/activate — a device types a code and becomes Pro.
 *
 * Public and rate-limited. A session is read if one happens to be there, but
 * never required: a guest with no Zoom identity has to be able to use a club
 * code, and that is the case the whole feature is sold on.
 */
export async function handleClubActivate(request, env) {
  if (request.method !== 'POST') return methodNotAllowed();
  if (!env.SESSION_SIGNING_KEY) return notConfigured('Club activation');
  const store = entitlementStore(env);
  if (!store) return json({ error: 'Club storage is not configured' }, 503);

  if (await throttled(request, env)) return json({ error: 'too_many_attempts' }, 429);

  const body = await readJsonBody(request);
  const code = normalizeCode(body?.code);
  if (!code) return invalidCode();

  let clubId;
  try {
    clubId = await store.get(clubByCodeKey(code));
  } catch {
    clubId = null;
  }
  if (!clubId) return invalidCode();

  const club = await readClubRecord(env, clubId);
  if (!club) return invalidCode();

  const access = await resolveAccess(env, { clubId, club });
  // A club that has lapsed is not a club a device may join. Same failure as an
  // unknown code, on purpose.
  if (!access.entitled) return invalidCode();

  const session = readSession(request, env);
  const uid = session?.uid ?? null;
  const now = Date.now();

  const clubToken = await attachDevice(env, request, {
    clubId,
    club,
    uid,
    now,
    deviceId: readDeviceId(body?.deviceId),
  });
  if (!clubToken) return notConfigured('Club activation');

  return json({ clubToken, ...(await buildClubState(env, clubId, club, access, { uid })) });
}

/**
 * A device id this browser minted for itself, if it looks like one of ours.
 *
 * Client-chosen on purpose: it has to survive `leaveClub()`, which is exactly
 * what a server-minted id cannot do. Guessing someone else's id buys nothing
 * anyone who already holds the club code does not have — the id names a row in
 * the roster, not a permission — but the shape is still checked, because this
 * string becomes part of a KV key.
 */
export function readDeviceId(raw) {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(raw) ? raw : null;
}

/**
 * Put this device on a club's roll and hand it a token.
 *
 * Shared by activation and by creation: an officer who just minted their club
 * must end up exactly where a timer who typed the code ends up, rather than
 * being told to go and type a code they were shown two lines above.
 *
 * The device id is the browser's own, so leaving and rejoining reuses the row
 * rather than adding a second one — a roster that grew a "macOS" line every
 * time somebody re-typed the code was showing four devices for one laptop, and
 * an admin cannot revoke what they cannot recognise. A revoked row is reused
 * as-is and stays revoked: re-typing the code is not a way out of a revocation.
 *
 * @returns {Promise<string|null>} the club token, or null when unsignable
 */
async function attachDevice(env, request, { clubId, club, uid, now, deviceId: requested }) {
  const store = entitlementStore(env);
  const deviceId = requested ?? crypto.randomUUID();

  const existing = requested ? await store.get(clubDeviceKey(clubId, deviceId), 'json').catch(() => null) : null;
  await store.put(
    clubDeviceKey(clubId, deviceId),
    JSON.stringify({
      label: deviceLabel(request),
      uid,
      activatedAt: existing?.activatedAt ?? now,
      lastSeenAt: now,
      // Carried, never cleared. Activation is a door, not an appeal.
      revokedAt: existing?.revokedAt ?? null,
    })
  );

  // Access attaches to a device; authorization attaches to a person. A guest
  // gets a device row and nothing else, which is what makes "you cannot grant
  // editing rights to an anonymous device" true by construction.
  //
  // The existence check is also what keeps a club's creator an admin: their
  // member row was written by createClubFromPending moments earlier.
  if (uid) {
    const existing = await store.get(clubMemberKey(clubId, uid), 'json');
    if (!existing) {
      await store.put(
        clubMemberKey(clubId, uid),
        JSON.stringify({ role: 'member', displayName: null, addedAt: now, revokedAt: null })
      );
    }
  }

  return mintClubToken({ clubId, deviceId, uid, ver: club.ver ?? 1 }, env.SESSION_SIGNING_KEY, now);
}

/** Why a create was refused, in the words the officer reads. */
const CREATE_ERRORS = {
  not_a_subscriber: 403,
  no_billing_account: 409,
  creation_in_progress: 409,
  club_storage_unavailable: 503,
};

/**
 * POST /api/club/create — a subscriber mints the club their plan pays for.
 *
 * The club is the unit of Pro, but until this existed the only way to get one
 * was to name it at checkout and then wait for an operator to run the CLI. That
 * left every subscriber from before the club bundle — and everyone who skipped
 * the optional name field — paying for features they could not reach.
 *
 * Requires a session, because a club belongs to the person who pays for it and
 * a guest device has nobody to make an admin. Comp grants are deliberately not
 * accepted: those stay operator-minted.
 */
export async function handleClubCreate(request, env) {
  if (request.method !== 'POST') return methodNotAllowed();
  if (!env.SESSION_SIGNING_KEY) return notConfigured('Club creation');

  const session = readSession(request, env);
  if (!session) return unauthorized();

  const body = await readJsonBody(request);
  const result = await createClubForSubscriber(env, {
    uid: session.uid,
    clubName: readClubName(body?.clubName),
    timezone: typeof body?.timezone === 'string' ? body.timezone.slice(0, 64) : null,
    stripe: createStripeClient(env),
  });

  if (!result.ok) return json({ error: result.error }, CREATE_ERRORS[result.error] ?? 500);

  const { clubId, club, code } = result;
  const access = await resolveAccess(env, { uid: session.uid, clubId, club });
  const clubToken = await attachDevice(env, request, {
    clubId,
    club,
    uid: session.uid,
    now: Date.now(),
    deviceId: readDeviceId(body?.deviceId),
  });
  if (!clubToken) return notConfigured('Club creation');

  return json({
    clubToken,
    created: result.created,
    ...(await buildClubState(env, clubId, club, access, { uid: session.uid })),
    // Last, so these win over the role-gated pair above. The member row making
    // this caller an admin was written moments ago and KV is eventually
    // consistent, so the role lookup inside buildClubState can still read null
    // — and the one request that must never fail to return the code is the one
    // that just minted it.
    code: formatCode(code),
    shareUrl: shareUrlFor(env, code),
  });
}

/**
 * POST /api/club/leave — this device is done with the club.
 *
 * The other half of `leaveClub()` on the device. Without it, leaving was purely
 * local: the row stayed on the roster for ever, and every rejoin added another,
 * so an admin trying to work out which laptop to revoke was reading a list of
 * ghosts. Deleted rather than marked, because a device that left is not a device
 * that was thrown out, and the two must not look the same in the console.
 *
 * A revoked row is left exactly where it is. The device calls this on its way
 * out of a 403 too, and deleting the row there would make re-typing the code a
 * way to undo a revocation — which is the one thing revocation has to mean.
 *
 * Idempotent, and quiet about what it found: the device is leaving either way.
 */
export async function handleClubLeave(request, env) {
  if (request.method !== 'POST') return methodNotAllowed();

  const claims = readClub(request, env);
  if (!claims?.clubId || !claims?.deviceId) return unauthorized();

  const store = entitlementStore(env);
  if (!store) return json({ error: 'Club storage is not configured' }, 503);

  const key = clubDeviceKey(claims.clubId, claims.deviceId);
  const device = await store.get(key, 'json').catch(() => null);
  if (device && !device.revokedAt) await store.delete(key).catch(() => {});
  return json({ left: true });
}

/**
 * GET /api/club — the daily refresh.
 *
 * Re-mints the token (bounding a revoked device's residual read access by the
 * same 24-hour clock that governs a lapse) and re-reads the plan, so a club
 * that lapsed overnight is off on the next app start. A session is read when
 * present so the answer is the *combined* one: a buyer who also typed their own
 * club's code must not be told they are free.
 */
export async function handleClubState(request, env) {
  if (request.method !== 'GET') return methodNotAllowed();

  const claims = readClub(request, env);
  if (!claims) return unauthorized();

  const store = entitlementStore(env);
  if (!store) return json({ error: 'Club storage is not configured' }, 503);

  const club = await readClubRecord(env, claims.clubId);
  if (!club) return json({ error: 'club_not_found' }, 404);

  const device = await store.get(clubDeviceKey(claims.clubId, claims.deviceId), 'json');
  if (!device || device.revokedAt) return json({ error: 'club_access_revoked' }, 403);

  const now = Date.now();
  const session = readSession(request, env);
  const access = await resolveAccess(env, { uid: session?.uid ?? null, clubId: claims.clubId, club }, now);

  // Once a day, on the one request that already costs a round trip. The roster
  // is the only reader, and "last seen yesterday" is the resolution it needs.
  if (!device.lastSeenAt || now - device.lastSeenAt > 12 * 60 * 60 * 1000) {
    await store.put(clubDeviceKey(claims.clubId, claims.deviceId), JSON.stringify({ ...device, lastSeenAt: now }));
  }

  const state = await buildClubState(env, claims.clubId, club, access, { uid: session?.uid ?? null });
  const clubToken = mintClubToken(
    { clubId: claims.clubId, deviceId: claims.deviceId, uid: claims.uid, ver: club.ver ?? 1 },
    env.SESSION_SIGNING_KEY,
    now
  );

  return json({ ...(clubToken ? { clubToken } : {}), ...state });
}

/**
 * The routes that let someone into a club: joining with a code, minting one,
 * and the two halves of the mailed admin link. These, and only these, sit
 * behind the `pro` release flag (worker/flags.js).
 *
 * Everything else stays open on purpose. A 404 from GET /api/club makes the
 * client leave the club, and a 4xx from the speech outbox makes it drop the
 * queued speech, so a blanket gate would evict club devices and lose their
 * work the first time the flag went off. The other routes need a club token or
 * an admin session, and while the flag is off nobody can get either.
 */
const CLUB_DOORS = new Set(['activate', 'create', 'magic-link', 'manage']);

/**
 * Dispatch for /api/club and /api/club/*.
 *
 * @param {Request} request
 * @param {URL} url
 * @param {Object} env
 * @param {{ctx?: Object}} [deps] - ctx lets the flag answer be cached at the edge
 * @returns {Promise<Response>}
 */
export async function handleClub(request, url, env, { ctx } = {}) {
  const route = url.pathname.slice('/api/club'.length).replace(/^\/+|\/+$/g, '');

  // Ahead of every other answer, so a dark door cannot be told apart from a
  // mistyped URL — not even by a 401, a 405 or a "not configured" 503.
  if (CLUB_DOORS.has(route) && !(await proReleased(request, env, ctx))) {
    console.log('flag off: pro', route);
    return notFound();
  }

  if (route === '') return handleClubState(request, env);
  if (route === 'activate') return handleClubActivate(request, env);
  if (route === 'create') return handleClubCreate(request, env);
  if (route === 'leave') return handleClubLeave(request, env);
  if (route === 'presets') return handleClubPresets(request, env);
  if (route === 'meetings' || route.startsWith('meetings/')) return handleClubMeetings(request, route, env);

  // The console's second door. Public (and rate-limited) on the way in, so it
  // sits ahead of the admin routes, which all require a credential.
  if (route === 'magic-link') return handleMagicLinkRequest(request, env);
  if (route === 'manage') return handleClubManage(request, url, env);
  if (route === 'manage/signout') return handleClubManageSignOut(request);

  // roster, members/<uid>/role, devices/<id>/revoke, kit.
  const admin = handleClubAdminRoutes(request, route, env);
  if (admin) return admin;

  return notFound();
}
