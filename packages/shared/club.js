import { FREE_ENTITLEMENT, setEntitlement, getEntitlement } from './entitlement.js';
import { DEFAULT_BADGE_PLACEMENT, DEFAULT_PRIMARY_COLOR, normalizeBadgePlacement } from './clubBadge.js';

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
/** The club's published list, as the device last received it. */
export const CLUB_PRESETS_STORAGE_KEY = 'toastmaster_club_presets';
/** Which list this device is running: 'club' or 'personal'. */
export const PRESET_SOURCE_STORAGE_KEY = 'toastmaster_preset_source';
/**
 * Where this device puts the club's badge, when it has moved it.
 *
 * Device-local and NOT synced, deliberately: the club's placement is the club's
 * default and arrives on `clubState.badge`, while the move a timer makes is
 * about their own tile — where their face is, what their camera frames — which
 * is exactly the kind of thing that must not follow them to another machine.
 * Only the fields this device actually changed are stored, so a club that
 * re-publishes its default still reaches every field nobody touched.
 */
export const CLUB_BADGE_STORAGE_KEY = 'toastmaster_club_badge';
/**
 * The day this device last dismissed the renewal reminder.
 *
 * A date rather than a flag, because the reminder is supposed to come back: a
 * club in grace has a handful of days to act, and the person who can act is
 * rarely the person timing. Dismissing it buys quiet for the rest of the
 * meeting, not for the rest of the grace window.
 */
export const CLUB_GRACE_DISMISSED_STORAGE_KEY = 'toastmaster_club_grace_dismissed';

const ACTIVATE_ENDPOINT = '/api/club/activate';
const CLUB_ENDPOINT = '/api/club';
const CREATE_ENDPOINT = '/api/club/create';

/** Once a day. A Tuesday publish reaches every device by the next meeting. */
export const CLUB_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The server's own grace window, mirrored here so the countdown the device
 * shows and the moment the Worker stops entitling are the same date.
 *
 * Kept in step with `PAST_DUE_GRACE_MS` in `worker/entitlements.js`. It is
 * duplicated rather than fetched because the banner has to be right on the
 * first paint, before any network call; the server stays the authority, and a
 * device that is a day out simply shows a countdown a day off on a state the
 * next refresh corrects.
 */
export const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

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

/**
 * The club's published list, as this device last received it.
 *
 * Read and written here rather than through storage.js on purpose: every setter
 * in storage.js announces its write to the sync layer, and the club's keys must
 * never reach the profile document. `toastmaster_role_rules` is a SYNCED_KEY,
 * so a club list that found its way into it would be pushed into the buyer's
 * *personal* profile and from there onto every other device they own.
 *
 * @returns {{rules: Object, order: string[], hiddenBuiltins: string[],
 *   publishedBy: string|null, publishedAt: number|null}|null}
 */
export function loadClubPresets() {
  try {
    const raw = localStorage.getItem(CLUB_PRESETS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.rules || typeof parsed.rules !== 'object') return null;
    return {
      rules: parsed.rules,
      order: Array.isArray(parsed.order) ? parsed.order : [],
      hiddenBuiltins: Array.isArray(parsed.hiddenBuiltins) ? parsed.hiddenBuiltins : [],
      publishedBy: parsed.publishedBy ?? null,
      publishedAt: typeof parsed.publishedAt === 'number' ? parsed.publishedAt : null,
    };
  } catch {
    return null;
  }
}

/** @param {Object|null} presets - null removes the key */
export function saveClubPresets(presets) {
  try {
    if (presets?.rules) localStorage.setItem(CLUB_PRESETS_STORAGE_KEY, JSON.stringify(presets));
    else localStorage.removeItem(CLUB_PRESETS_STORAGE_KEY);
  } catch {
    // Private mode. The club still works this page load; it just re-fetches.
  }
}

/** The stored switch position, or null when it has never been set explicitly. */
export function readPresetSource() {
  try {
    const value = localStorage.getItem(PRESET_SOURCE_STORAGE_KEY);
    return value === 'club' || value === 'personal' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Move the switch. Always explicit: the switch must only ever move because
 * something moved it, never because a derived default quietly changed.
 *
 * @param {'club'|'personal'|null} source - null clears it back to derived
 */
export function writePresetSource(source) {
  try {
    if (source === 'club' || source === 'personal') localStorage.setItem(PRESET_SOURCE_STORAGE_KEY, source);
    else localStorage.removeItem(PRESET_SOURCE_STORAGE_KEY);
  } catch {
    // Same as above: the derived default still answers for this page load.
  }
}

/**
 * This device's overrides to the club's badge placement, or null.
 *
 * Sparse on purpose — only the fields the timer actually moved. A club that
 * later republishes its default still reaches every field nobody touched.
 *
 * @returns {{x?: number, y?: number, scale?: number, visible?: boolean}|null}
 */
export function loadClubBadgeOverride() {
  try {
    const raw = localStorage.getItem(CLUB_BADGE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const out = {};
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      out.x = Math.min(1, Math.max(0, x));
      out.y = Math.min(1, Math.max(0, y));
    }
    const scale = Number(parsed.scale);
    if (Number.isFinite(scale) && scale > 0) out.scale = scale;
    if (typeof parsed.visible === 'boolean') out.visible = parsed.visible;
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/**
 * Move, resize or hide the badge on this device.
 *
 * Written straight to localStorage rather than through storage.js: every setter
 * there announces its write to the sync layer, and this key must never reach
 * the profile document.
 *
 * @param {{x?: number, y?: number, scale?: number, visible?: boolean}} patch
 * @returns {{x: number, y: number, scale: number, visible: boolean}} the
 *   placement now in effect
 */
export function saveClubBadgeOverride(patch) {
  const next = { ...(loadClubBadgeOverride() ?? {}), ...(patch ?? {}) };
  try {
    localStorage.setItem(CLUB_BADGE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode. The badge still draws from the club default this load.
  }
  return clubBadgePlacement();
}

/** Drop this device's move and go back to the club's placement. */
export function clearClubBadgeOverride() {
  try {
    localStorage.removeItem(CLUB_BADGE_STORAGE_KEY);
  } catch {
    // Same as above.
  }
  return clubBadgePlacement();
}

/** Whether this device has moved the badge away from the club's placement. */
export function hasClubBadgeOverride() {
  return Boolean(loadClubBadgeOverride());
}

/** The club's own placement, as last published. */
export function clubBadgeDefault() {
  return normalizeBadgePlacement(loadClub()?.badge, DEFAULT_BADGE_PLACEMENT);
}

/**
 * Where the badge goes on this device: the club's placement, with whatever this
 * device moved layered on top.
 *
 * @returns {{x: number, y: number, scale: number, visible: boolean}}
 */
export function clubBadgePlacement() {
  return normalizeBadgePlacement(loadClubBadgeOverride(), clubBadgeDefault());
}

// ---------------------------------------------------------------------------
// Grace and lapse: the three stages the device follows the server through
// ---------------------------------------------------------------------------

export const CLUB_ACTIVE = 'active';
export const CLUB_GRACE = 'grace';
export const CLUB_LAPSED = 'lapsed';

/**
 * Where the club stands: active, inside its grace window, or lapsed.
 *
 * Derived from the plan fields the server recomputes on every refresh rather
 * than from anything stored, which is what makes a lapse land on the next app
 * start with nothing written and nothing to reconcile. The two grace shapes
 * come straight from `subscriptionGrantsAccess`: a failed payment keeps Pro for
 * seven days past the period end, a scheduled cancellation keeps it until the
 * paid period runs out.
 *
 * @param {number} [now]
 * @returns {{state: 'active'|'grace'|'lapsed', clubId: string|null,
 *   clubName: string|null, endsAt: number|null, daysLeft: number|null,
 *   isAdmin: boolean}|null} null when this device has never joined a club
 */
export function clubLifecycle(now = Date.now()) {
  const club = loadClub();
  if (!club) return null;

  const base = {
    clubId: club.club?.id ?? null,
    clubName: club.club?.name || null,
    endsAt: null,
    daysLeft: null,
    // Only an admin can do anything about it, so only an admin is offered the
    // billing action. Everyone else is told who to ask.
    isAdmin: club.role === 'admin',
  };

  if (!club.entitled) return { ...base, state: CLUB_LAPSED };

  const failing = club.status === 'past_due';
  const ending = club.status === 'canceled' || club.cancelAtPeriodEnd;
  if (!failing && !ending) return { ...base, state: CLUB_ACTIVE };

  const periodEnd = typeof club.currentPeriodEnd === 'number' ? club.currentPeriodEnd : null;
  // A past_due club with no period end is entitled indefinitely server-side, so
  // there is a warning to give but no date to give with it.
  const endsAt = failing ? (periodEnd === null ? null : periodEnd + PAST_DUE_GRACE_MS) : periodEnd;

  return {
    ...base,
    state: CLUB_GRACE,
    endsAt,
    daysLeft: endsAt === null ? null : Math.max(0, Math.ceil((endsAt - now) / DAY_MS)),
  };
}

/** The club whose Pro has ended, for the copy that has to name it. */
export function lapsedClubName() {
  const club = loadClub();
  if (!club || club.entitled) return null;
  return club.club?.name || 'Your club';
}

/** The device's own calendar day, which is the unit the reminder returns on. */
function localDay(now) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Whether the renewal reminder has already been dismissed today. */
export function graceReminderDismissedToday(now = Date.now()) {
  try {
    return localStorage.getItem(CLUB_GRACE_DISMISSED_STORAGE_KEY) === localDay(now);
  } catch {
    return false;
  }
}

/**
 * Quiet for the rest of today. Tomorrow it comes back, because the club still
 * has not been renewed and the person who can renew it may not be here yet.
 */
export function dismissGraceReminder(now = Date.now()) {
  try {
    localStorage.setItem(CLUB_GRACE_DISMISSED_STORAGE_KEY, localDay(now));
  } catch {
    // Private mode. The reminder simply stays up for this page load.
  }
}

/**
 * The renewal reminder this device should be showing, or null.
 *
 * Grace only, deliberately. A lapsed club has nothing left to warn about — the
 * warning already ran for a week — and a banner that returned every day to a
 * club nobody intends to renew would be nagging rather than reminding. The
 * lapse explains itself where someone goes looking for it: the Footer reads
 * "Upgrade", the upgrade modal names the club, and the rules editor says why
 * the club's presets are gone.
 *
 * @param {number} [now]
 */
export function clubGraceReminder(now = Date.now()) {
  const life = clubLifecycle(now);
  if (!life || life.state !== CLUB_GRACE) return null;
  return graceReminderDismissedToday(now) ? null : life;
}

/**
 * The club's brand kit, or null when there is nothing to render.
 *
 * A lapsed club answers null, which is what makes the lapse behaviour fall out
 * for free: the badge and the report header simply stop being drawn, with
 * nothing deleted and nothing to restore on renewal.
 *
 * @returns {{name: string, logoUrl: string|null, primaryColor: string,
 *   showOnCards: boolean, showOnReports: boolean}|null}
 */
export function clubKit() {
  const club = loadClub();
  if (!club?.entitled) return null;
  const kit = club.kit;
  if (!kit || typeof kit !== 'object') return null;
  const name = String(kit.name ?? club.club?.name ?? '').trim();
  if (!name) return null;
  return {
    name,
    logoUrl: typeof kit.logoUrl === 'string' && kit.logoUrl ? kit.logoUrl : null,
    primaryColor: typeof kit.primaryColor === 'string' && kit.primaryColor ? kit.primaryColor : DEFAULT_PRIMARY_COLOR,
    showOnCards: kit.showOnCards !== false,
    showOnReports: kit.showOnReports !== false,
  };
}

// The decoded logo, and the URL it came from. Module-level because the badge is
// composited once per pushed frame and decoding there would put an image decode
// inside the 25 ms warm budget that card switching is held to.
let logoImage = null;
let logoImageUrl = null;
let logoPending = null;

/** The decoded club logo, or null when there is none or it has not landed yet. */
export function getClubLogoImage() {
  return logoImage;
}

/**
 * Decode the club's logo once, so the compositor never waits on the network.
 *
 * Never rejects: a logo that will not load leaves a name-only badge, which is
 * the same badge a club without a logo gets. Called from app start, alongside
 * the card pre-decode that already warms the timing cards.
 *
 * @param {{loadImage?: (url: string) => Promise<CanvasImageSource>}} [options]
 * @returns {Promise<CanvasImageSource|null>}
 */
export function warmClubLogo({ loadImage } = {}) {
  const url = clubKit()?.logoUrl ?? null;
  if (!url) {
    logoImage = null;
    logoImageUrl = null;
    logoPending = null;
    return Promise.resolve(null);
  }
  if (logoImageUrl === url && (logoImage || logoPending)) return logoPending ?? Promise.resolve(logoImage);

  logoImageUrl = url;
  logoImage = null;
  const load =
    loadImage ??
    ((src) =>
      new Promise((resolve, reject) => {
        if (typeof Image === 'undefined') {
          reject(new Error('No Image constructor'));
          return;
        }
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`Could not load ${src}`));
        // Same-origin, so the canvas it is drawn onto stays untainted and
        // getImageData still works on the composited frame.
        image.src = src;
      }));

  logoPending = Promise.resolve()
    .then(() => load(url))
    .then((image) => {
      if (logoImageUrl !== url) return logoImage;
      logoImage = image;
      notify();
      return image;
    })
    .catch(() => null)
    .finally(() => {
      logoPending = null;
    });

  return logoPending;
}

/**
 * Everything the badge renderer needs, or null when nothing should be drawn.
 *
 * One flat answer rather than two lookups, because the camera-mode dirty-check
 * compares this whole object to decide whether a bridge push is redundant.
 *
 * @returns {{kit: Object, placement: Object}|null}
 */
export function clubBadgeState() {
  const kit = clubKit();
  if (!kit || !kit.showOnCards) return null;
  const placement = clubBadgePlacement();
  if (!placement.visible) return null;
  return {
    kit: { ...kit, logo: logoImageUrl === kit.logoUrl ? logoImage : null },
    placement,
  };
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

/**
 * Fold a `clubState` document from the server into what we keep on the device.
 *
 * The published list is deliberately absent: it lives in its own key so that
 * `resolveActiveRules()` can read it without parsing the whole club, and so
 * that applying it stays a separate, version-gated decision.
 */
function toCacheEntry(state, { clubToken, lastRefreshAt }) {
  return {
    clubToken,
    ver: state?.ver ?? 1,
    club: state?.club ?? null,
    kit: state?.kit ?? null,
    badge: state?.badge ?? null,
    timezone: state?.timezone ?? null,
    // Recomputed by the server on every request, never versioned: a promotion
    // takes effect on the next refresh with nothing republished.
    role: state?.role ?? null,
    // Null for everyone but an admin — the server decides, not the client. A
    // demoted officer loses both on their next refresh.
    code: state?.code ?? null,
    shareUrl: state?.shareUrl ?? null,
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

/** Decode the club's logo, if there is one, without making anyone wait. */
function warmLogoQuietly() {
  try {
    warmClubLogo();
  } catch {
    // A name-only badge is the fallback, and it is a perfectly good badge.
  }
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

  // Activation is the one moment a device has no club list at all, so the
  // published one is taken unconditionally. Whether it is the list that shows
  // is a separate question, answered by the switch in clubPresets.js.
  saveClubPresets(body.presets ?? null);
  const entry = store(toCacheEntry(body, { clubToken: body.clubToken, lastRefreshAt: Date.now() }));
  applyPlan(clubEntitlementOf(entry));
  warmLogoQuietly();
  return { ok: true, club: entry };
}

/**
 * Mint the club this subscription pays for, and join it on this device.
 *
 * The other half of `activateClub`: that one is for a timer who was given a
 * code, this one is for the person who paid and has none. A subscriber used to
 * have no way to reach any club feature unless they had both named a club at
 * checkout and waited for an operator to run the CLI.
 *
 * Idempotent on the server, so pressing the button twice returns the same club
 * rather than minting a second — `created` says which happened.
 *
 * @param {{clubName?: string, timezone?: string}} [details]
 * @param {{getToken?: () => string|null, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{ok: true, club: Object, code: string, shareUrl: string|null,
 *   created: boolean}|{ok: false, error: string}>} never rejects
 */
export async function createClub(details = {}, { getToken, fetchImpl } = {}) {
  const timezone = details.timezone ?? guessTimezone();

  let response;
  try {
    const token = getToken?.();
    response = await (fetchImpl ?? fetch)(CREATE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({
        ...(details.clubName?.trim() ? { clubName: details.clubName.trim() } : {}),
        ...(timezone ? { timezone } : {}),
      }),
    });
  } catch {
    return { ok: false, error: 'network' };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok || !body?.clubToken) {
    return { ok: false, error: body?.error || 'create_failed' };
  }

  // Same landing as activation: the creator's device is on the club before this
  // resolves, so nobody is ever shown a code and asked to type it back in.
  saveClubPresets(body.presets ?? null);
  const entry = store(toCacheEntry(body, { clubToken: body.clubToken, lastRefreshAt: Date.now() }));
  applyPlan(clubEntitlementOf(entry));
  warmLogoQuietly();

  return {
    ok: true,
    club: entry,
    code: body.code ?? null,
    shareUrl: body.shareUrl ?? null,
    created: Boolean(body.created),
  };
}

/** The device's own zone, when the platform will say. Never fatal. */
function guessTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
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

  // Content moves only when `ver` moves. A plain daily refresh therefore leaves
  // a device's list exactly as it was, and only an actual publish replaces it —
  // and even then the switch is not touched, so a device sitting on its own
  // presets stays there with a newer club list waiting behind the toggle.
  if ((body.ver ?? 1) !== (club.ver ?? 1)) saveClubPresets(body.presets ?? null);

  const entry = store(toCacheEntry(body, { clubToken: body.clubToken ?? club.clubToken, lastRefreshAt: now }));
  applyPlan(clubEntitlementOf(entry));
  // The kit is club-wide and carries no device override, so it simply lands;
  // the badge *default* lands too, while whatever this device moved sits in its
  // own key and survives.
  warmLogoQuietly();
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
  // A deletion, never a restore: the personal keys were not written over while
  // the club was active, so there is nothing to put back.
  saveClubPresets(null);
  writePresetSource(null);
  // The badge placement goes with the club: it is a position on the club's
  // badge, and there is no badge to place once the club is gone.
  clearClubBadgeOverride();
  try {
    // So a device that rejoins a club in grace is reminded on day one rather
    // than inheriting a dismissal from the club it left.
    localStorage.removeItem(CLUB_GRACE_DISMISSED_STORAGE_KEY);
  } catch {
    // Private mode; there was nothing stored to clear.
  }
  logoImage = null;
  logoImageUrl = null;
  // Only a club-derived plan goes away with the club. A buyer who leaves their
  // own club keeps the subscription they paid for.
  if (getEntitlement().source === 'club') setEntitlement(FREE_ENTITLEMENT);
  notify();
  return had;
}

/**
 * Take the answer to a publish: the club's list is now this, at this version.
 *
 * Recording the new `ver` here is what stops the next daily refresh treating
 * the publisher's own device as out of date and replacing the list it just
 * shared — with the same content, but through the path that exists to overwrite.
 *
 * @param {number} ver
 * @param {Object} presets
 * @returns {Object|null} the club as it now stands
 */
export function rememberPublishedPresets(ver, presets) {
  const club = loadClub();
  if (!club) return null;
  saveClubPresets(presets ?? null);
  return store({ ...club, ver: typeof ver === 'number' ? ver : club.ver });
}

/** Test seam: drop the in-memory copy so the next read comes from storage. */
export function resetClubForTests() {
  cached = undefined;
  loaded = false;
  listeners.clear();
  logoImage = null;
  logoImageUrl = null;
  logoPending = null;
}
