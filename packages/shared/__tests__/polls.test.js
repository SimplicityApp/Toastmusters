import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { CLUB_STORAGE_KEY, CLUB_PRESETS_STORAGE_KEY, refreshClub, resetClubForTests } from '../club.js';
import { resetEntitlementForTests } from '../entitlement.js';

/**
 * Meeting polls (#80): the pure half, in packages/shared/polls.js.
 *
 *   defaultBallot()                         the three usual categories, three empty slots each
 *   ballotFromTemplate(template, reports, roleNames)
 *                                           this meeting's timed speakers, per category's role
 *   normalizeTemplate(raw)                  {categories: [{role, label?, slots}],
 *                                            options: {postToChat, showOnStage, expiryHours}}
 *   winners(counts)                         every name tied at the top count; none for zero votes
 *   activePollTemplate()                    club template (when the club's presets are available),
 *                                           else the personal one, else the default
 *
 * A ballot is `{categories: [{role, label?, candidates: [name, …]}]}`; an empty
 * slot is an empty-string candidate. `counts` maps a candidate's name to votes.
 *
 * Loaded dynamically so a missing module fails these assertions one by one
 * rather than the whole file at import.
 */

const DEFAULT_ROLES = ['Table Topics Speech', 'Standard Speech', 'Table Topics Evaluation'];

// A variable, so the bundler does not refuse the file before polls.js exists.
const POLLS_MODULE = '../polls.js';
let polls = {};
beforeAll(async () => {
  polls = await import(/* @vite-ignore */ POLLS_MODULE).catch(() => ({}));
});

const fn = (name) => {
  expect(typeof polls[name], `polls.js exports ${name}()`).toBe('function');
  return polls[name];
};

const report = (name, role, finishedAt) => ({
  speechId: `${name}-${finishedAt}`,
  name,
  role,
  duration: '1:30',
  color: 'green',
  comments: '',
  disqualified: false,
  finishedAt,
});

beforeEach(() => {
  localStorage.clear();
  resetClubForTests();
  resetEntitlementForTests();
});

describe('defaultBallot', () => {
  // AC-2: no template anywhere still gives a club its usual three votes.
  it('is Table Topics Speech, Standard Speech and Table Topics Evaluation, three empty slots each', () => {
    const ballot = fn('defaultBallot')();
    expect(ballot.categories.map((c) => c.role)).toEqual(DEFAULT_ROLES);
    for (const category of ballot.categories) expect(category.candidates).toEqual(['', '', '']);
  });

  it('hands out a fresh ballot each time, so editing one cannot change the next', () => {
    const first = fn('defaultBallot')();
    first.categories[0].candidates[0] = 'Edited';
    expect(fn('defaultBallot')().categories[0].candidates[0]).toBe('');
  });
});

describe('normalizeTemplate', () => {
  it('keeps the categories and options it knows, and nothing else', () => {
    const template = fn('normalizeTemplate')({
      categories: [
        { role: 'Standard Speech', label: 'Best Speaker', slots: 2, extra: 'dropped' },
        { role: 'Contest Speech', slots: 4 },
      ],
      options: { postToChat: true, showOnStage: false, expiryHours: 12, junk: 1 },
      junk: true,
    });

    expect(template.categories).toHaveLength(2);
    expect(template.categories[0]).toMatchObject({ role: 'Standard Speech', label: 'Best Speaker', slots: 2 });
    expect(template.categories[0]).not.toHaveProperty('extra');
    expect(template.categories[1]).toMatchObject({ role: 'Contest Speech', slots: 4 });
    expect(template.options).toMatchObject({ postToChat: true, showOnStage: false, expiryHours: 12 });
    expect(template.options).not.toHaveProperty('junk');
    expect(template).not.toHaveProperty('junk');
  });

  it('drops a category with no role', () => {
    const template = fn('normalizeTemplate')({ categories: [{ label: 'Nobody', slots: 3 }, { role: 'Standard Speech', slots: 3 }] });
    expect(template.categories.map((c) => c.role)).toEqual(['Standard Speech']);
  });
});

describe('ballotFromTemplate', () => {
  const template = {
    categories: [
      { role: 'Table Topics Speech', label: 'Best Table Topics Speaker', slots: 3 },
      { role: 'Standard Speech', label: 'Best Speaker', slots: 3 },
      { role: 'Table Topics Evaluation', slots: 2 },
    ],
    options: { postToChat: true, showOnStage: false, expiryHours: 24 },
  };
  const roleNames = [...DEFAULT_ROLES, 'Ice Breaker'];

  // AC-5: the timer already knows who spoke in each role.
  it('makes each category\'s candidates the distinct names timed in its role, in timing order', () => {
    const reports = [
      report('Bob', 'Table Topics Speech', 1_000),
      report('Alice', 'Standard Speech', 2_000),
      report('Carol', 'Table Topics Speech', 3_000),
      report('Bob', 'Table Topics Speech', 4_000),
      report('Ann', 'Ice Breaker', 5_000),
      report('Dan', 'Table Topics Speech', 6_000),
    ];

    const ballot = fn('ballotFromTemplate')(template, reports, roleNames);

    expect(ballot.categories[0]).toMatchObject({ role: 'Table Topics Speech', label: 'Best Table Topics Speaker' });
    expect(ballot.categories[0].candidates).toEqual(['Bob', 'Carol', 'Dan']);
    expect(ballot.categories[1].candidates).toEqual(['Alice']);
  });

  it('gives a category with nobody timed its empty slots', () => {
    const ballot = fn('ballotFromTemplate')(template, [report('Bob', 'Table Topics Speech', 1_000)], roleNames);
    expect(ballot.categories[1].candidates).toEqual(['', '', '']);
    expect(ballot.categories[2].candidates).toEqual(['', '']);
  });

  it('skips a speech timed with no name', () => {
    const ballot = fn('ballotFromTemplate')(
      template,
      [report('', 'Table Topics Speech', 1_000), report('Bob', 'Table Topics Speech', 2_000)],
      roleNames
    );
    expect(ballot.categories[0].candidates).toEqual(['Bob']);
  });
});

describe('winners', () => {
  // AC-8 and Q8.
  it('is the single top name when there is one', () => {
    expect(fn('winners')({ Alice: 4, Bob: 2, Carol: 1 })).toEqual(['Alice']);
  });

  it('is every name tied at the top count', () => {
    expect(fn('winners')({ Alice: 3, Bob: 3, Carol: 1 })).toEqual(['Alice', 'Bob']);
  });

  it('is nobody when the category got no votes', () => {
    expect(fn('winners')({ Alice: 0, Bob: 0 })).toEqual([]);
    expect(fn('winners')({})).toEqual([]);
  });
});

describe('activePollTemplate', () => {
  const PERSONAL = {
    categories: [{ role: 'Ice Breaker', label: 'Best Icebreaker', slots: 2 }],
    options: { postToChat: false, showOnStage: true, expiryHours: 6 },
  };
  const CLUB = {
    categories: [{ role: 'Contest Speech', label: 'Best Contestant', slots: 4 }],
    options: { postToChat: true, showOnStage: false, expiryHours: 12 },
  };

  function joinClub({ entitled = true } = {}) {
    localStorage.setItem(
      CLUB_STORAGE_KEY,
      JSON.stringify({
        clubToken: 'tok.sig',
        ver: 2,
        lastRefreshAt: Date.now(),
        club: { id: 'club-1', name: 'Downtown Speakers' },
        plan: entitled ? 'pro' : 'free',
        entitled,
        status: entitled ? 'active' : 'canceled',
        source: 'club',
      })
    );
    localStorage.setItem(CLUB_PRESETS_STORAGE_KEY, JSON.stringify({ rules: { 'Contest Speech': { green: 1, yellow: 2, red: 3 } }, order: [], hiddenBuiltins: [] }));
    localStorage.setItem('toastmaster_club_poll_template', JSON.stringify(CLUB));
    resetClubForTests();
  }

  it('is the default with no template anywhere', () => {
    const template = fn('activePollTemplate')();
    expect(template.categories.map((c) => c.role)).toEqual(DEFAULT_ROLES);
    expect(template.categories.map((c) => c.slots)).toEqual([3, 3, 3]);
  });

  it('is the personal template once one is saved', () => {
    localStorage.setItem('toastmaster_poll_template', JSON.stringify(PERSONAL));
    expect(fn('activePollTemplate')()).toMatchObject(PERSONAL);
  });

  it('is the club\'s template on a club device, ahead of the personal one', () => {
    localStorage.setItem('toastmaster_poll_template', JSON.stringify(PERSONAL));
    joinClub();
    expect(fn('activePollTemplate')()).toMatchObject(CLUB);
  });

  // AC-10: a lapsed club's template stays stored but is not used.
  it('falls back to the personal template when the club has lapsed', () => {
    localStorage.setItem('toastmaster_poll_template', JSON.stringify(PERSONAL));
    joinClub({ entitled: false });
    expect(fn('activePollTemplate')()).toMatchObject(PERSONAL);
    expect(localStorage.getItem('toastmaster_club_poll_template')).not.toBeNull();
  });
});

describe('the club template reaches a member on refresh', () => {
  const CLUB_TEMPLATE = {
    categories: [{ role: 'Contest Speech', label: 'Best Contestant', slots: 4 }],
    options: { postToChat: true, showOnStage: false, expiryHours: 12 },
  };
  const state = (over = {}) => ({
    ver: 1,
    club: { id: 'club-1', name: 'Downtown Speakers' },
    kit: null,
    presets: { rules: { 'Contest Speech': { green: 1, yellow: 2, red: 3 } }, order: [], hiddenBuiltins: [] },
    badge: null,
    cards: null,
    pollTemplate: null,
    timezone: null,
    role: 'member',
    plan: 'pro',
    entitled: true,
    status: 'active',
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    source: 'club',
    ...over,
  });
  const respondWith = (body) => vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));

  beforeEach(() => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify({ clubToken: 'tok.sig', lastRefreshAt: 0, ...state() }));
    resetClubForTests();
  });

  it('saves the published template when ver moves', async () => {
    await refreshClub({ fetchImpl: respondWith(state({ ver: 2, pollTemplate: CLUB_TEMPLATE })), force: true });

    expect(JSON.parse(localStorage.getItem('toastmaster_club_poll_template'))).toMatchObject(CLUB_TEMPLATE);
    expect(fn('activePollTemplate')()).toMatchObject(CLUB_TEMPLATE);
  });

  it('leaves the stored copy alone on a refresh where ver did not move', async () => {
    await refreshClub({ fetchImpl: respondWith(state({ ver: 2, pollTemplate: CLUB_TEMPLATE })), force: true });
    const stored = localStorage.getItem('toastmaster_club_poll_template');

    await refreshClub({
      fetchImpl: respondWith(state({ ver: 2, pollTemplate: { ...CLUB_TEMPLATE, options: { ...CLUB_TEMPLATE.options, expiryHours: 1 } } })),
      force: true,
    });
    expect(localStorage.getItem('toastmaster_club_poll_template')).toBe(stored);
  });
});
