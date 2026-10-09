import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  handleSharedReport,
  isShareToken,
  mintShareToken,
  shareKey,
  shareByMeetingKey,
  shareObjectName,
  shareFullObjectName,
  SHARE_TOKEN_LENGTH,
} from './club-share.js';
import { handleClubMeetings, speechKey, meetingKey } from './club-meetings.js';
import { handleClubActivate } from './club.js';
import { createClubFromPending, clubDeviceKey } from './club-admin.js';
import { verifyClubToken } from './club-token.js';
import { clubKey } from './entitlements.js';
import worker from './index.js';

/**
 * A meeting that travels: an image and a link.
 *
 * The two properties this rests on — the device renders both PNGs so the chat
 * preview can never drift from what the timer saw, and the token is minted
 * lazily so a meeting nobody shares has no public address at all.
 */

const SIGNING_KEY = 'test-session-signing-key';
const MEETING = '20260929';
const NOW = Date.UTC(2026, 8, 29, 23, 0);
const ORIGIN = 'https://www.timer.simple-tech.app';

/** KV with per-key metadata, as club-meetings.test.js needs it. */
function makeKv(seed = {}) {
  const store = new Map(
    Object.entries(seed).map(([k, v]) => [k, { value: typeof v === 'string' ? v : JSON.stringify(v), metadata: null }])
  );
  return {
    store,
    get: async (key, type) => {
      const entry = store.get(key);
      if (entry === undefined) return null;
      return type === 'json' ? JSON.parse(entry.value) : entry.value;
    },
    put: async (key, value, options) => {
      store.set(key, { value, metadata: options?.metadata ?? null });
    },
    delete: async (key) => {
      store.delete(key);
    },
    list: async ({ prefix = '' } = {}) => ({
      keys: [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entry]) => ({ name, ...(entry.metadata ? { metadata: entry.metadata } : {}) })),
      list_complete: true,
    }),
  };
}

/** In-memory R2, with the same get/head/put shape as the real bucket. */
function makeBucket() {
  const store = new Map();
  return {
    store,
    get: async (key) =>
      store.has(key)
        ? { body: store.get(key).body, httpMetadata: store.get(key).httpMetadata, httpEtag: `"${key}"` }
        : null,
    head: async (key) => (store.has(key) ? { httpMetadata: store.get(key).httpMetadata } : null),
    put: async (key, body, options) => {
      store.set(key, { body, httpMetadata: options?.httpMetadata });
    },
  };
}

let kv;
let bucket;
let env;

beforeEach(() => {
  kv = makeKv();
  bucket = makeBucket();
  env = {
    PROFILES: kv,
    CARD_ASSETS: bucket,
    SESSION_SIGNING_KEY: SIGNING_KEY,
    ENTITLEMENT_ENFORCE: '1',
    WEB_ORIGIN: ORIGIN,
  };
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

async function activated({ name = 'Downtown Speakers' } = {}) {
  const { clubId } = await createClubFromPending(env, { clubName: name, uid: 'buyer-uid' }, { code: 'DTSP7K2QM9' });
  const res = await handleClubActivate(
    new Request('https://x/api/club/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'DTSP-7K2QM9' }),
    }),
    env
  );
  const body = await res.json();
  return { clubId, clubToken: body.clubToken, deviceId: verifyClubToken(body.clubToken, SIGNING_KEY).deviceId };
}

const route = (path) => `meetings${path}`;

const speech = (over = {}) => ({
  speechId: 's1',
  name: 'Alice',
  role: 'Standard Speech',
  duration: '5:50',
  color: 'green',
  comments: '',
  disqualified: false,
  finishedAt: 1_000,
  ...over,
});

const appendReq = (clubToken, body) =>
  new Request(`https://x/api/club/meetings/${MEETING}/speeches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-club': clubToken },
    body: JSON.stringify(body),
  });

/** The device's share POST: multipart, because these are image bytes. */
function shareReq(clubToken, { title, png = 'FULL-PNG-BYTES', previewPng = 'PREVIEW-PNG-BYTES', meetingId = MEETING } = {}) {
  const form = new FormData();
  if (title) form.append('title', title);
  if (png) form.append('png', new Blob([png], { type: 'image/png' }), 'report.png');
  if (previewPng) form.append('previewPng', new Blob([previewPng], { type: 'image/png' }), 'preview.png');
  return new Request(`https://x/api/club/meetings/${meetingId}/share`, {
    method: 'POST',
    headers: clubToken ? { 'x-club': clubToken } : {},
    body: form,
  });
}

const share = (clubToken, options = {}) =>
  handleClubMeetings(shareReq(clubToken, options), route(`/${options.meetingId ?? MEETING}/share`), env);

/** A meeting with two speeches, one of which ran over. */
async function timedMeeting(clubToken) {
  await handleClubMeetings(appendReq(clubToken, speech()), route(`/${MEETING}/speeches`), env);
  await handleClubMeetings(
    appendReq(clubToken, speech({ speechId: 's2', name: 'Bob', color: 'red', finishedAt: 2_000 })),
    route(`/${MEETING}/speeches`),
    env
  );
}

describe('share tokens', () => {
  it('is sixteen Crockford base32 characters', () => {
    const token = mintShareToken();
    expect(token).toHaveLength(SHARE_TOKEN_LENGTH);
    // I, L, O and U are absent, the same way club codes exclude them: a token
    // read off a screenshot must not turn an O into a 0.
    expect(token).not.toMatch(/[ILOU]/);
    expect(isShareToken(token)).toBe(true);
  });

  it('refuses anything that is not one of ours', () => {
    expect(isShareToken('')).toBe(false);
    expect(isShareToken('short')).toBe(false);
    expect(isShareToken('ILOUILOUILOUILOU')).toBe(false);
    expect(isShareToken('abcdefghjkmnpqrs')).toBe(false);
    expect(isShareToken(`${mintShareToken()}X`)).toBe(false);
  });
});

describe('POST …/share', () => {
  it('compacts the meeting before it publishes it', async () => {
    const { clubToken, clubId } = await activated();
    await timedMeeting(clubToken);
    expect(kv.store.has(speechKey(clubId, MEETING, 's1'))).toBe(true);

    const res = await share(clubToken);

    expect(res.status).toBe(200);
    // The page and its preview are built from one key, not from a fan-out a
    // second device might still be adding to.
    expect(kv.store.has(speechKey(clubId, MEETING, 's1'))).toBe(false);
    const header = await kv.get(meetingKey(clubId, MEETING), 'json');
    expect(header.speeches.map((s) => s.name)).toEqual(['Alice', 'Bob']);
  });

  it('answers with the hosted URL and the public OG image', async () => {
    const { clubToken, clubId } = await activated();
    await timedMeeting(clubToken);

    const body = await (await share(clubToken)).json();

    expect(isShareToken(body.token)).toBe(true);
    expect(body.url).toBe(`${ORIGIN}/r/${body.token}`);
    // The preview points at the public, immutable club-asset route — the one
    // with no credential, because a crawler has none.
    expect(body.imageUrl).toBe(`/api/club-assets/${clubId}/r-${body.token}.png`);
    expect(body).toMatchObject({ meetingId: MEETING, speeches: 2, overtime: 1 });
  });

  it('stores both pictures: the preview a chat crops and the full report', async () => {
    const { clubToken, clubId } = await activated();
    await timedMeeting(clubToken);

    const { token } = await (await share(clubToken)).json();

    expect(bucket.store.has(`club/${clubId}/${shareObjectName(token)}`)).toBe(true);
    expect(bucket.store.has(`club/${clubId}/${shareFullObjectName(token)}`)).toBe(true);
    expect(bucket.store.get(`club/${clubId}/${shareObjectName(token)}`).httpMetadata.contentType).toBe('image/png');
  });

  it('records the title, which is the only moment a meeting ever gets one', async () => {
    const { clubToken, clubId } = await activated();
    await timedMeeting(clubToken);

    const body = await (await share(clubToken, { title: 'Humorous Speech Contest' })).json();

    expect(body.title).toBe('Humorous Speech Contest');
    const entry = kv.store.get(meetingKey(clubId, MEETING));
    expect(JSON.parse(entry.value).title).toBe('Humorous Speech Contest');
    // History renders from the metadata, so the title has to land there too.
    expect(entry.metadata.title).toBe('Humorous Speech Contest');
  });

  it('reuses the token when the same meeting is shared again', async () => {
    const { clubToken, clubId } = await activated();
    await timedMeeting(clubToken);

    const first = await (await share(clubToken)).json();
    const second = await (await share(clubToken, { title: 'Corrected title' })).json();

    // A link already sitting in somebody's group chat keeps working after the
    // timer notices a typo and shares again.
    expect(second.token).toBe(first.token);
    expect(await kv.get(shareByMeetingKey(clubId, MEETING))).toBe(first.token);
    expect([...kv.store.keys()].filter((k) => k.startsWith('report-share:'))).toHaveLength(1);
  });

  it('mints nothing for a meeting nobody shares', async () => {
    const { clubToken } = await activated();
    await timedMeeting(clubToken);

    expect([...kv.store.keys()].filter((k) => k.startsWith('report-share'))).toHaveLength(0);
  });

  it('404s a meeting that was never timed', async () => {
    const { clubToken } = await activated();

    const res = await share(clubToken, { meetingId: '20260101' });

    expect(res.status).toBe(404);
  });

  it('refuses a meetingId that is not one we mint', async () => {
    const { clubToken } = await activated();
    expect((await share(clubToken, { meetingId: 'tuesday' })).status).toBe(400);
  });

  it('turns away a request with no club at all', async () => {
    expect((await share(null)).status).toBe(401);
  });

  // Revocation bites on writes, because the token itself is HMAC-only.
  it('refuses a revoked device', async () => {
    const { clubToken, clubId, deviceId } = await activated();
    await timedMeeting(clubToken);
    const device = await kv.get(clubDeviceKey(clubId, deviceId), 'json');
    await kv.put(clubDeviceKey(clubId, deviceId), JSON.stringify({ ...device, revokedAt: 1 }));

    expect((await share(clubToken)).status).toBe(403);
  });

  it('refuses a club that has lapsed', async () => {
    const { clubToken, clubId } = await activated();
    await timedMeeting(clubToken);
    const club = await kv.get(clubKey(clubId), 'json');
    await kv.put(clubKey(clubId), JSON.stringify({ ...club, status: 'canceled', currentPeriodEnd: NOW - 1 }));

    expect((await share(clubToken)).status).toBe(402);
  });

  it('refuses anything but a POST', async () => {
    const { clubToken } = await activated();
    const res = await handleClubMeetings(
      new Request(`https://x/api/club/meetings/${MEETING}/share`, { headers: { 'x-club': clubToken } }),
      route(`/${MEETING}/share`),
      env
    );
    expect(res.status).toBe(405);
  });

  // The picture is optional: the hosted page renders the table as HTML, so a
  // device with no PNG encoder still gets a working link.
  it('publishes without the pictures rather than refusing', async () => {
    const { clubToken } = await activated();
    await timedMeeting(clubToken);

    const res = await share(clubToken, { png: null, previewPng: null });

    expect(res.status).toBe(200);
    expect(bucket.store.size).toBe(0);
  });
});

describe('GET /r/<token>', () => {
  async function shared({ title } = {}) {
    const activation = await activated();
    await timedMeeting(activation.clubToken);
    const body = await (await share(activation.clubToken, { title })).json();
    return { ...activation, ...body };
  }

  const page = (token) => {
    const url = new URL(`${ORIGIN}/r/${token}`);
    return handleSharedReport(new Request(url), url, env);
  };

  it('renders the meeting server-side, with no credential of any kind', async () => {
    const { token } = await shared();

    const res = await page(token);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('Downtown Speakers');
    // The table is in the bytes: a crawler does not run JavaScript, and neither
    // does whoever opens the link in a webview with no bundle anywhere near it.
    expect(html).toContain('Alice');
    expect(html).toContain('Bob');
    expect(html).toContain('5:50');
  });

  it('points its OG image at the public asset route', async () => {
    const { token, clubId } = await shared();

    const html = await (await page(token)).text();

    expect(html).toContain(
      `<meta property="og:image" content="${ORIGIN}/api/club-assets/${clubId}/r-${token}.png">`
    );
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    // Absolute, because an OG tag cannot be relative.
    expect(html).toContain(`<meta property="og:url" content="${ORIGIN}/r/${token}">`);
  });

  it('describes the meeting in the preview card', async () => {
    const { token } = await shared({ title: 'Humorous Speech Contest' });

    const html = await (await page(token)).text();

    expect(html).toContain('Downtown Speakers — Humorous Speech Contest');
    expect(html).toContain('2 speeches · 1 over time');
  });

  it('is noindex with a short public cache', async () => {
    const { token } = await shared();

    const res = await page(token);

    // Unguessable rather than secret: public enough for a crawler to fetch,
    // never something the club asked to have indexed.
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await res.text()).toContain('<meta name="robots" content="noindex">');
  });

  it('is a real 404 for a token nobody minted', async () => {
    await shared();

    expect((await page('ZZZZZZZZZZZZZZZZ')).status).toBe(404);
    expect((await page('not-a-token')).status).toBe(404);
    expect((await page('')).status).toBe(404);
    // And never cached, unlike the page itself.
    expect((await page('ZZZZZZZZZZZZZZZZ')).headers.get('cache-control')).toBe('no-store');
  });

  it('escapes whatever the club typed rather than letting it become markup', async () => {
    const activation = await activated({ name: 'Downtown <script>alert(1)</script>' });
    await timedMeeting(activation.clubToken);
    const { token } = await (await share(activation.clubToken, { title: '"><img onerror=x>' })).json();

    const html = await (await page(token)).text();

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img onerror=x>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('answers a HEAD without a body, for a preview fetcher that only wants the tags', async () => {
    const { token } = await shared();
    const url = new URL(`${ORIGIN}/r/${token}`);

    const res = await handleSharedReport(new Request(url, { method: 'HEAD' }), url, env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

describe('routing', () => {
  const ctx = { waitUntil: () => {} };
  const assets = {
    fetch: vi.fn(() => Promise.resolve(new Response('shell', { status: 200, headers: { 'x-asset-path': '/index.html' } }))),
  };

  it('serves /r/<token> from the Worker rather than the SPA shell', async () => {
    const activation = await activated();
    await timedMeeting(activation.clubToken);
    const { token } = await (await share(activation.clubToken)).json();

    const res = await worker.fetch(
      new Request(`${ORIGIN}/r/${token}`, { headers: { host: 'www.timer.simple-tech.app' } }),
      { ...env, ASSETS: assets },
      ctx
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('x-asset-path')).toBeNull();
    // The security headers still land on it, so the page gets ROOT_CSP.
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(await res.text()).toContain('Downtown Speakers');
  });

  it('canonicalizes a link pasted against the apex host', async () => {
    const res = await worker.fetch(
      new Request('https://timer.simple-tech.app/r/ZZZZZZZZZZZZZZZZ', { headers: { host: 'timer.simple-tech.app' } }),
      { ...env, ASSETS: assets },
      ctx
    );

    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://www.timer.simple-tech.app/r/ZZZZZZZZZZZZZZZZ');
  });
});
