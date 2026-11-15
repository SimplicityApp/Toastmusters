import { test, expect } from '@playwright/test';
import * as workerModule from '../worker/index.js';
import { makeDurableObjectNamespace, makeKv, makeCtx, makeEmptyAssets } from '../worker/durable-object-fake.js';
import { mintSessionToken } from '../worker/session-token.js';
import { entitlementKey } from '../worker/entitlements.js';

/**
 * Meeting polls (#80) in a plain browser. The Zoom app half stubs the Worker
 * with page.route; the voting page half runs the real Worker in-process (its
 * HTML, its inline script and its API, against an in-memory PollRoom), since
 * /vote/<id> is Worker-rendered and the dev server cannot serve it.
 *
 * Outside Zoom the app has no context; it still asks POST /api/polls/current
 * (the server decides), which is what lets the vote view be stubbed here.
 */

const POLL_ID = 'ABCDEFGHJKMNPQRS';
const VOTE_URL = `https://www.timer-dev.simple-tech.app/vote/${POLL_ID}`;
const DEFAULT_ROLES = ['Table Topics Speech', 'Standard Speech', 'Table Topics Evaluation'];

const report = (name, role, finishedAt) => ({ speechId: `${name}-${finishedAt}`, name, role, duration: '1:30', color: 'green', comments: '', disqualified: false, finishedAt });
const REPORTS = [
  report('Bob', 'Table Topics Speech', 1_000),
  report('Alice', 'Standard Speech', 2_000),
  report('Carol', 'Table Topics Speech', 3_000),
  report('Bob', 'Table Topics Speech', 4_000),
];

async function session(page, { plan = 'pro', flags = { pro: true, polls: true } } = {}) {
  await page.route('**/api/zoom/session', (route) =>
    route.fulfill({
      json: {
        identified: true,
        uid: 'e2e-polls',
        entitlement: plan === 'pro'
          ? { plan: 'pro', status: 'active', entitled: true, source: 'subscription' }
          : { plan: 'free', status: null, entitled: false, source: 'none' },
        flags,
      },
    })
  );
}

async function seed(page, entries) {
  await page.addInitScript((values) => {
    if (sessionStorage.getItem('e2e_seeded')) return;
    sessionStorage.setItem('e2e_seeded', '1');
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, JSON.stringify(value));
  }, entries);
}

/** No poll open in this meeting, unless a test says otherwise. */
async function noCurrentPoll(page) {
  await page.route('**/api/polls/current', (route) => route.fulfill({ status: 404, json: { error: 'not_found' } }));
}

/** Fails on an assertion, not a click timeout, when the tab is missing. */
async function openPollTab(page) {
  const tab = page.getByRole('button', { name: 'POLL', exact: true });
  await expect(tab).toBeVisible();
  await tab.click();
}

const tabs = (page) => page.getByRole('navigation', { name: 'Tabs' }).getByRole('button');
const categories = (page) => page.getByRole('group').filter({ has: page.getByRole('combobox', { name: /role/i }) });
const candidateValues = (group) =>
  group.getByRole('textbox', { name: /candidate/i }).evaluateAll((inputs) => inputs.map((input) => input.value));

// ---------------------------------------------------------------------------

test.describe('the POLL tab', () => {
  test('sits after REPORT with the polls flag on', async ({ page }) => {
    await session(page);
    await noCurrentPoll(page);
    await page.goto('/zoom/');
    await expect(tabs(page)).toHaveText(['AGENDA', 'LIVE', 'REPORT', 'POLL']);
  });

  test('is not there with the polls flag off', async ({ page }) => {
    await session(page, { flags: { pro: true } });
    await page.goto('/zoom/');
    await expect(tabs(page)).toHaveText(['AGENDA', 'LIVE', 'REPORT']);
  });

  // AC-1
  test('locks the setup on the free plan behind Upgrade to Pro', async ({ page }) => {
    await session(page, { plan: 'free' });
    await noCurrentPoll(page);
    await page.goto('/zoom/');
    await openPollTab(page);

    await expect(page.getByRole('button', { name: /upgrade to pro/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /open poll/i })).toHaveCount(0);
  });
});

test.describe('a Pro organizer runs a poll', () => {
  test.beforeEach(async ({ page }) => {
    await session(page);
    await noCurrentPoll(page);
    await seed(page, { toastmaster_reports: REPORTS });
  });

  // AC-2, AC-5
  test('the ballot starts from the three usual categories, filled with this meeting\'s speakers', async ({ page }) => {
    await page.goto('/zoom/');
    await openPollTab(page);

    await expect(categories(page)).toHaveCount(3);
    for (const [i, role] of DEFAULT_ROLES.entries()) {
      await expect(categories(page).nth(i).getByRole('combobox', { name: /role/i })).toHaveValue(role);
    }
    expect(await candidateValues(categories(page).nth(0))).toEqual(['Bob', 'Carol']);
    expect(await candidateValues(categories(page).nth(1))).toEqual(['Alice']);
    expect(await candidateValues(categories(page).nth(2))).toEqual(['', '', '']);
  });

  // AC-3
  test('categories and candidates can be added and removed', async ({ page }) => {
    await page.goto('/zoom/');
    await openPollTab(page);

    await page.getByRole('button', { name: /add category/i }).click();
    await expect(categories(page)).toHaveCount(4);
    await categories(page).nth(3).getByRole('button', { name: /remove category/i }).click();
    await expect(categories(page)).toHaveCount(3);

    const topics = categories(page).nth(0);
    await topics.getByRole('button', { name: /add candidate/i }).click();
    await expect(topics.getByRole('textbox', { name: /candidate/i })).toHaveCount(3);
    await topics.getByRole('button', { name: /remove candidate/i }).first().click();
    await expect(topics.getByRole('textbox', { name: /candidate/i })).toHaveCount(2);
  });

  // AC-7, AC-8, AC-9
  test('open, watch the counts, close, reveal the winners, and find them on the Report tab', async ({ page }) => {
    let resultReads = 0;
    await page.route('**/api/polls', (route) =>
      route.request().method() === 'POST' ? route.fulfill({ status: 201, json: { id: POLL_ID, url: VOTE_URL } }) : route.fallback()
    );
    await page.route(`**/api/polls/${POLL_ID}/results`, (route) => {
      resultReads += 1;
      route.fulfill({
        json: { status: 'open', counts: [[resultReads, 1], [1], [0, 0, 0]], byPath: { zoom: [[resultReads, 0], [1], [0, 0, 0]], guest: [[0, 0], [0], [0, 0, 0]], link: [[0, 1], [0], [0, 0, 0]] } },
      });
    });
    await page.route(`**/api/polls/${POLL_ID}/close`, (route) =>
      route.fulfill({
        json: {
          counts: [[2, 2], [3], [0, 0, 0]],
          byPath: { zoom: [[1, 1], [2], [0, 0, 0]], guest: [[0, 0], [0], [0, 0, 0]], link: [[1, 1], [1], [0, 0, 0]] },
          winners: [['Bob', 'Carol'], ['Alice'], []],
        },
      })
    );

    await page.goto('/zoom/');
    await openPollTab(page);
    await expect(page.getByRole('button', { name: /open poll/i })).toBeVisible();
    await page.getByRole('button', { name: /open poll/i }).click();
    await expect(page.getByText(VOTE_URL).or(page.locator(`input[value="${VOTE_URL}"]`)).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /copy link/i })).toBeVisible();

    // Every five seconds while the tab is open.
    await expect.poll(() => resultReads, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

    await page.getByRole('button', { name: /close poll/i }).click();
    await expect(page.getByRole('button', { name: /show on stage/i })).toBeVisible();
    await expect(page.getByText(/No votes/i).first()).toBeVisible();

    await page.getByRole('button', { name: 'REPORT', exact: true }).click();
    await expect(page.getByText(/winners?/i).first()).toBeVisible();
    await expect(page.getByText(/No votes/i).first()).toBeVisible();
  });
});

// AC-14
test('a participant on the free plan finds the open poll, votes, and is thanked', async ({ page }) => {
  const VOTE_ID = 'VWXYZ23456789ABC';
  let voteBody = null;
  await session(page, { plan: 'free' });
  await page.route('**/api/polls/current', (route) =>
    route.fulfill({ json: { id: VOTE_ID, ballot: { categories: [{ role: 'Standard Speech', label: 'Best Speaker', candidates: ['Alice', 'Bob'] }] } } })
  );
  await page.route(`**/api/polls/${VOTE_ID}/votes`, (route) => {
    voteBody = route.request().postDataJSON();
    route.fulfill({ json: { ok: true } });
  });

  await page.goto('/zoom/');
  const banner = page.getByText(/vote now/i).first();
  await expect(banner).toBeVisible();
  await banner.click();

  await expect(page.getByText('Best Speaker').first()).toBeVisible();
  await page.getByRole('radio', { name: 'Bob' }).check();
  await page.getByRole('button', { name: /submit vote/i }).click();

  await expect(page.getByText(/thanks, your vote is in/i).first()).toBeVisible();
  expect(voteBody.choices).toEqual({ 0: 1 });
});

// AC-6: the backup link, against the real Worker.
test.describe('the voting page /vote/<id>', () => {
  const ORIGIN = 'https://www.timer-dev.simple-tech.app';
  let env;
  let ctx;

  const workerFetch = (path, { method = 'GET', uid, body } = {}) =>
    workerModule.default.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          host: 'www.timer-dev.simple-tech.app',
          'content-type': 'application/json',
          ...(uid ? { authorization: `Bearer ${mintSessionToken(uid, env.SESSION_SIGNING_KEY)}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env,
      ctx
    );

  test.beforeEach(async ({ page }) => {
    env = {
      PROFILES: makeKv(),
      ASSETS: makeEmptyAssets(),
      SESSION_SIGNING_KEY: 'e2e-session-signing-key',
      ZOOM_CLIENT_SECRET: 'e2e-zoom-client-secret',
      ENTITLEMENT_ENFORCE: '1',
      FLAGS_FORCE: '1',
      WEB_ORIGIN: ORIGIN,
    };
    env.POLL_ROOM = makeDurableObjectNamespace(workerModule.PollRoom, () => env);
    ctx = makeCtx();
    await env.PROFILES.put(entitlementKey('owner-uid'), JSON.stringify({ status: 'active', currentPeriodEnd: Date.now() + 1e10 }));

    // Every request to the site goes to the in-process Worker.
    await page.route(`${ORIGIN}/**`, async (route) => {
      const request = route.request();
      const method = request.method();
      const res = await workerModule.default.fetch(
        new Request(request.url(), {
          method,
          headers: { ...request.headers(), host: 'www.timer-dev.simple-tech.app', 'cf-connecting-ip': '198.51.100.9' },
          ...(method === 'GET' || method === 'HEAD' ? {} : { body: request.postDataBuffer() }),
        }),
        env,
        ctx
      );
      await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
    });
  });

  async function openPoll() {
    const res = await workerFetch('/api/polls', {
      method: 'POST',
      uid: 'owner-uid',
      body: { ballot: { categories: [{ role: 'Standard Speech', label: 'Best Speaker', candidates: ['Alice', 'Bob'] }] } },
    });
    expect(res.ok).toBe(true);
    return (await res.json()).id;
  }

  test('shows the ballot to a browser with no sign-in, takes one vote per device, and never shows a count', async ({ page }) => {
    const id = await openPoll();

    const response = await page.goto(`${ORIGIN}/vote/${id}`);
    expect(response.status()).toBe(200);
    await expect(page.getByText('Best Speaker').first()).toBeVisible();
    await expect(page.getByText(/one vote per device/i).first()).toBeVisible();

    await page.getByRole('radio', { name: 'Bob' }).check();
    await page.getByRole('button', { name: /submit vote/i }).click();
    await expect(page.getByText(/thanks/i).first()).toBeVisible();

    const results = await (await workerFetch(`/api/polls/${id}/results`, { uid: 'owner-uid' })).json();
    expect(results.counts[0][1]).toBe(1);
    expect(results.byPath.link[0][1]).toBe(1);

    // Same browser, same device token: refused, and the count stays put.
    await page.reload();
    await page.getByRole('radio', { name: 'Alice' }).check();
    await page.getByRole('button', { name: /submit vote/i }).click();
    await expect(page.getByText(/already voted/i).first()).toBeVisible();
    const after = await (await workerFetch(`/api/polls/${id}/results`, { uid: 'owner-uid' })).json();
    expect(after.counts[0][0] ?? 0).toBe(0);

    await expect(page.getByText(/\b\d+ votes?\b/i)).toHaveCount(0);
  });

  test('says the poll is closed once the owner closes it', async ({ page }) => {
    const id = await openPoll();
    expect((await workerFetch(`/api/polls/${id}/close`, { method: 'POST', uid: 'owner-uid' })).ok).toBe(true);

    await page.goto(`${ORIGIN}/vote/${id}`);
    await expect(page.getByText(/closed/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /submit vote/i })).toHaveCount(0);
  });

  test('is a real 404 for an id nobody minted', async ({ page }) => {
    const response = await page.goto(`${ORIGIN}/vote/ZZZZZZZZZZZZZZZZ`);
    expect(response.status()).toBe(404);
  });
});
