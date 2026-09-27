import crypto from 'node:crypto';
import { readSession, readClub } from './auth.js';
import { json, methodNotAllowed, notConfigured, unauthorized } from './http.js';
import { entitlementStore, readClubRecord, resolveAccess } from './entitlements.js';
import { mintClubToken } from './club-token.js';
import { normalizeCode, clubByCodeKey, clubDeviceKey, clubMemberKey } from './club-admin.js';

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

/**
 * The whole club, as a device needs to see it.
 *
 * `kit`, `presets` and `badge` are placeholders until phases 2 and 3 fill them;
 * they are in the contract now so a device caching this document today does not
 * need a migration when they arrive.
 */
export function buildClubState(clubId, club, access) {
  return {
    ver: club?.ver ?? 1,
    club: { id: clubId, name: club?.name ?? null },
    kit: null, // Phase 3
    presets: null, // Phase 2
    badge: null, // Phase 3
    timezone: club?.timezone ?? null,
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
  const deviceId = crypto.randomUUID();

  await store.put(
    clubDeviceKey(clubId, deviceId),
    JSON.stringify({ label: deviceLabel(request), uid, activatedAt: now, lastSeenAt: now, revokedAt: null })
  );

  // Access attaches to a device; authorization attaches to a person. A guest
  // gets a device row and nothing else, which is what makes "you cannot grant
  // editing rights to an anonymous device" true by construction.
  if (uid) {
    const existing = await store.get(clubMemberKey(clubId, uid), 'json');
    if (!existing) {
      await store.put(
        clubMemberKey(clubId, uid),
        JSON.stringify({ role: 'member', displayName: null, addedAt: now, revokedAt: null })
      );
    }
  }

  const clubToken = mintClubToken({ clubId, deviceId, uid, ver: club.ver ?? 1 }, env.SESSION_SIGNING_KEY, now);
  if (!clubToken) return notConfigured('Club activation');

  return json({ clubToken, ...buildClubState(clubId, club, access) });
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

  const state = buildClubState(claims.clubId, club, access);
  const clubToken = mintClubToken(
    { clubId: claims.clubId, deviceId: claims.deviceId, uid: claims.uid, ver: club.ver ?? 1 },
    env.SESSION_SIGNING_KEY,
    now
  );

  return json({ ...(clubToken ? { clubToken } : {}), ...state });
}

/**
 * Dispatch for /api/club and /api/club/*.
 *
 * @param {Request} request
 * @param {URL} url
 * @param {Object} env
 */
export function handleClub(request, url, env) {
  const route = url.pathname.slice('/api/club'.length).replace(/^\/+|\/+$/g, '');
  if (route === '') return handleClubState(request, env);
  if (route === 'activate') return handleClubActivate(request, env);
  return json({ error: 'Not found' }, 404);
}
