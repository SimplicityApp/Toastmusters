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
  await page.getByRole('button', { name: "Who's speaking? Not on the agenda. Pick a speaker" }).click();
  // With nobody loaded the name labels the timer as it is typed (#168).
  await page.getByRole('textbox', { name: 'Type a name, or pick one' }).fill('Priya');
  await expect(page.getByRole('button', { name: 'Speaker: Priya. Not on the agenda. Change speaker' })).toBeVisible();
  await page.keyboard.press('Escape');

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

// 2026-11-16 Zoom run (NL-04): with the chip at the bottom right, the card's
// status line covered − / +, and the eye hung outside the panel. Playwright's
// click fails on a covered button, so a plain click proves the fix.
test('at the bottom right of the preview the chip\'s buttons still take clicks and stay in the panel', async ({ page }) => {
  await openPanel(page);
  const chip = page.getByRole('button', { name: 'Drag to place the count-up participants see on your video' });
  const preview = await page.getByTestId('video-preview').boundingBox();
  const start = await chip.boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(preview.x + preview.width * 0.85, preview.y + preview.height * 0.85, { steps: 5 });
  await page.mouse.up();

  const scale = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem('toastmaster_overlay_time_readout') || '{}').scale ?? null);
  const before = await scale();
  await chip.hover();
  await page.getByRole('button', { name: 'Make the count-up larger' }).click();
  await expect.poll(scale).not.toBe(before);

  const eye = await page.getByRole('button', { name: 'Hide the count-up from your video' }).boundingBox();
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  expect(eye.x + eye.width).toBeLessThanOrEqual(width);

  // 2026-11-17 Zoom rerun: the status line's text showed through the chip's
  // translucent buttons there. They are near-opaque now.
  const alpha = await page
    .getByRole('button', { name: 'Make the count-up larger' })
    .evaluate((el) => {
      const match = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/);
      const parts = match ? match[1].split(/[ ,/]+/).filter(Boolean) : [];
      return parts.length === 4 ? Number(parts[3]) : 1;
    });
  expect(alpha).toBeGreaterThanOrEqual(0.85);
});

// 2026-11-17 Zoom run: dropped at the preview's right edge, the chip hung off
// the panel. The video keeps the count-up inside the frame; so does the preview.
test('the count-up chip stays inside the preview when dropped past its edge', async ({ page }) => {
  await openPanel(page, { width: 340 });
  const chip = page.getByRole('button', { name: 'Drag to place the count-up participants see on your video' });
  const preview = page.getByTestId('video-preview');
  const frame = await preview.boundingBox();
  const start = await chip.boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width + 30, frame.y - 30, { steps: 5 });
  await page.mouse.up();
  await page.mouse.move(1, 1);
  const box = await chip.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
  expect(box.y).toBeGreaterThanOrEqual(frame.y - 0.5);
});

// A club device with Pro released, so the club's badge is on the preview.
const CLUB = {
  clubToken: 'club-token',
  // Fresh, so the app does not refresh the club against the (unmocked) server.
  lastRefreshAt: Date.now(),
  ver: 1,
  club: { id: 'club-1', name: 'Claude Test Club' },
  kit: { name: 'Claude Test Club', logoUrl: null, primaryColor: '#0f766e', showOnCards: true, showOnReports: true },
  presets: null,
  badge: { x: 0.8, y: 0.12, scale: 0.12 },
  timezone: null,
  role: 'admin',
  plan: 'pro',
  entitled: true,
  status: 'active',
  currentPeriodEnd: Date.now() + 200 * 24 * 60 * 60 * 1000,
  cancelAtPeriodEnd: false,
  source: 'club',
};

// 2026-11-17 Zoom rerun (NL-10): dragged to the far left, the badge ran past
// the preview and the card; at its top-right spot the club's name was cut to
// "Claude Test …". The video keeps it inside the frame, whole.
test('the club badge stays inside the preview, with its whole name, at either edge', async ({ page }) => {
  await page.addInitScript((club) => {
    if (sessionStorage.getItem('e2e_seeded')) return;
    sessionStorage.setItem('e2e_seeded', '1');
    localStorage.setItem('toastmaster_club', JSON.stringify(club));
  }, CLUB);
  // 340px: about the width Zoom's side panel gives the app.
  await openPanel(page, {
    width: 340,
    flags: { new_look: true, pro: true, sounds: true },
    entitlement: { plan: 'pro', status: 'active', entitled: true, source: 'club' },
  });
  const handle = page.getByRole('button', { name: "Drag to place your club's badge on your video" });
  const anchor = handle.locator('..');
  await expect(anchor).toBeVisible();
  const whole = () => anchor.getByText('Claude Test Club').evaluate((el) => el.scrollWidth <= el.clientWidth);
  const inside = async () => {
    const [box, frame] = await Promise.all([anchor.boundingBox(), page.getByTestId('video-preview').boundingBox()]);
    return (
      box.x >= frame.x - 0.5 &&
      box.y >= frame.y - 0.5 &&
      box.x + box.width <= frame.x + frame.width + 0.5 &&
      box.y + box.height <= frame.y + frame.height + 0.5
    );
  };
  expect(await whole()).toBe(true);
  expect(await inside()).toBe(true);

  const frame = await page.getByTestId('video-preview').boundingBox();
  for (const [fx, fy] of [[0.99, 0.01], [0.01, 0.99]]) {
    const from = await handle.boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(frame.x + frame.width * fx, frame.y + frame.height * fy, { steps: 5 });
    await page.mouse.up();
    await page.mouse.move(1, 1);
    expect(await whole(), `name whole at ${fx}, ${fy}`).toBe(true);
    expect(await inside(), `inside the preview at ${fx}, ${fy}`).toBe(true);
  }
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
  await expect(page.getByRole('button', { name: 'Speaker: Ana. On the agenda · 1 of 2. Change speaker' })).toBeVisible();
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
  // The Save footer reaches the sheet's bottom edge: no role row shows under it.
  const footer = sheet.getByRole('button', { name: 'Save' }).locator('..');
  const [footerBox, sheetBox] = await Promise.all([footer.boundingBox(), sheet.boundingBox()]);
  expect(Math.abs(footerBox.y + footerBox.height - (sheetBox.y + sheetBox.height))).toBeLessThanOrEqual(1);
  await sheet.getByRole('button', { name: /^Ice Breaker/ }).click();
  await sheet.getByLabel('Green').fill('3:30');
  await sheet.getByLabel('Green').blur();
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toHaveCount(0);
  await tab(page, 'Timer').click();
  await page.getByRole('button', { name: /Timing role/ }).click();
  await expect(page.getByRole('option', { name: /Ice Breaker/ })).toContainText('3:30 · 5:00 · 6:00');
});

// ── Phase 3: Pro, notices, stage ─────────────────────────────────────────

test('the top note says the new look is here, while Pro is still coming', async ({ page }) => {
  await openPanel(page);
  await expect(page.getByText('New look:')).toBeVisible();
  await expect(page.getByText('Coming soon:')).toHaveCount(0);
});

test('the Pro chip opens Upgrade as a sheet once Pro is released', async ({ page }) => {
  await openPanel(page, { flags: { new_look: true, pro: true, sounds: true } });
  await page.getByRole('button', { name: 'Upgrade to Pro' }).click();
  const sheet = page.getByRole('dialog', { name: 'One Pro account for your whole club' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Already on Pro through your club?')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
});

test('the full-screen timer opens from its sheet and names the share', async ({ page }) => {
  await openPanel(page);
  await page.getByRole('button', { name: /^On your video/ }).click();
  await page.getByRole('radio', { name: /Full-screen timer/ }).click();
  const stage = page.getByTestId('timer-stage');
  await expect(stage).toBeVisible();
  await expect(stage.getByRole('button', { name: 'Share the timer to the meeting' })).toHaveText('Share to the meeting');
  await stage.getByRole('button', { name: 'Close the timer stage' }).click();
  await expect(stage).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'On your video: Timer only' })).toBeVisible();
});
