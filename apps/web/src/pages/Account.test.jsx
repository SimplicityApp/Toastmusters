import { render, screen, waitFor } from '@testing-library/react';
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
});
