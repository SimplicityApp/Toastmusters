import { test, expect } from '@playwright/test';

// A Pro user with the sounds flag on and break music already switched on.
// Every oscillator the page starts is counted, so the test hears what the room
// would.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/zoom/session', (route) =>
    route.fulfill({
      json: {
        identified: true,
        uid: 'e2e-sounds',
        entitlement: { plan: 'pro', status: 'active', entitled: true, source: 'subscription' },
        flags: { sounds: true, pro: true },
      },
    })
  );
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e_seeded')) return;
    sessionStorage.setItem('e2e_seeded', '1');
    localStorage.setItem('toastmaster_sound_settings', JSON.stringify({ music: true, volume: 0.7 }));
  });
  await page.addInitScript(() => {
    window.__tones = 0;
    const create = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      window.__tones += 1;
      return create.call(this);
    };
  });
});

const tones = (page) => page.evaluate(() => window.__tones);

test('break music plays while a break runs and stops on STOP', async ({ page }) => {
  await page.goto('/zoom/');
  await expect(page.getByRole('button', { name: 'Sounds' })).toBeVisible();
  await page.locator('select').selectOption('Take a Break');

  await page.getByRole('button', { name: /START/i }).click();
  await expect.poll(() => tones(page)).toBeGreaterThan(4);

  await page.getByRole('button', { name: /STOP/i }).click();
  // Notes already scheduled may still start; after that, nothing new.
  await page.waitForTimeout(600);
  const settled = await tones(page);
  await page.waitForTimeout(1500);
  expect(await tones(page)).toBe(settled);
});

test('no music for a speech', async ({ page }) => {
  await page.goto('/zoom/');
  await page.locator('select').selectOption('Ice Breaker');
  await page.getByRole('button', { name: /START/i }).click();
  await page.waitForTimeout(2000);
  expect(await tones(page)).toBe(0);
});
