import { readClub } from './auth.js';
import { json, methodNotAllowed, unauthorized } from './http.js';
import { entitlementStore, readClubRecord, resolveAccess } from './entitlements.js';
import { verifiedClubId } from './club.js';
import { shareMeeting } from './club-share.js';

/**
 * The club's archive: every finished speech, as it happens.
 *
 * Two shapes, one meeting. While a meeting is live it is fanned out into one
 * key per speech, because that is what makes auto-save a single `put` to a key
 * that has never existed — no read, no merge, no contention, so a retry after a
 * flaky network rewrites the same bytes and two laptops timing the same evening
 * both land without coordinating. When the meeting closes it is folded back
 * into one key, because that is what makes browsing cheap: every meeting in
 * History is a single-key read, and only the one live meeting is ever fanned
 * out.
 *
 *   meeting:<clubId>:<invTs>:<meetingId>     { title, date, startedAt, speeches? }
 *      ↳ KV metadata                         { speeches, overtime, title }
 *   speech:<clubId>:<meetingId>:<speechId>   { name, role, duration, color,
 *                                              comments, disqualified, finishedAt }
 *      ↳ KV metadata                         { overtime }
 *
 * The speech keys carry their own metadata so the History list can count a
 * *live* meeting — speeches and over-times both — from the `list` it was
 * already doing, with no `get` per speech.
 */

export const speechKey = (clubId, meetingId, speechId) => `speech:${clubId}:${meetingId}:${speechId}`;
export const speechPrefix = (clubId, meetingId) => `speech:${clubId}:${meetingId}:`;
export const meetingPrefix = (clubId) => `meeting:${clubId}:`;

/** No club meets more than a handful of times a day, and 999 is plenty of room. */
const MAX_SEQ = 999;
/** Eight digits: 99999999 - YYYYMMDD never goes negative and never changes width. */
const DATE_CEILING = 99999999;

/**
 * Split `20260929-2` into its date and its sequence.
 *
 * @returns {{date: string, seq: number}|null} null when it is not a meetingId
 */
export function parseMeetingId(meetingId) {
  const match = /^(\d{8})(?:-(\d{1,3}))?$/.exec(String(meetingId ?? ''));
  if (!match) return null;
  const seq = match[2] ? Number(match[2]) : 1;
  if (seq < 1 || seq > MAX_SEQ) return null;
  return { date: match[1], seq };
}

/**
 * The key a meeting's header lives at — derived, never looked up.
 *
 * `invTs` is an inverted timestamp, so `list({prefix: 'meeting:<clubId>:'})`
 * comes back newest-first with no sorting. Deriving the whole key from the
 * meetingId is what lets an append, a compaction and a read all agree on where
 * a meeting lives without any of them reading first.
 *
 * @returns {string|null} null when the meetingId is not one we minted
 */
export function meetingKey(clubId, meetingId) {
  const parsed = parseMeetingId(meetingId);
  if (!parsed) return null;
  const invDate = String(DATE_CEILING - Number(parsed.date)).padStart(8, '0');
  // The second meeting of a day is the later one, so it has to sort first.
  const invSeq = String(MAX_SEQ + 1 - parsed.seq).padStart(3, '0');
  return `meeting:${clubId}:${invDate}-${invSeq}:${meetingId}`;
}

/** The date a meetingId names, as `YYYY-MM-DD`, for display. */
export function meetingDate(meetingId) {
  const parsed = parseMeetingId(meetingId);
  if (!parsed) return null;
  return `${parsed.date.slice(0, 4)}-${parsed.date.slice(4, 6)}-${parsed.date.slice(6, 8)}`;
}

/**
 * How long after a meeting's UTC midnight its calendar day is over *everywhere*.
 *
 * The Worker does not know the club's timezone here and must not guess: a
 * meeting dated the 29th ends at the latest at 29T24:00 in UTC-12, which is
 * 30T12:00Z — 36 hours after the date's UTC midnight. Two hours of slack on top
 * of that, and a meeting is only ever compacted once nobody anywhere can still
 * be timing it.
 */
const MEETING_SETTLED_MS = 38 * 60 * 60 * 1000;

/** Whether this meeting's day is definitively over in every timezone. */
export function meetingSettled(meetingId, now = Date.now()) {
  const parsed = parseMeetingId(meetingId);
  if (!parsed) return false;
  const midnight = Date.UTC(
    Number(parsed.date.slice(0, 4)),
    Number(parsed.date.slice(4, 6)) - 1,
    Number(parsed.date.slice(6, 8))
  );
  return now - midnight >= MEETING_SETTLED_MS;
}

/** Every key under a prefix, following the cursor. */
async function listAll(store, prefix) {
  const keys = [];
  let cursor;
  do {
    // eslint-disable-next-line no-await-in-loop
    const listed = await store.list({ prefix, cursor });
    keys.push(...(listed.keys ?? []));
    cursor = listed.list_complete === false ? listed.cursor : undefined;
  } while (cursor);
  return keys;
}

/** Everything a stored speech is allowed to be, and nothing else. */
function normalizeSpeech(raw, speechId) {
  return {
    speechId,
    name: String(raw?.name ?? ''),
    role: String(raw?.role ?? ''),
    duration: String(raw?.duration ?? ''),
    color: String(raw?.color ?? ''),
    comments: String(raw?.comments ?? ''),
    disqualified: raw?.disqualified === true,
    finishedAt: typeof raw?.finishedAt === 'number' ? raw.finishedAt : 0,
  };
}

const byFinishedAt = (a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0) || String(a.speechId).localeCompare(String(b.speechId));

/**
 * Fold a meeting's speech keys into its header and delete them.
 *
 * Runs on "End meeting", and lazily on the first read after the meeting's date
 * has passed. Idempotent by construction: with no speech keys left there is
 * nothing to fold, so a second compaction writes nothing and deletes nothing.
 *
 * A speech that arrives late — a laptop that was offline all evening draining
 * its outbox the next morning — lands as a fresh key and is merged into the
 * already-compacted header by `speechId` on the next compaction, rather than
 * replacing the speeches that were already there.
 *
 * @param {Object} env
 * @param {string} clubId
 * @param {string} meetingId
 * @param {{now?: number}} [options]
 * @returns {Promise<Object|null>} the compacted meeting, or null when there was none
 */
export async function compactMeeting(env, clubId, meetingId, { now = Date.now() } = {}) {
  const store = entitlementStore(env);
  const key = meetingKey(clubId, meetingId);
  if (!store || !key) return null;

  const [header, speechKeys] = await Promise.all([
    store.get(key, 'json').catch(() => null),
    listAll(store, speechPrefix(clubId, meetingId)),
  ]);

  // Nothing fanned out: either already compacted, or never existed. Either way
  // this is a no-op, which is what makes a second compaction free.
  if (!speechKeys.length) return header ?? null;

  const loose = await Promise.all(
    speechKeys.map(async (entry) => {
      const raw = await store.get(entry.name, 'json').catch(() => null);
      return raw ? normalizeSpeech(raw, entry.name.slice(speechPrefix(clubId, meetingId).length)) : null;
    })
  );

  const merged = new Map();
  for (const speech of Array.isArray(header?.speeches) ? header.speeches : []) {
    merged.set(speech.speechId, speech);
  }
  for (const speech of loose) {
    if (speech) merged.set(speech.speechId, speech);
  }

  const speeches = [...merged.values()].sort(byFinishedAt);
  const record = {
    title: header?.title ?? null,
    date: meetingDate(meetingId),
    startedAt: header?.startedAt ?? speeches[0]?.finishedAt ?? now,
    endedAt: speeches[speeches.length - 1]?.finishedAt ?? now,
    compactedAt: now,
    speeches,
  };

  await store.put(key, JSON.stringify(record), { metadata: meetingMetadata(meetingId, record) });
  // Only after the header is safely written: a crash between the two leaves the
  // speeches fanned out and the next compaction folds them again.
  await Promise.all(speechKeys.map((entry) => store.delete(entry.name)));

  return record;
}

/** The counts the History list renders from, without reading the body. */
function meetingMetadata(meetingId, record) {
  return {
    meetingId,
    date: record.date,
    title: record.title ?? null,
    speeches: record.speeches.length,
    overtime: record.speeches.filter((speech) => speech.color === 'red' || speech.disqualified).length,
  };
}

/** Whether a speech ran over. Stored on the key so a live count needs no gets. */
const isOvertime = (speech) => speech.color === 'red' || speech.disqualified === true;

/**
 * POST /api/club/meetings/<meetingId>/speeches — a finished speech arrives.
 *
 * No session required, and that is the point: whoever is timing on a borrowed
 * laptop at 6:55pm has no Zoom identity, and their speeches still belong to the
 * club. The device record is read so a revoked device stops appending (and
 * stops consuming the club's storage) on its very next request rather than
 * whenever its cached token happens to expire.
 */
export async function appendSpeech(request, env, meetingId) {
  if (request.method !== 'POST') return methodNotAllowed();

  const claims = readClub(request, env);
  if (!claims) return unauthorized();
  if (!parseMeetingId(meetingId)) return json({ error: 'invalid_meeting' }, 400);

  const store = entitlementStore(env);
  if (!store) return json({ error: 'Club storage is not configured' }, 503);

  const clubId = await verifiedClubId(env, claims);
  if (!clubId) return json({ error: 'forbidden' }, 403);

  // A lapsed club stops accumulating storage. One extra read on a path that was
  // already writing, and it costs nothing for the uid: resolveAccess with no
  // uid short-circuits before it touches KV.
  const club = await readClubRecord(env, clubId);
  if (!club) return json({ error: 'club_not_found' }, 404);
  const access = await resolveAccess(env, { clubId, club });
  if (!access.entitled) return json({ error: 'upgrade_required', entitlement: access }, 402);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const speechId = typeof body?.speechId === 'string' ? body.speechId.trim() : '';
  // The id is the device's, and it is what makes this a pure append. Without a
  // usable one there is no key to write to, and inventing one here would turn a
  // retry into a duplicate.
  if (!speechId || speechId.length > 64 || /[^A-Za-z0-9._-]/.test(speechId)) {
    return json({ error: 'invalid_speech_id' }, 400);
  }

  const speech = normalizeSpeech(body, speechId);
  // No get, no merge: the same bytes land on the same key however many times
  // the outbox retries.
  await store.put(speechKey(clubId, meetingId, speechId), JSON.stringify(speech), {
    metadata: { finishedAt: speech.finishedAt, overtime: isOvertime(speech) },
  });

  return json({ ok: true, meetingId, speechId });
}

/**
 * GET /api/club/meetings — the History list.
 *
 * Two `list` calls and no `get`: compacted meetings answer from the header's
 * metadata, and the one live meeting is counted from its speech keys' metadata.
 * Any meeting still fanned out whose day is over everywhere is compacted on the
 * way past, which is the lazy half of "compaction runs on End meeting, or on
 * the first read after its date has passed".
 */
export async function listMeetings(request, env) {
  if (request.method !== 'GET') return methodNotAllowed();

  // HMAC only, no device read: this is a read of a club the device was already
  // reading, and the token's 24-hour life is what bounds it.
  const claims = readClub(request, env);
  if (!claims) return unauthorized();

  const store = entitlementStore(env);
  if (!store) return json({ error: 'Club storage is not configured' }, 503);

  const { clubId } = claims;
  const now = Date.now();

  const looseKeys = await listAll(store, `speech:${clubId}:`);
  const live = new Map();
  for (const entry of looseKeys) {
    const rest = entry.name.slice(`speech:${clubId}:`.length);
    const at = rest.indexOf(':');
    if (at <= 0) continue;
    const meetingId = rest.slice(0, at);
    const current = live.get(meetingId) ?? { speeches: 0, overtime: 0 };
    current.speeches += 1;
    if (entry.metadata?.overtime) current.overtime += 1;
    live.set(meetingId, current);
  }

  // Fold away anything that can no longer be receiving speeches, so it is a
  // single-key read from here on.
  for (const meetingId of [...live.keys()]) {
    if (!meetingSettled(meetingId, now)) continue;
    // eslint-disable-next-line no-await-in-loop
    await compactMeeting(env, clubId, meetingId, { now });
    live.delete(meetingId);
  }

  const headers = await listAll(store, meetingPrefix(clubId));
  const meetings = [];
  const seen = new Set();
  for (const entry of headers) {
    const meetingId = entry.name.slice(entry.name.lastIndexOf(':') + 1);
    if (seen.has(meetingId)) continue;
    seen.add(meetingId);
    const meta = entry.metadata ?? {};
    const pending = live.get(meetingId);
    live.delete(meetingId);
    meetings.push({
      meetingId,
      date: meta.date ?? meetingDate(meetingId),
      title: meta.title ?? null,
      speeches: (Number(meta.speeches) || 0) + (pending?.speeches ?? 0),
      overtime: (Number(meta.overtime) || 0) + (pending?.overtime ?? 0),
      live: Boolean(pending),
    });
  }

  // A meeting still in progress has no header key yet — the header is written
  // by compaction, so that an append stays one `put` with nothing read first.
  for (const [meetingId, counts] of live) {
    meetings.push({
      meetingId,
      date: meetingDate(meetingId),
      title: null,
      speeches: counts.speeches,
      overtime: counts.overtime,
      live: true,
    });
  }

  // The header keys already come back newest-first; re-sorting puts the live
  // meeting, which has no key to sort by, in its place among them.
  meetings.sort((a, b) => String(b.meetingId).localeCompare(String(a.meetingId)));

  return json({ meetings });
}

/**
 * GET /api/club/meetings/<meetingId> — one meeting, with every speech in it.
 *
 * Compacts on the way past when the meeting's day is over, so the second read
 * of the same meeting is a single key.
 */
export async function readMeeting(request, env, meetingId) {
  if (request.method !== 'GET') return methodNotAllowed();

  const claims = readClub(request, env);
  if (!claims) return unauthorized();
  if (!parseMeetingId(meetingId)) return json({ error: 'invalid_meeting' }, 400);

  const store = entitlementStore(env);
  if (!store) return json({ error: 'Club storage is not configured' }, 503);

  const { clubId } = claims;
  const now = Date.now();

  if (meetingSettled(meetingId, now)) {
    const compacted = await compactMeeting(env, clubId, meetingId, { now });
    if (!compacted) return json({ error: 'not_found' }, 404);
    return json({ meeting: { meetingId, ...compacted } });
  }

  // A live meeting is read where it lives, without being folded: folding it
  // would end the meeting for every other device still timing it.
  const [header, speechKeys] = await Promise.all([
    store.get(meetingKey(clubId, meetingId), 'json').catch(() => null),
    listAll(store, speechPrefix(clubId, meetingId)),
  ]);
  if (!header && !speechKeys.length) return json({ error: 'not_found' }, 404);

  const loose = await Promise.all(
    speechKeys.map(async (entry) => {
      const raw = await store.get(entry.name, 'json').catch(() => null);
      return raw ? normalizeSpeech(raw, entry.name.slice(speechPrefix(clubId, meetingId).length)) : null;
    })
  );

  const merged = new Map();
  for (const speech of Array.isArray(header?.speeches) ? header.speeches : []) merged.set(speech.speechId, speech);
  for (const speech of loose) if (speech) merged.set(speech.speechId, speech);

  return json({
    meeting: {
      meetingId,
      title: header?.title ?? null,
      date: meetingDate(meetingId),
      startedAt: header?.startedAt ?? null,
      live: speechKeys.length > 0,
      speeches: [...merged.values()].sort(byFinishedAt),
    },
  });
}

/**
 * Dispatch for /api/club/meetings and everything under it.
 *
 * @param {Request} request
 * @param {string} route - the path after `/api/club/`, e.g. `meetings/20260929/speeches`
 * @param {Object} env
 */
export function handleClubMeetings(request, route, env) {
  const rest = route.slice('meetings'.length).replace(/^\/+|\/+$/g, '');
  if (rest === '') return listMeetings(request, env);

  const [meetingId, tail, ...extra] = rest.split('/');
  if (extra.length) return json({ error: 'Not found' }, 404);
  if (!tail) return readMeeting(request, env, decodeURIComponent(meetingId));
  if (tail === 'speeches') return appendSpeech(request, env, decodeURIComponent(meetingId));
  // "End meeting & share": closes the record and gives it a public address.
  if (tail === 'share') return shareMeeting(request, env, decodeURIComponent(meetingId));
  return json({ error: 'Not found' }, 404);
}
