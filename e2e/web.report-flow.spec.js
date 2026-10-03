import { test, expect } from '@playwright/test';

test('report generation and clear', async ({ page }) => {
  await page.goto('/timer');

  const nameInput = page.getByPlaceholder('Type speaker name...');

  // Time Speaker 1's speech
  await nameInput.fill('Speaker 1');
  await page.getByRole('button', { name: /START/i }).click();
  await page.getByTitle('Show control panel').click();
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /FINISH/i }).click();

  // Wait for form to reset and START to reappear before filling next speaker
  await expect(page.getByRole('button', { name: /START/i })).toBeVisible();

  // Time Speaker 2's speech
  await nameInput.fill('Speaker 2');
  await page.getByRole('button', { name: /START/i }).click();
  await page.getByTitle('Show control panel').click();
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /FINISH/i }).click();

  // Navigate to REPORT tab and verify both speakers are listed
  await page.getByRole('button', { name: /REPORT/i }).click();
  await expect(page.getByText('Speaker 1')).toBeVisible();
  await expect(page.getByText('Speaker 2')).toBeVisible();

  // Initiate clear flow via the Clear button
  await page.getByRole('button', { name: /Clear/i }).click();

  // Confirm the clear in the modal
  await page.getByRole('button', { name: 'Clear All' }).click();

  // Verify the empty state is shown after clearing
  await expect(page.getByText('No reports yet')).toBeVisible();
});
