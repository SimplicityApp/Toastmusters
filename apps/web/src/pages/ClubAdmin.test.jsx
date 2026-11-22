import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { resetClubForTests } from '@toastmaster-timer/shared';
import ClubAdmin from './ClubAdmin';

/**
 * The console, as an officer meets it: refused with two doors, or opened on a
 * roster they can act on.
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
  counts: { people: 2, placesUsed: 1, placesTotal: 3 },
  // A club with no known owner (minted by hand), so the last-admin rule is
  // what guards it; the owner's row is in ClubAdmin.members.test.jsx.
  members: [
    { uid: 'sarah', role: 'admin', displayName: 'Sarah Chen', addedAt: 1, isOwner: false },
    { uid: 'james', role: 'editor', displayName: 'James Okoro', addedAt: 2, isOwner: false },
  ],
  blocked: [],
};

/** A fetch stub keyed by path, recording every call. */
function stubApi(routes) {
  const calls = [];
  const fetchMock = vi.fn(async (url, init = {}) => {
    const path = String(url).split('?')[0];
    calls.push({ path, method: init.method || 'GET', body: init.body, headers: init.headers });
    const answer = routes[path] ?? { status: 404, body: {} };
    const resolved = typeof answer === 'function' ? answer(calls.length) : answer;
    return {
      ok: resolved.status >= 200 && resolved.status < 300,
      status: resolved.status,
      json: async () => resolved.body ?? {},
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const renderConsole = () =>
  render(
    <MemoryRouter initialEntries={['/club/admin']}>
      <ClubAdmin />
    </MemoryRouter>
  );

beforeEach(() => {
  resetClubForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ClubAdmin — the two doors', () => {
  it('offers Zoom sign-in and the billing link when nobody is signed in', async () => {
    stubApi({ '/api/club/roster': { status: 401, body: { error: 'Unauthorized' } } });
    renderConsole();

    const link = await screen.findByTestId('sign-in-with-zoom');
    expect(link).toHaveAttribute('href', '/api/auth/zoom/start?returnTo=%2Fclub%2Fadmin');
    expect(screen.getByLabelText('Admin moved on?')).toBeInTheDocument();
  });

  it('explains why a non-admin was refused, and still offers both doors', async () => {
    stubApi({ '/api/club/roster': { status: 403, body: { error: 'forbidden' } } });
    renderConsole();

    expect(await screen.findByRole('alert')).toHaveTextContent('not an admin');
    expect(screen.getByTestId('sign-in-with-zoom')).toBeInTheDocument();
  });

  // Always 200 on the server, whatever the address — so the page can only ever
  // say "if that address pays for a club".
  it('says the same thing whatever address was typed', async () => {
    const calls = stubApi({
      '/api/club/roster': { status: 401, body: {} },
      '/api/club/magic-link': { status: 200, body: { sent: true } },
    });
    renderConsole();

    await screen.findByLabelText('Admin moved on?');
    await userEvent.type(screen.getByLabelText('Admin moved on?'), 'nobody@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send link' }));

    expect(await screen.findByRole('status')).toHaveTextContent('If that address pays for a club');
    const sent = calls.find((call) => call.path === '/api/club/magic-link');
    expect(JSON.parse(sent.body)).toEqual({ email: 'nobody@example.com' });
  });
});

describe('ClubAdmin — the roster', () => {
  it('renders the people in the club and the places they use', async () => {
    stubApi({ '/api/club/roster': { status: 200, body: ROSTER } });
    renderConsole();

    expect(await screen.findByText('Downtown Speakers')).toBeInTheDocument();
    expect(screen.getByText('DTSP-7K2QM9')).toBeInTheDocument();
    expect(screen.getByText(/2 people · 1 of 3 places used/)).toBeInTheDocument();

    expect(screen.getByText('Sarah Chen')).toBeInTheDocument();
    expect(screen.getByText('James Okoro')).toBeInTheDocument();
  });

  // The roster used to label anyone without a `displayName` — which was
  // everyone, because nothing ever wrote one — with their raw Zoom uid.
  it('calls the signed-in officer "You", and names nobody else for them', async () => {
    const nameless = {
      ...ROSTER,
      members: ROSTER.members.map((member) => ({ ...member, displayName: null })),
    };
    stubApi({ '/api/club/roster': { status: 200, body: nameless } });
    renderConsole();

    expect(await screen.findByText('You')).toBeInTheDocument();
    expect(screen.getByText('james')).toBeInTheDocument();
  });

  it('lets an admin give a member a name', async () => {
    const calls = stubApi({
      '/api/club/roster': { status: 200, body: ROSTER },
      '/api/club/members/james/name': { status: 200, body: { uid: 'james', member: { displayName: 'Jim' } } },
    });
    renderConsole();

    await screen.findByText('James Okoro');
    await userEvent.click(screen.getAllByRole('button', { name: 'Rename' })[1]);
    const field = screen.getByLabelText('Name for this person');
    await userEvent.clear(field);
    await userEvent.type(field, 'Jim')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const call = calls.find((c) => c.path === '/api/club/members/james/name');
      expect(call).toBeTruthy();
      expect(JSON.parse(call.body)).toEqual({ name: 'Jim' });
    });
  });

  it('promotes a member and reloads the roster', async () => {
    const calls = stubApi({
      '/api/club/roster': { status: 200, body: ROSTER },
      '/api/club/members/james/role': { status: 200, body: { uid: 'james', member: { role: 'admin' } } },
    });
    renderConsole();

    await screen.findByText('James Okoro');
    await userEvent.selectOptions(screen.getByLabelText('Role for James Okoro'), 'admin');

    await waitFor(() => {
      const call = calls.find((c) => c.path === '/api/club/members/james/role');
      expect(call).toBeTruthy();
      expect(JSON.parse(call.body)).toEqual({ role: 'admin' });
    });
    // The roster is re-read rather than patched in place, so a cascade shows up.
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/club/roster')).toHaveLength(2));
  });

  it('says why the last admin cannot be demoted', async () => {
    stubApi({
      '/api/club/roster': { status: 200, body: ROSTER },
      '/api/club/members/sarah/role': { status: 409, body: { error: 'last_admin' } },
    });
    renderConsole();

    await screen.findByText('Sarah Chen');
    await userEvent.selectOptions(screen.getByLabelText('Role for Sarah Chen'), 'member');

    expect(await screen.findByRole('alert')).toHaveTextContent('at least one admin');
  });
});

describe('ClubAdmin — the kit', () => {
  it('saves the colour and the toggles as JSON when no file was chosen', async () => {
    const calls = stubApi({
      '/api/club/roster': { status: 200, body: ROSTER },
      '/api/club/kit': { status: 200, body: { ver: 2, kit: ROSTER.kit } },
    });
    renderConsole();

    await screen.findByLabelText('Club name');
    await userEvent.click(screen.getByLabelText('Show the header on reports'));
    await userEvent.click(screen.getByRole('button', { name: /Save brand kit/ }));

    await waitFor(() => {
      const call = calls.find((c) => c.path === '/api/club/kit');
      expect(call.method).toBe('PUT');
      expect(JSON.parse(call.body)).toMatchObject({
        name: 'Downtown Speakers',
        primaryColor: '#772432',
        showOnCards: true,
        showOnReports: false,
      });
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Saved');
  });

  it('sends the logo as multipart when one was chosen', async () => {
    const calls = stubApi({
      '/api/club/roster': { status: 200, body: ROSTER },
      '/api/club/kit': { status: 200, body: { ver: 2, kit: ROSTER.kit } },
    });
    renderConsole();

    const input = await screen.findByLabelText('Logo');
    await userEvent.upload(input, new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' }));
    await userEvent.click(screen.getByRole('button', { name: /Save brand kit/ }));

    await waitFor(() => {
      const call = calls.find((c) => c.path === '/api/club/kit');
      expect(call.body).toBeInstanceOf(FormData);
      expect(call.body.get('logo')).toBeInstanceOf(File);
      // No Content-Type of ours: the browser has to set the multipart boundary.
      expect(call.headers['Content-Type']).toBeUndefined();
    });
  });

  it('explains a rejected logo', async () => {
    stubApi({
      '/api/club/roster': { status: 200, body: ROSTER },
      '/api/club/kit': { status: 415, body: { error: 'invalid_logo_type' } },
    });
    renderConsole();

    await screen.findByLabelText('Club name');
    await userEvent.click(screen.getByRole('button', { name: /Save brand kit/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('PNG, JPEG, WebP or GIF');
  });
});

describe('ClubAdmin — billing', () => {
  it('offers the Stripe portal to the Zoom actor', async () => {
    stubApi({ '/api/club/roster': { status: 200, body: ROSTER } });
    renderConsole();
    expect(await screen.findByRole('button', { name: /Manage billing/ })).toBeInTheDocument();
  });

  // The portal is opened against the buyer's Stripe customer, which is keyed by
  // their Zoom uid — so a billing-address session has to route through a
  // promotion instead.
  it('tells the billing-link actor how to reach billing instead', async () => {
    stubApi({
      '/api/club/roster': {
        status: 200,
        body: { ...ROSTER, actor: { type: 'billing', email: 'treasurer@downtownspeakers.org' } },
      },
    });
    renderConsole();

    expect(await screen.findByText(/Promote a current officer to Admin/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Manage billing/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign out of this admin session/ })).toBeInTheDocument();
  });
});
