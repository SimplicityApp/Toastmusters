import { loadClub, clubHeaders, clubKit, getClubLogoImage } from './club.js';
import { renderReportPng, reportImageFilename, isOvertime } from './reportImage.js';

/**
 * Every finished speech, on its way to the club's archive.
 *
 * Two decisions carry this whole module, and everything else falls out of them.
 *
 * `speechId` is generated on the device, so the upload is a `put` to a key that
 * has never existed. A retry after a flaky network rewrites the same key with
 * the same bytes, which makes at-least-once delivery exactly right and means
 * the queue needs no ack protocol, no dedup and no ordering guarantee.
 *
 * `meetingId` is *derived* from the club's calendar day rather than negotiated
 * with the server, so an entry that sat in the outbox overnight still knows
 * where it belongs without asking, and two laptops timing the same evening
 * converge on one record with no coordination.
 *
 * The queue is persisted rather than in-memory because this app treats webview
 * reloads as routine — the same reason `zoomSdk.js` persists its overlay flags.
 * "If the laptop dies mid-meeting, everything up to that point is in the
 * archive" is only true if unsent speeches survive a reload.
 */

/** Speeches this device has timed but not yet handed to the club. */
export const CLUB_OUTBOX_STORAGE_KEY = 'toastmaster_club_outbox';
/**
 * Which meeting of the day this device is on: `{ date: 'YYYYMMDD', seq: n }`.
 *
 * Device-local and deliberately not synced. It exists only so a club that
 * meets twice on one day does not fold both meetings into one record.
 */
export const MEETING_SEQ_STORAGE_KEY = 'toastmaster_meeting_seq';

const MEETINGS_ENDPOINT = '/api/club/meetings';

/**
 * A ceiling, not a target. An outbox this long means something has been wrong
 * for weeks; dropping the oldest entries beats letting localStorage fill up and
 * start throwing on the writes the timer itself depends on.
 */
const MAX_OUTBOX_ENTRIES = 500;

/**
 * A request that has not answered in ten seconds is not going to.
 *
 * The one thing the queue could not survive was a request that neither resolved
 * nor rejected — a connection that died while the laptop slept, most often.
 * `fetch` will wait on that for ever, the in-flight `draining` promise never
 * settles, and every later drain returns that same stuck promise: the outbox
 * reads "1 speech waiting to upload" on a device that is demonstrably online.
 */
const UPLOAD_TIMEOUT_MS = 10_000;

/**
 * 15s, 30s, 60s, then every 5 minutes.
 *
 * Before this the only two things that ever re-tried were app start and the
 * next FINISH, so a single failed upload sat in the queue until somebody timed
 * another speech — or until the meeting was over and the app was closed.
 */
const RETRY_BACKOFF_MS = [15_000, 30_000, 60_000, 300_000];

/**
 * How long "End meeting & share" will wait for the queue before going ahead.
 *
 * The drain is what folds this device's speeches into the meeting the share is
 * about, so it is worth waiting for — but not worth freezing the button for. A
 * speech that misses the deadline is merged into the already-compacted header
 * on the next compaction, which is the case this module was built around.
 */
const DRAIN_DEADLINE_MS = 8_000;

/** The meeting this device shared last, so sharing it twice is not two meetings. */
export const LAST_SHARE_STORAGE_KEY = 'toastmaster_club_last_share';

const listeners = new Set();

/**
 * Where an upload failure goes.
 *
 * An injected function rather than an import, because this module is shared by
 * two apps with two PostHog instances and no analytics of its own. Both wire it
 * up at start; a surface that does not is simply not counted.
 *
 * @type {((event: string, properties: Object) => void)|null}
 */
let reporter = null;

/** @param {((event: string, properties: Object) => void)|null} fn */
export function setArchiveReporter(fn) {
  reporter = typeof fn === 'function' ? fn : null;
}

function reportFailure(reason) {
  try {
    reporter?.('club_upload_failed', { reason, pending: outboxCount() });
  } catch {
    // Analytics must never be the reason a speech is not retried.
  }
}

function notify() {
  for (const listener of listeners) {
    try {
      listener(outboxCount());
    } catch {
      // One bad subscriber must not stop the others hearing about it.
    }
  }
}

/**
 * Subscribe to the outbox depth, for the "Saved to <club>" indicator.
 *
 * @param {(count: number) => void} listener
 * @returns {() => void} unsubscribe
 */
export function subscribeOutbox(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The queued speeches, oldest first.
 *
 * @returns {Array<Object>}
 */
export function readOutbox() {
  try {
    const raw = localStorage.getItem(CLUB_OUTBOX_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry === 'object') : [];
  } catch {
    return [];
  }
}

function writeOutbox(entries) {
  try {
    if (entries.length) localStorage.setItem(CLUB_OUTBOX_STORAGE_KEY, JSON.stringify(entries));
    else localStorage.removeItem(CLUB_OUTBOX_STORAGE_KEY);
  } catch {
    // Private mode, or storage full. The speech is still on the Report tab and
    // still in the device's own reports key; only the archive misses it.
  }
}

/** How many speeches are still waiting to be handed over. */
export function outboxCount() {
  return readOutbox().length;
}

/** Whether this device has work the club has not received yet. */
export function outboxPending() {
  return outboxCount() > 0;
}

// ---------------------------------------------------------------------------
// The meeting a speech belongs to
// ---------------------------------------------------------------------------

/**
 * Today's date in the club's timezone, as `YYYYMMDD`.
 *
 * The timezone is load-bearing, not decoration: a 7–9pm Eastern meeting crosses
 * midnight UTC, so a "today" computed anywhere but in the club's own zone would
 * split one meeting in half partway through.
 *
 * Falls back to the device's own zone when the club has not set one, and again
 * to the device's zone when the stored zone is not one this browser knows.
 *
 * @param {number} [now]
 * @param {string|null} [timezone] - an IANA zone, e.g. 'America/Toronto'
 * @returns {string} eight digits
 */
export function clubDateString(now = Date.now(), timezone = null) {
  const format = (zone) =>
    new Intl.DateTimeFormat('en-CA', {
      ...(zone ? { timeZone: zone } : {}),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(now));

  let formatted;
  try {
    formatted = format(timezone || undefined);
  } catch {
    // An unknown zone on the club record must not stop a speech being saved.
    formatted = format(undefined);
  }
  return formatted.replace(/\D/g, '').slice(0, 8);
}

function readMeetingSeq() {
  try {
    const raw = localStorage.getItem(MEETING_SEQ_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.date !== 'string' || !Number.isFinite(Number(parsed.seq))) return null;
    return { date: parsed.date, seq: Math.max(1, Math.round(Number(parsed.seq))) };
  } catch {
    return null;
  }
}

/**
 * The meeting this device is timing right now.
 *
 *   20260929      the club's first meeting that day
 *   20260929-2    "New meeting" pressed on the same day
 *
 * @param {{now?: number, timezone?: string|null}} [options]
 * @returns {string}
 */
export function deriveMeetingId({ now = Date.now(), timezone } = {}) {
  const zone = timezone === undefined ? loadClub()?.timezone ?? null : timezone;
  const date = clubDateString(now, zone);
  const stored = readMeetingSeq();
  const seq = stored && stored.date === date ? stored.seq : 1;
  return seq > 1 ? `${date}-${seq}` : date;
}

/**
 * Start a second (or third) meeting on the same calendar day.
 *
 * @param {{now?: number, timezone?: string|null}} [options]
 * @returns {string} the meetingId speeches will now be filed under
 */
export function startNewMeeting({ now = Date.now(), timezone } = {}) {
  const zone = timezone === undefined ? loadClub()?.timezone ?? null : timezone;
  const date = clubDateString(now, zone);
  const stored = readMeetingSeq();
  const seq = (stored && stored.date === date ? stored.seq : 1) + 1;
  try {
    localStorage.setItem(MEETING_SEQ_STORAGE_KEY, JSON.stringify({ date, seq }));
  } catch {
    // The day's single meeting is still the right answer without this.
  }
  return deriveMeetingId({ now, timezone: zone });
}

/** The date a meetingId names, as `YYYY-MM-DD`. */
export function meetingDate(meetingId) {
  const digits = String(meetingId ?? '').slice(0, 8);
  if (!/^\d{8}$/.test(digits)) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

// ---------------------------------------------------------------------------
// Queueing and draining
// ---------------------------------------------------------------------------

function newSpeechId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    // Fall through to the counter below.
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Queue a finished speech for the club, and start handing it over.
 *
 * Never awaited by the caller and never rejects: FINISH must return the timer
 * to the organizer at once, and a club that cannot be reached is a retry, not
 * an error anybody has to see.
 *
 * A device with no club, or on a club that has lapsed, queues nothing at all —
 * which is what makes the lapse behaviour fall out for free.
 *
 * @param {{name?: string, role?: string, duration?: string, color?: string,
 *   comments?: string, disqualified?: boolean, speechId?: string,
 *   finishedAt?: number, meetingId?: string}} speech
 * @param {{getToken?: () => string|null, fetchImpl?: typeof fetch, now?: number}} [options]
 * @returns {Object|null} the queued entry, or null when there was no club
 */
export function recordSpeech(speech, { getToken, fetchImpl, now = Date.now() } = {}) {
  const club = loadClub();
  if (!club?.clubToken || !club.entitled || !speech) return null;

  const entry = {
    speechId: typeof speech.speechId === 'string' && speech.speechId ? speech.speechId : newSpeechId(),
    meetingId:
      typeof speech.meetingId === 'string' && speech.meetingId
        ? speech.meetingId
        : deriveMeetingId({ now, timezone: club.timezone ?? null }),
    name: String(speech.name ?? ''),
    role: String(speech.role ?? ''),
    duration: String(speech.duration ?? ''),
    color: String(speech.color ?? ''),
    comments: String(speech.comments ?? ''),
    disqualified: speech.disqualified === true,
    finishedAt: typeof speech.finishedAt === 'number' ? speech.finishedAt : now,
  };

  const queued = [...readOutbox(), entry];
  writeOutbox(queued.length > MAX_OUTBOX_ENTRIES ? queued.slice(-MAX_OUTBOX_ENTRIES) : queued);
  notify();

  // Fire-and-forget: the drain is allowed to fail, and the entry stays queued
  // when it does. Caught here all the same — an unhandled rejection in the
  // FINISH path would surface in the console of someone running a meeting.
  drainOutbox({ getToken, fetchImpl }).catch(() => {});

  return entry;
}

// One request in flight at a time, the same discipline the overlay queue and
// the profile push already use. Concurrent callers share the running drain.
let draining = null;

/** What a request that never answered throws, so the drain can name the reason. */
class UploadTimeout extends Error {
  constructor() {
    super('The club did not answer in time');
    this.name = 'UploadTimeout';
  }
}

/**
 * Give a promise a deadline it cannot talk its way out of.
 *
 * The `AbortController` is the polite half and is what a real `fetch` honours;
 * the race is the half that holds when it does not — an implementation that
 * ignores the signal, or a webview that has simply stopped answering.
 */
function withDeadline(promise, ms, controller) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // Already aborted, or no AbortController on this platform.
      }
      reject(new UploadTimeout());
    }, ms);
    const settle = (fn) => (value) => {
      clearTimeout(timer);
      fn(value);
    };
    promise.then(settle(resolve), settle(reject));
  });
}

async function uploadOne(entry, { getToken, fetchImpl }) {
  const token = getToken?.();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const request = (fetchImpl ?? fetch)(`${MEETINGS_ENDPOINT}/${encodeURIComponent(entry.meetingId)}/speeches`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...clubHeaders(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: 'same-origin',
    cache: 'no-store',
    ...(controller ? { signal: controller.signal } : {}),
    body: JSON.stringify({
      speechId: entry.speechId,
      name: entry.name,
      role: entry.role,
      duration: entry.duration,
      color: entry.color,
      comments: entry.comments,
      disqualified: entry.disqualified,
      finishedAt: entry.finishedAt,
    }),
  });
  return withDeadline(Promise.resolve(request), UPLOAD_TIMEOUT_MS, controller);
}

// ---------------------------------------------------------------------------
// Coming back to a queue that did not go out
// ---------------------------------------------------------------------------

let retryTimer = null;
let retryAttempt = 0;
let retryOptions = null;
let wakeListening = false;

function clearRetryTimer() {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
}

/** The queue is empty: forget the backoff so the next failure starts at 15s. */
function stopRetrying() {
  clearRetryTimer();
  retryAttempt = 0;
}

/**
 * Come back to a queue that did not go out, without waiting for a FINISH.
 *
 * Backoff rather than a fixed interval because the commonest reason a drain
 * fails is that the club — or the hall's wifi — is having a bad few minutes,
 * and a device that retried every 15 seconds for an hour would be part of it.
 */
function scheduleRetry(options) {
  retryOptions = options;
  listenForWake();
  if (retryTimer !== null) return;
  const delay = RETRY_BACKOFF_MS[Math.min(retryAttempt, RETRY_BACKOFF_MS.length - 1)];
  retryAttempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    drainOutbox(retryOptions ?? {}).catch(() => {});
  }, delay);
  // Node only, and only in tests: a pending retry must not hold the process up.
  retryTimer?.unref?.();
}

/**
 * The two moments worth more than any timer: the network came back, and the
 * person came back. Both mean "try now" rather than "try in four minutes".
 */
function onWake() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (!outboxPending()) return;
  // An explicit signal resets the backoff: this is a new situation, not the
  // next tick of the old one.
  stopRetrying();
  drainOutbox(retryOptions ?? {}).catch(() => {});
}

function listenForWake() {
  if (wakeListening || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  wakeListening = true;
  window.addEventListener('online', onWake);
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onWake);
  }
}

function stopListeningForWake() {
  if (!wakeListening) return;
  wakeListening = false;
  window.removeEventListener('online', onWake);
  if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
    document.removeEventListener('visibilitychange', onWake);
  }
}

/**
 * Hand over everything queued, oldest first, one request at a time.
 *
 *   200       → drop from the outbox
 *   4xx       → drop from the outbox; the server will never accept this entry
 *   5xx / net → keep it, and stop draining; the next trigger tries again
 *
 * Stopping on the first retryable failure rather than pushing on keeps the
 * order the speeches were timed in, and keeps an offline device from making one
 * doomed request per queued speech.
 *
 * Whatever is left over schedules its own next attempt, which is the difference
 * between a queue that drains and a queue that waits: app start and the next
 * FINISH used to be the only two triggers in the product.
 *
 * @param {{getToken?: () => string|null, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{sent: number, pending: number}>} never rejects
 */
export function drainOutbox({ getToken, fetchImpl } = {}) {
  if (draining) return draining;

  draining = (async () => {
    let sent = 0;
    try {
      // Re-read between entries rather than iterating a snapshot: a speech
      // finished while the drain is in flight must not be dropped by a write
      // that predates it.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const queue = readOutbox();
        if (!queue.length) break;
        const entry = queue[0];
        if (!loadClub()?.clubToken) break;

        let response;
        try {
          // eslint-disable-next-line no-await-in-loop
          response = await uploadOne(entry, { getToken, fetchImpl });
        } catch (error) {
          // Offline, or a connection that died while the laptop slept.
          // Everything stays queued.
          reportFailure(error instanceof UploadTimeout || error?.name === 'AbortError' ? 'timeout' : 'network');
          break;
        }

        // A 5xx is the club's problem, not this entry's: keep it and stop.
        if (response.status >= 500) {
          reportFailure('http_5xx');
          break;
        }
        // Anything else — accepted, or refused in a way a retry cannot fix —
        // means this entry is done travelling.
        const remaining = readOutbox().filter((queued) => queued.speechId !== entry.speechId);
        writeOutbox(remaining);
        notify();
        if (response.ok) sent += 1;
      }
    } finally {
      draining = null;
    }
    const pending = outboxCount();
    if (pending) scheduleRetry({ getToken, fetchImpl });
    else stopRetrying();
    return { sent, pending };
  })();

  return draining;
}

// ---------------------------------------------------------------------------
// Reading the archive back
// ---------------------------------------------------------------------------

async function getJson(path, { getToken, fetchImpl }) {
  const club = loadClub();
  if (!club?.clubToken) return { ok: false, error: 'no_club' };

  let response;
  try {
    const token = getToken?.();
    response = await (fetchImpl ?? fetch)(path, {
      headers: {
        ...clubHeaders(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'same-origin',
      cache: 'no-store',
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
  if (!response.ok) return { ok: false, error: body?.error || 'unavailable' };
  return { ok: true, body };
}

/**
 * The club's meetings, newest first.
 *
 * @param {{getToken?: () => string|null, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{ok: true, meetings: Array<Object>}|{ok: false, error: string}>}
 *   never rejects
 */
export async function fetchHistory({ getToken, fetchImpl } = {}) {
  const result = await getJson(MEETINGS_ENDPOINT, { getToken, fetchImpl });
  if (!result.ok) return result;
  return { ok: true, meetings: Array.isArray(result.body?.meetings) ? result.body.meetings : [] };
}

/**
 * One meeting, with every speech in it.
 *
 * @param {string} meetingId
 * @param {{getToken?: () => string|null, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{ok: true, meeting: Object}|{ok: false, error: string}>} never rejects
 */
export async function fetchMeeting(meetingId, { getToken, fetchImpl } = {}) {
  if (!meetingId) return { ok: false, error: 'not_found' };
  const result = await getJson(`${MEETINGS_ENDPOINT}/${encodeURIComponent(meetingId)}`, { getToken, fetchImpl });
  if (!result.ok) return result;
  return { ok: true, meeting: result.body?.meeting ?? null };
}

/**
 * End the meeting and give it a public address.
 *
 * The device sends the two PNGs it just rendered rather than asking the Worker
 * to draw them, which is what guarantees the chat preview can never drift from
 * what the timer saw when they tapped Copy image — there is only ever one
 * renderer.
 *
 * Multipart rather than JSON: these are image bytes, and base64ing them into a
 * JSON string would inflate them by a third for nothing.
 *
 * @param {string} meetingId
 * @param {{title?: string|null, png?: Blob|null, previewPng?: Blob|null,
 *   getToken?: () => string|null, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{ok: true, url: string, token: string, imageUrl: string}
 *   |{ok: false, error: string}>} never rejects
 */
export async function shareMeeting(meetingId, { title, png, previewPng, getToken, fetchImpl } = {}) {
  const club = loadClub();
  if (!club?.clubToken) return { ok: false, error: 'no_club' };
  if (!meetingId) return { ok: false, error: 'not_found' };

  const form = new FormData();
  if (typeof title === 'string' && title.trim()) form.append('title', title.trim());
  // A device with no PNG encoder shares the link without the picture rather
  // than failing: the page the link opens renders the table as HTML anyway.
  const attach = (field, blob, filename) => {
    if (blob && typeof blob.arrayBuffer === 'function') form.append(field, blob, filename);
  };
  attach('png', png, 'report.png');
  attach('previewPng', previewPng, 'preview.png');

  let response;
  try {
    const token = getToken?.();
    response = await (fetchImpl ?? fetch)(`${MEETINGS_ENDPOINT}/${encodeURIComponent(meetingId)}/share`, {
      method: 'POST',
      headers: {
        // Deliberately no Content-Type: the boundary is generated with the body.
        ...clubHeaders(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'same-origin',
      cache: 'no-store',
      body: form,
    });
  } catch {
    // Offline at the end of a meeting. The PNG is still in the timer's hands,
    // so "Copy image" keeps working and only the link is missing.
    return { ok: false, error: 'network' };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || !body?.url) return { ok: false, error: body?.error || 'unavailable' };
  return { ok: true, url: body.url, token: body.token ?? null, imageUrl: body.imageUrl ?? null };
}

// ---------------------------------------------------------------------------
// Sharing the same meeting twice
// ---------------------------------------------------------------------------

/**
 * The meeting this device shared last, and what was in it.
 *
 * `startNewMeeting()` runs on a successful share, so the id this device derives
 * moves on immediately — while the Report tab still shows the meeting that just
 * ended, because clearing it is the timer's decision and not ours. Sharing a
 * second time therefore used to derive the *next* meeting, which has no
 * speeches in it, and the server answered 404 with the title and the link gone.
 *
 * @returns {{meetingId: string, url: string|null, token: string|null,
 *   title: string|null, speechIds: string[]}|null}
 */
function readLastShare() {
  try {
    const raw = localStorage.getItem(LAST_SHARE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.meetingId !== 'string' || !parsed.meetingId) return null;
    return {
      meetingId: parsed.meetingId,
      url: typeof parsed.url === 'string' ? parsed.url : null,
      token: typeof parsed.token === 'string' ? parsed.token : null,
      title: typeof parsed.title === 'string' ? parsed.title : null,
      speechIds: Array.isArray(parsed.speechIds) ? parsed.speechIds.filter((id) => typeof id === 'string') : [],
    };
  } catch {
    return null;
  }
}

function writeLastShare(value) {
  try {
    localStorage.setItem(LAST_SHARE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Private mode, or storage full. A second share derives the next meeting
    // again, which is where this started.
  }
}

/**
 * Whether the timer has finished anything since the last share.
 *
 * "Nothing new" is the whole test: the same rows, shared again, is one meeting
 * being shared twice — a typo in the title, a link that never reached the
 * group chat — and it has to reuse the meeting the server already has.
 */
function isRepeatShare(localIds, last) {
  if (!last?.meetingId || !localIds.length) return false;
  return localIds.every((speechId) => last.speechIds.includes(speechId));
}

/**
 * "End meeting & share", end to end.
 *
 * One function rather than two copies in two ReportTabs, because the ordering
 * is the part that has to be right and it is not obvious: the outbox is drained
 * *first*, so that compaction on the server folds in every speech this device
 * is still holding; then the club's own copy of the meeting is read back, so
 * the counts and both PNGs describe the whole evening rather than this laptop's
 * half of it; then the upload; and only then does the day's sequence advance,
 * so that a failed share does not silently start a second meeting.
 *
 * Reading the meeting back is what fixes a two-device evening reporting itself
 * as "2 speeches, 1 over time" when three were timed: the caller can only pass
 * the rows on its own Report tab, and the archive is where the other laptop's
 * speeches are.
 *
 * Never rejects. A share that could not reach the club still comes back with
 * the image in hand, because "Copy image" is the destination that needs no
 * network at all.
 *
 * @param {{title?: string|null, speeches?: Array<Object>, meetingId?: string,
 *   getToken?: () => string|null, fetchImpl?: typeof fetch, now?: number,
 *   createCanvas?: Function}} [options]
 * @returns {Promise<{meetingId: string, date: string|null, title: string|null,
 *   speeches: number, overtime: number, blob: Blob|null, filename: string,
 *   url: string|null, token: string|null, error: string|null}>}
 */
export async function endMeetingAndShare({
  title = null,
  speeches = [],
  meetingId,
  getToken,
  fetchImpl,
  now = Date.now(),
  createCanvas,
} = {}) {
  const club = loadClub();
  const kit = clubKit();
  const rows = Array.isArray(speeches) ? speeches : [];
  const localIds = rows.map((speech) => speech?.speechId).filter(Boolean);

  // Nothing timed since the last share means this is the same meeting being
  // shared again, not an empty new one.
  const last = readLastShare();
  const repeat = !meetingId && isRepeatShare(localIds, last);

  const id = meetingId || (repeat ? last.meetingId : deriveMeetingId({ now, timezone: club?.timezone ?? null }));
  const date = meetingDate(id);
  const clubName = kit?.name || club?.club?.name || 'Timing report';
  // A repeat share with no title typed keeps the one the meeting already has,
  // rather than quietly clearing it.
  const cleanTitle =
    typeof title === 'string' && title.trim() ? title.trim() : repeat ? (last.title ?? null) : null;

  const result = {
    meetingId: id,
    date,
    title: cleanTitle,
    speeches: rows.length,
    overtime: rows.filter(isOvertime).length,
    blob: null,
    filename: reportImageFilename({ clubName, date }),
    url: null,
    token: null,
    error: null,
  };

  // Anything still queued belongs in this meeting, and compaction is about to
  // close it. Failing to drain is not fatal — a late speech is merged into the
  // already-compacted header on the next compaction — and neither is failing to
  // drain *in time*: a hung request must not freeze the share button.
  const deadline = countdown(DRAIN_DEADLINE_MS);
  try {
    await Promise.race([drainOutbox({ getToken, fetchImpl }), deadline.reached]);
  } catch {
    // drainOutbox never rejects; belt and braces on the FINISH-adjacent path.
  } finally {
    deadline.cancel();
  }

  const shown = await wholeMeeting(id, rows, { getToken, fetchImpl });
  result.speeches = shown.length;
  result.overtime = shown.filter(isOvertime).length;

  const report = { club, kit, meeting: { meetingId: id, date, title: cleanTitle }, speeches: shown };
  const draw = { logo: getClubLogoImage(), ...(createCanvas ? { createCanvas } : {}) };
  let previewPng = null;
  try {
    [result.blob, previewPng] = await Promise.all([
      renderReportPng(report, { ...draw, variant: 'full' }),
      renderReportPng(report, { ...draw, variant: 'preview' }),
    ]);
  } catch {
    // No canvas, or no PNG encoder. The link still works; only the picture is
    // missing, and the page the link opens renders the table as HTML anyway.
  }

  const shared = await shareMeeting(id, {
    title: cleanTitle,
    png: result.blob,
    previewPng,
    getToken,
    fetchImpl,
  });
  if (shared.ok) {
    result.url = shared.url;
    result.token = shared.token;
    writeLastShare({
      meetingId: id,
      url: shared.url,
      token: shared.token,
      title: cleanTitle,
      speechIds: localIds,
    });
    // Only once the club has the meeting, and never on a repeat: advancing the
    // day's sequence after a failed share would file the retry under a meeting
    // that does not exist, and advancing it twice for one meeting would leave a
    // gap in the day nobody ever meets in.
    if (!repeat) startNewMeeting({ now, timezone: club?.timezone ?? null });
  } else {
    result.error = shared.error;
  }

  return result;
}

/** A deadline that can be called off once whatever it was racing has landed. */
function countdown(ms) {
  let timer = null;
  const reached = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
    // Node only, and only in tests: a deadline nobody is waiting on any more
    // must not hold the process up.
    timer?.unref?.();
  });
  return { reached, cancel: () => clearTimeout(timer) };
}

/**
 * Every speech in the meeting, not just this device's.
 *
 * The club's copy is the authority — it is what the /r/ page and every other
 * device read — so it leads. The local rows are folded in behind it rather than
 * dropped, because a speech whose upload is still queued is a speech that
 * happened, and a share that silently left it out would be the same under-count
 * from the other direction.
 */
async function wholeMeeting(meetingId, rows, { getToken, fetchImpl }) {
  const archived = await fetchMeeting(meetingId, { getToken, fetchImpl });
  const server = archived.ok && Array.isArray(archived.meeting?.speeches) ? archived.meeting.speeches : null;
  // Offline, or a meeting the club has never heard of: the device's own rows
  // are what "Copy image" has always promised to work from.
  if (!server?.length) return rows;

  const merged = new Map(server.map((speech) => [speech.speechId, speech]));
  for (const speech of rows) {
    if (speech?.speechId && !merged.has(speech.speechId)) merged.set(speech.speechId, speech);
  }
  return [...merged.values()];
}

/** Test seam: drop the in-flight drain, the retry backoff and every subscriber. */
export function resetClubArchiveForTests() {
  draining = null;
  stopRetrying();
  stopListeningForWake();
  retryOptions = null;
  reporter = null;
  listeners.clear();
}
