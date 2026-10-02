import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { resetEntitlementForTests, resetFlagsForTests, setFlags } from '@toastmaster-timer/shared';
import { resolveWebIdentity, resetWebIdentityForTests } from '../utils/webIdentity';
import AccountMenu from './AccountMenu';

/**
 * The header's sign-in door, on the landing page and the timer's top bar.
 *
 * Sign-in is behind the pro release flag. The link waits for the flags
 * as well as the identity, so it never appears and then vanishes; a signed-in
 * visitor keeps their account link whatever the flag says.
 */

function stubMe(body, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: status === 200, status, json: async () => body }))
  );
}

const SIGNED_OUT = [{ error: 'Unauthorized' }, 401];
const SIGNED_IN = [{ uid: 'u1', entitlement: { plan: 'free', entitled: false } }];

async function renderMenu(path = '/app') {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <AccountMenu />
    </MemoryRouter>
  );
  // Let the identity call land, so what is (or is not) on screen is the answer
  // and not the loading state.
  await act(() => resolveWebIdentity());
  return view;
}

beforeEach(() => {
  resetWebIdentityForTests();
  resetEntitlementForTests();
  resetFlagsForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AccountMenu: the pro flag', () => {
  it('offers no sign-in while the flags are still unknown, and offers it once they land on', async () => {
    stubMe(...SIGNED_OUT);
    await renderMenu();
    expect(screen.queryByTestId('sign-in-with-zoom')).toBeNull();

    act(() => {
      setFlags({ pro: true });
    });
    expect(screen.getByTestId('sign-in-with-zoom')).toBeInTheDocument();
  });

  it('offers no sign-in when the flag is off', async () => {
    stubMe(...SIGNED_OUT);
    setFlags({ pro: false });
    await renderMenu();

    expect(screen.queryByTestId('sign-in-with-zoom')).toBeNull();
    expect(screen.queryByTestId('account-link')).toBeNull();
  });

  it('links sign-in back to the page it was pressed on when the flag is on', async () => {
    stubMe(...SIGNED_OUT);
    setFlags({ pro: true });
    await renderMenu('/app?tab=agenda');

    await waitFor(() =>
      expect(screen.getByTestId('sign-in-with-zoom')).toHaveAttribute(
        'href',
        '/api/auth/zoom/start?returnTo=%2Fapp%3Ftab%3Dagenda'
      )
    );
  });

  // The session is real, so the way to the account page (and Sign out) stays.
  it('keeps the account link for a signed-in visitor when the flag is off', async () => {
    stubMe(...SIGNED_IN);
    setFlags({ pro: false });
    await renderMenu();

    expect(await screen.findByTestId('account-link')).toBeInTheDocument();
    expect(screen.queryByTestId('sign-in-with-zoom')).toBeNull();
  });
});
