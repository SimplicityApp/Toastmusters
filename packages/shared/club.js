import { FREE_ENTITLEMENT, setEntitlement, getEntitlement } from './entitlement.js';

/**
 * The club this device joined, as the device remembers it.
 *
 * A club is a second credential, not a second identity. It is earned by typing
 * a code, cached here, and sent in its own `X-Club` header alongside whatever
 * session the device happens to have — or alongside nothing at all, which is
 * the case the feature exists for: whoever is timing on a borrowed laptop at
 * 6:55pm has no Zoom identity and still needs the club's presets.
 *
 * Deliberately NOT a synced key. `toastmaster_role_rules` and friends travel in
 * the profile document (`profileMerge.js`), and putting the club in there would
 * push one device's club onto every other device the buyer owns. The three club
 * keys are device-local, always.
 *
 * The cache is also what keeps the first paint honest. Without it a club device
 * would set `known = true` from the session response and flash "Upgrade" before
 * the club refresh landed — the exact flash the `known` flag exists to prevent.
 * localStorage is synchronous, so reading it before render costs nothing.
 */

export const CLUB_STORAGE_KEY = 'toastmaster_club';
/** Written from Phase 2; listed here so leaving clears everything club-shaped. */
export const CLUB_PRESETS_STORAGE_KEY = 'toastmaster_club_presets';
export const PRESET_SOURCE_STORAGE_KEY = 'toastmaster_preset_source';

const ACTIVATE_ENDPOINT = '/api/club/activate';
const CLUB_ENDPOINT = '/api/club';

/** Once a day. A Tuesday publish reaches every device by the next meeting. */
export const CLUB_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

let cached;
let loaded = false;
const listeners = new Set();

function readStored() {
  try {
    const raw = localStorage.getItem(CLUB_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.clubToken !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStored(value) {
  try {
    if (value) localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(CLUB_STORAGE_KEY);
  } catch {
    // Private mode, or storage disabled. The in-memory copy still carries this
    // page load, which is all the club needs to work in this meeting.
  }
}

function notify() {
  for (const listener of listeners) {
    try {
      listener(cached ?? null);
    } catch {
      // One bad subscriber must not stop the others hearing about it.
    }
  }
}

/**
 * The cached club, or null.
 *
 * @returns {{clubToken: string, ver: number, club: {id: string, name: string|null},
 *   kit: Object|null, badge: Object|null, timezone: string|null,
 *   plan: string, entitled: boolean, status: string|null,
 *   currentPeriodEnd: number|null, lastRefreshAt: number}|null}
 */
export function loadClub() {
  if (!loaded) {
    cached = readStored();
    loaded = true;
  }
  return cached ?? null;
}

/**
 * The header every request carries once a device has joined a club.
 *
 * Spread into a headers object: `{ ...clubHeaders(), Authorization: … }`.
 */
export function clubHeaders() {
  const club = loadClub();
  return club?.clubToken ? { 'X-Club': club.clubToken } : {};
}

/** @param {(club: Object|null) => void} listener @returns {() => void} unsubscribe */
export function subscribeClub(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The entitlement a cached club state implies. */
function clubEntitlementOf(state) {
  if (!state) return FREE_ENTITLEMENT;
  return {
    plan: state.plan ?? 'free',
    status: state.status ?? null,
    entitled: Boolean(state.entitled),
    currentPeriodEnd: typeof state.currentPeriodEnd === 'number' ? state.currentPeriodEnd : null,
    cancelAtPeriodEnd: Boolean(state.cancelAtPeriodEnd),
    source: state.source ?? 'club',
  };
}

/** Fold a `clubState` document from the server into what we keep on the device. */
function toCacheEntry(state, { clubToken, lastRefreshAt }) {
  return {
    clubToken,
    ver: state?.ver ?? 1,
    club: state?.club ?? null,
    kit: state?.kit ?? null,
    presets: state?.presets ?? null,
    badge: state?.badge ?? null,
    timezone: state?.timezone ?? null,
    plan: state?.plan ?? 'free',
    entitled: Boolean(state?.entitled),
    status: state?.status ?? null,
    currentPeriodEnd: typeof state?.currentPeriodEnd === 'number' ? state.currentPeriodEnd : null,
    cancelAtPeriodEnd: Boolean(state?.cancelAtPeriodEnd),
    source: state?.source ?? 'club',
    lastRefreshAt,
  };
}

function store(entry) {
  cached = entry;
  loaded = true;
  writeStored(entry);
  notify();
  return entry;
}

/**
 * Seed the entitlement store from the cache, synchronously, before render.
 *
 * Only ever an upgrade: a cached club that is not entitled says nothing, and
 * the session response is left to answer for a buyer who has their own plan.
 *
 * @returns {Object|null} the cached club, if there was one
 */
export function initClubFromCache() {
  const club = loadClub();
  if (club?.entitled) setEntitlement(clubEntitlementOf(club));
  return club ?? null;
}

/**
 * Apply a plan the server just reported for the club.
 *
 * Guarded so a club answer can never talk down a personal subscription: the
 * only downgrade this is allowed to make is to a plan the club itself granted.
 */
function applyPlan(entitlement) {
  if (entitlement.entitled) {
    setEntitlement(entitlement);
    return;
  }
  const current = getEntitlement();
  if (current.source === 'club' || current.source === 'none') setEntitlement(entitlement);
}

/**
 * Type a code and join the club on this device.
 *
 * Every failure is the same failure on the server, so there is exactly one line
 * of copy to show: "That code isn't active. Check with your club officer."
 *
 * @param {string} code
 * @param {{getToken?: () => string|null, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{ok: true, club: Object}|{ok: false, error: string}>} never rejects
 */
export async function activateClub(code, { getToken, fetchImpl } = {}) {
  if (!code || !String(code).trim()) return { ok: false, error: 'invalid_code' };

  let response;
  try {
    const token = getToken?.();
    response = await (fetchImpl ?? fetch)(ACTIVATE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ code }),
    });
  } catch {
    // Offline, minutes before a meeting. Say so rather than blaming the code.
    return { ok: false, error: 'network' };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok || !body?.clubToken) {
    return { ok: false, error: body?.error || (response.status === 429 ? 'too_many_attempts' : 'invalid_code') };
  }

  const entry = store(toCacheEntry(body, { clubToken: body.clubToken, lastRefreshAt: Date.now() }));
  applyPlan(clubEntitlementOf(entry));
  return { ok: true, club: entry };
}

/**
 * Re-check the club, at most once a day, on app start.
 *
 * Offline is a non-event: a failed refresh leaves the cache in place and the
 * device stays Pro, so a lapse can only land on a *successful* refresh at app
 * start and never mid-meeting.
 *
 * @param {{getToken?: () => string|null, fetchImpl?: typeof fetch, force?: boolean,
 *   now?: number}} [options]
 * @returns {Promise<Object|null>} the club as it now stands, or null if there is none
 */
export async function refreshClub({ getToken, fetchImpl, force = false, now = Date.now() } = {}) {
  const club = loadClub();
  if (!club) return null;

  const age = now - (club.lastRefreshAt ?? 0);
  if (!force && age >= 0 && age < CLUB_REFRESH_INTERVAL_MS) return club;

  let response;
  try {
    const token = getToken?.();
    response = await (fetchImpl ?? fetch)(CLUB_ENDPOINT, {
      headers: {
        'X-Club': club.clubToken,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return club;
  }

  // The device was revoked, or the club is gone. Either way this credential is
  // spent, so stop sending it — but leave the rest of the device alone.
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    leaveClub();
    return null;
  }
  if (!response.ok) return club;

  let body = null;
  try {
    body = await response.json();
  } catch {
    return club;
  }
  if (!body?.club) return club;

  const entry = store(toCacheEntry(body, { clubToken: body.clubToken ?? club.clubToken, lastRefreshAt: now }));
  applyPlan(clubEntitlementOf(entry));
  return entry;
}

/**
 * Leave the club on this device.
 *
 * A deletion, not a restore: the device's own presets and artwork were never
 * written over while the club was active, so there is no backup to lose.
 */
export function leaveClub() {
  const had = Boolean(loadClub());
  cached = null;
  loaded = true;
  writeStored(null);
  for (const key of [CLUB_PRESETS_STORAGE_KEY, PRESET_SOURCE_STORAGE_KEY]) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing to do; the club token is already gone, which is what gates.
    }
  }
  // Only a club-derived plan goes away with the club. A buyer who leaves their
  // own club keeps the subscription they paid for.
  if (getEntitlement().source === 'club') setEntitlement(FREE_ENTITLEMENT);
  notify();
  return had;
}

/** Test seam: drop the in-memory copy so the next read comes from storage. */
export function resetClubForTests() {
  cached = undefined;
  loaded = false;
  listeners.clear();
}
