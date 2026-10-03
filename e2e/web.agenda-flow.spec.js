import { test, expect } from '@playwright/test';

test('agenda add and load speakers', async ({ page }) => {
  await page.goto('/timer');

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
