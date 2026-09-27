import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  compactMeeting,
  handleClubMeetings,
  meetingKey,
  meetingSettled,
  parseMeetingId,
  speechKey,
} from './club-meetings.js';
import { handleClubActivate } from './club.js';
import { createClubFromPending, clubDeviceKey } from './club-admin.js';
import { verifyClubToken } from './club-token.js';
import { clubKey } from './entitlements.js';

/**
 * The archive, from the Worker's side.
 *
 * The two properties everything else rests on: an append is a pure `put` to a
 * key that has never existed — so a retry is free and two laptops never
 * collide — and compaction is idempotent, so running it twice costs nothing
 * and a speech that arrives after it is merged rather than lost.
 */

const SIGNING_KEY = 'test-session-signing-key';
const MEETING = '20260929';
/** Mid-meeting: 7pm Eastern on the 29th, which is already the 30th in UTC. */
const LIVE_NOW = Date.UTC(2026, 8, 29, 23, 0);
/**
 * Past the 38-hour settling window for 2026-09-29, and still inside the club
 * token's 24-hour life, so one activation covers both halves of a test.
 */
const SETTLED_NOW = Date.UTC(2026, 8, 30, 15, 0);

/**
 * A KV double that carries per-key metadata, because the History list is built
 * entirely out of it: without metadata on `list` this archive would need a
 * `get` per speech to count the over-times.
 */
function makeKv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, { value: typeof v === 'string' ? v : JSON.stringify(v), metadata: null }]));
  return {
    store,
    gets: 0,
    puts: 0,
    get: async function get(key, type) {
      this.gets += 1;
      const entry = store.get(key);
      if (entry === undefined) return null;
      return type === 'json' ? JSON.parse(entry.value) : entry.value;
    },
    put: async function put(key, value, options) {
      this.puts += 1;
      store.set(key, { value, metadata: options?.metadata ?? null });
    },
    delete: async (key) => { store.delete(key); },
    list: async ({ prefix = '' } = {}) => ({
      keys: [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entry]) => ({ name, ...(entry.metadata ? { metadata: entry.metadata } : {}) })),
      list_complete: true,
    }),
  };
}

let kv;
let env;

beforeEach(() => {
  kv = makeKv();
  env = { PROFILES: kv, SESSION_SIGNING_KEY: SIGNING_KEY, ENTITLEMENT_ENFORCE: '1' };
  // Every test times its speeches on the evening of 2026-09-29. The club token
  // is minted against this clock too, so a test that jumps forward has to land
  // inside the token's 24-hour life.
  vi.setSystemTime(LIVE_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Seed a club and activate one anonymous device on it. */
async function activated() {
  const { clubId } = await createClubFromPending(
    env,
    { clubName: 'Downtown Speakers', uid: 'buyer-uid' },
    { code: 'DTSP7K2QM9' }
  );
  const res = await handleClubActivate(
    new Request('https://x/api/club/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'DTSP-7K2QM9' }),
    }),
    env
  );
  const body = await res.json();
  return { clubId, clubToken: body.clubToken, deviceId: verifyClubToken(body.clubToken, SIGNING_KEY).deviceId };
}

const appendReq = (clubToken, meetingId, speech) =>
  new Request(`https://x/api/club/meetings/${meetingId}/speeches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(clubToken ? { 'x-club': clubToken } : {}) },
    body: JSON.stringify(speech),
  });

const readReq = (clubToken, path = '') =>
  new Request(`https://x/api/club/meetings${path}`, {
    headers: clubToken ? { 'x-club': clubToken } : {},
  });

const route = (path) => `meetings${path}`;

const speech = (over = {}) => ({
  speechId: 's1',
  name: 'Alice',
  role: 'Standard Speech',
  duration: '5:50',
  color: 'green',
  comments: '',
  disqualified: false,
  finishedAt: 1_000,
  ...over,
});

describe('meeting ids and the keys they imply', () => {
  it('reads a plain day and a second meeting on the same day', () => {
    expect(parseMeetingId('20260929')).toEqual({ date: '20260929', seq: 1 });
    expect(parseMeetingId('20260929-2')).toEqual({ date: '20260929', seq: 2 });
    expect(parseMeetingId('not-a-meeting')).toBeNull();
    expect(parseMeetingId('2026092')).toBeNull();
  });

  // The whole point of an inverted timestamp: list() is already in the order
  // History wants, so nothing has to be read to sort it.
  it('sorts newest-first by key name, with the day’s later meeting ahead of its first', () => {
    const keys = ['20260929', '20261001', '20260929-2', '20250101']
      .map((id) => meetingKey('club-1', id))
      .sort();
    expect(keys.map((key) => key.slice(key.lastIndexOf(':') + 1))).toEqual([
      '20261001',
      '20260929-2',
      '20260929',
      '20250101',
    ]);
  });

  // The Worker does not know the club's timezone here, so "the day is over" has
  // to be true in every zone before a meeting may be folded away.
  it('waits until the meeting’s day is over in every timezone before settling', () => {
    // 2026-09-29 ends at the latest at 2026-09-30T12:00Z, in UTC-12.
    expect(meetingSettled(MEETING, Date.UTC(2026, 8, 30, 11, 0))).toBe(false);
    expect(meetingSettled(MEETING, Date.UTC(2026, 8, 30, 23, 0))).toBe(true);
  });
});

describe('appending a speech', () => {
  it('never reads before it writes', async () => {
    const { clubToken, clubId } = await activated();
    const before = kv.gets;

    const res = await handleClubMeetings(appendReq(clubToken, MEETING, speech()), route(`/${MEETING}/speeches`), env);

    expect(res.status).toBe(200);
    // The speech key itself is never read: the reads are the device record and
    // the club record, both of which exist to refuse a revoked or lapsed club.
    expect(kv.gets - before).toBe(2);
    expect(kv.store.has(speechKey(clubId, MEETING, 's1'))).toBe(true);
  });

  it('is safe to send twice: the same bytes land on the same key', async () => {
    const { clubToken, clubId } = await activated();

    await handleClubMeetings(appendReq(clubToken, MEETING, speech()), route(`/${MEETING}/speeches`), env);
    const first = kv.store.get(speechKey(clubId, MEETING, 's1')).value;
    await handleClubMeetings(appendReq(clubToken, MEETING, speech()), route(`/${MEETING}/speeches`), env);

    expect(kv.store.get(speechKey(clubId, MEETING, 's1')).value).toBe(first);
    expect([...kv.store.keys()].filter((k) => k.startsWith('speech:'))).toHaveLength(1);
  });

  it('stores whether the speech ran over on the key, so a live count needs no gets', async () => {
    const { clubToken, clubId } = await activated();

    await handleClubMeetings(
      appendReq(clubToken, MEETING, speech({ speechId: 's2', color: 'red' })),
      route(`/${MEETING}/speeches`),
      env
    );

    expect(kv.store.get(speechKey(clubId, MEETING, 's2')).metadata.overtime).toBe(true);
  });

  it('refuses a speech with no usable id, rather than inventing one', async () => {
    const { clubToken } = await activated();

    const res = await handleClubMeetings(
      appendReq(clubToken, MEETING, speech({ speechId: '' })),
      route(`/${MEETING}/speeches`),
      env
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_speech_id');
  });

  it('refuses a meetingId that is not one we mint', async () => {
    const { clubToken } = await activated();

    const res = await handleClubMeetings(appendReq(clubToken, 'tuesday', speech()), route('/tuesday/speeches'), env);

    expect(res.status).toBe(400);
  });

  it('turns away a request with no club at all', async () => {
    const res = await handleClubMeetings(appendReq(null, MEETING, speech()), route(`/${MEETING}/speeches`), env);
    expect(res.status).toBe(401);
  });

  // Revocation has to bite on the write path, because the token itself is
  // HMAC-only and nothing reads state to verify it.
  it('refuses a revoked device on append but still lets it read', async () => {
    const { clubToken, clubId, deviceId } = await activated();
    await handleClubMeetings(appendReq(clubToken, MEETING, speech()), route(`/${MEETING}/speeches`), env);

    const device = await kv.get(clubDeviceKey(clubId, deviceId), 'json');
    await kv.put(clubDeviceKey(clubId, deviceId), JSON.stringify({ ...device, revokedAt: 1 }));

    const append = await handleClubMeetings(
      appendReq(clubToken, MEETING, speech({ speechId: 's2' })),
      route(`/${MEETING}/speeches`),
      env
    );
    expect(append.status).toBe(403);

    const read = await handleClubMeetings(readReq(clubToken, `/${MEETING}`), route(`/${MEETING}`), env);
    expect(read.status).toBe(200);
    expect((await read.json()).meeting.speeches).toHaveLength(1);
  });

  // A club that stopped paying stops accumulating storage. Same rule the
  // presets route already runs.
  it('refuses an append once the club has lapsed', async () => {
    const { clubToken, clubId } = await activated();
    const club = await kv.get(clubKey(clubId), 'json');
    await kv.put(clubKey(clubId), JSON.stringify({ ...club, status: 'canceled', currentPeriodEnd: 1 }));

    const res = await handleClubMeetings(appendReq(clubToken, MEETING, speech()), route(`/${MEETING}/speeches`), env);

    expect(res.status).toBe(402);
  });
});

describe('compaction', () => {
  it('folds the speeches into one key, writes the counts into metadata, and deletes them', async () => {
    const { clubToken, clubId } = await activated();
    for (const [id, over] of [['s1', {}], ['s2', { color: 'red', finishedAt: 2_000 }], ['s3', { finishedAt: 500 }]]) {
      // eslint-disable-next-line no-await-in-loop
      await handleClubMeetings(
        appendReq(clubToken, MEETING, speech({ speechId: id, ...over })),
        route(`/${MEETING}/speeches`),
        env
      );
    }

    const record = await compactMeeting(env, clubId, MEETING, { now: SETTLED_NOW });

    expect(record.speeches.map((s) => s.speechId)).toEqual(['s3', 's1', 's2']);
    expect([...kv.store.keys()].filter((k) => k.startsWith('speech:'))).toEqual([]);
    const header = kv.store.get(meetingKey(clubId, MEETING));
    expect(header.metadata).toMatchObject({ meetingId: MEETING, date: '2026-09-29', speeches: 3, overtime: 1 });
  });

  it('is a no-op the second time', async () => {
    const { clubToken, clubId } = await activated();
    await handleClubMeetings(appendReq(clubToken, MEETING, speech()), route(`/${MEETING}/speeches`), env);
    await compactMeeting(env, clubId, MEETING, { now: SETTLED_NOW });

    const puts = kv.puts;
    const again = await compactMeeting(env, clubId, MEETING, { now: SETTLED_NOW + 1 });

    expect(kv.puts).toBe(puts);
    expect(again.speeches).toHaveLength(1);
  });

  // The laptop that was offline all evening, draining its outbox the next day.
  it('merges a speech that arrives after the meeting was folded', async () => {
    const { clubToken, clubId } = await activated();
    await handleClubMeetings(appendReq(clubToken, MEETING, speech()), route(`/${MEETING}/speeches`), env);
    await compactMeeting(env, clubId, MEETING, { now: SETTLED_NOW });

    await handleClubMeetings(
      appendReq(clubToken, MEETING, speech({ speechId: 'late', finishedAt: 3_000 })),
      route(`/${MEETING}/speeches`),
      env
    );
    const record = await compactMeeting(env, clubId, MEETING, { now: SETTLED_NOW });

    expect(record.speeches.map((s) => s.speechId)).toEqual(['s1', 'late']);
  });

  it('answers null for a meeting that never happened', async () => {
    const { clubId } = await activated();
    expect(await compactMeeting(env, clubId, '20200101', { now: SETTLED_NOW })).toBeNull();
  });
});

describe('reading the archive back', () => {
  it('lists a live meeting from its speech keys alone, with no header yet', async () => {
    const { clubToken, clubId } = await activated();
    await handleClubMeetings(appendReq(clubToken, MEETING, speech()), route(`/${MEETING}/speeches`), env);
    await handleClubMeetings(
      appendReq(clubToken, MEETING, speech({ speechId: 's2', color: 'red' })),
      route(`/${MEETING}/speeches`),
      env
    );

    const res = await handleClubMeetings(readReq(clubToken), route(''), env);
    const { meetings } = await res.json();

    expect(meetings).toEqual([
      { meetingId: MEETING, date: '2026-09-29', title: null, speeches: 2, overtime: 1, live: true },
    ]);
    expect(kv.store.has(meetingKey(clubId, MEETING))).toBe(false);
  });

  it('folds a meeting whose day has passed on the way past, then serves it from metadata', async () => {
    const { clubToken, clubId } = await activated();
    await handleClubMeetings(appendReq(clubToken, MEETING, speech()), route(`/${MEETING}/speeches`), env);

    vi.setSystemTime(SETTLED_NOW);
    const res = await handleClubMeetings(readReq(clubToken), route(''), env);
    const { meetings } = await res.json();

    expect(meetings).toEqual([
      { meetingId: MEETING, date: '2026-09-29', title: null, speeches: 1, overtime: 0, live: false },
    ]);
    expect(kv.store.has(meetingKey(clubId, MEETING))).toBe(true);
    expect([...kv.store.keys()].filter((k) => k.startsWith('speech:'))).toEqual([]);
  });

  it('returns meetings newest first', async () => {
    vi.setSystemTime(SETTLED_NOW);
    const { clubToken, clubId } = await activated();
    for (const id of ['20260901', '20260929', '20260915']) {
      // eslint-disable-next-line no-await-in-loop
      await handleClubMeetings(appendReq(clubToken, id, speech()), route(`/${id}/speeches`), env);
      // eslint-disable-next-line no-await-in-loop
      await compactMeeting(env, clubId, id, { now: SETTLED_NOW });
    }

    const res = await handleClubMeetings(readReq(clubToken), route(''), env);

    expect((await res.json()).meetings.map((m) => m.meetingId)).toEqual(['20260929', '20260915', '20260901']);
  });

  it('serves one meeting with every speech in it', async () => {
    const { clubToken } = await activated();
    await handleClubMeetings(
      appendReq(clubToken, MEETING, speech({ speechId: 'b', finishedAt: 2_000, name: 'Bob' })),
      route(`/${MEETING}/speeches`),
      env
    );
    await handleClubMeetings(
      appendReq(clubToken, MEETING, speech({ speechId: 'a', finishedAt: 1_000, name: 'Alice' })),
      route(`/${MEETING}/speeches`),
      env
    );

    const res = await handleClubMeetings(readReq(clubToken, `/${MEETING}`), route(`/${MEETING}`), env);
    const { meeting } = await res.json();

    expect(meeting.meetingId).toBe(MEETING);
    expect(meeting.date).toBe('2026-09-29');
    expect(meeting.speeches.map((s) => s.name)).toEqual(['Alice', 'Bob']);
  });

  // Folding a meeting somebody else is still timing would end it for them.
  it('does not fold a meeting that is still live when it is read', async () => {
    const { clubToken, clubId } = await activated();
    await handleClubMeetings(appendReq(clubToken, MEETING, speech()), route(`/${MEETING}/speeches`), env);

    await handleClubMeetings(readReq(clubToken, `/${MEETING}`), route(`/${MEETING}`), env);

    expect([...kv.store.keys()].filter((k) => k.startsWith('speech:'))).toHaveLength(1);
  });

  it('404s a meeting the club never held', async () => {
    const { clubToken } = await activated();
    const res = await handleClubMeetings(readReq(clubToken, '/20200101'), route('/20200101'), env);
    expect(res.status).toBe(404);
  });

  it('turns away a read with no club token', async () => {
    const res = await handleClubMeetings(readReq(null), route(''), env);
    expect(res.status).toBe(401);
  });

  // One club's archive is not another's, and the key prefix is the only thing
  // standing between them.
  it('never shows one club another club’s meetings', async () => {
    vi.setSystemTime(SETTLED_NOW);
    const first = await activated();
    await handleClubMeetings(appendReq(first.clubToken, MEETING, speech()), route(`/${MEETING}/speeches`), env);

    const { clubId: otherId } = await createClubFromPending(env, { clubName: 'Uptown' }, { code: 'UPTN000001' });
    const otherRes = await handleClubActivate(
      new Request('https://x/api/club/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'UPTN-000001' }),
      }),
      env
    );
    const { clubToken: otherToken } = await otherRes.json();
    expect(otherId).not.toBe(first.clubId);

    const res = await handleClubMeetings(readReq(otherToken), route(''), env);

    expect((await res.json()).meetings).toEqual([]);
  });
});
