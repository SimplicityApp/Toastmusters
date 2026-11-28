import { test, expect } from '@playwright/test';

// #168, on-the-spot speakers, in the Zoom app's old look (new_look off): the Live
// tab panel and the Full-Screen Timer stage. Plain browser, Zoom SDK absent. The
// agenda is read back from localStorage, where the app keeps it.
//
// Words the plan fixes: a status dot "On the agenda · 2 of 3" / "Not on the
// agenda" / "Unsaved changes"; "Update Jordan on the agenda" listing "name Jordan
// → Dana · role → …" with "Undo changes"; "Add a speaker after Jordan" opening a
// panel whose button reads "Add Dana after Jordan" and names the role; "Switch to
// quick timing", "Back to agenda" (next: …), "Save Eve to the agenda"; a collapsed
// "Speaker options".

const OLD_LOOK = { new_look: false, pro: false, sounds: true };
const TT = 'Table Topics Speech';
const INSERT_KEY = 'toastmaster_speaker_insert_position';
const SEED = [
  { id: 'a', name: 'Ana', role: 'Standard Speech', rules: { green: 300, yellow: 360, red: 420, graceAfterRed: 30 }, completed: false },
  { id: 'b', name: 'Jordan', role: 'Ice Breaker', rules: { green: 240, yellow: 300, red: 360, graceAfterRed: 30 }, completed: false },
  { id: 'c', name: 'Cole', role: 'Standard Speech', rules: { green: 300, yellow: 360, red: 420, graceAfterRed: 30 }, completed: false },
];

async function openOldLook(page) {
  await page.route('**/api/zoom/session', (route) =>
    route.fulfill({ json: { identified: true, uid: 'e2e-speakers', entitlement: { plan: 'free' }, flags: OLD_LOOK } })
  );
  await page.goto('/zoom/');
  await expect(page.getByRole('button', { name: 'START' })).toBeVisible();
  await page.evaluate((seed) => localStorage.setItem('toastmaster_agenda', JSON.stringify(seed)), SEED);
  await page.reload();
  await expect(page.getByRole('button', { name: 'START' })).toBeVisible();
}

const agenda = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('toastmaster_agenda') || '[]'));
const agendaNames = async (page) => (await agenda(page)).map((item) => item.name);
const nameField = (page) => page.getByPlaceholder('Type speaker name...');
const rolePicker = (page) => page.locator('select').first();
const body = (page) => page.locator('body');

async function loadFromSuggestions(page, name) {
  await nameField(page).click();
  await page.getByText(name, { exact: true }).first().click();
  await expect(nameField(page)).toHaveValue(name);
}

/** The add panel's own name field: any text field but the panel's main one. */
const addPanelName = (page) =>
  page.getByRole('textbox').and(page.locator(':not([placeholder="Type speaker name..."])')).last();
/** The add panel's own role picker: the last select that lists the roles. */
const addPanelRole = (page) => page.locator('select').filter({ has: page.locator('option', { hasText: TT }) }).last();

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

test.describe('old look: on-the-spot speakers (#168)', () => {
  test('AC-1, AC-5, AC-7, AC-10: a speaker added from the panel goes after the loaded one, under the panel\'s role, and is loaded', async ({ page }) => {
    await openOldLook(page);
    await expect(body(page)).toContainText('Not on the agenda');
    await loadFromSuggestions(page, 'Jordan');
    await expect(body(page)).toContainText(/On the agenda\s*·\s*2 of 3/);
    await expect(page.getByRole('button', { name: /Switch to quick timing/ })).toBeVisible();
    await expect(body(page)).toContainText('Jordan stays on the agenda, not ticked off');

    await page.getByRole('button', { name: /Add a speaker after Jordan/ }).click();
    await expect(addPanelRole(page)).toHaveValue('Ice Breaker');
    await addPanelRole(page).selectOption(TT);
    await addPanelName(page).fill('Dana');
    await expect(rolePicker(page)).toHaveValue('Ice Breaker');
    await expect(nameField(page)).toHaveValue('Jordan');
    const add = page.getByRole('button', { name: /Add Dana after Jordan/ });
    await expect(add).toContainText('as Table Topics Speech');
    await add.click();

    await expect.poll(() => agendaNames(page)).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
    await expect(nameField(page)).toHaveValue('Dana');
    await expect(rolePicker(page)).toHaveValue(TT);
    await expect(page.getByText('Timing rules: Green: 1 minute, Yellow: 1 min 30 sec, Red: 2 minutes')).toBeVisible();
    await expect(body(page)).toContainText(/On the agenda\s*·\s*3 of 4/);
  });

  test('AC-6, AC-8, AC-9: name and role edits wait for Update (or Enter); Undo changes saves nothing', async ({ page }) => {
    await openOldLook(page);
    await loadFromSuggestions(page, 'Jordan');

    await rolePicker(page).selectOption(TT);
    await nameField(page).fill('Dana');
    await expect(body(page)).toContainText('Unsaved changes');
    await expect(body(page)).toContainText('name Jordan → Dana · role → Table Topics Speech');
    await expect(page.getByRole('button', { name: /Update Jordan on the agenda/ })).toBeVisible();
    expect((await agenda(page))[1]).toMatchObject({ name: 'Jordan', role: 'Ice Breaker' });

    await nameField(page).press('Enter');
    await expect.poll(async () => (await agenda(page))[1]).toMatchObject({ id: 'b', name: 'Dana', role: TT });
    await expect(body(page)).not.toContainText('Unsaved changes');

    await nameField(page).fill('Dane');
    await page.getByRole('button', { name: /Undo changes/ }).click();
    await expect(nameField(page)).toHaveValue('Dana');
    expect((await agenda(page))[1]).toMatchObject({ name: 'Dana' });
  });

  test('AC-13, AC-14, AC-16: adding mid-speech leaves the speech alone; quick timing reports a guest without touching the agenda', async ({ page }) => {
    await openOldLook(page);
    await loadFromSuggestions(page, 'Jordan');
    await page.getByRole('button', { name: 'START' }).click();
    await expect(page.getByTestId('timer-display')).not.toHaveText('00:00', { timeout: 4000 });

    await expect(page.getByRole('button', { name: /Add a speaker after Jordan/ })).toBeVisible();
    await page.getByRole('button', { name: /Add a speaker after Jordan/ }).click();
    await addPanelName(page).fill('Dana');
    await page.getByRole('button', { name: /Add Dana after Jordan/ }).click();
    await expect.poll(() => agendaNames(page)).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
    await expect(nameField(page)).toHaveValue('Jordan');
    await expect(page.getByRole('button', { name: /STOP/ })).toBeVisible();

    await page.getByRole('button', { name: 'FINISH' }).click();
    await expect(nameField(page)).toHaveValue('Dana');

    await page.getByRole('button', { name: /Switch to quick timing/ }).click();
    await expect(body(page)).toContainText('Not on the agenda');
    await expect(page.getByRole('button', { name: /Back to agenda/ })).toBeVisible();
    await expect(body(page)).toContainText('next: Dana');
    await nameField(page).fill('Guest');
    await page.getByRole('button', { name: 'START' }).click();
    await expect.poll(() => agendaNames(page)).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
    await expect(page.getByTestId('timer-display')).not.toHaveText('00:00', { timeout: 4000 });
    await page.getByRole('button', { name: 'FINISH' }).click();

    const rows = await agenda(page);
    expect(rows.map((item) => item.name)).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
    expect(rows.find((item) => item.name === 'Dana').completed).toBe(false);
    await page.getByRole('button', { name: /REPORT/i }).click();
    await expect(page.getByText('Guest')).toBeVisible();
  });

  test('AC-2, AC-3, AC-4, AC-15: "Speaker options" → at the end; a quick-timed name is saved last', async ({ page }) => {
    await openOldLook(page);
    await expect(page.getByText(/Speaker options/i)).toBeVisible();
    await page.getByText(/Speaker options/i).click();
    await chooseSetting(page, /at the end/i);
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), INSERT_KEY)).toBe('end');

    await loadFromSuggestions(page, 'Jordan');
    await page.getByRole('button', { name: /Add a speaker/ }).click();
    await addPanelName(page).fill('Dana');
    await page.getByRole('button', { name: /Add Dana/ }).click();
    await expect.poll(() => agendaNames(page)).toEqual(['Ana', 'Jordan', 'Cole', 'Dana']);

    await page.reload();
    await expect(body(page)).toContainText('Not on the agenda');
    await nameField(page).fill('Eve');
    await page.getByRole('button', { name: /Save Eve to the agenda/ }).click();
    await expect.poll(() => agendaNames(page)).toEqual(['Ana', 'Jordan', 'Cole', 'Dana', 'Eve']);
    await expect(body(page)).toContainText(/On the agenda\s*·\s*5 of 5/);
  });

  test('AC-5, AC-6, AC-7: on the Full-Screen Timer, a rename waits for Update and "+ Add" goes after the loaded speaker', async ({ page }) => {
    await openOldLook(page);
    await loadFromSuggestions(page, 'Jordan');
    await page.getByRole('button', { name: /^Display mode:/ }).click();
    await page.getByRole('menuitemradio', { name: /Full-Screen Timer/ }).click();
    const stage = page.getByTestId('timer-stage');
    await expect(stage).toBeVisible();
    await expect(stage).toContainText(/On the agenda\s*·\s*2 of 3/);

    await stage.getByRole('textbox').first().fill('Dana');
    await expect(stage).toContainText('Unsaved changes');
    expect(await agendaNames(page)).toEqual(['Ana', 'Jordan', 'Cole']);
    await stage.getByRole('button', { name: /Update Jordan on the agenda/ }).click();
    await expect.poll(() => agendaNames(page)).toEqual(['Ana', 'Dana', 'Cole']);

    await stage.getByRole('button', { name: /Add a speaker|^\W*Add$/ }).first().click();
    await stage.getByRole('textbox').last().fill('Eve');
    await stage.getByRole('button', { name: /Add Eve after Dana/ }).click();
    await expect.poll(() => agendaNames(page)).toEqual(['Ana', 'Dana', 'Eve', 'Cole']);
  });
});
