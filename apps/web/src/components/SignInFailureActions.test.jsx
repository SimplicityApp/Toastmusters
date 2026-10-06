import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ZOOM_MANAGE_APPS_URL, ZOOM_SIGNIN_PERMISSION_HELP_URL } from '@toastmaster-timer/shared';
import { trackEvent } from '../utils/posthog';
import { readSigninFailure } from '../utils/signinFailure';
import SignInFailureActions from './SignInFailureActions';

const failureAt = (path) => readSigninFailure(new URL(path, 'https://www.example.test').searchParams);

const at = (path, { surface = 'banner', tone = 'light' } = {}) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <SignInFailureActions failure={failureAt(path)} surface={surface} tone={tone} />
    </MemoryRouter>
  );

beforeEach(() => {
  trackEvent.mockClear();
});

describe('SignInFailureActions', () => {
  it('offers Sign in again, back to the same page without the failure params', () => {
    at('/account?signin=failed&reason=denied&x=1');
    expect(screen.getByText('Sign in again')).toHaveAttribute(
      'href',
      `/api/auth/zoom/start?returnTo=${encodeURIComponent('/account?x=1')}`
    );
  });

  it('keeps the hash on the way back', () => {
    at('/club/admin?signin=failed&reason=profile#members');
    expect(screen.getByText('Sign in again')).toHaveAttribute(
      'href',
      `/api/auth/zoom/start?returnTo=${encodeURIComponent('/club/admin#members')}`
    );
  });

  it('records the notice being shown, once, with its reason and surface', () => {
    at('/?signin=failed&reason=scope_not_granted', { surface: 'banner' });
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('signin_failure_shown', { reason: 'scope_not_granted', surface: 'banner' });
  });

  it('reports the raw reason, even one it shows the generic line for', () => {
    at('/account?signin=failed&reason=network', { surface: 'account', tone: 'dark' });
    expect(trackEvent).toHaveBeenCalledWith('signin_failure_shown', { reason: 'network', surface: 'account' });
  });

  it('records the retry click with its reason and surface', async () => {
    const user = userEvent.setup();
    at('/timer/app?signin=failed&reason=state_mismatch', { surface: 'banner' });
    const link = screen.getByText('Sign in again');
    // jsdom cannot navigate; the click handler is what is under test.
    link.addEventListener('click', (event) => event.preventDefault());
    await user.click(link);
    expect(trackEvent).toHaveBeenCalledWith('signin_retry_clicked', { reason: 'state_mismatch', surface: 'banner' });
  });

  it('reads on the light strip and on the dark account card', () => {
    const { unmount } = at('/?signin=failed&reason=denied', { tone: 'light' });
    expect(screen.getByText('Sign in again')).toHaveClass('bg-amber-600', 'text-white');
    unmount();

    at('/account?signin=failed&reason=denied', { surface: 'account', tone: 'dark' });
    expect(screen.getByText('Sign in again')).toHaveClass('bg-white', 'text-gray-900');
  });

  describe('when Zoom did not grant the permission', () => {
    // jsdom cannot open a new tab; the click handler is what is under test.
    const clickWithoutNavigating = async (user, element) => {
      element.addEventListener('click', (event) => event.preventDefault());
      await user.click(element);
    };

    it('also offers Manage in Zoom and Why does Zoom ask?, each in a new tab', () => {
      at('/?signin=failed&reason=scope_not_granted');

      const manage = screen.getByText('Manage in Zoom');
      expect(manage).toHaveAttribute('href', ZOOM_MANAGE_APPS_URL);
      expect(manage).toHaveAttribute('target', '_blank');
      expect(manage.getAttribute('rel')).toContain('noopener');

      const why = screen.getByText('Why does Zoom ask?');
      expect(why).toHaveAttribute('href', ZOOM_SIGNIN_PERMISSION_HELP_URL);
      expect(why).toHaveAttribute('target', '_blank');
      expect(why.getAttribute('rel')).toContain('noopener');

      // The one-click fix is still there, and still in the same tab.
      expect(screen.getByText('Sign in again')).not.toHaveAttribute('target');
    });

    it.each(['denied', 'profile', 'state_mismatch', 'network'])(
      'does not offer them for reason=%s, which a Marketplace visit cannot fix',
      (reason) => {
        at(`/?signin=failed&reason=${reason}`);
        expect(screen.getByText('Sign in again')).toBeInTheDocument();
        expect(screen.queryByText('Manage in Zoom')).not.toBeInTheDocument();
        expect(screen.queryByText('Why does Zoom ask?')).not.toBeInTheDocument();
      }
    );

    it('records the Manage in Zoom click with its reason and surface', async () => {
      const user = userEvent.setup();
      at('/account?signin=failed&reason=scope_not_granted', { surface: 'account', tone: 'dark' });
      await clickWithoutNavigating(user, screen.getByText('Manage in Zoom'));
      expect(trackEvent).toHaveBeenCalledWith('zoom_manage_app_clicked', {
        reason: 'scope_not_granted',
        surface: 'account',
      });
    });

    it('records the Why does Zoom ask? click with its reason and surface', async () => {
      const user = userEvent.setup();
      at('/?signin=failed&reason=scope_not_granted', { surface: 'banner' });
      await clickWithoutNavigating(user, screen.getByText('Why does Zoom ask?'));
      expect(trackEvent).toHaveBeenCalledWith('signin_help_clicked', {
        reason: 'scope_not_granted',
        surface: 'banner',
      });
    });

    it('fires no click event just by showing the links', () => {
      at('/?signin=failed&reason=scope_not_granted');
      expect(trackEvent.mock.calls.map(([event]) => event)).toEqual(['signin_failure_shown']);
    });

    it('styles Manage in Zoom as the secondary action on both tones', () => {
      const { unmount } = at('/?signin=failed&reason=scope_not_granted', { tone: 'light' });
      expect(screen.getByText('Manage in Zoom')).toHaveClass('bg-white', 'text-ink');
      unmount();

      at('/account?signin=failed&reason=scope_not_granted', { surface: 'account', tone: 'dark' });
      expect(screen.getByText('Manage in Zoom')).toHaveClass('bg-white/10', 'text-white');
    });
  });
});
