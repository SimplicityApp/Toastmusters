import { test, expect } from '@playwright/test';

// The club badge on the Full-Screen Timer stage is sized and placed against the
// 16:9 card the stage shows, as on the video, and never sits on the stage's
// controls. In the real Zoom client on 2026-11-16 the ~400px sidebar stage drew
// it against the whole tall panel instead: over half the panel wide, off the
// right edge, and across Screenshare and the pop-out button.
const CLUB = {
  clubToken: 'club-token',
  // Fresh, so the app does not refresh the club against the (unmocked) server.
  lastRefreshAt: Date.now(),
  ver: 1,
  club: { id: 'club-1', name: 'Claude Test Club' },
  kit: { name: 'Claude Test Club', logoUrl: null, primaryColor: '#772432', showOnCards: true, showOnReports: true },
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

async function openStageAsClubDevice(page) {
  await page.addInitScript((club) => {
    if (sessionStorage.getItem('e2e_seeded')) return;
    sessionStorage.setItem('e2e_seeded', '1');
    localStorage.setItem('toastmaster_club', JSON.stringify(club));
  }, CLUB);
  await page.route('**/api/zoom/session', (route) =>
    route.fulfill({
      json: {
        identified: true,
        uid: 'e2e-club',
        entitlement: { plan: 'pro', status: 'active', entitled: true, source: 'club' },
        flags: { sounds: true, pro: true },
      },
    })
  );
  await page.goto('/zoom/');
  await expect(page.getByRole('button', { name: /START/i })).toBeVisible();

  await page.getByRole('button', { name: /^Display mode:/ }).click();
  await page.getByRole('menuitemradio', { name: /Full-Screen Timer/ }).click();
  const stage = page.getByTestId('timer-stage');
  await expect(stage).toBeVisible();
  const badge = stage.getByTestId('club-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('Claude Test Club');
  return stage;
}

const overlaps = (a, b) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Every control on the stage the badge must stay off, by its accessible name. */
async function stageControls(stage) {
  const names = [
    'Close the timer stage',
    'Screenshare the timer',
    'Open in its own window',
    'Hide countdown',
    /START/,
    'Reset',
    'Choose a speaker from the agenda or the meeting',
  ];
  const boxes = [];
  for (const name of names) {
    const control = stage.getByRole('button', { name });
    if (await control.count()) boxes.push({ name: String(name), box: await control.first().boundingBox() });
  }
  boxes.push({ name: 'Speaker name', box: await stage.getByRole('textbox', { name: 'Speaker name', exact: true }).boundingBox() });
  return boxes;
}

async function expectClearOfControls(stage, badgeBox) {
  const controls = await stageControls(stage);
  expect(controls.map((c) => c.name)).toEqual(expect.arrayContaining(['Screenshare the timer', '/START/']));
  for (const { name, box } of controls) {
    expect(overlaps(badgeBox, box), `badge overlaps ${name}`).toBe(false);
  }
}

test.describe('on the narrow sidebar panel', () => {
  test.use({ viewport: { width: 400, height: 800 } });

  test('the badge is sized against the 16:9 card, stays on it, and clears the controls', async ({ page }) => {
    const stage = await openStageAsClubDevice(page);

    // The card band the artwork is contained in: the full width, 9/16 of it high.
    const band = await stage.getByTestId('stage-card-band').boundingBox();
    expect(band.width).toBeCloseTo(400, 0);
    expect(band.height).toBeCloseTo(225, 0);
    expect(band.y).toBeCloseTo((800 - 225) / 2, 0);

    const badge = await stage.getByTestId('club-badge').boundingBox();
    // 12% of the card's height, as on the video (it was 12% of the 800px panel: 96px).
    expect(badge.height).toBeGreaterThan(25);
    expect(badge.height).toBeLessThan(29);
    // Never past the 44% ceiling, and inside the card, so never off the panel.
    expect(badge.width).toBeLessThanOrEqual(0.44 * band.width + 1);
    expect(badge.x).toBeGreaterThanOrEqual(band.x);
    expect(badge.x + badge.width).toBeLessThanOrEqual(band.x + band.width);
    expect(badge.y).toBeGreaterThanOrEqual(band.y);
    expect(badge.y + badge.height).toBeLessThanOrEqual(band.y + band.height);
    // Top right of the card, as the default placement is on the video.
    expect(badge.x + badge.width / 2).toBeCloseTo(0.8 * band.width, -1);

    await expectClearOfControls(stage, badge);
  });
});

test.describe('in a wide popped-out window', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('the badge keeps the video\'s size but moves out from under the controls', async ({ page }) => {
    const stage = await openStageAsClubDevice(page);

    const band = await stage.getByTestId('stage-card-band').boundingBox();
    expect(band.width).toBeCloseTo(1280, 0);
    expect(band.height).toBeCloseTo(720, 0);

    const badge = await stage.getByTestId('club-badge').boundingBox();
    // 12% of 720px, as on the video.
    expect(badge.height).toBeGreaterThan(84);
    expect(badge.height).toBeLessThan(88);
    expect(badge.x + badge.width).toBeLessThanOrEqual(1280);

    await expectClearOfControls(stage, badge);
  });
});
