import { test, expect } from '@playwright/test';

// The footer's Pro button before and after the launch.
function session(page, flags, entitlement = { plan: 'free' }) {
  return page.route('**/api/zoom/session', (route) =>
    route.fulfill({ json: { identified: true, uid: 'e2e-pro-soon', entitlement, flags } })
  );
}

test('before the launch, the Pro button is locked and lists what is coming', async ({ page }) => {
  await session(page, { sounds: true, pro: false });
  await page.goto('/zoom/');

  const pro = page.getByRole('button', { name: 'Pro (coming soon)' });
  await expect(pro).toBeVisible();
  await expect(page.locator('footer').getByRole('button', { name: /upgrade to pro/i })).toHaveCount(0);

  // Pointing at it opens the list; moving away closes it.
  await pro.hover();
  const panel = page.getByRole('dialog', { name: 'Pro is coming soon' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Sounds: a chime at each colour, music for breaks');
  await expect(panel).toContainText("Your club's card sets on every club timer");
  await expect(panel).toContainText('Voting for Best Table Topics and Best Evaluator');
  await expect(panel).toContainText('And more');
  await page.mouse.move(5, 5);
  await expect(panel).toHaveCount(0);

  // A click keeps it open until a click elsewhere.
  await pro.click();
  await page.mouse.move(5, 5);
  await expect(panel).toBeVisible();
  await page.getByText('Timing Role').click();
  await expect(panel).toHaveCount(0);
});

test('once Pro is released, the Pro button is the real one again', async ({ page }) => {
  await session(page, { sounds: true, pro: true });
  await page.goto('/zoom/');
  // Scoped to the footer: the locked Sounds button's label also says "Upgrade to Pro".
  const footer = page.locator('footer');
  await expect(footer.getByRole('button', { name: /upgrade to pro/i })).toBeVisible();
  await expect(footer.getByRole('button', { name: 'Pro (coming soon)' })).toHaveCount(0);
});
