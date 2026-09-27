import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UpgradeModal from './UpgradeModal';
import { trackEvent } from '../utils/posthog';
import { resolveZoomIdentity } from '../utils/zoomIdentity';
import {
  CLUB_STORAGE_KEY,
  resetClubForTests,
  resetEntitlementForTests,
  initClubFromCache,
  getEntitlement,
} from '@toastmaster-timer/shared';

// Stubbed rather than imported: the real module pulls in @zoom/appssdk, which
// hangs vitest under jsdom.
vi.mock('../utils/zoomSdk', () => ({ openExternalUrl: vi.fn() }));
vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));
vi.mock('../utils/zoomIdentity', () => ({
  resolveZoomIdentity: vi.fn(),
  getSessionToken: vi.fn(() => 'session-token'),
}));

const clubState = (over = {}) => ({
  ver: 1,
  club: { id: 'club-1', name: 'Downtown Speakers' },
  kit: null,
  presets: null,
  badge: null,
  timezone: null,
  plan: 'pro',
  entitled: true,
  status: 'active',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  source: 'club',
  ...over,
});

function renderModal(props = {}) {
  const merged = { isOpen: true, onClose: vi.fn(), source: 'footer', onUpgraded: vi.fn(), ...props };
  render(<UpgradeModal {...merged} />);
  return merged;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetClubForTests();
  resetEntitlementForTests();
  resolveZoomIdentity.mockResolvedValue({ identified: true, uid: 'u1' });
  global.fetch = vi.fn();
});

describe('club code entry', () => {
  it('turns the device Pro and tells analytics which club', async () => {
    const user = userEvent.setup();
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ clubToken: 'tok.sig', ...clubState() }),
    });
    const props = renderModal();
    await screen.findByLabelText(/already on pro through your club/i);

    await user.type(screen.getByLabelText(/already on pro through your club/i), 'dtsp-7k2qm9');
    await user.click(screen.getByRole('button', { name: /activate/i }));

    // The modal switches to the club confirmation; the pricing is gone.
    expect(await screen.findByText(/Downtown Speakers/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /monthly/i })).not.toBeInTheDocument();

    const [path, init] = global.fetch.mock.calls[0];
    expect(path).toBe('/api/club/activate');
    expect(JSON.parse(init.body)).toEqual({ code: 'dtsp-7k2qm9' });
    expect(getEntitlement()).toMatchObject({ plan: 'pro', entitled: true, source: 'club' });
    expect(trackEvent).toHaveBeenCalledWith('club_code_activated', {
      surface: 'zoom',
      source: 'footer',
      club_id: 'club-1',
      is_guest: false,
      via: 'typed',
    });
    expect(props.onUpgraded).toHaveBeenCalled();
  });

  // One uniform failure on the server means one line of copy here, and the
  // modal stays open so the code can be corrected in place.
  it('shows one line and keeps the field when the code is refused', async () => {
    const user = userEvent.setup();
    global.fetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'invalid_code' }) });
    renderModal();
    await screen.findByLabelText(/already on pro through your club/i);

    await user.type(screen.getByLabelText(/already on pro through your club/i), 'ZZZZ-999999');
    await user.click(screen.getByRole('button', { name: /activate/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That code isn't active. Check with your club officer."
    );
    expect(screen.getByRole('button', { name: /monthly/i })).toBeInTheDocument();
    expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeNull();
    expect(trackEvent).toHaveBeenCalledWith('club_code_rejected', {
      surface: 'zoom',
      source: 'footer',
      reason: 'invalid_code',
    });
  });

  // The case the feature is sold on: no Zoom identity, no sign-in, just a code.
  it('offers the field to a guest who cannot buy', async () => {
    resolveZoomIdentity.mockResolvedValue({ identified: false, isGuest: true });
    renderModal();

    expect(await screen.findByText(/sign in to Zoom and add Toastmasters Timer/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/already on pro through your club/i)).toBeInTheDocument();
  });

  it('refuses to send an empty code', async () => {
    renderModal();
    await screen.findByLabelText(/already on pro through your club/i);

    expect(screen.getByRole('button', { name: /activate/i })).toBeDisabled();
  });
});

describe('an already-activated device', () => {
  beforeEach(() => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify({ clubToken: 'tok.sig', lastRefreshAt: Date.now(), ...clubState() }));
    initClubFromCache();
  });

  it('opens on the club, not the pricing', async () => {
    renderModal();

    expect(await screen.findByText(/Downtown Speakers/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /yearly/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/already on pro through your club/i)).not.toBeInTheDocument();
  });

  it('reports the plan source on open, so buyers and activated timers can be told apart', async () => {
    renderModal();

    await waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith('upgrade_prompt_shown', {
        source: 'footer',
        plan: 'pro',
        plan_source: 'club',
      })
    );
  });

  it('leaves the club on this device and returns to the pricing', async () => {
    const user = userEvent.setup();
    localStorage.setItem('toastmaster_role_rules', '{"Evaluator":{}}');
    renderModal();

    await user.click(await screen.findByRole('button', { name: /leave this club on this device/i }));

    expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeNull();
    expect(getEntitlement()).toMatchObject({ plan: 'free', entitled: false });
    expect(await screen.findByRole('button', { name: /monthly/i })).toBeInTheDocument();
    // The device's own presets were never written over, so leaving cannot take
    // them away.
    expect(localStorage.getItem('toastmaster_role_rules')).toBe('{"Evaluator":{}}');
    expect(trackEvent).toHaveBeenCalledWith('club_left', { surface: 'zoom', source: 'footer', club_id: 'club-1' });
  });
});
