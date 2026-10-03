import { test, expect } from '@playwright/test';

// Inject CWV observers before any page JS runs
const cwvInitScript = () => {
  window.__cwv = { fcp: 0, lcp: 0, maxEventDuration: 0 };

  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      if (e.name === 'first-contentful-paint') window.__cwv.fcp = e.startTime;
  }).observe({ type: 'paint', buffered: true });

  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__cwv.lcp = e.startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });

  window.__cwv.maxEventDuration = 0;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      if (e.interactionId && e.duration > window.__cwv.maxEventDuration)
        window.__cwv.maxEventDuration = e.duration;
  }).observe({ type: 'event', buffered: true, durationThreshold: 0 });
};

test.describe('Web App — Functional Checks', () => {
  test('page loads with timer display', async ({ page }) => {
    await page.goto('/timer');
    await expect(page.getByText(/^\d{2}:\d{2}$/)).toBeVisible();
  });

  test('role selection updates timing rules', async ({ page }) => {
    await page.goto('/timer');
    const roleSelect = page.locator('select');
    await expect(roleSelect).toHaveValue('Standard Speech');

    await roleSelect.selectOption('Ice Breaker');
    await expect(roleSelect).toHaveValue('Ice Breaker');
  });

  test('start → timer ticks, stop → CONTINUE appears', async ({ page }) => {
    await page.goto('/timer');

    await page.getByRole('button', { name: /START/i }).click();
    await page.getByTitle('Show control panel').click();
    await page.waitForTimeout(1500);

    // Timer should have advanced past 00:00
    await expect(page.getByText(/^\d{2}:\d{2}$/)).not.toHaveText('00:00');

    // Stop → CONTINUE button appears
    await page.getByRole('button', { name: /STOP/i }).click();
    await expect(page.getByRole('button', { name: /CONTINUE/i })).toBeVisible();
  });

  test('tab switching preserves timer state', async ({ page }) => {
    await page.goto('/timer');

    // Start and let timer run
    await page.getByRole('button', { name: /START/i }).click();
    await page.getByTitle('Show control panel').click();
    await page.waitForTimeout(1000);

    // Switch through tabs
    await page.getByRole('button', { name: /AGENDA/i }).click();
    await page.getByRole('button', { name: /REPORT/i }).click();
    await page.getByRole('button', { name: /LIVE/i }).click();

    // Timer should still be running (not reset to 00:00)
    await expect(page.getByText(/^\d{2}:\d{2}$/)).not.toHaveText('00:00');
  });

  test('feedback modal opens', async ({ page }) => {
    await page.goto('/timer');
    await page.getByRole('button', { name: /Send Us Feedback/i }).click();
    // Lazy-loaded FeedbackModal should appear with heading
    await expect(page.getByRole('heading', { name: /Send Us Feedback/i })).toBeVisible();
  });

  test('reset returns timer to 00:00', async ({ page }) => {
    await page.goto('/timer');

    // Start, wait, then finish
    await page.getByRole('button', { name: /START/i }).click();
    await page.getByTitle('Show control panel').click();
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /FINISH/i }).click();

    // After FINISH, timer resets and START reappears
    await expect(page.getByRole('button', { name: /START/i })).toBeVisible();
    await expect(page.getByText(/^\d{2}:\d{2}$/)).toHaveText('00:00');
  });
});

test.describe('Web App — Performance @performance', () => {
  test('FCP and LCP within thresholds', async ({ page }) => {
    await page.addInitScript(cwvInitScript);
    await page.goto('/timer');

    // Wait for LCP to settle
    await page.waitForTimeout(2000);

    const cwv = await page.evaluate(() => window.__cwv);
    console.log(`Web CWV — FCP: ${cwv.fcp}ms, LCP: ${cwv.lcp}ms`);

    expect(cwv.fcp, `FCP ${cwv.fcp}ms exceeded 3s`).toBeLessThan(3000);
    expect(cwv.lcp, `LCP ${cwv.lcp}ms exceeded 4s`).toBeLessThan(4000);
  });

  test('INP/TBT within threshold after interactions', async ({ page }) => {
    await page.addInitScript(cwvInitScript);
    await page.goto('/timer');
    await page.waitForTimeout(500);

    // Perform several interactions to generate event timing entries
    await page.getByRole('button', { name: /START/i }).click();
    await page.getByTitle('Show control panel').click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /STOP/i }).click();
    await page.getByRole('button', { name: /CONTINUE/i }).click();
    await page.getByRole('button', { name: /AGENDA/i }).click();
    await page.getByRole('button', { name: /LIVE/i }).click();

    await page.waitForTimeout(500);

    const cwv = await page.evaluate(() => window.__cwv);
    console.log(`Web CWV — Max Event Duration (INP proxy): ${cwv.maxEventDuration}ms`);

    expect(cwv.maxEventDuration, `INP proxy ${cwv.maxEventDuration}ms exceeded 200ms`).toBeLessThan(200);
  });
});
