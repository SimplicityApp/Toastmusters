import crypto from 'node:crypto';
import { readSession, exchangeZoomCode } from './auth.js';
import { json, methodNotAllowed, notConfigured, notFound, unauthorized } from './http.js';
import { flagEnabled } from './flags.js';
import { isShareToken } from './club-share.js';
import { capturePostHogEvent } from './posthog.js';
import { askRoom, ownerHashFor, roomFor } from './polls.js';

/**
 * The native Zoom poll (#80, part B): the host's app poll as a Zoom poll on a
 * scheduled meeting, with its answers collected after the meeting ends.
 *
 *   POST /api/polls/zoom   session, owner: {code, codeVerifier, meetingId, pollId}
 *
 * The code comes from zoomSdk.authorize (PKCE, as in contact.js). The access
 * token creates the poll; the refresh token is the one Zoom credential this
 * Worker ever keeps: AES-256-GCM under a key derived from SESSION_SIGNING_KEY,
 * only inside that poll's PollRoom, never in KV or a log, and deleted once the
 * answers are in, after the last retry, or 24 hours after creation, whichever
 * comes first (poll-room.js).
 *
 *   zoom-poll-by-meeting:<numericId>   pollId, TTL 24 h   ← meeting.ended finds the room
 */

const ZOOM_API = 'https://api.zoom.us/v2';
const ZOOM_TOKEN_URL = 'https://zoom.us/oauth/token';
const HKDF_INFO = 'toastmusters/zoom-poll-refresh/v1';
const DAY_SECONDS = 24 * 60 * 60;

export const zoomPollByMeetingKey = (numericId) => `zoom-poll-by-meeting:${numericId}`;

// ---------------------------------------------------------------------------
// The refresh token at rest
// ---------------------------------------------------------------------------

/** A key of its own, so the token is never encrypted under the session signing key itself. */
const tokenKey = (env) => Buffer.from(crypto.hkdfSync('sha256', env.SESSION_SIGNING_KEY, '', HKDF_INFO, 32));

/** `iv.ciphertext.tag`, base64url, bound to its poll so it cannot be moved to another room. */
export function encryptRefreshToken(token, env, pollId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenKey(env), iv);
  cipher.setAAD(Buffer.from(pollId));
  const sealed = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, sealed, cipher.getAuthTag()].map((b) => b.toString('base64url')).join('.');
}

/** The token, or null when it does not open (a rotated signing key orphans it, by design). */
export function decryptRefreshToken(value, env, pollId) {
  try {
    const [iv, sealed, tag] = String(value).split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', tokenKey(env), iv);
    decipher.setAAD(Buffer.from(pollId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(sealed), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Zoom REST
// ---------------------------------------------------------------------------

/** A refresh: {accessToken, refreshToken} or null. The rotated token is the caller's to drop. */
export async function refreshZoomToken(env, refreshToken) {
  const basic = Buffer.from(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(ZOOM_TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  });
  if (!res.ok) {
    console.error('Zoom token refresh failed:', res.status);
    return null;
  }
  const tokens = await res.json();
  if (typeof tokens?.access_token !== 'string' || !tokens.access_token) return null;
  return { accessToken: tokens.access_token, refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null };
}

/** Zoom's rule for a meeting UUID in a path: double-encode one that starts with "/" or contains "//". */
export function encodeMeetingUuid(uuid) {
  const value = String(uuid ?? '');
  return value.startsWith('/') || value.includes('//') ? encodeURIComponent(encodeURIComponent(value)) : encodeURIComponent(value);
}

const questionName = (category) => category.label || category.role;

/**
 * GET /past_meetings/{uuid}/polls, folded into counts per question and answer.
 * Who answered what stays with Zoom. Null when there is nothing yet (an empty
 * answer or a 404), which is what the retries are for.
 *
 * @returns {Promise<{questions: Array<{name: string, answers: Object<string, number>}>}|null>}
 */
export async function fetchPastPollAnswers(accessToken, uuid, ballot) {
  const res = await fetch(`${ZOOM_API}/past_meetings/${encodeMeetingUuid(uuid)}/polls`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const rows = Array.isArray(body?.questions) ? body.questions : [];

  // In ballot order, so the owner's client can line the answers up with its categories.
  const questions = (ballot?.categories ?? []).map((category) => ({ name: questionName(category), answers: {} }));
  const byName = new Map(questions.map((q) => [q.name, q]));
  let answered = 0;
  for (const row of rows) {
    for (const detail of Array.isArray(row?.question_details) ? row.question_details : []) {
      const name = String(detail?.question ?? '');
      const pick = String(detail?.answer ?? '');
      if (!name || !pick) continue;
      if (!byName.has(name)) {
        const extra = { name, answers: {} };
        questions.push(extra);
        byName.set(name, extra);
      }
      const answers = byName.get(name).answers;
      answers[pick] = (answers[pick] ?? 0) + 1;
      answered += 1;
    }
  }
  return answered ? { questions } : null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const readBody = async (request) => {
  try {
    return await request.json();
  } catch {
    return null;
  }
};

/** POST /api/polls/zoom — make the owner's open poll a native Zoom poll. */
export async function handleZoomPollCreate(request, env, ctx) {
  if (request.method !== 'POST') return methodNotAllowed();
  const session = readSession(request, env);
  if (!session?.uid) return unauthorized();
  if (!(await flagEnabled(env, 'polls_zoom', { uid: session.uid }, ctx))) return notFound();

  const body = await readBody(request);
  const code = typeof body?.code === 'string' ? body.code : '';
  const codeVerifier = typeof body?.codeVerifier === 'string' ? body.codeVerifier : body?.verifier;
  const meetingId = String(body?.meetingId ?? '').replace(/\s+/g, '');
  const pollId = body?.pollId;
  if (!code || typeof codeVerifier !== 'string' || !codeVerifier || !/^\d{9,12}$/.test(meetingId) || !isShareToken(pollId)) {
    return json({ error: 'Bad request' }, 400);
  }
  if (!env.POLL_ROOM) return notConfigured('Poll storage');
  if (!env.ZOOM_CLIENT_ID || !env.ZOOM_CLIENT_SECRET || !env.ZOOM_APP_HOME_URL || !env.SESSION_SIGNING_KEY) {
    return notConfigured('Zoom authorization');
  }

  const room = roomFor(env, pollId);
  const ownerHash = ownerHashFor(env, pollId, session.uid);
  // Before the code is spent: only the owner's open poll can become a Zoom poll.
  const results = await askRoom(room, { op: 'results', ownerHash });
  if (results.status !== 200) return json(results.body, results.status);
  if (results.body.status !== 'open') return json({ error: 'closed' }, 409);
  const { body: poll } = await askRoom(room, { op: 'ballot' });

  let tokens;
  try {
    tokens = await exchangeZoomCode(env, code, env.ZOOM_APP_HOME_URL, { codeVerifier, returnRefreshToken: true });
  } catch (error) {
    console.error('Zoom poll exchange failed:', error?.message || error);
    return json({ error: 'exchange' }, 502);
  }
  if (!tokens.ok) return json({ error: 'exchange' }, 502);
  const auth = { Authorization: `Bearer ${tokens.accessToken}` };

  const meetingRes = await fetch(`${ZOOM_API}/meetings/${meetingId}`, { headers: auth });
  if (!meetingRes.ok) return json({ error: 'meeting', status: meetingRes.status }, 502);
  const meeting = await meetingRes.json();
  // Zoom allows polls on scheduled meetings only.
  if (Number(meeting?.type) === 1) {
    return json({ error: 'instant_meeting', message: 'Zoom polls only work on scheduled meetings, not instant meetings.' }, 409);
  }

  const created = await fetch(`${ZOOM_API}/meetings/${meetingId}/polls`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Meeting vote',
      questions: poll.ballot.categories.filter((category) => category.candidates.length).map((category) => ({
        name: questionName(category),
        type: 'single',
        answers: category.candidates,
      })),
    }),
  });
  if (!created.ok) return json({ error: 'zoom_poll', status: created.status }, 502);
  const zoomPoll = await created.json().catch(() => ({}));

  if (tokens.refreshToken) {
    await askRoom(room, {
      op: 'zoomAttach',
      ownerHash,
      token: encryptRefreshToken(tokens.refreshToken, env, pollId),
      numericId: meetingId,
      uuid: typeof meeting?.uuid === 'string' ? meeting.uuid : null,
    });
    await env.PROFILES?.put(zoomPollByMeetingKey(meetingId), pollId, { expirationTtl: DAY_SECONDS });
  }

  const capture = capturePostHogEvent(env, 'zoom_poll_created', {
    distinct_id: 'polls',
    $process_person_profile: false,
    questions: poll.ballot.categories.length,
  });
  if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(capture);
  return json({ ok: true, zoomPollId: zoomPoll?.id ?? null }, 201);
}

/**
 * meeting.ended, from zoom-webhook.js: tell the native poll's room, if this
 * meeting has one. Called inside ctx.waitUntil, so the webhook's 3 s answer
 * never waits for it.
 */
export async function notifyMeetingEnded(env, object) {
  const numericId = String(object?.id ?? '');
  if (!numericId || !env.PROFILES || !env.POLL_ROOM) return;
  const pollId = await env.PROFILES.get(zoomPollByMeetingKey(numericId)).catch(() => null);
  if (!isShareToken(pollId)) return;
  await askRoom(roomFor(env, pollId), { op: 'meetingEnded', uuid: typeof object?.uuid === 'string' ? object.uuid : null });
}
