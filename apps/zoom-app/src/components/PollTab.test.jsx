import '@testing-library/jest-dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../context/ToastContext';
import { TimerProvider } from '../context/TimerContext';
import { trackEvent } from '../utils/posthog';
import * as zoomSdk from '../utils/zoomSdk';
import {
  CLUB_STORAGE_KEY,
  CLUB_PRESETS_STORAGE_KEY,
  PRESET_SOURCE_STORAGE_KEY,
  DEFAULT_CUSTOM_RULES,
  loadRoleRules,
  onLocalWrite,
  resetClubForTests,
  resetEntitlementForTests,
  resetFlagsForTests,
  setEntitlement,
  setFlags,
} from '@toastmaster-timer/shared';

/**
 * The POLL tab (#80): set up a ballot from this meeting's timed speakers, open
 * it, watch it, close it and reveal the winners; and, on any plan, vote in a
 * poll someone else opened in this meeting.
 *
 * The UI contract these tests hold (accessible names, so markup is free):
 *  - each category is a `group` holding a `Role` select (its options are
 *    roleOptions plus "New role…"), candidate text boxes named "Candidate …",
 *    "Add candidate", "Remove candidate" and "Remove category"; "Add category"
 *    sits below them;
 *  - "New role…" reveals a "New role name" box and an "Add role" button;
 *  - "Save as my template", "Publish to club" (admin or editor only),
 *    "Open poll"; once open: the link, "Copy link", "Invite everyone",
 *    "Close poll" and (host, polls_zoom) "Create as Zoom poll"; once closed:
 *    the winners and "Show on Stage";
 *  - a free plan sees "Upgrade to Pro" instead of the setup;
 *  - a poll found through POST /api/polls/current shows its ballot as radio
 *    buttons named by candidate and a "Submit vote" button.
 *
 * Zoom is reached only through utils/zoomSdk: readAppContext(),
 * readZoomUserSummary() → {status, role}, readMeetingContext() → {meetingID},
 * sendChatMessage(text) and inviteAllParticipants() → true/false (a rejection
 * counts as false), requestZoomAuthorizeCode() → {status, code, codeVerifier}.
 */

// Stubbed rather than imported: the real module pulls in @zoom/appssdk, which
// hangs vitest under jsdom. Anything not named here is a no-op mock.
vi.mock('../utils/zoomSdk', () => {
  const named = {
    applyOverlay: vi.fn(),
    removeOverlay: vi.fn(),
    getBackgroundUrl: vi.fn((color) => `/backgrounds/${color}.png`),
    isOverlayActive: vi.fn(() => false),
    getOverlayMode: vi.fn(() => 'card'),
    isVideoOverlayMode: vi.fn(() => false),
    setOverlayTimeLabel: vi.fn(),
    OVERLAY_MODE_CARD: 'card',
    openExternalUrl: vi.fn(async () => true),
    isApiAvailable: vi.fn(() => true),
    readAppContext: vi.fn(async () => 'ctx-owner'),
    readZoomUserSummary: vi.fn(async () => ({ status: 'authorized', role: 'host' })),
    readMeetingContext: vi.fn(async () => ({ meetingID: '123456789', meetingTopic: 'Downtown Speakers' })),
    sendChatMessage: vi.fn(async () => true),
    inviteAllParticipants: vi.fn(async () => true),
    requestZoomAuthorizeCode: vi.fn(async () => ({ status: 'code', code: 'auth-code', codeVerifier: 'ver-1' })),
  };
  return new Proxy(named, {
    get: (target, prop) => {
      if (prop in target || typeof prop !== 'string' || prop === 'then' || prop === '__esModule') return target[prop];
      target[prop] = vi.fn();
      return target[prop];
    },
    has: (target, prop) => prop in target || typeof prop === 'string',
  });
});
vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));
vi.mock('../utils/zoomIdentity', () => ({
  getSessionToken: vi.fn(() => 'session-token'),
  resolveZoomIdentity: vi.fn(async () => ({ identified: true, uid: 'owner-uid' })),
  resetZoomIdentityForTests: vi.fn(),
}));

// Loaded after the mocks; a variable keeps the bundler from refusing the file
// before the component exists, so each test fails on its own assertion.
const POLL_TAB_MODULE = './PollTab';
let PollTab = null;
beforeAll(async () => {
  PollTab = (await import(/* @vite-ignore */ POLL_TAB_MODULE).catch(() => null))?.default ?? null;
});

const PRO = { plan: 'pro', status: 'active', entitled: true, source: 'subscription' };
const FREE = { plan: 'free', status: null, entitled: false, source: 'none' };
const POLL_ID = 'ABCDEFGHJKMNPQRS';
const VOTE_URL = `https://www.timer-dev.simple-tech.app/vote/${POLL_ID}`;
const DEFAULT_ROLES = ['Table Topics Speech', 'Standard Speech', 'Table Topics Evaluation'];

const report = (name, role, finishedAt) => ({ speechId: `${name}-${finishedAt}`, name, role, duration: '1:30', color: 'green', comments: '', disqualified: false, finishedAt });
const REPORTS = [
  report('Bob', 'Table Topics Speech', 1_000),
  report('Alice', 'Standard Speech', 2_000),
  report('Carol', 'Table Topics Speech', 3_000),
  report('Bob', 'Table Topics Speech', 4_000),
  report('Frank', 'Table Topics Evaluation', 5_000),
];

// ---------------------------------------------------------------------------
// The Worker, at the fetch boundary

let routes;
let calls;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function installFetch() {
  calls = [];
  routes = {};
  global.fetch = vi.fn(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? input?.method ?? 'GET').toUpperCase();
    const path = new URL(url, 'https://zoom.timer-dev.simple-tech.app').pathname;
    const body = typeof init.body === 'string' ? init.body : null;
    calls.push({ method, path, body: body ? JSON.parse(body) : null });
    const handler = routes[`${method} ${path}`];
    return handler ? handler(body ? JSON.parse(body) : null) : json({ error: 'not_found' }, 404);
  });
}

const callsTo = (method, path) => calls.filter((c) => c.method === method && (path instanceof RegExp ? path.test(c.path) : c.path === path));

// ---------------------------------------------------------------------------

function joinClub({ role = null, entitled = true } = {}) {
  localStorage.setItem(
    CLUB_STORAGE_KEY,
    JSON.stringify({
      clubToken: 'tok.sig',
      lastRefreshAt: Date.now(),
      ver: 3,
      club: { id: 'club-1', name: 'Downtown Speakers' },
      kit: null,
      badge: null,
      timezone: null,
      role,
      plan: entitled ? 'pro' : 'free',
      entitled,
      status: entitled ? 'active' : 'canceled',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      source: 'club',
    })
  );
  localStorage.setItem(
    CLUB_PRESETS_STORAGE_KEY,
    JSON.stringify({ rules: { 'Contest Speech': { green: 111, yellow: 222, red: 333, graceAfterRed: 30 } }, order: ['Contest Speech'], hiddenBuiltins: [], publishedBy: 'buyer-uid', publishedAt: 1 })
  );
  resetClubForTests();
}

function renderTab() {
  expect(PollTab, 'components/PollTab.jsx has a default export').toBeTypeOf('function');
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <TimerProvider>
        <PollTab />
      </TimerProvider>
    </ToastProvider>
  );
  return user;
}

/** Every category on screen: a group with a Role select in it. */
const categories = () =>
  screen.getAllByRole('group').filter((group) => within(group).queryByRole('combobox', { name: /role/i }));
const roleOf = (group) => within(group).getByRole('combobox', { name: /role/i });
const candidatesOf = (group) => within(group).queryAllByRole('textbox', { name: /candidate/i });
const valuesOf = (group) => candidatesOf(group).map((input) => input.value);

async function setupReady() {
  await waitFor(() => expect(categories().length).toBeGreaterThan(0));
}

function savePersonalTemplate(options = {}) {
  localStorage.setItem(
    'toastmaster_poll_template',
    JSON.stringify({
      categories: DEFAULT_ROLES.map((role) => ({ role, slots: 3 })),
      options: { postToChat: true, showOnStage: true, expiryHours: 24, ...options },
    })
  );
}

function routeOpen() {
  routes[`POST /api/polls`] = () => json({ id: POLL_ID, url: VOTE_URL }, 201);
  routes[`GET /api/polls/${POLL_ID}/results`] = () =>
    json({ status: 'open', counts: [[1, 1], [2], [0]], byPath: { zoom: [[1, 0], [1], [0]], guest: [[0, 0], [0], [0]], link: [[0, 1], [1], [0]] } });
  routes[`POST /api/polls/${POLL_ID}/close`] = () =>
    json({
      counts: [[2, 2], [3], [0]],
      byPath: { zoom: [[1, 1], [2], [0]], guest: [[0, 0], [0], [0]], link: [[1, 1], [1], [0]] },
      winners: [['Bob', 'Carol'], ['Alice'], []],
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetClubForTests();
  resetEntitlementForTests();
  resetFlagsForTests();
  setFlags({ pro: true, polls: true, polls_zoom: false });
  installFetch();
  zoomSdk.readAppContext.mockResolvedValue('ctx-owner');
  zoomSdk.readZoomUserSummary.mockResolvedValue({ status: 'authorized', role: 'host' });
  zoomSdk.sendChatMessage.mockResolvedValue(true);
  zoomSdk.inviteAllParticipants.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------

describe('on the free plan (AC-1)', () => {
  it('locks the setup, and "Upgrade to Pro" opens the upgrade modal', async () => {
    setEntitlement(FREE);
    const user = renderTab();

    const [upgrade] = await screen.findAllByRole('button', { name: /upgrade to pro/i });
    expect(screen.queryByRole('button', { name: /open poll/i })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('combobox', { name: /role/i })).toHaveLength(0);

    await user.click(upgrade);
    await waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith('upgrade_prompt_shown', expect.objectContaining({ source: 'polls' }))
    );
  });
});

describe('setting up the ballot', () => {
  beforeEach(() => setEntitlement(PRO));

  // AC-2
  it('starts from Table Topics Speech, Standard Speech and Table Topics Evaluation, three empty slots each', async () => {
    renderTab();
    await setupReady();

    expect(categories().map((group) => roleOf(group).value)).toEqual(DEFAULT_ROLES);
    for (const group of categories()) expect(valuesOf(group)).toEqual(['', '', '']);
  });

  // AC-5
  it('fills each category with this meeting\'s timed speakers, deduplicated in timing order', async () => {
    localStorage.setItem('toastmaster_reports', JSON.stringify(REPORTS));
    renderTab();
    await setupReady();

    const [topics, speech, evaluation] = categories();
    expect(valuesOf(topics)).toEqual(['Bob', 'Carol']);
    expect(valuesOf(speech)).toEqual(['Alice']);
    expect(valuesOf(evaluation)).toEqual(['Frank']);
  });

  // AC-3 and AC-5
  it('adds, renames and removes candidates and categories, and offers every role including custom ones', async () => {
    localStorage.setItem('toastmaster_reports', JSON.stringify(REPORTS));
    localStorage.setItem('toastmaster_role_rules', JSON.stringify({ 'Contest Speech': { green: 111, yellow: 222, red: 333 } }));
    localStorage.setItem('toastmaster_role_order', JSON.stringify(['Contest Speech']));
    const user = renderTab();
    await setupReady();

    const topics = categories()[0];
    await user.click(within(topics).getByRole('button', { name: /add candidate/i }));
    expect(candidatesOf(topics)).toHaveLength(3);
    await user.type(candidatesOf(topics)[2], 'Dmitri');
    await user.clear(candidatesOf(topics)[0]);
    await user.type(candidatesOf(topics)[0], 'Robert');
    expect(valuesOf(topics)).toEqual(['Robert', 'Carol', 'Dmitri']);
    await user.click(within(topics).getAllByRole('button', { name: /remove candidate/i })[1]);
    expect(valuesOf(topics)).toEqual(['Robert', 'Dmitri']);

    await user.click(screen.getByRole('button', { name: /add category/i }));
    expect(categories()).toHaveLength(4);
    const added = categories()[3];
    const options = within(roleOf(added)).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining([...DEFAULT_ROLES, 'Ice Breaker', 'Contest Speech']));
    await user.selectOptions(roleOf(added), 'Contest Speech');
    expect(roleOf(categories()[3]).value).toBe('Contest Speech');

    await user.click(within(categories()[3]).getByRole('button', { name: /remove category/i }));
    expect(categories()).toHaveLength(3);
  });

  // AC-4
  it('creates a new role from the poll screen with the default custom rules', async () => {
    const user = renderTab();
    await setupReady();

    const role = roleOf(categories()[0]);
    await user.selectOptions(role, within(role).getByRole('option', { name: /new role/i }));
    await user.type(await screen.findByRole('textbox', { name: /new role name/i }), 'Humorous Speech Contest');
    await user.click(screen.getByRole('button', { name: /^add role$/i }));

    await waitFor(() => expect(loadRoleRules()?.['Humorous Speech Contest']).toEqual(DEFAULT_CUSTOM_RULES));
    expect(roleOf(categories()[0]).value).toBe('Humorous Speech Contest');
    expect(trackEvent).toHaveBeenCalledWith('role_added', expect.objectContaining({ role: 'Humorous Speech Contest' }));
  });

  it('on a club device, makes the timer\'s own copy of the club list first, as Edit Rules does', async () => {
    joinClub();
    const user = renderTab();
    await setupReady();

    const role = roleOf(categories()[0]);
    await user.selectOptions(role, within(role).getByRole('option', { name: /new role/i }));
    await user.type(await screen.findByRole('textbox', { name: /new role name/i }), 'Humorous Speech Contest');
    await user.click(screen.getByRole('button', { name: /^add role$/i }));
    await user.click(await screen.findByRole('button', { name: /make my copy/i }));

    await waitFor(() => expect(loadRoleRules()?.['Humorous Speech Contest']).toEqual(DEFAULT_CUSTOM_RULES));
    expect(loadRoleRules()['Contest Speech']).toMatchObject({ green: 111, yellow: 222, red: 333 });
    expect(localStorage.getItem(PRESET_SOURCE_STORAGE_KEY)).toBe('personal');
  });

  // AC-11
  it('saves the ballot setup as a personal template through the synced store', async () => {
    const written = [];
    const stop = onLocalWrite((key) => written.push(key));
    const user = renderTab();
    await setupReady();

    await user.click(screen.getByRole('button', { name: /save as my template/i }));

    stop();
    expect(written).toContain('toastmaster_poll_template');
    const saved = JSON.parse(localStorage.getItem('toastmaster_poll_template'));
    expect(saved.categories.map((c) => c.role)).toEqual(DEFAULT_ROLES);
  });

  // AC-10
  it('lets an editor publish the setup to the club, and hides that from a member', async () => {
    joinClub({ role: 'editor' });
    routes['PUT /api/club/poll-template'] = () => json({ ver: 4, pollTemplate: {} });
    const user = renderTab();
    await setupReady();

    await user.click(screen.getByRole('button', { name: /publish to club/i }));
    await waitFor(() => expect(callsTo('PUT', '/api/club/poll-template')).toHaveLength(1));
    expect(callsTo('PUT', '/api/club/poll-template')[0].body.categories.map((c) => c.role)).toEqual(DEFAULT_ROLES);
  });

  it('shows no publish button to a plain member', async () => {
    joinClub({ role: 'member' });
    renderTab();
    await setupReady();
    expect(screen.queryByRole('button', { name: /publish to club/i })).not.toBeInTheDocument();
  });

  it('starts from the club\'s template on a club device, and an edit for one meeting changes neither template', async () => {
    joinClub({ role: 'member' });
    const clubTemplate = JSON.stringify({
      categories: [
        { role: 'Contest Speech', label: 'Best Contestant', slots: 2 },
        { role: 'Table Topics Evaluation', slots: 1 },
      ],
      options: { postToChat: true, showOnStage: false, expiryHours: 12 },
    });
    localStorage.setItem('toastmaster_club_poll_template', clubTemplate);
    const user = renderTab();
    await setupReady();

    expect(categories().map((group) => roleOf(group).value)).toEqual(['Contest Speech', 'Table Topics Evaluation']);
    expect(categories().map((group) => candidatesOf(group).length)).toEqual([2, 1]);
    await user.type(candidatesOf(categories()[0])[0], 'Zed');

    expect(localStorage.getItem('toastmaster_club_poll_template')).toBe(clubTemplate);
    expect(localStorage.getItem('toastmaster_poll_template')).toBeNull();
  });
});

describe('opening the poll', () => {
  beforeEach(() => {
    setEntitlement(PRO);
    localStorage.setItem('toastmaster_reports', JSON.stringify(REPORTS));
    routeOpen();
  });

  async function openPoll() {
    const user = renderTab();
    await setupReady();
    await user.click(screen.getByRole('button', { name: /open poll/i }));
    // As text or in a read-only box, either way on screen.
    await waitFor(() => expect(screen.queryAllByText(VOTE_URL).length + screen.queryAllByDisplayValue(VOTE_URL).length).toBeGreaterThan(0));
    return user;
  }

  // AC-12, AC-14: the owner's context ties the poll to this meeting.
  it('creates the poll with this meeting\'s names and context, then shows the link with Copy', async () => {
    savePersonalTemplate();
    await openPoll();

    const [created] = callsTo('POST', '/api/polls');
    expect(created.body.context).toBe('ctx-owner');
    expect(created.body.ballot.categories.map((c) => c.role)).toEqual(DEFAULT_ROLES);
    expect(created.body.ballot.categories[0].candidates).toEqual(['Bob', 'Carol']);
    expect(screen.getByRole('button', { name: /copy link/i })).toBeInTheDocument();
  });

  it('posts the link to the meeting chat when postToChat is on', async () => {
    savePersonalTemplate({ postToChat: true });
    await openPoll();

    await waitFor(() => expect(zoomSdk.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(zoomSdk.sendChatMessage.mock.calls[0][0]).toContain(VOTE_URL);
  });

  it('leaves the chat alone when postToChat is off, and still offers Copy link', async () => {
    savePersonalTemplate({ postToChat: false });
    await openPoll();

    expect(zoomSdk.sendChatMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /copy link/i })).toBeInTheDocument();
  });

  it('falls back to Copy link with a toast when the chat post fails', async () => {
    savePersonalTemplate({ postToChat: true });
    zoomSdk.sendChatMessage.mockResolvedValue(false);
    await openPoll();

    expect(await screen.findByText((text) => /chat/i.test(text) && /copy/i.test(text))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy link/i })).toBeInTheDocument();
  });

  // AC-15
  it('invites everyone into the app, and points at Copy link when Zoom refuses', async () => {
    const user = await openPoll();

    await user.click(screen.getByRole('button', { name: /invite everyone/i }));
    expect(zoomSdk.inviteAllParticipants).toHaveBeenCalledTimes(1);

    zoomSdk.inviteAllParticipants.mockRejectedValueOnce(new Error('refused'));
    await user.click(screen.getByRole('button', { name: /invite everyone/i }));
    expect(await screen.findByText((text) => /invit/i.test(text) && /link/i.test(text) && /copy/i.test(text))).toBeInTheDocument();
  });

  // AC-8, AC-9
  it('closes, reveals every winner (ties included, "No votes" for an empty category) and keeps the results', async () => {
    const user = await openPoll();

    await user.click(screen.getByRole('button', { name: /close poll/i }));

    expect(await screen.findByRole('button', { name: /show on stage/i })).toBeInTheDocument();
    expect(callsTo('POST', `/api/polls/${POLL_ID}/close`)).toHaveLength(1);
    expect(screen.getAllByText(/Bob/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Carol/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Alice/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/No votes/i).length).toBeGreaterThan(0);

    const stored = JSON.parse(localStorage.getItem('toastmaster_poll_results'));
    const closed = stored.find((entry) => entry.pollId === POLL_ID);
    expect(closed.categories.map((c) => c.winners)).toEqual([['Bob', 'Carol'], ['Alice'], []]);
  });

  it('queues the closed results for the club archive on a club device', async () => {
    joinClub();
    const user = await openPoll();

    await user.click(screen.getByRole('button', { name: /close poll/i }));
    await screen.findByRole('button', { name: /show on stage/i });

    await waitFor(() => expect(callsTo('POST', /^\/api\/club\/meetings\/[^/]+\/polls$/)).toHaveLength(1));
    expect(callsTo('POST', /^\/api\/club\/meetings\/[^/]+\/polls$/)[0].body).toMatchObject({ pollId: POLL_ID });
  });

  // AC-13
  describe('as a native Zoom poll', () => {
    it('is offered only to the host with polls_zoom on, with Zoom\'s limits spelled out', async () => {
      setFlags({ pro: true, polls: true, polls_zoom: true });
      await openPoll();

      expect(await screen.findByRole('button', { name: /create as zoom poll/i })).toBeInTheDocument();
      expect(screen.getAllByText(/scheduled meeting/i).length).toBeGreaterThan(0);
    });

    it('is not offered to anyone but the host', async () => {
      setFlags({ pro: true, polls: true, polls_zoom: true });
      zoomSdk.readZoomUserSummary.mockResolvedValue({ status: 'authorized', role: 'attendee' });
      await openPoll();
      await waitFor(() => expect(zoomSdk.readZoomUserSummary).toHaveBeenCalled());
      expect(screen.queryByRole('button', { name: /create as zoom poll/i })).not.toBeInTheDocument();
    });

    it('is not offered with polls_zoom off', async () => {
      await openPoll();
      expect(screen.queryByRole('button', { name: /create as zoom poll/i })).not.toBeInTheDocument();
    });

    it('asks Zoom for a code, sends it with the meeting number and the poll, and says why an instant meeting cannot have one', async () => {
      setFlags({ pro: true, polls: true, polls_zoom: true });
      routes['POST /api/polls/zoom'] = () => json({ error: 'instant_meeting' }, 409);
      const user = await openPoll();

      await user.click(await screen.findByRole('button', { name: /create as zoom poll/i }));

      await waitFor(() => expect(callsTo('POST', '/api/polls/zoom')).toHaveLength(1));
      expect(zoomSdk.requestZoomAuthorizeCode).toHaveBeenCalled();
      const { body } = callsTo('POST', '/api/polls/zoom')[0];
      expect(body).toMatchObject({ code: 'auth-code', meetingId: '123456789', pollId: POLL_ID });
      expect(body.codeVerifier ?? body.verifier).toBe('ver-1');
      await waitFor(() => expect(screen.getAllByText(/instant meeting/i).length).toBeGreaterThan(0));
    });
  });
});

describe('voting in a poll opened in this meeting (AC-14)', () => {
  const VOTE_ID = 'VWXYZ23456789ABC';

  beforeEach(() => {
    zoomSdk.readAppContext.mockResolvedValue('ctx-voter');
    routes['POST /api/polls/current'] = () =>
      json({ id: VOTE_ID, ballot: { categories: [{ role: 'Standard Speech', label: 'Best Speaker', candidates: ['Alice', 'Bob'] }] } });
    routes[`POST /api/polls/${VOTE_ID}/votes`] = () => json({ ok: true });
  });

  it('shows the ballot to a free plan, sends the vote with this app\'s context, and thanks them without any counts', async () => {
    setEntitlement(FREE);
    const user = renderTab();

    expect((await screen.findAllByText('Best Speaker')).length).toBeGreaterThan(0);
    expect(callsTo('POST', '/api/polls/current')[0].body).toMatchObject({ context: 'ctx-voter' });

    await user.click(screen.getByRole('radio', { name: 'Bob' }));
    await user.click(screen.getByRole('button', { name: /submit vote/i }));

    await waitFor(() => expect(callsTo('POST', `/api/polls/${VOTE_ID}/votes`)).toHaveLength(1));
    const { body } = callsTo('POST', `/api/polls/${VOTE_ID}/votes`)[0];
    expect(body.choices).toEqual({ 0: 1 });
    expect(body.context).toBe('ctx-voter');
    expect((await screen.findAllByText(/thanks, your vote is in/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/\b\d+ votes?\b/i)).not.toBeInTheDocument();
  });

  it('shows the same ballot to a Pro user who did not open the poll', async () => {
    setEntitlement(PRO);
    renderTab();
    expect((await screen.findAllByText('Best Speaker')).length).toBeGreaterThan(0);
    expect(screen.getByRole('radio', { name: 'Alice' })).toBeInTheDocument();
  });
});
