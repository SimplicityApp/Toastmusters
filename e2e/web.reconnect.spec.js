import { test, expect } from '@playwright/test';

// The re-auth landing (GitHub issue #96) in a plain browser.
//
// This runs on the Vite dev server, with no Worker in front of it, so neither
// redirect happens here: the Worker's answer to /oauth/redirect?code=… (a 302
// to ?welcome=back|new that sets tt_approved) is proven in
// worker/routing.test.js and worker/reconnect.test.js. These tests open the
// URLs the Worker redirects to and check the page each one shows.

test.describe('install landing', () => {
  test('?welcome=back shows "You\'re reconnected" with a way back into Zoom', async ({ page }) => {
    await page.goto('/oauth/redirect?welcome=back');

    await expect(page.getByRole('heading', { name: "You're reconnected" })).toBeVisible();
    await expect(page.getByText('Your agendas, roles and reports are exactly where you left them.')).toBeVisible();

    const openInZoom = page.getByRole('link', { name: 'Open in Zoom' });
    await expect(openInZoom).toBeVisible();
    await expect(openInZoom).toHaveAttribute('href', /^https:\/\/marketplace\.zoom\.us\/zoomapp\/[^/]+\/context\/meeting\/target\/launch\/deeplink$/);
    await expect(page.getByRole('link', { name: 'Open Zoom in browser' })).toHaveAttribute('href', 'https://app.zoom.us');

    // Someone reconnecting already knows the app.
    await expect(page.getByText('Zoom app installed successfully')).toHaveCount(0);
    await expect(page.getByText('Quick Demo: Using in Zoom')).toHaveCount(0);
  });

  test('?welcome=new shows the installed page with the demos', async ({ page }) => {
    await page.goto('/oauth/redirect?welcome=new');

    await expect(page.getByRole('heading', { name: 'Zoom app installed successfully' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Zoom app' })).toBeVisible();
    await expect(page.getByText('Quick Demo: Using in Zoom')).toBeVisible();
    await expect(page.getByText("You're reconnected")).toHaveCount(0);
  });
});
