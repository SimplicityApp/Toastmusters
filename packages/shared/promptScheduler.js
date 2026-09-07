import { notifyLocalWrite } from './storageEvents.js';
/**
 * Decides when to interrupt a user with an occasional in-app prompt (the club
 * question, the Zoom review ask) and remembers what they already answered.
 *
 * All state lives in one localStorage key so a user who answers in the browser
 * timer is not asked again there, and the Zoom app keeps its own copy. Pure
 * functions take `now` so the cadence can be tested without faking clocks.
 */

const STORAGE_KEY = 'toastmaster_prompts';

const DAY_MS = 24 * 60 * 60 * 1000;

export const CLUB_PROMPT = 'club';
export const REVIEW_PROMPT = 'review';

/**
 * Cadence per prompt. The thresholds are deliberately conservative: a prompt
 * that shows up before the app has proved useful gets dismissed, and a
 * dismissed prompt is a wasted ask.
 *
 * - firstAskAfterSpeeches: speeches timed before the very first ask
 * - speechesBetweenAsks:   extra speeches needed before asking again
 * - daysBetweenAsks:       days that must also pass before asking again
 * - maxAsks:               hard stop, so a silent user is never nagged forever
 */
export const PROMPT_RULES = {
  [CLUB_PROMPT]: {
    firstAskAfterSpeeches: 3,
    speechesBetweenAsks: 5,
    daysBetweenAsks: 14,
    maxAsks: 3,
  },
  [REVIEW_PROMPT]: {
    firstAskAfterSpeeches: 10,
    speechesBetweenAsks: 15,
    daysBetweenAsks: 30,
    maxAsks: 3,
  },
};

// The club question takes one line to answer, so it goes first when both are due.
export const PROMPT_ORDER = [CLUB_PROMPT, REVIEW_PROMPT];

// Two prompts never land closer together than this, whichever prompts they are.
export const GLOBAL_COOLDOWN_DAYS = 3;

// Answered / declined are both terminal: the prompt is never shown again.
export const RESOLUTION_ANSWERED = 'answered';
export const RESOLUTION_DECLINED = 'declined';

/**
 * True only where VITE_ENABLE_DEBUG_PANEL is explicitly "true", so the calendar
 * gates are skipped: waiting 14 or 30 real days for a re-ask makes the cadence
 * impossible to test by hand. Usage thresholds, the per-prompt ask cap and
 * answered/declined all still apply.
 *
 * Deliberately not tied to `import.meta.env.DEV` — relaxing the cadence must be
 * opt-in, never a side effect of an env file going missing. For everyday testing
 * reach for the debug panel's prompt controls (forcePrompt / resetPromptState)
 * instead of this flag.
 *
 * @returns {boolean}
 */
export function isPromptDebugMode() {
  try {
    // Read the key directly: Vite only substitutes the literal
    // `import.meta.env.VITE_*` form, so `import.meta.env?.VITE_*` would compile
    // to a lookup on the stub env object and always be undefined in a build.
    // The try/catch covers plain-Node consumers, where import.meta.env is absent.
    return import.meta.env.VITE_ENABLE_DEBUG_PANEL === 'true';
  } catch {
    return false;
  }
}

function emptyPromptRecord() {
  return {
    asks: 0,
    lastAskAt: 0,
    lastAskAtSpeeches: 0,
    resolution: null,
  };
}

function emptyState() {
  return {
    speechesFinished: 0,
    lastPromptAt: 0,
    prompts: PROMPT_ORDER.reduce((acc, key) => {
      acc[key] = emptyPromptRecord();
      return acc;
    }, {}),
  };
}

/**
 * Fill in anything a stored payload is missing, so adding a prompt or a field
 * later cannot throw on an old browser's data.
 * @param {Object|null} stored - Raw parsed localStorage payload
 * @returns {Object} Complete prompt state
 */
function normalize(stored) {
  const state = emptyState();
  if (!stored || typeof stored !== 'object') return state;

  if (Number.isFinite(stored.speechesFinished)) {
    state.speechesFinished = stored.speechesFinished;
  }
  if (Number.isFinite(stored.lastPromptAt)) {
    state.lastPromptAt = stored.lastPromptAt;
  }

  PROMPT_ORDER.forEach((key) => {
    const record = stored.prompts?.[key];
    if (!record || typeof record !== 'object') return;
    if (Number.isFinite(record.asks)) state.prompts[key].asks = record.asks;
    if (Number.isFinite(record.lastAskAt)) state.prompts[key].lastAskAt = record.lastAskAt;
    if (Number.isFinite(record.lastAskAtSpeeches)) {
      state.prompts[key].lastAskAtSpeeches = record.lastAskAtSpeeches;
    }
    if (record.resolution === RESOLUTION_ANSWERED || record.resolution === RESOLUTION_DECLINED) {
      state.prompts[key].resolution = record.resolution;
    }
  });

  return state;
}

/**
 * Load prompt state from localStorage
 * @returns {Object} Prompt state (defaults if nothing is stored)
 */
export function loadPromptState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return normalize(stored ? JSON.parse(stored) : null);
  } catch (error) {
    console.error('Failed to load prompt state:', error);
    return emptyState();
  }
}

/**
 * Save prompt state to localStorage
 * @param {Object} state - Prompt state
 */
export function savePromptState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    notifyLocalWrite(STORAGE_KEY);
  } catch (error) {
    console.error('Failed to save prompt state:', error);
  }
}

/**
 * Clear all prompt history (used by tests and manual QA)
 */
export function resetPromptState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    notifyLocalWrite(STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear prompt state:', error);
  }
  notify(emptyState());
}

const listeners = new Set();

function notify(state) {
  listeners.forEach((listener) => {
    try {
      listener(state);
    } catch (error) {
      console.error('Prompt state listener failed:', error);
    }
  });
}

/**
 * Subscribe to prompt state changes — a speech finishing, a prompt being shown
 * or resolved, or the history being cleared.
 * @param {Function} listener - Called with the new state
 * @returns {Function} Unsubscribe function
 */
export function subscribeToPromptState(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const forceListeners = new Set();

/**
 * Subscribe to manual "show this prompt now" requests from the debug panel.
 * @param {Function} listener - Called with the prompt key to show
 * @returns {Function} Unsubscribe function
 */
export function subscribeToForcedPrompt(listener) {
  forceListeners.add(listener);
  return () => forceListeners.delete(listener);
}

/**
 * Put a prompt on screen right now, skipping every cadence gate and the polite
 * delay after a speech. For the debug panel only: it deliberately records no
 * ask, so forcing a prompt cannot skew the cadence being tested. Answering or
 * declining a forced prompt still writes the real resolution.
 *
 * @param {string} key - CLUB_PROMPT or REVIEW_PROMPT
 */
export function forcePrompt(key) {
  forceListeners.forEach((listener) => {
    try {
      listener(key);
    } catch (error) {
      console.error('Forced prompt listener failed:', error);
    }
  });
}

/**
 * Count a finished speech — the signal that the app just did its job.
 * @returns {Object} Updated prompt state
 */
export function recordSpeechFinished() {
  const state = loadPromptState();
  state.speechesFinished += 1;
  savePromptState(state);
  notify(state);
  return state;
}

/**
 * Whether a prompt is allowed to show right now.
 * @param {string} key - CLUB_PROMPT or REVIEW_PROMPT
 * @param {Object} state - Prompt state
 * @param {number} [now] - Current epoch ms
 * @param {Object} [options]
 * @param {boolean} [options.ignoreTimeGates] - Skip the global cooldown and the
 *   days-between-asks wait. Defaults to on in dev builds; pass explicitly to pin
 *   the behaviour regardless of environment.
 * @returns {boolean}
 */
export function isPromptDue(key, state, now = Date.now(), options = {}) {
  const { ignoreTimeGates = isPromptDebugMode() } = options;
  const rules = PROMPT_RULES[key];
  const record = state?.prompts?.[key];
  if (!rules || !record) return false;

  // Answered or explicitly declined: done asking, forever.
  if (record.resolution) return false;
  if (record.asks >= rules.maxAsks) return false;

  // A prompt of any kind shown recently blocks this one.
  if (
    !ignoreTimeGates &&
    state.lastPromptAt &&
    now - state.lastPromptAt < GLOBAL_COOLDOWN_DAYS * DAY_MS
  ) {
    return false;
  }

  if (record.asks === 0) {
    return state.speechesFinished >= rules.firstAskAfterSpeeches;
  }

  // Re-asking needs both more usage and more elapsed time, so a heavy user in a
  // single week is not asked repeatedly.
  const usedEnough =
    state.speechesFinished - record.lastAskAtSpeeches >= rules.speechesBetweenAsks;
  const waitedEnough = ignoreTimeGates || now - record.lastAskAt >= rules.daysBetweenAsks * DAY_MS;
  return usedEnough && waitedEnough;
}

/**
 * Pick the prompt to show, or null if none is due.
 * @param {Object} state - Prompt state
 * @param {number} [now] - Current epoch ms
 * @param {string[]} [enabled] - Prompts this app supports
 * @param {Object} [options] - Forwarded to isPromptDue
 * @returns {string|null} Prompt key
 */
export function selectDuePrompt(state, now = Date.now(), enabled = PROMPT_ORDER, options = {}) {
  return (
    PROMPT_ORDER.find((key) => enabled.includes(key) && isPromptDue(key, state, now, options)) ||
    null
  );
}

/**
 * Record that a prompt was put on screen. Dismissing it needs no further call:
 * an unanswered ask simply counts against the cadence.
 * @param {string} key - Prompt key
 * @param {number} [now] - Current epoch ms
 * @returns {Object} Updated prompt state
 */
export function markPromptShown(key, now = Date.now()) {
  const state = loadPromptState();
  const record = state.prompts[key];
  if (!record) return state;

  record.asks += 1;
  record.lastAskAt = now;
  record.lastAskAtSpeeches = state.speechesFinished;
  state.lastPromptAt = now;
  savePromptState(state);
  notify(state);
  return state;
}

function resolve(key, resolution) {
  const state = loadPromptState();
  if (!state.prompts[key]) return state;
  state.prompts[key].resolution = resolution;
  savePromptState(state);
  notify(state);
  return state;
}

/**
 * Record that the user answered a prompt (submitted the club, opened the review
 * page). It is never shown again.
 * @param {string} key - Prompt key
 * @returns {Object} Updated prompt state
 */
export function markPromptAnswered(key) {
  return resolve(key, RESOLUTION_ANSWERED);
}

/**
 * Record that the user asked not to see a prompt again.
 * @param {string} key - Prompt key
 * @returns {Object} Updated prompt state
 */
export function markPromptDeclined(key) {
  return resolve(key, RESOLUTION_DECLINED);
}
