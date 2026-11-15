import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker, * as workerModule from './index.js';
import { FLAG_FALLBACKS } from './flags.js';
import { isShareToken } from './club-share.js';
import { mintSessionToken } from './session-token.js';
import { entitlementKey } from './entitlements.js';
import { encryptZoomContext } from './test-helpers.js';
import { makeDurableObjectNamespace, makeKv, makeCtx, makeEmptyAssets } from './durable-object-fake.js';

/**
 * Meeting polls (#80), from the Worker's side: one PollRoom Durable Object per
 * poll holds the ballot and the votes, so the counts at Close are final.
 *
 * Contract these tests hold the implementation to:
 *  - worker/index.js exports the Durable Object class `PollRoom`; its binding
 *    is `env.POLL_ROOM`. Storage is the key-value API, not `storage.sql`.
 *  - a ballot is `{categories: [{role, label?, candidates: [name, …]}]}`;
 *  - a vote is `{choices: {<catIndex>: <candIndex>}, context?, device?}`;
 *  - results are `{counts, byPath: {zoom, guest, link}, status}`, where
 *    `counts[catIndex][candIndex]` is a number and `byPath.<path>` has the same
 *    shape; close answers `{counts, byPath, winners}`, `winners[catIndex]`
 *    being the winning candidate names (every name tied at the top count, and
 *    none when the category got no votes).
 */

const SIGNING_KEY = 'test-session-signing-key';
const CLIENT_SECRET = 'test-zoom-client-secret';
const WEB_ORIGIN = 'https://www.timer-dev.simple-tech.app';
const ZOOM_HOST = 'zoom.timer-dev.simple-tech.app';
const WWW_HOST = 'www.timer-dev.simple-tech.app';
const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2026, 10, 15, 0, 30);
const MEETING = 'meeting-uuid-M==';
const OTHER_MEETING = 'meeting-uuid-N==';

const BALLOT = {
  categories: [
    { role: 'Table Topics Speech', label: 'Best Table Topics Speaker', candidates: ['Alice', 'Bob', 'Carol'] },
    { role: 'Standard Speech', label: 'Best Speaker', candidates: ['Dan', 'Erin'] },
    { role: 'Table Topics Evaluation', label: 'Best Evaluator', candidates: ['Frank'] },
  ],
};

let env;
let ctx;

function makeEnv() {
  const next = {
    PROFILES: makeKv(),
    ASSETS: makeEmptyAssets(),
    SESSION_SIGNING_KEY: SIGNING_KEY,
    ZOOM_CLIENT_ID: 'test-client-id',
    ZOOM_CLIENT_SECRET: CLIENT_SECRET,
    ENTITLEMENT_ENFORCE: '1',
    // Every flag on: these tests are about the endpoints, not the dark launch.
    FLAGS_FORCE: '1',
    WEB_ORIGIN,
  };
  next.POLL_ROOM = makeDurableObjectNamespace(workerModule.PollRoom, () => next);
  return next;
}

/** A context for `uid` (null for a guest) in meeting `mid`, encrypted the way Zoom does it. */
const contextFor = (uid, mid = MEETING) =>
  encryptZoomContext(
    { ...(uid ? { uid } : {}), mid, typ: 'meeting', ts: Date.now(), exp: Date.now() + HOUR },
    { secret: CLIENT_SECRET }
  );

async function makePro(uid) {
  await env.PROFILES.put(entitlementKey(uid), JSON.stringify({ status: 'active', currentPeriodEnd: Date.now() + 365 * 24 * HOUR }));
}

function call(method, path, { uid, body, host = ZOOM_HOST, ip = '203.0.113.7' } = {}) {
  const headers = { host, 'cf-connecting-ip': ip };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (uid) headers.authorization = `Bearer ${mintSessionToken(uid, SIGNING_KEY)}`;
  return worker.fetch(
    new Request(`https://${host}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
    env,
    ctx
  );
}

const readJson = async (res) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};

/** Create a poll as `owner` (a Pro uid), from inside meeting `mid` unless `mid` is null. */
async function createPoll({ owner = 'owner-uid', mid = MEETING, ballot = BALLOT, expiryHours } = {}) {
  const res = await call('POST', '/api/polls', {
    uid: owner,
    body: { ballot, ...(expiryHours ? { expiryHours } : {}), ...(mid ? { context: contextFor(owner, mid) } : {}) },
  });
  const body = await readJson(res);
  expect(res.ok, `POST /api/polls answered ${res.status}`).toBe(true);
  expect(isShareToken(body?.id)).toBe(true);
  return body.id;
}

const vote = (id, choices, { context, device, ip } = {}) =>
  call('POST', `/api/polls/${id}/votes`, {
    ip,
    body: { choices, ...(context !== undefined ? { context } : {}), ...(device !== undefined ? { device } : {}) },
  });

const results = async (id, uid = 'owner-uid') => readJson(await call('GET', `/api/polls/${id}/results`, { uid }));

const count = (res, cat, cand) => Number(res?.counts?.[cat]?.[cand] ?? 0);

/** Sum every number in a nested structure: the path split, however it is shaped. */
function total(value) {
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.reduce((sum, v) => sum + total(v), 0);
  if (value && typeof value === 'object') return Object.values(value).reduce((sum, v) => sum + total(v), 0);
  return 0;
}

beforeEach(() => {
  vi.setSystemTime(START);
  env = makeEnv();
  ctx = makeCtx();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('what ships dark, and what it needs', () => {
  it('declares the polls and polls_zoom release flags, both off by default', () => {
    expect(FLAG_FALLBACKS.polls).toBe(false);
    expect(FLAG_FALLBACKS.polls_zoom).toBe(false);
  });

  it('exports the PollRoom Durable Object class from the Worker entry point', () => {
    expect(typeof workerModule.PollRoom).toBe('function');
  });

  describe('wrangler.jsonc', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    // Comments in this file always sit on their own line (see flags.test.js).
    const config = JSON.parse(readFileSync(join(repoRoot, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
    const doBinding = (block) => (block?.durable_objects?.bindings ?? []).find((b) => b.name === 'POLL_ROOM');
    const limiter = (block) => (block?.unsafe?.bindings ?? []).find((b) => b.name === 'POLL_VOTE_LIMITER');
    const migrates = (migrations) =>
      (migrations ?? []).some((m) => [...(m.new_classes ?? []), ...(m.new_sqlite_classes ?? [])].includes('PollRoom'));

    // Bindings are not inherited by environments, so dev needs its own copy.
    it('binds POLL_ROOM to the PollRoom class in production and dev', () => {
      expect(doBinding(config)?.class_name).toBe('PollRoom');
      expect(doBinding(config.env.dev)?.class_name).toBe('PollRoom');
    });

    it('has a migration that creates the PollRoom class', () => {
      expect(migrates(config.migrations)).toBe(true);
      expect(migrates(config.env.dev.migrations ?? config.migrations)).toBe(true);
    });

    it('limits link votes to 120 a minute in both environments', () => {
      for (const block of [config, config.env.dev]) {
        expect(limiter(block)?.type).toBe('ratelimit');
        expect(limiter(block)?.simple).toEqual({ limit: 120, period: 60 });
      }
    });
  });
});

describe('POST /api/polls — opening a poll', () => {
  it('needs a signed-in user', async () => {
    const res = await call('POST', '/api/polls', { body: { ballot: BALLOT } });
    expect(res.status).toBe(401);
  });

  // Running a poll is Pro; voting is not (see the vote tests below).
  it('refuses a free plan with the upgrade answer', async () => {
    const res = await call('POST', '/api/polls', { uid: 'free-uid', body: { ballot: BALLOT, context: contextFor('free-uid') } });
    expect(res.status).toBe(402);
    expect((await readJson(res))?.error).toBe('upgrade_required');
  });

  it('gives a Pro user an unguessable id and a voting link on the www host', async () => {
    await makePro('owner-uid');
    const res = await call('POST', '/api/polls', { uid: 'owner-uid', body: { ballot: BALLOT, context: contextFor('owner-uid') } });
    const body = await readJson(res);

    expect(res.ok).toBe(true);
    expect(isShareToken(body?.id)).toBe(true);
    // Asked from the zoom. host, which routes every path to the sidebar app:
    // the link has to point at the website instead.
    expect(body?.url).toBe(`${WEB_ORIGIN}/vote/${body?.id}`);
  });

  it('refuses a ballot with no categories', async () => {
    await makePro('owner-uid');
    const res = await call('POST', '/api/polls', { uid: 'owner-uid', body: { ballot: { categories: [] } } });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/polls/<id>/ballot', () => {
  beforeEach(() => makePro('owner-uid'));

  it('shows anyone the names and labels, and never a count', async () => {
    const id = await createPoll();
    await vote(id, { 0: 0 }, { device: 'device-1' });

    const res = await call('GET', `/api/polls/${id}/ballot`, { host: WWW_HOST });
    const text = JSON.stringify(await readJson(res));

    expect(res.status).toBe(200);
    for (const name of ['Alice', 'Bob', 'Carol', 'Dan', 'Erin', 'Frank', 'Best Speaker', 'Best Evaluator']) {
      expect(text).toContain(name);
    }
    expect(text).not.toMatch(/"counts"|"byPath"/);
  });

  it('is a 404 for an id nobody minted, and for one that is not an id at all', async () => {
    expect((await call('GET', '/api/polls/ABCDEFGHJKMNPQRS/ballot')).status).toBe(404);
    expect((await call('GET', '/api/polls/not-an-id/ballot')).status).toBe(404);
  });

  it('expires after 24 hours by default, and the room deletes its storage', async () => {
    const id = await createPoll();

    vi.setSystemTime(START + 23 * HOUR);
    await env.POLL_ROOM.runDueAlarms();
    expect((await call('GET', `/api/polls/${id}/ballot`)).status).toBe(200);

    vi.setSystemTime(START + 24 * HOUR + 60_000);
    await env.POLL_ROOM.runDueAlarms();
    expect((await call('GET', `/api/polls/${id}/ballot`)).status).toBe(404);
    expect(env.POLL_ROOM.allStorage().every((data) => data.size === 0)).toBe(true);
  });

  it('honours a shorter expiry', async () => {
    const id = await createPoll({ expiryHours: 2 });
    vi.setSystemTime(START + 2 * HOUR + 60_000);
    await env.POLL_ROOM.runDueAlarms();
    expect((await call('GET', `/api/polls/${id}/ballot`)).status).toBe(404);
  });
});

describe('POST /api/polls/<id>/votes — the web link', () => {
  beforeEach(() => makePro('owner-uid'));

  it('takes a vote from a browser with no Zoom sign-in, counted under link', async () => {
    const id = await createPoll();
    const res = await vote(id, { 0: 1 }, { device: 'device-1' });

    expect(res.ok).toBe(true);
    const r = await results(id);
    expect(count(r, 0, 1)).toBe(1);
    expect(total(r.byPath.link)).toBe(1);
    expect(total(r.byPath.zoom)).toBe(0);
    expect(total(r.byPath.guest)).toBe(0);
  });

  it('refuses a second vote from the same device in the same category, and the count stays put', async () => {
    const id = await createPoll();
    expect((await vote(id, { 0: 1 }, { device: 'device-1' })).ok).toBe(true);

    const again = await vote(id, { 0: 2 }, { device: 'device-1' });
    expect(again.status).toBe(409);

    const r = await results(id);
    expect(count(r, 0, 1)).toBe(1);
    expect(count(r, 0, 2)).toBe(0);
  });

  it('lets the same device vote in a category it has not voted in yet', async () => {
    const id = await createPoll();
    expect((await vote(id, { 0: 0 }, { device: 'device-1' })).ok).toBe(true);
    expect((await vote(id, { 1: 1 }, { device: 'device-1' })).ok).toBe(true);
    expect((await vote(id, { 0: 0 }, { device: 'device-2' })).ok).toBe(true);

    const r = await results(id);
    expect(count(r, 0, 0)).toBe(2);
    expect(count(r, 1, 1)).toBe(1);
  });

  it('refuses a choice that is not on the ballot', async () => {
    const id = await createPoll();
    expect((await vote(id, { 0: 9 }, { device: 'device-1' })).status).toBe(400);
    expect((await vote(id, { 7: 0 }, { device: 'device-2' })).status).toBe(400);
    expect(total((await results(id)).counts)).toBe(0);
  });

  it('is a 404 for an unknown poll and for an expired one', async () => {
    expect((await vote('ABCDEFGHJKMNPQRS', { 0: 0 }, { device: 'device-1' })).status).toBe(404);

    const id = await createPoll();
    vi.setSystemTime(START + 25 * HOUR);
    await env.POLL_ROOM.runDueAlarms();
    expect((await vote(id, { 0: 0 }, { device: 'device-1' })).status).toBe(404);
  });

  it('refuses votes once the poll is closed', async () => {
    const id = await createPoll();
    await vote(id, { 0: 0 }, { device: 'device-1' });
    expect((await call('POST', `/api/polls/${id}/close`, { uid: 'owner-uid' })).ok).toBe(true);

    const late = await vote(id, { 0: 1 }, { device: 'device-2' });
    expect(late.ok).toBe(false);
    expect([403, 409, 410]).toContain(late.status);
    const r = await results(id);
    expect(count(r, 0, 0)).toBe(1);
    expect(count(r, 0, 1)).toBe(0);
  });

  describe('the per-poll-and-address limiter', () => {
    function makeLimiter(limit) {
      const seen = new Map();
      return {
        seen,
        limit: vi.fn(async ({ key }) => {
          const next = (seen.get(key) ?? 0) + 1;
          seen.set(key, next);
          return { success: next <= limit };
        }),
      };
    }

    // One room's Wi-Fi is one address: a hybrid club of 120 has to fit.
    it('takes 120 link votes a minute from one address, then answers 429', async () => {
      env.POLL_VOTE_LIMITER = makeLimiter(120);
      const id = await createPoll();

      for (let i = 0; i < 120; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const res = await vote(id, { 0: i % 3 }, { device: `device-${i}`, ip: '198.51.100.1' });
        expect(res.ok, `vote ${i + 1} answered ${res.status}`).toBe(true);
      }
      const refused = await vote(id, { 0: 0 }, { device: 'device-120', ip: '198.51.100.1' });
      expect(refused.status).toBe(429);
      expect(env.POLL_VOTE_LIMITER.seen.get(`${id}:198.51.100.1`)).toBe(121);

      // Another address is its own bucket.
      expect((await vote(id, { 0: 0 }, { device: 'device-121', ip: '198.51.100.2' })).ok).toBe(true);
      expect(total((await results(id)).counts)).toBe(121);
    });

    it('lets the vote through when the limiter itself fails', async () => {
      env.POLL_VOTE_LIMITER = { limit: vi.fn(async () => { throw new Error('limiter down'); }) };
      const id = await createPoll();

      expect((await vote(id, { 0: 0 }, { device: 'device-1' })).ok).toBe(true);
      expect(env.POLL_VOTE_LIMITER.limit).toHaveBeenCalled();
      expect(count(await results(id), 0, 0)).toBe(1);
    });

    it('never applies to a vote cast inside Zoom', async () => {
      env.POLL_VOTE_LIMITER = makeLimiter(0);
      const id = await createPoll();

      expect((await vote(id, { 0: 0 }, { context: contextFor('voter-uid') })).ok).toBe(true);
      expect((await vote(id, { 0: 1 }, { context: contextFor(null), device: 'guest-device' })).ok).toBe(true);
      expect(env.POLL_VOTE_LIMITER.limit).not.toHaveBeenCalled();
    });
  });
});

describe('POST /api/polls/<id>/votes — inside Zoom', () => {
  beforeEach(() => makePro('owner-uid'));

  // The voter has no plan at all, and enforcement is on: voting is free.
  it('takes a signed-in participant\'s vote, counted under zoom', async () => {
    const id = await createPoll();
    const res = await vote(id, { 1: 0 }, { context: contextFor('voter-uid') });

    expect(res.ok).toBe(true);
    const r = await results(id);
    expect(count(r, 1, 0)).toBe(1);
    expect(total(r.byPath.zoom)).toBe(1);
    expect(total(r.byPath.link)).toBe(0);
  });

  it('keys a signed-in vote by the Zoom account, so a second device cannot vote again', async () => {
    const id = await createPoll();
    expect((await vote(id, { 1: 0 }, { context: contextFor('voter-uid'), device: 'laptop' })).ok).toBe(true);

    const again = await vote(id, { 1: 1 }, { context: contextFor('voter-uid'), device: 'phone' });
    expect(again.status).toBe(409);
    expect(count(await results(id), 1, 1)).toBe(0);
  });

  it('keys a guest\'s vote by device token, counted under guest', async () => {
    const id = await createPoll();
    expect((await vote(id, { 0: 0 }, { context: contextFor(null), device: 'guest-1' })).ok).toBe(true);
    expect((await vote(id, { 0: 1 }, { context: contextFor(null), device: 'guest-2' })).ok).toBe(true);
    expect((await vote(id, { 0: 2 }, { context: contextFor(null), device: 'guest-1' })).status).toBe(409);

    const r = await results(id);
    expect(total(r.byPath.guest)).toBe(2);
    expect(count(r, 0, 2)).toBe(0);
  });

  it('refuses a context from another meeting with 403 wrong_meeting', async () => {
    const id = await createPoll();
    const res = await vote(id, { 0: 0 }, { context: contextFor('voter-uid', OTHER_MEETING) });

    expect(res.status).toBe(403);
    expect((await readJson(res))?.error).toBe('wrong_meeting');
    expect(total((await results(id)).counts)).toBe(0);
  });

  it('refuses a context that does not decrypt with 400', async () => {
    const id = await createPoll();
    const forged = encryptZoomContext({ uid: 'voter-uid', mid: MEETING, exp: Date.now() + HOUR }, { secret: 'not-our-secret' });

    expect((await vote(id, { 0: 0 }, { context: forged })).status).toBe(400);
    expect((await vote(id, { 0: 0 }, { context: 'garbage' })).status).toBe(400);
    expect(total((await results(id)).counts)).toBe(0);
  });

  it('takes link votes only, for a poll opened with no meeting to tie it to', async () => {
    const id = await createPoll({ mid: null });
    expect((await vote(id, { 0: 0 }, { device: 'device-1' })).ok).toBe(true);
    expect((await vote(id, { 0: 0 }, { context: contextFor('voter-uid') })).status).toBe(403);
  });

  it('stores who voted only as hashes', async () => {
    const id = await createPoll();
    await vote(id, { 0: 0 }, { context: contextFor('voter-uid-secret') });
    await vote(id, { 0: 1 }, { context: contextFor(null), device: 'guest-device-secret' });
    await vote(id, { 0: 2 }, { device: 'link-device-secret' });

    const stored = JSON.stringify(env.POLL_ROOM.allStorage().map((data) => [...data.entries()]));
    expect(stored).not.toContain('voter-uid-secret');
    expect(stored).not.toContain('guest-device-secret');
    expect(stored).not.toContain('link-device-secret');
  });
});

describe('POST /api/polls/current — an invited app finds the poll', () => {
  beforeEach(() => makePro('owner-uid'));

  const current = (context) => call('POST', '/api/polls/current', { body: { context } });

  it('answers a participant in the same meeting with the open poll and its ballot', async () => {
    const id = await createPoll();
    const res = await current(contextFor('voter-uid'));
    const body = await readJson(res);

    expect(res.status).toBe(200);
    expect(body?.id).toBe(id);
    expect(JSON.stringify(body?.ballot)).toContain('Alice');
    expect(JSON.stringify(body)).not.toMatch(/"counts"|"byPath"/);
  });

  it('finds it for a guest too', async () => {
    const id = await createPoll();
    expect((await readJson(await current(contextFor(null))))?.id).toBe(id);
  });

  it('is a 404 from another meeting, and once the poll is closed', async () => {
    const id = await createPoll();
    expect((await current(contextFor('voter-uid', OTHER_MEETING))).status).toBe(404);

    await call('POST', `/api/polls/${id}/close`, { uid: 'owner-uid' });
    expect((await current(contextFor('voter-uid'))).status).toBe(404);
  });

  it('is a 404 for a poll opened with no meeting context', async () => {
    await createPoll({ mid: null });
    expect((await current(contextFor('voter-uid'))).status).toBe(404);
  });

  it('refuses a context that does not decrypt', async () => {
    await createPoll();
    const res = await current('garbage');
    expect([400, 404]).toContain(res.status);
  });
});

describe('results and Close belong to the poll\'s owner', () => {
  beforeEach(async () => {
    await makePro('owner-uid');
    await makePro('other-pro-uid');
  });

  it('answers results to the owner only: 401 anonymous, 403 anyone else', async () => {
    const id = await createPoll();
    expect((await call('GET', `/api/polls/${id}/results`)).status).toBe(401);
    expect((await call('GET', `/api/polls/${id}/results`, { uid: 'other-pro-uid' })).status).toBe(403);

    const res = await call('GET', `/api/polls/${id}/results`, { uid: 'owner-uid' });
    expect(res.status).toBe(200);
    expect((await readJson(res))?.status).toBe('open');
  });

  it('splits the counts by how each vote came in', async () => {
    const id = await createPoll();
    await vote(id, { 0: 0 }, { context: contextFor('voter-1') });
    await vote(id, { 0: 0 }, { context: contextFor('voter-2') });
    await vote(id, { 0: 1 }, { context: contextFor(null), device: 'guest-1' });
    await vote(id, { 0: 1 }, { device: 'link-1' });
    await vote(id, { 0: 1 }, { device: 'link-2' });
    await vote(id, { 0: 2 }, { device: 'link-3' });

    const r = await results(id);
    expect([count(r, 0, 0), count(r, 0, 1), count(r, 0, 2)]).toEqual([2, 3, 1]);
    expect(total(r.byPath.zoom)).toBe(2);
    expect(total(r.byPath.guest)).toBe(1);
    expect(total(r.byPath.link)).toBe(3);
  });

  it('lets only the owner close it: 401 anonymous, 403 anyone else', async () => {
    const id = await createPoll();
    expect((await call('POST', `/api/polls/${id}/close`)).status).toBe(401);
    expect((await call('POST', `/api/polls/${id}/close`, { uid: 'other-pro-uid' })).status).toBe(403);
    expect((await results(id)).status).toBe('open');
  });

  it('closes with final counts and the winners: every name tied at the top, none for an empty category', async () => {
    const id = await createPoll();
    await vote(id, { 0: 0 }, { device: 'd1' });
    await vote(id, { 0: 1 }, { device: 'd2' });
    await vote(id, { 0: 0 }, { device: 'd3' });
    await vote(id, { 0: 1 }, { device: 'd4' });
    await vote(id, { 0: 2 }, { device: 'd5' });
    await vote(id, { 1: 1 }, { device: 'd6' });

    const res = await call('POST', `/api/polls/${id}/close`, { uid: 'owner-uid' });
    const body = await readJson(res);

    expect(res.status).toBe(200);
    expect([count(body, 0, 0), count(body, 0, 1), count(body, 0, 2)]).toEqual([2, 2, 1]);
    expect(body.winners[0]).toEqual(['Alice', 'Bob']);
    expect(body.winners[1]).toEqual(['Erin']);
    expect(body.winners[2] ?? []).toEqual([]);
    expect(total(body.byPath.link)).toBe(6);
    expect((await results(id)).status).toBe('closed');
  });
});

describe('GET /vote/<id> — the backup voting page', () => {
  beforeEach(() => makePro('owner-uid'));

  const page = (id) => call('GET', `/vote/${id}`, { host: WWW_HOST });

  it('is Worker-rendered HTML on the www host, noindex, and never the SPA shell', async () => {
    const id = await createPoll();
    const res = await page(id);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('x-robots-tag') ?? html).toMatch(/noindex/);
    expect(env.ASSETS.calls).toEqual([]);
    // Honest about what a device token can and cannot do.
    expect(html).toMatch(/one vote per device/i);
  });

  it('is a real 404 for an id nobody minted', async () => {
    const res = await page('ABCDEFGHJKMNPQRS');
    expect(res.status).toBe(404);
    expect(env.ASSETS.calls).toEqual([]);
  });
});
