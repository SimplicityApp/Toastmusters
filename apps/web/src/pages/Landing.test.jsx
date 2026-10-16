import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Landing from './Landing';
import { TOOLS } from '@toastmaster-timer/shared';

const TEST_ZOOM_URL = 'https://zoom.us/oauth/authorize?test=true';

// Stands in for the real player, which would load YouTube's script. Its presence in the DOM is
// what "YouTube has loaded" means in these tests.
vi.mock('../components/YouTubePlayer', () => ({
  default: ({ videoId, autoplay }) => <div data-testid="youtube" data-video-id={videoId} data-autoplay={String(autoplay)} />,
}));

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

describe('Landing demo placement', () => {
  const renderLanding = () =>
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>
    );

  it('opens on a silent looping clip of a real run, ahead of the clubs strip', () => {
    renderLanding();

    const clip = document.querySelector('video[src="/video/hero-loop.mp4"]');
    expect(clip).not.toBeNull();
    expect(clip.muted).toBe(true);
    expect(clip.loop).toBe(true);
    expect(clip).toHaveAttribute('autoplay');
    expect(clip).toHaveAttribute('playsinline');
    expect(clip).toHaveAttribute('poster', '/video/hero-loop-poster.jpg');
    const clubs = screen.getByRole('region', { name: /clubs using toastmasters timer/i });
    expect(clip.compareDocumentPosition(clubs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the poster instead of the clip when the visitor prefers reduced motion', () => {
    vi.stubGlobal('matchMedia', (query) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} }));
    renderLanding();

    expect(document.querySelector('video[src="/video/hero-loop.mp4"]')).toBeNull();
    expect(document.querySelector('img[src="/video/hero-loop-poster.jpg"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Watch the 2-minute demo' })).toBeInTheDocument();
  });

  it('loads nothing from YouTube until someone asks to watch the demo', () => {
    renderLanding();

    expect(screen.queryByRole('dialog', { name: /best toastmasters timer tool in zoom/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('youtube')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'See it running' })).not.toBeInTheDocument();
    expect(document.getElementById('demos')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Demos' })).not.toBeInTheDocument();
  });

  it.each([
    ['the pill on the video', 'Watch the 2-minute demo'],
    ['the quiet link in the hero', 'Watch the demo'],
  ])('opens the demo popup, and only then loads the player, from %s', (_where, name) => {
    renderLanding();

    fireEvent.click(screen.getByRole('button', { name }));

    const dialog = screen.getByRole('dialog', { name: /best toastmasters timer tool in zoom/i });
    const player = within(dialog).getByTestId('youtube');
    expect(player).toHaveAttribute('data-video-id', 'D_9bbL9eSJY');
    expect(player).toHaveAttribute('data-autoplay', 'true');
    expect(within(dialog).getByRole('link', { name: 'Add to Zoom' })).toHaveAttribute('href', TEST_ZOOM_URL);
  });

  it('closes the popup with Escape, unloading the player and handing focus back to the button', () => {
    renderLanding();
    const pill = screen.getByRole('button', { name: 'Watch the 2-minute demo' });
    pill.focus();

    fireEvent.click(pill);
    expect(screen.getByRole('button', { name: 'Close the demo' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: /best toastmasters timer tool in zoom/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('youtube')).not.toBeInTheDocument();
    expect(pill).toHaveFocus();
  });

  it('teases the first three tutorials after the how-to steps, linking into /tutorials', () => {
    renderLanding();

    const section = document.getElementById('tutorials');
    expect(screen.getByRole('heading', { name: 'Short tutorials' }).closest('section')).toBe(section);
    expect(document.getElementById('how-to-zoom').compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const cards = within(section).getAllByRole('link').filter((a) => a.getAttribute('href').startsWith('/tutorials#'));
    expect(cards.map((a) => a.getAttribute('href'))).toEqual(['/tutorials#first-speech', '/tutorials#display-modes', '/tutorials#agenda']);
    expect(within(section).getByRole('link', { name: /watch all 5 tutorials/i })).toHaveAttribute('href', '/tutorials');
    expect(within(section).getByRole('link', { name: /quick demo: using in zoom/i })).toHaveAttribute('href', '/toastmasters-timer-zoom-demo');
  });

  it('previews each tutorial card as a muted loop that downloads nothing until someone points at it', () => {
    renderLanding();

    const section = document.getElementById('tutorials');
    const previews = [...section.querySelectorAll('video')];
    expect(previews).toHaveLength(3);
    previews.forEach((v) => {
      expect(v.getAttribute('src')).toMatch(/^\/video\/tutorials\/[a-z-]+\.mp4$/);
      expect(v).toHaveAttribute('preload', 'none');
      expect(v.muted).toBe(true);
      expect(v.loop).toBe(true);
      expect(v).not.toHaveAttribute('autoplay');
      expect(v).toHaveAttribute('poster');
    });
  });

  it('no longer plays the quick in-Zoom clip on the home page', () => {
    renderLanding();

    expect(screen.queryByLabelText(/demo video showing toastmasters timer/i)).not.toBeInTheDocument();
    expect(document.getElementById('more-videos')).toBeNull();
  });

  it('adds Video Tutorials to the header nav and the footer', () => {
    renderLanding();

    const nav = screen.getByRole('navigation', { name: /page sections/i });
    expect(within(nav).getByRole('link', { name: 'Video Tutorials' })).toHaveAttribute('href', '/tutorials');
    const footerLink = screen.getAllByRole('link', { name: 'Video Tutorials' }).find((a) => a.closest('footer'));
    expect(footerLink).toHaveAttribute('href', '/tutorials');
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
