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
  resetFlagsForTests,
  setFlags,
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
  resetFlagsForTests();
  // Released unless a test says otherwise; the dark position has its own block
  // at the end.
  setFlags({ clubs: true });
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

describe('the club-framed pitch', () => {
  it('sells the club, and sends the optional name with the purchase', async () => {
    const user = userEvent.setup();
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ url: 'https://checkout.stripe.com/c/cs_1' }) });
    renderModal();

    expect(await screen.findByText(/One Pro account for your whole club/i)).toBeInTheDocument();
    expect(screen.getByText(/brand kit on every timer card/i)).toBeInTheDocument();
    expect(screen.getByText(/Shared timing presets/i)).toBeInTheDocument();
    expect(screen.getByText(/saved to your club's archive/i)).toBeInTheDocument();
    expect(screen.getByText(/timer itself stays free/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/your club's name/i), 'Downtown Speakers');
    await user.click(screen.getByRole('button', { name: /monthly/i }));

    const [path, init] = global.fetch.mock.calls.find(([p]) => p === '/api/billing/checkout');
    expect(path).toBe('/api/billing/checkout');
    expect(JSON.parse(init.body)).toEqual({ interval: 'monthly', clubName: 'Downtown Speakers' });
  });

  // A buyer stopped at a required field is a sale lost; the club is minted with
  // a placeholder instead.
  it('checks out with the field left empty and sends no key at all', async () => {
    const user = userEvent.setup();
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ url: 'https://checkout.stripe.com/c/cs_1' }) });
    renderModal();

    await user.click(await screen.findByRole('button', { name: /yearly/i }));

    const [, init] = global.fetch.mock.calls.find(([p]) => p === '/api/billing/checkout');
    expect(JSON.parse(init.body)).toEqual({ interval: 'yearly' });
  });
});

describe('a club whose Pro has ended', () => {
  beforeEach(() => {
    localStorage.setItem(
      CLUB_STORAGE_KEY,
      JSON.stringify({
        clubToken: 'tok.sig',
        lastRefreshAt: Date.now(),
        ...clubState({ plan: 'free', entitled: false, status: 'canceled', source: 'none' }),
      })
    );
    initClubFromCache();
  });

  // Nothing is hard-deleted, and the device still knows which club to check, so
  // the modal names it rather than pretending the last six months did not happen.
  it('names the club, keeps the code field, and offers the pricing again', async () => {
    renderModal();

    expect(await screen.findByText(/Downtown Speakers's Pro has ended/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /monthly/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/already on pro through your club/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith('club_lapsed_shown', {
        surface: 'zoom',
        source: 'footer',
        club_id: 'club-1',
      })
    );
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

/**
 * Setting up the club from inside Zoom.
 *
 * Zoom is the main distribution channel, so an officer who never visits the web
 * site has to be able to do this. Before it, a buyer here had no way to learn
 * their own club code: the code was rendered on one browser-only page.
 */
describe('setting up a club', () => {
  const createdResponse = (over = {}) => ({
    clubToken: 'tok.sig',
    created: true,
    code: 'DTSP-7K2QM9',
    shareUrl: 'https://www.example.test/pro/DTSP-7K2QM9',
    ...clubState({ role: 'admin', source: 'subscription' }),
    ...over,
  });

  it('offers the card to a subscriber who has no club', async () => {
    const { setEntitlement } = await import('@toastmaster-timer/shared');
    setEntitlement({ plan: 'pro', entitled: true, status: 'active', source: 'subscription' });
    renderModal();

    expect(await screen.findByRole('button', { name: /set up my club/i })).toBeInTheDocument();
  });

  it('stays hidden from a device that is Pro through somebody else’s club', async () => {
    localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify({ clubToken: 'tok.sig', lastRefreshAt: Date.now(), ...clubState({ role: 'member' }) }));
    initClubFromCache();
    renderModal();

    await screen.findByText(/Downtown Speakers/);
    expect(screen.queryByRole('button', { name: /set up my club/i })).not.toBeInTheDocument();
  });

  it('creates the club and shows the code and the invite link', async () => {
    const user = userEvent.setup();
    const { setEntitlement } = await import('@toastmaster-timer/shared');
    setEntitlement({ plan: 'pro', entitled: true, status: 'active', source: 'subscription' });
    global.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => createdResponse() });
    renderModal();

    await user.type(await screen.findByLabelText(/your club's name/i), 'Downtown Speakers');
    await user.click(screen.getByRole('button', { name: /set up my club/i }));

    expect(await screen.findByDisplayValue('DTSP-7K2QM9')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://www.example.test/pro/DTSP-7K2QM9')).toBeInTheDocument();

    const [path, init] = global.fetch.mock.calls.find(([p]) => p === '/api/club/create');
    expect(path).toBe('/api/club/create');
    expect(JSON.parse(init.body)).toMatchObject({ clubName: 'Downtown Speakers' });
    expect(trackEvent).toHaveBeenCalledWith('club_created', {
      surface: 'zoom',
      source: 'self_serve',
      club_id: 'club-1',
      created: true,
    });
  });

  it('names a refusal the officer can act on', async () => {
    const user = userEvent.setup();
    const { setEntitlement } = await import('@toastmaster-timer/shared');
    setEntitlement({ plan: 'pro', entitled: true, status: 'active', source: 'subscription' });
    global.fetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'no_billing_account' }) });
    renderModal();

    await user.click(await screen.findByRole('button', { name: /set up my club/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot find your payment yet/i);
    expect(trackEvent).toHaveBeenCalledWith('club_create_failed', {
      surface: 'zoom',
      source: 'footer',
      reason: 'no_billing_account',
    });
  });

  // The console is a web page, and inside Zoom this app is served from
  // zoom.<domain> — a host that routes every path back to this app.
  it('opens the console on the web host, never the Zoom one', async () => {
    const user = userEvent.setup();
    const { openExternalUrl } = await import('../utils/zoomSdk');
    localStorage.setItem(
      CLUB_STORAGE_KEY,
      JSON.stringify({
        clubToken: 'tok.sig',
        lastRefreshAt: Date.now(),
        ...clubState({ role: 'admin', code: 'DTSP-7K2QM9', shareUrl: 'https://www.example.test/pro/DTSP-7K2QM9' }),
      })
    );
    initClubFromCache();
    renderModal();

    await user.click(await screen.findByRole('button', { name: /manage your club/i }));
    expect(openExternalUrl).toHaveBeenCalledWith('https://www.example.test/club/admin');
  });
});

/**
 * The `clubs` release flag. Only the doors go dark — the code field and the
 * setup card — because the server refuses activate and create while it is off.
 * The pitch, the purchase, and a device already in a club are all unchanged.
 */
describe('while clubs is not released', () => {
  const codeField = () => screen.queryByLabelText(/already on pro through your club/i);
  const setupButton = () => screen.queryByRole('button', { name: /set up my club/i });

  it('offers no code field while the flags are still unknown', async () => {
    resetFlagsForTests();
    renderModal();

    expect(await screen.findByRole('button', { name: /monthly/i })).toBeInTheDocument();
    expect(codeField()).toBeNull();
  });

  it('keeps the pitch and the prices, and offers no code field', async () => {
    setFlags({ clubs: false });
    renderModal();

    expect(await screen.findByText(/One Pro account for your whole club/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /monthly/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/your club's name/i)).toBeInTheDocument();
    expect(codeField()).toBeNull();
  });

  it('tells a guest how to subscribe, with no code field', async () => {
    setFlags({ clubs: false });
    resolveZoomIdentity.mockResolvedValue({ identified: false, isGuest: true });
    renderModal();

    expect(await screen.findByText(/sign in to Zoom and add Toastmasters Timer/i)).toBeInTheDocument();
    expect(codeField()).toBeNull();
  });

  it('offers a subscriber no club setup', async () => {
    setFlags({ clubs: false });
    const { setEntitlement } = await import('@toastmaster-timer/shared');
    setEntitlement({ plan: 'pro', entitled: true, status: 'active', source: 'subscription' });
    renderModal();

    expect(await screen.findByRole('button', { name: /manage billing/i })).toBeInTheDocument();
    expect(setupButton()).toBeNull();
  });

  // A device that joined while clubs was on keeps its club, and leaving must
  // always work.
  it('still shows a device its club, and still lets it leave', async () => {
    setFlags({ clubs: false });
    localStorage.setItem(
      CLUB_STORAGE_KEY,
      JSON.stringify({
        clubToken: 'tok.sig',
        lastRefreshAt: Date.now(),
        ...clubState({ role: 'admin', code: 'DTSP-7K2QM9', shareUrl: 'https://www.example.test/pro/DTSP-7K2QM9' }),
      })
    );
    initClubFromCache();
    renderModal();

    expect(await screen.findByText(/Downtown Speakers/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /leave this club on this device/i })).toBeInTheDocument();
    // The code is a door for somebody else, and that door is shut.
    expect(screen.queryByDisplayValue('DTSP-7K2QM9')).toBeNull();
  });
});
