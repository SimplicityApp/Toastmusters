import { test, expect } from '@playwright/test';

// The announcement banner above the tabs, with the shipped announcements.
// Production until Pro launches: `sounds` released, `pro` not, so the
// pre-launch notice is the one showing.
function session(page, flags) {
  return page.route('**/api/zoom/session', (route) =>
    route.fulfill({
      json: { identified: true, uid: 'e2e-announcement', entitlement: { plan: 'free' }, flags },
    })
  );
}

test('before the launch, the banner says a new look and Pro are coming, and Sounds is locked as coming soon', async ({ page }) => {
  await session(page, { sounds: true, pro: false });
  await page.goto('/zoom/');

  const banner = page.getByTestId('announcement-banner');
  await expect(banner).toHaveAttribute('data-announcement-id', 'pre-launch-2026-11');
  await expect(banner).toHaveText(
    'Coming soon: a fresh new look for the timer, and Pro features for your club.'
  );

  const sounds = page.getByRole('button', { name: /^Sounds \(locked\)/ });
  await expect(sounds).toHaveAccessibleName('Sounds (locked): Hold tight! Sounds are coming soon.');
  await sounds.click();
  await expect(page.getByText('Hold tight! Sounds are coming soon.')).toBeVisible();
  await expect(page.getByText(/sounds are a pro feature/i)).toHaveCount(0);
});

test('a closed announcement stays gone after reopening', async ({ page }) => {
  await session(page, { sounds: true, pro: false });
  await page.goto('/zoom/');
  const banner = page.getByTestId('announcement-banner');
  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('toastmaster_announcements_dismissed'))).toBe(
    '["pre-launch-2026-11"]'
  );

  await page.reload();
  await expect(page.getByRole('button', { name: /START/i })).toBeVisible();
  await expect(page.getByTestId('announcement-banner')).toHaveCount(0);
});

test('no pre-launch notice once Pro is released', async ({ page }) => {
  await session(page, { sounds: true, pro: true });
  await page.goto('/zoom/');
  await expect(page.getByRole('button', { name: /START/i })).toBeVisible();
  await expect(page.getByTestId('announcement-banner')).toHaveCount(0);
});
