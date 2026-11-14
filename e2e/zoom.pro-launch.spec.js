import { test, expect } from '@playwright/test';

// The one-time "Pro is here" announcement. It appears after a speech ends, only
// while the `pro` flag is on and only to a device that is not Pro already.

function session(page, { plan = 'free', pro = true, sounds = false } = {}) {
  return page.route('**/api/zoom/session', (route) =>
    route.fulfill({
      json: {
        identified: true,
        uid: 'e2e-pro-launch',
        entitlement:
          plan === 'pro'
            ? { plan: 'pro', status: 'active', entitled: true, source: 'subscription' }
            : { plan: 'free', status: null, entitled: false, source: null },
        flags: { pro, sounds },
      },
    })
  );
}

const announcement = (page) => page.getByRole('dialog', { name: /new: pro for your club/i });
// The footer's: the locked Sounds button's label mentions upgrading too.
const upgradeButton = (page) => page.locator('footer').getByRole('button', { name: /upgrade to pro/i });

async function timeOneSpeech(page) {
  await page.getByRole('button', { name: /START/i }).click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /FINISH/i }).click();
}

test('a free user sees it once, after FINISH, and the footer marks Upgrade as new', async ({ page }) => {
  await session(page);
  await page.goto('/zoom/');

  await expect(upgradeButton(page)).toContainText('New');
  await timeOneSpeech(page);

  // Not on the FINISH click itself: the prompt waits for a quiet moment.
  await expect(announcement(page)).toBeHidden();
  await expect(announcement(page)).toBeVisible({ timeout: 6000 });
  await expect(announcement(page)).toContainText('One plan covers every timer in your club');

  await announcement(page).getByRole('button', { name: /not now/i }).click();
  await expect(announcement(page)).toBeHidden();
  // Closing the announcement leaves the quiet reminder in place.
  await expect(upgradeButton(page)).toContainText('New');

  // Shown once: another speech, after a reload, brings nothing back.
  await page.reload();
  await timeOneSpeech(page);
  await page.waitForTimeout(4000);
  await expect(announcement(page)).toBeHidden();
});

test('"See what\'s in Pro" opens the Upgrade dialog and retires the badge', async ({ page }) => {
  await session(page, { sounds: true });
  await page.goto('/zoom/');
  await timeOneSpeech(page);
  await expect(announcement(page)).toBeVisible({ timeout: 6000 });
  // Sounds are pitched once released, in the announcement and behind it.
  await expect(announcement(page)).toContainText('A chime when the card changes, and music during breaks');

  await announcement(page).getByRole('button', { name: /see what's in pro/i }).click();
  await expect(announcement(page)).toBeHidden();
  await expect(page.getByText("Every meeting saved to your club's archive")).toBeVisible();
  await expect(page.getByText('A chime when the card changes, and music during breaks')).toBeVisible();

  await page.getByRole('button', { name: 'Close' }).first().click();
  await expect(upgradeButton(page)).toBeVisible();
  await expect(upgradeButton(page)).not.toContainText('New');
});

test('nothing while Pro is not released', async ({ page }) => {
  await session(page, { pro: false });
  await page.goto('/zoom/');
  await timeOneSpeech(page);
  await page.waitForTimeout(4000);
  await expect(announcement(page)).toBeHidden();
  await expect(upgradeButton(page)).toHaveCount(0);
});

test('nothing for a device that is already Pro', async ({ page }) => {
  await session(page, { plan: 'pro' });
  await page.goto('/zoom/');
  await timeOneSpeech(page);
  await page.waitForTimeout(4000);
  await expect(announcement(page)).toBeHidden();
  await expect(page.locator('footer').getByRole('button', { name: /manage your pro plan/i })).not.toContainText('New');
});
