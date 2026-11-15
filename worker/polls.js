import crypto from 'node:crypto';
import { readSession, readClub } from './auth.js';
import { json, methodNotAllowed, notConfigured, notFound, unauthorized } from './http.js';
import { resolveAccess } from './entitlements.js';
import { flagEnabled } from './flags.js';
import { isShareToken, mintShareToken } from './club-share.js';
import { decryptAppContext } from './zoom-context.js';
import { capturePostHogEvent } from './posthog.js';
import { handleZoomPollCreate } from './polls-zoom.js';

/**
 * Meeting polls (#80): Best Table Topics Speaker, Best Speaker, Best Evaluator.
 *
 *   POST /api/polls                 session + Pro: open a poll   → 201 {id, url, ballot}
 *   POST /api/polls/current         public: {context} → the open poll of that meeting
 *   GET  /api/polls/<id>/ballot     public: names and labels, never a count
 *   POST /api/polls/<id>/votes      public: {choices, context?, device?}
 *   GET  /api/polls/<id>/results    owner only: {status, counts, byPath, zoom}
 *   POST /api/polls/<id>/close      owner only: {counts, byPath, winners}
 *   POST /api/polls/zoom            owner, host: the native Zoom poll (polls-zoom.js)
 *   GET  /vote/<id>                 the backup voting page, Worker-rendered
 *
 * Running a poll is Pro; voting never is. The votes live in the poll's
 * PollRoom (poll-room.js). The id is a share token: 16 Crockford characters,
 * unguessable rather than secret.
 *
 * Who a vote counts as is decided here, never by the client:
 *  - a Zoom app context with a uid, from the poll's meeting → that Zoom account (`zoom`)
 *  - a context with no uid (a guest), from the poll's meeting → the device token (`guest`)
 *  - no context (the web link) → the device token (`link`), behind a per-poll-and-address limiter
 * Only hashes reach the room, keyed per poll so two polls cannot be joined.
 */

const HOUR = 60 * 60 * 1000;
const DEFAULT_EXPIRY_HOURS = 24;
const MAX_CATEGORIES = 10;
const MAX_CANDIDATES = 30;
const MAX_TEXT = 80;
const MAX_DEVICE = 128;

export const pollByMidKey = (midHash) => `poll-by-mid:${midHash}`;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** A voter or owner key, keyed per poll with the signing key, so a stored hash names nobody. */
export const voterHash = (env, pollId, value) =>
  crypto.createHmac('sha256', env.SESSION_SIGNING_KEY || 'poll').update(`${pollId}:${value}`).digest('hex');

export const ownerHashFor = (env, pollId, uid) => voterHash(env, pollId, `owner:${uid}`);

/** The meeting's id as stored: hashed, and the same hash names its KV index. */
export const midHashFor = (mid) => (mid ? sha256(`mid:${mid}`) : null);

const clip = (value) => (typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '');

/**
 * Names and labels only. Empty slots are dropped; a category left with nobody
 * in it stays, so the ballot keeps the owner's categories in order, and simply
 * ends with no votes and no winner.
 *
 * @returns {{categories: Array<{role: string, label?: string, candidates: string[]}>}|null}
 */
export function normalizeBallot(raw) {
  const categories = (Array.isArray(raw?.categories) ? raw.categories : [])
    .slice(0, MAX_CATEGORIES)
    .map((c) => {
      const label = clip(c?.label);
      const candidates = (Array.isArray(c?.candidates) ? c.candidates : []).map(clip).filter(Boolean).slice(0, MAX_CANDIDATES);
      return { role: clip(c?.role), ...(label ? { label } : {}), candidates };
    })
    .filter((c) => c.role);
  return categories.length ? { categories } : null;
}

/** The poll's room, or null when the binding is missing. */
export function roomFor(env, id) {
  if (!env.POLL_ROOM) return null;
  return env.POLL_ROOM.get(env.POLL_ROOM.idFromName(id));
}

/** One command to a room: its status and body. */
export async function askRoom(room, command) {
  const res = await room.fetch('https://poll-room/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const readBody = async (request) => {
  try {
    return await request.json();
  } catch {
    return null;
  }
};

function track(env, ctx, event, properties) {
  const capture = capturePostHogEvent(env, event, { distinct_id: 'polls', $process_person_profile: false, ...properties });
  if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(capture);
  return capture;
}

function webOrigin(request, env) {
  if (typeof env?.WEB_ORIGIN === 'string' && env.WEB_ORIGIN) return env.WEB_ORIGIN.replace(/\/+$/, '');
  return new URL(request.url).origin;
}

/** POST /api/polls — open a poll. */
async function createPoll(request, env, ctx) {
  if (request.method !== 'POST') return methodNotAllowed();
  const session = readSession(request, env);
  if (!session?.uid) return unauthorized();
  if (!(await flagEnabled(env, 'polls', { uid: session.uid }, ctx))) return notFound();

  // A club device's club plan counts too, as everywhere else.
  const clubId = readClub(request, env)?.clubId ?? null;
  const access = await resolveAccess(env, { uid: session.uid, clubId });
  if (!access.entitled) return json({ error: 'upgrade_required', entitlement: access }, 402);

  const body = await readBody(request);
  const ballot = normalizeBallot(body?.ballot);
  if (!ballot) return json({ error: 'invalid_ballot' }, 400);

  if (!env.POLL_ROOM) return notConfigured('Poll storage');

  const hours = Number(body?.expiryHours);
  const expiryHours = Number.isFinite(hours) && hours > 0 ? Math.min(DEFAULT_EXPIRY_HOURS, hours) : DEFAULT_EXPIRY_HOURS;
  // Without a context we can trust, the poll still works by link only.
  const mid = decryptAppContext(body?.context, env.ZOOM_CLIENT_SECRET)?.mid ?? null;
  const midHash = midHashFor(mid);

  const id = mintShareToken();
  const created = await askRoom(roomFor(env, id), {
    op: 'create',
    id,
    ballot,
    ownerHash: ownerHashFor(env, id, session.uid),
    midHash,
    expiresAt: Date.now() + expiryHours * HOUR,
  });
  if (created.status !== 201) return json({ error: 'create_failed' }, 503);

  // So an invited participant's app can find the poll from its own context.
  if (midHash) {
    await env.PROFILES?.put(pollByMidKey(midHash), id, { expirationTtl: Math.max(60, Math.round(expiryHours * 3600)) });
  }

  track(env, ctx, 'poll_opened', { categories: ballot.categories.length, in_meeting: Boolean(midHash) });
  return json({ id, url: `${webOrigin(request, env)}/vote/${id}`, ballot }, 201);
}

/** POST /api/polls/current — the open poll of the caller's meeting. */
async function currentPoll(request, env) {
  if (request.method !== 'POST') return methodNotAllowed();
  const body = await readBody(request);
  const context = body?.context ? decryptAppContext(body.context, env.ZOOM_CLIENT_SECRET) : null;
  if (body?.context && !context) return json({ error: 'invalid_context' }, 400);
  const midHash = midHashFor(context?.mid);
  if (!midHash || !env.PROFILES || !env.POLL_ROOM) return notFound();

  const id = await env.PROFILES.get(pollByMidKey(midHash)).catch(() => null);
  if (!isShareToken(id)) return notFound();
  const { status, body: poll } = await askRoom(roomFor(env, id), { op: 'ballot' });
  if (status !== 200 || poll.status !== 'open' || poll.midHash !== midHash) return notFound();
  return json({ id, ballot: poll.ballot });
}

/** The ballot as anyone may see it, or null. */
async function readBallot(env, id) {
  if (!isShareToken(id) || !env.POLL_ROOM) return null;
  const { status, body } = await askRoom(roomFor(env, id), { op: 'ballot' });
  return status === 200 ? { id, ballot: body.ballot, status: body.status } : null;
}

async function linkLimited(request, env, id) {
  if (!env.POLL_VOTE_LIMITER?.limit) return false;
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  try {
    const { success } = await env.POLL_VOTE_LIMITER.limit({ key: `${id}:${ip}` });
    return !success;
  } catch {
    // A limiter outage must not stop a club from voting.
    return false;
  }
}

/** POST /api/polls/<id>/votes */
async function castVote(request, env, ctx, id) {
  if (request.method !== 'POST') return methodNotAllowed();
  const body = await readBody(request);
  if (!body || typeof body.choices !== 'object' || body.choices === null) return json({ error: 'invalid_choice' }, 400);
  const device = typeof body.device === 'string' && body.device && body.device.length <= MAX_DEVICE ? body.device : null;

  let path;
  let key;
  let midHash = null;
  if (body.context !== undefined && body.context !== null) {
    const context = decryptAppContext(body.context, env.ZOOM_CLIENT_SECRET);
    if (!context) return json({ error: 'invalid_context' }, 400);
    midHash = midHashFor(context.mid);
    if (context.uid) {
      path = 'zoom';
      key = `uid:${context.uid}`;
    } else {
      if (!device) return json({ error: 'device_required' }, 400);
      path = 'guest';
      key = `device:${device}`;
    }
  } else {
    if (!device) return json({ error: 'device_required' }, 400);
    path = 'link';
    key = `device:${device}`;
    if (await linkLimited(request, env, id)) return json({ error: 'rate_limited' }, 429);
  }

  if (!env.POLL_ROOM) return notFound();
  const { status, body: result } = await askRoom(roomFor(env, id), {
    op: 'vote',
    choices: body.choices,
    voterHash: voterHash(env, id, key),
    path,
    midHash,
  });
  if (status === 200) track(env, ctx, 'poll_vote_cast', { path });
  return json(result, status);
}

/** GET results and POST close: the owner's session, compared as a hash in the room. */
async function ownerCommand(request, env, ctx, id, op) {
  if (request.method !== (op === 'results' ? 'GET' : 'POST')) return methodNotAllowed();
  const session = readSession(request, env);
  if (!session?.uid) return unauthorized();
  if (!env.POLL_ROOM) return notFound();

  const { status, body } = await askRoom(roomFor(env, id), { op, ownerHash: ownerHashFor(env, id, session.uid) });
  if (op === 'close' && status === 200) {
    const { midHash, firstClose, ...closed } = body;
    if (midHash && env.PROFILES) {
      // Only if it still points here: a later poll in the same meeting owns it now.
      const indexed = await env.PROFILES.get(pollByMidKey(midHash)).catch(() => null);
      if (indexed === id) await env.PROFILES.delete(pollByMidKey(midHash));
    }
    if (firstClose) track(env, ctx, 'poll_closed', { categories: closed.winners.length });
    return json(closed);
  }
  return json(body, status);
}

/**
 * Dispatch for /api/polls and everything under it.
 */
export function handlePolls(request, url, env, ctx) {
  const route = url.pathname.slice('/api/polls'.length).replace(/^\/+|\/+$/g, '');
  if (route === '') return createPoll(request, env, ctx);
  if (route === 'current') return currentPoll(request, env);
  if (route === 'zoom') return handleZoomPollCreate(request, env, ctx);

  const [id, tail, ...extra] = route.split('/');
  if (extra.length || !isShareToken(id)) return notFound();
  if (tail === 'ballot') {
    if (request.method !== 'GET') return methodNotAllowed();
    return readBallot(env, id).then((poll) => (poll ? json(poll) : notFound()));
  }
  if (tail === 'votes') return castVote(request, env, ctx, id);
  if (tail === 'results' || tail === 'close') return ownerCommand(request, env, ctx, id, tail);
  return notFound();
}

// ---------------------------------------------------------------------------
// The backup voting page
// ---------------------------------------------------------------------------

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex',
};

function page(title, body, status = 200) {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: #f3f4f6; color: #111827; }
main { max-width: 520px; margin: 0 auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; }
h1 { font-size: 20px; margin: 0 0 12px; }
fieldset { border: 1px solid #e5e7eb; border-radius: 8px; margin: 0 0 14px; padding: 10px 14px; }
legend { font-weight: 600; padding: 0 4px; }
label { display: block; padding: 6px 0; font-size: 16px; }
button { width: 100%; padding: 12px; font-size: 16px; font-weight: 600; color: #fff; background: #772432; border: 0; border-radius: 8px; }
.note { color: #6b7280; font-size: 13px; }
#message { font-weight: 600; margin: 12px 0 0; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`,
    { status, headers: PAGE_HEADERS }
  );
}

const notFoundPage = () =>
  page('Poll not found', '<h1>That poll is not available</h1><p>It may have expired. Ask whoever shared it for a fresh link.</p>', 404);

// The device token: one vote per device and category, and the server says so.
const VOTE_SCRIPT = (id) => `<script>
(function () {
  var form = document.getElementById('ballot');
  var message = document.getElementById('message');
  var device;
  try {
    device = localStorage.getItem('tm_vote_device');
    if (!device) {
      device = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
      localStorage.setItem('tm_vote_device', device);
    }
  } catch (e) {
    device = String(Math.random()).slice(2) + Date.now();
  }
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var choices = {};
    var picked = form.querySelectorAll('input[type=radio]:checked');
    for (var i = 0; i < picked.length; i += 1) choices[picked[i].getAttribute('data-cat')] = Number(picked[i].value);
    if (!picked.length) { message.textContent = 'Pick a name first.'; return; }
    message.textContent = 'Sending…';
    fetch('/api/polls/${id}/votes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choices: choices, device: device })
    }).then(function (res) {
      if (res.ok) { form.remove(); message.textContent = 'Thanks, your vote is in.'; return; }
      if (res.status === 409) { message.textContent = 'You already voted from this device.'; return; }
      if (res.status === 410) { form.remove(); message.textContent = 'This poll is closed.'; return; }
      if (res.status === 429) { message.textContent = 'Too many votes from this network right now. Try again in a minute.'; return; }
      message.textContent = 'That did not go through. Try again.';
    }, function () {
      message.textContent = 'No connection. Try again.';
    });
  });
})();
</script>`;

/** GET /vote/<id> */
export async function handleVotePage(request, url, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed();
  const id = url.pathname.slice('/vote/'.length).replace(/\/+$/, '');
  const poll = await readBallot(env, id).catch(() => null);
  if (!poll) return notFoundPage();

  if (poll.status !== 'open') {
    return page('Poll closed', '<h1>This poll is closed</h1><p>Voting has ended. The results are with whoever ran the poll.</p>');
  }

  const fieldsets = poll.ballot.categories
    .map((category, c) => (category.candidates.length ? [category, c] : null))
    .filter(Boolean)
    .map(
      ([category, c]) => `<fieldset>
  <legend>${escapeHtml(category.label || category.role)}</legend>
  ${category.candidates
    .map((name, j) => `<label><input type="radio" name="c${c}" data-cat="${c}" value="${j}"> ${escapeHtml(name)}</label>`)
    .join('\n  ')}
</fieldset>`
    )
    .join('\n');

  return page(
    'Vote',
    `<h1>Cast your vote</h1>
<form id="ballot">
${fieldsets}
<button type="submit">Submit vote</button>
</form>
<p id="message" role="status"></p>
<p class="note">One vote per device. That stops a vote being counted twice by accident; it is no proof against someone determined to vote twice.</p>
${VOTE_SCRIPT(poll.id)}`
  );
}
