import { render, screen, waitFor, within } from '@testing-library/react';
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
  counts: { devices: 4, people: 2, guestDevices: 1 },
  members: [
    {
      uid: 'sarah',
      role: 'admin',
      displayName: 'Sarah Chen',
      revokedAt: null,
      devices: [
        { deviceId: 'd1', label: 'Chrome · Windows', activatedAt: 1_700_000_000_000, lastSeenAt: 1_700_100_000_000, revokedAt: null },
        { deviceId: 'd2', label: 'Safari · iPad', activatedAt: 1_700_000_000_000, lastSeenAt: 1_700_050_000_000, revokedAt: null },
      ],
    },
    {
      uid: 'james',
      role: 'editor',
      displayName: 'James Okoro',
      revokedAt: null,
      devices: [{ deviceId: 'd3', label: 'Chrome · macOS', activatedAt: 1, lastSeenAt: 2, revokedAt: null }],
    },
  ],
  guestDevices: [
    { deviceId: 'd4', label: 'Firefox · Windows', activatedAt: 1, lastSeenAt: 2, revokedAt: null },
  ],
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
  it('renders every device grouped under its person, with guests on their own', async () => {
    stubApi({ '/api/club/roster': { status: 200, body: ROSTER } });
    renderConsole();

    expect(await screen.findByText('Downtown Speakers')).toBeInTheDocument();
    expect(screen.getByText('DTSP-7K2QM9')).toBeInTheDocument();
    expect(screen.getByText(/4 devices · 2 people/)).toBeInTheDocument();

    expect(screen.getByText('Sarah Chen')).toBeInTheDocument();
    expect(screen.getByText('Chrome · Windows')).toBeInTheDocument();
    expect(screen.getByText('Safari · iPad')).toBeInTheDocument();
    expect(screen.getByText('James Okoro')).toBeInTheDocument();

    const guests = screen.getByText('Guest devices').closest('div');
    expect(within(guests).getByText('Firefox · Windows')).toBeInTheDocument();
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

  it('revokes a guest device', async () => {
    const calls = stubApi({
      '/api/club/roster': { status: 200, body: ROSTER },
      '/api/club/devices/d4/revoke': { status: 200, body: { deviceId: 'd4' } },
    });
    renderConsole();

    await screen.findByText('Guest devices');
    const guests = screen.getByText('Guest devices').closest('div');
    await userEvent.click(within(guests).getByRole('button', { name: /Revoke/ }));

    await waitFor(() => {
      const call = calls.find((c) => c.path === '/api/club/devices/d4/revoke');
      expect(JSON.parse(call.body)).toEqual({ revoked: true });
    });
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
