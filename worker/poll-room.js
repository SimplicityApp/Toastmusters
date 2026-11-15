import { capturePostHogEvent } from './posthog.js';
import { decryptRefreshToken, encryptRefreshToken, fetchPastPollAnswers, refreshZoomToken } from './polls-zoom.js';

/**
 * PollRoom: one Durable Object per meeting poll (#80).
 *
 * Votes need a strongly consistent count: KV's eventual consistency could
 * leave the last votes out of the tally read right after Close, and the
 * revealed winner would be wrong. One object per poll serialises every vote,
 * so the counts Close returns are final.
 *
 * The Worker decides who is asking (session, Zoom app context, device token)
 * and hands this object hashes only; it never sees a uid or a device token.
 * Its storage, key-value API only:
 *
 *   poll          { id, ballot, ownerHash, midHash, createdAt, expiresAt, status, closedAt }
 *   tally         { counts, byPath: {zoom, guest, link} }   counts[cat][cand]
 *   v:<voterHash> [catIndex, …]                             the categories that key voted in
 *   zoom          { token, numericId, uuid, tokenDeadline, fetchAt, attempt }
 *   zoomResults   { fetchedAt, questions: [{name, answers: {name: count}}] }
 *
 * One alarm per object, so it is always set to the earliest of the poll's
 * expiry, the refresh token's deadline and the next results fetch.
 */

export const PATHS = Object.freeze(['zoom', 'guest', 'link']);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
/** Zoom needs a few minutes after a meeting ends before its poll answers exist. */
export const ZOOM_RESULTS_DELAY_MS = 5 * MINUTE;
/** After an empty or missing answer: +15 min, then +60 min, then give up. */
export const ZOOM_RETRY_DELAYS_MS = Object.freeze([15 * MINUTE, 60 * MINUTE]);
/** The refresh token is deleted by this long after the native poll was created, whatever happened. */
export const ZOOM_TOKEN_LIFETIME_MS = 24 * HOUR;
/** A native poll's room outlives its token so the owner can still collect the results. */
export const NATIVE_POLL_LIFETIME_MS = 7 * 24 * HOUR;

const answer = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const zeros = (ballot) => ballot.categories.map((c) => c.candidates.map(() => 0));

/** Every name tied at the top count; nobody for a category with no votes. */
export function topNames(candidates, counts) {
  const top = Math.max(0, ...counts);
  if (!top) return [];
  return candidates.filter((_, i) => counts[i] === top);
}

export class PollRoom {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
  }

  /** The Worker's one door in: POST {op, …} → JSON. */
  async fetch(request) {
    let command;
    try {
      command = await request.json();
    } catch {
      return answer({ error: 'Invalid JSON' }, 400);
    }
    const now = Date.now();
    if (command?.op === 'create') return this.create(command, now);

    const poll = await this.storage.get('poll');
    // Expired but the alarm has not run yet: already gone, as far as anyone can tell.
    if (!poll || poll.expiresAt <= now) return answer({ error: 'not_found' }, 404);

    switch (command.op) {
      case 'ballot':
        return answer({ id: poll.id, ballot: poll.ballot, status: poll.status, midHash: poll.midHash });
      case 'vote':
        return this.vote(poll, command);
      case 'results':
        return this.ownerOnly(poll, command, async () => answer(await this.results(poll)));
      case 'close':
        return this.ownerOnly(poll, command, () => this.close(poll, now));
      case 'zoomAttach':
        return this.ownerOnly(poll, command, () => this.zoomAttach(poll, command, now));
      case 'meetingEnded':
        return this.meetingEnded(command, now);
      default:
        return answer({ error: 'Not found' }, 404);
    }
  }

  async create({ id, ballot, ownerHash, midHash, expiresAt }, now) {
    if (await this.storage.get('poll')) return answer({ error: 'exists' }, 409);
    const poll = { id, ballot, ownerHash, midHash: midHash ?? null, createdAt: now, expiresAt, status: 'open', closedAt: null };
    await this.storage.put({ poll, tally: { counts: zeros(ballot), byPath: Object.fromEntries(PATHS.map((p) => [p, zeros(ballot)])) } });
    await this.schedule();
    return answer({ ok: true }, 201);
  }

  ownerOnly(poll, { ownerHash }, run) {
    return ownerHash && ownerHash === poll.ownerHash ? run() : answer({ error: 'forbidden' }, 403);
  }

  /**
   * One ballot from one voter key. All of it lands or none of it does: a
   * second vote in any category it already voted in is a 409 and changes
   * nothing.
   */
  async vote(poll, { choices, voterHash, path, midHash }) {
    if (poll.status !== 'open') return answer({ error: 'closed' }, 410);
    // An in-Zoom vote must come from the meeting the poll was opened in.
    if (path !== 'link' && (!poll.midHash || midHash !== poll.midHash)) {
      return answer({ error: 'wrong_meeting' }, 403);
    }

    const picks = [];
    for (const [cat, cand] of Object.entries(choices ?? {})) {
      const c = Number(cat);
      const j = Number(cand);
      const candidates = poll.ballot.categories[c]?.candidates;
      if (!Number.isInteger(c) || !Number.isInteger(j) || !candidates || j < 0 || j >= candidates.length) {
        return answer({ error: 'invalid_choice' }, 400);
      }
      picks.push([c, j]);
    }
    if (!picks.length) return answer({ error: 'invalid_choice' }, 400);

    const voterKey = `v:${voterHash}`;
    const voted = (await this.storage.get(voterKey)) ?? [];
    if (picks.some(([c]) => voted.includes(c))) return answer({ error: 'already_voted' }, 409);

    const tally = await this.storage.get('tally');
    for (const [c, j] of picks) {
      tally.counts[c][j] += 1;
      tally.byPath[path][c][j] += 1;
    }
    await this.storage.put({ tally, [voterKey]: [...voted, ...picks.map(([c]) => c)] });
    return answer({ ok: true });
  }

  async results(poll) {
    const [tally, zoom] = await Promise.all([this.storage.get('tally'), this.storage.get('zoomResults')]);
    return { status: poll.status, counts: tally.counts, byPath: tally.byPath, zoom: zoom ?? null };
  }

  async close(poll, now) {
    if (poll.status === 'open') {
      await this.storage.put('poll', { ...poll, status: 'closed', closedAt: now });
    }
    const { counts, byPath } = await this.storage.get('tally');
    const winners = poll.ballot.categories.map((c, i) => topNames(c.candidates, counts[i]));
    return answer({ counts, byPath, winners, midHash: poll.midHash, firstClose: poll.status === 'open' });
  }

  /** The native Zoom poll was created: hold its (encrypted) refresh token until the meeting ends. */
  async zoomAttach(poll, { token, numericId, uuid }, now) {
    await this.storage.put({
      poll: { ...poll, expiresAt: Math.max(poll.expiresAt, now + NATIVE_POLL_LIFETIME_MS) },
      zoom: { token, numericId, uuid, tokenDeadline: now + ZOOM_TOKEN_LIFETIME_MS, fetchAt: null, attempt: 0 },
    });
    await this.schedule();
    return answer({ ok: true });
  }

  /** meeting.ended for the native poll's meeting: fetch the answers once Zoom has them. */
  async meetingEnded({ uuid }, now) {
    const zoom = await this.storage.get('zoom');
    if (!zoom?.token || zoom.fetchAt) return answer({ ok: true, scheduled: false });
    await this.storage.put('zoom', { ...zoom, uuid: uuid || zoom.uuid, fetchAt: now + ZOOM_RESULTS_DELAY_MS });
    await this.schedule();
    return answer({ ok: true, scheduled: true });
  }

  /** Point the one alarm at the earliest thing still due. */
  async schedule() {
    const [poll, zoom] = await Promise.all([this.storage.get('poll'), this.storage.get('zoom')]);
    if (!poll) return;
    const times = [poll.expiresAt];
    if (zoom?.token) times.push(zoom.tokenDeadline, ...(zoom.fetchAt ? [zoom.fetchAt] : []));
    await this.storage.setAlarm(Math.min(...times));
  }

  async alarm() {
    const now = Date.now();
    const poll = await this.storage.get('poll');
    if (!poll || poll.expiresAt <= now) {
      await this.storage.deleteAll();
      return;
    }
    const zoom = await this.storage.get('zoom');
    if (zoom?.token) {
      if (zoom.tokenDeadline <= now) {
        await this.storage.delete('zoom');
      } else if (zoom.fetchAt && zoom.fetchAt <= now) {
        await this.fetchZoomResults(poll, zoom, now);
      }
    }
    await this.schedule();
  }

  /**
   * Refresh the token, ask Zoom for the answers, keep the counts. Zoom rotates
   * the refresh token on every refresh, so while a retry is still pending the
   * rotated one replaces the stored one (encrypted the same way); once the
   * answers are in, or the last retry has failed, no token is left at all.
   */
  async fetchZoomResults(poll, zoom, now) {
    const attempt = zoom.attempt + 1;
    let rotated = null;
    let stored = null;
    try {
      const refreshToken = decryptRefreshToken(zoom.token, this.env, poll.id);
      const tokens = refreshToken ? await refreshZoomToken(this.env, refreshToken) : null;
      rotated = tokens?.refreshToken ?? null;
      if (tokens?.accessToken) {
        const answers = await fetchPastPollAnswers(tokens.accessToken, zoom.uuid, poll.ballot);
        if (answers) stored = answers;
      }
    } catch (error) {
      console.error('Zoom poll results fetch failed:', error?.message || error);
    }

    if (stored) {
      await this.storage.put('zoomResults', { fetchedAt: now, ...stored });
      await this.storage.delete('zoom');
      await capturePostHogEvent(this.env, 'zoom_poll_results_fetched', {
        distinct_id: 'poll-room',
        $process_person_profile: false,
        attempt,
        questions: stored.questions.length,
      });
      return;
    }
    const delay = ZOOM_RETRY_DELAYS_MS[attempt - 1];
    if (!delay || !rotated) {
      await this.storage.delete('zoom');
      return;
    }
    await this.storage.put('zoom', {
      ...zoom,
      token: encryptRefreshToken(rotated, this.env, poll.id),
      fetchAt: now + delay,
      attempt,
    });
  }
}
