import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import SignInFailureNotice from './SignInFailureNotice';

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

  it('can be dismissed', async () => {
    const user = userEvent.setup();
    at('/club/admin?signin=failed&reason=profile');
    await user.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
