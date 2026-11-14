import { test, expect } from '@playwright/test';

// Club features are on only when the club is active AND Pro is released. A club
// device whose `pro` flag is off behaves as a lapsed one: no badge, no club
// strip on the Report tab, no renewal line; nothing is deleted.
const CLUB = {
  clubToken: 'club-token',
  // Fresh, so the app does not refresh the club against the (unmocked) server.
  lastRefreshAt: Date.now(),
  ver: 1,
  club: { id: 'club-1', name: 'Downtown Speakers' },
  kit: { name: 'Downtown Speakers', logoUrl: null, primaryColor: '#772432', showOnCards: true, showOnReports: true },
  presets: null,
  badge: { x: 0.8, y: 0.12, scale: 0.12 },
  timezone: null,
  role: 'admin',
  plan: 'pro',
  entitled: true,
  status: 'active',
  // Set not to renew and ending in 10 days: inside the reminder's 60-day window.
  currentPeriodEnd: Date.now() + 10 * 24 * 60 * 60 * 1000,
  cancelAtPeriodEnd: true,
  source: 'club',
};

async function openAsClubDevice(page, flags) {
  await page.addInitScript((club) => {
    if (sessionStorage.getItem('e2e_seeded')) return;
    sessionStorage.setItem('e2e_seeded', '1');
    localStorage.setItem('toastmaster_club', JSON.stringify(club));
  }, CLUB);
  await page.route('**/api/zoom/session', (route) =>
    route.fulfill({
      json: {
        identified: true,
        uid: 'e2e-club',
        entitlement: { plan: 'pro', status: 'active', entitled: true, source: 'club' },
        flags,
      },
    })
  );
  await page.goto('/zoom/');
  await expect(page.getByRole('button', { name: /START/i })).toBeVisible();
}

test('a club device shows no club features while pro is off', async ({ page }) => {
  await openAsClubDevice(page, { sounds: true, pro: false });

  await expect(page.getByTestId('club-grace-banner')).toHaveCount(0);
  await expect(page.getByTestId('club-badge')).toHaveCount(0);
  await expect(page.getByText('Downtown Speakers', { exact: false })).toHaveCount(0);

  await page.getByRole('button', { name: 'REPORT' }).click();
  await expect(page.getByTestId('club-archive-indicator')).toHaveCount(0);

  // Nothing was deleted: the device is still in its club.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('toastmaster_club')).club.name)).toBe(
    'Downtown Speakers'
  );
});

test('the same device shows its club features once pro is on', async ({ page }) => {
  await openAsClubDevice(page, { sounds: true, pro: true });

  await expect(page.getByTestId('club-grace-banner')).toContainText("Downtown Speakers's Pro ends in 10 days");
  await expect(page.getByTestId('club-badge')).toContainText('Downtown Speakers');

  await page.getByRole('button', { name: 'REPORT' }).click();
  await expect(page.getByTestId('club-archive-indicator')).toContainText('Saved to Downtown Speakers');
});
