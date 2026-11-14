/**
 * Announcements: a one-line notice above the tabs, one at a time.
 *
 * To announce something, add an entry to ANNOUNCEMENTS with a new `id`. The
 * first entry that applies is the one shown, so put the most important first.
 * Take an entry out once it is over, or give it an `ends` date.
 *
 * An `id` is what a dismissal remembers, so never reuse one: a new id shows
 * the notice to everyone again, including people who closed an earlier one.
 *
 * Fields:
 * - `id`       unique and never reused.
 * - `lead`     optional bold opener, e.g. "Coming soon:".
 * - `text`     the message. Keep it to two lines in the Zoom side panel.
 * - `tone`     'info' (blue, the default), 'success' (green) or 'warning' (amber).
 * - `surfaces` which apps show it: 'zoom', 'web'. Defaults to ['zoom'].
 * - `starts`, `ends`  optional ISO dates: shown from `starts` until `ends`.
 * - `when`     optional ({ flags }) => boolean. It waits for the flags to be
 *              known, so a gated notice never flashes on load. Tie it to a
 *              release flag (declared in worker/flags.js) to switch a notice
 *              on and off from PostHog without a deploy.
 * - `link`     optional { label, url }, opened outside the app.
 */
export const ANNOUNCEMENTS = Object.freeze([
  Object.freeze({
    id: 'pre-launch-2026-11',
    lead: 'Coming soon:',
    text: 'a fresh new look for the timer, and Pro features for your club.',
    tone: 'info',
    surfaces: ['zoom'],
    // Retires itself at launch, when the Pro launch announcement takes over.
    when: ({ flags }) => !flags.pro,
  }),
]);

// Per device on purpose: closing a notice in Zoom says nothing about the web.
export const ANNOUNCEMENTS_DISMISSED_KEY = 'toastmaster_announcements_dismissed';

/** The ids this device has closed. Never throws; bad storage reads as none. */
export function loadDismissedAnnouncements() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ANNOUNCEMENTS_DISMISSED_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Remember that this device closed an announcement. Returns false when storage
 * refused it, in which case the notice is back on the next load.
 */
export function dismissAnnouncement(id) {
  const dismissed = loadDismissedAnnouncements();
  if (dismissed.includes(id)) return true;
  try {
    localStorage.setItem(ANNOUNCEMENTS_DISMISSED_KEY, JSON.stringify([...dismissed, id]));
    return true;
  } catch {
    return false;
  }
}

function inWindow(announcement, now) {
  const starts = announcement.starts ? Date.parse(announcement.starts) : null;
  const ends = announcement.ends ? Date.parse(announcement.ends) : null;
  if (starts !== null && !Number.isNaN(starts) && now < starts) return false;
  if (ends !== null && !Number.isNaN(ends) && now >= ends) return false;
  return true;
}

/**
 * The announcement to show now, or null.
 *
 * @param {Object} options
 * @param {'zoom'|'web'} options.surface - the app asking
 * @param {Object} [options.flags] - release flags, as `getFlags()` returns them
 * @param {boolean} [options.flagsKnown] - whether the server has answered yet
 * @param {string[]} [options.dismissed] - ids this device closed
 * @param {number} [options.now]
 * @param {ReadonlyArray<Object>} [options.announcements]
 */
export function pickAnnouncement({
  surface,
  flags = {},
  flagsKnown = false,
  dismissed = loadDismissedAnnouncements(),
  now = Date.now(),
  announcements = ANNOUNCEMENTS,
} = {}) {
  for (const announcement of announcements) {
    if (!announcement?.id || !announcement.text) continue;
    if (!(announcement.surfaces ?? ['zoom']).includes(surface)) continue;
    if (dismissed.includes(announcement.id)) continue;
    if (!inWindow(announcement, now)) continue;
    if (announcement.when) {
      if (!flagsKnown) continue;
      let applies = false;
      try {
        applies = announcement.when({ flags }) === true;
      } catch {
        // A broken condition hides its notice rather than the app.
      }
      if (!applies) continue;
    }
    return announcement;
  }
  return null;
}
