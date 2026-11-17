import { test, expect } from '@playwright/test';

// The daily club refresh at app start. The server reads the caller's club role
// (and with it the code and "Share with my club") from the Zoom session, and in
// the Zoom app that session only exists once POST /api/zoom/session answers.
// The refresh used to go out at module load, before it: an admin's device came
// back as nobody's and lost every admin-only control until the next day.
const DAY = 24 * 60 * 60 * 1000;
const SESSION_TOKEN = 'e2e-session-token';

const club = (over = {}) => ({
  clubToken: 'club-token',
  ver: 1,
  club: { id: 'club-1', name: 'Downtown Speakers' },
  kit: null,
  presets: null,
  badge: null,
  timezone: null,
  role: 'admin',
  code: 'DTSP-7K2QM9',
  shareUrl: 'https://www.example.test/pro/DTSP-7K2QM9',
  plan: 'pro',
  entitled: true,
  status: 'active',
  currentPeriodEnd: Date.now() + 300 * DAY,
  cancelAtPeriodEnd: false,
  source: 'club',
  ...over,
});

/**
 * Open the Zoom app as an admin's club device, with a slow session endpoint and
 * a /api/club that answers like the Worker: the role only for a caller whose
 * session it can see.
 */
async function openAdminDevice(page, { lastRefreshAt }) {
  const seen = { sessionAnsweredAt: null, clubRequests: [] };

  await page.addInitScript((seed) => {
    if (sessionStorage.getItem('e2e_seeded')) return;
    sessionStorage.setItem('e2e_seeded', '1');
    localStorage.setItem('toastmaster_club', JSON.stringify(seed));
  }, club({ lastRefreshAt }));

  await page.route('**/api/zoom/session', async (route) => {
    // Long enough that a refresh sent at module load would beat it every time.
    await new Promise((resolve) => setTimeout(resolve, 800));
    seen.sessionAnsweredAt = Date.now();
    await route.fulfill({
      json: {
        identified: true,
        uid: 'e2e-admin',
        token: SESSION_TOKEN,
        entitlement: { plan: 'pro', status: 'active', entitled: true, source: 'club' },
        flags: { pro: true },
      },
    });
  });

  await page.route('**/api/club', async (route) => {
    const headers = route.request().headers();
    seen.clubRequests.push({ at: Date.now(), authorization: headers.authorization ?? null, xClub: headers['x-club'] ?? null });
    const signedIn = headers.authorization === `Bearer ${SESSION_TOKEN}`;
    await route.fulfill({
      json: {
        ...club(signedIn ? {} : { role: null, code: null, shareUrl: null }),
        clubToken: 'club-token-2',
      },
    });
  });

  await page.goto('/zoom/');
  await expect(page.getByRole('button', { name: /START/i })).toBeVisible();
  return seen;
}

const cachedClub = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('toastmaster_club')));

test('a due refresh waits for the Zoom session, so an admin stays an admin', async ({ page }) => {
  const seen = await openAdminDevice(page, { lastRefreshAt: Date.now() - 2 * DAY });

  await expect.poll(() => seen.clubRequests.length).toBe(1);
  const [refresh] = seen.clubRequests;
  expect(refresh).toMatchObject({ xClub: 'club-token', authorization: `Bearer ${SESSION_TOKEN}` });
  expect(refresh.at).toBeGreaterThanOrEqual(seen.sessionAnsweredAt);

  await expect.poll(async () => (await cachedClub(page)).clubToken).toBe('club-token-2');
  expect(await cachedClub(page)).toMatchObject({ role: 'admin', code: 'DTSP-7K2QM9' });

  // What the admin sees: Card Images offers to share with the club.
  await page.getByRole('button', { name: 'Customize card images' }).click();
  await expect(page.getByText('Share a set to put it on every club device.')).toBeVisible();
});

test('a refresh that is not due does not go out at all', async ({ page }) => {
  const seen = await openAdminDevice(page, { lastRefreshAt: Date.now() });

  // Past the session, so a waiting refresh would have fired by now.
  await expect.poll(() => seen.sessionAnsweredAt).not.toBeNull();
  await page.waitForTimeout(300);
  expect(seen.clubRequests).toHaveLength(0);
  expect(await cachedClub(page)).toMatchObject({ clubToken: 'club-token', role: 'admin' });
});
