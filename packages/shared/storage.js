import { notifyLocalWrite } from './storageEvents.js';

/**
 * Write a key and announce it. Every setter below goes through this so the sync
 * layer learns about a change without being wired into each one.
 */
function persist(key, serialized) {
  localStorage.setItem(key, serialized);
  notifyLocalWrite(key);
}

/** Remove a key and announce it, for the same reason. */
function forget(key) {
  localStorage.removeItem(key);
  notifyLocalWrite(key);
}

const STORAGE_KEYS = {
  AGENDA: 'toastmaster_agenda',
  REPORTS: 'toastmaster_reports',
  ROLE_RULES: 'toastmaster_role_rules',
  ROLE_ORDER: 'toastmaster_role_order',
  HIDDEN_BUILTIN_ROLES: 'toastmaster_hidden_builtin_roles',
  OVERLAY_MODE: 'toastmaster_overlay_mode',
  TIME_INPUT_MODE: 'toastmaster_time_input_mode',
  STAGE_CLOCK_HIDDEN: 'toastmaster_stage_clock_hidden',
  REVEAL_FACE_WHEN_IDLE: 'toastmaster_reveal_face_when_idle',
  OVERLAY_TIME_READOUT: 'toastmaster_overlay_time_readout',
};

/**
 * Save agenda to localStorage
 * @param {Array} agenda - Agenda items array
 */
export function saveAgenda(agenda) {
  try {
    persist(STORAGE_KEYS.AGENDA, JSON.stringify(agenda));
  } catch (error) {
    console.error('Failed to save agenda:', error);
  }
}

/**
 * Load agenda from localStorage
 * @returns {Array} Agenda items array or empty array
 */
export function loadAgenda() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.AGENDA);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error('Failed to load agenda:', error);
    return [];
  }
}

/**
 * Clear agenda from localStorage
 */
export function clearAgenda() {
  try {
    forget(STORAGE_KEYS.AGENDA);
  } catch (error) {
    console.error('Failed to clear agenda:', error);
  }
}

/**
 * Save reports to localStorage
 * @param {Array} reports - Reports array
 */
export function saveReports(reports) {
  try {
    persist(STORAGE_KEYS.REPORTS, JSON.stringify(reports));
  } catch (error) {
    console.error('Failed to save reports:', error);
  }
}

/**
 * Load reports from localStorage
 * @returns {Array} Reports array or empty array
 */
export function loadReports() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.REPORTS);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error('Failed to load reports:', error);
    return [];
  }
}

/**
 * Clear reports from localStorage
 */
export function clearReports() {
  try {
    forget(STORAGE_KEYS.REPORTS);
  } catch (error) {
    console.error('Failed to clear reports:', error);
  }
}

/**
 * Save custom role rules to localStorage
 * @param {Object} roleRules - Role rules object
 */
export function saveRoleRules(roleRules) {
  try {
    persist(STORAGE_KEYS.ROLE_RULES, JSON.stringify(roleRules));
  } catch (error) {
    console.error('Failed to save role rules:', error);
  }
}

/**
 * Load custom role rules from localStorage
 * @returns {Object} Role rules object or null
 */
export function loadRoleRules() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.ROLE_RULES);
    return stored ? JSON.parse(stored) : null;
  } catch (error) {
    console.error('Failed to load role rules:', error);
    return null;
  }
}

/**
 * Load custom role names order from localStorage (user-added roles only, in order)
 * @returns {string[]} Array of custom role names or empty array
 */
export function loadRoleOrder() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.ROLE_ORDER);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error('Failed to load role order:', error);
    return [];
  }
}

/**
 * Save custom role names order to localStorage
 * @param {string[]} order - Array of custom role names
 */
export function saveRoleOrder(order) {
  try {
    persist(STORAGE_KEYS.ROLE_ORDER, JSON.stringify(order));
  } catch (error) {
    console.error('Failed to save role order:', error);
  }
}

/**
 * Load hidden built-in role names from localStorage (removed by user; restored by "Reset All to Defaults")
 * @returns {string[]} Array of built-in role names to hide
 */
export function loadHiddenBuiltinRoles() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.HIDDEN_BUILTIN_ROLES);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error('Failed to load hidden built-in roles:', error);
    return [];
  }
}

/**
 * Save hidden built-in role names to localStorage
 * @param {string[]} hidden - Array of built-in role names to hide
 */
export function saveHiddenBuiltinRoles(hidden) {
  try {
    persist(STORAGE_KEYS.HIDDEN_BUILTIN_ROLES, JSON.stringify(hidden));
  } catch (error) {
    console.error('Failed to save hidden built-in roles:', error);
  }
}

/**
 * Save overlay mode to localStorage
 * @param {string} mode - Overlay mode ('card' or 'camera')
 */
export function saveOverlayMode(mode) {
  try {
    persist(STORAGE_KEYS.OVERLAY_MODE, mode);
  } catch (error) {
    console.error('Failed to save overlay mode:', error);
  }
}

/**
 * Load overlay mode from localStorage
 * @returns {string|null} Overlay mode or null
 */
export function loadOverlayMode() {
  try {
    return localStorage.getItem(STORAGE_KEYS.OVERLAY_MODE);
  } catch (error) {
    console.error('Failed to load overlay mode:', error);
    return null;
  }
}

/**
 * Save the count-up readout settings for the pushed background: where it
 * sits, how big it is, and whether it shows at all.
 * @param {{x: number, y: number, scale: number, visible: boolean}} readout
 */
export function saveOverlayTimeReadout(readout) {
  try {
    persist(STORAGE_KEYS.OVERLAY_TIME_READOUT, JSON.stringify(readout));
  } catch (error) {
    console.error('Failed to save overlay time readout:', error);
  }
}

/**
 * Load the count-up readout settings. Field-tolerant: each field comes back
 * only if it was saved valid, so a caller can fall back per field.
 * @returns {{x?: number, y?: number, scale?: number, visible?: boolean}|null}
 */
export function loadOverlayTimeReadout() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.OVERLAY_TIME_READOUT);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const readout = {};
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      readout.x = Math.min(1, Math.max(0, x));
      readout.y = Math.min(1, Math.max(0, y));
    }
    const scale = Number(parsed.scale);
    if (Number.isFinite(scale) && scale > 0) readout.scale = scale;
    if (typeof parsed.visible === 'boolean') readout.visible = parsed.visible;
    return Object.keys(readout).length ? readout : null;
  } catch (error) {
    console.error('Failed to load overlay time readout:', error);
    return null;
  }
}

/**
 * Save whether the video modes drop their overlay between speeches, handing the
 * organizer their own background back.
 * @param {boolean} reveal - True to show the organizer's own background when idle
 */
export function saveRevealFaceWhenIdle(reveal) {
  try {
    persist(STORAGE_KEYS.REVEAL_FACE_WHEN_IDLE, String(reveal));
  } catch (error) {
    console.error('Failed to save reveal-face-when-idle:', error);
  }
}

/**
 * Load whether the video modes drop their overlay between speeches.
 *
 * @returns {boolean} Defaults to false — only an explicit 'true' turns it on.
 *   Off by default because in Timer + Camera every reveal costs a Zoom
 *   confirmation dialog, by Zoom's design: there is no silent way to take a
 *   virtual background off. Once per speech is enough to wear an organizer down,
 *   so the color stays up and the clear button takes it off once, when asked.
 */
export function loadRevealFaceWhenIdle() {
  try {
    return localStorage.getItem(STORAGE_KEYS.REVEAL_FACE_WHEN_IDLE) === 'true';
  } catch (error) {
    console.error('Failed to load reveal-face-when-idle:', error);
    return false;
  }
}

/**
 * Save whether the stage-mode countdown is hidden. Remembered across meetings:
 * a club that finds a ticking clock distracting for its speakers wants it off
 * every time, not once per session.
 * @param {boolean} hidden
 */
export function saveStageClockHidden(hidden) {
  try {
    persist(STORAGE_KEYS.STAGE_CLOCK_HIDDEN, String(hidden));
  } catch (error) {
    console.error('Failed to save stage clock visibility:', error);
  }
}

/**
 * Load whether the stage-mode countdown is hidden.
 * @returns {boolean} Defaults to false, so the clock shows until hidden
 */
export function loadStageClockHidden() {
  try {
    return localStorage.getItem(STORAGE_KEYS.STAGE_CLOCK_HIDDEN) === 'true';
  } catch (error) {
    console.error('Failed to load stage clock visibility:', error);
    return false;
  }
}

/**
 * Save time input mode to localStorage
 * @param {string} mode - 'minsec' or 'seconds'
 */
export function saveTimeInputMode(mode) {
  try {
    persist(STORAGE_KEYS.TIME_INPUT_MODE, mode);
  } catch (error) {
    console.error('Failed to save time input mode:', error);
  }
}

/**
 * Load time input mode from localStorage
 * @returns {string} 'minsec' or 'seconds' (defaults to 'minsec')
 */
export function loadTimeInputMode() {
  try {
    return localStorage.getItem(STORAGE_KEYS.TIME_INPUT_MODE) || 'minsec';
  } catch (error) {
    console.error('Failed to load time input mode:', error);
    return 'minsec';
  }
}

/**
 * Clear all stored data
 */
export function clearAllStorage() {
  try {
    Object.values(STORAGE_KEYS).forEach(key => {
      forget(key);
    });
  } catch (error) {
    console.error('Failed to clear storage:', error);
  }
}
