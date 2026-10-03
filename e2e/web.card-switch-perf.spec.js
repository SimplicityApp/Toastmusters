import { test, expect } from '@playwright/test';
import { CARD_COLORS, DEFAULT_CARD_SETS, CARD_ASSET_VERSION } from '../packages/shared/cardImages.js';

// Card-switch latency for the web timer, per image set. The timer switches
// blue -> green -> yellow -> red by swapping a CSS background image, so the
// user-visible delay is the image fetch + decode:
//   - cold: first time a card is shown, nothing cached (worst case)
//   - warm: fetch and decode caches primed (every switch after preload)
//
// Budgets are deliberately loose — this guards against regressions like an
// oversized asset or a broken preload, not micro-variance between runs.
const COLD_BUDGET_MS = 750;
const WARM_BUDGET_MS = 50;

const SETTINGS_KEY = 'toastmaster_custom_card_images';

/**
 * Measure fetch+decode per color in the page. `bust` appends a unique query
 * so the browser treats the first decode as fully cold even if the app (or a
 * previous test) already touched the asset; the second decode of the same
 * URL is the warm number.
 */
function measureDecodes(page, urlsByColor, bust) {
  return page.evaluate(async ({ urlsByColor, bust }) => {
    const decodeOnce = async (url) => {
      const img = new Image();
      const t0 = performance.now();
      img.src = url;
      await img.decode();
      return performance.now() - t0;
    };
    const results = {};
    for (const [color, url] of Object.entries(urlsByColor)) {
      const probeUrl = bust ? `${url}&coldprobe=${Math.random().toString(36).slice(2)}` : url;
      results[color] = { cold: await decodeOnce(probeUrl), warm: await decodeOnce(probeUrl) };
    }
    return results;
  }, { urlsByColor, bust });
}

function logAndAssert(setLabel, results) {
  for (const [color, { cold, warm }] of Object.entries(results)) {
    console.log(`${setLabel} — ${color}: cold ${cold.toFixed(1)}ms, warm ${warm.toFixed(1)}ms`);
    expect(cold, `${setLabel} ${color} cold decode ${cold.toFixed(1)}ms exceeded ${COLD_BUDGET_MS}ms`).toBeLessThan(COLD_BUDGET_MS);
    expect(warm, `${setLabel} ${color} warm decode ${warm.toFixed(1)}ms exceeded ${WARM_BUDGET_MS}ms`).toBeLessThan(WARM_BUDGET_MS);
  }
}

test.describe('Web App — Card Switch Performance @performance', () => {
  for (const set of DEFAULT_CARD_SETS) {
    test(`${set.label} set: cold and warm decode per card`, async ({ page }) => {
      await page.goto('/timer/app');
      const urlsByColor = Object.fromEntries(
        CARD_COLORS.map((color) => [color, `/zoom/backgrounds/${set.files[color]}?v=${CARD_ASSET_VERSION}`])
      );
      logAndAssert(set.label, await measureDecodes(page, urlsByColor, true));
    });
  }

  test('Custom set: cold and warm decode per card', async ({ page }) => {
    await page.goto('/timer/app');

    // Seed a realistic custom set straight into the stores the app reads:
    // 1280x720 JPEGs (the size uploads are re-encoded to) in IndexedDB, and
    // the v3 metadata in localStorage. Noise keeps JPEG from compressing the
    // flat color away, so file sizes resemble real club artwork.
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
    await page.reload();

    // The app must actually be running on the custom set.
    await expect
      .poll(() => page.evaluate(() => document.body.style.backgroundImage), { message: 'custom set applied to page background' })
      .toContain('blob:');

    // Object URLs cannot be cache-busted; a freshly minted URL over the same
    // stored Blob is the cold decode (no network involved), decoding it again
    // is the warm one.
    const results = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('toastmaster-timer', 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const entries = await new Promise((resolve, reject) => {
        const tx = db.transaction('card-images', 'readonly');
        const keysReq = tx.objectStore('card-images').getAllKeys();
        const valuesReq = tx.objectStore('card-images').getAll();
        tx.oncomplete = () => resolve(keysReq.result.map((key, i) => [key, valuesReq.result[i]]));
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      const decodeOnce = async (url) => {
        const img = new Image();
        const t0 = performance.now();
        img.src = url;
        await img.decode();
        return performance.now() - t0;
      };
      const results = {};
      for (const [key, blob] of entries) {
        const color = key.split(':')[1];
        const url = URL.createObjectURL(blob);
        results[color] = { cold: await decodeOnce(url), warm: await decodeOnce(url), bytes: blob.size };
        URL.revokeObjectURL(url);
      }
      return results;
    });

    for (const color of CARD_COLORS) {
      console.log(`Custom — ${color}: ${(results[color].bytes / 1024).toFixed(0)}KB`);
    }
    logAndAssert('Custom', results);
  });

  test('after startup, every card of the selected set is pre-warmed', async ({ page }) => {
    await page.goto('/timer/app');
    // Give initCardImages + preloadCardImages time to warm the caches.
    await page.waitForTimeout(1500);

    const urlsByColor = Object.fromEntries(
      CARD_COLORS.map((color) => [
        color,
        `/zoom/backgrounds/${DEFAULT_CARD_SETS[0].files[color]}?v=${CARD_ASSET_VERSION}`,
      ])
    );
    // No cache-busting: these are the exact URLs a status switch uses, and
    // preload should have made every one of them warm already.
    const results = await measureDecodes(page, urlsByColor, false);
    for (const [color, { cold }] of Object.entries(results)) {
      console.log(`Preloaded — ${color}: ${cold.toFixed(1)}ms`);
      expect(cold, `${color} was not pre-warmed: first decode took ${cold.toFixed(1)}ms`).toBeLessThan(WARM_BUDGET_MS);
    }
  });

  test('switch interactions stay responsive through blue → green → yellow → red', async ({ page }) => {
    await page.addInitScript(() => {
      window.__maxEventDuration = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          if (e.interactionId && e.duration > window.__maxEventDuration)
            window.__maxEventDuration = e.duration;
      }).observe({ type: 'event', buffered: true, durationThreshold: 0 });
    });
    await page.goto('/timer/app');
    await page.waitForTimeout(1000);

    // The four preview swatches drive the same code path a live status
    // change does (page background + tile).
    const swatchRow = page.getByRole('button', { name: 'Customize card images' }).locator('..');
    const swatches = swatchRow.locator('button.rounded-full');
    await expect(swatches).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await swatches.nth(i).click();
      await page.waitForTimeout(150);
    }

    const maxEventDuration = await page.evaluate(() => window.__maxEventDuration);
    console.log(`Card switch — max event duration (INP proxy): ${maxEventDuration.toFixed(1)}ms`);
    expect(maxEventDuration, `switch interaction ${maxEventDuration.toFixed(1)}ms exceeded 200ms`).toBeLessThan(200);
  });
});
