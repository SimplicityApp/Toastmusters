import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { resetFlagsForTests, setFlags } from '@toastmaster-timer/shared';
import ClubMagicLink from './ClubMagicLink';

/**
 * The page a mailed admin link lands on. It spends the token with a POST, so a
 * link-prefetching email client cannot burn a single-use token on the way in.
 */

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/club/manage" element={<ClubMagicLink />} />
        <Route path="/club/admin" element={<p>The console</p>} />
      </Routes>
    </MemoryRouter>
  );
}

// Released unless a test says otherwise: the page is a door into a club, and
// its dark position has its own block at the end.
beforeEach(() => {
  resetFlagsForTests();
  setFlags({ clubs: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ClubMagicLink', () => {
  it('spends the token with a POST and lands on the console', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, club: { id: 'club-1', name: 'Downtown Speakers' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/club/manage?t=abc123');

    expect(await screen.findByText('The console')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/club/manage?t=abc123');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
  });

  it('explains an expired link and offers a fresh one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: 'expired' }) }))
    );

    renderAt('/club/manage?t=stale');

    expect(await screen.findByRole('alert')).toHaveTextContent('expired');
    expect(screen.getByRole('link', { name: 'Ask for a new link' })).toHaveAttribute('href', '/club/admin');
  });

  // The Worker's GET fallback redirects here with ?error=… rather than erroring.
  it('reads a reason the Worker put in the query string, without calling anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/club/manage?error=invalid_link');

    expect(await screen.findByRole('alert')).toHaveTextContent('already been used');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blames the network rather than the link when the call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));

    renderAt('/club/manage?t=abc123');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the server'));
  });
});

// The link opens the console, which is a door into a club. While clubs is dark
// the Worker refuses the token anyway, so the page does not spend it: it waits
// for the flags, and is the not-found view when they say off.
describe('ClubMagicLink — the clubs flag', () => {
  it('spends nothing until the flags land, then spends the token', async () => {
    resetFlagsForTests();
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/club/manage?t=abc123');
    expect(screen.getByText(/Opening your club/)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => { setFlags({ clubs: true }); });
    expect(await screen.findByText('The console')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is the not-found view when clubs is off, and spends nothing', async () => {
    setFlags({ clubs: false });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderAt('/club/manage?t=abc123');

    expect(screen.getByTestId('not-found')).toHaveTextContent('Page not found');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the not-found view rather than a reason from the Worker when clubs is off', () => {
    setFlags({ clubs: false });
    vi.stubGlobal('fetch', vi.fn());

    renderAt('/club/manage?error=invalid_link');

    expect(screen.getByTestId('not-found')).toBeInTheDocument();
    expect(screen.queryByText(/already been used/)).toBeNull();
  });
});
