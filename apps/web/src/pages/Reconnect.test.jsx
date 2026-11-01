import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ZOOM_MARKETPLACE_LISTING_URL } from '@toastmaster-timer/shared';
import { trackEvent } from '../utils/posthog';
import Reconnect from './Reconnect';

const DEV_INSTALL_URL =
  'https://zoom.us/oauth/authorize?response_type=code&client_id=kgpoX2A6TY2BvdctzK9iw' +
  '&redirect_uri=https://www.timer-dev.simple-tech.app/oauth/redirect';
const DEV_DEEPLINK = 'https://marketplace.zoom.us/zoomapp/kgpoX2A6TY2BvdctzK9iw/context/meeting/target/launch/deeplink';
const PROD_DEEPLINK = 'https://marketplace.zoom.us/zoomapp/DsFHK5sNQs2_VFyeQky2sg/context/meeting/target/launch/deeplink';

// Where a client-side link landed, so a test can tell /?home from /.
function WhereAmI() {
  const { pathname, search } = useLocation();
  return <p data-testid="location">{`${pathname}${search}`}</p>;
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/reconnect']}>
      <Routes>
        <Route path="/reconnect" element={<Reconnect />} />
        <Route path="*" element={<WhereAmI />} />
      </Routes>
    </MemoryRouter>
  );

// jsdom does not navigate. Stop the click's default action after React has
// handled it, so following an external link does not log "not implemented".
const stopNavigation = (event) => event.preventDefault();

describe('Reconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('VITE_ZOOM_OAUTH_REDIRECT', DEV_INSTALL_URL);
    window.addEventListener('click', stopNavigation);
  });

  afterEach(() => {
    window.removeEventListener('click', stopNavigation);
    vi.unstubAllEnvs();
  });

  // Worded to be true for anyone who sees it: the site cannot tell a lapsed
  // grant from a healthy one.
  it('says why the user is here, that their data is safe, and why Zoom asks', () => {
    renderPage();

    expect(screen.getByText('Welcome back')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Reconnect Toastmusters Timer to Zoom' })).toBeInTheDocument();
    expect(screen.getByText(/If Zoom asked you to approve the app again, you're in the right place\./)).toHaveTextContent(
      "If Zoom asked you to approve the app again, you're in the right place. We updated the app, and Zoom needs your OK before the timer can control your video. Nothing is broken."
    );

    const reassurances = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(reassurances.map((item) => item.textContent)).toEqual([
      '✓Your agendas, roles and reports are safe. Approving does not touch them.',
      "✓It takes about ten seconds. One click here, one on Zoom's approval screen.",
      "✓Then go back to your meeting. We'll show you the way once you're done.",
    ]);

    expect(screen.getByText(/^Why am I seeing this\?/)).toHaveTextContent(
      'Why am I seeing this? Zoom asks you to approve an app again when the permissions it needs change. You only do this once per update.'
    );
  });

  describe('"Approve in Zoom"', () => {
    // Same tab: Zoom's approval screen comes back to "You're reconnected".
    it("opens the build's Zoom install screen in the same tab", () => {
      renderPage();

      const approve = screen.getByRole('link', { name: 'Approve in Zoom' });
      expect(approve).toHaveAttribute('href', DEV_INSTALL_URL);
      expect(approve).not.toHaveAttribute('target');
    });

    it('falls back to the Marketplace listing when the build has no install link', () => {
      vi.stubEnv('VITE_ZOOM_OAUTH_REDIRECT', '');
      renderPage();

      expect(screen.getByRole('link', { name: 'Approve in Zoom' })).toHaveAttribute('href', ZOOM_MARKETPLACE_LISTING_URL);
    });
  });

  // "Approve in Zoom" on a dev build authorizes the dev app, so "Open in Zoom"
  // has to launch that same app and not the production one.
  describe('"Already approved? Open in Zoom"', () => {
    it('launches the dev app when the build carries the dev install link', () => {
      renderPage();

      expect(screen.getByRole('link', { name: 'Already approved? Open in Zoom' })).toHaveAttribute('href', DEV_DEEPLINK);
    });

    it('launches the production app when the build has no install link', () => {
      vi.stubEnv('VITE_ZOOM_OAUTH_REDIRECT', '');
      renderPage();

      expect(screen.getByRole('link', { name: 'Already approved? Open in Zoom' })).toHaveAttribute('href', PROD_DEEPLINK);
    });
  });

  it('offers the browser timer as the way out', () => {
    renderPage();

    expect(screen.getByRole('link', { name: 'Use the browser timer instead' })).toHaveAttribute('href', '/timer/app');
  });

  // A bare / is where a returning browser gets sent back here; any query string
  // reaches the homepage and keeps it there on a reload.
  it('"Go to the homepage" goes to /?home, not /', () => {
    renderPage();

    const home = screen.getByRole('link', { name: 'Go to the homepage' });
    expect(home).toHaveAttribute('href', '/?home');

    fireEvent.click(home);

    expect(screen.getByTestId('location')).toHaveTextContent('/?home');
  });

  // The funnel's second step is cta_clicked { cta: 'approve_in_zoom' } on this
  // page; every other way off it is tracked the same way.
  it.each([
    ['Approve in Zoom', 'approve_in_zoom'],
    ['Use the browser timer instead', 'web_timer'],
    ['Already approved? Open in Zoom', 'open_in_zoom'],
    ['Go to the homepage', 'home'],
  ])('tracks a click on "%s" as cta_clicked %s', (name, cta) => {
    renderPage();

    fireEvent.click(screen.getByRole('link', { name }));

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('cta_clicked', { cta, location: 'hero', page: '/reconnect' });
  });
});
