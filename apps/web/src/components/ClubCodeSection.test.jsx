import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { resetClubForTests, resetEntitlementForTests, resetFlagsForTests, setFlags } from '@toastmaster-timer/shared';
import { resetWebIdentityForTests, signInUrl } from '../utils/webIdentity';
import { trackEvent } from '../utils/posthog';
import ClubCodeSection from './ClubCodeSection';

/**
 * The code field on /account (#167). Joining needs a Zoom sign-in, the joined
 * state belongs to the account, Leave asks first, and the owner cannot leave.
 */

const CODE = 'DTSP-7K2QM9';

const STATE = {
  ver: 1,
  club: { id: 'club-1', name: 'Downtown Speakers' },
  kit: null,
  presets: null,
  badge: { x: 0.8, y: 0.12, scale: 0.12 },
  cards: null,
  timezone: null,
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
  placesUsed: 2,
};

const copy = (text) =>
  new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['\u2019]"));
const sameText = (a, b) => a.replace(/\u2019/g, "'") === b.replace(/\u2019/g, "'");

/** A fetch stub keyed by path, recording every call. */
function stubApi({ me, activate = { status: 200, body: STATE }, leave = { status: 200, body: { left: true } } }) {
  const calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init = {}) => {
      const path = String(url).split('?')[0];
      calls.push({ path, method: init.method || 'GET', body: init.body, headers: init.headers ?? {} });
      const answer =
        path === '/api/me'
          ? me
          : path === '/api/club/activate'
            ? activate
            : path === '/api/club/leave'
              ? leave
              : { status: 404, body: {} };
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        json: async () => answer.body ?? {},
      };
    })
  );
  return calls;
}

const SIGNED_OUT = { status: 401, body: { error: 'Unauthorized' } };
const SIGNED_IN = { status: 200, body: { uid: 'timer-uid', entitlement: { plan: 'free', entitled: false } } };

const renderSection = ({ identified }) =>
  render(
    <MemoryRouter initialEntries={['/account']}>
      <ClubCodeSection source="web_account" identified={identified} />
    </MemoryRouter>
  );

const codeField = () => screen.queryByLabelText(/already on pro through your club/i) ?? screen.queryByRole('textbox');
const callsTo = (calls, path) => calls.filter((call) => call.path === path);
const headerNames = (call) => Object.keys(call.headers ?? {}).map((name) => name.toLowerCase());

/** Type the code and submit it, the way a person on /account does. */
async function enterCode(user, code = CODE) {
  const field = await waitFor(() => {
    const found = codeField();
    expect(found).toBeTruthy();
    return found;
  });
  await user.type(field, code);
  await user.keyboard('{Enter}');
}

/**
 * Answer the confirm, whichever way the page asks: window.confirm, or an in-app
 * dialog with the same words.
 */
async function answerConfirm(user, message, { accept }) {
  if (window.confirm.mock.calls.length) {
    expect(sameText(window.confirm.mock.calls.at(-1)[0], message)).toBe(true);
    return;
  }
  const dialog = screen.queryByRole('alertdialog') ?? (await screen.findByRole('dialog'));
  expect(dialog).toHaveTextContent(copy(message));
  const buttons = within(dialog).getAllByRole('button');
  const choice = accept
    ? buttons.find((button) => /leave/i.test(button.textContent))
    : buttons.find((button) => /cancel|stay|keep/i.test(button.textContent));
  await user.click(choice);
}

beforeEach(() => {
  localStorage.clear();
  resetClubForTests();
  resetWebIdentityForTests();
  resetEntitlementForTests();
  resetFlagsForTests();
  setFlags({ pro: true });
  trackEvent.mockClear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ClubCodeSection: signed out (AC-1d)', () => {
  it('sends nothing and offers a Zoom sign-in that returns to /pro/<CODE>', async () => {
    const user = userEvent.setup();
    const calls = stubApi({ me: SIGNED_OUT });
    renderSection({ identified: false });

    await enterCode(user);

    const link = await screen.findByRole('link', { name: /sign in with zoom to join/i });
    expect(link).toHaveAttribute('href', signInUrl(`/pro/${CODE}`));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsTo(calls, '/api/club/activate')).toEqual([]);
    await waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith(
        'club_code_rejected',
        expect.objectContaining({ reason: 'sign_in_required' })
      )
    );
  });

  it('no longer says no sign-in is needed (AC-7)', async () => {
    stubApi({ me: SIGNED_OUT });
    renderSection({ identified: false });

    await waitFor(() => expect(codeField() ?? screen.queryByRole('link', { name: /sign in with zoom/i })).toBeTruthy());
    expect(document.body.textContent).not.toMatch(/No sign-in needed/i);
  });
});

describe('ClubCodeSection: signed in', () => {
  it('joins and shows the account wording (AC-1d, AC-7)', async () => {
    const user = userEvent.setup();
    const calls = stubApi({ me: SIGNED_IN });
    renderSection({ identified: true });

    await enterCode(user);

    expect(await screen.findByText(copy("You're on Pro through Downtown Speakers"))).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/This browser is on Pro/i);
    expect(document.body.textContent).not.toMatch(/This device is on Pro/i);
    expect(screen.queryByRole('button', { name: /on this device/i })).toBeNull();

    const [activate] = callsTo(calls, '/api/club/activate');
    expect(JSON.parse(activate.body).deviceId).toBeUndefined();
    expect(headerNames(activate)).not.toContain('x-club');
  });

  it('reports places_used and no is_guest on club_code_activated (AC-10)', async () => {
    const user = userEvent.setup();
    stubApi({ me: SIGNED_IN });
    renderSection({ identified: true });

    await enterCode(user);

    await waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith('club_code_activated', expect.objectContaining({ places_used: 2 }))
    );
    const [, props] = trackEvent.mock.calls.find(([event]) => event === 'club_code_activated');
    expect(props).not.toHaveProperty('is_guest');
  });

  it('shows the full message (AC-3, AC-10)', async () => {
    const user = userEvent.setup();
    stubApi({ me: SIGNED_IN, activate: { status: 409, body: { error: 'full', placesUsed: 3, placesTotal: 3 } } });
    renderSection({ identified: true });

    await enterCode(user);

    expect(
      await screen.findByText(
        copy("This club's Pro is full (3 of 3). Ask the person who shared the code to free a place.")
      )
    ).toBeInTheDocument();
    expect(trackEvent).toHaveBeenCalledWith('club_code_rejected', expect.objectContaining({ reason: 'full' }));
  });

  it('names the club the account is already in (AC-5, AC-10)', async () => {
    const user = userEvent.setup();
    stubApi({
      me: SIGNED_IN,
      activate: { status: 409, body: { error: 'already_in_club', clubName: 'Riverside Toastmasters' } },
    });
    renderSection({ identified: true });

    await enterCode(user);

    expect(
      await screen.findByText(copy("You're already in Riverside Toastmasters. Leave it to join another club."))
    ).toBeInTheDocument();
    expect(trackEvent).toHaveBeenCalledWith(
      'club_code_rejected',
      expect.objectContaining({ reason: 'already_in_club' })
    );
  });
});

describe('ClubCodeSection: leaving (AC-4, AC-12)', () => {
  const LEAVE_MESSAGE =
    "Leave Downtown Speakers? You'll lose its Pro on every computer where you're signed in.";

  async function joined(user, state = STATE) {
    const calls = stubApi({ me: SIGNED_IN, activate: { status: 200, body: state } });
    renderSection({ identified: true });
    await enterCode(user);
    await screen.findByText(copy("You're on Pro through Downtown Speakers"));
    return calls;
  }

  it('asks first, then leaves with the session and no X-Club', async () => {
    const user = userEvent.setup();
    window.confirm.mockReturnValue(true);
    const calls = await joined(user);

    await user.click(screen.getByRole('button', { name: /^leave/i }));
    await answerConfirm(user, LEAVE_MESSAGE, { accept: true });

    await waitFor(() => expect(callsTo(calls, '/api/club/leave')).toHaveLength(1));
    const [leave] = callsTo(calls, '/api/club/leave');
    expect(leave.method).toBe('POST');
    expect(headerNames(leave)).not.toContain('x-club');
    await waitFor(() => expect(screen.queryByText(copy("You're on Pro through Downtown Speakers"))).toBeNull());
  });

  it('stays in the club when the confirm is cancelled', async () => {
    const user = userEvent.setup();
    window.confirm.mockReturnValue(false);
    const calls = await joined(user);

    await user.click(screen.getByRole('button', { name: /^leave/i }));
    await answerConfirm(user, LEAVE_MESSAGE, { accept: false });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsTo(calls, '/api/club/leave')).toEqual([]);
    expect(screen.getByText(copy("You're on Pro through Downtown Speakers"))).toBeInTheDocument();
  });

  it('offers the owner no Leave at all', async () => {
    const user = userEvent.setup();
    await joined(user, { ...STATE, role: 'admin', isOwner: true, code: CODE });

    expect(screen.queryByRole('button', { name: /leave/i })).toBeNull();
  });
});
