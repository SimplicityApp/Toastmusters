import { test, expect } from '@playwright/test';

// #168, on-the-spot speakers, in the Zoom app's new look (design B, new_look on).
// The timer card's speaker chip carries the status; its popover holds the name
// field, the actions, the add panel, the lists and, at its foot, "Speaker
// options". Same words as the old look (e2e/zoom.speaker-entry.spec.js). Plain
// browser, Zoom SDK absent; the agenda is read back from localStorage.

const NEW_LOOK = { new_look: true, pro: false, sounds: true };
const OLD_LOOK = { new_look: false, pro: false, sounds: true };
const TT = 'Table Topics Speech';
const INSERT_KEY = 'toastmaster_speaker_insert_position';
const SEED = [
  { id: 'a', name: 'Ana', role: 'Standard Speech', rules: { green: 300, yellow: 360, red: 420, graceAfterRed: 30 }, completed: false },
  { id: 'b', name: 'Jordan', role: 'Ice Breaker', rules: { green: 240, yellow: 300, red: 360, graceAfterRed: 30 }, completed: false },
  { id: 'c', name: 'Cole', role: 'Standard Speech', rules: { green: 300, yellow: 360, red: 420, graceAfterRed: 30 }, completed: false },
];

function session(page, flags) {
  return page.route('**/api/zoom/session', (route) =>
    route.fulfill({ json: { identified: true, uid: 'e2e-new-look-speakers', entitlement: { plan: 'free' }, flags } })
  );
}

async function openNewLook(page) {
  await page.setViewportSize({ width: 400, height: 860 });
  await session(page, NEW_LOOK);
  await page.goto('/zoom/');
  await expect(page.getByTestId('timer-card')).toBeVisible();
  await page.evaluate((seed) => localStorage.setItem('toastmaster_agenda', JSON.stringify(seed)), SEED);
  await page.reload();
  await expect(page.getByTestId('timer-card')).toBeVisible();
}

const agenda = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('toastmaster_agenda') || '[]'));
const agendaNames = async (page) => (await agenda(page)).map((item) => item.name);
const tab = (page, name) => page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name });
const body = (page) => page.locator('body');
const chip = (page) => page.getByTestId('timer-card').getByRole('button', { name: /speak|who/i }).first();

/** Loads Jordan from the Agenda tab, which is unchanged by #168. */
async function loadJordan(page) {
  await tab(page, 'Agenda').click();
  await page.getByRole('button', { name: 'Put Jordan on the timer' }).click();
  await expect(page.getByTestId('timer-card')).toBeVisible();
}

async function openPopover(page) {
  if ((await chip(page).getAttribute('aria-expanded')) !== 'true') await chip(page).click();
  return page.getByRole('textbox').first();
}

/** The card's role chip, with the add panel closed (the only "Timing role" button then). */
async function chooseCardRole(page, role) {
  await page.getByTestId('timer-card').getByRole('button', { name: /^Timing role/ }).first().click();
  await page.getByRole('option', { name: new RegExp(`^${role}`) }).first().click();
}

/**
 * The add panel's own role: a select, or a role button like the card's, found in
 * the nearest container of the panel's name field that holds one.
 */
async function chooseAddPanelRole(page, role) {
  const panel = page
    .getByRole('textbox')
    .last()
    .locator('xpath=ancestor::*[.//select or .//button[contains(translate(@aria-label, "ROLE", "role"), "role")]][1]');
  const select = panel.locator('select');
  if (await select.count()) return select.first().selectOption(role);
  await panel.getByRole('button', { name: /role/i }).first().click();
  return page.getByRole('option', { name: new RegExp(`^${role}`) }).first().click();
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

test.describe('new look: on-the-spot speakers (#168)', () => {
  test('AC-1, AC-5, AC-7, AC-10: the popover\'s add panel puts a speaker after the loaded one, under its own role, and loads them', async ({ page }) => {
    await openNewLook(page);
    await loadJordan(page);
    await openPopover(page);
    await expect(body(page)).toContainText(/On the agenda\s*·\s*2 of 3/);
    await expect(page.getByRole('button', { name: /Switch to quick timing/ })).toBeVisible();

    await page.getByRole('button', { name: /Add a speaker after Jordan/ }).click();
    await page.getByRole('textbox').last().fill('Dana');
    await chooseAddPanelRole(page, TT);
    const add = page.getByRole('button', { name: /Add Dana after Jordan/ });
    await expect(add).toContainText('as Table Topics Speech');
    await add.click();

    await expect.poll(() => agendaNames(page)).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
    await expect(chip(page)).toHaveAccessibleName(/Dana/);
    await expect(page.getByText('Green 1:00 · Yellow 1:30 · Red 2:00')).toBeVisible();
  });

  test('AC-6, AC-8, AC-9: the role chip and the name field stage edits; Enter writes both to the row', async ({ page }) => {
    await openNewLook(page);
    await loadJordan(page);

    await chooseCardRole(page, TT);
    const field = await openPopover(page);
    await expect(field).toHaveValue('Jordan');
    await field.fill('Dana');
    await expect(body(page)).toContainText('Unsaved changes');
    await expect(body(page)).toContainText('name Jordan → Dana · role → Table Topics Speech');
    expect((await agenda(page))[1]).toMatchObject({ name: 'Jordan', role: 'Ice Breaker' });

    await field.press('Enter');
    await expect.poll(async () => (await agenda(page))[1]).toMatchObject({ id: 'b', name: 'Dana', role: TT });
    await expect(chip(page)).toHaveAccessibleName(/Dana/);
  });

  test('AC-14, AC-15: quick timing lets go of the row; a quick-timed name is saved after it', async ({ page }) => {
    await openNewLook(page);
    await loadJordan(page);
    await openPopover(page);

    await expect(page.getByRole('button', { name: /Switch to quick timing/ })).toBeVisible();
    await page.getByRole('button', { name: /Switch to quick timing/ }).click();
    await openPopover(page);
    await expect(body(page)).toContainText('Not on the agenda');
    await expect(page.getByRole('button', { name: /Back to agenda/ })).toBeVisible();
    await expect(body(page)).toContainText('next: Jordan, Ice Breaker');

    const field = await openPopover(page);
    await field.fill('Eve');
    await page.getByRole('button', { name: /Save Eve to the agenda/ }).click();
    await expect.poll(() => agendaNames(page)).toEqual(['Ana', 'Jordan', 'Eve', 'Cole']);
  });

  test('AC-4: a setting chosen in the new look shows the same in the old look', async ({ page }) => {
    await openNewLook(page);
    await openPopover(page);
    await expect(page.getByText(/Speaker options/i)).toBeVisible();
    await page.getByText(/Speaker options/i).click();
    await chooseSetting(page, /at the end/i);
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), INSERT_KEY)).toBe('end');

    await page.unroute('**/api/zoom/session');
    await session(page, OLD_LOOK);
    await page.reload();
    await expect(page.getByRole('button', { name: 'START' })).toBeVisible();
    await page.getByText(/Speaker options/i).click();
    await expectSettingChosen(page, /at the end/i);
  });
});
