import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { resetClubForTests, resetEntitlementForTests, resetFlagsForTests, setFlags } from '@toastmaster-timer/shared';
import { resetWebIdentityForTests, signInUrl } from '../utils/webIdentity';
import { trackEvent } from '../utils/posthog';
import ProActivate from './ProActivate';

/**
 * /pro/<code> (#167). Club Pro belongs to a Zoom account now, so the link joins
 * the signed-in account and, for a signed-out browser, sends nothing and asks
 * for a Zoom sign-in that comes back here.
 */

const CODE = 'DTSP-7K2QM9';

/** The club state the Worker answers a join with: no clubToken, plus the place count. */
const STATE = {
  ver: 1,
  club: { id: 'club-1', name: 'Downtown Speakers' },
  kit: null,
  presets: null,
  badge: { x: 0.8, y: 0.12, scale: 0.12 },
  cards: null,
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
  placesUsed: 2,
};

/** A straight or a curly apostrophe: the copy may use either. */
const copy = (text) =>
  new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['\u2019]"));

/**
 * A fetch stub keyed by path. `me` answers /api/me (signed in or out);
 * `activate` answers POST /api/club/activate.
 */
function stubApi({ me, activate }) {
  const calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init = {}) => {
      const path = String(url).split('?')[0];
      calls.push({ path, method: init.method || 'GET', body: init.body, headers: init.headers ?? {} });
      const answer =
        path === '/api/me' ? me : path === '/api/club/activate' ? activate : { status: 404, body: {} };
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        json: async () => answer.body ?? {},
      };
    })
  );
  return calls;
}

const SIGNED_OUT = { status: 401, body: { error: 'Unauthorized' } };
const SIGNED_IN = { status: 200, body: { uid: 'timer-uid', entitlement: { plan: 'free', entitled: false } } };

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={[`/pro/${CODE}`]}>
      <Routes>
        <Route path="/pro/:code" element={<ProActivate />} />
      </Routes>
    </MemoryRouter>
  );

const activateCalls = (calls) => calls.filter((call) => call.path === '/api/club/activate');

beforeEach(() => {
  localStorage.clear();
  resetClubForTests();
  resetWebIdentityForTests();
  resetEntitlementForTests();
  resetFlagsForTests();
  setFlags({ pro: true });
  trackEvent.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProActivate: a signed-out browser (AC-1d)', () => {
  it('sends nothing and links to Zoom sign-in that comes back to this page', async () => {
    const calls = stubApi({ me: SIGNED_OUT, activate: { status: 200, body: STATE } });
    renderPage();

    const link = await screen.findByRole('link', { name: /sign in with zoom to join/i });
    expect(link).toHaveAttribute('href', signInUrl(`/pro/${CODE}`));
    // The return trip is the whole point: /pro/<CODE> joins once signed in.
    expect(decodeURIComponent(link.getAttribute('href'))).toBe(`/api/auth/zoom/start?returnTo=/pro/${CODE}`);

    // Give a stray activation every chance to go out.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(activateCalls(calls)).toEqual([]);
  });

  it('never claims Pro for "this browser" or says no sign-in is needed (AC-7)', async () => {
    stubApi({ me: SIGNED_OUT, activate: { status: 200, body: STATE } });
    renderPage();

    await screen.findByRole('link', { name: /sign in with zoom to join/i });
    expect(document.body.textContent).not.toMatch(/on Pro in this browser/i);
    expect(document.body.textContent).not.toMatch(/This device is on Pro/i);
    expect(document.body.textContent).not.toMatch(/No sign-in needed/i);
  });
});

describe('ProActivate: a signed-in browser', () => {
  it('joins the account and says so in the account wording (AC-1d, AC-7)', async () => {
    const calls = stubApi({ me: SIGNED_IN, activate: { status: 200, body: STATE } });
    renderPage();

    expect(await screen.findByText(copy("You're on Pro through Downtown Speakers"))).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/on Pro in this browser/i);
    expect(document.body.textContent).not.toMatch(/This device is on Pro/i);

    const [activate] = activateCalls(calls);
    expect(activate.method).toBe('POST');
    const body = JSON.parse(activate.body);
    expect(body.code).toBeTruthy();
    // Nothing per device any more.
    expect(body.deviceId).toBeUndefined();
    const headerNames = Object.keys(activate.headers).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain('x-club');
  });

  it('reports places_used and no is_guest on club_code_activated (AC-10)', async () => {
    stubApi({ me: SIGNED_IN, activate: { status: 200, body: STATE } });
    renderPage();

    await waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith('club_code_activated', expect.objectContaining({ places_used: 2 }))
    );
    const [, props] = trackEvent.mock.calls.find(([event]) => event === 'club_code_activated');
    expect(props).not.toHaveProperty('is_guest');
  });

  it('shows the full message when every place is taken (AC-3)', async () => {
    stubApi({ me: SIGNED_IN, activate: { status: 409, body: { error: 'full', placesUsed: 3, placesTotal: 3 } } });
    renderPage();

    expect(
      await screen.findByText(
        copy("This club's Pro is full (3 of 3). Ask the person who shared the code to free a place.")
      )
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith('club_code_rejected', expect.objectContaining({ reason: 'full' }))
    );
  });

  it('names the club an account is already in (AC-5)', async () => {
    stubApi({
      me: SIGNED_IN,
      activate: { status: 409, body: { error: 'already_in_club', clubName: 'Riverside Toastmasters' } },
    });
    renderPage();

    expect(
      await screen.findByText(copy("You're already in Riverside Toastmasters. Leave it to join another club."))
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith(
        'club_code_rejected',
        expect.objectContaining({ reason: 'already_in_club' })
      )
    );
  });
});
