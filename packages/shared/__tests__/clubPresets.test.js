import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CLUB_STORAGE_KEY,
  CLUB_PRESETS_STORAGE_KEY,
  PRESET_SOURCE_STORAGE_KEY,
  loadClub,
  loadClubPresets,
  refreshClub,
  activateClub,
  leaveClub,
  resetClubForTests,
} from '../club.js';
import {
  presetSource,
  hasPersonalCustomization,
  clubPresetsAvailable,
  clubPresetsLive,
  canPublishPresets,
  activeClubName,
  resolveActiveRules,
  resolveActiveHiddenBuiltins,
  resolveActiveRoleOrder,
  forkFromClub,
  resetToClub,
  useClubPresets,
  usePersonalPresets,
  ensureForked,
  publishPresets,
} from '../clubPresets.js';
import { DEFAULT_ROLE_RULES } from '../timingRules.js';
import { loadRoleRules, loadRoleOrder, loadHiddenBuiltinRoles } from '../storage.js';
import { resetEntitlementForTests } from '../entitlement.js';

/**
 * Which list is live, and what it costs to move between them.
 *
 * The whole design rests on one separation: the club's list lives in its own
 * key and the personal keys are never written while it is showing. That is what
 * makes "your own presets are kept aside untouched" free rather than a backup
 * nobody maintains.
 */

const NOW = 1_800_000_000_000;

const CLUB_RULES = {
  'Standard Speech': { green: 300, yellow: 360, red: 420, graceAfterRed: 30 },
  'Contest Speech': { green: 300, yellow: 360, red: 420, graceAfterRed: 30 },
};

const clubState = (over = {}) => ({
  ver: 1,
  club: { id: 'club-1', name: 'Downtown Speakers' },
  kit: null,
  presets: null,
  badge: null,
  timezone: null,
  role: null,
  plan: 'pro',
  entitled: true,
  status: 'active',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  source: 'club',
  ...over,
});

const publishedList = (over = {}) => ({
  rules: CLUB_RULES,
  order: ['Contest Speech'],
  hiddenBuiltins: ['Ice Breaker'],
  publishedBy: 'buyer-uid',
  publishedAt: NOW - 1000,
  ...over,
});

/** A device that has joined the club and holds its published list. */
function seedClubDevice({ club = {}, presets = publishedList() } = {}) {
  localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify({ clubToken: 'tok.sig', lastRefreshAt: NOW, ...clubState(club) }));
  if (presets) localStorage.setItem(CLUB_PRESETS_STORAGE_KEY, JSON.stringify(presets));
  resetClubForTests();
}

const respondWith = (body, { ok = true, status = 200 } = {}) =>
  vi.fn(async () => ({ ok, status, json: async () => body }));

beforeEach(() => {
  localStorage.clear();
  resetClubForTests();
  resetEntitlementForTests();
});

// ---------------------------------------------------------------------------

describe('which list a device opens on', () => {
  // The case the feature is sold on, and the overwhelming majority of devices.
  it('puts a device that never customized anything on the club\'s list', () => {
    seedClubDevice();

    expect(hasPersonalCustomization()).toBe(false);
    expect(presetSource()).toBe('club');
    expect(clubPresetsLive()).toBe(true);
    expect(resolveActiveRules()).toEqual({ 'Standard Speech': CLUB_RULES['Standard Speech'], 'Contest Speech': CLUB_RULES['Contest Speech'] });
  });

  // Overwriting years of someone's own setup the moment they type a code is the
  // one thing that would make activation feel like a loss.
  it('leaves a device that has its own presets on them', () => {
    localStorage.setItem('toastmaster_role_rules', JSON.stringify({ 'Standard Speech': { green: 1, yellow: 2, red: 3 } }));
    seedClubDevice();

    expect(hasPersonalCustomization()).toBe(true);
    expect(presetSource()).toBe('personal');
    expect(resolveActiveRules()['Standard Speech']).toEqual({ green: 1, yellow: 2, red: 3 });
    // Every built-in is still there: the personal path merges over the defaults.
    expect(resolveActiveRules()['Ice Breaker']).toEqual(DEFAULT_ROLE_RULES['Ice Breaker']);
  });

  // Absence of writes, not deep-equality against the defaults — which does not
  // drift when the built-in defaults change.
  it('counts a hidden built-in or a role order as customization on its own', () => {
    localStorage.setItem('toastmaster_hidden_builtin_roles', JSON.stringify(['Ice Breaker']));
    seedClubDevice();
    expect(presetSource()).toBe('personal');

    localStorage.setItem('toastmaster_hidden_builtin_roles', JSON.stringify([]));
    localStorage.setItem('toastmaster_role_order', JSON.stringify(['Contest Speech']));
    expect(presetSource()).toBe('personal');
  });

  it('runs the device\'s own list when there is no club at all', () => {
    expect(clubPresetsAvailable()).toBe(false);
    expect(clubPresetsLive()).toBe(false);
    expect(activeClubName()).toBeNull();
    expect(resolveActiveRules()).toEqual(DEFAULT_ROLE_RULES);
  });

  // The lapse behaviour falls out of this with nothing deleted: on renewal the
  // club's list is still sitting in its key, so there is nothing to restore.
  it('falls back to the built-ins the moment the club stops being entitled', () => {
    seedClubDevice({ club: { entitled: false, plan: 'free', status: 'canceled' } });

    expect(clubPresetsAvailable()).toBe(false);
    expect(resolveActiveRules()).toEqual(DEFAULT_ROLE_RULES);
    // Nothing was thrown away, so renewal needs no re-activation.
    expect(loadClubPresets()).toMatchObject({ rules: CLUB_RULES });
  });

  // A built-in the admin removed is absent from the rules map, so roleOptions
  // has to learn about it separately or it is offered with factory timings.
  it('reports the club\'s hidden built-ins and role order while the club list shows', () => {
    seedClubDevice();
    // Every built-in the club's list does not contain, whether or not the
    // publish spelled it out — otherwise roleOptions would keep offering a role
    // the admin removed, with factory timings behind it.
    expect(resolveActiveHiddenBuiltins()).toContain('Ice Breaker');
    expect(resolveActiveHiddenBuiltins()).toContain('Short Roles');
    expect(resolveActiveHiddenBuiltins()).not.toContain('Standard Speech');
    expect(resolveActiveRoleOrder()).toEqual(['Contest Speech']);

    usePersonalPresets();
    expect(resolveActiveHiddenBuiltins()).toEqual([]);
    expect(resolveActiveRoleOrder()).toEqual([]);
  });

  it('never resurrects a built-in the admin removed', () => {
    seedClubDevice();
    expect(resolveActiveRules()['Ice Breaker']).toBeUndefined();
  });
});

describe('forking the club\'s list', () => {
  it('copies all three keys and writes the switch explicitly', () => {
    seedClubDevice();

    expect(forkFromClub()).toBe(true);

    expect(loadRoleRules()).toEqual(CLUB_RULES);
    expect(loadRoleOrder()).toEqual(['Contest Speech']);
    // The derived list, because the personal path merges over the built-in
    // defaults: anything less would resurrect the roles the admin removed.
    expect(loadHiddenBuiltinRoles()).toContain('Ice Breaker');
    expect(loadHiddenBuiltinRoles()).toContain('Short Roles');
    // The forked list is the club's list, role for role.
    expect(resolveActiveRules()).toEqual(CLUB_RULES);
    // Explicit, so the switch never moves merely because the copy above made
    // hasPersonalCustomization() true as a side effect.
    expect(localStorage.getItem(PRESET_SOURCE_STORAGE_KEY)).toBe('personal');
    // The club's own list is untouched, which is why "reset to club" is not a
    // data operation at all.
    expect(loadClubPresets()).toMatchObject({ rules: CLUB_RULES });
  });

  it('puts the device back on the club with resetToClub', () => {
    seedClubDevice();
    forkFromClub();

    expect(resetToClub()).toBe(true);
    expect(presetSource()).toBe('club');
    expect(hasPersonalCustomization()).toBe(false);
    expect(resolveActiveRules()).toEqual(CLUB_RULES);
  });

  it('refuses to reset a device whose club has no list to go back to', () => {
    seedClubDevice({ presets: null });
    expect(resetToClub()).toBe(false);
  });
});

describe('the fork guard', () => {
  it('asks once, forks on confirm, and the edit proceeds', async () => {
    seedClubDevice();
    const confirm = vi.fn(async () => true);

    expect(await ensureForked(confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(presetSource()).toBe('personal');
  });

  // Cancel must write nothing at all: the modal stays open with the edit on
  // screen, and the club's list is still what this device is running.
  it('writes nothing on cancel', async () => {
    seedClubDevice();

    expect(await ensureForked(async () => false)).toBe(false);
    expect(loadRoleRules()).toBeNull();
    expect(localStorage.getItem(PRESET_SOURCE_STORAGE_KEY)).toBeNull();
    expect(presetSource()).toBe('club');
  });

  it('does not ask at all on a device already running its own list', async () => {
    seedClubDevice();
    usePersonalPresets();
    const confirm = vi.fn();

    expect(await ensureForked(confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('does not ask on a device with no club', async () => {
    const confirm = vi.fn();
    expect(await ensureForked(confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('a publish arriving on a device', () => {
  // Content moves only when `ver` moves. Everything else about the club — the
  // plan above all — is applied on every refresh.
  it('replaces the club\'s list on a version move, and leaves it alone otherwise', async () => {
    seedClubDevice();
    const nextList = publishedList({ rules: { Speech: { green: 1, yellow: 2, red: 3 } }, order: [], hiddenBuiltins: [] });

    await refreshClub({
      force: true,
      now: NOW,
      fetchImpl: respondWith({ clubToken: 'tok.sig', ...clubState({ ver: 1, presets: nextList }) }),
    });
    expect(loadClubPresets().rules).toEqual(CLUB_RULES);

    await refreshClub({
      force: true,
      now: NOW,
      fetchImpl: respondWith({ clubToken: 'tok.sig', ...clubState({ ver: 2, presets: nextList }) }),
    });
    expect(loadClubPresets().rules).toEqual(nextList.rules);
    expect(loadClub().ver).toBe(2);
  });

  // A device sitting on its own presets simply has a newer club list waiting
  // behind the toggle.
  it('never moves the switch', async () => {
    seedClubDevice();
    usePersonalPresets();

    await refreshClub({
      force: true,
      now: NOW,
      fetchImpl: respondWith({ clubToken: 'tok.sig', ...clubState({ ver: 9, presets: publishedList({ rules: { Speech: { green: 1, yellow: 2, red: 3 } } }) }) }),
    });

    expect(presetSource()).toBe('personal');
    expect(localStorage.getItem(PRESET_SOURCE_STORAGE_KEY)).toBe('personal');
  });

  // Activation is the one moment a device has no list at all.
  it('takes the club\'s list on activation', async () => {
    const result = await activateClub('DTSP-7K2QM9', {
      fetchImpl: respondWith({ clubToken: 'tok.sig', ...clubState({ presets: publishedList() }) }),
    });

    expect(result.ok).toBe(true);
    expect(loadClubPresets()).toMatchObject({ rules: CLUB_RULES });
    expect(resolveActiveRules()).toEqual(CLUB_RULES);
  });

  it('takes the club\'s list off the device when it leaves', () => {
    seedClubDevice();
    usePersonalPresets();
    localStorage.setItem('toastmaster_role_rules', JSON.stringify({ Mine: { green: 1, yellow: 2, red: 3 } }));

    leaveClub();

    expect(localStorage.getItem(CLUB_PRESETS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(PRESET_SOURCE_STORAGE_KEY)).toBeNull();
    // A deletion, never a restore: the personal keys were never written over.
    expect(loadRoleRules()).toEqual({ Mine: { green: 1, yellow: 2, red: 3 } });
  });
});

describe('publishing', () => {
  it('sends the club token and takes the answer as the new list', async () => {
    seedClubDevice({ club: { role: 'admin' } });
    const nextRules = { Speech: { green: 1, yellow: 2, red: 3 } };
    const fetchImpl = respondWith({ ver: 7, presets: publishedList({ rules: nextRules }) });

    const result = await publishPresets({ rules: nextRules, order: [], hiddenBuiltins: [] }, { getToken: () => 'sess', fetchImpl });

    expect(result).toMatchObject({ ok: true, ver: 7 });
    const [path, init] = fetchImpl.mock.calls[0];
    expect(path).toBe('/api/club/presets');
    expect(init.method).toBe('PUT');
    expect(init.headers['X-Club']).toBe('tok.sig');
    expect(init.headers.Authorization).toBe('Bearer sess');
    expect(JSON.parse(init.body)).toEqual({ rules: nextRules, order: [], hiddenBuiltins: [] });

    // Recording the version is what stops the next refresh treating the
    // publisher's own device as out of date.
    expect(loadClub().ver).toBe(7);
    expect(loadClubPresets().rules).toEqual(nextRules);
  });

  it('reports a refusal without changing anything on the device', async () => {
    seedClubDevice();
    const result = await publishPresets(
      { rules: CLUB_RULES },
      { fetchImpl: respondWith({ error: 'forbidden' }, { ok: false, status: 403 }) }
    );

    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(loadClub().ver).toBe(1);
  });

  it('never rejects when the network is down', async () => {
    seedClubDevice();
    const result = await publishPresets({ rules: CLUB_RULES }, { fetchImpl: vi.fn(async () => { throw new Error('offline'); }) });
    expect(result).toEqual({ ok: false, error: 'network' });
  });

  it('says so when this device has not joined a club', async () => {
    expect(await publishPresets({ rules: CLUB_RULES })).toEqual({ ok: false, error: 'no_club' });
  });
});

describe('who may publish', () => {
  // Roles live only on member records, so an anonymous device can use
  // everything and change nothing club-wide.
  it('is the admin and the editor, and nobody else', () => {
    seedClubDevice({ club: { role: 'admin' } });
    expect(canPublishPresets()).toBe(true);

    seedClubDevice({ club: { role: 'editor' } });
    expect(canPublishPresets()).toBe(true);

    seedClubDevice({ club: { role: 'member' } });
    expect(canPublishPresets()).toBe(false);

    seedClubDevice({ club: { role: null } });
    expect(canPublishPresets()).toBe(false);
  });

  it('is nobody once the club has lapsed', () => {
    seedClubDevice({ club: { role: 'admin', entitled: false } });
    expect(canPublishPresets()).toBe(false);
  });
});

describe('the club keys stay out of the synced profile', () => {
  it('writes them without announcing them to the sync layer', async () => {
    const { SYNCED_KEYS } = await import('../profileMerge.js');

    for (const key of [CLUB_STORAGE_KEY, CLUB_PRESETS_STORAGE_KEY, PRESET_SOURCE_STORAGE_KEY]) {
      expect(SYNCED_KEYS).not.toContain(key);
    }
  });
});
