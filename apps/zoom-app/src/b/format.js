import { formatPhaseTextFor, getPhaseInfo } from '@toastmaster-timer/shared';

/**
 * Words and colours for design B's timer card (plan 13). Kept apart from the
 * components so the card's sentences have one definition and one test.
 */

/** The card's colours per status, as drawn on the BCard board. */
export const CARD_PALETTE = Object.freeze({
  blue: { bg: '#4f86f7', fg: '#ffffff', shadow: 'rgba(37,99,235,0.28)', soft: 'rgba(255,255,255,0.22)', ghost: 'rgba(0,0,0,0.18)', inset: 'rgba(0,0,0,0.12)', ring: 'rgba(255,255,255,0.7)' },
  green: { bg: '#16a34a', fg: '#ffffff', shadow: 'rgba(22,163,74,0.3)', soft: 'rgba(255,255,255,0.22)', ghost: 'rgba(0,0,0,0.2)', inset: 'rgba(0,0,0,0.12)', ring: 'rgba(255,255,255,0.7)' },
  yellow: { bg: '#facc15', fg: '#422006', shadow: 'rgba(202,138,4,0.35)', soft: 'rgba(255,255,255,0.55)', ghost: 'rgba(66,32,6,0.12)', inset: 'rgba(66,32,6,0.08)', ring: 'rgba(66,32,6,0.35)' },
  red: { bg: '#dc2626', fg: '#ffffff', shadow: 'rgba(220,38,38,0.3)', soft: 'rgba(255,255,255,0.22)', ghost: 'rgba(0,0,0,0.22)', inset: 'rgba(0,0,0,0.14)', ring: 'rgba(255,255,255,0.7)' },
});

/** The four preview swatches, in the order the meeting sees the colours. */
export const PREVIEW_SWATCHES = Object.freeze([
  { color: 'blue', label: 'Blue', bg: '#4f86f7' },
  { color: 'green', label: 'Green', bg: '#22c55e' },
  { color: 'yellow', label: 'Yellow', bg: '#eab308' },
  { color: 'red', label: 'Red', bg: '#ef4444' },
]);

/**
 * A threshold the way people say it: 4:00, 0:30, 12:05. Shorter than the
 * clock's 04:00, which is what lets three of them share a line at 400px.
 *
 * @param {number} seconds
 */
export function formatThreshold(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/** "Green 4:00 · Yellow 5:00 · Red 6:00", or '' without rules. */
export function rulesLine(rules) {
  if (!rules) return '';
  return `Green ${formatThreshold(rules.green)} · Yellow ${formatThreshold(rules.yellow)} · Red ${formatThreshold(rules.red)}`;
}

/** "4:00 · 5:00 · 6:00", for the role picker's rows. */
export function thresholdsLine(rules) {
  if (!rules) return '';
  return `${formatThreshold(rules.green)} · ${formatThreshold(rules.yellow)} · ${formatThreshold(rules.red)}`;
}

const lowerFirst = (text) => (text ? text.charAt(0).toLowerCase() + text.slice(1) : text);
const NEXT_COLOUR = { blue: 'green', green: 'yellow', yellow: 'red' };
const COLOUR_NAME = { blue: 'Blue', green: 'Green', yellow: 'Yellow', red: 'Red' };
const THRESHOLD_FOR = { green: 'green', yellow: 'yellow', red: 'red' };

/**
 * The one line under the big clock: what is happening now and what comes
 * next, in the card's own words.
 *
 *   Ready · green at 4:00          idle speech
 *   Blue · green at 4:00           running
 *   Red phase                      running, past red
 *   Paused · red at 6:00           stopped mid-speech
 *   Counts down · green when 02:00 left   idle break
 *   Start works once your video is on      video off, nothing started
 *
 * @param {{
 *   status: 'blue'|'green'|'yellow'|'red'|null,
 *   rules: Object|null,
 *   isRunning: boolean,
 *   elapsedTime: number,
 *   previewColor?: string|null,
 *   videoOff?: boolean,
 * }} state
 * @returns {string}
 */
export function cardStatusLine({ status, rules, isRunning, elapsedTime, previewColor = null, videoOff = false }) {
  const idle = !isRunning && elapsedTime === 0;
  if (idle && videoOff) return 'Start works once your video is on';
  if (idle && previewColor) return `Previewing ${previewColor} on your video`;
  if (!rules) return '';

  const current = status || 'blue';
  if (rules.countdown) {
    const phase = formatPhaseTextFor(getPhaseInfo(elapsedTime, rules, current), rules);
    if (idle) return `Counts down · ${lowerFirst(phase)}`;
    return isRunning ? phase : `Paused · ${lowerFirst(phase)}`;
  }

  if (idle) return `Ready · green at ${formatThreshold(rules.green)}`;
  const next = NEXT_COLOUR[current];
  const upcoming = next ? `${next} at ${formatThreshold(rules[THRESHOLD_FOR[next]])}` : null;
  if (!isRunning) return upcoming ? `Paused · ${upcoming}` : 'Paused · red';
  return upcoming ? `${COLOUR_NAME[current]} · ${upcoming}` : 'Red phase';
}
