import { test, expect } from '@playwright/test';

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

test('agenda add and load speakers', async ({ page }) => {
  await page.goto('/timer/app');

  // Switch to AGENDA tab
  await page.getByRole('button', { name: /AGENDA/i }).click();

  // Verify empty state message
  await expect(page.getByText('No speakers in agenda')).toBeVisible();

  // Add speaker Alice with Ice Breaker role
  await page.getByRole('button', { name: /Add Item/i }).click();
  await page.getByPlaceholder('Enter speaker name').fill('Alice');

  // Select Ice Breaker in the modal's role dropdown
  const modalSelect = page.locator('.fixed select');
  await modalSelect.selectOption('Ice Breaker');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // Verify Alice is now listed in the agenda
  await expect(page.getByText('Alice')).toBeVisible();

  // Add speaker Bob with default role
  await page.getByRole('button', { name: /Add Item/i }).click();
  await page.getByPlaceholder('Enter speaker name').fill('Bob');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // Verify Bob is listed
  await expect(page.getByText('Bob')).toBeVisible();

  // Click Alice to load into the LIVE tab
  await page.getByText('Alice').click();

  // Should now show Alice's name in the speaker input on the LIVE tab
  await expect(page.getByPlaceholder('Type speaker name...')).toHaveValue('Alice');
});

test('Simple Format import assigns custom roles', async ({ page }) => {
  await page.goto('/timer/app');

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
