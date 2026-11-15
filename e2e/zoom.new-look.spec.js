import { test, expect } from '@playwright/test';

// Design B, the redesigned panel (plan 13), behind the new_look flag. Plain
// browser, Zoom SDK absent: what is proven here is the layout and the flow,
// not the video (that is e2e/zoom-client/new-look.md).

const PRODUCTION_TODAY = { new_look: true, pro: false, sounds: true };

function session(page, flags, entitlement = { plan: 'free' }) {
  return page.route('**/api/zoom/session', (route) =>
    route.fulfill({ json: { identified: true, uid: 'e2e-new-look', entitlement, flags } })
  );
}

async function openPanel(page, { flags = PRODUCTION_TODAY, width = 400, entitlement } = {}) {
  await page.setViewportSize({ width, height: 860 });
  await session(page, flags, entitlement);
  await page.goto('/zoom/');
  await expect(page.getByTestId('timer-card')).toBeVisible();
}

const noSidewaysScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('with new_look off, the panel is the one shipped today', async ({ page }) => {
  await session(page, { new_look: false, pro: false, sounds: true });
  await page.goto('/zoom/');
  await expect(page.getByRole('button', { name: 'START' })).toBeVisible();
  await expect(page.locator('footer')).toBeVisible();
  await expect(page.getByTestId('timer-card')).toHaveCount(0);
});

for (const width of [360, 400]) {
  test(`fits ${width}px: one top row, no footer, nothing scrolls sideways`, async ({ page }) => {
    await openPanel(page, { width });
    const nav = page.getByRole('navigation', { name: 'Sections' });
    await expect(nav.getByRole('button')).toHaveText(['Agenda', 'Timer', 'Report']);
    await expect(page.getByRole('button', { name: 'Pro (coming soon)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'More' })).toBeVisible();
    await expect(page.locator('footer')).toHaveCount(0);

    // The switch, the chip and the menu share one line.
    const boxes = await Promise.all([
      nav.boundingBox(),
      page.getByRole('button', { name: 'Pro (coming soon)' }).boundingBox(),
      page.getByRole('button', { name: 'More' }).boundingBox(),
    ]);
    const tops = boxes.map((box) => Math.round(box.y + box.height / 2));
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(2);
    expect(await noSidewaysScroll(page)).toBe(true);

    // Start sits high: above the fold of a short laptop panel.
    const start = await page.getByRole('button', { name: 'Start' }).boundingBox();
    expect(start.y + start.height).toBeLessThan(560);
  });
}

test('a speech from start to finish lands in the report', async ({ page }) => {
  await openPanel(page);
  await page.getByRole('button', { name: "Who's speaking? Pick a speaker" }).click();
  await page.getByRole('textbox', { name: 'Type a name, or pick one' }).fill('Priya');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Speaker: Priya. Change speaker' })).toBeVisible();

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(page.getByTestId('timer-display')).not.toHaveText('00:00', { timeout: 4000 });
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Report' }).click();
  await expect(page.getByText('Priya').first()).toBeVisible();
});

test('the role list shows thresholds and changes the rules line', async ({ page }) => {
  await openPanel(page);
  await page.getByRole('button', { name: /Timing role/ }).click();
  const list = page.getByRole('listbox', { name: 'Timing role' });
  await expect(list.getByRole('option', { name: /Ice Breaker/ })).toContainText('4:00 · 5:00 · 6:00');
  await list.getByRole('option', { name: /Ice Breaker/ }).click();
  await expect(page.getByText('Green 4:00 · Yellow 5:00 · Red 6:00')).toBeVisible();
});

test('each Look & sound row opens only its own sheet', async ({ page }) => {
  await openPanel(page);
  for (const [row, title] of [
    ['On your video', 'On your video'],
    ['Cards', 'Cards'],
    ['Sounds', 'Sounds'],
    ['Between speeches', 'Between speeches'],
  ]) {
    await page.getByRole('button', { name: new RegExp(`^${row}`) }).click();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(page.getByRole('dialog', { name: title })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  // Sounds stay locked with the pre-launch line while pro is off.
  await page.getByRole('button', { name: /^Sounds/ }).click();
  await expect(page.getByRole('dialog', { name: 'Sounds' })).toContainText('Hold tight! Sounds are coming soon.');
});

test('the count-up chip hides its controls until pointed at', async ({ page }) => {
  await openPanel(page);
  // The fade sits on the cluster that holds − / + / eye.
  const controls = page.getByRole('button', { name: 'Make the count-up larger' }).locator('..');
  await page.mouse.move(5, 5);
  await expect(controls).toHaveCSS('opacity', '0');
  await page.getByRole('button', { name: 'Drag to place the count-up participants see on your video' }).hover();
  await expect(controls).toHaveCSS('opacity', '1');
});

test('the ⋯ menu holds the footer\'s old buttons, and Pro once it is released', async ({ page }) => {
  await openPanel(page, { flags: { new_look: true, pro: true, sounds: true } });
  await expect(page.getByRole('button', { name: 'Upgrade to Pro' })).toBeVisible();
  await page.getByRole('button', { name: 'More' }).click();
  const menu = page.getByRole('menu', { name: 'More' });
  await expect(menu).toContainText('Your plan');
  for (const item of ['Join my club with a code', 'Roles & timing rules', 'Clear the timer from my video', 'How-to videos', 'Send feedback', 'Rate the app']) {
    await expect(menu.getByRole('menuitem', { name: item })).toBeVisible();
  }
  await menu.getByRole('menuitem', { name: 'Send feedback' }).click();
  await expect(menu).toHaveCount(0);
});

// ── Phase 2: Agenda, Report, Roles & timing rules ─────────────────────────

const tab = (page, name) => page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name });

test('agenda: paste one per line, pick the missing role, then time from the agenda', async ({ page }) => {
  await openPanel(page);
  await tab(page, 'Agenda').click();
  await expect(page.getByText('No speakers yet')).toBeVisible();
  await page.getByRole('button', { name: 'Paste from EasySpeak' }).click();
  await page.getByRole('tab', { name: 'One per line' }).click();
  await page.getByRole('textbox', { name: 'One speaker per line' }).fill('Ana (Ice Breaker)\nAlex (Table Topics Master)');
  await expect(page.getByText('Found 2 speakers.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Add 2 speakers' }).click();

  const list = page.getByRole('list', { name: 'Agenda' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByText('1 row needs a role', { exact: false })).toBeVisible();
  // A row that needs a role is not loaded onto the timer.
  await page.getByRole('button', { name: 'Alex: pick a role first' }).click();
  await expect(page.getByTestId('timer-card')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Pick a role for Alex' }).selectOption('Table Topics Speech');
  await expect(page.getByText('1 row needs a role', { exact: false })).toHaveCount(0);

  await page.getByRole('button', { name: 'Put Ana on the timer' }).click();
  await expect(page.getByRole('button', { name: 'Speaker: Ana. Change speaker' })).toBeVisible();
  await expect(page.getByTestId('up-next')).toContainText('Alex');
});

test('agenda: an EasySpeak paste fills the agenda', async ({ page }) => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(new URL('../demo-agenda-easyspeak.txt', import.meta.url), 'utf8');
  await openPanel(page);
  await tab(page, 'Agenda').click();
  await page.getByRole('button', { name: 'Paste from EasySpeak' }).click();
  await page.getByRole('textbox', { name: 'EasySpeak agenda' }).fill(text);
  await expect(page.getByText(/Found \d+ speakers?\./)).toBeVisible();
  await page.getByRole('button', { name: /^Add \d+ speakers?$/ }).click();
  expect(await page.getByRole('list', { name: 'Agenda' }).getByRole('listitem').count()).toBeGreaterThan(2);
  expect(await noSidewaysScroll(page)).toBe(true);
});

test('report: empty, then a speech to copy; the rules sheet edits a role', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openPanel(page);
  await tab(page, 'Report').click();
  await expect(page.getByText('No speeches timed yet')).toBeVisible();
  await page.getByRole('button', { name: 'Go to the timer' }).click();

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('timer-display')).not.toHaveText('00:00', { timeout: 4000 });
  await page.getByRole('button', { name: 'Finish' }).click();
  await tab(page, 'Report').click();
  await expect(page.getByRole('list', { name: 'Speeches timed' }).getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Copy report' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();

  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Roles & timing rules' }).click();
  const sheet = page.getByRole('dialog', { name: 'Roles & timing rules' });
  await sheet.getByRole('button', { name: /^Ice Breaker/ }).click();
  await sheet.getByLabel('Green').fill('3:30');
  await sheet.getByLabel('Green').blur();
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toHaveCount(0);
  await tab(page, 'Timer').click();
  await page.getByRole('button', { name: /Timing role/ }).click();
  await expect(page.getByRole('option', { name: /Ice Breaker/ })).toContainText('3:30 · 5:00 · 6:00');
});
