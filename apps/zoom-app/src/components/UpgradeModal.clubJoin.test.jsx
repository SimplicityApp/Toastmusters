import '@testing-library/jest-dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UpgradeModal from './UpgradeModal';
import { trackEvent } from '../utils/posthog';
import * as zoomSdk from '../utils/zoomSdk';
import * as zoomIdentity from '../utils/zoomIdentity';
import {
  CLUB_STORAGE_KEY,
  resetClubForTests,
  resetEntitlementForTests,
  resetFlagsForTests,
  setEntitlement,
  setFlags,
  getEntitlement,
} from '@toastmaster-timer/shared';

/**
 * #167: joining a club with a code needs a Zoom account that approved the app,
 * and club Pro then belongs to that account.
 *
 * The Pro panel decides by Zoom's auth status before anything is sent:
 *   unauthenticated → "Sign in to Zoom…", nothing sent
 *   authenticated (guest mode) → "Approve…" + Approve, the code kept and sent
 *     once the identity resolves again as authorized
 *   authorized → send
 */

/**
 * The SDK and identity modules are stubbed (the real SDK hangs jsdom). Any
 * export these stubs don't name answers with a no-op mock rather than throwing,
 * so the implementation is free to use whichever SDK helper fits.
 */
function lenientMock(known) {
  return new Proxy(known, {
    get(target, prop) {
      if (prop in target || typeof prop !== 'string' || prop === 'then' || prop === '__esModule') return target[prop];
      target[prop] = vi.fn();
      return target[prop];
    },
    has(target, prop) {
      return prop !== 'then' || prop in target;
    },
  });
}

vi.mock('../utils/zoomSdk', () =>
  lenientMock({
    openExternalUrl: vi.fn(async () => true),
    promptZoomAuthorize: vi.fn(async () => true),
    setUserStatusChangeCallback: vi.fn(),
  })
);
vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));
vi.mock('../utils/zoomIdentity', () =>
  lenientMock({
    resolveZoomIdentity: vi.fn(),
    refreshZoomIdentity: vi.fn(),
    getSessionToken: vi.fn(() => 'session-token'),
  })
);

const PENDING_KEY = 'toastmaster_pending_club_code';
const SIGN_IN_COPY = 'Sign in to Zoom, then open the timer again to join your club';
const APPROVE_COPY = 'Approve Toastmusters Timer in Zoom to join your club';
const FULL_COPY = "This club's Pro is full (3 of 3). Ask the person who shared the code to free a place.";
const leaveCopy = (club) => `Leave ${club}? You'll lose its Pro on every computer where you're signed in.`;


/** A copy line as a regex that takes a straight or a typographic apostrophe. */
const copy = (text) =>
  new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]"));

/**
 * Text matcher that survives the line being split across elements (a bold
 * club name, say): the innermost element whose whole text contains it.
 */
const phrase = (text) => {
  const re = typeof text === 'string' ? copy(text) : text;
  return (_content, element) => {
    if (!element || !re.test(element.textContent ?? '')) return false;
    return ![...element.children].some((child) => re.test(child.textContent ?? ''));
  };
};

const AUTHORIZED = { identified: true, isGuest: false, uid: 'u1', authStatus: 'authorized', entitlement: null };
const GUEST = { identified: false, isGuest: true, uid: null, authStatus: 'authenticated', entitlement: null };
const SIGNED_OUT = { identified: false, isGuest: false, uid: null, authStatus: 'unauthenticated', entitlement: null };

const clubState = (over = {}) => ({
  ver: 1,
  club: { id: 'club-1', name: 'Downtown Speakers' },
  kit: null,
  presets: null,
  cards: null,
  badge: null,
  timezone: null,
  role: 'member',
  isOwner: false,
  code: null,
  shareUrl: null,
  plan: 'pro',
  entitled: true,
  status: 'active',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  source: 'club',
  ...over,
});

/** A member's club, as #167 caches it: tied to the account, no club token. */
function joinedAs(over = {}) {
  localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify({ uid: 'u1', lastRefreshAt: Date.now(), ...clubState(over) }));
  resetClubForTests();
  // What syncClubWithIdentity applies once the identity has resolved.
  setEntitlement({ plan: 'pro', entitled: true, status: 'active', source: 'club' });
}

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function renderModal(props = {}) {
  const merged = { isOpen: true, onClose: vi.fn(), source: 'footer', onUpgraded: vi.fn(), ...props };
  render(<UpgradeModal {...merged} />);
  return merged;
}

const codeField = () => screen.findByLabelText(/already on pro through your club/i);

/** Type a code and submit it the way a person would: Enter in the field. */
async function enterCode(user, code = 'dtsp-7k2qm9') {
  const field = await codeField();
  await user.type(field, `${code}{enter}`);
}

const activateCalls = () => global.fetch.mock.calls.filter(([url]) => String(url).includes('/api/club/activate'));
const leaveCalls = () => global.fetch.mock.calls.filter(([url]) => String(url).includes('/api/club/leave'));
const headersOf = (init) => Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  resetClubForTests();
  resetEntitlementForTests();
  resetFlagsForTests();
  setFlags({ pro: true });
  zoomIdentity.resolveZoomIdentity.mockResolvedValue(AUTHORIZED);
  zoomIdentity.refreshZoomIdentity.mockResolvedValue(AUTHORIZED);
  zoomIdentity.getSessionToken.mockReturnValue('session-token');
  zoomSdk.promptZoomAuthorize.mockResolvedValue(true);
  global.fetch = vi.fn(async () => json({}, 500));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('signed out of Zoom (AC-1b)', () => {
  beforeEach(() => {
    zoomIdentity.resolveZoomIdentity.mockResolvedValue(SIGNED_OUT);
    zoomIdentity.getSessionToken.mockReturnValue(null);
  });

  it('sends nothing and says to sign in to Zoom', async () => {
    const user = userEvent.setup();
    renderModal();

    const field = screen.queryByLabelText(/already on pro through your club/i) ?? (await codeField().catch(() => null));
    if (field) await user.type(field, 'dtsp-7k2qm9{enter}');

    expect(await screen.findByText(phrase(SIGN_IN_COPY))).toBeInTheDocument();
    expect(activateCalls()).toEqual([]);
    expect(getEntitlement()).toMatchObject({ entitled: false });
  });

  it('reports the refusal as sign_in_required', async () => {
    const user = userEvent.setup();
    renderModal();
    await enterCode(user);

    await waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith(
        'club_code_rejected',
        expect.objectContaining({ surface: 'zoom', reason: 'sign_in_required' })
      )
    );
    expect(activateCalls()).toEqual([]);
  });
});

describe('guest mode (AC-1c)', () => {
  beforeEach(() => {
    zoomIdentity.resolveZoomIdentity.mockResolvedValue(GUEST);
    zoomIdentity.getSessionToken.mockReturnValue(null);
  });

  it('asks to approve the app, keeps the code, and sends nothing yet', async () => {
    const user = userEvent.setup();
    renderModal();
    await enterCode(user);

    expect(await screen.findByText(phrase(APPROVE_COPY))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^approve/i })).toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_KEY)).toMatch(/dtsp-?7k2qm9/i);
    expect(activateCalls()).toEqual([]);
    await waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith(
        'club_code_rejected',
        expect.objectContaining({ surface: 'zoom', reason: 'approve_required' })
      )
    );
  });

  it('sends the typed code after the approval, without retyping, then forgets it', async () => {
    const user = userEvent.setup();
    renderModal();
    await enterCode(user);

    // Approving in Zoom: the identity resolves again as authorized.
    zoomIdentity.refreshZoomIdentity.mockResolvedValue(AUTHORIZED);
    zoomIdentity.resolveZoomIdentity.mockResolvedValue(AUTHORIZED);
    zoomIdentity.getSessionToken.mockReturnValue('session-token');
    global.fetch.mockImplementation(async (url) =>
      String(url).includes('/api/club/activate') ? json({ ...clubState(), placesUsed: 2 }) : json({}, 500)
    );

    await user.click(await screen.findByRole('button', { name: /^approve/i }));
    expect(zoomSdk.promptZoomAuthorize).toHaveBeenCalled();
    // However the panel learns of the approval (the promise, or Zoom's status
    // callback), let it hear it.
    for (const [callback] of zoomSdk.setUserStatusChangeCallback.mock.calls) {
      if (typeof callback === 'function') callback({ status: 'authorized' });
    }

    await waitFor(() => expect(activateCalls()).toHaveLength(1), { timeout: 3000 });
    const [, init] = activateCalls()[0];
    expect(JSON.parse(init.body).code).toMatch(/dtsp-?7k2qm9/i);
    expect(headersOf(init).authorization).toBe('Bearer session-token');
    await waitFor(() => expect(sessionStorage.getItem(PENDING_KEY)).toBeNull());
    expect(await screen.findByText(phrase("You're on Pro through"))).toBeInTheDocument();
  });
});

describe('signed in and approved (AC-1a, AC-3, AC-5, AC-11)', () => {
  it('joins with the session and shows "You\'re on Pro through <club>"', async () => {
    const user = userEvent.setup();
    global.fetch.mockImplementation(async () => json({ ...clubState(), placesUsed: 2 }));
    const props = renderModal();

    await enterCode(user);

    expect(await screen.findByText(phrase("You're on Pro through"))).toBeInTheDocument();
    expect(screen.getByText(phrase(/You['\u2019]re on Pro through\s*Downtown Speakers/))).toBeInTheDocument();
    const [path, init] = activateCalls()[0];
    expect(path).toBe('/api/club/activate');
    expect(headersOf(init).authorization).toBe('Bearer session-token');
    expect(headersOf(init)['x-club']).toBeUndefined();
    expect(JSON.parse(init.body)).not.toHaveProperty('deviceId');
    expect(props.onUpgraded).toHaveBeenCalled();
  });

  it('reports places_used on club_code_activated, and no is_guest', async () => {
    const user = userEvent.setup();
    global.fetch.mockImplementation(async () => json({ ...clubState(), placesUsed: 2 }));
    renderModal();

    await enterCode(user);
    await screen.findByText(phrase("You're on Pro through"));

    const call = trackEvent.mock.calls.find(([name]) => name === 'club_code_activated');
    expect(call?.[1]).toMatchObject({ surface: 'zoom', club_id: 'club-1', places_used: 2 });
    expect(call?.[1]).not.toHaveProperty('is_guest');
  });

  it('says the club is full, with the 3 places', async () => {
    const user = userEvent.setup();
    global.fetch.mockImplementation(async () => json({ error: 'full', placesUsed: 3, placesTotal: 3 }, 409));
    renderModal();

    await enterCode(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(copy(FULL_COPY));
    expect(trackEvent).toHaveBeenCalledWith('club_code_rejected', expect.objectContaining({ reason: 'full' }));
  });

  it('says the account is already in another club, by name', async () => {
    const user = userEvent.setup();
    global.fetch.mockImplementation(async () => json({ error: 'already_in_club', clubName: 'Uptown Orators' }, 409));
    renderModal();

    await enterCode(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      copy("You're already in Uptown Orators. Leave it to join another club.")
    );
    expect(trackEvent).toHaveBeenCalledWith('club_code_rejected', expect.objectContaining({ reason: 'already_in_club' }));
  });

  it('shows a blocked account the same line as a wrong code', async () => {
    const user = userEvent.setup();
    global.fetch.mockImplementation(async () => json({ error: 'invalid_code' }, 400));
    renderModal();

    await enterCode(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(copy("That code isn't active"));
  });

  it('no longer says "No sign-in needed"', async () => {
    renderModal();
    await codeField();
    expect(screen.queryByText(/no sign-in needed/i)).not.toBeInTheDocument();
  });
});

describe('a member\'s Pro panel (AC-4, AC-7, AC-12, AC-3)', () => {
  /**
   * The confirm may be the browser's or the app's own dialog. Answers whichever
   * one appeared and reports whether the question was asked.
   */
  async function answerLeave(user, confirmSpy, accept) {
    const asked = confirmSpy.mock.calls.some(([message]) => copy(leaveCopy('Downtown Speakers')).test(String(message)));
    if (asked) return true;
    const text = await screen.findByText(phrase(leaveCopy('Downtown Speakers'))).catch(() => null);
    if (!text) return false;
    const dialog = text.closest('[role="dialog"],[role="alertdialog"]') ?? document.body;
    const buttons = within(dialog).getAllByRole('button');
    const target = accept
      ? buttons.find((b) => /^leave/i.test(b.textContent.trim()) && b !== text)
      : buttons.find((b) => /cancel|keep|stay|no/i.test(b.textContent));
    await user.click(target);
    return true;
  }

  it('reads "You\'re on Pro through <club>", never "This device is on Pro"', async () => {
    joinedAs();
    renderModal();

    expect(await screen.findByText(phrase("You're on Pro through"))).toBeInTheDocument();
    expect(screen.queryByText(/this device is on/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/on this device/i)).not.toBeInTheDocument();
  });

  it('asks before leaving, and Cancel leaves nothing', async () => {
    const user = userEvent.setup();
    joinedAs();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderModal();

    await user.click(await screen.findByRole('button', { name: /^leave/i }));

    expect(await answerLeave(user, confirmSpy, false)).toBe(true);
    expect(leaveCalls()).toEqual([]);
    expect(localStorage.getItem(CLUB_STORAGE_KEY)).not.toBeNull();
  });

  it('leaves after the confirm: POSTs with the session and returns to the pricing', async () => {
    const user = userEvent.setup();
    joinedAs();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    global.fetch.mockImplementation(async () => json({ left: true }));
    renderModal();

    await user.click(await screen.findByRole('button', { name: /^leave/i }));
    expect(await answerLeave(user, confirmSpy, true)).toBe(true);

    await waitFor(() => expect(leaveCalls()).toHaveLength(1));
    const [, init] = leaveCalls()[0];
    expect((init.method ?? 'GET').toUpperCase()).toBe('POST');
    expect(headersOf(init).authorization).toBe('Bearer session-token');
    expect(headersOf(init)['x-club']).toBeUndefined();
    await waitFor(() => expect(localStorage.getItem(CLUB_STORAGE_KEY)).toBeNull());
    expect(await screen.findByRole('button', { name: /monthly/i })).toBeInTheDocument();
    expect(trackEvent).toHaveBeenCalledWith('club_left', expect.objectContaining({ surface: 'zoom', club_id: 'club-1' }));
  });

  it('keeps the club and says why when the last admin tries to leave', async () => {
    const user = userEvent.setup();
    joinedAs({ role: 'admin', code: 'DTSP-7K2QM9', placesUsed: 1, placesTotal: 3 });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    global.fetch.mockImplementation(async () => json({ error: 'last_admin' }, 409));
    renderModal();

    await user.click(await screen.findByRole('button', { name: /^leave/i }));
    await answerLeave(user, confirmSpy, true);

    await waitFor(() => expect(leaveCalls()).toHaveLength(1));
    expect(localStorage.getItem(CLUB_STORAGE_KEY)).not.toBeNull();
    expect(screen.getByText(phrase("You're on Pro through"))).toBeInTheDocument();
  });

  it('shows the owner no Leave at all', async () => {
    joinedAs({ role: 'admin', isOwner: true, code: 'DTSP-7K2QM9', placesUsed: 1, placesTotal: 3 });
    renderModal();

    expect(await screen.findByText(phrase("You're on Pro through"))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /leave/i })).not.toBeInTheDocument();
  });

  it('shows an admin "N of 3 places used" beside the code', async () => {
    joinedAs({ role: 'admin', isOwner: true, code: 'DTSP-7K2QM9', shareUrl: 'https://www.example.test/pro/DTSP-7K2QM9', placesUsed: 2, placesTotal: 3 });
    renderModal();

    expect(await screen.findByText(phrase('2 of 3 places used'))).toBeInTheDocument();
    expect(screen.getByText(/DTSP-7K2QM9/)).toBeInTheDocument();
  });

  it.each(['member', 'editor'])('shows a %s no place count', async (role) => {
    joinedAs({ role });
    renderModal();

    expect(await screen.findByText(phrase("You're on Pro through"))).toBeInTheDocument();
    expect(screen.queryByText(/places used/i)).not.toBeInTheDocument();
  });
});
