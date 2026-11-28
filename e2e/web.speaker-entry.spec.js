import { test, expect } from '@playwright/test';

// #168, on-the-spot speakers, on the web Live tab. The web follows the Zoom app
// (AC-12): same status, staged Update with Undo, add panel, quick timing, Back
// to agenda, both settings, and picking an agenda suggestion loads its row. Same
// words as e2e/zoom.speaker-entry.spec.js. The agenda is read back from
// localStorage. The panel minimizes on START and CONTINUE; "Show control panel"
// brings it back.

const TT = 'Table Topics Speech';
const INSERT_KEY = 'toastmaster_speaker_insert_position';
const SEED = [
  { id: 'a', name: 'Ana', role: 'Standard Speech', rules: { green: 300, yellow: 360, red: 420, graceAfterRed: 30 }, completed: false },
  { id: 'b', name: 'Jordan', role: 'Ice Breaker', rules: { green: 240, yellow: 300, red: 360, graceAfterRed: 30 }, completed: false },
  { id: 'c', name: 'Cole', role: 'Standard Speech', rules: { green: 300, yellow: 360, red: 420, graceAfterRed: 30 }, completed: false },
];

async function openLiveTab(page) {
  await page.goto('/timer/app');
  await expect(page.getByRole('button', { name: /START/i })).toBeVisible();
  await page.evaluate((seed) => localStorage.setItem('toastmaster_agenda', JSON.stringify(seed)), SEED);
  await page.reload();
  await expect(page.getByRole('button', { name: /START/i })).toBeVisible();
}

const agenda = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('toastmaster_agenda') || '[]'));
const agendaNames = async (page) => (await agenda(page)).map((item) => item.name);
const nameField = (page) => page.getByPlaceholder('Type speaker name...');
const rolePicker = (page) => page.locator('select').first();
const body = (page) => page.locator('body');
const addPanelName = (page) =>
  page.getByRole('textbox').and(page.locator(':not([placeholder="Type speaker name..."])')).last();
const addPanelRole = (page) => page.locator('select').filter({ has: page.locator('option', { hasText: TT }) }).last();

async function pickSuggestion(page, name) {
  await nameField(page).click();
  await page.getByText(name, { exact: true }).first().click();
  await expect(nameField(page)).toHaveValue(name);
}

async function start(page) {
  await page.getByRole('button', { name: /START/i }).click();
  await page.getByTitle('Show control panel').click();
}

async function chooseSetting(page, pattern) {
  for (const role of ['radio', 'checkbox']) {
    const toggle = page.getByRole(role, { name: pattern });
    if (await toggle.count()) return toggle.first().check();
  }
  const select = page.locator('select').filter({ has: page.locator('option', { hasText: pattern }) });
  if (await select.count()) {
    const label = await select.first().locator('option', { hasText: pattern }).first().textContent();
    return select.first().selectOption({ label });
  }
  const button = page.getByRole('button', { name: pattern });
  await expect(button.first(), `a "Speaker options" setting matching ${pattern}`).toBeVisible();
  return button.first().click();
}

async function expectSettingChosen(page, pattern) {
  for (const role of ['radio', 'checkbox']) {
    const toggle = page.getByRole(role, { name: pattern });
    if (await toggle.count()) return expect(toggle.first()).toBeChecked();
  }
  const select = page.locator('select').filter({ has: page.locator('option', { hasText: pattern }) });
  if (await select.count()) {
    const value = await select.first().locator('option', { hasText: pattern }).first().getAttribute('value');
    return expect(select.first()).toHaveValue(value);
  }
  return expect(page.getByRole('button', { name: pattern }).first()).toHaveAttribute('aria-pressed', 'true');
}

test.describe('web: on-the-spot speakers (#168)', () => {
  test('AC-12, AC-1, AC-5, AC-7, AC-10: a picked suggestion loads its row, and a speaker added from the panel goes after it', async ({ page }) => {
    await openLiveTab(page);
    await expect(body(page)).toContainText('Not on the agenda');
    await pickSuggestion(page, 'Jordan');
    await expect(body(page)).toContainText(/On the agenda\s*·\s*2 of 3/);

    await page.getByRole('button', { name: /Add a speaker after Jordan/ }).click();
    await expect(addPanelRole(page)).toHaveValue('Ice Breaker');
    await addPanelRole(page).selectOption(TT);
    await addPanelName(page).fill('Dana');
    await expect(rolePicker(page)).toHaveValue('Ice Breaker');
    const add = page.getByRole('button', { name: /Add Dana after Jordan/ });
    await expect(add).toContainText('as Table Topics Speech');
    await add.click();

    await expect.poll(() => agendaNames(page)).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
    await expect(nameField(page)).toHaveValue('Dana');
    await expect(page.getByText('Timing rules: Green: 1 minute, Yellow: 1 min 30 sec, Red: 2 minutes')).toBeVisible();
  });

  test('AC-6, AC-8, AC-9: edits wait for Update (or Enter); Undo changes saves nothing', async ({ page }) => {
    await openLiveTab(page);
    await pickSuggestion(page, 'Jordan');

    await rolePicker(page).selectOption(TT);
    await nameField(page).fill('Dana');
    await expect(body(page)).toContainText('Unsaved changes');
    await expect(body(page)).toContainText('name Jordan → Dana · role → Table Topics Speech');
    expect((await agenda(page))[1]).toMatchObject({ name: 'Jordan', role: 'Ice Breaker' });

    await nameField(page).press('Enter');
    await expect.poll(async () => (await agenda(page))[1]).toMatchObject({ id: 'b', name: 'Dana', role: TT });

    await nameField(page).fill('Dane');
    await page.getByRole('button', { name: /Undo changes/ }).click();
    await expect(nameField(page)).toHaveValue('Dana');
    expect((await agenda(page))[1]).toMatchObject({ name: 'Dana' });
  });

  test('AC-13, AC-14: adding mid-speech waits for FINISH; quick timing reports a guest without touching the agenda', async ({ page }) => {
    await openLiveTab(page);
    await pickSuggestion(page, 'Jordan');
    await start(page);
    await page.waitForTimeout(1200);

    await expect(page.getByRole('button', { name: /Add a speaker after Jordan/ })).toBeVisible();
    await page.getByRole('button', { name: /Add a speaker after Jordan/ }).click();
    await addPanelName(page).fill('Dana');
    await page.getByRole('button', { name: /Add Dana after Jordan/ }).click();
    await expect.poll(() => agendaNames(page)).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
    await expect(nameField(page)).toHaveValue('Jordan');
    await expect(page.getByRole('button', { name: /STOP/i })).toBeVisible();

    await page.getByRole('button', { name: /FINISH/i }).click();
    await expect(nameField(page)).toHaveValue('Dana');

    await page.getByRole('button', { name: /Switch to quick timing/ }).click();
    await expect(body(page)).toContainText('Not on the agenda');
    await nameField(page).fill('Guest');
    await start(page);
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: /FINISH/i }).click();

    const rows = await agenda(page);
    expect(rows.map((item) => item.name)).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
    expect(rows.find((item) => item.name === 'Dana').completed).toBe(false);
    await page.getByRole('button', { name: /REPORT/i }).click();
    await expect(page.getByText('Guest')).toBeVisible();
  });

  test('AC-2, AC-4: "Speaker options" → at the end survives a reload, and the next add goes last', async ({ page }) => {
    await openLiveTab(page);
    await expect(page.getByText(/Speaker options/i)).toBeVisible();
    await page.getByText(/Speaker options/i).click();
    await chooseSetting(page, /at the end/i);
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), INSERT_KEY)).toBe('end');

    await page.reload();
    await page.getByText(/Speaker options/i).click();
    await expectSettingChosen(page, /at the end/i);

    await pickSuggestion(page, 'Jordan');
    await page.getByRole('button', { name: /Add a speaker/ }).click();
    await addPanelName(page).fill('Dana');
    await page.getByRole('button', { name: /Add Dana/ }).click();
    await expect.poll(() => agendaNames(page)).toEqual(['Ana', 'Jordan', 'Cole', 'Dana']);
  });
});
