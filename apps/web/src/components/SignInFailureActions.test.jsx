import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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
});
