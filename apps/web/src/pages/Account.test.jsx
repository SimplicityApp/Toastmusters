import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { resetEntitlementForTests } from '@toastmaster-timer/shared';
import { resetWebIdentityForTests } from '../utils/webIdentity';
import Account from './Account';

function stubMe(body, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      if (String(url) === '/api/me') return { ok: status === 200, status, json: async () => body };
      return { ok: true, status: 200, json: async () => ({}) };
    })
  );
}

beforeEach(() => {
  resetWebIdentityForTests();
  resetEntitlementForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Account', () => {
  it('offers Sign in with Zoom when there is no session', async () => {
    stubMe({ error: 'Unauthorized' }, 401);
    render(
      <MemoryRouter initialEntries={['/account']}>
        <Account />
      </MemoryRouter>
    );
    const link = await screen.findByTestId('sign-in-with-zoom');
    expect(link).toHaveAttribute('href', '/api/auth/zoom/start?returnTo=%2Faccount');
  });

  it('explains a failed sign-in from the query string', async () => {
    stubMe({ error: 'Unauthorized' }, 401);
    render(
      <MemoryRouter initialEntries={['/account?signin=failed&reason=denied']}>
        <Account />
      </MemoryRouter>
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('closed the Zoom sign-in');
  });

  it('shows the plan and billing controls for a signed-in Pro user', async () => {
    stubMe({ uid: 'u1', entitlement: { plan: 'pro', entitled: true, status: 'active', currentPeriodEnd: 1_900_000_000_000, source: 'subscription' } });
    // The page seeds the store from /api/me through startWebSession in main.jsx;
    // in isolation, seed it the way the app would.
    const { setEntitlement } = await import('@toastmaster-timer/shared');
    setEntitlement({ plan: 'pro', entitled: true, status: 'active', currentPeriodEnd: 1_900_000_000_000, source: 'subscription' });

    render(
      <MemoryRouter initialEntries={['/account']}>
        <Account />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText('Manage billing')).toBeInTheDocument());
    expect(screen.getByText('Sign out')).toBeInTheDocument();
    expect(screen.getByText(/Renews on/)).toBeInTheDocument();
  });

  it('offers the two prices to a signed-in free user', async () => {
    stubMe({ uid: 'u1', entitlement: { plan: 'free', entitled: false } });
    const { setEntitlement } = await import('@toastmaster-timer/shared');
    setEntitlement({ plan: 'free', entitled: false });

    render(
      <MemoryRouter initialEntries={['/account']}>
        <Account />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText('Monthly')).toBeInTheDocument());
    expect(screen.getByText('Yearly')).toBeInTheDocument();
  });

  // Payment is the one moment the club's name naturally exists, but an empty
  // field must never stand between a treasurer and a purchase.
  it('carries the optional club name into checkout without ever requiring it', async () => {
    const user = userEvent.setup();
    stubMe({ uid: 'u1', entitlement: { plan: 'free', entitled: false } });
    const { setEntitlement } = await import('@toastmaster-timer/shared');
    setEntitlement({ plan: 'free', entitled: false });

    render(
      <MemoryRouter initialEntries={['/account']}>
        <Account />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText('Monthly')).toBeInTheDocument());
    await user.click(screen.getByText('Yearly'));
    expect(JSON.parse(fetch.mock.calls.find(([url]) => url === '/api/billing/checkout')[1].body))
      .toEqual({ interval: 'yearly' });

    await user.type(screen.getByLabelText(/your club's name/i), 'Downtown Speakers');
    await user.click(screen.getByText('Monthly'));
    expect(JSON.parse(fetch.mock.calls.filter(([url]) => url === '/api/billing/checkout')[1][1].body))
      .toEqual({ interval: 'monthly', clubName: 'Downtown Speakers' });
  });
});

/**
 * Setting up the club a subscription pays for.
 *
 * The state that made this necessary: a subscriber from before the club bundle
 * has Pro and no club, so the page showed them their plan and a code field for
 * a club they do not belong to — and no way to make one.
 */
describe('Account: setting up a club', () => {
  const SUBSCRIBER = { plan: 'pro', entitled: true, status: 'active', source: 'subscription' };

  /**
   * A signed-in subscriber, plus whatever this test wants to answer.
   *
   * /api/me has to keep answering: the page re-asks it on mount, and an answer
   * without an entitlement drops the store back to free — which renders the
   * upsell instead of the card under test.
   */
  const asSubscriber = async (routes = {}) => {
    const { setEntitlement } = await import('@toastmaster-timer/shared');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const path = String(url);
        if (routes[path]) return routes[path];
        if (path === '/api/me') return { ok: true, status: 200, json: async () => ({ uid: 'u1', entitlement: SUBSCRIBER }) };
        return { ok: true, status: 200, json: async () => ({}) };
      })
    );
    setEntitlement(SUBSCRIBER);
  };

  const renderAccount = () =>
    render(
      <MemoryRouter initialEntries={['/account']}>
        <Account />
      </MemoryRouter>
    );

  beforeEach(async () => {
    const { resetClubForTests } = await import('@toastmaster-timer/shared');
    resetClubForTests();
    localStorage.clear();
  });

  it('offers the card to a subscriber with no club', async () => {
    await asSubscriber();
    renderAccount();
    expect(await screen.findByRole('button', { name: /set up my club/i })).toBeInTheDocument();
  });

  it('stays hidden from a free user', async () => {
    const { setEntitlement } = await import('@toastmaster-timer/shared');
    stubMe({ uid: 'u1', entitlement: { plan: 'free', entitled: false } });
    setEntitlement({ plan: 'free', entitled: false });
    renderAccount();

    await waitFor(() => expect(screen.getByText('Monthly')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /set up my club/i })).toBeNull();
  });

  // A comp grant is operator-minted, and so is the club that goes with it.
  it('stays hidden from a comp grant', async () => {
    const { setEntitlement } = await import('@toastmaster-timer/shared');
    const entitlement = { plan: 'pro', entitled: true, status: 'granted', source: 'grant' };
    stubMe({ uid: 'u1', entitlement });
    setEntitlement(entitlement);
    renderAccount();

    await waitFor(() => expect(screen.getByText(/Complimentary access/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /set up my club/i })).toBeNull();
  });

  it('creates the club and hands over the code and the invite link', async () => {
    const user = userEvent.setup();
    await asSubscriber({
      '/api/club/create': {
        ok: true,
        status: 200,
        json: async () => ({
          clubToken: 'tok.sig',
          created: true,
          code: 'DTSP-7K2QM9',
          shareUrl: 'https://www.example.test/pro/DTSP-7K2QM9',
          ver: 1,
          club: { id: 'club-1', name: 'Downtown Speakers' },
          role: 'admin',
          plan: 'pro',
          entitled: true,
          source: 'subscription',
        }),
      },
    });
    renderAccount();

    await user.click(await screen.findByRole('button', { name: /set up my club/i }));

    expect(await screen.findByDisplayValue('DTSP-7K2QM9')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://www.example.test/pro/DTSP-7K2QM9')).toBeInTheDocument();
  });

  it('names a refusal rather than failing quietly', async () => {
    const user = userEvent.setup();
    await asSubscriber({
      '/api/club/create': { ok: false, status: 403, json: async () => ({ error: 'not_a_subscriber' }) },
    });
    renderAccount();

    await user.click(await screen.findByRole('button', { name: /set up my club/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/person who pays for the plan/i);
  });
});
