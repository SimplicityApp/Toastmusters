// Default timing rules for different speech types (in seconds)
// graceAfterRed: extra seconds after red before speech is disqualified (over time)
export const DEFAULT_ROLE_RULES = {
  'Short Roles': { green: 30, yellow: 45, red: 60, graceAfterRed: 15 },
  'Table Topics Speech': { green: 60, yellow: 90, red: 120, graceAfterRed: 30 },
  'Table Topics Evaluation': { green: 30, yellow: 45, red: 60, graceAfterRed: 15 },
  'Standard Speech': { green: 300, yellow: 360, red: 420, graceAfterRed: 30 },
  'Ice Breaker': { green: 240, yellow: 300, red: 360, graceAfterRed: 30 },
  'Speech Evaluation': { green: 120, yellow: 150, red: 180, graceAfterRed: 30 },
  'General Evaluation': { green: 180, yellow: 240, red: 300, graceAfterRed: 30 },
  'Custom': { green: 30, yellow: 45, red: 60, graceAfterRed: 15 },
};

export const ROLE_OPTIONS = Object.keys(DEFAULT_ROLE_RULES);

/** Default rules for the Custom role (and for new rows in Edit Rules). Single source of truth. */
export const DEFAULT_CUSTOM_RULES = { ...DEFAULT_ROLE_RULES['Custom'] };

// Break Time: a countdown session between speeches. Deliberately not part of
// DEFAULT_ROLE_RULES — its thresholds are derived from the chosen length, not
// edited number by number, so it does not belong in the rules editor.
export const BREAK_ROLE = 'Take a Break';
export const DEFAULT_BREAK_SECONDS = 600;
// Offered as one-tap choices next to the custom input. Most common first.
export const BREAK_QUICK_PICKS = [600, 300, 180];

/**
 * Timing rules for a break of the given length.
 *
 * The same engine as a speech — elapsed time crossing green, then yellow, then
 * red — but the thresholds are proportions of the total, so every break has
 * the same rhythm whatever its length: blue for the first 60%, green until
 * 80%, yellow for the last stretch, red when time is up. The countdown flag is
 * what makes displays show time remaining instead of time elapsed.
 *
 * @param {number} totalSeconds - Break length; clamped to at least 30 seconds
 * @returns {{green: number, yellow: number, red: number, graceAfterRed: number, countdown: true}}
 */
export function deriveBreakRules(totalSeconds) {
  const total = Math.max(30, Math.round(Number(totalSeconds) || 0));
  return {
    green: Math.round(total * 0.6),
    yellow: Math.round(total * 0.8),
    red: total,
    // A break has no disqualification: nobody runs over a break, the meeting
    // just resumes.
    graceAfterRed: 0,
    countdown: true,
  };
}

/**
 * Whether these rules describe a countdown session (a break) rather than a
 * counted-up speech.
 * @param {Object} [rules]
 * @returns {boolean}
 */
export function isCountdownRules(rules) {
  return rules?.countdown === true;
}

/** Default grace (sec) after red before disqualification: 15 for short/table-topics-eval, 30 otherwise */
export function getDefaultGraceAfterRed(role) {
  return role === 'Short Roles' || role === 'Table Topics Evaluation' ? 15 : 30;
}
