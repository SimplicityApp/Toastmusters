import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CLUB_STORAGE_KEY,
  resetClubForTests,
  resetFlagsForTests,
  setFlags,
} from '@toastmaster-timer/shared';
import ClubStatusBanner from './ClubStatusBanner';
import { openExternalUrl } from '../utils/zoomSdk';

// Stubbed rather than imported: the real module pulls in @zoom/appssdk, which
// hangs vitest under jsdom.
vi.mock('../utils/zoomSdk', () => ({ openExternalUrl: vi.fn(async () => true) }));
vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));
vi.mock('../utils/zoomIdentity', () => ({ getSessionToken: vi.fn(() => 'session-token') }));

const DAY = 24 * 60 * 60 * 1000;

/** A club an admin is about to lose tomorrow. */
const endingTomorrow = () =>
  JSON.stringify({
    clubToken: 'tok.sig',
    lastRefreshAt: Date.now(),
    ver: 1,
    club: { id: 'club-1', name: 'Downtown Speakers' },
    kit: null,
    presets: null,
    badge: null,
    timezone: null,
    role: 'admin',
    plan: 'pro',
    entitled: true,
    status: 'active',
    currentPeriodEnd: Date.now() + DAY,
    cancelAtPeriodEnd: true,
    source: 'club',
  });

const manageBilling = () => screen.queryByRole('button', { name: /manage billing/i });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem(CLUB_STORAGE_KEY, endingTomorrow());
  resetClubForTests();
  resetFlagsForTests();
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ url: 'https://billing.stripe.com/p/1' }),
  }));
});

/**
 * The Zoom app's wiring of the grace banner. "Manage billing" is a door into
 * Stripe, which stays dark until pro is released: while it is off the
 * portal answers 404, and the button would do nothing at all.
 */
describe('ClubStatusBanner — Manage billing', () => {
  it('opens the portal in the system browser once pro is on', async () => {
    const user = userEvent.setup();
    setFlags({ pro: true });
    render(<ClubStatusBanner />);

    await user.click(manageBilling());

    const [path, init] = global.fetch.mock.calls[0];
    expect(path).toBe('/api/billing/portal');
    expect(init.headers).toEqual({ Authorization: 'Bearer session-token' });
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith('https://billing.stripe.com/p/1'));
  });

  it.each([
    ['the flags are still unknown', () => {}],
    ['pro is off', () => setFlags({ pro: false })],
  ])('still warns the admin, but offers no billing, while %s', (_, seed) => {
    seed();
    render(<ClubStatusBanner />);

    expect(screen.getByTestId('club-grace-banner')).toHaveTextContent("Downtown Speakers's Pro ends tomorrow");
    expect(screen.getByTestId('club-grace-banner')).toHaveTextContent('Renew to keep your presets');
    expect(manageBilling()).toBeNull();
  });
});
