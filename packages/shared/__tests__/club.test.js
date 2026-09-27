import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CLUB_STORAGE_KEY,
  CLUB_PRESETS_STORAGE_KEY,
  PRESET_SOURCE_STORAGE_KEY,
  CLUB_REFRESH_INTERVAL_MS,
  loadClub,
  clubHeaders,
  initClubFromCache,
  activateClub,
  refreshClub,
  leaveClub,
  subscribeClub,
  resetClubForTests,
} from '../club.js';
import {
  FREE_ENTITLEMENT,
  getEntitlement,
  isEntitlementKnown,
  setEntitlement,
  resetEntitlementForTests,
} from '../entitlement.js';

const NOW = 1_800_000_000_000;

const clubState = (over = {}) => ({
  ver: 1,
  club: { id: 'club-1', name: 'Downtown Speakers' },
  kit: null,
  presets: null,
  badge: null,
  timezone: 'America/Toronto',
  plan: 'pro',
  entitled: true,
  status: 'active',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  source: 'club',
  ...over,
});

const cached = (over = {}) => ({ clubToken: 'tok.sig', lastRefreshAt: NOW, ...clubState(), ...over });

const respondWith = (body, { ok = true, status = 200 } = {}) =>
  vi.fn(async () => ({ ok, status, json: async () => body }));

beforeEach(() => {
  localStorage.clear();
  resetClubForTests();
  resetEntitlementForTests();
});

describe('the cached club', () => {
  // Without this the device would take `known = true` from the session
  // response and flash "Upgrade" before the club refresh landed.
  it('seeds the entitlement store synchronously, before anything async starts', () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));

    expect(isEntitlementKnown()).toBe(false);
    const club = initClubFromCache();

    expect(club).toMatchObject({ club: { name: 'Downtown Speakers' } });
    expect(isEntitlementKnown()).toBe(true);
    expect(getEntitlement()).toMatchObject({ plan: 'pro', entitled: true, source: 'club' });
  });

  // A lapsed cached club says nothing: the session response answers for a
  // buyer who still has their own plan.
  it('says nothing when the cached club is not entitled', () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached({ plan: 'free', entitled: false })));

    initClubFromCache();
    expect(isEntitlementKnown()).toBe(false);
  });

  it('is a no-op with nothing cached, and tolerates junk', () => {
    expect(initClubFromCache()).toBeNull();
    expect(clubHeaders()).toEqual({});

    localStorage.setItem(CLUB_STORAGE_KEY, 'not json');
    resetClubForTests();
    expect(loadClub()).toBeNull();

    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify({ club: { name: 'No token' } }));
    resetClubForTests();
    expect(loadClub()).toBeNull();
  });

  it('carries the token in X-Club once there is one', () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));
    expect(clubHeaders()).toEqual({ 'X-Club': 'tok.sig' });
  });
});

describe('activateClub', () => {
  it('caches the club, sets the plan and tells subscribers', async () => {
    const seen = [];
    subscribeClub((club) => seen.push(club));
    const fetchImpl = respondWith({ clubToken: 'fresh.sig', ...clubState() });

    const result = await activateClub('dtsp-7k2qm9', { fetchImpl, getToken: () => 'bearer-token' });

    expect(result).toMatchObject({ ok: true });
    expect(JSON.parse(localStorage.getItem(CLUB_STORAGE_KEY))).toMatchObject({
      clubToken: 'fresh.sig',
      ver: 1,
      club: { name: 'Downtown Speakers' },
    });
    expect(getEntitlement()).toMatchObject({ plan: 'pro', entitled: true });
    expect(seen).toHaveLength(1);

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ code: 'dtsp-7k2qm9' });
    expect(init.headers.Authorization).toBe('Bearer bearer-token');
  });

  // The activating browser may have no Zoom identity at all.
  it('activates without a session token', async () => {
    const fetchImpl = respondWith({ clubToken: 'fresh.sig', ...clubState() });

    expect(await activateClub('DTSP-7K2QM9', { fetchImpl })).toMatchObject({ ok: true });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('reports a refusal without caching anything', async () => {
    const fetchImpl = respondWith({ error: 'invalid_code' }, { ok: false, status: 400 });

    expect(await activateClub('ZZZZ-999999', { fetchImpl })).toEqual({ ok: false, error: 'invalid_code' });
    expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeNull();
    expect(getEntitlement()).toEqual(FREE_ENTITLEMENT);
  });

  it('tells a throttled attempt apart from a wrong code', async () => {
    const fetchImpl = respondWith({ error: 'too_many_attempts' }, { ok: false, status: 429 });
    expect(await activateClub('DTSP-7K2QM9', { fetchImpl })).toEqual({ ok: false, error: 'too_many_attempts' });
  });

  it('blames the network rather than the code when offline', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
    expect(await activateClub('DTSP-7K2QM9', { fetchImpl })).toEqual({ ok: false, error: 'network' });
  });

  it('refuses an empty code without asking the server', async () => {
    const fetchImpl = vi.fn();
    expect(await activateClub('   ', { fetchImpl })).toEqual({ ok: false, error: 'invalid_code' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('refreshClub', () => {
  it('is a no-op inside 24 hours', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached({ lastRefreshAt: NOW })));
    const fetchImpl = vi.fn();

    const club = await refreshClub({ fetchImpl, now: NOW + CLUB_REFRESH_INTERVAL_MS - 1 });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(club).toMatchObject({ club: { name: 'Downtown Speakers' } });
  });

  it('asks again once a day, and carries both credentials', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached({ lastRefreshAt: NOW })));
    const later = NOW + CLUB_REFRESH_INTERVAL_MS;
    const fetchImpl = respondWith({ clubToken: 'rotated.sig', ...clubState({ ver: 4 }) });

    const club = await refreshClub({ fetchImpl, getToken: () => 'bearer-token', now: later });

    expect(club).toMatchObject({ ver: 4, clubToken: 'rotated.sig', lastRefreshAt: later });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers).toMatchObject({ 'X-Club': 'tok.sig', Authorization: 'Bearer bearer-token' });
  });

  it('does nothing at all when no club was ever joined', async () => {
    const fetchImpl = vi.fn();
    expect(await refreshClub({ fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Offline is a non-event: a lapse can only land on a *successful* refresh at
  // app start, never mid-meeting.
  it('leaves the cache and the plan intact when the network fails', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));
    initClubFromCache();
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });

    const club = await refreshClub({ fetchImpl, force: true });

    expect(club).toMatchObject({ clubToken: 'tok.sig' });
    expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeTruthy();
    expect(getEntitlement()).toMatchObject({ plan: 'pro', entitled: true });
  });

  it('keeps the cache on a 500 and on an unreadable body', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));

    expect(await refreshClub({ fetchImpl: respondWith(null, { ok: false, status: 500 }), force: true }))
      .toMatchObject({ clubToken: 'tok.sig' });
    expect(await refreshClub({ fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })), force: true }))
      .toMatchObject({ clubToken: 'tok.sig' });
  });

  it('turns Pro off when the club has lapsed', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));
    initClubFromCache();
    const fetchImpl = respondWith(clubState({ plan: 'free', entitled: false, status: 'canceled', source: 'none' }));

    const club = await refreshClub({ fetchImpl, force: true });

    expect(club).toMatchObject({ entitled: false });
    expect(getEntitlement()).toMatchObject({ plan: 'free', entitled: false });
    // Nothing is hard-deleted: the device keeps knowing which club to re-check.
    expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeTruthy();
  });

  // The buyer who also typed their own club's code must not be talked down.
  it('never downgrades a personal subscription', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));
    setEntitlement({ plan: 'pro', entitled: true, status: 'active', source: 'subscription' });
    const fetchImpl = respondWith(clubState({ plan: 'free', entitled: false, source: 'none' }));

    await refreshClub({ fetchImpl, force: true });

    expect(getEntitlement()).toMatchObject({ plan: 'pro', entitled: true, source: 'subscription' });
  });

  it('forgets a credential the server has revoked', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));
    initClubFromCache();

    expect(await refreshClub({ fetchImpl: respondWith({ error: 'club_access_revoked' }, { ok: false, status: 403 }), force: true })).toBeNull();
    expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeNull();
    expect(getEntitlement()).toEqual(FREE_ENTITLEMENT);
  });
});

describe('leaveClub', () => {
  it('clears the club and its presets, and returns the device to free', () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));
    localStorage.setItem(CLUB_PRESETS_STORAGE_KEY, '{"rules":{}}');
    localStorage.setItem(PRESET_SOURCE_STORAGE_KEY, 'club');
    localStorage.setItem('toastmaster_role_rules', '{"Evaluator":{}}');
    initClubFromCache();

    expect(leaveClub()).toBe(true);

    expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(CLUB_PRESETS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(PRESET_SOURCE_STORAGE_KEY)).toBeNull();
    expect(getEntitlement()).toEqual(FREE_ENTITLEMENT);
    expect(clubHeaders()).toEqual({});
    // The device's own presets were never written over, so there is nothing to
    // restore — and nothing that may be taken away.
    expect(localStorage.getItem('toastmaster_role_rules')).toBe('{"Evaluator":{}}');
  });

  it('leaves a personal subscription alone', () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));
    setEntitlement({ plan: 'pro', entitled: true, status: 'active', source: 'subscription' });

    leaveClub();

    expect(getEntitlement()).toMatchObject({ plan: 'pro', source: 'subscription' });
  });
});
