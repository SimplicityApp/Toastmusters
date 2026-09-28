import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../context/ToastContext';
import { TimerProvider } from '../context/TimerContext';
import EditRulesModal from './EditRulesModal';
import { trackEvent } from '../utils/posthog';
import {
  CLUB_STORAGE_KEY,
  CLUB_PRESETS_STORAGE_KEY,
  PRESET_SOURCE_STORAGE_KEY,
  loadRoleRules,
  loadClubPresets,
  resetClubForTests,
  resetEntitlementForTests,
} from '@toastmaster-timer/shared';

/**
 * Editing while the club's list is showing.
 *
 * The contract this file holds: cancelling the confirmation writes absolutely
 * nothing, and confirming copies the club's list into this device's own before
 * the edit lands on it.
 */

// Stubbed rather than imported: the real module pulls in @zoom/appssdk, which
// hangs vitest under jsdom.
vi.mock('../utils/zoomSdk', () => ({
  applyOverlay: vi.fn(),
  removeOverlay: vi.fn(),
  getBackgroundUrl: vi.fn((color) => `/backgrounds/${color}.png`),
  isOverlayActive: vi.fn(() => false),
  getOverlayMode: vi.fn(() => 'card'),
  isVideoOverlayMode: vi.fn(() => false),
  setOverlayTimeLabel: vi.fn(),
  OVERLAY_MODE_CARD: 'card',
}));
vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));
vi.mock('../utils/zoomIdentity', () => ({ getSessionToken: vi.fn(() => 'session-token') }));

const CLUB_RULES = {
  'Standard Speech': { green: 300, yellow: 360, red: 420, graceAfterRed: 30 },
  'Contest Speech': { green: 111, yellow: 222, red: 333, graceAfterRed: 30 },
};

const clubState = (over = {}) => ({
  ver: 1,
  club: { id: 'club-1', name: 'Downtown Speakers' },
  kit: null,
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

function joinClub({ role = null, presets = { rules: CLUB_RULES, order: ['Contest Speech'], hiddenBuiltins: ['Ice Breaker'], publishedBy: 'buyer-uid', publishedAt: 1_700_000_000_000 } } = {}) {
  localStorage.setItem(
    CLUB_STORAGE_KEY,
    JSON.stringify({ clubToken: 'tok.sig', lastRefreshAt: Date.now(), ...clubState({ role }) })
  );
  if (presets) localStorage.setItem(CLUB_PRESETS_STORAGE_KEY, JSON.stringify(presets));
  resetClubForTests();
}

function renderModal() {
  const onClose = vi.fn();
  render(
    <ToastProvider>
      <TimerProvider>
        <EditRulesModal isOpen onClose={onClose} />
      </TimerProvider>
    </ToastProvider>
  );
  return { onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetClubForTests();
  resetEntitlementForTests();
  global.fetch = vi.fn();
});

// ---------------------------------------------------------------------------

describe('a device running the club\'s list', () => {
  it('names the club and shows its rules, not the built-in defaults', () => {
    joinClub();
    renderModal();

    expect(screen.getByText(/Downtown Speakers presets/)).toBeInTheDocument();
    // The admin removed Ice Breaker, so it is not on offer at all.
    expect(screen.queryByRole('heading', { name: 'Ice Breaker' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Contest Speech' })).toBeInTheDocument();
  });

  // Nothing at all is written, and the modal stays open with the edit on
  // screen so it can be finished or abandoned.
  it('writes nothing when the fork confirmation is cancelled', async () => {
    const user = userEvent.setup();
    joinClub();
    renderModal();

    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText(/Make your own copy\?/)).toBeInTheDocument();

    // The confirmation renders after the editor, so its Cancel is the last one.
    const cancels = screen.getAllByRole('button', { name: 'Cancel' });
    await user.click(cancels[cancels.length - 1]);

    await waitFor(() => expect(screen.queryByText(/Make your own copy\?/)).not.toBeInTheDocument());
    expect(loadRoleRules()).toBeNull();
    expect(localStorage.getItem(PRESET_SOURCE_STORAGE_KEY)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Edit Timing Rules' })).toBeInTheDocument();
  });

  it('forks the club\'s list on confirm, then applies the edit to the copy', async () => {
    const user = userEvent.setup();
    joinClub();
    const { onClose } = renderModal();

    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await user.click(await screen.findByRole('button', { name: 'Make my copy' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // The copy carries the club's values, so the starting point is the club's
    // list rather than the factory defaults.
    expect(loadRoleRules()['Contest Speech']).toEqual(CLUB_RULES['Contest Speech']);
    expect(localStorage.getItem(PRESET_SOURCE_STORAGE_KEY)).toBe('personal');
    // The club's published list is untouched and one tap away.
    expect(loadClubPresets().rules).toEqual(CLUB_RULES);
    expect(trackEvent).toHaveBeenCalledWith('club_presets_forked', { surface: 'zoom', club_id: 'club-1' });
  });

  it('moves between the two lists without losing either', async () => {
    const user = userEvent.setup();
    localStorage.setItem('toastmaster_role_rules', JSON.stringify({ 'Standard Speech': { green: 10, yellow: 20, red: 30 } }));
    joinClub();
    renderModal();

    // A device with its own presets opens on them.
    expect(screen.getByText(/^My presets$/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Downtown Speakers' }));
    expect(await screen.findByText(/Downtown Speakers presets/)).toBeInTheDocument();
    expect(localStorage.getItem(PRESET_SOURCE_STORAGE_KEY)).toBe('club');
    // Their own list was never written over.
    expect(loadRoleRules()).toEqual({ 'Standard Speech': { green: 10, yellow: 20, red: 30 } });
  });

  it('clears the personal copy on "Reset to club"', async () => {
    const user = userEvent.setup();
    localStorage.setItem('toastmaster_role_rules', JSON.stringify({ 'Standard Speech': { green: 10, yellow: 20, red: 30 } }));
    joinClub();
    renderModal();

    await user.click(screen.getByRole('button', { name: 'Reset to club' }));

    expect(await screen.findByText(/Downtown Speakers presets/)).toBeInTheDocument();
    expect(loadRoleRules()).toEqual({});
    expect(trackEvent).toHaveBeenCalledWith('club_presets_reset', { surface: 'zoom', club_id: 'club-1' });
  });
});

describe('the publish panel', () => {
  it('is hidden from a timer who only holds the code', () => {
    joinClub({ role: 'member' });
    renderModal();

    expect(screen.queryByRole('button', { name: /share with my club/i })).not.toBeInTheDocument();
  });

  it('shares the list on screen, and takes the answer as the club\'s new list', async () => {
    const user = userEvent.setup();
    joinClub({ role: 'admin' });
    const published = { rules: CLUB_RULES, order: ['Contest Speech'], hiddenBuiltins: ['Ice Breaker'], publishedBy: 'me', publishedAt: 1 };
    global.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ver: 2, presets: published }) });

    renderModal();
    await user.click(screen.getByRole('button', { name: /share with my club/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const [path, init] = global.fetch.mock.calls[0];
    expect(path).toBe('/api/club/presets');
    expect(init.headers['X-Club']).toBe('tok.sig');

    const sent = JSON.parse(init.body);
    expect(sent.rules['Contest Speech']).toEqual(CLUB_RULES['Contest Speech']);
    // A built-in missing from the list is one the officer removed, and every
    // device in the club has to stop offering it.
    expect(sent.hiddenBuiltins).toContain('Ice Breaker');

    await waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith(
        'club_presets_published',
        expect.objectContaining({ surface: 'zoom', club_id: 'club-1', role: 'admin' })
      )
    );
  });

  it('says who may publish when the server refuses', async () => {
    const user = userEvent.setup();
    joinClub({ role: 'admin' });
    global.fetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) });

    renderModal();
    await user.click(screen.getByRole('button', { name: /share with my club/i }));

    expect(await screen.findByText(/Only a club admin or editor can share presets\./)).toBeInTheDocument();
  });
});

describe('a device with no club', () => {
  it('shows neither the banner nor the publish panel, and saves without asking', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();

    expect(screen.queryByText(/presets$/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /share with my club/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByText(/Make your own copy\?/)).not.toBeInTheDocument();
  });
});
