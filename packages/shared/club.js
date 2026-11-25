import { FREE_ENTITLEMENT, setEntitlement, getEntitlement } from './entitlement.js';
import { areFlagsKnown, getFlags } from './flags.js';
import { DEFAULT_BADGE_PLACEMENT, DEFAULT_PRIMARY_COLOR, normalizeBadgePlacement } from './clubBadge.js';

/**
 * The club this account is in, as this device last heard it.
 *
 * Club Pro belongs to a Zoom account (#167): it is joined with a code by a
 * signed-in account, and from then on it follows that account through its
 * session to every computer it signs in on. Nothing here is a credential.
 * Every club request carries the session — the Bearer in Zoom, the cookie on
 * the web — and the server finds the club from the account.
 *
 * What the device keeps is a copy, tied to the account (`uid`) it was read
 * for, and applied only once identity has resolved: for that same account, or
 * offline while Zoom says the app is authorized. Never for another account,
 * and never for someone signed out or in guest mode (`syncClubWithIdentity`).
 *
 * Deliberately NOT a synced key. `toastmaster_role_rules` and friends travel in
 * the profile document (`profileMerge.js`), and putting the club in there would
 * push one device's copy into the profile. The server is where the club
 * follows the account; these keys are a device-local cache of it.
 */

export const CLUB_STORAGE_KEY = 'toastmaster_club';
/** The club's published list, as the device last received it. */
export const CLUB_PRESETS_STORAGE_KEY = 'toastmaster_club_presets';
/** Which list this device is running: 'club' or 'personal'. */
export const PRESET_SOURCE_STORAGE_KEY = 'toastmaster_preset_source';
/** The club's published card set, as the device last received it: hashes, not pixels. */
export const CLUB_CARDS_STORAGE_KEY = 'toastmaster_club_cards';
/**
 * Which cards this device shows: 'club' or 'own'. Unset means derived, as the
 * preset switch is: a device that never chose its own cards shows the club's.
 */
export const CARD_SOURCE_STORAGE_KEY = 'toastmaster_card_source';
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
const LEAVE_ENDPOINT = '/api/club/leave';

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
/**
 * The account identity last resolved to, so a code typed after that is cached
 * for the right account. Null until `syncClubWithIdentity` has run.
 */
let accountUid = null;

function readStored() {
  try {
    const raw = localStorage.getItem(CLUB_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.club?.id !== 'string') return null;
    // A device-token entry saved before #167: no account to tie it to, so it
    // is dropped and the account's own club arrives on the next refresh.
    if (typeof parsed.clubToken === 'string') return null;
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

// Parsed once and kept: the card resolver reads this on every status change,
// which sits inside the 25 ms card-switch budget.
let cardsCache;
let cardsLoaded = false;

function normalizeClubCards(raw) {
  if (!raw || typeof raw !== 'object' || !raw.images || typeof raw.images !== 'object') return null;
  const images = {};
  for (const [color, hash] of Object.entries(raw.images)) {
    if (typeof hash === 'string' && hash) images[color] = hash;
  }
  if (!Object.keys(images).length) return null;
  return {
    label: typeof raw.label === 'string' && raw.label ? raw.label : null,
    images,
    publishedBy: raw.publishedBy ?? null,
    publishedAt: typeof raw.publishedAt === 'number' ? raw.publishedAt : null,
  };
}

/**
 * The club's published card set, as this device last received it, or null.
 *
 * @returns {{label: string|null, images: Object<string, string>, publishedBy: string|null,
 *   publishedAt: number|null}|null}
 */
export function loadClubCards() {
  if (!cardsLoaded) {
    try {
      const raw = localStorage.getItem(CLUB_CARDS_STORAGE_KEY);
      cardsCache = raw ? normalizeClubCards(JSON.parse(raw)) : null;
    } catch {
      cardsCache = null;
    }
    cardsLoaded = true;
  }
  return cardsCache ?? null;
}

/** @param {Object|null} cards - null removes the key */
export function saveClubCards(cards) {
  const normalized = normalizeClubCards(cards);
  cardsCache = normalized;
  cardsLoaded = true;
  try {
    if (normalized) localStorage.setItem(CLUB_CARDS_STORAGE_KEY, JSON.stringify(normalized));
    else localStorage.removeItem(CLUB_CARDS_STORAGE_KEY);
  } catch {
    // Private mode. The in-memory copy carries this page load.
  }
}

/** The stored card switch, or null when it has never been set explicitly. */
export function readCardSource() {
  try {
    const value = localStorage.getItem(CARD_SOURCE_STORAGE_KEY);
    return value === 'club' || value === 'own' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Move the card switch. Explicit only, like the preset switch.
 *
 * @param {'club'|'own'|null} source - null clears it back to derived
 */
export function writeCardSource(source) {
  try {
    if (source === 'club' || source === 'own') localStorage.setItem(CARD_SOURCE_STORAGE_KEY, source);
    else localStorage.removeItem(CARD_SOURCE_STORAGE_KEY);
  } catch {
    // The derived default still answers for this page load.
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

/** Whether Pro is released: the `pro` flag has arrived and is on. */
function proReleased() {
  return areFlagsKnown() && getFlags().pro === true;
}

/**
 * Whether this device's club features are on: its club is active (the server
 * says entitled) and Pro is released (the `pro` flag is known and on).
 *
 * Every club surface reads this one gate: the badge on the card and the video,
 * the club's card set, its shared timings, the meeting archive and sharing, the
 * club's branding on reports, and the renewal reminder. While `pro` is off a
 * club device behaves as a lapsed one does: nothing is deleted, the device stays
 * in its club, and everything is back the moment `pro` is on. Until the flags
 * arrive it answers false, so nothing appears and then vanishes at load.
 *
 * @param {Object|null} [club] the cached club; read fresh when omitted
 */
export function clubFeaturesOn(club = loadClub()) {
  return Boolean(club?.entitled) && proReleased();
}

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
 * In grace, `reason` says which: 'payment_failed' (still set to renew, but the
 * last charge did not go through) or 'not_renewing' (cancelled, or set not to
 * renew, so it ends when the paid period does).
 *
 * @param {number} [now]
 * @returns {{state: 'active'|'grace'|'lapsed', clubId: string|null,
 *   clubName: string|null, endsAt: number|null, daysLeft: number|null,
 *   isAdmin: boolean, reason?: 'payment_failed'|'not_renewing'}|null} null when
 *   this device has never joined a club
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
    reason: failing ? 'payment_failed' : 'not_renewing',
    endsAt,
    daysLeft: endsAt === null ? null : Math.max(0, Math.ceil((endsAt - now) / DAY_MS)),
  };
}

/** The club whose Pro has ended, for the copy that has to name it. */
export function lapsedClubName() {
  const club = loadClub();
  // Nothing to say about a club's Pro ending while Pro itself is not released.
  if (!club || club.entitled || !proReleased()) return null;
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
 * How close to its end a club that will not renew starts being reminded. A
 * yearly plan set not to renew is in "grace" for most of the year; a reminder
 * that early would be noise, and there is nothing urgent to do yet.
 */
export const GRACE_REMINDER_WINDOW_DAYS = 60;

/**
 * The renewal reminder this device should be showing, or null.
 *
 * A club that will not renew is reminded only in its last
 * GRACE_REMINDER_WINDOW_DAYS days, and only when its end date is known. A failed
 * payment is reminded at once: Pro ends a week after it, and the fix (a new
 * card) is quick.
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
  if (!clubFeaturesOn()) return null;
  const life = clubLifecycle(now);
  if (!life || life.state !== CLUB_GRACE) return null;
  if (life.reason === 'not_renewing') {
    if (life.endsAt === null) return null;
    if (life.endsAt - now >= GRACE_REMINDER_WINDOW_DAYS * DAY_MS) return null;
  }
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
  if (!clubFeaturesOn(club)) return null;
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

  const pending = Promise.resolve()
    .then(() => load(url))
    .then((image) => {
      if (logoImageUrl !== url) return logoImage;
      logoImage = image;
      notify();
      return image;
    })
    .catch(() => null)
    .finally(() => {
      // Only if nothing newer has started: a load for a logo that has since
      // changed must not clear the flag of the load that replaced it.
      if (logoPending === pending) logoPending = null;
    });

  logoPending = pending;
  return pending;
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
 * @returns {{uid: string|null, ver: number, club: {id: string, name: string|null},
 *   kit: Object|null, badge: Object|null, timezone: string|null,
 *   role: string|null, isOwner: boolean, code: string|null,
 *   placesUsed: number|null, placesTotal: number|null,
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
function toCacheEntry(state, { uid, lastRefreshAt }) {
  return {
    // Whose club this is. A different account on this device never gets it.
    uid: uid ?? null,
    ver: state?.ver ?? 1,
    club: state?.club ?? null,
    kit: state?.kit ?? null,
    badge: state?.badge ?? null,
    timezone: state?.timezone ?? null,
    // Recomputed by the server on every request, never versioned: a promotion
    // takes effect on the next refresh with nothing republished.
    role: state?.role ?? null,
    // The owner pays for the club and can't leave it, so no surface offers to.
    isOwner: state?.isOwner === true,
    // Null for everyone but an admin — the server decides, not the client. A
    // demoted officer loses them on their next refresh.
    code: state?.code ?? null,
    shareUrl: state?.shareUrl ?? null,
    placesUsed: typeof state?.placesUsed === 'number' ? state.placesUsed : null,
    placesTotal: typeof state?.placesTotal === 'number' ? state.placesTotal : null,
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
 * Read the cached club into memory, without applying it.
 *
 * It used to set club Pro before the first paint. It no longer does (#167,
 * Q4): the copy belongs to an account, and which account is signed in is only
 * known once identity resolves, so `syncClubWithIdentity` decides then.
 *
 * @returns {Object|null} the cached club, if there was one
 */
export function initClubFromCache() {
  return loadClub();
}

/**
 * Forget the club on this device without telling the server: the server
 * refused it (removed, blocked, lapsed out of existence), or it belongs to an
 * account that is not the one signed in now.
 *
 * A deletion, not a restore: the device's own presets and artwork were never
 * written over while the club was active, so there is no backup to lose.
 *
 * @returns {boolean} whether there was a club to forget
 */
export function forgetClub() {
  const had = Boolean(loadClub());
  cached = null;
  loaded = true;
  writeStored(null);
  saveClubPresets(null);
  writePresetSource(null);
  // The card set and its switch go too. The device's own sets were never
  // touched, so its own choice is simply what shows again.
  saveClubCards(null);
  writeCardSource(null);
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
 * Bring the club in line with who this is, once identity has resolved.
 *
 * The one place the cached copy is applied, and the one place it is thrown
 * away for belonging to someone else:
 *
 *   identified, same account or no copy, session says a club     refresh; the answer replaces the copy
 *   identified, session says no club                             forget the copy (a refusal)
 *   identified as another account                                forget the copy first
 *   session unreachable, Zoom says the app is authorized         keep the copy and apply its plan
 *   signed out, guest mode, or anyone else we can't name         never apply it: forget it
 *
 * Runs after the session call, never before it: no club request goes out
 * before the server can say which account is asking.
 *
 * @param {{identified: boolean, uid: string|null, authStatus: string|null,
 *   reachable: boolean, entitlement: Object|null, getToken?: () => string|null,
 *   fetchImpl?: typeof fetch}} identity
 * @returns {Promise<Object|null>} the club as it now stands
 */
export async function syncClubWithIdentity({
  identified,
  uid,
  authStatus,
  reachable,
  entitlement,
  getToken,
  fetchImpl,
} = {}) {
  const club = loadClub();

  if (!reachable && authStatus === 'authorized') {
    // Offline, and Zoom still says this is the account that approved the app.
    // It can't say *which* account, so this is the one case the copy is
    // trusted on the device's word (Q3). Only ever an upgrade: a lapsed copy
    // says nothing, so a buyer with their own plan is not told they are free
    // by a club while the session that knows better is out of reach.
    if (club?.entitled) {
      setEntitlement(clubEntitlementOf(club));
      warmLogoQuietly();
    }
    return club;
  }

  if (!identified || !uid) {
    // Signed out, guest mode, or a session that named nobody: this device has
    // no account to hold a club for.
    if (club) forgetClub();
    return null;
  }

  accountUid = uid;
  if (club && club.uid !== uid) forgetClub();
  // Same account, another club: it left this one and joined that one
  // somewhere else. Nothing of the old club's (its list, its cards, the badge
  // placement) may ride along under the new club's name.
  const sessionClubId = entitlement?.club?.id ?? null;
  const copy = loadClub();
  if (copy && sessionClubId && copy.club?.id !== sessionClubId) forgetClub();
  if (!entitlement?.club) {
    if (loadClub()) forgetClub();
    return null;
  }
  return refreshClub({ getToken, fetchImpl, uid });
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
 * Type a code and join the club with this account.
 *
 * The server's reason comes back as it is, with what each one needs said:
 * `full` (with `placesUsed`/`placesTotal`), `already_in_club` (with the other
 * club's `clubName`), `sign_in_required`, and `invalid_code`, which is every
 * other refusal on purpose — a wrong code, a lapsed club and a blocked account
 * look the same — so there is one line of copy for it: "That code isn't
 * active. Check with your club officer."
 *
 * @param {string} code
 * @param {{getToken?: () => string|null, fetchImpl?: typeof fetch, uid?: string|null}} [options]
 *   `uid` is the account joining; defaults to the one identity last resolved to
 * @returns {Promise<{ok: true, club: Object, placesUsed: number|null}|{ok: false,
 *   error: string, clubName?: string, placesUsed?: number, placesTotal?: number}>}
 *   never rejects
 */
export async function activateClub(code, { getToken, fetchImpl, uid = accountUid } = {}) {
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

  if (!response.ok || !body?.club) {
    // A 5xx is never the code's fault, whatever the body says (`try_again`
    // when the place counter can't be reached): the person sees the network
    // message, not "That code isn't active".
    if (response.status >= 500) return { ok: false, error: 'network' };
    const fallback =
      response.status === 429 ? 'too_many_attempts'
        : response.status === 401 ? 'sign_in_required'
          : 'invalid_code';
    return {
      ok: false,
      error: body?.error || fallback,
      ...(typeof body?.clubName === 'string' ? { clubName: body.clubName } : {}),
      ...(typeof body?.placesUsed === 'number' ? { placesUsed: body.placesUsed } : {}),
      ...(typeof body?.placesTotal === 'number' ? { placesTotal: body.placesTotal } : {}),
    };
  }

  // Activation is the one moment a device has no club list at all, so the
  // published one is taken unconditionally. Whether it is the list that shows
  // is a separate question, answered by the switch in clubPresets.js. The card
  // set lands the same way, behind its own switch in cardImages.js.
  saveClubPresets(body.presets ?? null);
  saveClubCards(body.cards ?? null);
  const entry = store(toCacheEntry(body, { uid, lastRefreshAt: Date.now() }));
  applyPlan(clubEntitlementOf(entry));
  warmLogoQuietly();
  return { ok: true, club: entry, placesUsed: typeof body.placesUsed === 'number' ? body.placesUsed : null };
}

/**
 * Mint the club this subscription pays for, and land on it with this account.
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
export async function createClub(details = {}, { getToken, fetchImpl, uid = accountUid } = {}) {
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

  if (!response.ok || !body?.club) {
    return { ok: false, error: body?.error || 'create_failed' };
  }

  // Same landing as activation: the creator's account is in the club before
  // this resolves, so nobody is ever shown a code and asked to type it back in.
  saveClubPresets(body.presets ?? null);
  saveClubCards(body.cards ?? null);
  const entry = store(toCacheEntry(body, { uid, lastRefreshAt: Date.now() }));
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
 * Ask the server for this account's club, on every app open.
 *
 * One GET per open, and only for an account the session says is in a club
 * (`syncClubWithIdentity` decides). The answer replaces the copy. A refusal —
 * 401, 403 or 404 — forgets the club on this device and tells the server
 * nothing: there is nothing to tell it. Offline is a non-event: a failed
 * refresh leaves the copy in place, so a lapse can only land on a *successful*
 * refresh at app start and never mid-meeting.
 *
 * @param {{getToken?: () => string|null, fetchImpl?: typeof fetch, uid?: string|null,
 *   now?: number}} [options] - `uid` is whose club this is; defaults to the
 *   copy's own
 * @returns {Promise<Object|null>} the club as it now stands, or null if there is none
 */
export async function refreshClub({ getToken, fetchImpl, uid, now = Date.now() } = {}) {
  let club = loadClub();

  let response;
  try {
    const token = getToken?.();
    response = await (fetchImpl ?? fetch)(CLUB_ENDPOINT, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return club;
  }

  // Removed, blocked, or no club for this account: the copy is wrong now.
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    forgetClub();
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

  // Another club than the copy's: the account moved clubs on another
  // computer. `ver` starts at 1 in every club, so comparing it alone would
  // keep the old club's list and cards under the new club's name.
  const copyUid = club?.uid;
  if (club && club.club?.id !== body.club.id) {
    forgetClub();
    club = null;
  }

  // Content moves only when `ver` moves. A plain refresh therefore leaves a
  // device's list exactly as it was, and only an actual publish replaces it —
  // and even then the switch is not touched, so a device sitting on its own
  // presets stays there with a newer club list waiting behind the toggle. A
  // device with no copy (a new computer for this account) takes the list.
  const verMoved = !club || (body.ver ?? 1) !== (club.ver ?? 1);
  if (verMoved) saveClubPresets(body.presets ?? null);
  // The card set rides the same version. It is also taken when this device has
  // none at all, so a device that last refreshed on a bundle that did not know
  // about card sets still receives the one already published.
  if (verMoved || (!loadClubCards() && body.cards)) saveClubCards(body.cards ?? null);

  const entry = store(toCacheEntry(body, { uid: uid ?? copyUid ?? accountUid, lastRefreshAt: now }));
  applyPlan(clubEntitlementOf(entry));
  // The kit is club-wide and carries no device override, so it simply lands;
  // the badge *default* lands too, while whatever this device moved sits in its
  // own key and survives.
  warmLogoQuietly();
  return entry;
}

/**
 * Leave the club with this account, everywhere it is signed in.
 *
 * The server decides: the copy here is cleared only after a 2xx, so an owner
 * (`owner`), the last admin of a club with no known owner (`last_admin`) or a
 * dropped connection all leave the club exactly as it was, and the caller
 * says why.
 *
 * @param {{getToken?: () => string|null, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{ok: true}|{ok: false, error: string}>} never rejects
 */
export async function leaveClub({ getToken, fetchImpl } = {}) {
  let response;
  try {
    const token = getToken?.();
    response = await (fetchImpl ?? fetch)(LEAVE_ENDPOINT, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return { ok: false, error: 'network' };
  }

  if (!response?.ok) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: false, error: response.status >= 500 ? 'network' : body?.error || 'leave_failed' };
  }

  forgetClub();
  return { ok: true };
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

/**
 * Take the answer to a card-set publish or removal, for the same reason
 * `rememberPublishedPresets` exists: the publisher's own device must not read
 * its next refresh as news.
 *
 * @param {number} ver
 * @param {Object|null} cards
 * @returns {Object|null} the club as it now stands
 */
export function rememberPublishedCards(ver, cards) {
  const club = loadClub();
  if (!club) return null;
  saveClubCards(cards ?? null);
  return store({ ...club, ver: typeof ver === 'number' ? ver : club.ver });
}

/** Test seam: drop the in-memory copy so the next read comes from storage. */
export function resetClubForTests() {
  cached = undefined;
  loaded = false;
  accountUid = null;
  cardsCache = undefined;
  cardsLoaded = false;
  listeners.clear();
  logoImage = null;
  logoImageUrl = null;
  logoPending = null;
}
