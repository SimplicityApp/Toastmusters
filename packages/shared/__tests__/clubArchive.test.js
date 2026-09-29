import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CLUB_OUTBOX_STORAGE_KEY,
  MEETING_SEQ_STORAGE_KEY,
  clubDateString,
  deriveMeetingId,
  drainOutbox,
  endMeetingAndShare,
  fetchHistory,
  fetchMeeting,
  meetingDate,
  outboxCount,
  outboxPending,
  readOutbox,
  recordSpeech,
  resetClubArchiveForTests,
  setArchiveReporter,
  startNewMeeting,
  subscribeOutbox,
} from '../clubArchive.js';
import { CLUB_STORAGE_KEY, resetClubForTests } from '../club.js';
import { resetEntitlementForTests } from '../entitlement.js';

/**
 * The outbox exists for one sentence in the product: "if the laptop dies
 * mid-meeting, everything up to that point is already in the archive." That is
 * only true if a queued speech survives a reload, so almost every test here is
 * some version of "kill the page and look again".
 */

/** 7:30pm Eastern on Tuesday 2026-09-29 — which is already the 30th in UTC. */
const EVENING = Date.UTC(2026, 8, 29, 23, 30);

const club = (over = {}) => ({
  clubToken: 'club.tok',
  ver: 1,
  club: { id: 'club-1', name: 'Downtown Speakers' },
  kit: null,
  badge: null,
  timezone: 'America/Toronto',
  role: null,
  plan: 'pro',
  entitled: true,
  status: 'active',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  source: 'club',
  lastRefreshAt: EVENING,
  ...over,
});

function joinClub(over) {
  localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(club(over)));
  resetClubForTests();
}

/** Drop every module-level cache, the way a page reload does. */
function reload() {
  resetClubForTests();
  resetClubArchiveForTests();
}

const ok = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
const serverError = () => ({ ok: false, status: 503, json: async () => ({ error: 'unavailable' }) });
const refused = () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_speech_id' }) });

const speech = (over = {}) => ({
  name: 'Alice',
  role: 'Standard Speech',
  duration: '5:50',
  color: 'green',
  comments: '',
  disqualified: false,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  resetClubForTests();
  resetClubArchiveForTests();
  resetEntitlementForTests();
  vi.setSystemTime(EVENING);
});

describe('which meeting a speech belongs to', () => {
  // The whole reason the timezone rides along on clubState. A 7–9pm Eastern
  // meeting is already "tomorrow" in UTC, so a server-side today would file the
  // first half and the second half under two different meetings.
  it('files a 7–9pm Eastern meeting under one day, though it crosses midnight UTC', () => {
    const zone = 'America/Toronto';
    const sevenPm = Date.UTC(2026, 8, 29, 23, 0); // 19:00 EDT
    const ninePm = Date.UTC(2026, 8, 30, 1, 0); //  21:00 EDT

    expect(clubDateString(sevenPm, zone)).toBe('20260929');
    expect(clubDateString(ninePm, zone)).toBe('20260929');
    // The same two instants, asked of UTC, land on two different days.
    expect(clubDateString(sevenPm, 'UTC')).not.toBe(clubDateString(ninePm, 'UTC'));
  });

  it('takes the timezone from the cached club', () => {
    joinClub({ timezone: 'America/Toronto' });
    expect(deriveMeetingId({ now: Date.UTC(2026, 8, 30, 1, 0) })).toBe('20260929');
  });

  it('falls back to the device’s own zone when the club has no timezone, and when it has a bad one', () => {
    joinClub({ timezone: null });
    expect(deriveMeetingId({ now: EVENING })).toMatch(/^\d{8}$/);
    joinClub({ timezone: 'Mars/Olympus_Mons' });
    expect(deriveMeetingId({ now: EVENING })).toMatch(/^\d{8}$/);
  });

  it('numbers a second meeting on the same day, and starts over the next day', () => {
    joinClub();
    expect(deriveMeetingId({ now: EVENING })).toBe('20260929');

    expect(startNewMeeting({ now: EVENING })).toBe('20260929-2');
    expect(deriveMeetingId({ now: EVENING })).toBe('20260929-2');

    // The stored sequence is scoped to its date, so tomorrow is plain again.
    expect(deriveMeetingId({ now: EVENING + 24 * 60 * 60 * 1000 })).toBe('20260930');
  });

  it('reads the date back out of a meetingId', () => {
    expect(meetingDate('20260929')).toBe('2026-09-29');
    expect(meetingDate('20260929-2')).toBe('2026-09-29');
    expect(meetingDate('nope')).toBeNull();
  });
});

describe('queueing a finished speech', () => {
  it('queues nothing at all without a club', () => {
    const fetchImpl = vi.fn();

    expect(recordSpeech(speech(), { fetchImpl })).toBeNull();
    expect(readOutbox()).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // The lapse behaviour, for free: a club record that is no longer entitled
  // stops the archive without anything being deleted or restored.
  it('queues nothing once the club has lapsed', () => {
    joinClub({ entitled: false, plan: 'free', status: 'canceled' });
    const fetchImpl = vi.fn();

    expect(recordSpeech(speech(), { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stamps an id, a meeting and a finish time, and posts to the meeting’s route', async () => {
    joinClub();
    const fetchImpl = vi.fn(async () => ok());

    const entry = recordSpeech(speech(), { fetchImpl, now: EVENING });
    await drainOutbox({ fetchImpl });

    expect(entry.speechId).toBeTruthy();
    expect(entry.meetingId).toBe('20260929');
    expect(entry.finishedAt).toBe(EVENING);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/club/meetings/20260929/speeches');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Club']).toBe('club.tok');
    expect(JSON.parse(init.body)).toMatchObject({ speechId: entry.speechId, name: 'Alice', duration: '5:50' });
  });

  it('keeps the id the caller supplied, so a retry is the same key', async () => {
    joinClub();
    const fetchImpl = vi.fn(async () => ok());

    recordSpeech(speech({ speechId: 'given-id' }), { fetchImpl });
    await drainOutbox({ fetchImpl });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).speechId).toBe('given-id');
  });
});

describe('draining the outbox', () => {
  it('drops an entry the club accepted', async () => {
    joinClub();
    const fetchImpl = vi.fn(async () => ok());

    recordSpeech(speech(), { fetchImpl });
    await drainOutbox({ fetchImpl });

    expect(readOutbox()).toEqual([]);
    expect(outboxPending()).toBe(false);
  });

  // Offline at 6:55pm in a church hall is the normal case, not an error path.
  it('keeps a speech queued when the network is down, and sends it on the next drain', async () => {
    joinClub();
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch'); });

    recordSpeech(speech(), { fetchImpl: offline });
    await drainOutbox({ fetchImpl: offline });
    expect(outboxCount()).toBe(1);

    const online = vi.fn(async () => ok());
    await drainOutbox({ fetchImpl: online });

    expect(online).toHaveBeenCalledTimes(1);
    expect(readOutbox()).toEqual([]);
  });

  // The queue is persisted precisely so this works: an in-memory one would lose
  // the evening the moment the webview reloaded.
  it('still holds the speech after the page is reloaded', async () => {
    joinClub();
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    recordSpeech(speech({ name: 'Bob' }), { fetchImpl: offline });
    await drainOutbox({ fetchImpl: offline });

    reload();

    expect(readOutbox()).toHaveLength(1);
    const online = vi.fn(async () => ok());
    await drainOutbox({ fetchImpl: online });
    expect(JSON.parse(online.mock.calls[0][1].body).name).toBe('Bob');
    expect(readOutbox()).toEqual([]);
  });

  it('stops after the first 5xx rather than making one doomed request per speech', async () => {
    joinClub();
    const fetchImpl = vi.fn(async () => serverError());

    recordSpeech(speech({ speechId: 'a' }), { fetchImpl });
    recordSpeech(speech({ speechId: 'b' }), { fetchImpl });
    await drainOutbox({ fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(readOutbox().map((e) => e.speechId)).toEqual(['a', 'b']);
  });

  // A 4xx is the server saying it will never accept this entry. Retrying it
  // forever would block every speech queued behind it.
  it('drops an entry the server refused, and carries on with the next', async () => {
    joinClub();
    const responses = [refused(), ok()];
    const sequenced = vi.fn(async () => responses.shift());

    recordSpeech(speech({ speechId: 'bad' }), { fetchImpl: sequenced });
    recordSpeech(speech({ speechId: 'good' }), { fetchImpl: sequenced });
    await drainOutbox({ fetchImpl: sequenced });

    expect(sequenced).toHaveBeenCalledTimes(2);
    expect(readOutbox()).toEqual([]);
  });

  it('sends the speeches in the order they were timed', async () => {
    joinClub();
    const sent = [];
    const fetchImpl = vi.fn(async (url, init) => { sent.push(JSON.parse(init.body).speechId); return ok(); });

    recordSpeech(speech({ speechId: 'first' }), { fetchImpl });
    recordSpeech(speech({ speechId: 'second' }), { fetchImpl });
    await drainOutbox({ fetchImpl });

    expect(sent).toEqual(['first', 'second']);
  });

  // The same single-in-flight discipline the overlay queue and the profile push
  // already use: two concurrent drains would upload every entry twice.
  it('keeps one request in flight however many drains are started', async () => {
    joinClub();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight -= 1;
      return ok();
    });

    recordSpeech(speech({ speechId: 'a' }), { fetchImpl });
    recordSpeech(speech({ speechId: 'b' }), { fetchImpl });
    const drains = [drainOutbox({ fetchImpl }), drainOutbox({ fetchImpl }), drainOutbox({ fetchImpl })];
    release();
    await Promise.all(drains);

    expect(peak).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(readOutbox()).toEqual([]);
  });

  it('tells the indicator when the queue empties', async () => {
    joinClub();
    const seen = [];
    subscribeOutbox((count) => seen.push(count));
    const fetchImpl = vi.fn(async () => ok());

    recordSpeech(speech(), { fetchImpl });
    await drainOutbox({ fetchImpl });

    expect(seen).toEqual([1, 0]);
  });

  it('survives an outbox key that is not an array', async () => {
    joinClub();
    localStorage.setItem(CLUB_OUTBOX_STORAGE_KEY, 'not json');

    expect(readOutbox()).toEqual([]);
    await expect(drainOutbox({ fetchImpl: vi.fn() })).resolves.toEqual({ sent: 0, pending: 0 });
  });

  it('stops trying to drain once the device has left the club', async () => {
    joinClub();
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    recordSpeech(speech(), { fetchImpl: offline });
    await drainOutbox({ fetchImpl: offline });

    localStorage.removeItem(CLUB_STORAGE_KEY);
    reload();
    const fetchImpl = vi.fn(async () => ok());
    await drainOutbox({ fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('reading the archive back', () => {
  it('asks for the club’s meetings with the club header', async () => {
    joinClub();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ meetings: [{ meetingId: '20260929', speeches: 4, overtime: 1 }] }),
    }));

    const result = await fetchHistory({ fetchImpl });

    expect(fetchImpl.mock.calls[0][0]).toBe('/api/club/meetings');
    expect(fetchImpl.mock.calls[0][1].headers['X-Club']).toBe('club.tok');
    expect(result).toEqual({ ok: true, meetings: [{ meetingId: '20260929', speeches: 4, overtime: 1 }] });
  });

  it('never rejects when the network is down', async () => {
    joinClub();
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch'); });

    await expect(fetchHistory({ fetchImpl: offline })).resolves.toEqual({ ok: false, error: 'network' });
  });

  it('says so rather than throwing when there is no club', async () => {
    await expect(fetchHistory({ fetchImpl: vi.fn() })).resolves.toEqual({ ok: false, error: 'no_club' });
  });

  it('fetches one meeting with its speeches', async () => {
    joinClub();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ meeting: { meetingId: '20260929', speeches: [{ name: 'Alice' }] } }),
    }));

    const result = await fetchMeeting('20260929', { fetchImpl });

    expect(fetchImpl.mock.calls[0][0]).toBe('/api/club/meetings/20260929');
    expect(result.meeting.speeches).toEqual([{ name: 'Alice' }]);
  });

  it('turns a 404 into an answer, not an exception', async () => {
    joinClub();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'not_found' }) }));

    await expect(fetchMeeting('20200101', { fetchImpl })).resolves.toEqual({ ok: false, error: 'not_found' });
  });
});

describe('the stored meeting sequence', () => {
  it('ignores a corrupt sequence key', () => {
    joinClub();
    localStorage.setItem(MEETING_SEQ_STORAGE_KEY, '{{{');
    expect(deriveMeetingId({ now: EVENING })).toBe('20260929');
  });
});

describe('ending a meeting and sharing it', () => {
  /** A canvas whose context does nothing but answer, so a PNG comes back. */
  const createCanvas = (width, height) => ({
    width,
    height,
    getContext: () => ({
      fillRect: () => {},
      fillText: () => {},
      drawImage: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      quadraticCurveTo: () => {},
      fill: () => {},
      save: () => {},
      restore: () => {},
      measureText: (text) => ({ width: String(text).length * 8 }),
    }),
    toBlob: (cb) => cb(new Blob(['png'], { type: 'image/png' })),
  });

  const shared = (over = {}) => ({
    ok: true,
    status: 200,
    json: async () => ({ token: 'ABCDEFGHJKMNPQRS', url: 'https://x/r/ABCDEFGHJKMNPQRS', ...over }),
  });

  const rows = [speech(), speech({ name: 'Bob', color: 'red' })];

  it('drains the outbox before it asks the server to close the meeting', async () => {
    joinClub();
    const failing = vi.fn(async () => serverError());
    recordSpeech(speech(), { fetchImpl: failing });
    // Join the drain recordSpeech fired, so the 5xx has definitely landed and
    // the entry is definitely still queued before the share starts.
    await drainOutbox({ fetchImpl: failing });
    expect(outboxCount()).toBe(1);

    const calls = [];
    const fetchImpl = vi.fn(async (url) => {
      calls.push(String(url));
      return String(url).endsWith('/share') ? shared() : ok();
    });

    await endMeetingAndShare({ speeches: rows, fetchImpl, createCanvas });

    // The queued speech has to reach the club before compaction folds the
    // meeting away, or the picture and the page disagree with the archive.
    expect(calls[0]).toContain('/speeches');
    expect(calls[calls.length - 1]).toContain('/share');
    expect(outboxCount()).toBe(0);
  });

  it('sends both variants and the title as multipart', async () => {
    joinClub();
    const fetchImpl = vi.fn(async () => shared());

    const result = await endMeetingAndShare({
      title: '  Humorous Speech Contest  ',
      speeches: rows,
      fetchImpl,
      createCanvas,
    });

    // Not call 0 any more: the club's own copy of the meeting is read back
    // first, so the counts and both PNGs cover every device's speeches.
    const [url, init] = fetchImpl.mock.calls.find(([called]) => String(called).endsWith('/share'));
    expect(url).toBe('/api/club/meetings/20260929/share');
    expect(init.method).toBe('POST');
    // No Content-Type: the boundary is generated with the body.
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.headers['X-Club']).toBe('club.tok');
    expect(init.body.get('title')).toBe('Humorous Speech Contest');
    expect(init.body.get('png')).toBeTruthy();
    expect(init.body.get('previewPng')).toBeTruthy();
    expect(result).toMatchObject({
      meetingId: '20260929',
      date: '2026-09-29',
      title: 'Humorous Speech Contest',
      speeches: 2,
      overtime: 1,
      url: 'https://x/r/ABCDEFGHJKMNPQRS',
      error: null,
    });
    expect(result.filename).toBe('downtown-speakers-2026-09-29.png');
  });

  it('starts the next meeting only once the club has this one', async () => {
    joinClub();

    const failed = await endMeetingAndShare({
      speeches: rows,
      fetchImpl: vi.fn(async () => serverError()),
      createCanvas,
    });

    // A failed share must not file the retry under a meeting that never closed.
    expect(failed.error).toBe('unavailable');
    expect(deriveMeetingId({ now: EVENING })).toBe('20260929');
    // The picture is still in the timer's hands, which is what makes "Copy
    // image" the destination that needs no network.
    expect(failed.blob).toBeInstanceOf(Blob);

    await endMeetingAndShare({ speeches: rows, fetchImpl: vi.fn(async () => shared()), createCanvas });
    expect(deriveMeetingId({ now: EVENING })).toBe('20260929-2');
  });

  it('says so rather than throwing when the network is gone', async () => {
    joinClub();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(endMeetingAndShare({ speeches: rows, fetchImpl, createCanvas })).resolves.toMatchObject({
      url: null,
      error: 'network',
    });
  });

  it('refuses to share at all without a club', async () => {
    const fetchImpl = vi.fn();

    const result = await endMeetingAndShare({ speeches: rows, fetchImpl, createCanvas });

    expect(result.error).toBe('no_club');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // The whole meeting, not this laptop's half of it
  // -------------------------------------------------------------------------

  /** A canvas that remembers every string it was asked to draw. */
  const recordingCanvas = (drawn) => (width, height) => {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext();
    return { ...canvas, getContext: () => ({ ...context, fillText: (text) => drawn.push(String(text)) }) };
  };

  const archived = (over = {}) => ({
    speechId: 'srv-1',
    name: 'Cara',
    role: 'Standard Speech',
    duration: '7:20',
    color: 'red',
    comments: '',
    disqualified: false,
    finishedAt: 3,
    ...over,
  });

  /** The club's copy for `/share`, and whatever the caller wants for `/`. */
  const archiveServer = (speeches) =>
    vi.fn(async (url) => {
      if (String(url).endsWith('/share')) return shared();
      return { ok: true, status: 200, json: async () => ({ meeting: { meetingId: '20260929', speeches } }) };
    });

  it('counts every device’s speeches, not only the ones on this Report tab', async () => {
    joinClub();
    // Three speeches in the club's archive; this device timed two of them.
    const server = [
      archived({ speechId: 'a', name: 'Alice', color: 'green' }),
      archived({ speechId: 'b', name: 'Bob', color: 'red' }),
      archived({ speechId: 'c', name: 'Cara', color: 'red' }),
    ];
    const local = [
      { ...speech({ name: 'Alice' }), speechId: 'a' },
      { ...speech({ name: 'Bob', color: 'red' }), speechId: 'b' },
    ];
    const drawn = [];

    const result = await endMeetingAndShare({
      speeches: local,
      fetchImpl: archiveServer(server),
      createCanvas: recordingCanvas(drawn),
    });

    // The web card used to say "2 speeches, 1 over time" for a meeting the
    // hosted page correctly reported as 3 · 2 over time.
    expect(result).toMatchObject({ speeches: 3, overtime: 2 });
    // And the picture listed only this device's two.
    expect(drawn).toContain('Cara');
  });

  it('keeps a speech the club has not received yet rather than dropping it', async () => {
    joinClub();
    const local = [
      { ...speech({ name: 'Alice' }), speechId: 'a' },
      { ...speech({ name: 'Dana' }), speechId: 'd' },
    ];

    const result = await endMeetingAndShare({
      speeches: local,
      fetchImpl: archiveServer([archived({ speechId: 'a', name: 'Alice', color: 'green' })]),
      createCanvas,
    });

    // One on the server, one still queued here: the meeting had two.
    expect(result.speeches).toBe(2);
  });

  it('falls back to this device’s rows when the archive cannot be read', async () => {
    joinClub();
    const fetchImpl = vi.fn(async (url) =>
      String(url).endsWith('/share') ? shared() : { ok: false, status: 404, json: async () => ({ error: 'not_found' }) }
    );

    const result = await endMeetingAndShare({ speeches: rows, fetchImpl, createCanvas });

    expect(result).toMatchObject({ speeches: 2, overtime: 1, error: null });
  });

  // -------------------------------------------------------------------------
  // Sharing the same meeting twice
  // -------------------------------------------------------------------------

  it('shares the same meeting again when nothing new has been timed', async () => {
    joinClub();
    const withIds = [
      { ...speech({ name: 'Alice' }), speechId: 'a' },
      { ...speech({ name: 'Bob', color: 'red' }), speechId: 'b' },
    ];
    const fetchImpl = archiveServer([]);

    const first = await endMeetingAndShare({ title: 'Contest', speeches: withIds, fetchImpl, createCanvas });
    expect(first.meetingId).toBe('20260929');
    expect(first.url).toBe('https://x/r/ABCDEFGHJKMNPQRS');

    // Closing the card and pressing the button again used to derive 20260929-2,
    // which has no speeches in it: 404, no link, and the title lost.
    const again = await endMeetingAndShare({ speeches: withIds, fetchImpl, createCanvas });

    expect(again.meetingId).toBe('20260929');
    expect(again.url).toBe(first.url);
    expect(again.token).toBe(first.token);
    // The title the meeting already has, rather than nothing.
    expect(again.title).toBe('Contest');
    // And the day's sequence moved once, for one meeting.
    expect(deriveMeetingId({ now: EVENING })).toBe('20260929-2');
  });

  it('starts a new meeting once something new has been timed', async () => {
    joinClub();
    const first = [{ ...speech({ name: 'Alice' }), speechId: 'a' }];
    const fetchImpl = archiveServer([]);

    await endMeetingAndShare({ speeches: first, fetchImpl, createCanvas });

    const second = await endMeetingAndShare({
      speeches: [...first, { ...speech({ name: 'Bob' }), speechId: 'b' }],
      fetchImpl,
      createCanvas,
    });

    expect(second.meetingId).toBe('20260929-2');
  });
});

// ---------------------------------------------------------------------------
// A queue that does not go out
// ---------------------------------------------------------------------------

describe('coming back to a queue that did not go out', () => {
  /** A request that neither resolves nor rejects — a connection that died asleep. */
  const hung = () => vi.fn(() => new Promise(() => {}));

  const shared = () => ({
    ok: true,
    status: 200,
    json: async () => ({ token: 'ABCDEFGHJKMNPQRS', url: 'https://x/r/ABCDEFGHJKMNPQRS' }),
  });

  it('abandons a request that never answers, and keeps the speech for later', async () => {
    joinClub();
    vi.useFakeTimers();
    vi.setSystemTime(EVENING);
    try {
      const stuck = hung();
      recordSpeech(speech(), { fetchImpl: stuck });
      const drain = drainOutbox({ fetchImpl: stuck });

      // Ten seconds, and the drain settles rather than holding the module's
      // `draining` promise — and with it every later drain — for ever.
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(drain).resolves.toMatchObject({ sent: 0, pending: 1 });

      // The speech is kept, and the next drain hands it over.
      await expect(drainOutbox({ fetchImpl: vi.fn(async () => ok()) })).resolves.toMatchObject({
        sent: 1,
        pending: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports why an upload did not go out', async () => {
    joinClub();
    vi.useFakeTimers();
    vi.setSystemTime(EVENING);
    const seen = [];
    setArchiveReporter((event, properties) => seen.push([event, properties]));
    try {
      recordSpeech(speech(), { fetchImpl: hung() });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(seen).toContainEqual(['club_upload_failed', { reason: 'timeout', pending: 1 }]);

      await drainOutbox({ fetchImpl: vi.fn(async () => serverError()) });
      expect(seen).toContainEqual(['club_upload_failed', { reason: 'http_5xx', pending: 1 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries on its own, without waiting for another FINISH', async () => {
    joinClub();
    vi.useFakeTimers();
    vi.setSystemTime(EVENING);
    try {
      let attempt = 0;
      const fetchImpl = vi.fn(async () => {
        attempt += 1;
        return attempt === 1 ? serverError() : ok();
      });

      recordSpeech(speech(), { fetchImpl });
      await vi.advanceTimersByTimeAsync(0);
      expect(outboxCount()).toBe(1);

      // Nothing happens here but the clock: no app start, no second speech.
      await vi.advanceTimersByTimeAsync(15_000);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(outboxCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains when the network comes back', async () => {
    joinClub();
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('Failed to fetch');
      return ok();
    });

    recordSpeech(speech(), { fetchImpl });
    await drainOutbox({ fetchImpl });
    expect(outboxCount()).toBe(1);

    window.dispatchEvent(new Event('online'));

    await vi.waitFor(() => expect(outboxCount()).toBe(0));
  });

  it('shares even while a drain is hung', async () => {
    joinClub();
    vi.useFakeTimers();
    vi.setSystemTime(EVENING);
    try {
      // The drain this FINISH fires never answers; the share awaits that same
      // promise, which is what used to leave the button saying "Saving…".
      recordSpeech(speech(), { fetchImpl: hung() });

      const share = endMeetingAndShare({
        speeches: [speech()],
        fetchImpl: vi.fn(async (url) => (String(url).endsWith('/share') ? shared() : ok())),
        createCanvas: (width, height) => ({
          width,
          height,
          getContext: () => ({
            fillRect: () => {}, fillText: () => {}, drawImage: () => {}, beginPath: () => {},
            closePath: () => {}, moveTo: () => {}, lineTo: () => {}, quadraticCurveTo: () => {},
            fill: () => {}, save: () => {}, restore: () => {},
            measureText: (text) => ({ width: String(text).length * 8 }),
          }),
          toBlob: (cb) => cb(new Blob(['png'], { type: 'image/png' })),
        }),
      });

      await vi.advanceTimersByTimeAsync(8_000);

      await expect(share).resolves.toMatchObject({ url: 'https://x/r/ABCDEFGHJKMNPQRS', error: null });
    } finally {
      vi.useRealTimers();
    }
  });
});
