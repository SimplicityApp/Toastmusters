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

// Custom roles for the Simple Format import test (green / yellow / red in seconds)
const CUSTOM_ROLES = [
  { name: 'Opening', green: 15, yellow: 30, red: 45 },
  { name: 'Closing Remarks', green: 60, yellow: 90, red: 120 },
  { name: 'Hand over', green: 30, yellow: 45, red: 60 },
];

const SIMPLE_FORMAT_TEXT = [
  'Cam-Ly - Opening (Opening)',
  'Dominique - General Evaluation (Closing)',
  'Yu (Closing Remarks - 2 min)',
  'Sam - Introduce Speakers (hand over)',
  'Bob (Ice Breaker)',
  'Lee (Moment of Reflection)',
].join('\n');

// [row name, role shown] for each imported line, in order
const EXPECTED_ROWS = [
  ['Cam-Ly - Opening', 'Opening'],
  ['Dominique - General Evaluation', 'Closing Remarks'],
  ['Yu', 'Closing Remarks'],
  ['Sam - Introduce Speakers', 'Hand over'],
  ['Bob', 'Ice Breaker'],
  ['Lee', 'Short Roles'],
];

// Add roles through the Live tab's "Edit timing rules" modal and save
async function addCustomRoles(page, roles) {
  await page.getByRole('link', { name: 'Edit timing rules' }).click();

  // Seconds mode gives each timing one input: Green, Yellow, Red, Grace
  await page.getByRole('button', { name: 'seconds', exact: true }).click();

  for (const { name, green, yellow, red } of roles) {
    await page.getByRole('button', { name: /Add role/i }).click();
    const card = page.locator('.border.rounded-lg.p-4').filter({ has: page.getByPlaceholder('Role name') }).last();
    await card.getByPlaceholder('Role name').fill(name);
    const timings = card.locator('input[type="number"]');
    await timings.nth(0).fill(String(green));
    await timings.nth(1).fill(String(yellow));
    await timings.nth(2).fill(String(red));
  }

  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByRole('heading', { name: 'Edit Timing Rules' })).toBeHidden();
}

test.describe('Zoom App — Functional Checks', () => {
  let consoleErrors;

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    page.on('pageerror', (error) => consoleErrors.push(error.message));
  });

  test('page loads with timer display', async ({ page }) => {
    await page.goto('/zoom/');
    await expect(page.getByTestId('timer-display')).toBeVisible();
  });

  test('select role, start timer, verify ticking', async ({ page }) => {
    await page.goto('/zoom/');

    // Select a role
    const roleSelect = page.locator('select');
    await roleSelect.selectOption('Ice Breaker');
    await expect(roleSelect).toHaveValue('Ice Breaker');

    // Start timer
    await page.getByRole('button', { name: /START/i }).click();
    await page.waitForTimeout(1500);

    // Timer should have advanced past 00:00
    await expect(page.getByTestId('timer-display')).not.toHaveText('00:00');
  });

  test('STOP → CONTINUE → FINISH flow', async ({ page }) => {
    await page.goto('/zoom/');

    // Type speaker name
    const nameInput = page.getByPlaceholder('Type speaker name...');
    await nameInput.fill('Zoom Speaker');

    // Start and wait
    await page.getByRole('button', { name: /START/i }).click();
    await page.waitForTimeout(1000);

    // Stop
    await page.getByRole('button', { name: /STOP/i }).click();
    await expect(page.getByRole('button', { name: /CONTINUE/i })).toBeVisible();

    // Continue
    await page.getByRole('button', { name: /CONTINUE/i }).click();
    await page.waitForTimeout(500);

    // Finish
    await page.getByRole('button', { name: /FINISH/i }).click();
    await expect(page.getByRole('button', { name: /START/i })).toBeVisible();
  });

  test('tab switching (LIVE → AGENDA → REPORT → LIVE)', async ({ page }) => {
    await page.goto('/zoom/');

    // Verify we start on LIVE
    await expect(page.getByTestId('timer-display')).toBeVisible();

    // Switch to AGENDA
    await page.getByRole('button', { name: /AGENDA/i }).click();
    await expect(page.getByText(/No speakers in agenda/i)).toBeVisible();

    // Switch to REPORT
    await page.getByRole('button', { name: /REPORT/i }).click();
    await expect(page.getByText(/No reports yet/i)).toBeVisible();

    // Back to LIVE
    await page.getByRole('button', { name: /LIVE/i }).click();
    await expect(page.getByTestId('timer-display')).toBeVisible();
  });

  test('report tab shows completed speech', async ({ page }) => {
    await page.goto('/zoom/');

    const nameInput = page.getByPlaceholder('Type speaker name...');
    await nameInput.fill('Report Speaker');

    await page.getByRole('button', { name: /START/i }).click();
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /FINISH/i }).click();

    await page.getByRole('button', { name: /REPORT/i }).click();
    await expect(page.getByText('Report Speaker')).toBeVisible();
  });

  test('Simple Format import assigns custom roles', async ({ page }) => {
    await page.goto('/zoom/');

    // Create the custom roles; the Live tab dropdown lists them after the built-ins
    await addCustomRoles(page, CUSTOM_ROLES);
    await expect(page.locator('select option')).toContainText(CUSTOM_ROLES.map((role) => role.name));

    // Agenda tab -> Import Text; the modal opens on EasySpeak, so switch to Simple Format
    await page.getByRole('button', { name: /AGENDA/i }).click();
    await page.getByRole('button', { name: /Import Text/i }).click();
    await page.getByRole('button', { name: 'Simple Format' }).click();
    await page.getByPlaceholder('John Doe (Ice Breaker)').fill(SIMPLE_FORMAT_TEXT);
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    await expect(page.getByText('Imported 6 speaker(s)')).toBeVisible();

    // Each row lands on the role from its last "(...)" group, matched to the custom roles
    const rows = page.locator('.cursor-pointer').filter({ has: page.getByRole('button', { name: /^Edit / }) });
    await expect(rows).toHaveCount(EXPECTED_ROWS.length);
    await expect(rows.locator('.font-medium')).toHaveText(EXPECTED_ROWS.map(([name]) => name));
    await expect(rows.locator('.text-sm')).toHaveText(EXPECTED_ROWS.map(([, role]) => `(${role})`));

    // Loading an imported custom-role speaker uses that role's own timings
    await page.getByText('Cam-Ly - Opening', { exact: true }).click();
    await expect(page.locator('select')).toHaveValue('Opening');
    await expect(page.getByText('Timing rules: Green: 15 seconds, Yellow: 30 seconds, Red: 45 seconds')).toBeVisible();
  });

  test('no console errors about missing context providers', async ({ page }) => {
    await page.goto('/zoom/');
    await page.waitForTimeout(1000);

    const contextErrors = consoleErrors.filter(
      (msg) => msg.includes('Context') || msg.includes('Provider')
    );
    expect(contextErrors, `Context errors: ${contextErrors.join(', ')}`).toHaveLength(0);
  });
});

test.describe('Zoom App — Performance @performance', () => {
  test('FCP and LCP within thresholds', async ({ page }) => {
    await page.addInitScript(cwvInitScript);
    await page.goto('/zoom/');

    // Wait for LCP to settle
    await page.waitForTimeout(2000);

    const cwv = await page.evaluate(() => window.__cwv);
    console.log(`Zoom CWV — FCP: ${cwv.fcp}ms, LCP: ${cwv.lcp}ms`);

    expect(cwv.fcp, `FCP ${cwv.fcp}ms exceeded 3s`).toBeLessThan(3000);
    expect(cwv.lcp, `LCP ${cwv.lcp}ms exceeded 4s`).toBeLessThan(4000);
  });

  test('INP/TBT within threshold after interactions', async ({ page }) => {
    await page.addInitScript(cwvInitScript);
    await page.goto('/zoom/');
    await page.waitForTimeout(500);

    // Perform interactions
    await page.getByRole('button', { name: /START/i }).click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /STOP/i }).click();
    await page.getByRole('button', { name: /CONTINUE/i }).click();
    await page.getByRole('button', { name: /AGENDA/i }).click();
    await page.getByRole('button', { name: /LIVE/i }).click();

    await page.waitForTimeout(500);

    const cwv = await page.evaluate(() => window.__cwv);
    console.log(`Zoom CWV — Max Event Duration (INP proxy): ${cwv.maxEventDuration}ms`);

    // Zoom SDK init is heavier, so allow more headroom
    expect(cwv.maxEventDuration, `INP proxy ${cwv.maxEventDuration}ms exceeded 500ms`).toBeLessThan(500);
  });
});
