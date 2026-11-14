import { test, expect } from '@playwright/test';
import { CARD_COLORS, DEFAULT_CARD_SETS } from '../packages/shared/cardImages.js';

// Card-switch latency for the Zoom overlay, per image set. A status switch
// (blue -> green -> yellow -> red) pushes a frame through
// loadImageAsImageData: fetch -> decode -> downscale to the 640x360 overlay
// ImageData. That is everything the app controls; what remains after it is
// the Zoom SDK bridge, which only exists inside the Zoom client.
//
// The numbers that matter:
//   - cold: decoded-frame cache empty (first show of a card, or right after
//     the set is changed)
//   - warm: cache hit — the cost of every switch after preload, and what
//     preloadBackgroundImages() buys at startup and on set change
const COLD_BUDGET_MS = 1500;
const WARM_BUDGET_MS = 25;

const SETTINGS_KEY = 'toastmaster_custom_card_images';

// The dev server serves the app's own modules; importing zoomSdk by URL
// yields the same live module instance the app runs on, so these calls
// exercise the real pipeline with the app's own caches and settings.
const SDK_MODULE = '/zoom/src/utils/zoomSdk.js';

function logAndAssert(setLabel, results) {
  for (const [color, { cold, warm }] of Object.entries(results)) {
    console.log(`${setLabel} — ${color}: cold ${cold.toFixed(1)}ms, warm ${warm.toFixed(1)}ms`);
    expect(cold, `${setLabel} ${color} cold pipeline ${cold.toFixed(1)}ms exceeded ${COLD_BUDGET_MS}ms`).toBeLessThan(COLD_BUDGET_MS);
    expect(warm, `${setLabel} ${color} cached pipeline ${warm.toFixed(1)}ms exceeded ${WARM_BUDGET_MS}ms`).toBeLessThan(WARM_BUDGET_MS);
  }
}

test.describe('Zoom App — Card Switch Performance @performance', () => {
  for (const set of DEFAULT_CARD_SETS) {
    test(`${set.label} set: overlay decode pipeline per card`, async ({ page }) => {
      await page.goto('/zoom/');
      await expect(page.getByTestId('timer-display')).toBeVisible();

      const results = await page.evaluate(
        async ({ SDK_MODULE, files, colors }) => {
          const sdk = await import(SDK_MODULE);
          // Startup preload may already have cached some of these; clear so
          // the first number is genuinely cold.
          sdk.notifyCardImagesChanged();
          const results = {};
          for (const color of colors) {
            const url = sdk.getCardFileUrl(files[color]);
            let t0 = performance.now();
            await sdk.loadImageAsImageData(url);
            const cold = performance.now() - t0;
            t0 = performance.now();
            await sdk.loadImageAsImageData(url);
            results[color] = { cold, warm: performance.now() - t0 };
          }
          return results;
        },
        { SDK_MODULE, files: set.files, colors: CARD_COLORS }
      );
      logAndAssert(set.label, results);
    });
  }

  test('Custom set: overlay decode pipeline per card', async ({ page }) => {
    // Seed a realistic custom set straight into the stores the app reads
    // (1280x720 JPEGs in IndexedDB, v3 metadata in localStorage), then open
    // the app so its own init loads it. Seed from a static page on the same
    // origin, before the app runs: its start-up sweep deletes stored images
    // that no set lists yet, so seeding under a running app races it.
    await page.goto('/zoom/robots.txt');
    await page.evaluate(async ({ SETTINGS_KEY }) => {
      const makeBlob = (hex, label) =>
        new Promise((resolve) => {
          const canvas = document.createElement('canvas');
          canvas.width = 1280;
          canvas.height = 720;
          const ctx = canvas.getContext('2d');
          const grad = ctx.createLinearGradient(0, 0, 1280, 720);
          grad.addColorStop(0, hex);
          grad.addColorStop(1, '#1c1c1c');
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, 1280, 720);
          for (let i = 0; i < 5000; i++) {
            ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.08})`;
            ctx.fillRect(Math.random() * 1280, Math.random() * 720, 3, 3);
          }
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 140px sans-serif';
          ctx.fillText(label, 80, 400);
          canvas.toBlob(resolve, 'image/jpeg', 0.85);
        });
      const hexes = { blue: '#1d4ed8', green: '#16a34a', yellow: '#eab308', red: '#dc2626' };
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('toastmaster-timer', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('card-images');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      for (const [color, hex] of Object.entries(hexes)) {
        const blob = await makeBlob(hex, color.toUpperCase());
        await new Promise((resolve, reject) => {
          const tx = db.transaction('card-images', 'readwrite');
          tx.objectStore('card-images').put(blob, `custom-1:${color}`);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      }
      db.close();
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          version: 3,
          selectedSetId: 'custom-1',
          customSets: [{ id: 'custom-1', colors: ['blue', 'green', 'yellow', 'red'] }],
        })
      );
    }, { SETTINGS_KEY });
    await page.goto('/zoom/');
    await expect(page.getByTestId('timer-display')).toBeVisible();

    const results = await page.evaluate(
      async ({ SDK_MODULE, colors }) => {
        const sdk = await import(SDK_MODULE);
        // Wait for the app's initCardImages to publish the blob URLs.
        for (let i = 0; i < 50 && !sdk.getBackgroundUrl('blue').startsWith('blob:'); i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!sdk.getBackgroundUrl('blue').startsWith('blob:')) {
          return { error: `custom set never resolved: ${sdk.getBackgroundUrl('blue')}` };
        }
        sdk.notifyCardImagesChanged();
        const results = {};
        for (const color of colors) {
          const url = sdk.getBackgroundUrl(color);
          let t0 = performance.now();
          await sdk.loadImageAsImageData(url);
          const cold = performance.now() - t0;
          t0 = performance.now();
          await sdk.loadImageAsImageData(url);
          results[color] = { cold, warm: performance.now() - t0 };
        }
        return results;
      },
      { SDK_MODULE, colors: CARD_COLORS }
    );

    expect(results.error, results.error).toBeUndefined();
    logAndAssert('Custom', results);
  });

  test('preloadBackgroundImages makes every switch a cache hit', async ({ page }) => {
    await page.goto('/zoom/');
    await expect(page.getByTestId('timer-display')).toBeVisible();

    const results = await page.evaluate(
      async ({ SDK_MODULE, colors }) => {
        const sdk = await import(SDK_MODULE);
        // What the modal does on a set change: drop every decoded frame,
        // then re-warm. Afterwards each card must push straight from cache.
        sdk.notifyCardImagesChanged();
        await sdk.preloadBackgroundImages();
        const results = {};
        for (const color of colors) {
          const t0 = performance.now();
          await sdk.loadImageAsImageData(sdk.getBackgroundUrl(color));
          results[color] = performance.now() - t0;
        }
        return results;
      },
      { SDK_MODULE, colors: CARD_COLORS }
    );

    for (const [color, ms] of Object.entries(results)) {
      console.log(`Preloaded — ${color}: ${ms.toFixed(1)}ms`);
      expect(ms, `${color} was not served from cache after preload: ${ms.toFixed(1)}ms`).toBeLessThan(WARM_BUDGET_MS);
    }
  });
});
