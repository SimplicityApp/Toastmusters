import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CLUB_STORAGE_KEY, resetClubForTests } from '@toastmaster-timer/shared';
import TimerApp from './TimerApp';

/**
 * Minimising the panel is how the browser app becomes the shared surface: the
 * card fills the window and the window is what the meeting sees. So it is the
 * one screen a club's badge most needs to be on — and the one screen nothing
 * drew it on, because the background there is set on `document.body` and no
 * component owned it.
 */

const club = (over = {}) => ({
  clubToken: 'club.tok',
  ver: 1,
  club: { id: 'club-1', name: 'Claude Test Club' },
  kit: {
    name: 'Claude Test Club',
    logoUrl: null,
    primaryColor: '#772432',
    showOnCards: true,
    showOnReports: true,
  },
  badge: { x: 0.8, y: 0.12, scale: 0.12 },
  timezone: null,
  plan: 'pro',
  entitled: true,
  status: 'active',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  source: 'club',
  lastRefreshAt: Date.now(),
  ...over,
});

function joinClub(over) {
  localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(club(over)));
  resetClubForTests();
}

const renderApp = () =>
  render(
    <MemoryRouter initialEntries={['/timer/app']}>
      <TimerApp />
    </MemoryRouter>
  );

const minimize = async () => userEvent.click(await screen.findByTitle('Minimize panel'));

describe('TimerApp — the full-screen card', () => {
  it('keeps the club badge on the card the meeting is looking at', async () => {
    joinClub();
    renderApp();

    await minimize();

    await waitFor(() => expect(screen.getByTestId('club-badge')).toHaveTextContent('Claude Test Club'));
  });

  it('draws no badge when the club turned it off', async () => {
    joinClub({ kit: { name: 'Claude Test Club', logoUrl: null, primaryColor: '#772432', showOnCards: false } });
    renderApp();

    await minimize();

    await waitFor(() => expect(screen.getByTitle('Show control panel')).toBeInTheDocument());
    expect(screen.queryByTestId('club-badge')).not.toBeInTheDocument();
  });

  it('draws no badge on a device with no club at all', async () => {
    resetClubForTests();
    renderApp();

    await minimize();

    await waitFor(() => expect(screen.getByTitle('Show control panel')).toBeInTheDocument());
    expect(screen.queryByTestId('club-badge')).not.toBeInTheDocument();
  });
});
