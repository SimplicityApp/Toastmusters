import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { trackEvent } from '../utils/posthog';
import OAuthRedirect from './OAuthRedirect';

describe('OAuthRedirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fires zoom_app_installed event on mount', () => {
    render(
      <MemoryRouter initialEntries={['/oauth/redirect']}>
        <OAuthRedirect />
      </MemoryRouter>
    );

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('zoom_app_installed', {
      source: 'oauth_redirect',
      has_code: false,
      has_state: false,
    });
  });

  // The code is a live OAuth credential. Analytics may learn that one arrived,
  // never what it was.
  it('reports that a code arrived without recording its value', () => {
    render(
      <MemoryRouter initialEntries={['/oauth/redirect?code=abc123&state=xyz']}>
        <OAuthRedirect />
      </MemoryRouter>
    );

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('zoom_app_installed', {
      source: 'oauth_redirect',
      has_code: true,
      has_state: true,
    });
    const [, properties] = trackEvent.mock.calls[0];
    expect(JSON.stringify(properties)).not.toContain('abc123');
  });

  it('renders the success page content', () => {
    const { getByText } = render(
      <MemoryRouter initialEntries={['/oauth/redirect']}>
        <OAuthRedirect />
      </MemoryRouter>
    );

    expect(getByText('Zoom app installed successfully')).toBeInTheDocument();
  });

  // "Add to Zoom" on a dev build authorizes the dev app, so "Open Zoom app"
  // has to launch that same app and not the production one.
  describe('"Open Zoom app" link', () => {
    const DEV_INSTALL_URL =
      'https://zoom.us/oauth/authorize?response_type=code&client_id=kgpoX2A6TY2BvdctzK9iw' +
      '&redirect_uri=https://www.timer-dev.simple-tech.app/oauth/redirect';

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('launches the dev app when the build carries the dev install link', () => {
      vi.stubEnv('VITE_ZOOM_OAUTH_REDIRECT', DEV_INSTALL_URL);
      const { getByRole } = render(
        <MemoryRouter initialEntries={['/oauth/redirect']}>
          <OAuthRedirect />
        </MemoryRouter>
      );

      expect(getByRole('link', { name: 'Open Zoom app' })).toHaveAttribute(
        'href',
        'https://marketplace.zoom.us/zoomapp/kgpoX2A6TY2BvdctzK9iw/context/meeting/target/launch/deeplink',
      );
    });

    it('launches the production app when the build has no install link', () => {
      vi.stubEnv('VITE_ZOOM_OAUTH_REDIRECT', '');
      const { getByRole } = render(
        <MemoryRouter initialEntries={['/oauth/redirect']}>
          <OAuthRedirect />
        </MemoryRouter>
      );

      expect(getByRole('link', { name: 'Open Zoom app' })).toHaveAttribute(
        'href',
        'https://marketplace.zoom.us/zoomapp/DsFHK5sNQs2_VFyeQky2sg/context/meeting/target/launch/deeplink',
      );
    });
  });
});
