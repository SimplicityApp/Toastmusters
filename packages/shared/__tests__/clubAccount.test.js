import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setFlags } from '../flags.js';
import * as club from '../club.js';
import {
  getEntitlement,
  isEntitlementKnown,
  setEntitlement,
  resetEntitlementForTests,
} from '../entitlement.js';

/**
 * #167: club Pro belongs to a Zoom account, not to a device.
 *
 * The device keeps a copy of the club tied to the account (`uid`) it was read
 * for, sends its session (never `X-Club`) on every club request, and applies
 * the copy only after identity has resolved: for the same account, or offline
 * while Zoom says the app is authorized. Never for another account, and never
 * for someone signed out or in guest mode.
 */

const NOW = 1_800_000_000_000;
const { CLUB_STORAGE_KEY } = club;

const clubState = (over = {}) => ({
  ver: 1,
  club: { id: 'club-1', name: 'Downtown Speakers' },
  kit: null,
  presets: null,
  cards: null,
  badge: null,
  timezone: 'America/Toronto',
  role: 'member',
  isOwner: false,
  code: null,
  shareUrl: null,
  plan: 'pro',
  entitled: true,
  status: 'active',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  source: 'club',
  ...over,
});

/** The new cache entry: tied to the account, no club token. */
const cachedFor = (uid, over = {}) => ({ uid, lastRefreshAt: NOW, ...clubState(), ...over });

const sessionEntitlement = (withClub = true) => ({
  plan: withClub ? 'pro' : 'free',
  status: withClub ? 'active' : null,
  entitled: withClub,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  source: withClub ? 'club' : 'none',
  club: withClub ? { id: 'club-1', name: 'Downtown Speakers' } : null,
});

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

let fetchMock;

/** Every request that went out, as `{ url, method, headers }`. */
const requests = () =>
  fetchMock.mock.calls.map(([url, init = {}]) => ({
    url: String(url),
    method: (init.method ?? 'GET').toUpperCase(),
    headers: Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    ),
    body: init.body,
  }));

function seed(entry) {
  localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(entry));
  club.resetClubForTests();
}

const stored = () => JSON.parse(localStorage.getItem(CLUB_STORAGE_KEY) ?? 'null');

beforeEach(() => {
  setFlags({ pro: true });
  localStorage.clear();
  sessionStorage.clear();
  club.resetClubForTests();
  resetEntitlementForTests();
  fetchMock = vi.fn(async () => response(clubState()));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the club copy on this device (AC-7, AC-8)', () => {
  it('is keyed on the club, not on a club token: a new-shape entry loads', () => {
    seed(cachedFor('u-1'));
    expect(club.loadClub()).toMatchObject({ uid: 'u-1', club: { id: 'club-1' } });
  });

  it('drops an old token-shaped entry from before #167', () => {
    seed({ clubToken: 'tok.sig', lastRefreshAt: NOW, ...clubState() });
    expect(club.loadClub()).toBeNull();
  });

  it('is not applied before the first paint any more (Q4)', () => {
    seed(cachedFor('u-1'));
    // The copy is readable; it just isn't applied until identity resolves.
    expect(club.loadClub()).toMatchObject({ uid: 'u-1' });
    club.initClubFromCache();
    expect(isEntitlementKnown()).toBe(false);
    expect(getEntitlement()).toMatchObject({ entitled: false });
  });

  it('has no device id and no X-Club header helper', () => {
    expect(club.clubHeaders).toBeUndefined();
    expect(club.clubDeviceId).toBeUndefined();
  });
});

describe('syncClubWithIdentity (AC-2, AC-8)', () => {
  it('is exported', () => {
    expect(club.syncClubWithIdentity).toBeTypeOf('function');
  });

  it('fetches the club with the session when the session says one exists and nothing is cached', async () => {
    fetchMock.mockImplementation(async () => response(clubState({ isOwner: false })));

    await club.syncClubWithIdentity?.({
      identified: true,
      uid: 'u-1',
      authStatus: 'authorized',
      reachable: true,
      entitlement: sessionEntitlement(true),
      getToken: () => 'session-token',
    });

    const gets = requests().filter((r) => r.url.endsWith('/api/club') && r.method === 'GET');
    expect(gets).toHaveLength(1);
    expect(gets[0].headers.authorization).toBe('Bearer session-token');
    expect(gets[0].headers['x-club']).toBeUndefined();

    expect(stored()).toMatchObject({ uid: 'u-1', club: { id: 'club-1', name: 'Downtown Speakers' } });
    expect(stored()).not.toHaveProperty('clubToken');
    expect(getEntitlement()).toMatchObject({ plan: 'pro', entitled: true, source: 'club' });
  });

  it('refreshes on every open for the same account, with no 24-hour skip', async () => {
    seed(cachedFor('u-1', { lastRefreshAt: Date.now() }));
    fetchMock.mockImplementation(async () => response(clubState({ ver: 2, club: { id: 'club-1', name: 'Renamed Club' } })));

    await club.syncClubWithIdentity?.({
      identified: true,
      uid: 'u-1',
      authStatus: 'authorized',
      reachable: true,
      entitlement: sessionEntitlement(true),
      getToken: () => 'session-token',
    });

    expect(requests().some((r) => r.url.endsWith('/api/club') && r.method === 'GET')).toBe(true);
    expect(stored()).toMatchObject({ uid: 'u-1', ver: 2, club: { name: 'Renamed Club' } });
  });

  it('clears the copy when the session says this account has no club, without a leave POST', async () => {
    seed(cachedFor('u-1'));

    await club.syncClubWithIdentity?.({
      identified: true,
      uid: 'u-1',
      authStatus: 'authorized',
      reachable: true,
      entitlement: sessionEntitlement(false),
      getToken: () => 'session-token',
    });

    expect(club.syncClubWithIdentity).toBeTypeOf('function');
    expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeNull();
    expect(club.loadClub()).toBeNull();
    expect(requests().filter((r) => r.method === 'POST')).toEqual([]);
    expect(getEntitlement()).toMatchObject({ entitled: false });
  });

  it('never applies another account\'s copy: a different uid clears it first', async () => {
    seed(cachedFor('u-1', { club: { id: 'club-a', name: 'Club A' } }));
    // The refresh for the new account fails, so only the old copy could make it Pro.
    fetchMock.mockImplementation(async () => {
      throw new Error('offline');
    });

    await club.syncClubWithIdentity?.({
      identified: true,
      uid: 'u-2',
      authStatus: 'authorized',
      reachable: true,
      entitlement: sessionEntitlement(true),
      getToken: () => 'session-token',
    });

    expect(club.syncClubWithIdentity).toBeTypeOf('function');
    expect(JSON.stringify(stored() ?? {})).not.toContain('club-a');
    expect(club.loadClub()?.club?.id).not.toBe('club-a');
    expect(getEntitlement().entitled && getEntitlement().source === 'club' && club.loadClub()?.uid === 'u-1').toBe(false);
  });

  it('keeps and applies the copy offline while Zoom says the app is authorized (Q3)', async () => {
    seed(cachedFor('u-1'));

    await club.syncClubWithIdentity?.({
      identified: false,
      uid: null,
      authStatus: 'authorized',
      reachable: false,
      entitlement: null,
      getToken: () => null,
    });

    expect(club.syncClubWithIdentity).toBeTypeOf('function');
    expect(stored()).toMatchObject({ uid: 'u-1', club: { id: 'club-1' } });
    expect(getEntitlement()).toMatchObject({ plan: 'pro', entitled: true, source: 'club' });
    expect(requests()).toEqual([]);
  });

  it.each([
    ['signed out of Zoom', 'unauthenticated', false],
    ['in guest mode', 'authenticated', false],
    ['signed out of Zoom, server reachable', 'unauthenticated', true],
    ['in guest mode, server reachable', 'authenticated', true],
  ])('never applies the copy when %s', async (_label, authStatus, reachable) => {
    seed(cachedFor('u-1'));

    await club.syncClubWithIdentity?.({
      identified: false,
      uid: null,
      authStatus,
      reachable,
      entitlement: null,
      getToken: () => null,
    });

    expect(club.syncClubWithIdentity).toBeTypeOf('function');
    expect(getEntitlement()).toMatchObject({ entitled: false });
    expect(requests().filter((r) => r.url.includes('/api/club'))).toEqual([]);
  });

  it('carries isOwner from the server answer on the copy', async () => {
    fetchMock.mockImplementation(async () =>
      response(clubState({ role: 'admin', isOwner: true, code: 'DTSP-7K2QM9', placesUsed: 2, placesTotal: 3 }))
    );

    await club.syncClubWithIdentity?.({
      identified: true,
      uid: 'u-owner',
      authStatus: 'authorized',
      reachable: true,
      entitlement: sessionEntitlement(true),
      getToken: () => 'session-token',
    });

    expect(club.loadClub()).toMatchObject({ isOwner: true, role: 'admin', placesUsed: 2, placesTotal: 3 });
  });
});

describe('refreshClub (AC-8)', () => {
  it('asks the server on every call, even inside 24 hours, with the session and no X-Club', async () => {
    seed(cachedFor('u-1', { lastRefreshAt: NOW }));

    await club.refreshClub({ getToken: () => 'session-token', fetchImpl: fetchMock, now: NOW + 60_000 });

    const gets = requests().filter((r) => r.url.endsWith('/api/club'));
    expect(gets).toHaveLength(1);
    expect(gets[0].headers.authorization).toBe('Bearer session-token');
    expect(gets[0].headers['x-club']).toBeUndefined();
  });

  it.each([401, 403, 404])('forgets the club locally on a %i, and sends no leave POST', async (status) => {
    seed(cachedFor('u-1'));
    setEntitlement({ plan: 'pro', entitled: true, status: 'active', source: 'club' });
    fetchMock.mockImplementation(async () => response({ error: 'no_club' }, status));

    const result = await club.refreshClub({ getToken: () => 'session-token', fetchImpl: fetchMock, force: true });

    expect(requests().filter((r) => r.url.endsWith('/api/club'))).toHaveLength(1);
    expect(result).toBeNull();
    expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeNull();
    expect(requests().filter((r) => r.url.includes('/api/club/leave'))).toEqual([]);
    expect(getEntitlement()).toMatchObject({ entitled: false });
  });

  it('keeps the copy when the network fails', async () => {
    seed(cachedFor('u-1'));
    fetchMock.mockImplementation(async () => {
      throw new Error('offline');
    });

    await club.refreshClub({ getToken: () => 'session-token', fetchImpl: fetchMock, force: true });

    expect(fetchMock).toHaveBeenCalled();
    expect(stored()).toMatchObject({ uid: 'u-1', club: { id: 'club-1' } });
  });
});

describe('forgetClub (AC-4, AC-8)', () => {
  it('clears the copy and the club Pro without telling the server', () => {
    seed(cachedFor('u-1'));
    setEntitlement({ plan: 'pro', entitled: true, status: 'active', source: 'club' });

    expect(club.forgetClub).toBeTypeOf('function');
    club.forgetClub?.();

    expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeNull();
    expect(club.loadClub()).toBeNull();
    expect(getEntitlement()).toMatchObject({ entitled: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('activateClub (AC-1, AC-3, AC-5, AC-7)', () => {
  it('joins with the session: Bearer, no device id, no X-Club, and no club token in the answer', async () => {
    fetchMock.mockImplementation(async () => response({ ...clubState(), placesUsed: 2 }));

    const result = await club.activateClub('dtsp-7k2qm9', { getToken: () => 'session-token', fetchImpl: fetchMock });

    expect(result).toMatchObject({ ok: true });
    const [post] = requests();
    expect(post.url).toContain('/api/club/activate');
    expect(post.headers.authorization).toBe('Bearer session-token');
    expect(post.headers['x-club']).toBeUndefined();
    expect(JSON.parse(post.body)).not.toHaveProperty('deviceId');
    expect(club.loadClub()).toMatchObject({ club: { id: 'club-1' } });
    expect(club.loadClub()).not.toHaveProperty('clubToken');
    expect(getEntitlement()).toMatchObject({ plan: 'pro', entitled: true });
  });

  it('passes "full" through with the place counts', async () => {
    fetchMock.mockImplementation(async () => response({ error: 'full', placesUsed: 3, placesTotal: 3 }, 409));

    const result = await club.activateClub('DTSP-7K2QM9', { getToken: () => 'session-token', fetchImpl: fetchMock });

    expect(result).toMatchObject({ ok: false, error: 'full', placesUsed: 3, placesTotal: 3 });
    expect(club.loadClub()).toBeNull();
  });

  it('passes "already_in_club" through with the other club\'s name', async () => {
    fetchMock.mockImplementation(async () => response({ error: 'already_in_club', clubName: 'Uptown Orators' }, 409));

    const result = await club.activateClub('DTSP-7K2QM9', { getToken: () => 'session-token', fetchImpl: fetchMock });

    expect(result).toMatchObject({ ok: false, error: 'already_in_club', clubName: 'Uptown Orators' });
  });

  it('passes "sign_in_required" through rather than calling it a bad code', async () => {
    fetchMock.mockImplementation(async () => response({ error: 'sign_in_required' }, 401));

    const result = await club.activateClub('DTSP-7K2QM9', { getToken: () => null, fetchImpl: fetchMock });

    expect(result).toMatchObject({ ok: false, error: 'sign_in_required' });
  });

  it('keeps "invalid_code" for a refused code (including a blocked account)', async () => {
    fetchMock.mockImplementation(async () => response({ error: 'invalid_code' }, 400));

    const result = await club.activateClub('DTSP-7K2QM9', { getToken: () => 'session-token', fetchImpl: fetchMock });

    expect(result).toMatchObject({ ok: false, error: 'invalid_code' });
  });
});

describe('leaveClub (AC-4, AC-12)', () => {
  it('POSTs with the session, no X-Club, and clears only after a 2xx', async () => {
    seed(cachedFor('u-1'));
    setEntitlement({ plan: 'pro', entitled: true, status: 'active', source: 'club' });
    fetchMock.mockImplementation(async () => response({ left: true }));

    const result = await club.leaveClub({ getToken: () => 'session-token', fetchImpl: fetchMock });

    const leaves = requests().filter((r) => r.url.includes('/api/club/leave'));
    expect(leaves).toHaveLength(1);
    expect(leaves[0].method).toBe('POST');
    expect(leaves[0].headers.authorization).toBe('Bearer session-token');
    expect(leaves[0].headers['x-club']).toBeUndefined();
    expect(result).toMatchObject({ ok: true });
    expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeNull();
    expect(getEntitlement()).toMatchObject({ entitled: false });
  });

  it.each(['owner', 'last_admin'])('returns a %s refusal and keeps the club', async (error) => {
    seed(cachedFor('u-1', { role: 'admin', isOwner: error === 'owner' }));
    setEntitlement({ plan: 'pro', entitled: true, status: 'active', source: 'club' });
    fetchMock.mockImplementation(async () => response({ error }, 409));

    const result = await club.leaveClub({ getToken: () => 'session-token', fetchImpl: fetchMock });

    expect(requests().filter((r) => r.url.includes('/api/club/leave'))).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, error });
    expect(stored()).toMatchObject({ uid: 'u-1', club: { id: 'club-1' } });
    expect(getEntitlement()).toMatchObject({ entitled: true });
  });

  it('keeps the club when the network fails', async () => {
    seed(cachedFor('u-1'));
    fetchMock.mockImplementation(async () => {
      throw new Error('offline');
    });

    const result = await club.leaveClub({ getToken: () => 'session-token', fetchImpl: fetchMock });

    expect(fetchMock).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false });
    expect(stored()).toMatchObject({ uid: 'u-1' });
  });
});
