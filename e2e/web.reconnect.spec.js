import { test, expect } from '@playwright/test';

// The re-auth landing (GitHub issue #96) in a plain browser.
//
// This runs on the Vite dev server, with no Worker in front of it, so neither
// redirect happens here: the Worker's answer to /oauth/redirect?code=… (a 302
// to ?welcome=back|new that sets tt_approved) is proven in
// worker/routing.test.js and worker/reconnect.test.js. These tests open the
// URLs the Worker redirects to and check the page each one shows, plus the
// reconnect page and the links between it and the homepage.

// The build's install screen, or the Marketplace listing when it has none.
const INSTALL_HREF = /^https:\/\/(zoom\.us\/oauth\/authorize\?|marketplace\.zoom\.us\/apps\/)/;
const DEEPLINK_HREF = /^https:\/\/marketplace\.zoom\.us\/zoomapp\/[^/]+\/context\/meeting\/target\/launch\/deeplink$/;

test.describe('reconnect page', () => {
  test('/reconnect explains why Zoom sent the user here and offers "Approve in Zoom"', async ({ page }) => {
    await page.goto('/reconnect');

    await expect(page.getByRole('heading', { level: 1, name: 'Reconnect Toastmusters Timer to Zoom' })).toBeVisible();
    await expect(page.getByText("If Zoom asked you to approve the app again, you're in the right place.", { exact: false })).toBeVisible();
    await expect(page.getByText('Your agendas, roles and reports are safe.')).toBeVisible();
    await expect(page.getByText('Why am I seeing this?', { exact: false })).toBeVisible();

    // Same tab: Zoom's approval screen comes back to "You're reconnected".
    const approve = page.getByRole('link', { name: 'Approve in Zoom' });
    await expect(approve).toBeVisible();
    await expect(approve).toHaveAttribute('href', INSTALL_HREF);
    await expect(approve).not.toHaveAttribute('target');

    await expect(page.getByRole('link', { name: 'Use the browser timer instead' })).toHaveAttribute('href', '/timer/app');
    await expect(page.getByRole('link', { name: 'Already approved? Open in Zoom' })).toHaveAttribute('href', DEEPLINK_HREF);

    // The homepage's static skeleton is cleared on every path but /, so it
    // never shows under the reconnect page.
    await expect(page.locator('.static-landing')).toHaveCount(0);
  });

  test('"Go to the homepage" goes to /?home and shows the homepage, also after a reload', async ({ page }) => {
    await page.goto('/reconnect');

    await page.getByRole('link', { name: 'Go to the homepage' }).click();

    await expect(page).toHaveURL(/\/\?home$/);
    await expect(page.getByRole('heading', { level: 1, name: /Toastmasters Timer – Free Online Speech Timer/ })).toBeVisible();

    await page.reload();
    await expect(page).toHaveURL(/\/\?home$/);
    await expect(page.getByRole('link', { name: 'Reconnect it' })).toBeVisible();
  });

  test('the homepage\'s "Already use the Zoom app? Reconnect it" opens the reconnect page', async ({ page }) => {
    await page.goto('/');

    const reconnect = page.getByRole('link', { name: 'Reconnect it' });
    await expect(reconnect).toBeVisible();
    await reconnect.click();

    await expect(page).toHaveURL(/\/reconnect$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Reconnect Toastmusters Timer to Zoom' })).toBeVisible();
  });
});

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
