import { test, expect } from '@playwright/test';

// Joining a club from the web app (#167): the officer's /pro/<CODE> link and
// the code field on Account. A club belongs to Zoom accounts now, so a
// signed-out browser is sent to "Sign in with Zoom" and comes back to the same
// link, which then joins. Nothing names a device and nothing carries X-Club.

const CODE = 'DTSP-7K2QM9';
const CLUB_REF = { id: 'club-1', name: 'Downtown Speakers' };
const FLAGS = { pro: true, sounds: true };

const CLUB_STATE = {
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
  currentPeriodEnd: Date.now() + 200 * 24 * 60 * 60 * 1000,
  cancelAtPeriodEnd: false,
  source: 'club',
};

const FREE = {
  plan: 'free',
  status: null,
  entitled: false,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  source: 'none',
  club: null,
};

async function mockServer(page, { uid = null } = {}) {
  const requests = [];
  page.on('request', (request) => {
    requests.push({ url: request.url(), method: request.method(), headers: request.headers(), body: request.postData() });
  });
  await page.route('**/api/me**', (route) =>
    uid
      ? route.fulfill({ json: { uid, entitlement: FREE, flags: FLAGS } })
      : new URL(route.request().url()).searchParams.get('flags') === '1'
        ? route.fulfill({ json: { uid: null, flags: FLAGS } })
        : route.fulfill({ status: 401, json: { error: 'Unauthorized' } })
  );
  await page.route('**/api/club', (route) =>
    route.fulfill(uid ? { json: CLUB_STATE } : { status: 401, json: { error: 'sign_in_required' } })
  );
  await page.route('**/api/club/activate', (route) =>
    route.fulfill(
      uid
        ? { json: { ...CLUB_STATE, placesUsed: 2 } }
        : { status: 401, json: { error: 'sign_in_required' } }
    )
  );
  return requests;
}

const isActivate = (r) => r.method === 'POST' && new URL(r.url).pathname === '/api/club/activate';

/** The returnTo a "Sign in with Zoom" link carries, decoded. */
async function returnToOf(link) {
  const href = await link.getAttribute('href');
  const url = new URL(href, 'http://localhost');
  expect(url.pathname).toBe('/api/auth/zoom/start');
  return url.searchParams.get('returnTo');
}

test('AC-1d: a signed-out browser on /pro/<CODE> is asked to sign in with Zoom, and nothing is sent', async ({ page }) => {
  const requests = await mockServer(page);
  await page.goto(`/pro/${CODE}`);

  const link = page.getByRole('link', { name: 'Sign in with Zoom to join' });
  await expect(link).toBeVisible();
  expect(await returnToOf(link)).toBe(`/pro/${CODE}`);

  await page.waitForTimeout(500);
  expect(requests.filter(isActivate)).toHaveLength(0);
  await expect(page.getByText(/on Pro in this browser/)).toHaveCount(0);
});

test('AC-1d: signed in, /pro/<CODE> joins by account and says so', async ({ page }) => {
  const requests = await mockServer(page, { uid: 'web-member' });
  await page.goto(`/pro/${CODE}`);

  await expect(page.getByText(/You're on Pro through/)).toBeVisible();
  await expect(page.getByText('Downtown Speakers').first()).toBeVisible();

  const activate = requests.find(isActivate);
  expect(activate, 'the code was sent').toBeTruthy();
  // The web session is the cookie: no device id in the body, no club token.
  expect(JSON.parse(activate.body)).toEqual({ code: CODE });
  expect(requests.filter((r) => 'x-club' in r.headers)).toHaveLength(0);
  await expect(page.getByText(/in this browser/)).toHaveCount(0);
});

test('AC-1d: a signed-out browser entering a code on Account is asked to sign in first', async ({ page }) => {
  const requests = await mockServer(page);
  await page.goto('/account');

  const field = page.locator('#club-code');
  if (await field.count()) {
    await field.fill(CODE);
    await field.press('Enter');
  }

  const link = page.getByRole('link', { name: 'Sign in with Zoom to join' });
  await expect(link).toBeVisible();
  expect(await returnToOf(link)).toMatch(/^\/(pro\/|account)/);
  expect(requests.filter(isActivate)).toHaveLength(0);
  await expect(page.getByText('No sign-in needed', { exact: false })).toHaveCount(0);
});
