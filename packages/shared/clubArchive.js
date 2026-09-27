import { loadClub, clubHeaders } from './club.js';

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

const listeners = new Set();

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

async function uploadOne(entry, { getToken, fetchImpl }) {
  const token = getToken?.();
  return (fetchImpl ?? fetch)(`${MEETINGS_ENDPOINT}/${encodeURIComponent(entry.meetingId)}/speeches`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...clubHeaders(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: 'same-origin',
    cache: 'no-store',
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
 * Called on app start, from `recordSpeech`, and again after each success.
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
        } catch {
          // Offline. Everything stays queued.
          break;
        }

        // A 5xx is the club's problem, not this entry's: keep it and stop.
        if (response.status >= 500) break;
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
    return { sent, pending: outboxCount() };
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

/** Test seam: drop the in-flight drain and every subscriber. */
export function resetClubArchiveForTests() {
  draining = null;
  listeners.clear();
}
