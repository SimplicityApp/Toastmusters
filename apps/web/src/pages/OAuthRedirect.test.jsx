import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { trackEvent } from '../utils/posthog';
import OAuthRedirect from './OAuthRedirect';

const DEV_INSTALL_URL =
  'https://zoom.us/oauth/authorize?response_type=code&client_id=kgpoX2A6TY2BvdctzK9iw' +
  '&redirect_uri=https://www.timer-dev.simple-tech.app/oauth/redirect';
const DEV_DEEPLINK = 'https://marketplace.zoom.us/zoomapp/kgpoX2A6TY2BvdctzK9iw/context/meeting/target/launch/deeplink';
const PROD_DEEPLINK = 'https://marketplace.zoom.us/zoomapp/DsFHK5sNQs2_VFyeQky2sg/context/meeting/target/launch/deeplink';

const renderAt = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <OAuthRedirect />
    </MemoryRouter>
  );

describe('OAuthRedirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The Worker redirects Zoom's install landing to ?welcome=back|new
  // (worker/reconnect.js). That redirect is the install; a bare visit is not.
  describe('zoom_app_installed', () => {
    it.each(['new', 'back'])('fires once with welcome=%s', (welcome) => {
      renderAt(`/oauth/redirect?welcome=${welcome}`);

      expect(trackEvent).toHaveBeenCalledTimes(1);
      expect(trackEvent).toHaveBeenCalledWith('zoom_app_installed', {
        source: 'oauth_redirect',
        welcome,
      });
    });

    it.each(['/oauth/redirect', '/oauth/redirect?welcome=', '/oauth/redirect?welcome=bogus', '/oauth/redirect?code=abc123'])(
      'does not fire for %s',
      (path) => {
        renderAt(path);

        expect(trackEvent).not.toHaveBeenCalled();
      }
    );

    // The code is a live OAuth credential. The Worker drops it before the page
    // loads; should one ever arrive anyway, analytics must not learn it.
    it('never carries a code, or anything else from the URL', () => {
      renderAt('/oauth/redirect?welcome=new&code=abc123&state=xyz');

      expect(trackEvent).toHaveBeenCalledTimes(1);
      const [, properties] = trackEvent.mock.calls[0];
      expect(properties).toEqual({ source: 'oauth_redirect', welcome: 'new' });
      expect(JSON.stringify(properties)).not.toContain('abc123');
    });
  });

  describe('a browser that had approved the app before (?welcome=back)', () => {
    it('shows "You\'re reconnected" with the data-safe line, and no demo videos', () => {
      const { getByRole, getByText, queryByText } = renderAt('/oauth/redirect?welcome=back');

      expect(getByRole('heading', { name: "You're reconnected" })).toBeInTheDocument();
      expect(getByRole('status')).toHaveTextContent('Your agendas, roles and reports are exactly where you left them.');
      expect(getByText('Then start or rejoin your meeting. The timer is back in your meeting toolbar.')).toBeInTheDocument();
      expect(queryByText('Zoom app installed successfully')).not.toBeInTheDocument();
      expect(queryByText('Quick Demo: Using in Zoom')).not.toBeInTheDocument();
      expect(queryByText('Watch the Full Product Demo')).not.toBeInTheDocument();
    });

    it('offers "Open in Zoom" for the dev app on a dev build, and "Open Zoom in browser"', () => {
      vi.stubEnv('VITE_ZOOM_OAUTH_REDIRECT', DEV_INSTALL_URL);
      const { getByRole } = renderAt('/oauth/redirect?welcome=back');

      expect(getByRole('link', { name: 'Open in Zoom' })).toHaveAttribute('href', DEV_DEEPLINK);
      expect(getByRole('link', { name: 'Open Zoom in browser' })).toHaveAttribute('href', 'https://app.zoom.us');
    });

    it('opens the production app when the build has no install link', () => {
      vi.stubEnv('VITE_ZOOM_OAUTH_REDIRECT', '');
      const { getByRole } = renderAt('/oauth/redirect?welcome=back');

      expect(getByRole('link', { name: 'Open in Zoom' })).toHaveAttribute('href', PROD_DEEPLINK);
    });
  });

  // A first install, or any other query: today's page, unchanged.
  describe.each(['/oauth/redirect?welcome=new', '/oauth/redirect'])('the installed page at %s', (path) => {
    it('renders the success content and the demo videos', () => {
      const { getByText, queryByText } = renderAt(path);

      expect(getByText('Zoom app installed successfully')).toBeInTheDocument();
      expect(getByText('Quick Demo: Using in Zoom')).toBeInTheDocument();
      expect(getByText('Watch the Full Product Demo')).toBeInTheDocument();
      expect(queryByText("You're reconnected")).not.toBeInTheDocument();
    });

    // "Add to Zoom" on a dev build authorizes the dev app, so "Open Zoom app"
    // has to launch that same app and not the production one.
    it('launches the dev app when the build carries the dev install link', () => {
      vi.stubEnv('VITE_ZOOM_OAUTH_REDIRECT', DEV_INSTALL_URL);
      const { getByRole } = renderAt(path);

      expect(getByRole('link', { name: 'Open Zoom app' })).toHaveAttribute('href', DEV_DEEPLINK);
    });

    it('launches the production app when the build has no install link', () => {
      vi.stubEnv('VITE_ZOOM_OAUTH_REDIRECT', '');
      const { getByRole } = renderAt(path);

      expect(getByRole('link', { name: 'Open Zoom app' })).toHaveAttribute('href', PROD_DEEPLINK);
    });
  });
});
