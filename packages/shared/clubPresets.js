import { DEFAULT_ROLE_RULES } from './timingRules.js';
import {
  loadRoleRules,
  saveRoleRules,
  loadRoleOrder,
  saveRoleOrder,
  loadHiddenBuiltinRoles,
  saveHiddenBuiltinRoles,
} from './storage.js';
import {
  loadClub,
  loadClubPresets,
  readPresetSource,
  writePresetSource,
  rememberPublishedPresets,
  clubHeaders,
} from './club.js';

/**
 * Which timing list is live on this device: the club's, or the timer's own.
 *
 * A club device is on one list or the other, never a blend. Per-role layering
 * was rejected because it produces a list that is neither the club's nor the
 * timer's and cannot be explained in a banner; always replacing the device's
 * list was rejected because it is a silent rug-pull on the regulars, who are
 * exactly the people most invested in the app.
 *
 * The switch is per-device and unsynced. Its initial position is *derived*
 * rather than stored — a device that has never customized anything opens on the
 * club's list — and it only ever moves because something moved it.
 *
 * The club's list never touches `toastmaster_role_rules` and friends. Those are
 * SYNCED_KEYS: writing a club's presets into them would push the club's list
 * into the buyer's personal profile and from there onto every other device they
 * own. The upside of that separation is that "the device's own presets are kept
 * aside untouched" costs nothing — leaving the club is a key deletion, not a
 * restore, and there is no backup to lose.
 */

export const PRESET_SOURCE_CLUB = 'club';
export const PRESET_SOURCE_PERSONAL = 'personal';

const PRESETS_ENDPOINT = '/api/club/presets';

/**
 * Whether this device has ever customized its own timing rules.
 *
 * Tests for the *absence of writes* rather than deep-equality against
 * DEFAULT_ROLE_RULES: a device that never customized simply has nothing in
 * those keys, which is cheaper to ask and does not drift when the built-in
 * defaults change.
 *
 * @returns {boolean}
 */
export function hasPersonalCustomization() {
  const rules = loadRoleRules();
  if (rules && Object.keys(rules).length > 0) return true;
  if (loadHiddenBuiltinRoles().length > 0) return true;
  return loadRoleOrder().length > 0;
}

/**
 * Whether the club has a list this device could actually show.
 *
 * A lapsed club answers no, which is what makes the lapse behaviour fall out
 * for free: the device returns to the built-ins plus whatever it had customized
 * before it activated, with nothing deleted and nothing to restore on renewal.
 *
 * @returns {boolean}
 */
export function clubPresetsAvailable() {
  const club = loadClub();
  if (!club?.entitled) return false;
  const presets = loadClubPresets();
  return Boolean(presets && Object.keys(presets.rules ?? {}).length > 0);
}

/**
 * The switch position: 'club' or 'personal'.
 *
 * @returns {'club'|'personal'}
 */
export function presetSource() {
  return readPresetSource() ?? (hasPersonalCustomization() ? PRESET_SOURCE_PERSONAL : PRESET_SOURCE_CLUB);
}

/** Whether the club's published list is what the timer is currently looking at. */
export function clubPresetsLive() {
  return clubPresetsAvailable() && presetSource() === PRESET_SOURCE_CLUB;
}

/** The club's name, when it has one worth putting in a banner. */
export function activeClubName() {
  const club = loadClub();
  if (!club?.entitled) return null;
  return club.club?.name || null;
}

/** Whether this device's signed-in user may publish to the club. */
export function canPublishPresets() {
  const club = loadClub();
  if (!club?.entitled) return false;
  return club.role === 'admin' || club.role === 'editor';
}

function withoutHidden(rules, hidden) {
  const merged = { ...rules };
  for (const role of hidden ?? []) delete merged[role];
  return merged;
}

/**
 * The timing rules the app should run with right now.
 *
 * The one question the rest of the app asks. `TimerContext` seeds its `roleRules`
 * from here instead of reading `loadRoleRules()` directly, and that is the whole
 * of the change on the consuming side.
 *
 * @returns {Object} role name → { green, yellow, red, graceAfterRed }
 */
export function resolveActiveRules() {
  if (!clubPresetsLive()) {
    return withoutHidden({ ...DEFAULT_ROLE_RULES, ...(loadRoleRules() ?? {}) }, loadHiddenBuiltinRoles());
  }
  const presets = loadClubPresets();
  // No DEFAULT_ROLE_RULES base: a publish sends the publisher's full list, so
  // the club's list is complete on its own. Merging the built-ins back in would
  // resurrect exactly the roles the admin removed.
  return withoutHidden({ ...presets.rules }, presets.hiddenBuiltins);
}

/**
 * The built-in roles that should not appear, from whichever list is live.
 *
 * `roleOptions` is built from this rather than from `resolveActiveRules()`'s
 * keys, because a built-in the admin removed is absent from the rules map and
 * would otherwise still be offered with its factory timings.
 *
 * @returns {string[]}
 */
export function resolveActiveHiddenBuiltins() {
  if (!clubPresetsLive()) return loadHiddenBuiltinRoles();
  return clubHiddenBuiltins(loadClubPresets());
}

/**
 * A built-in the club's list simply does not contain is a built-in the admin
 * removed, whether or not the publish spelled it out. Deriving it rather than
 * trusting the field is what keeps the roles on offer and the timings behind
 * them describing the same list.
 */
function clubHiddenBuiltins(presets) {
  return [
    ...new Set([
      ...(presets?.hiddenBuiltins ?? []),
      ...Object.keys(DEFAULT_ROLE_RULES).filter((role) => !(role in (presets?.rules ?? {}))),
    ]),
  ];
}

/**
 * The order the club's (or the timer's) added roles are listed in.
 *
 * @returns {string[]}
 */
export function resolveActiveRoleOrder() {
  if (!clubPresetsLive()) return loadRoleOrder();
  return loadClubPresets().order ?? [];
}

/**
 * Copy the club's list into this device's own keys and move the switch.
 *
 * Forking rather than overriding has two consequences worth naming. The forked
 * list lands in synced keys, so it propagates to that person's other devices —
 * correct, since it is now their personal list. And "reset to club" stops being
 * a data operation at all: the club's list is still sitting untouched in its
 * own key, so resetting is flipping the switch back and clearing the copy.
 *
 * @returns {boolean} whether there was a club list to fork from
 */
export function forkFromClub() {
  const presets = loadClubPresets();
  if (!presets) return false;

  saveRoleRules({ ...presets.rules });
  // The derived list, not the published field: the personal path merges over
  // DEFAULT_ROLE_RULES, so anything short of this would resurrect every
  // built-in the admin removed the moment the fork landed.
  saveHiddenBuiltinRoles(clubHiddenBuiltins(presets));
  saveRoleOrder([...(presets.order ?? [])]);
  // Explicit, so the switch never moves merely because hasPersonalCustomization()
  // quietly became true as a side effect of the copy above.
  writePresetSource(PRESET_SOURCE_PERSONAL);
  return true;
}

/**
 * Go back to the club's published list and drop this device's copy.
 *
 * @returns {boolean} whether there was a club list to go back to
 */
export function resetToClub() {
  if (!clubPresetsAvailable()) return false;
  saveRoleRules({});
  saveHiddenBuiltinRoles([]);
  saveRoleOrder([]);
  writePresetSource(PRESET_SOURCE_CLUB);
  return true;
}

/** Move to this device's own list without copying anything into it. */
export function usePersonalPresets() {
  writePresetSource(PRESET_SOURCE_PERSONAL);
}

/** Move to the club's list, leaving this device's own keys untouched. */
export function useClubPresets() {
  writePresetSource(PRESET_SOURCE_CLUB);
}

/**
 * The guard every mutating path in the rules editor runs first.
 *
 * Add, update, remove and reset-all all await this one function so they cannot
 * drift into four behaviours. `confirm` is supplied by the caller because the
 * confirmation is a React modal and this module is framework-free.
 *
 * @param {() => Promise<boolean>|boolean} confirm - resolves true to fork
 * @returns {Promise<boolean>} false means the caller must do nothing at all
 */
export async function ensureForked(confirm) {
  if (!clubPresetsLive()) return true;
  const confirmed = await confirm?.();
  if (!confirmed) return false;
  return forkFromClub();
}

/**
 * Publish this device's current list to the club.
 *
 * Refused server-side for anyone but an admin or editor: publishing rewrites
 * every timer's list, and that is not something whoever happens to hold a
 * shared code should be able to do.
 *
 * @param {{rules: Object, order?: string[], hiddenBuiltins?: string[]}} presets
 * @param {{getToken?: () => string|null, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{ok: true, ver: number, presets: Object}|{ok: false, error: string}>}
 *   never rejects
 */
export async function publishPresets(presets, { getToken, fetchImpl } = {}) {
  const club = loadClub();
  if (!club?.clubToken) return { ok: false, error: 'no_club' };

  let response;
  try {
    const token = getToken?.();
    response = await (fetchImpl ?? fetch)(PRESETS_ENDPOINT, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...clubHeaders(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({
        rules: presets?.rules ?? {},
        order: presets?.order ?? [],
        hiddenBuiltins: presets?.hiddenBuiltins ?? [],
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

  if (!response.ok || !body?.presets) {
    return { ok: false, error: body?.error || (response.status === 403 ? 'forbidden' : 'publish_failed') };
  }

  rememberPublishedPresets(body.ver, body.presets);
  return { ok: true, ver: body.ver, presets: body.presets };
}

/**
 * What this device would publish: whichever list is live, as a publish payload.
 *
 * @returns {{rules: Object, order: string[], hiddenBuiltins: string[]}}
 */
export function currentPublishablePresets() {
  return {
    rules: resolveActiveRules(),
    order: resolveActiveRoleOrder(),
    hiddenBuiltins: resolveActiveHiddenBuiltins(),
  };
}
