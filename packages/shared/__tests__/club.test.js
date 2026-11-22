import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetFlagsForTests, setFlags } from '../flags.js';
import { clubPresetsAvailable } from '../clubPresets.js';
import {
  CLUB_STORAGE_KEY,
  CLUB_PRESETS_STORAGE_KEY,
  PRESET_SOURCE_STORAGE_KEY,
  loadClub,
  clubLifecycle,
  clubGraceReminder,
  GRACE_REMINDER_WINDOW_DAYS,
  dismissGraceReminder,
  graceReminderDismissedToday,
  lapsedClubName,
  clubFeaturesOn,
  clubKit,
  PAST_DUE_GRACE_MS,
  CLUB_GRACE_DISMISSED_STORAGE_KEY,
  initClubFromCache,
  activateClub,
  createClub,
  refreshClub,
  forgetClub,
  leaveClub,
  syncClubWithIdentity,
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

const cached = (over = {}) => ({ uid: 'u-1', lastRefreshAt: NOW, ...clubState(), ...over });

/** Apply the cached club the one way a device does without the server: offline, authorized. */
const applyCached = () =>
  syncClubWithIdentity({ identified: false, uid: null, authStatus: 'authorized', reachable: false, entitlement: null });

const respondWith = (body, { ok = true, status = 200 } = {}) =>
  vi.fn(async () => ({ ok, status, json: async () => body }));

beforeEach(() => {
  // Club features need Pro released (clubFeaturesOn); the gate itself is
  // tested in club.test.js.
  setFlags({ pro: true });
  localStorage.clear();
  resetClubForTests();
  resetEntitlementForTests();
});

describe('the cached club', () => {
  // The copy belongs to an account, and which account is signed in is only
  // known once identity resolves (clubAccount.test.js covers that).
  it('is read, but not applied, before the first paint', () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));

    const club = initClubFromCache();

    expect(club).toMatchObject({ uid: 'u-1', club: { name: 'Downtown Speakers' } });
    expect(isEntitlementKnown()).toBe(false);
  });

  it('applies the plan when it is applied, and says nothing when the club is not entitled', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));
    await applyCached();
    expect(getEntitlement()).toMatchObject({ plan: 'pro', entitled: true, source: 'club' });

    resetClubForTests();
    resetEntitlementForTests();
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached({ plan: 'free', entitled: false })));
    await applyCached();
    expect(isEntitlementKnown()).toBe(false);
  });

  it('is a no-op with nothing cached, and tolerates junk', () => {
    expect(initClubFromCache()).toBeNull();

    localStorage.setItem(CLUB_STORAGE_KEY, 'not json');
    resetClubForTests();
    expect(loadClub()).toBeNull();

    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify({ club: { name: 'No id' } }));
    resetClubForTests();
    expect(loadClub()).toBeNull();
  });
});

describe('activateClub', () => {
  it('caches the club, sets the plan and tells subscribers', async () => {
    const seen = [];
    subscribeClub((club) => seen.push(club));
    const fetchImpl = respondWith({ ...clubState(), placesUsed: 2 });

    const result = await activateClub('dtsp-7k2qm9', { fetchImpl, getToken: () => 'bearer-token', uid: 'u-1' });

    expect(result).toMatchObject({ ok: true, placesUsed: 2 });
    expect(JSON.parse(localStorage.getItem(CLUB_STORAGE_KEY))).toMatchObject({
      uid: 'u-1',
      ver: 1,
      club: { name: 'Downtown Speakers' },
    });
    expect(getEntitlement()).toMatchObject({ plan: 'pro', entitled: true });
    expect(seen).toHaveLength(1);

    const [, init] = fetchImpl.mock.calls[0];
    // The code and nothing else: the account is the session's.
    expect(JSON.parse(init.body)).toEqual({ code: 'dtsp-7k2qm9' });
    expect(init.headers.Authorization).toBe('Bearer bearer-token');
  });

  // The web app's session is its cookie: no header of its own.
  it('sends no Authorization header without a token', async () => {
    const fetchImpl = respondWith(clubState());

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

  it('blames the network rather than the code when offline, or when the server cannot count', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
    expect(await activateClub('DTSP-7K2QM9', { fetchImpl })).toEqual({ ok: false, error: 'network' });

    const down = respondWith(null, { ok: false, status: 503 });
    expect(await activateClub('DTSP-7K2QM9', { fetchImpl: down })).toEqual({ ok: false, error: 'network' });

    // What the Worker actually answers when the place counter is down.
    const counterDown = respondWith({ error: 'try_again' }, { ok: false, status: 503 });
    expect(await activateClub('DTSP-7K2QM9', { fetchImpl: counterDown })).toEqual({ ok: false, error: 'network' });
  });

  it('refuses an empty code without asking the server', async () => {
    const fetchImpl = vi.fn();
    expect(await activateClub('   ', { fetchImpl })).toEqual({ ok: false, error: 'invalid_code' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('createClub', () => {
  const created = (over = {}) => ({
    created: true,
    code: 'DTSP-7K2QM9',
    shareUrl: 'https://www.example.test/pro/DTSP-7K2QM9',
    ...clubState({ role: 'admin', isOwner: true }),
    ...over,
  });

  // The creator must land exactly where a timer who typed the code lands, or
  // they would be shown a code and asked to type it back into their own app.
  it('caches the club for the creator, as its owner', async () => {
    const fetchImpl = respondWith(created());

    const result = await createClub({ clubName: 'Downtown Speakers' }, { fetchImpl, getToken: () => 'bearer-token', uid: 'u-1' });

    expect(result).toMatchObject({ ok: true, created: true, code: 'DTSP-7K2QM9' });
    expect(JSON.parse(localStorage.getItem(CLUB_STORAGE_KEY))).toMatchObject({
      uid: 'u-1',
      club: { name: 'Downtown Speakers' },
      role: 'admin',
      isOwner: true,
    });
    expect(getEntitlement()).toMatchObject({ plan: 'pro', entitled: true });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/club/create');
    expect(init.headers.Authorization).toBe('Bearer bearer-token');
  });

  it('sends the club name only when there is one, and the device timezone', async () => {
    const fetchImpl = respondWith(created());
    await createClub({ timezone: 'America/Toronto' }, { fetchImpl });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ timezone: 'America/Toronto' });
  });

  it('keeps the code and the link an admin has to share', async () => {
    const fetchImpl = respondWith(created());
    const result = await createClub({}, { fetchImpl });
    expect(result.shareUrl).toBe('https://www.example.test/pro/DTSP-7K2QM9');
    expect(loadClub()).toMatchObject({ code: 'DTSP-7K2QM9' });
  });

  // Pressing twice is a double-click, not a second club.
  it('reports a club that already existed without claiming to have made it', async () => {
    const fetchImpl = respondWith(created({ created: false }));
    expect(await createClub({}, { fetchImpl })).toMatchObject({ ok: true, created: false });
  });

  it('passes the server refusal through for the caller to phrase', async () => {
    const fetchImpl = respondWith({ error: 'not_a_subscriber' }, { ok: false, status: 403 });
    expect(await createClub({}, { fetchImpl })).toEqual({ ok: false, error: 'not_a_subscriber' });
    expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeNull();
  });

  it('blames the network when offline', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
    expect(await createClub({}, { fetchImpl })).toEqual({ ok: false, error: 'network' });
  });
});

describe('refreshClub', () => {
  it('asks the server with the session, and its answer replaces the copy', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached({ lastRefreshAt: NOW })));
    const later = NOW + 1000;
    const fetchImpl = respondWith(clubState({ ver: 4 }));

    const club = await refreshClub({ fetchImpl, getToken: () => 'bearer-token', now: later });

    expect(club).toMatchObject({ ver: 4, uid: 'u-1', lastRefreshAt: later });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/club');
    expect(init.headers).toEqual({ Authorization: 'Bearer bearer-token' });
  });

  // A new computer for the account has no copy yet: the server's is the whole club.
  it('takes the whole club, list included, when this device had none', async () => {
    const fetchImpl = respondWith(clubState({ presets: { rules: { Speech: { green: 1, yellow: 2, red: 3 } } } }));

    const club = await refreshClub({ fetchImpl, uid: 'u-1', now: NOW });

    expect(club).toMatchObject({ uid: 'u-1', club: { id: 'club-1' } });
    expect(JSON.parse(localStorage.getItem(CLUB_PRESETS_STORAGE_KEY))).toMatchObject({ rules: { Speech: { green: 1 } } });
  });

  // Offline is a non-event: a lapse can only land on a *successful* refresh at
  // app start, never mid-meeting.
  it('leaves the cache and the plan intact when the network fails', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));
    await applyCached();
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });

    const club = await refreshClub({ fetchImpl });

    expect(club).toMatchObject({ uid: 'u-1' });
    expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeTruthy();
    expect(getEntitlement()).toMatchObject({ plan: 'pro', entitled: true });
  });

  it('keeps the cache on a 500 and on an unreadable body', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));

    expect(await refreshClub({ fetchImpl: respondWith(null, { ok: false, status: 500 }) }))
      .toMatchObject({ uid: 'u-1' });
    expect(await refreshClub({ fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })) }))
      .toMatchObject({ uid: 'u-1' });
  });

  it('turns Pro off when the club has lapsed', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));
    await applyCached();
    const fetchImpl = respondWith(clubState({ plan: 'free', entitled: false, status: 'canceled', source: 'none' }));

    const club = await refreshClub({ fetchImpl });

    expect(club).toMatchObject({ entitled: false });
    expect(getEntitlement()).toMatchObject({ plan: 'free', entitled: false });
    // Nothing is hard-deleted: the device keeps knowing which club to re-check.
    expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeTruthy();
  });

  // The buyer who is also in their own club must not be talked down.
  it('never downgrades a personal subscription', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));
    setEntitlement({ plan: 'pro', entitled: true, status: 'active', source: 'subscription' });
    const fetchImpl = respondWith(clubState({ plan: 'free', entitled: false, source: 'none' }));

    await refreshClub({ fetchImpl });

    expect(getEntitlement()).toMatchObject({ plan: 'pro', entitled: true, source: 'subscription' });
  });

  it('forgets a club the server says this account is no longer in', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));
    await applyCached();

    expect(await refreshClub({ fetchImpl: respondWith({ error: 'no_club' }, { ok: false, status: 404 }) })).toBeNull();
    expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeNull();
    expect(getEntitlement()).toEqual(FREE_ENTITLEMENT);
  });

  // The account left club 1 and joined club 2 on another computer. Both clubs
  // are at ver 1, so the version alone can't tell the lists apart.
  it('replaces everything of the old club when the answer is another club', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));
    localStorage.setItem(CLUB_PRESETS_STORAGE_KEY, '{"rules":{"FromClubOne":{"green":60,"yellow":90,"red":120}}}');

    const other = clubState({
      club: { id: 'club-2', name: 'Uptown Talkers' },
      presets: { rules: { FromClubTwo: { green: 30, yellow: 45, red: 60 } } },
    });
    const entry = await refreshClub({ uid: 'u-1', fetchImpl: respondWith(other) });

    expect(entry).toMatchObject({ uid: 'u-1', club: { id: 'club-2', name: 'Uptown Talkers' } });
    expect(JSON.parse(localStorage.getItem(CLUB_PRESETS_STORAGE_KEY)).rules).toEqual(other.presets.rules);
  });
});

describe('leaveClub when the server cannot answer', () => {
  it('blames the network and keeps the club, whatever the 5xx body says', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));
    resetClubForTests();

    const result = await leaveClub({ fetchImpl: respondWith({ error: 'try_again' }, { ok: false, status: 503 }) });

    expect(result).toEqual({ ok: false, error: 'network' });
    expect(loadClub()).toMatchObject({ club: { id: 'club-1' } });
  });
});

describe('syncClubWithIdentity and a club change', () => {
  it('forgets the copy of a club the same account is no longer in before refreshing', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));
    localStorage.setItem(CLUB_PRESETS_STORAGE_KEY, '{"rules":{"FromClubOne":{"green":60,"yellow":90,"red":120}}}');
    resetClubForTests();

    // The refresh fails: nothing of club 1 may stay behind in the meantime.
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
    await syncClubWithIdentity({
      identified: true,
      uid: 'u-1',
      authStatus: 'authorized',
      reachable: true,
      entitlement: { plan: 'pro', entitled: true, source: 'club', club: { id: 'club-2', name: 'Uptown Talkers' } },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(CLUB_PRESETS_STORAGE_KEY)).toBeNull();
  });
});

const DAY = 24 * 60 * 60 * 1000;

describe('grace and lapse', () => {
  // The device follows the server's policy rather than inventing its own:
  // past_due keeps Pro for seven days past the period end.
  it('counts down a failed payment through the server\'s seven-day window', () => {
    localStorage.setItem(
      CLUB_STORAGE_KEY,
      JSON.stringify(cached({ status: 'past_due', currentPeriodEnd: NOW - 2 * DAY }))
    );

    expect(clubLifecycle(NOW)).toMatchObject({
      state: 'grace',
      clubName: 'Downtown Speakers',
      endsAt: NOW - 2 * DAY + PAST_DUE_GRACE_MS,
      daysLeft: 5,
    });
  });

  // A scheduled cancellation keeps Pro until the paid period runs out, with no
  // extra grace on top: that time was already paid for.
  it('counts a scheduled cancellation down to its paid period end', () => {
    localStorage.setItem(
      CLUB_STORAGE_KEY,
      JSON.stringify(cached({ status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: NOW + 3 * DAY }))
    );

    expect(clubLifecycle(NOW)).toMatchObject({ state: 'grace', daysLeft: 3, endsAt: NOW + 3 * DAY });
  });

  // A yearly plan set not to renew sits in grace for most of a year. Saying so
  // 316 days out is noise; the reminder waits for the last 60.
  it('reminds a club that will not renew only in its last 60 days', () => {
    const endingIn = (days) => {
      resetClubForTests();
      localStorage.setItem(
        CLUB_STORAGE_KEY,
        JSON.stringify(cached({ status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: NOW + days * DAY }))
      );
      return clubGraceReminder(NOW);
    };

    expect(GRACE_REMINDER_WINDOW_DAYS).toBe(60);
    expect(endingIn(316)).toBeNull();
    expect(endingIn(61)).toBeNull();
    expect(endingIn(60)).toBeNull();
    expect(endingIn(59.5)).toMatchObject({ state: 'grace', reason: 'not_renewing', daysLeft: 60 });
    expect(endingIn(3)).toMatchObject({ reason: 'not_renewing', daysLeft: 3 });
    // The lifecycle itself still says grace: only the reminder waits.
    endingIn(316);
    expect(clubLifecycle(NOW)).toMatchObject({ state: 'grace', reason: 'not_renewing' });
  });

  it('says nothing about a cancelled club with no end date to count down to', () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached({ status: 'canceled', currentPeriodEnd: null })));
    expect(clubLifecycle(NOW)).toMatchObject({ state: 'grace', reason: 'not_renewing', endsAt: null });
    expect(clubGraceReminder(NOW)).toBeNull();
  });

  // Still set to renew, but the card failed: Pro ends a week after, so it is
  // said at once, with or without a date.
  it('warns about a failed payment straight away', () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached({ status: 'past_due', currentPeriodEnd: NOW })));
    expect(clubGraceReminder(NOW)).toMatchObject({ reason: 'payment_failed', daysLeft: 7 });

    resetClubForTests();
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached({ status: 'past_due', currentPeriodEnd: null })));
    expect(clubGraceReminder(NOW)).toMatchObject({ reason: 'payment_failed', daysLeft: null });
  });

  it('says nothing at all about a healthy club, or about no club', () => {
    expect(clubLifecycle(NOW)).toBeNull();

    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));
    resetClubForTests();
    expect(clubLifecycle(NOW)).toMatchObject({ state: 'active' });
    expect(clubGraceReminder(NOW)).toBeNull();
  });

  // Only an admin can act on it; everyone else is told who to ask.
  it('offers the billing action to an admin and to nobody else', () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached({ status: 'past_due', currentPeriodEnd: NOW })));
    expect(clubGraceReminder(NOW)).toMatchObject({ isAdmin: false });

    resetClubForTests();
    localStorage.setItem(
      CLUB_STORAGE_KEY,
      JSON.stringify(cached({ status: 'past_due', currentPeriodEnd: NOW, role: 'admin' }))
    );
    expect(clubGraceReminder(NOW)).toMatchObject({ isAdmin: true });
  });

  // Quiet for the rest of the meeting, not for the rest of the grace window:
  // the person who can renew may not have opened the app yet.
  it('goes quiet for today and comes back tomorrow', () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached({ status: 'past_due', currentPeriodEnd: NOW })));

    expect(clubGraceReminder(NOW)).not.toBeNull();
    dismissGraceReminder(NOW);
    expect(graceReminderDismissedToday(NOW)).toBe(true);
    expect(clubGraceReminder(NOW)).toBeNull();
    expect(clubGraceReminder(NOW + DAY)).not.toBeNull();
  });

  // A lapsed club has had its week of warning already; a banner that returned
  // daily to a club nobody intends to renew would be nagging, not reminding.
  it('stops reminding once the club has lapsed, and names it instead', () => {
    localStorage.setItem(
      CLUB_STORAGE_KEY,
      JSON.stringify(cached({ plan: 'free', entitled: false, status: 'canceled', source: 'none' }))
    );

    expect(clubLifecycle(NOW)).toMatchObject({ state: 'lapsed' });
    expect(clubGraceReminder(NOW)).toBeNull();
    expect(lapsedClubName()).toBe('Downtown Speakers');
  });

  // The whole round trip, through the one path that can change it: a refresh.
  it('goes grace → lapsed → renewed, keeping the cache and the club\'s list throughout', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));
    localStorage.setItem(CLUB_PRESETS_STORAGE_KEY, '{"rules":{"Evaluator":{"green":120}}}');

    await refreshClub({
      fetchImpl: respondWith(clubState({ status: 'past_due', currentPeriodEnd: NOW - DAY })),
      force: true,
      now: NOW,
    });
    expect(clubLifecycle(NOW)).toMatchObject({ state: 'grace', daysLeft: 6 });
    expect(getEntitlement()).toMatchObject({ plan: 'pro', entitled: true });

    await refreshClub({
      fetchImpl: respondWith(clubState({ plan: 'free', entitled: false, status: 'canceled', source: 'none' })),
      force: true,
      now: NOW,
    });
    expect(clubLifecycle(NOW)).toMatchObject({ state: 'lapsed' });
    expect(getEntitlement()).toMatchObject({ plan: 'free', entitled: false });
    // Nothing is hard-deleted on the device either: the club and its published
    // list stay put, which is what makes renewal need no re-activation.
    expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeTruthy();
    expect(localStorage.getItem(CLUB_PRESETS_STORAGE_KEY)).toBeTruthy();

    await refreshClub({ fetchImpl: respondWith(clubState()), force: true, now: NOW });
    expect(clubLifecycle(NOW)).toMatchObject({ state: 'active' });
    expect(getEntitlement()).toMatchObject({ plan: 'pro', entitled: true, source: 'club' });
    expect(lapsedClubName()).toBeNull();
  });
});

describe('club features and the pro flag', () => {
  // One gate for every club surface: an active club, and Pro released.
  const KIT = { name: 'Downtown Speakers', showOnCards: true, showOnReports: true };

  const joinActive = (over = {}) => {
    resetClubForTests();
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached({ kit: KIT, ...over })));
    localStorage.setItem(CLUB_PRESETS_STORAGE_KEY, '{"rules":{"Evaluator":{"green":120}}}');
  };

  it('are on for an active club once pro is released', () => {
    joinActive();
    expect(clubFeaturesOn()).toBe(true);
    expect(clubKit()).toMatchObject({ name: 'Downtown Speakers' });
    expect(clubPresetsAvailable()).toBe(true);
  });

  it('are off while pro is off, with nothing deleted', () => {
    joinActive({ status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: NOW + 3 * DAY });
    setFlags({ pro: false });

    expect(clubFeaturesOn()).toBe(false);
    expect(clubKit()).toBeNull();
    expect(clubPresetsAvailable()).toBe(false);
    expect(clubGraceReminder(NOW)).toBeNull();
    // The device stays in its club, and its lifecycle is still the server's.
    expect(loadClub()).toMatchObject({ entitled: true });
    expect(clubLifecycle(NOW)).toMatchObject({ state: 'grace' });

    setFlags({ pro: true });
    expect(clubFeaturesOn()).toBe(true);
    expect(clubKit()).not.toBeNull();
    expect(clubGraceReminder(NOW)).not.toBeNull();
  });

  it('stay off until the flags have arrived, so nothing flashes at load', () => {
    joinActive();
    resetFlagsForTests();
    expect(clubFeaturesOn()).toBe(false);
    expect(clubKit()).toBeNull();
  });

  it('say nothing about a lapsed club while pro is off', () => {
    joinActive({ plan: 'free', entitled: false, status: 'canceled', source: 'none' });
    expect(lapsedClubName()).toBe('Downtown Speakers');
    setFlags({ pro: false });
    expect(lapsedClubName()).toBeNull();
  });

  it('stay off for a lapsed club whatever the flag says', () => {
    joinActive({ plan: 'free', entitled: false, status: 'canceled', source: 'none' });
    expect(clubFeaturesOn()).toBe(false);
    expect(clubKit()).toBeNull();
  });
});

describe('forgetClub', () => {
  it('clears the club and its presets, and returns the device to free', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));
    localStorage.setItem(CLUB_PRESETS_STORAGE_KEY, '{"rules":{}}');
    localStorage.setItem(PRESET_SOURCE_STORAGE_KEY, 'club');
    localStorage.setItem(CLUB_GRACE_DISMISSED_STORAGE_KEY, '2026-09-27');
    localStorage.setItem('toastmaster_role_rules', '{"Evaluator":{}}');
    await applyCached();

    expect(forgetClub()).toBe(true);

    expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(CLUB_PRESETS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(PRESET_SOURCE_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(CLUB_GRACE_DISMISSED_STORAGE_KEY)).toBeNull();
    expect(getEntitlement()).toEqual(FREE_ENTITLEMENT);
    // The device's own presets were never written over, so there is nothing to
    // restore — and nothing that may be taken away.
    expect(localStorage.getItem('toastmaster_role_rules')).toBe('{"Evaluator":{}}');
  });

  it('leaves a personal subscription alone', () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cached()));
    setEntitlement({ plan: 'pro', entitled: true, status: 'active', source: 'subscription' });

    forgetClub();

    expect(getEntitlement()).toMatchObject({ plan: 'pro', source: 'subscription' });
  });
});
