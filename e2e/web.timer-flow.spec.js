import { test, expect } from '@playwright/test';

test('timer basic flow', async ({ page }) => {
  await page.goto('/timer/app');

  // Verify default role is "Standard Speech"
  const roleSelect = page.locator('select');
  await expect(roleSelect).toHaveValue('Standard Speech');

  // Type speaker name
  const nameInput = page.getByPlaceholder('Type speaker name...');
  await nameInput.fill('Test Speaker');

  // Start timer
  await page.getByRole('button', { name: /START/i }).click();

  // Panel auto-minimizes on START — restore it
  await page.getByTitle('Show control panel').click();

  // Wait for timer to begin counting
  await page.waitForTimeout(1500);

  // Verify timer is running (display should no longer read 00:00)
  await expect(page.getByText(/^\d{2}:\d{2}$/)).not.toHaveText('00:00');

  // Stop the timer
  await page.getByRole('button', { name: /STOP/i }).click();
  await expect(page.getByRole('button', { name: /CONTINUE/i })).toBeVisible();

  // Continue the timer
  await page.getByRole('button', { name: /CONTINUE/i }).click();
  await page.waitForTimeout(500);

  // Finish the speech
  await page.getByRole('button', { name: /FINISH/i }).click();

  // Navigate to the REPORT tab and verify the speaker name appears
  await page.getByRole('button', { name: /REPORT/i }).click();
  await expect(page.getByText('Test Speaker')).toBeVisible();
});
