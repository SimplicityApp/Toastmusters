import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CLUB_STORAGE_KEY, resetClubForTests } from '@toastmaster-timer/shared';
import { trackEvent } from '../utils/posthog';
import ClubAdmin from './ClubAdmin';

/**
 * The console's people list after #167: accounts, not devices. The owner is
 * fixed, the others can be removed (and rejoin) or blocked (and kept out until
 * unblocked), and an admin sees how many of the 3 places are used.
 */

const ROSTER = {
  club: {
    id: 'club-1',
    name: 'Downtown Speakers',
    code: 'DTSP-7K2QM9',
    billingEmail: 'treasurer@downtownspeakers.org',
  },
  kit: { name: 'Downtown Speakers', logoUrl: null, primaryColor: '#772432', showOnCards: true, showOnReports: true },
  actor: { type: 'zoom', uid: 'sarah' },
  role: 'admin',
  plan: 'pro',
  entitled: true,
  counts: { people: 3, placesUsed: 2, placesTotal: 3 },
  members: [
    { uid: 'sarah', role: 'admin', displayName: 'Sarah Chen', addedAt: 1_700_000_000_000, isOwner: true },
    { uid: 'james', role: 'editor', displayName: 'James Okoro', addedAt: 1_700_000_000_001, isOwner: false },
    { uid: 'priya', role: 'member', displayName: 'Priya Patel', addedAt: 1_700_000_000_002, isOwner: false },
  ],
  blocked: [],
};

const withoutPriya = {
  ...ROSTER,
  counts: { people: 2, placesUsed: 1, placesTotal: 3 },
  members: ROSTER.members.filter((member) => member.uid !== 'priya'),
};

const copy = (text) =>
  new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['\u2019]"));
const sameText = (a, b) => a.replace(/\u2019/g, "'") === b.replace(/\u2019/g, "'");

/**
 * A fetch stub keyed by path. A route may be a list of answers, one per call
 * (the last repeats), so a roster can change after a write.
 */
function stubApi(routes) {
  const calls = [];
  const seen = new Map();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init = {}) => {
      const path = String(url).split('?')[0];
      calls.push({ path, method: init.method || 'GET', body: init.body, headers: init.headers ?? {} });
      const n = seen.get(path) ?? 0;
      seen.set(path, n + 1);
      const route = routes[path] ?? { status: 404, body: {} };
      const answer = Array.isArray(route) ? route[Math.min(n, route.length - 1)] : route;
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        json: async () => answer.body ?? {},
      };
    })
  );
  return calls;
}

const renderConsole = () =>
  render(
    <MemoryRouter initialEntries={['/club/admin']}>
      <ClubAdmin />
    </MemoryRouter>
  );

const callsTo = (calls, path) => calls.filter((call) => call.path === path);

/** Each row's "…" control, by its accessible name, label or title. */
function moreOptionsIn(container) {
  const scope = within(container);
  return [
    ...scope.queryAllByRole('button', { name: /more options/i }),
    ...scope.queryAllByLabelText(/more options/i),
    ...scope.queryAllByTitle(/more options/i),
  ].filter((element, index, all) => all.indexOf(element) === index);
}

/** The smallest element holding this person's name and a control of their own. */
function rowOf(name) {
  let node = screen.getByText(name);
  while (node && node !== document.body) {
    const scope = within(node);
    if (moreOptionsIn(node).length || scope.queryAllByRole('combobox').length || scope.queryAllByText(/^Owner$/).length) {
      return node;
    }
    node = node.parentElement;
  }
  throw new Error(`No row for ${name}`);
}

async function chooseBlock(user, name) {
  const row = rowOf(name);
  const [more] = moreOptionsIn(row);
  expect(more).toBeTruthy();
  await user.click(more);
  const block =
    within(row).queryByRole('menuitem', { name: /^block$/i }) ??
    within(row).queryByRole('button', { name: /^block$/i }) ??
    within(row).queryByText(/^block$/i) ??
    screen.queryByRole('menuitem', { name: /^block$/i }) ??
    (await screen.findAllByText(/^block$/i)).at(-1);
  await user.click(block);
}

/** window.confirm, or an in-app dialog with the same words. */
async function answerConfirm(user, message, { accept, verb }) {
  if (window.confirm.mock.calls.length) {
    expect(sameText(window.confirm.mock.calls.at(-1)[0], message)).toBe(true);
    return;
  }
  const dialog = screen.queryByRole('alertdialog') ?? (await screen.findByRole('dialog'));
  expect(dialog).toHaveTextContent(copy(message));
  const buttons = within(dialog).getAllByRole('button');
  const choice = accept
    ? buttons.find((button) => verb.test(button.textContent))
    : buttons.find((button) => /cancel|keep/i.test(button.textContent));
  await user.click(choice);
}

const REMOVE_MESSAGE =
  "Remove Priya Patel? They lose the club's Pro at their next open and the place is freed. They can rejoin with the code; to keep them out, use Block.";
const BLOCK_MESSAGE =
  "Block Priya Patel? They lose the club's Pro at their next open, the place is freed, and the code won't let them back in until you unblock them.";

beforeEach(() => {
  localStorage.clear();
  resetClubForTests();
  trackEvent.mockClear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ClubAdmin: people, not devices (AC-3, AC-7)', () => {
  it('shows the places used and no device rows', async () => {
    stubApi({ '/api/club/roster': { status: 200, body: ROSTER } });
    renderConsole();

    expect(await screen.findByText('Priya Patel')).toBeInTheDocument();
    expect(screen.getByText(/2 of 3 places used/)).toBeInTheDocument();
    expect(screen.getByText('James Okoro')).toBeInTheDocument();

    expect(screen.queryByText('Guest devices')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d+ devices?\b/);
    expect(document.body.textContent).not.toMatch(/No device has activated/i);
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull();
  });

  // A browser left with an old device token must not send it to the console.
  it('sends the cookie only, never X-Club', async () => {
    localStorage.setItem(
      CLUB_STORAGE_KEY,
      JSON.stringify({
        clubToken: 'old.token',
        lastRefreshAt: Date.now(),
        ver: 1,
        club: { id: 'club-1', name: 'Downtown Speakers' },
        role: 'admin',
        plan: 'pro',
        entitled: true,
        source: 'club',
      })
    );
    resetClubForTests();
    const calls = stubApi({ '/api/club/roster': { status: 200, body: ROSTER } });
    renderConsole();

    await screen.findByText('Priya Patel');
    for (const call of calls) {
      const names = Object.keys(call.headers ?? {}).map((name) => name.toLowerCase());
      expect(names).not.toContain('x-club');
    }
  });
});

describe('ClubAdmin: the owner row (AC-12)', () => {
  it('says Owner, with no role select and no "…" menu', async () => {
    stubApi({ '/api/club/roster': { status: 200, body: ROSTER } });
    renderConsole();

    await screen.findByText('Sarah Chen');
    const owner = rowOf('Sarah Chen');
    expect(within(owner).getByText(/^Owner$/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Role for Sarah Chen')).toBeNull();
    expect(moreOptionsIn(owner)).toEqual([]);

    // Everyone else keeps both.
    expect(screen.getByLabelText('Role for James Okoro')).toBeInTheDocument();
    expect(screen.getByLabelText('Role for Priya Patel')).toBeInTheDocument();
    expect(moreOptionsIn(rowOf('James Okoro')).length).toBeGreaterThan(0);
    expect(moreOptionsIn(rowOf('Priya Patel')).length).toBeGreaterThan(0);
  });
});

describe('ClubAdmin: Remove (AC-4)', () => {
  it('offers Remove instead of No access', async () => {
    stubApi({ '/api/club/roster': { status: 200, body: ROSTER } });
    renderConsole();

    const select = await screen.findByLabelText('Role for Priya Patel');
    const labels = within(select).getAllByRole('option').map((option) => option.textContent);
    expect(labels).toContain('Remove');
    expect(labels).not.toContain('No access');
  });

  it('asks first, then removes, and the person drops off the roster', async () => {
    const user = userEvent.setup();
    window.confirm.mockReturnValue(true);
    const calls = stubApi({
      '/api/club/roster': [
        { status: 200, body: ROSTER },
        { status: 200, body: withoutPriya },
      ],
      '/api/club/members/priya/role': { status: 200, body: { uid: 'priya', removed: true } },
    });
    renderConsole();

    const select = await screen.findByLabelText('Role for Priya Patel');
    await user.selectOptions(select, 'revoked');
    await answerConfirm(user, REMOVE_MESSAGE, { accept: true, verb: /remove/i });

    await waitFor(() => {
      const [call] = callsTo(calls, '/api/club/members/priya/role');
      expect(call).toBeTruthy();
      expect(JSON.parse(call.body)).toEqual({ role: 'revoked' });
    });
    await waitFor(() => expect(screen.queryByText('Priya Patel')).toBeNull());
    expect(screen.queryByText(/^Removed$/)).toBeNull();
    expect(trackEvent).toHaveBeenCalledWith('club_access_revoked', expect.objectContaining({ club_id: 'club-1' }));
  });

  it('sends nothing when the confirm is cancelled', async () => {
    const user = userEvent.setup();
    window.confirm.mockReturnValue(false);
    const calls = stubApi({
      '/api/club/roster': { status: 200, body: ROSTER },
      '/api/club/members/priya/role': { status: 200, body: {} },
    });
    renderConsole();

    const select = await screen.findByLabelText('Role for Priya Patel');
    await user.selectOptions(select, 'revoked');
    await answerConfirm(user, REMOVE_MESSAGE, { accept: false, verb: /remove/i });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsTo(calls, '/api/club/members/priya/role')).toEqual([]);
    expect(screen.getByText('Priya Patel')).toBeInTheDocument();
  });
});

describe('ClubAdmin: Block and Unblock (AC-10, AC-11)', () => {
  const blockedRoster = {
    ...withoutPriya,
    blocked: [{ uid: 'priya', displayName: 'Priya Patel', blockedAt: 1_700_000_100_000 }],
  };

  it('shows no Blocked section while nobody is blocked', async () => {
    stubApi({ '/api/club/roster': { status: 200, body: ROSTER } });
    renderConsole();

    await screen.findByText('Priya Patel');
    expect(screen.queryByText(/^Blocked$/)).toBeNull();
    expect(screen.queryByRole('button', { name: /unblock/i })).toBeNull();
  });

  it('blocks from the row\'s "…" menu after a confirm, and lists the account under Blocked', async () => {
    const user = userEvent.setup();
    window.confirm.mockReturnValue(true);
    const calls = stubApi({
      '/api/club/roster': [
        { status: 200, body: ROSTER },
        { status: 200, body: blockedRoster },
      ],
      '/api/club/members/priya/block': { status: 200, body: { uid: 'priya', blocked: true } },
    });
    renderConsole();

    await screen.findByText('Priya Patel');
    await chooseBlock(user, 'Priya Patel');
    await answerConfirm(user, BLOCK_MESSAGE, { accept: true, verb: /block/i });

    await waitFor(() => {
      const [call] = callsTo(calls, '/api/club/members/priya/block');
      expect(call).toBeTruthy();
      expect(call.method).toBe('POST');
      expect(JSON.parse(call.body)).toEqual({ blocked: true });
    });

    const heading = await screen.findByText(/^Blocked$/);
    expect(heading).toBeInTheDocument();
    expect(screen.getByText('Priya Patel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /unblock/i })).toBeInTheDocument();
    expect(trackEvent).toHaveBeenCalledWith(
      'club_member_blocked',
      expect.objectContaining({ club_id: 'club-1', surface: 'web' })
    );
  });

  it('sends nothing when the block confirm is cancelled', async () => {
    const user = userEvent.setup();
    window.confirm.mockReturnValue(false);
    const calls = stubApi({
      '/api/club/roster': { status: 200, body: ROSTER },
      '/api/club/members/priya/block': { status: 200, body: {} },
    });
    renderConsole();

    await screen.findByText('Priya Patel');
    await chooseBlock(user, 'Priya Patel');
    await answerConfirm(user, BLOCK_MESSAGE, { accept: false, verb: /block/i });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsTo(calls, '/api/club/members/priya/block')).toEqual([]);
  });

  it('unblocks with one click and no confirm', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      '/api/club/roster': [
        { status: 200, body: blockedRoster },
        { status: 200, body: withoutPriya },
      ],
      '/api/club/members/priya/block': { status: 200, body: { uid: 'priya', blocked: false } },
    });
    renderConsole();

    await screen.findByText(/^Blocked$/);
    await user.click(screen.getByRole('button', { name: /unblock/i }));

    await waitFor(() => {
      const [call] = callsTo(calls, '/api/club/members/priya/block');
      expect(call).toBeTruthy();
      expect(JSON.parse(call.body)).toEqual({ blocked: false });
    });
    expect(window.confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Not put back automatically: the account rejoins with the code.
    await waitFor(() => expect(screen.queryByText(/^Blocked$/)).toBeNull());
    expect(screen.queryByText('Priya Patel')).toBeNull();
    expect(trackEvent).toHaveBeenCalledWith(
      'club_member_unblocked',
      expect.objectContaining({ club_id: 'club-1', surface: 'web' })
    );
  });
});
