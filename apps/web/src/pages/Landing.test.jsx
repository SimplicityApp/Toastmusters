import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Landing from './Landing';
import { TOOLS } from '@toastmaster-timer/shared';

const TEST_ZOOM_URL = 'https://zoom.us/oauth/authorize?test=true';

beforeEach(() => {
  import.meta.env.VITE_ZOOM_OAUTH_REDIRECT = TEST_ZOOM_URL;
  // The usage strip fetches /api/stats on mount; default to "endpoint down"
  // so tests exercise the baked fallback unless they stub a response.
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Landing', () => {
  it('every "Add to Zoom" button links to the VITE_ZOOM_OAUTH_REDIRECT env var', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>
    );

    // The header, the hero and the closing band each carry one; they must all
    // point at the same OAuth URL.
    const links = screen.getAllByRole('link', { name: /add to zoom/i });
    expect(links.length).toBeGreaterThanOrEqual(2);
    links.forEach((link) => expect(link).toHaveAttribute('href', TEST_ZOOM_URL));
  });

  it('"Open in Zoom" launches the same app the build\'s "Add to Zoom" installs', () => {
    import.meta.env.VITE_ZOOM_OAUTH_REDIRECT =
      'https://zoom.us/oauth/authorize?response_type=code&client_id=kgpoX2A6TY2BvdctzK9iw&redirect_uri=https://www.timer-dev.simple-tech.app/oauth/redirect';
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>
    );

    expect(screen.getByRole('link', { name: 'Open in Zoom' })).toHaveAttribute(
      'href',
      'https://marketplace.zoom.us/zoomapp/kgpoX2A6TY2BvdctzK9iw/context/meeting/target/launch/deeplink',
    );
  });

  it('shows the clubs in the "Trusted by" strip, with the loop copy hidden from screen readers', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>
    );

    // The marquee renders the list several times for the seamless loop; only
    // one copy may be exposed to assistive tech.
    const chips = screen.getAllByText('Jacaranda Chinese English Toastmasters');
    expect(chips.length).toBeGreaterThanOrEqual(2);
    const exposed = chips.filter((chip) => !chip.closest('[aria-hidden="true"]'));
    expect(exposed).toHaveLength(1);

    expect(screen.getAllByText('Women LEAD Toastmasters')).not.toHaveLength(0);
    expect(screen.getAllByText('Sapphire City Toastmasters')).not.toHaveLength(0);
    expect(screen.getAllByText('Malabar Toastmasters')).not.toHaveLength(0);
  });

  it('shows the baked usage numbers in the hero when /api/stats is unreachable', async () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>
    );

    // 520 users -> "500+", 55 countries exact, 1405 speeches -> "1,400+",
    // 416804 seconds of app sessions -> 115 hours -> "110+".
    expect(await screen.findByText('500+')).toBeInTheDocument();
    expect(screen.getByText('55')).toBeInTheDocument();
    expect(screen.getByText('1,400+')).toBeInTheDocument();
    expect(screen.getByText('110+')).toBeInTheDocument();
    expect(screen.getByText('speeches timed')).toBeInTheDocument();
    expect(screen.getByText('hours using the app')).toBeInTheDocument();
  });

  it('swaps in live numbers once /api/stats answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              timerUsers: 730,
              countries: 61,
              speechesTimed: 2210,
              appSeconds: 1080000, // 300 hours
            }),
        })
      )
    );

    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>
    );

    expect(await screen.findByText('700+')).toBeInTheDocument();
    expect(screen.getByText('61')).toBeInTheDocument();
    expect(screen.getByText('2,200+')).toBeInTheDocument();
    expect(screen.getByText('300+')).toBeInTheDocument();
  });

  it('introduces John C. as Founding Ambassador', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { name: 'John C.' })).toBeInTheDocument();
    expect(screen.getByText('Toastmasters Area Director')).toBeInTheDocument();
    expect(screen.getByText(/California to EMEA to Southeast Asia/)).toBeInTheDocument();
    expect(screen.getByText(/fun, low-stress way to participate/)).toBeInTheDocument();
  });
});

describe('Landing footer tools', () => {
  it('links to every other tool in the suite', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>
    );

    for (const tool of TOOLS.filter((entry) => entry.slug !== 'timer')) {
      expect(screen.getByRole('link', { name: tool.name })).toHaveAttribute('href', `${tool.url}/`);
    }
    expect(screen.getByText(/Toastmusters Timer \(this site\)/)).toBeInTheDocument();
  });
});
