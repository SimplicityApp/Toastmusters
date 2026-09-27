import { readSession, readClub } from './auth.js';
import { json, methodNotAllowed, unauthorized } from './http.js';
import { entitlementStore, clubKey, readClubRecord, resolveAccess } from './entitlements.js';
import { canPublish, clubPresetsKey, readMemberRole } from './club-admin.js';
import { verifiedClubId } from './club.js';

/**
 * Publishing the club's timing presets.
 *
 * This is the first route that needs a *role* rather than just a club. Access
 * attaches to a device — any device holding the code may read and use the
 * club's list — but authorization attaches to a person, and publishing
 * rewrites every timer's list. So a Zoom identity with an `admin` or `editor`
 * member record is required, which an anonymous device can never have.
 *
 * The write bumps `club:<clubId>.ver`. That version is the only thing that
 * makes a device replace its copy of the list: a plain daily refresh leaves a
 * device's presets exactly as they were, and only an actual publish moves them.
 */

/** Big enough for any club's list, small enough that it cannot be a payload. */
const MAX_ROLES = 100;
const MAX_ROLE_NAME_LENGTH = 80;
/** Sixteen hours: longer than any speech anyone will ever time. */
const MAX_SECONDS = 16 * 60 * 60;

const forbidden = () => json({ error: 'forbidden' }, 403);

function positiveSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const rounded = Math.round(number);
  if (rounded <= 0 || rounded > MAX_SECONDS) return null;
  return rounded;
}

/**
 * Fold one role's rules into the shape every device already understands, or
 * reject them.
 *
 * The same invariant the editor enforces — green < yellow < red — is re-checked
 * here, because a list that violates it would arrive on every device in the
 * club and there is no UI on the receiving end to repair it.
 */
function normalizeRules(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const green = positiveSeconds(raw.green);
  const yellow = positiveSeconds(raw.yellow);
  const red = positiveSeconds(raw.red);
  if (green === null || yellow === null || red === null) return null;
  if (!(green < yellow && yellow < red)) return null;

  const graceRaw = Number(raw.graceAfterRed);
  const grace = Number.isFinite(graceRaw) ? Math.min(MAX_SECONDS, Math.max(0, Math.round(graceRaw))) : 0;

  return { green, yellow, red, graceAfterRed: grace };
}

const usableName = (name) =>
  typeof name === 'string' && name.trim().length > 0 && name.length <= MAX_ROLE_NAME_LENGTH;

/**
 * Turn a published body into the record we store, or null if it is unusable.
 *
 * `order` and `hiddenBuiltins` are filtered rather than validated: a stale
 * entry naming a role that no longer exists is noise, not an error, and
 * dropping it here keeps every device from having to cope with it.
 *
 * @param {unknown} body
 * @returns {{rules: Object, order: string[], hiddenBuiltins: string[]}|null}
 */
export function normalizePresets(body) {
  if (!body || typeof body !== 'object') return null;
  const { rules, order, hiddenBuiltins } = body;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return null;

  const entries = Object.entries(rules);
  if (!entries.length || entries.length > MAX_ROLES) return null;

  const normalized = {};
  for (const [role, value] of entries) {
    if (!usableName(role)) return null;
    const clean = normalizeRules(value);
    if (!clean) return null;
    normalized[role] = clean;
  }

  const known = new Set(Object.keys(normalized));
  return {
    rules: normalized,
    order: (Array.isArray(order) ? order : []).filter((role) => known.has(role)),
    hiddenBuiltins: [
      ...new Set((Array.isArray(hiddenBuiltins) ? hiddenBuiltins : []).filter(usableName)),
    ],
  };
}

/** Whether a publish would actually change anything a device would see. */
export function presetsUnchanged(stored, next) {
  if (!stored) return false;
  return (
    JSON.stringify(stored.rules ?? null) === JSON.stringify(next.rules) &&
    JSON.stringify(stored.order ?? []) === JSON.stringify(next.order) &&
    JSON.stringify(stored.hiddenBuiltins ?? []) === JSON.stringify(next.hiddenBuiltins)
  );
}

/**
 * Read the club's published list. Never throws, for the same reason the rest of
 * the club path doesn't: it runs on the app-start refresh.
 *
 * @returns {Promise<Object|null>}
 */
export async function readClubPresets(env, clubId) {
  if (!clubId) return null;
  const store = entitlementStore(env);
  if (!store) return null;
  try {
    return (await store.get(clubPresetsKey(clubId), 'json')) ?? null;
  } catch {
    return null;
  }
}

/**
 * PUT /api/club/presets — an admin or editor shares their list with the club.
 *
 * @param {Request} request
 * @param {Object} env
 * @returns {Promise<Response>}
 */
export async function handleClubPresets(request, env) {
  if (request.method !== 'PUT') return methodNotAllowed();

  // Both credentials, and in this order: without a uid there is no role to
  // check, and without a club there is nothing to publish to.
  const session = readSession(request, env);
  if (!session?.uid) return unauthorized();
  const claims = readClub(request, env);
  if (!claims) return unauthorized();

  const store = entitlementStore(env);
  if (!store) return json({ error: 'Club storage is not configured' }, 503);

  // A revoked device stops being able to rewrite every timer's list on the very
  // next request, rather than whenever its cached token happens to expire.
  const clubId = await verifiedClubId(env, claims);
  if (!clubId) return forbidden();

  const club = await readClubRecord(env, clubId);
  if (!club) return json({ error: 'club_not_found' }, 404);

  const access = await resolveAccess(env, { uid: session.uid, clubId, club });
  if (!access.entitled) return json({ error: 'upgrade_required', entitlement: access }, 402);

  if (!canPublish(await readMemberRole(env, clubId, session.uid))) return forbidden();

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const next = normalizePresets(body);
  if (!next) return json({ error: 'invalid_presets' }, 400);

  const stored = await readClubPresets(env, clubId);
  // An identical publish writes nothing. Bumping `ver` for it would make every
  // device in the club discard its list to receive the list it already has.
  if (presetsUnchanged(stored, next)) return json({ ver: club.ver ?? 1, presets: stored });

  const record = {
    ...next,
    // The badge placement rides along with the presets (Phase 3); a presets
    // publish must not silently drop a placement someone already shared.
    badge: stored?.badge ?? null,
    publishedBy: session.uid,
    publishedAt: Date.now(),
  };

  await store.put(clubPresetsKey(clubId), JSON.stringify(record));
  const ver = (club.ver ?? 1) + 1;
  await store.put(clubKey(clubId), JSON.stringify({ ...club, ver }));

  return json({ ver, presets: record });
}
