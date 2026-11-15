import { notifyLocalWrite } from './storageEvents.js';
import { CLUB_POLL_TEMPLATE_STORAGE_KEY, loadClub, clubHeaders, rememberPublishedPollTemplate } from './club.js';
import { clubPresetsAvailable } from './clubPresets.js';

/**
 * Meeting polls (#80): the ballot for Best Table Topics Speaker, Best Speaker
 * and Best Evaluator, built from the speakers this meeting already timed.
 *
 * A template is the setup that outlives a meeting: `{categories: [{role,
 * label?, slots}], options: {postToChat, showOnStage, expiryHours}}`. A ballot
 * is one meeting's poll: `{categories: [{role, label?, candidates}]}`, where an
 * empty slot is an empty-string candidate. The Worker holds the votes; this
 * module only shapes what goes in and reads what comes out.
 *
 * Where a template comes from, first match wins: the club's (when the club's
 * presets are available on this device, so a lapsed club falls through), the
 * personal one (synced, see profileMerge.js), the default. Editing the ballot
 * for one meeting writes only the draft, never a template.
 */

export const POLL_TEMPLATE_STORAGE_KEY = 'toastmaster_poll_template';
/** This meeting's edited ballot. Local, cleared with the reports. */
export const POLL_DRAFT_STORAGE_KEY = 'toastmaster_poll_draft';
/** Closed polls of this meeting. Local, cleared with the reports. */
export const POLL_RESULTS_STORAGE_KEY = 'toastmaster_poll_results';

export const DEFAULT_POLL_ROLES = ['Table Topics Speech', 'Standard Speech', 'Table Topics Evaluation'];
export const DEFAULT_POLL_SLOTS = 3;
export const DEFAULT_POLL_OPTIONS = Object.freeze({ postToChat: true, showOnStage: false, expiryHours: 24 });
const MAX_SLOTS = 20;

/** The template a club with nothing saved gets: the three usual votes. */
export function defaultPollTemplate() {
  return {
    categories: DEFAULT_POLL_ROLES.map((role) => ({ role, slots: DEFAULT_POLL_SLOTS })),
    options: { ...DEFAULT_POLL_OPTIONS },
  };
}

/** A fresh default ballot, three empty slots per category. */
export function defaultBallot() {
  return ballotFromTemplate(defaultPollTemplate(), [], DEFAULT_POLL_ROLES);
}

const clampSlots = (value) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(MAX_SLOTS, Math.max(1, n)) : DEFAULT_POLL_SLOTS;
};

/**
 * Keep only what a template is made of. A category with no role is dropped.
 *
 * @param {Object} raw
 * @returns {{categories: Array<{role: string, label?: string, slots: number}>,
 *   options: {postToChat: boolean, showOnStage: boolean, expiryHours: number}}}
 */
export function normalizeTemplate(raw) {
  const categories = (Array.isArray(raw?.categories) ? raw.categories : [])
    .filter((c) => typeof c?.role === 'string' && c.role.trim())
    .map((c) => ({
      role: c.role.trim(),
      ...(typeof c.label === 'string' && c.label.trim() ? { label: c.label.trim() } : {}),
      slots: clampSlots(c.slots),
    }));
  const options = raw?.options ?? {};
  const hours = Number(options.expiryHours);
  return {
    categories,
    options: {
      postToChat: typeof options.postToChat === 'boolean' ? options.postToChat : DEFAULT_POLL_OPTIONS.postToChat,
      showOnStage: typeof options.showOnStage === 'boolean' ? options.showOnStage : DEFAULT_POLL_OPTIONS.showOnStage,
      expiryHours: Number.isFinite(hours) && hours > 0 ? Math.min(24, hours) : DEFAULT_POLL_OPTIONS.expiryHours,
    },
  };
}

/**
 * This meeting's ballot: each category's candidates are the distinct names
 * timed in its role, in timing order; a category nobody was timed in gets its
 * empty slots.
 *
 * @param {Object} template
 * @param {Array<{name: string, role: string, finishedAt?: number}>} reports
 * @param {string[]} [roleNames] - roles the timer knows; a category in any other role still keeps its slots
 */
export function ballotFromTemplate(template, reports = [], roleNames = []) {
  const known = new Set(roleNames);
  const timed = [...(reports ?? [])].sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  return {
    categories: normalizeTemplate(template).categories.map(({ role, label, slots }) => {
      const names = [];
      if (known.size === 0 || known.has(role)) {
        for (const r of timed) {
          const name = typeof r?.name === 'string' ? r.name.trim() : '';
          if (r?.role === role && name && !names.includes(name)) names.push(name);
        }
      }
      return { role, ...(label ? { label } : {}), candidates: names.length ? names : Array(slots).fill('') };
    }),
  };
}

/**
 * Every name tied at the top count, in the order given; nobody when nobody voted.
 *
 * @param {Object<string, number>} counts - candidate name → votes
 * @returns {string[]}
 */
export function winners(counts) {
  const entries = Object.entries(counts ?? {}).filter(([, n]) => Number(n) > 0);
  if (!entries.length) return [];
  const top = Math.max(...entries.map(([, n]) => Number(n)));
  return entries.filter(([, n]) => Number(n) === top).map(([name]) => name);
}

/** What a category is called: its label, else its role. */
export const categoryTitle = (category) => category?.label || category?.role || '';

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value, { synced = false } = {}) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    if (synced) notifyLocalWrite(key);
  } catch {
    // Private mode: the poll still runs this page load.
  }
}

const usable = (template) => (template && normalizeTemplate(template).categories.length ? normalizeTemplate(template) : null);

/** The personal template, or null. */
export const loadPollTemplate = () => usable(readJson(POLL_TEMPLATE_STORAGE_KEY));

/** Save the personal template through the synced store. */
export function savePollTemplate(template) {
  writeJson(POLL_TEMPLATE_STORAGE_KEY, normalizeTemplate(template), { synced: true });
}

/** The club's template as this device last received it, or null. */
export const loadClubPollTemplate = () => usable(readJson(CLUB_POLL_TEMPLATE_STORAGE_KEY));

/** The template this device sets polls up from right now. */
export function activePollTemplate() {
  return (clubPresetsAvailable() && loadClubPollTemplate()) || loadPollTemplate() || defaultPollTemplate();
}

/**
 * Publish a template to the club. Refused server-side for anyone but an admin
 * or editor, as presets are.
 *
 * @param {Object} template
 * @param {{getToken?: () => string|null, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{ok: true, ver: number}|{ok: false, error: string}>} never rejects
 */
export async function publishPollTemplate(template, { getToken, fetchImpl } = {}) {
  if (!loadClub()?.clubToken) return { ok: false, error: 'no_club' };
  const normalized = normalizeTemplate(template);
  let response;
  try {
    const token = getToken?.();
    response = await (fetchImpl ?? fetch)('/api/club/poll-template', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...clubHeaders(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(normalized),
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, error: body?.error || (response.status === 403 ? 'forbidden' : 'publish_failed') };
  rememberPublishedPollTemplate(body?.ver, body?.pollTemplate?.categories ? body.pollTemplate : normalized);
  return { ok: true, ver: body?.ver };
}

/** This meeting's edited ballot, or null when it has not been touched. */
export function loadPollDraft() {
  const draft = readJson(POLL_DRAFT_STORAGE_KEY);
  return Array.isArray(draft?.categories) ? draft : null;
}

export const savePollDraft = (draft) => writeJson(POLL_DRAFT_STORAGE_KEY, draft ?? null);

/** Closed polls of this meeting, oldest first. */
export function loadPollResults() {
  const results = readJson(POLL_RESULTS_STORAGE_KEY);
  return Array.isArray(results) ? results : [];
}

/** Add or replace one closed poll, by pollId. */
export function savePollResult(result) {
  const others = loadPollResults().filter((r) => r.pollId !== result.pollId);
  writeJson(POLL_RESULTS_STORAGE_KEY, [...others, result]);
}

/** Drop this meeting's draft and results; Clear on the Report tab calls it with the reports. */
export function clearPollMeeting() {
  writeJson(POLL_DRAFT_STORAGE_KEY, null);
  writeJson(POLL_RESULTS_STORAGE_KEY, null);
}

/**
 * Turn the Worker's answer to Close into what this device keeps: per category,
 * its names, counts in candidate order, the path split and the winners.
 *
 * @param {string} pollId
 * @param {{categories: Array}} ballot - the ballot the poll was opened with
 * @param {{counts: number[][], byPath?: Object, winners?: string[][]}} closed
 * @param {number} [closedAt]
 */
export function closedPollResult(pollId, ballot, closed, closedAt = Date.now()) {
  return {
    pollId,
    closedAt,
    categories: (ballot?.categories ?? []).map((category, i) => {
      const candidates = category.candidates ?? [];
      const counts = candidates.map((_, j) => Number(closed?.counts?.[i]?.[j] ?? 0));
      const byPath = {};
      for (const path of ['zoom', 'guest', 'link']) {
        byPath[path] = candidates.map((_, j) => Number(closed?.byPath?.[path]?.[i]?.[j] ?? 0));
      }
      const byName = {};
      candidates.forEach((name, j) => {
        byName[name] = (byName[name] ?? 0) + counts[j];
      });
      return {
        role: category.role,
        ...(category.label ? { label: category.label } : {}),
        candidates,
        counts,
        byPath,
        winners: Array.isArray(closed?.winners?.[i]) ? closed.winners[i] : winners(byName),
      };
    }),
  };
}

// What "Show on Stage" put on this device's stage: `[{role, label?, winners}]`
// or null. In memory only, like the stage itself.
let stageWinners = null;
const stageListeners = new Set();

export const getStageWinners = () => stageWinners;

export function setStageWinners(categories) {
  stageWinners = Array.isArray(categories) && categories.length ? categories : null;
  for (const listener of stageListeners) listener();
}

export function subscribeStageWinners(listener) {
  stageListeners.add(listener);
  return () => stageListeners.delete(listener);
}
