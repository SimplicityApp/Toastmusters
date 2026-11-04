import { test, expect } from '@playwright/test';

// A Pro user with the sounds flag on, a role whose cards change at 1, 2 and 3
// seconds, and the chime already switched on. Every oscillator the page starts
// is recorded, so the test hears what the speaker would.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => {
    if (new URL(route.request().url()).pathname === '/api/me') {
      return route.fulfill({
        json: {
          uid: 'e2e-sounds',
          entitlement: { plan: 'pro', status: 'active', entitled: true, source: 'subscription' },
          flags: { sounds: true },
        },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e_seeded')) return;
    sessionStorage.setItem('e2e_seeded', '1');
    localStorage.setItem('toastmaster_role_rules', JSON.stringify({ Quick: { green: 1, yellow: 2, red: 3 } }));
    localStorage.setItem('toastmaster_role_order', JSON.stringify(['Quick']));
    localStorage.setItem('toastmaster_sound_settings', JSON.stringify({ cues: true, volume: 0.7 }));
  });
  await page.addInitScript(() => {
    window.__tones = [];
    const create = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      const osc = create.call(this);
      const set = osc.frequency.setValueAtTime.bind(osc.frequency);
      osc.frequency.setValueAtTime = (value, time) => {
        window.__tones.push(Math.round(value));
        return set(value, time);
      };
      return osc;
    };
  });
});

test('chimes one, two and three notes as the cards change', async ({ page }) => {
  await page.goto('/timer/app');
  await page.locator('select').selectOption('Quick');
  await expect(page.getByRole('button', { name: 'Sounds' })).toBeVisible();

  await page.getByRole('button', { name: /START/i }).click();
  // The panel minimizes on START, which unmounts the tabs; the chime must not
  // depend on them.
  await expect.poll(() => page.evaluate(() => window.__tones.length), { timeout: 6000 }).toBe(12);

  // Fundamentals only (each note also has a quiet octave above).
  const fundamentals = await page.evaluate(() => window.__tones.filter((_, i) => i % 2 === 0));
  expect(fundamentals).toEqual([659, 659, 784, 659, 784, 1047]);
});

test('the Sounds modal turns the chime off', async ({ page }) => {
  await page.goto('/timer/app');
  await page.getByRole('button', { name: 'Sounds' }).click();
  const chime = page.getByRole('checkbox', { name: /chime when the card changes/i });
  await expect(chime).toBeChecked();
  await chime.uncheck();
  await page.getByRole('button', { name: 'Close' }).click();

  await page.locator('select').selectOption('Quick');
  await page.getByRole('button', { name: /START/i }).click();
  await page.waitForTimeout(3500);
  expect(await page.evaluate(() => window.__tones.length)).toBe(0);
});
