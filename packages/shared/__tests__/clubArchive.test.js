import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CLUB_OUTBOX_STORAGE_KEY,
  MEETING_SEQ_STORAGE_KEY,
  clubDateString,
  deriveMeetingId,
  drainOutbox,
  fetchHistory,
  fetchMeeting,
  meetingDate,
  outboxCount,
  outboxPending,
  readOutbox,
  recordSpeech,
  resetClubArchiveForTests,
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
