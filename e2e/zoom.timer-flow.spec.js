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

// [row name, role line] for each imported line, in order. Only an exact role
// name is taken; every other line is left for the user to pick (#91).
const EXPECTED_ROWS = [
  ['Cam-Ly - Opening', '(Opening)'],
  ['Dominique - General Evaluation', '(Closing) is not one of your roles'],
  ['Yu', '(Closing Remarks - 2 min) is not one of your roles'],
  ['Sam - Introduce Speakers', '(Hand over)'],
  ['Bob', '(Ice Breaker)'],
  ['Lee', '(Moment of Reflection) is not one of your roles'],
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

    await expect(page.getByText('Imported 6 speaker(s). 3 need a role')).toBeVisible();

    // A row gets the role its last "(...)" group names exactly; the rest are highlighted
    const rows = page.locator('.cursor-pointer').filter({ has: page.getByRole('button', { name: /^Edit / }) });
    await expect(rows).toHaveCount(EXPECTED_ROWS.length);
    await expect(rows.locator('.font-medium')).toHaveText(EXPECTED_ROWS.map(([name]) => name));
    await expect(rows.locator('.font-medium + div')).toHaveText(EXPECTED_ROWS.map(([, line]) => line));
    await expect(page.locator('[data-needs-role]')).toHaveCount(3);
    await expect(page.getByText('3 rows need a role.')).toBeVisible();

    // A highlighted row does not open in the Live tab
    await page.getByText('Lee', { exact: true }).click();
    await expect(page.getByText('Pick a role for Lee first')).toBeVisible();
    await expect(page.getByRole('button', { name: /Import Text/i })).toBeVisible();

    // Pick from the saved roles; the highlight and the banner go
    await page.getByLabel('Pick a role for Dominique - General Evaluation').selectOption('Closing Remarks');
    await page.getByLabel('Pick a role for Yu').selectOption('Closing Remarks');
    await page.getByLabel('Pick a role for Lee').selectOption('Short Roles');
    await expect(page.locator('[data-needs-role]')).toHaveCount(0);
    await expect(page.getByText(/rows? needs? a role\./)).toHaveCount(0);
    await expect(rows.locator('.font-medium + div')).toHaveText([
      '(Opening)', '(Closing Remarks)', '(Closing Remarks)', '(Hand over)', '(Ice Breaker)', '(Short Roles)',
    ]);

    // Loading an imported custom-role speaker uses that role's own timings
    await page.getByText('Cam-Ly - Opening', { exact: true }).click();
    await expect(page.locator('select')).toHaveValue('Opening');
    await expect(page.getByText('Timing rules: Green: 15 seconds, Yellow: 30 seconds, Red: 45 seconds')).toBeVisible();
  });

  test('Simple Format import: a keyword in the name never sets the role (#90, #91)', async ({ page }) => {
    await page.goto('/zoom/');

    await page.getByRole('button', { name: /AGENDA/i }).click();
    await page.getByRole('button', { name: /Import Text/i }).click();
    await page.getByRole('button', { name: 'Simple Format' }).click();
    await page
      .getByPlaceholder('John Doe (Ice Breaker)')
      .fill('Tim Timer (Standard Speech)\nDominique - General Evaluation (Table Topics)');
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    await expect(page.getByText('Imported 2 speaker(s). 1 needs a role')).toBeVisible();

    const rows = page.locator('.cursor-pointer').filter({ has: page.getByRole('button', { name: /^Edit / }) });
    await expect(rows).toHaveCount(2);
    await expect(rows.locator('.font-medium')).toHaveText(['Tim Timer', 'Dominique - General Evaluation']);
    await expect(rows.locator('.font-medium + div')).toHaveText([
      '(Standard Speech)',
      '(Table Topics) is not one of your roles',
    ]);
  });

  test('Simple Format import: (Table Topics Speech) times 1/1.5/2 min, (Table Topics) needs a pick (#91)', async ({ page }) => {
    await page.goto('/zoom/');

    await page.getByRole('button', { name: /AGENDA/i }).click();
    await page.getByRole('button', { name: /Import Text/i }).click();
    await page.getByRole('button', { name: 'Simple Format' }).click();
    await page.getByPlaceholder('John Doe (Ice Breaker)').fill('David Kim (Table Topics Speech)\nAlex (Table Topics)');
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    await expect(page.getByText('Imported 2 speaker(s). 1 needs a role')).toBeVisible();
    await page.getByLabel('Pick a role for Alex').selectOption('Table Topics Speech');
    await expect(page.locator('[data-needs-role]')).toHaveCount(0);

    // The imported row drives the Live tab with Table Topics Speech's own rules, and START runs
    await page.getByText('David Kim', { exact: true }).click();
    await expect(page.locator('select')).toHaveValue('Table Topics Speech');
    await expect(page.getByText('Timing rules: Green: 1 minute, Yellow: 1 min 30 sec, Red: 2 minutes')).toBeVisible();
    await page.getByRole('button', { name: /START/i }).click();
    await expect(page.getByRole('button', { name: /STOP/i })).toBeVisible();
    await expect(page.getByText('Please set timing rules first')).toHaveCount(0);
  });

  test('the Live tab does not time a row that needs a role: suggestions, FINISH, stage picker (#91)', async ({ page }) => {
    await page.goto('/zoom/');

    await page.getByRole('button', { name: /AGENDA/i }).click();
    await page.getByRole('button', { name: /Import Text/i }).click();
    await page.getByRole('button', { name: 'Simple Format' }).click();
    await page.getByPlaceholder('John Doe (Ice Breaker)').fill('Bob (Ice Breaker)\nAlex (Table Topics)\nAlice (Standard Speech)');
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByText('Imported 3 speaker(s). 1 needs a role')).toBeVisible();
    await page.getByRole('button', { name: /LIVE/i }).click();

    const nameInput = page.getByPlaceholder('Type speaker name...');
    const rolePicker = page.locator('select');
    const askForAlex = page.getByText('Pick a role for Alex on the Agenda tab first');
    // The same warning comes back on each path; close it so the next check sees a new one.
    const closeAsk = () => askForAlex.locator('..').getByRole('button', { name: 'Close' }).click();

    // Panel suggestions: Alex is refused and nothing moves; Bob loads
    await nameInput.click();
    await page.getByText('Alex', { exact: true }).click();
    await expect(askForAlex).toBeVisible();
    await expect(nameInput).toHaveValue('');
    await expect(rolePicker).toHaveValue('Standard Speech');
    await closeAsk();

    await nameInput.click();
    await page.getByText('Bob', { exact: true }).click();
    await expect(nameInput).toHaveValue('Bob');
    await expect(rolePicker).toHaveValue('Ice Breaker');

    // FINISH stops at Alex: no auto-load, no default role, field cleared
    await page.getByRole('button', { name: /START/i }).click();
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /FINISH/i }).click();
    await expect(askForAlex).toBeVisible();
    await expect(nameInput).toHaveValue('');
    await expect(rolePicker).toHaveValue('Ice Breaker');
    await closeAsk();

    // Full-Screen Timer's agenda picker: Alex is refused, Alice loads
    await page.getByRole('button', { name: /^Display mode:/ }).click();
    await page.getByRole('menuitemradio', { name: /Full-Screen Timer/ }).click();
    const stageName = page.getByTestId('timer-stage').getByRole('textbox', { name: 'Speaker name', exact: true });
    const openStagePicker = () =>
      page.getByRole('button', { name: 'Choose a speaker from the agenda or the meeting' }).click();

    await openStagePicker();
    await page.getByRole('option', { name: /Alex/ }).click();
    await expect(askForAlex).toBeVisible();
    await expect(stageName).toHaveValue('');

    await openStagePicker();
    await page.getByRole('option', { name: /Alice/ }).click();
    await expect(stageName).toHaveValue('Alice');
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
