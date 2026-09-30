import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { resetEntitlementForTests, resetFlagsForTests, setFlags } from '@toastmaster-timer/shared';
import { resetWebIdentityForTests } from '../utils/webIdentity';
import Account from './Account';

function stubMe(body, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      // Both the identity call (?flags=1) and the entitlement re-check.
      if (String(url).split('?')[0] === '/api/me') return { ok: status === 200, status, json: async () => body };
      return { ok: true, status: 200, json: async () => ({}) };
    })
  );
}

beforeEach(() => {
  resetWebIdentityForTests();
  resetEntitlementForTests();
  resetFlagsForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Account', () => {
  it('offers Sign in with Zoom when there is no session', async () => {
    stubMe({ error: 'Unauthorized' }, 401);
    setFlags({ web_signin: true });
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
    setFlags({ web_signin: true });
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
    setFlags({ pro_billing: true });

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
    setFlags({ pro_billing: true });

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
    setFlags({ pro_billing: true });

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
 * The plan section is every web door into Stripe (the prices, Checkout, and
 * "Manage billing"), so it stays dark until pro_billing is released — and
 * hidden until the flags have landed, so it never appears and then vanishes.
 */
describe('Account: the pro_billing flag', () => {
  const FREE = { plan: 'free', entitled: false };
  const PRO = { plan: 'pro', entitled: true, status: 'active', currentPeriodEnd: 1_900_000_000_000, source: 'subscription' };

  const renderAccount = () =>
    render(
      <MemoryRouter initialEntries={['/account']}>
        <Account />
      </MemoryRouter>
    );

  it('hides the plan section while the flags are still unknown', async () => {
    stubMe({ uid: 'u1', entitlement: FREE });
    const { setEntitlement } = await import('@toastmaster-timer/shared');
    setEntitlement(FREE);
    renderAccount();

    // Signed in, so the rest of the page is there; only the plan is held back.
    expect(await screen.findByText('Sign out')).toBeInTheDocument();
    expect(screen.queryByTestId('account-plan')).toBeNull();
    expect(screen.queryByText('Monthly')).toBeNull();
    expect(screen.queryByText('Checking your plan…')).toBeNull();
  });

  it('hides the prices from a free user when the flag is off', async () => {
    stubMe({ uid: 'u1', entitlement: FREE });
    const { setEntitlement } = await import('@toastmaster-timer/shared');
    setEntitlement(FREE);
    setFlags({ pro_billing: false });
    renderAccount();

    expect(await screen.findByText('Sign out')).toBeInTheDocument();
    expect(screen.queryByTestId('account-plan')).toBeNull();
    expect(screen.queryByText('Monthly')).toBeNull();
    expect(screen.queryByText('Yearly')).toBeNull();
  });

  it('hides Manage billing from a subscriber when the flag is off', async () => {
    stubMe({ uid: 'u1', entitlement: PRO });
    const { setEntitlement } = await import('@toastmaster-timer/shared');
    setEntitlement(PRO);
    setFlags({ pro_billing: false });
    renderAccount();

    expect(await screen.findByText('Sign out')).toBeInTheDocument();
    expect(screen.queryByTestId('account-plan')).toBeNull();
    expect(screen.queryByText('Manage billing')).toBeNull();
  });

  it('shows the plan section once the flag is on', async () => {
    stubMe({ uid: 'u1', entitlement: FREE });
    const { setEntitlement } = await import('@toastmaster-timer/shared');
    setEntitlement(FREE);
    setFlags({ pro_billing: true });
    renderAccount();

    expect(await screen.findByTestId('account-plan')).toBeInTheDocument();
    expect(screen.getByText('Monthly')).toBeInTheDocument();
  });

  // A signed-out visitor still gets the sign-in door; the plan section was
  // never shown to them either way.
  it('leaves sign-in alone when the flag is off', async () => {
    stubMe({ uid: null, flags: { pro_billing: false, web_signin: true } });
    setFlags({ pro_billing: false, web_signin: true });
    renderAccount();

    expect(await screen.findByTestId('sign-in-with-zoom')).toBeInTheDocument();
    expect(screen.queryByTestId('account-plan')).toBeNull();
  });
});

/**
 * The signed-out card is one pitch for one door, so it stays dark until
 * web_signin is released — and hidden until the flags have landed. A signed-in
 * visitor keeps Sign out whatever the flag says.
 */
describe('Account: the web_signin flag', () => {
  const renderAccount = () =>
    render(
      <MemoryRouter initialEntries={['/account']}>
        <Account />
      </MemoryRouter>
    );

  it('offers no sign-in while the flags are still unknown', async () => {
    stubMe({ error: 'Unauthorized' }, 401);
    renderAccount();

    // The club section is there, so the page has rendered past "Loading…".
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(screen.queryByTestId('account-sign-in')).toBeNull();
    expect(screen.queryByTestId('sign-in-with-zoom')).toBeNull();
  });

  it('offers no sign-in when the flag is off', async () => {
    stubMe({ uid: null, flags: { web_signin: false } });
    setFlags({ web_signin: false });
    renderAccount();

    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(screen.queryByTestId('account-sign-in')).toBeNull();
    expect(screen.queryByTestId('sign-in-with-zoom')).toBeNull();
  });

  it('offers Sign in with Zoom once the flag is on', async () => {
    stubMe({ uid: null, flags: { web_signin: true } });
    setFlags({ web_signin: true });
    renderAccount();

    expect(await screen.findByTestId('sign-in-with-zoom')).toHaveAttribute('href', '/api/auth/zoom/start?returnTo=%2Faccount');
  });

  it('still lets a signed-in visitor sign out when the flag is off', async () => {
    stubMe({ uid: 'u1', entitlement: { plan: 'free', entitled: false } });
    setFlags({ web_signin: false });
    renderAccount();

    expect(await screen.findByText('Sign out')).toBeInTheDocument();
    expect(screen.queryByTestId('sign-in-with-zoom')).toBeNull();
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
        if (path.split('?')[0] === '/api/me') return { ok: true, status: 200, json: async () => ({ uid: 'u1', entitlement: SUBSCRIBER }) };
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
    // The plan section these cases read is behind pro_billing, and the setup
    // card is a door into a club, behind clubs.
    setFlags({ pro_billing: true, clubs: true });
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

/**
 * The `clubs` release flag. Setting up a club and typing a code are the doors
 * into one, and the Worker refuses both while clubs is dark. A browser already
 * in a club keeps it, and can always leave.
 */
describe('Account: the clubs flag', () => {
  const SUBSCRIBER = { plan: 'pro', entitled: true, status: 'active', source: 'subscription' };

  const renderAccount = () =>
    render(
      <MemoryRouter initialEntries={['/account']}>
        <Account />
      </MemoryRouter>
    );

  const asSubscriber = async () => {
    const { setEntitlement } = await import('@toastmaster-timer/shared');
    stubMe({ uid: 'u1', entitlement: SUBSCRIBER });
    setEntitlement(SUBSCRIBER);
  };

  const codeField = () => screen.queryByLabelText(/already on pro through your club/i);
  const setupButton = () => screen.queryByRole('button', { name: /set up my club/i });

  beforeEach(async () => {
    const { resetClubForTests } = await import('@toastmaster-timer/shared');
    localStorage.clear();
    resetClubForTests();
  });

  it('offers the code field and the setup card once clubs is on', async () => {
    await asSubscriber();
    setFlags({ pro_billing: true, clubs: true });
    renderAccount();

    expect(await screen.findByRole('button', { name: /set up my club/i })).toBeInTheDocument();
    expect(codeField()).toBeInTheDocument();
  });

  it.each([
    ['the flags are still unknown', () => {}],
    ['clubs is off', () => setFlags({ pro_billing: true, clubs: false })],
  ])('shows no club section at all while %s', async (_, seed) => {
    await asSubscriber();
    seed();
    renderAccount();

    await waitFor(() => expect(screen.getByText('Sign out')).toBeInTheDocument());
    expect(screen.queryByTestId('account-club')).toBeNull();
    expect(codeField()).toBeNull();
    expect(setupButton()).toBeNull();
  });

  it('still shows a browser already in a club its club, and lets it leave', async () => {
    const { CLUB_STORAGE_KEY, initClubFromCache } = await import('@toastmaster-timer/shared');
    localStorage.setItem(
      CLUB_STORAGE_KEY,
      JSON.stringify({
        clubToken: 'tok.sig',
        lastRefreshAt: Date.now(),
        ver: 1,
        club: { id: 'club-1', name: 'Downtown Speakers' },
        kit: null,
        presets: null,
        badge: null,
        timezone: null,
        role: 'admin',
        code: 'DTSP-7K2QM9',
        shareUrl: 'https://www.example.test/pro/DTSP-7K2QM9',
        plan: 'pro',
        entitled: true,
        status: 'active',
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        source: 'club',
      })
    );
    initClubFromCache();
    stubMe({ error: 'Unauthorized' }, 401);
    setFlags({ clubs: false });
    renderAccount();

    expect(await screen.findByText('This browser is on Pro through your club.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /leave this club on this device/i })).toBeInTheDocument();
    // The code is a door for somebody else, and that door is shut.
    expect(screen.queryByDisplayValue('DTSP-7K2QM9')).toBeNull();
  });
});
