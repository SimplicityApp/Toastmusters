import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CLUB_STORAGE_KEY,
  CLUB_GRACE_DISMISSED_STORAGE_KEY,
  resetClubForTests,
  resetFlagsForTests,
  setFlags,
} from '@toastmaster-timer/shared';
import ClubStatusBanner from './ClubStatusBanner';
import { trackEvent } from '../utils/posthog';

vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));

const DAY = 24 * 60 * 60 * 1000;

const cache = (over = {}) =>
  JSON.stringify({
    clubToken: 'tok.sig',
    lastRefreshAt: Date.now(),
    ver: 1,
    club: { id: 'club-1', name: 'Downtown Speakers' },
    kit: null,
    presets: null,
    badge: null,
    timezone: null,
    role: null,
    plan: 'pro',
    entitled: true,
    status: 'active',
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    source: 'club',
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetClubForTests();
  resetFlagsForTests();
});

describe('ClubStatusBanner', () => {
  // The banner is the one thing on screen for a device that is about to lose
  // everything, so it has to be absent for every device that is not.
  it('says nothing for a free device or a healthy club', () => {
    const { rerender } = render(<ClubStatusBanner />);
    expect(screen.queryByTestId('club-grace-banner')).not.toBeInTheDocument();

    localStorage.setItem(CLUB_STORAGE_KEY, cache());
    resetClubForTests();
    rerender(<ClubStatusBanner />);
    expect(screen.queryByTestId('club-grace-banner')).not.toBeInTheDocument();
  });

  // Whoever is timing is rarely whoever pays, so a member is told who to ask
  // rather than shown a billing page they cannot use.
  it('counts down for a member and names who to ask', () => {
    localStorage.setItem(
      CLUB_STORAGE_KEY,
      cache({ status: 'past_due', currentPeriodEnd: Date.now() - 2 * DAY })
    );
    render(<ClubStatusBanner />);

    expect(screen.getByTestId('club-grace-banner')).toHaveTextContent("Downtown Speakers's Pro ends in 5 days");
    expect(screen.getByTestId('club-grace-banner')).toHaveTextContent('Ask your club admin to renew');
    expect(screen.queryByRole('button', { name: /manage billing/i })).not.toBeInTheDocument();
    expect(trackEvent).toHaveBeenCalledWith('club_grace_banner_shown', {
      surface: 'web',
      club_id: 'club-1',
      days_left: 5,
      is_admin: false,
    });
  });

  it('offers billing to an admin', () => {
    setFlags({ pro: true });
    localStorage.setItem(
      CLUB_STORAGE_KEY,
      cache({ status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: Date.now() + DAY, role: 'admin' })
    );
    render(<ClubStatusBanner />);

    expect(screen.getByTestId('club-grace-banner')).toHaveTextContent("Downtown Speakers's Pro ends tomorrow");
    expect(screen.getByRole('button', { name: /manage billing/i })).toBeInTheDocument();
  });

  // The portal answers 404 while pro is off, so the button would do
  // nothing. The warning itself still reaches the admin.
  it.each([
    ['the flags are still unknown', () => {}],
    ['pro is off', () => setFlags({ pro: false })],
  ])('warns an admin but offers no billing while %s', (_, seed) => {
    seed();
    localStorage.setItem(
      CLUB_STORAGE_KEY,
      cache({ status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: Date.now() + DAY, role: 'admin' })
    );
    render(<ClubStatusBanner />);

    expect(screen.getByTestId('club-grace-banner')).toHaveTextContent('Renew to keep your presets');
    expect(screen.queryByRole('button', { name: /manage billing/i })).not.toBeInTheDocument();
  });

  // Quiet for the rest of the meeting, not for the rest of the grace window.
  it('dismisses for today only', async () => {
    const user = userEvent.setup();
    localStorage.setItem(CLUB_STORAGE_KEY, cache({ status: 'past_due', currentPeriodEnd: Date.now() }));
    render(<ClubStatusBanner />);

    await user.click(screen.getByRole('button', { name: /dismiss for today/i }));

    expect(screen.queryByTestId('club-grace-banner')).not.toBeInTheDocument();
    expect(localStorage.getItem(CLUB_GRACE_DISMISSED_STORAGE_KEY)).toBeTruthy();
  });

  // A lapsed club has had its week of warning; the explanation moves to the
  // upgrade modal and the rules editor rather than nagging above the tabs.
  it('goes away entirely once the club has lapsed', () => {
    localStorage.setItem(CLUB_STORAGE_KEY, cache({ plan: 'free', entitled: false, status: 'canceled', source: 'none' }));
    render(<ClubStatusBanner />);

    expect(screen.queryByTestId('club-grace-banner')).not.toBeInTheDocument();
  });
});
