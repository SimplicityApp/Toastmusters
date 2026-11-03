import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { trackEvent } from '../utils/posthog';
import SignInFailureNotice from './SignInFailureNotice';

beforeEach(() => {
  trackEvent.mockClear();
});

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <SignInFailureNotice />
    </MemoryRouter>
  );

describe('SignInFailureNotice', () => {
  it('names the reason on whatever page the sign-in came back to', () => {
    at('/timer/app?signin=failed&reason=state_mismatch');
    expect(screen.getByRole('alert')).toHaveTextContent('had expired');
  });

  it('falls back to a generic line for a reason it does not know', () => {
    at('/?signin=failed&reason=something_new');
    expect(screen.getByRole('alert')).toHaveTextContent('did not finish');
  });

  it('stays out of the way when nothing failed', () => {
    at('/timer/app');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // /account renders the same message inside its own layout.
  it('defers to the account page', () => {
    at('/account?signin=failed&reason=denied');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers Sign in again, back to the same page without the failure params', () => {
    at('/timer/app?signin=failed&reason=exchange');
    expect(screen.getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
      'href',
      `/api/auth/zoom/start?returnTo=${encodeURIComponent('/timer/app')}`
    );
    expect(trackEvent).toHaveBeenCalledWith('signin_failure_shown', { reason: 'exchange', surface: 'banner' });
  });

  it('records nothing when there is no notice', () => {
    at('/timer/app');
    at('/account?signin=failed&reason=denied');
    expect(trackEvent).not.toHaveBeenCalledWith('signin_failure_shown', expect.anything());
  });

  it('can be dismissed', async () => {
    const user = userEvent.setup();
    at('/club/admin?signin=failed&reason=profile');
    await user.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
