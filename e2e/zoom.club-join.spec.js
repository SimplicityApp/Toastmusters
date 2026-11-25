import { test, expect } from '@playwright/test';

// Joining a club by Zoom account (#167). Plain browser, but with a stand-in for
// the Zoom Apps SDK: the code form depends on the user's Zoom sign-in status
// (unauthenticated | authenticated (guest mode) | authorized), and only the SDK
// can report it. The real client is e2e/zoom-client/club-membership.md.
//
// Server contract (worker/club.js): every club call carries the session Bearer
// and never `X-Club`; `/api/club` answers only for an account that is a member.

const CODE = 'DTSP-7K2QM9';
const CLUB_REF = { id: 'club-1', name: 'Downtown Speakers' };
const FLAGS = { pro: true, sounds: true, new_look: false };
const UID = 'e2e-member';

const CLUB_ENTITLEMENT = {
  plan: 'pro',
  status: 'active',
  entitled: true,
  currentPeriodEnd: Date.now() + 200 * 24 * 60 * 60 * 1000,
  cancelAtPeriodEnd: false,
  source: 'club',
  club: CLUB_REF,
};
const FREE_ENTITLEMENT = {
  plan: 'free',
  status: null,
  entitled: false,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  source: 'none',
  club: null,
};

/** What GET /api/club and a successful activate answer with. */
function clubState(over = {}) {
  return {
    ver: 1,
    club: CLUB_REF,
    kit: { name: 'Downtown Speakers', logoUrl: null, primaryColor: '#772432', showOnCards: true, showOnReports: true },
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
    currentPeriodEnd: CLUB_ENTITLEMENT.currentPeriodEnd,
    cancelAtPeriodEnd: false,
    source: 'club',
    ...over,
  };
}

/**
 * A module served in place of the pre-bundled @zoom/appssdk. Every method the
 * app asks for exists and resolves; the ones this spec cares about answer from
 * `window.__e2eZoomStatus`, and promptAuthorize is recorded.
 */
const FAKE_SDK = `
const calls = (window.__e2eSdkCalls = window.__e2eSdkCalls || []);
const status = () => window.__e2eZoomStatus || 'authorized';
const impl = {
  config: async () => ({ runningContext: 'inMeeting', unsupportedApis: [], auth: { status: status() } }),
  getUserContext: async () => ({ status: status(), role: 'host', screenName: 'E2E Timer' }),
  getAppContext: async () => (status() === 'unauthenticated' ? {} : { context: 'e2e-app-context' }),
  getRunningContext: async () => ({ context: 'inMeeting' }),
  getMeetingParticipants: async () => ({ participants: [] }),
  promptAuthorize: async () => { calls.push('promptAuthorize'); return {}; },
};
const sdk = new Proxy(impl, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (prop === 'then' || typeof prop !== 'string') return undefined;
    if (prop.startsWith('on') || prop.startsWith('off')) return () => {};
    return async () => ({});
  },
});
export default sdk;
`;

/**
 * Open the panel as a Zoom user with the given sign-in status.
 *
 * @returns {{requests: Array<{url: string, method: string, headers: Object, body: string|null, at: number}>,
 *   sessionAnsweredAt: () => number|null}}
 */
async function openPanel(page, {
  status = 'authorized',
  session = { identified: true, isGuest: false, uid: UID, token: 'e2e-session-token', entitlement: FREE_ENTITLEMENT },
  sessionDelayMs = 0,
  seedClub = null,
  club = () => ({ status: 404, json: { error: 'no_club' } }),
  activate = () => ({ status: 200, json: { ...clubState(), placesUsed: 2 } }),
  leave = () => ({ status: 200, json: { left: true } }),
} = {}) {
  const requests = [];
  let sessionAnsweredAt = null;

  page.on('request', (request) => {
    requests.push({
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      body: request.postData(),
      at: Date.now(),
    });
  });

  await page.addInitScript(({ status: zoomStatus, seed }) => {
    window.__e2eZoomStatus = sessionStorage.getItem('e2e_zoom_status') || zoomStatus;
    if (sessionStorage.getItem('e2e_seeded')) return;
    sessionStorage.setItem('e2e_seeded', '1');
    if (seed) localStorage.setItem('toastmaster_club', JSON.stringify(seed));
  }, { status, seed: seedClub });

  await page.route('**/.vite/deps/@zoom_appssdk.js*', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: FAKE_SDK })
  );
  await page.route('**/api/zoom/session', async (route) => {
    if (sessionDelayMs) await new Promise((resolve) => setTimeout(resolve, sessionDelayMs));
    const answer = typeof session === 'function' ? session() : session;
    sessionAnsweredAt = Date.now();
    await route.fulfill({ json: { flags: FLAGS, contactKnown: true, ...answer } });
  });
  await page.route('**/api/club', (route) => route.fulfill(club(route.request())));
  await page.route('**/api/club/activate', (route) => route.fulfill(activate(route.request())));
  await page.route('**/api/club/leave', (route) => route.fulfill(leave(route.request())));

  await page.goto('/zoom/');
  await expect(page.getByRole('button', { name: /START/i })).toBeVisible();
  return { requests, sessionAnsweredAt: () => sessionAnsweredAt };
}

const isActivate = (r) => r.method === 'POST' && new URL(r.url).pathname === '/api/club/activate';
const isClubState = (r) => r.method === 'GET' && new URL(r.url).pathname === '/api/club';
const isLeave = (r) => r.method === 'POST' && new URL(r.url).pathname === '/api/club/leave';

async function openProPanel(page) {
  await page.getByRole('button', { name: /^(Upgrade to Pro|Manage your Pro plan)$/ }).click();
}

/** Type a code into the modal's field, if the modal offers one, and submit it. */
async function submitCode(page, code = CODE) {
  const field = page.locator('#club-code');
  if (await field.count()) {
    await field.fill(code);
    await field.press('Enter');
  }
}

// ---------------------------------------------------------------------------
// AC-1: joining
// ---------------------------------------------------------------------------

test('AC-1a: a signed-in, approved account joins with the code and sees the club', async ({ page }) => {
  const { requests } = await openPanel(page);
  await openProPanel(page);
  await submitCode(page);

  await expect(page.getByText(/You're on Pro through/)).toBeVisible();
  await expect(page.getByText('Downtown Speakers').first()).toBeVisible();

  const activate = requests.find(isActivate);
  expect(activate, 'the code was sent').toBeTruthy();
  // By account: the session rides along, and nothing names a device.
  expect(activate.headers.authorization).toBe('Bearer e2e-session-token');
  expect(JSON.parse(activate.body)).toEqual({ code: CODE });
  // The cache is tied to the account and carries no device token.
  const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('toastmaster_club') || 'null'));
  expect(cached).toMatchObject({ uid: UID, club: { id: 'club-1' } });
  expect(cached).not.toHaveProperty('clubToken');
});

test('AC-1b: signed out of Zoom, the code is not sent and the free timer still works', async ({ page }) => {
  const { requests } = await openPanel(page, {
    status: 'unauthenticated',
    session: { identified: false, isGuest: true },
  });
  await openProPanel(page);
  await submitCode(page);

  await expect(page.getByText('Sign in to Zoom, then open the timer again to join your club')).toBeVisible();
  expect(requests.filter(isActivate)).toHaveLength(0);

  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: /START/i }).click();
  await expect(page.getByRole('button', { name: /STOP/i })).toBeVisible();
});

test('AC-1c: in guest mode, Approve asks Zoom, and the typed code is sent once approved', async ({ page }) => {
  let approved = false;
  const { requests } = await openPanel(page, {
    status: 'authenticated',
    session: () =>
      approved
        ? { identified: true, isGuest: false, uid: UID, token: 'e2e-session-token', entitlement: FREE_ENTITLEMENT }
        : { identified: false, isGuest: true },
  });
  // Guest mode also raises the app-wide "approve this app" notice; it has its
  // own Approve in Zoom button, which is not the one under test here.
  await page.getByRole('dialog', { name: 'Approve Toastmusters Timer in Zoom' }).getByRole('button', { name: 'Close' }).click();
  await openProPanel(page);
  await submitCode(page);

  await expect(page.getByText('Approve Toastmusters Timer in Zoom to join your club')).toBeVisible();
  expect(requests.filter(isActivate)).toHaveLength(0);

  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__e2eSdkCalls ?? [])).toContain('promptAuthorize');

  // Zoom has approved the app; the next open is authorized. No retyping.
  approved = true;
  await page.evaluate(() => sessionStorage.setItem('e2e_zoom_status', 'authorized'));
  await page.reload();

  await expect.poll(() => requests.filter(isActivate).length).toBeGreaterThan(0);
  expect(JSON.parse(requests.find(isActivate).body)).toEqual({ code: CODE });
  expect(await page.evaluate(() => sessionStorage.getItem('toastmaster_pending_club_code'))).toBeNull();
});

// ---------------------------------------------------------------------------
// AC-3, AC-5: refusals
// ---------------------------------------------------------------------------

test('AC-3: a full club says so, in its own words', async ({ page }) => {
  await openPanel(page, {
    activate: () => ({ status: 409, json: { error: 'full', placesUsed: 3, placesTotal: 3 } }),
  });
  await openProPanel(page);
  await submitCode(page);

  await expect(
    page.getByText("This club's Pro is full (3 of 3). Ask the person who shared the code to free a place.")
  ).toBeVisible();
});

test('AC-5: an account already in another club is told which one', async ({ page }) => {
  await openPanel(page, {
    activate: () => ({ status: 409, json: { error: 'already_in_club', clubName: 'Uptown Orators' } }),
  });
  await openProPanel(page);
  await submitCode(page);

  await expect(page.getByText("You're already in Uptown Orators. Leave it to join another club.")).toBeVisible();
});

// ---------------------------------------------------------------------------
// AC-2: Pro follows the account
// ---------------------------------------------------------------------------

test('AC-2: empty storage, a member account gets its club from the server with no code', async ({ page }) => {
  const { requests } = await openPanel(page, {
    session: { identified: true, isGuest: false, uid: UID, token: 'e2e-session-token', entitlement: CLUB_ENTITLEMENT },
    club: () => ({ status: 200, json: clubState() }),
  });

  await expect.poll(() => requests.filter(isClubState).length).toBeGreaterThan(0);
  expect(requests.find(isClubState).headers.authorization).toBe('Bearer e2e-session-token');

  await openProPanel(page);
  await expect(page.getByText(/You're on Pro through/)).toBeVisible();
});

test('AC-2: a different account on this computer gets nothing from the saved club', async ({ page }) => {
  await openPanel(page, {
    session: { identified: true, isGuest: false, uid: 'someone-else', token: 'e2e-session-token', entitlement: FREE_ENTITLEMENT },
    seedClub: { ...clubState(), uid: UID, lastRefreshAt: Date.now() },
  });

  await expect.poll(() => page.evaluate(() => localStorage.getItem('toastmaster_club'))).toBeNull();
  await openProPanel(page);
  await expect(page.getByText(/on Pro through/)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// AC-4, AC-12, AC-3: leave, the owner, places
// ---------------------------------------------------------------------------

test('AC-4: Leave asks first, then leaves the club for this account', async ({ page }) => {
  const dialogs = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    dialog.accept();
  });
  const { requests } = await openPanel(page, {
    session: { identified: true, isGuest: false, uid: UID, token: 'e2e-session-token', entitlement: CLUB_ENTITLEMENT },
    seedClub: { ...clubState(), uid: UID, lastRefreshAt: Date.now() },
    club: () => ({ status: 200, json: clubState() }),
  });
  await openProPanel(page);
  await expect(page.getByText(/You're on Pro through/)).toBeVisible();

  await page.getByRole('button', { name: /^Leave/ }).first().click();
  const confirmText = "Leave Downtown Speakers? You'll lose its Pro on every computer where you're signed in.";
  await expect
    .poll(async () => dialogs.includes(confirmText) || (await page.getByText(confirmText).count()) > 0)
    .toBe(true);
  // An in-page confirm has its own Leave button; a native one was accepted above.
  if (!dialogs.length) await page.getByRole('button', { name: /^Leave/ }).last().click();

  await expect.poll(() => requests.filter(isLeave).length).toBe(1);
  expect(requests.find(isLeave).headers.authorization).toBe('Bearer e2e-session-token');
  await expect(page.getByText(/You're on Pro through/)).toHaveCount(0);
});

test('AC-12, AC-3: the owner has no Leave and sees how many places are used', async ({ page }) => {
  await openPanel(page, {
    session: { identified: true, isGuest: false, uid: UID, token: 'e2e-session-token', entitlement: CLUB_ENTITLEMENT },
    seedClub: { ...clubState({ role: 'admin', isOwner: true, code: CODE }), uid: UID, lastRefreshAt: Date.now() },
    club: () => ({
      status: 200,
      json: clubState({ role: 'admin', isOwner: true, code: CODE, placesUsed: 2, placesTotal: 3 }),
    }),
  });
  await openProPanel(page);

  await expect(page.getByText(/You're on Pro through/)).toBeVisible();
  await expect(page.getByText('2 of 3 places used')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Leave/ })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// AC-7, AC-8: no device token, nothing before the session
// ---------------------------------------------------------------------------

test('AC-7: no request carries X-Club, even from a device that held a club token', async ({ page }) => {
  const { requests } = await openPanel(page, {
    session: { identified: true, isGuest: false, uid: UID, token: 'e2e-session-token', entitlement: CLUB_ENTITLEMENT },
    // The shape a device saved before #167: a 24-hour club token, no uid.
    seedClub: { ...clubState(), clubToken: 'legacy-club-token', lastRefreshAt: 0 },
    club: () => ({ status: 200, json: clubState() }),
  });
  await openProPanel(page);
  await submitCode(page);
  await page.waitForTimeout(500);

  const carried = requests.filter((r) => 'x-club' in r.headers).map((r) => new URL(r.url).pathname);
  expect(carried).toEqual([]);
});

test('AC-8: no club request goes out before the Zoom session has answered', async ({ page }) => {
  const { requests, sessionAnsweredAt } = await openPanel(page, {
    sessionDelayMs: 1500,
    session: { identified: true, isGuest: false, uid: UID, token: 'e2e-session-token', entitlement: CLUB_ENTITLEMENT },
    seedClub: { ...clubState(), uid: UID, lastRefreshAt: 0 },
    club: () => ({ status: 200, json: clubState() }),
  });

  await expect.poll(() => requests.filter(isClubState).length).toBeGreaterThan(0);
  const clubCalls = requests.filter((r) => new URL(r.url).pathname.startsWith('/api/club'));
  expect(sessionAnsweredAt()).not.toBeNull();
  for (const call of clubCalls) expect(call.at).toBeGreaterThanOrEqual(sessionAnsweredAt());
});
