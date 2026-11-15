import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker, * as workerModule from './index.js';
import { mintSessionToken } from './session-token.js';
import { entitlementKey } from './entitlements.js';
import { encryptZoomContext } from './test-helpers.js';
import { makeDurableObjectNamespace, makeKv, makeCtx, makeEmptyAssets } from './durable-object-fake.js';

/**
 * The native Zoom poll (#80, part B, Q5): the host's app poll becomes a Zoom
 * poll on a scheduled meeting, and its results are fetched after the meeting
 * with a short-lived refresh token that only that poll's PollRoom ever holds,
 * encrypted, and that is deleted on every path.
 *
 * Contract: `POST /api/polls/zoom` with a session and
 * `{code, codeVerifier|verifier, meetingId, pollId}`; the owner's
 * `GET /api/polls/<id>/results` carries the fetched answers as `zoom`.
 * Zoom is faked at the fetch boundary, so every call it receives is visible.
 */

const SIGNING_KEY = 'test-session-signing-key';
const CLIENT_SECRET = 'test-zoom-client-secret';
const WEBHOOK_SECRET = 'test-webhook-secret-token';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const START = Date.UTC(2026, 10, 15, 0, 30);
const MID = 'meeting-uuid-M==';
const NUMERIC_ID = '123456789';
const REFRESH_TOKEN = 'rt-original-secret-0123456789';

const BALLOT = {
  categories: [
    { role: 'Table Topics Speech', label: 'Best Table Topics Speaker', candidates: ['Alice', 'Bob'] },
    { role: 'Standard Speech', label: 'Best Speaker', candidates: ['Dan', 'Erin'] },
    { role: 'Table Topics Evaluation', label: 'Best Evaluator', candidates: ['Frank', 'Gina'] },
  ],
};

/** What GET /past_meetings/{uuid}/polls answers: one row per participant. */
const PAST_POLLS = {
  id: Number(NUMERIC_ID),
  questions: [
    {
      name: 'Ann',
      email: 'ann@example.com',
      question_details: [
        { question: 'Best Table Topics Speaker', answer: 'Alice', polling_id: 'zoom-poll-1' },
        { question: 'Best Speaker', answer: 'Dan', polling_id: 'zoom-poll-1' },
      ],
    },
    {
      name: 'Ben',
      email: 'ben@example.com',
      question_details: [
        { question: 'Best Table Topics Speaker', answer: 'Alice', polling_id: 'zoom-poll-1' },
        { question: 'Best Speaker', answer: 'Erin', polling_id: 'zoom-poll-1' },
      ],
    },
    {
      name: 'Cy',
      email: 'cy@example.com',
      question_details: [{ question: 'Best Table Topics Speaker', answer: 'Bob', polling_id: 'zoom-poll-1' }],
    },
  ],
};

let env;
let ctx;
let zoom;

/**
 * Zoom at the fetch boundary. `pastPolls` is the queue of answers the
 * past-meeting polls endpoint gives, one per call: a status number, or a body.
 */
function fakeZoom({ meetingType = 2, uuid = 'aBcD12==', pastPolls = [PAST_POLLS] } = {}) {
  const calls = [];
  let refreshes = 0;
  const queue = [...pastPolls];
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl = vi.fn(async (input, init = {}) => {
    const request = input instanceof Request ? input : null;
    const url = request ? request.url : String(input);
    const method = (init.method ?? request?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers ?? request?.headers ?? {});
    let body = init.body ?? (request && method !== 'GET' ? await request.clone().text() : undefined);
    if (body instanceof URLSearchParams) body = body.toString();
    const call = { url, method, authorization: headers.get('authorization'), body: typeof body === 'string' ? body : body == null ? '' : String(body) };
    calls.push(call);

    if (url.startsWith('https://zoom.us/oauth/token')) {
      const form = new URLSearchParams(call.body || new URL(url).search);
      if (form.get('grant_type') === 'authorization_code') {
        return reply({ access_token: 'at-from-code', refresh_token: REFRESH_TOKEN, token_type: 'bearer', expires_in: 3600, scope: 'meeting:write:poll meeting:read:meeting meeting:read:list_poll_results' });
      }
      if (form.get('grant_type') === 'refresh_token') {
        refreshes += 1;
        return reply({ access_token: `at-refreshed-${refreshes}`, refresh_token: `rt-rotated-${refreshes}`, token_type: 'bearer', expires_in: 3600 });
      }
      return reply({ error: 'unsupported_grant_type' }, 400);
    }
    if (method === 'GET' && url === `https://api.zoom.us/v2/meetings/${NUMERIC_ID}`) {
      return reply({ id: Number(NUMERIC_ID), uuid, type: meetingType, topic: 'Downtown Speakers' });
    }
    if (method === 'POST' && url === `https://api.zoom.us/v2/meetings/${NUMERIC_ID}/polls`) {
      return reply({ id: 'zoom-poll-1', status: 'notstart', ...JSON.parse(call.body || '{}') }, 201);
    }
    if (method === 'GET' && url.startsWith('https://api.zoom.us/v2/past_meetings/')) {
      const next = queue.length ? queue.shift() : 404;
      return typeof next === 'number' ? reply({ code: 3001, message: 'Meeting does not exist' }, next) : reply(next);
    }
    if (url.includes('posthog.com')) return reply({ status: 1 });
    return reply({ error: 'not faked' }, 404);
  });

  return {
    fetchImpl,
    calls,
    tokenCalls: (grant) => calls.filter((c) => c.url.startsWith('https://zoom.us/oauth/token') && new URLSearchParams(c.body).get('grant_type') === grant),
    pollCreates: () => calls.filter((c) => c.method === 'POST' && c.url.endsWith(`/meetings/${NUMERIC_ID}/polls`)),
    pastCalls: () => calls.filter((c) => c.url.startsWith('https://api.zoom.us/v2/past_meetings/')),
  };
}

function makeEnv() {
  const next = {
    PROFILES: makeKv(),
    ASSETS: makeEmptyAssets(),
    SESSION_SIGNING_KEY: SIGNING_KEY,
    ZOOM_CLIENT_ID: 'test-client-id',
    ZOOM_CLIENT_SECRET: CLIENT_SECRET,
    ZOOM_WEBHOOK_SECRET_TOKEN: WEBHOOK_SECRET,
    ZOOM_APP_HOME_URL: 'https://zoom.timer-dev.simple-tech.app',
    WEB_ORIGIN: 'https://www.timer-dev.simple-tech.app',
    ENTITLEMENT_ENFORCE: '1',
    FLAGS_FORCE: '1',
  };
  next.POLL_ROOM = makeDurableObjectNamespace(workerModule.PollRoom, () => next);
  return next;
}

const contextFor = (uid, mid = MID) =>
  encryptZoomContext({ ...(uid ? { uid } : {}), mid, typ: 'meeting', ts: Date.now(), exp: Date.now() + HOUR }, { secret: CLIENT_SECRET });

function call(method, path, { uid, body } = {}) {
  const host = 'zoom.timer-dev.simple-tech.app';
  const headers = { host };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (uid) headers.authorization = `Bearer ${mintSessionToken(uid, SIGNING_KEY)}`;
  return worker.fetch(new Request(`https://${host}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env, ctx);
}

const readJson = async (res) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};

async function appPoll() {
  await env.PROFILES.put(entitlementKey('host-uid'), JSON.stringify({ status: 'active', currentPeriodEnd: Date.now() + 365 * 24 * HOUR }));
  const res = await call('POST', '/api/polls', { uid: 'host-uid', body: { ballot: BALLOT, context: contextFor('host-uid') } });
  expect(res.ok, `POST /api/polls answered ${res.status}`).toBe(true);
  return (await res.json()).id;
}

const createZoomPoll = (pollId, { uid = 'host-uid' } = {}) =>
  call('POST', '/api/polls/zoom', {
    uid,
    body: { code: 'auth-code-1', codeVerifier: 'verifier-1', verifier: 'verifier-1', meetingId: NUMERIC_ID, pollId },
  });

function signedWebhook(body) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const hash = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`v0:${timestamp}:${raw}`).digest('hex');
  return worker.fetch(
    new Request('https://www.timer-dev.simple-tech.app/api/zoom/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zm-signature': `v0=${hash}`, 'x-zm-request-timestamp': timestamp },
      body: raw,
    }),
    env,
    ctx
  );
}

async function meetingEnded(uuid = 'aBcD12==') {
  const res = await signedWebhook({
    event: 'meeting.ended',
    event_ts: Date.now(),
    payload: { account_id: 'acct-1', object: { id: NUMERIC_ID, uuid, host_id: 'host-uid', topic: 'Downtown Speakers', type: 2 } },
  });
  expect(res.status).toBe(200);
  await ctx.settle();
  await env.POLL_ROOM.settle();
}

/** Move the clock and let every alarm that is due run. */
async function advanceTo(at) {
  vi.setSystemTime(at);
  await env.POLL_ROOM.runDueAlarms(at);
}

/** Everything the Worker has put anywhere it persists or prints. */
function everythingPersisted() {
  const kv = [...env.PROFILES.store.entries()].map(([k, v]) => `${k}=${v.value}`);
  const rooms = env.POLL_ROOM.allStorage().map((data) => JSON.stringify([...data.entries()]));
  const logs = ['log', 'info', 'warn', 'error'].flatMap((level) => console[level].mock.calls.map((args) => args.map(String).join(' ')));
  return [...kv, ...rooms, ...logs].join('\n');
}

/** The count for an answer, wherever the stored results keep it. */
function countFor(zoomResults, answer) {
  let found = null;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node[answer] === 'number') found = Math.max(found ?? 0, node[answer]);
    const label = node.answer ?? node.name ?? node.candidate;
    const n = node.count ?? node.votes;
    if (label === answer && typeof n === 'number') found = Math.max(found ?? 0, n);
    // Parallel arrays: {answers: ['Alice', 'Bob'], counts: [2, 1]}.
    const values = Object.values(node);
    for (const names of values) {
      if (!Array.isArray(names) || !names.includes(answer)) continue;
      for (const numbers of values) {
        if (Array.isArray(numbers) && numbers.length === names.length && numbers.every((x) => typeof x === 'number')) {
          found = Math.max(found ?? 0, numbers[names.indexOf(answer)]);
        }
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(zoomResults);
  return found;
}

beforeEach(() => {
  vi.setSystemTime(START);
  env = makeEnv();
  ctx = makeCtx();
  for (const level of ['log', 'info', 'warn', 'error']) vi.spyOn(console, level).mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('POST /api/polls/zoom — creating the native poll', () => {
  it('needs a signed-in user', async () => {
    zoom = fakeZoom();
    vi.stubGlobal('fetch', zoom.fetchImpl);
    const pollId = await appPoll();

    expect((await createZoomPoll(pollId, { uid: null })).status).toBe(401);
    expect(zoom.pollCreates()).toHaveLength(0);
  });

  // Zoom only allows polls on scheduled meetings; the host is told why.
  it('refuses an instant meeting with a reason, and creates nothing', async () => {
    zoom = fakeZoom({ meetingType: 1 });
    vi.stubGlobal('fetch', zoom.fetchImpl);
    const pollId = await appPoll();

    const res = await createZoomPoll(pollId);
    const body = await readJson(res);

    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(JSON.stringify(body)).toMatch(/instant/i);
    expect(zoom.pollCreates()).toHaveLength(0);
  });

  it('creates one single-choice question per category on a scheduled meeting, with the candidates as answers', async () => {
    zoom = fakeZoom();
    vi.stubGlobal('fetch', zoom.fetchImpl);
    const pollId = await appPoll();

    const res = await createZoomPoll(pollId);
    expect(res.ok, `POST /api/polls/zoom answered ${res.status}`).toBe(true);

    const [exchange] = zoom.tokenCalls('authorization_code');
    const form = new URLSearchParams(exchange.body);
    expect(form.get('code')).toBe('auth-code-1');
    expect(form.get('code_verifier')).toBe('verifier-1');

    const [created] = zoom.pollCreates();
    expect(created.authorization).toBe('Bearer at-from-code');
    const { questions } = JSON.parse(created.body);
    expect(questions).toHaveLength(3);
    for (const [i, question] of questions.entries()) {
      expect(question.type).toBe('single');
      expect(question.answers).toEqual(BALLOT.categories[i].candidates);
      expect(question.name).toContain(BALLOT.categories[i].label);
    }
  });

  it('keeps the host\'s refresh token only encrypted: never in KV, never plain in the room, never in a log', async () => {
    zoom = fakeZoom();
    vi.stubGlobal('fetch', zoom.fetchImpl);
    const pollId = await appPoll();
    expect((await createZoomPoll(pollId)).ok).toBe(true);

    const persisted = everythingPersisted();
    expect(persisted).not.toContain(REFRESH_TOKEN);
    expect(persisted).not.toContain(Buffer.from(REFRESH_TOKEN).toString('base64'));
    expect(persisted).not.toContain(Buffer.from(REFRESH_TOKEN).toString('hex'));
    // The deadline that deletes it is already set: 24 hours at the latest.
    expect(env.POLL_ROOM.nextAlarm()).not.toBeNull();
    expect(env.POLL_ROOM.nextAlarm()).toBeLessThanOrEqual(START + 24 * HOUR);
  });
});

describe('the results, after the meeting ends', () => {
  async function nativePoll(options) {
    zoom = fakeZoom(options);
    vi.stubGlobal('fetch', zoom.fetchImpl);
    const pollId = await appPoll();
    expect((await createZoomPoll(pollId)).ok).toBe(true);
    return pollId;
  }

  it('waits five minutes after meeting.ended, refreshes the token, fetches the answers and stores the counts', async () => {
    const pollId = await nativePoll();
    const ended = Date.now() + 40 * MINUTE;
    vi.setSystemTime(ended);
    await meetingEnded();

    // Zoom needs a few minutes to process the poll; nothing is asked before then.
    expect(env.POLL_ROOM.nextAlarm()).toBeGreaterThanOrEqual(ended + 4 * MINUTE);
    expect(env.POLL_ROOM.nextAlarm()).toBeLessThanOrEqual(ended + 6 * MINUTE);
    await advanceTo(ended + 4 * MINUTE);
    expect(zoom.pastCalls()).toHaveLength(0);

    await advanceTo(ended + 6 * MINUTE);
    const [refresh] = zoom.tokenCalls('refresh_token');
    expect(new URLSearchParams(refresh.body).get('refresh_token')).toBe(REFRESH_TOKEN);
    const [past] = zoom.pastCalls();
    expect(past.url.startsWith(`https://api.zoom.us/v2/past_meetings/${encodeURIComponent('aBcD12==')}/polls`)).toBe(true);
    expect(past.authorization).toBe('Bearer at-refreshed-1');

    const results = await readJson(await call('GET', `/api/polls/${pollId}/results`, { uid: 'host-uid' }));
    expect(results?.zoom).toBeTruthy();
    expect(countFor(results.zoom, 'Alice')).toBe(2);
    expect(countFor(results.zoom, 'Bob')).toBe(1);
    expect(countFor(results.zoom, 'Dan')).toBe(1);
    expect(countFor(results.zoom, 'Erin')).toBe(1);
    // Counts only: who answered what stays with Zoom.
    expect(JSON.stringify(results.zoom)).not.toContain('ann@example.com');
  });

  it('deletes the token once the answers are in, rotated token included', async () => {
    await nativePoll();
    await meetingEnded();
    await advanceTo(Date.now() + 6 * MINUTE);
    expect(zoom.pastCalls()).toHaveLength(1);

    const persisted = everythingPersisted();
    expect(persisted).not.toContain(REFRESH_TOKEN);
    expect(persisted).not.toContain('rt-rotated-1');

    // Nothing left to refresh with: another meeting.ended asks Zoom for nothing.
    await meetingEnded();
    await advanceTo(Date.now() + 10 * MINUTE);
    await advanceTo(Date.now() + 2 * HOUR);
    expect(zoom.tokenCalls('refresh_token')).toHaveLength(1);
    expect(zoom.pastCalls()).toHaveLength(1);
  });

  it('retries an empty answer and a 404 at +15 and +60 minutes, then stores what arrives', async () => {
    const pollId = await nativePoll({ pastPolls: [{ questions: [] }, 404, PAST_POLLS] });
    await meetingEnded();
    const first = Date.now() + 6 * MINUTE;
    await advanceTo(first);
    expect(zoom.pastCalls()).toHaveLength(1);

    // Not straight away.
    await env.POLL_ROOM.runDueAlarms();
    expect(zoom.pastCalls()).toHaveLength(1);

    await advanceTo(first + 15 * MINUTE + 1000);
    expect(zoom.pastCalls()).toHaveLength(2);

    await advanceTo(first + 15 * MINUTE + 60 * MINUTE + 2000);
    expect(zoom.pastCalls()).toHaveLength(3);

    const results = await readJson(await call('GET', `/api/polls/${pollId}/results`, { uid: 'host-uid' }));
    expect(countFor(results?.zoom, 'Alice')).toBe(2);
  });

  it('gives up after the last retry and deletes the token', async () => {
    await nativePoll({ pastPolls: [404, 404, 404, 404, 404] });
    await meetingEnded();
    const first = Date.now() + 6 * MINUTE;
    await advanceTo(first);
    await advanceTo(first + 15 * MINUTE + 1000);
    await advanceTo(first + 75 * MINUTE + 2000);
    expect(zoom.pastCalls()).toHaveLength(3);

    await advanceTo(first + 6 * HOUR);
    expect(zoom.pastCalls()).toHaveLength(3);
    const refreshes = zoom.tokenCalls('refresh_token').length;

    await meetingEnded();
    await advanceTo(Date.now() + 10 * MINUTE);
    expect(zoom.tokenCalls('refresh_token')).toHaveLength(refreshes);
    expect(zoom.pastCalls()).toHaveLength(3);
  });

  it('deletes the token 24 hours after creation when the meeting never reports ending, and keeps the poll for its owner', async () => {
    const pollId = await nativePoll();

    await advanceTo(START + 24 * HOUR + MINUTE);
    await advanceTo(START + 24 * HOUR + 2 * MINUTE);
    expect(everythingPersisted()).not.toContain(REFRESH_TOKEN);

    await meetingEnded();
    await advanceTo(Date.now() + 10 * MINUTE);
    expect(zoom.tokenCalls('refresh_token')).toHaveLength(0);
    expect(zoom.pastCalls()).toHaveLength(0);

    // A native poll's room lives a week, so the owner can still collect it.
    expect((await call('GET', `/api/polls/${pollId}/results`, { uid: 'host-uid' })).status).toBe(200);
  });

  // Zoom's rule for meeting UUIDs in a path: double-encode one that starts
  // with "/" or contains "//".
  it('double-encodes a meeting UUID that starts with a slash or contains a double slash', async () => {
    const uuid = '/aB//cD==';
    await nativePoll({ uuid });
    await meetingEnded(uuid);
    await advanceTo(Date.now() + 6 * MINUTE);

    const [past] = zoom.pastCalls();
    expect(past?.url.startsWith(`https://api.zoom.us/v2/past_meetings/${encodeURIComponent(encodeURIComponent(uuid))}/polls`)).toBe(true);
  });

  it('answers the webhook for a meeting with no native poll, and asks Zoom for nothing', async () => {
    zoom = fakeZoom();
    vi.stubGlobal('fetch', zoom.fetchImpl);
    await meetingEnded();
    await advanceTo(Date.now() + 10 * MINUTE);
    expect(zoom.pastCalls()).toHaveLength(0);
    expect(zoom.tokenCalls('refresh_token')).toHaveLength(0);
  });
});
