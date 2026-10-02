import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { resetClubForTests, resetFlagsForTests, setFlags } from '@toastmaster-timer/shared';
import { resetWebIdentityForTests } from '../utils/webIdentity';
import ProActivate from './ProActivate';

/**
 * /pro/<code>, the officer's shareable link. Joining is a door into a club, so
 * the page sits behind the `clubs` release flag: it activates nothing until the
 * flags land, and is the not-found view while clubs is off.
 */

const CLUB = {
  clubToken: 'tok.sig',
  ver: 1,
  club: { id: 'club-1', name: 'Downtown Speakers' },
  kit: null,
  presets: null,
  badge: null,
  timezone: null,
  role: null,
  plan: 'pro',
  entitled: true,
  status: 'active',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  source: 'club',
};

/** The identity call answers "signed out"; activation answers with the club. */
function stubApi() {
  const fetchMock = vi.fn(async (url) => {
    const path = String(url).split('?')[0];
    if (path === '/api/club/activate') return { ok: true, status: 200, json: async () => CLUB };
    return { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return () => fetchMock.mock.calls.filter(([url]) => String(url) === '/api/club/activate');
}

const renderAt = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/pro/:code" element={<ProActivate />} />
      </Routes>
    </MemoryRouter>
  );

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  resetWebIdentityForTests();
  resetClubForTests();
  resetFlagsForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProActivate — the clubs flag', () => {
  it('activates the code from the link once clubs is on', async () => {
    setFlags({ clubs: true });
    const activations = stubApi();
    renderAt('/pro/DTSP-7K2QM9');

    expect(await screen.findByText(/You're on Pro in this browser/)).toBeInTheDocument();
    expect(activations()).toHaveLength(1);
    expect(JSON.parse(activations()[0][1].body)).toEqual({ code: 'DTSP-7K2QM9', deviceId: expect.any(String) });
  });

  it('activates nothing while the flags are still unknown, then activates once they land', async () => {
    const activations = stubApi();
    renderAt('/pro/DTSP-7K2QM9');

    expect(screen.getByText('Activating…')).toBeInTheDocument();
    await settle();
    expect(activations()).toHaveLength(0);

    act(() => { setFlags({ clubs: true }); });
    expect(await screen.findByText(/You're on Pro in this browser/)).toBeInTheDocument();
    expect(activations()).toHaveLength(1);
  });

  it('is the not-found view when clubs is off, and activates nothing', async () => {
    setFlags({ clubs: false });
    const activations = stubApi();
    renderAt('/pro/DTSP-7K2QM9');

    expect(screen.getByTestId('not-found')).toHaveTextContent('Page not found');
    expect(screen.queryByText(/That code didn't work/)).toBeNull();
    await settle();
    expect(activations()).toHaveLength(0);
  });
});
