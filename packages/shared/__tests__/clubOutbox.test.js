import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setFlags } from '../flags.js';
import {
  CLUB_OUTBOX_STORAGE_KEY,
  drainOutbox,
  fetchHistory,
  readOutbox,
  recordSpeech,
  resetClubArchiveForTests,
} from '../clubArchive.js';
import { CLUB_STORAGE_KEY, resetClubForTests } from '../club.js';
import { resetEntitlementForTests } from '../entitlement.js';

/**
 * #167, AC-8: a speech finished offline, or before the Zoom session exists,
 * uploads later and is not dropped.
 *
 * The club copy has no club token any more; uploads carry the session. So the
 * outbox queues on the club alone, waits for a session token before sending,
 * and keeps an entry on a 401 (no session yet) as it does on a network error
 * or a 5xx. Only a refusal a retry can't fix (400/403/404) drops it.
 *
 * The drain keeps its existing `{ getToken, fetchImpl }` options; "no session"
 * is `getToken()` returning nothing.
 */

const EVENING = Date.UTC(2026, 8, 29, 23, 30);

/** The #167 club copy: tied to an account, no club token. */
const club = (over = {}) => ({
  uid: 'u-1',
  ver: 1,
  club: { id: 'club-1', name: 'Downtown Speakers' },
  kit: null,
  badge: null,
  timezone: 'America/Toronto',
  role: 'member',
  isOwner: false,
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

const status = (code) => async () => ({ ok: code >= 200 && code < 300, status: code, json: async () => ({}) });

const speech = (over = {}) => ({
  name: 'Alice',
  role: 'Standard Speech',
  duration: '5:50',
  color: 'green',
  comments: '',
  disqualified: false,
  ...over,
});

const headersOf = (call) =>
  Object.fromEntries(Object.entries(call?.[1]?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

beforeEach(() => {
  setFlags({ pro: true });
  localStorage.clear();
  resetClubForTests();
  resetClubArchiveForTests();
  resetEntitlementForTests();
  vi.setSystemTime(EVENING);
});

describe('recordSpeech with an account club (AC-8)', () => {
  it('queues a speech when a club is cached with no club token', () => {
    joinClub();
    const fetchImpl = vi.fn(status(200));

    const entry = recordSpeech(speech(), { getToken: () => null, fetchImpl });

    expect(entry).not.toBeNull();
    expect(readOutbox()).toHaveLength(1);
  });

  it('queues nothing for a device with no club, as before', () => {
    expect(recordSpeech(speech(), { getToken: () => 'session-token', fetchImpl: vi.fn() })).toBeNull();
    expect(readOutbox()).toEqual([]);
  });
});

describe('drainOutbox and the session (AC-8)', () => {
  async function queueOne() {
    joinClub();
    recordSpeech(speech({ speechId: 's-1' }), { getToken: () => null, fetchImpl: vi.fn(status(200)) });
    expect(JSON.parse(localStorage.getItem(CLUB_OUTBOX_STORAGE_KEY) ?? '[]')).toHaveLength(1);
    // Let the drain recordSpeech started (with no session) settle, so the next
    // drainOutbox call is a fresh run rather than that one.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('waits for a session token: nothing is sent and the speech stays queued', async () => {
    await queueOne();
    const fetchImpl = vi.fn(status(200));

    await drainOutbox({ getToken: () => null, fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readOutbox()).toHaveLength(1);
  });

  it('sends with the session once there is one, and no X-Club', async () => {
    await queueOne();
    const fetchImpl = vi.fn(status(200));

    const result = await drainOutbox({ getToken: () => 'session-token', fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/club\/meetings\/\d{8}(-\d+)?\/speeches$/);
    expect(headersOf(fetchImpl.mock.calls[0]).authorization).toBe('Bearer session-token');
    expect(headersOf(fetchImpl.mock.calls[0])['x-club']).toBeUndefined();
    expect(result).toMatchObject({ sent: 1, pending: 0 });
    expect(readOutbox()).toEqual([]);
  });

  it('keeps the speech on a network error', async () => {
    await queueOne();
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });

    await drainOutbox({ getToken: () => 'session-token', fetchImpl });

    expect(fetchImpl).toHaveBeenCalled();
    expect(readOutbox()).toHaveLength(1);
  });

  it.each([500, 503])('keeps the speech on a %i', async (code) => {
    await queueOne();
    const fetchImpl = vi.fn(status(code));

    await drainOutbox({ getToken: () => 'session-token', fetchImpl });

    expect(fetchImpl).toHaveBeenCalled();
    expect(readOutbox()).toHaveLength(1);
  });

  it('keeps the speech on a 401: the session is not there yet, the speech is fine', async () => {
    await queueOne();
    const fetchImpl = vi.fn(status(401));

    await drainOutbox({ getToken: () => 'session-token', fetchImpl });

    expect(fetchImpl).toHaveBeenCalled();
    expect(readOutbox()).toHaveLength(1);
  });

  it.each([400, 403, 404])('drops the speech on a %i, which a retry cannot fix', async (code) => {
    await queueOne();
    const fetchImpl = vi.fn(status(code));

    await drainOutbox({ getToken: () => 'session-token', fetchImpl });

    expect(fetchImpl).toHaveBeenCalled();
    expect(readOutbox()).toEqual([]);
  });
});

describe('reading the archive with an account club (AC-9)', () => {
  it('reads History with the session and no X-Club', async () => {
    joinClub();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ meetings: [] }) }));

    const result = await fetchHistory({ getToken: () => 'session-token', fetchImpl });

    expect(result).toMatchObject({ ok: true, meetings: [] });
    expect(headersOf(fetchImpl.mock.calls[0]).authorization).toBe('Bearer session-token');
    expect(headersOf(fetchImpl.mock.calls[0])['x-club']).toBeUndefined();
  });
});
