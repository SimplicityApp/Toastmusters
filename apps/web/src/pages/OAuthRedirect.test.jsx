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
});
