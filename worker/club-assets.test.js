import { describe, it, expect, beforeEach } from 'vitest';
import { handleClubAsset } from './club-assets.js';
import worker from './index.js';

/**
 * The one asset route with no credential at all.
 *
 * Card artwork is scoped by uid so a hash is never a global capability; the
 * club logo deliberately is one, because its readers are a guest's badge
 * compositor and a crawler fetching a shared report's preview image — neither
 * of which has anything we could check.
 */

/** In-memory R2, with the same get/head/put shape as the real bucket. */
function makeBucket(seed = {}) {
  const store = new Map(
    Object.entries(seed).map(([key, value]) => [
      key,
      // `body` is what a real R2 object hands back; the Response constructor
      // takes a byte array the same way it takes the stream.
      { body: new TextEncoder().encode(value), httpMetadata: { contentType: 'image/png' }, httpEtag: `"${key}"` },
    ])
  );
  return {
    store,
    get: async (key) => store.get(key) ?? null,
    head: async (key) => (store.has(key) ? { ...store.get(key), body: undefined } : null),
    put: async (key, body, options) => {
      store.set(key, { body, httpMetadata: options?.httpMetadata });
    },
  };
}

let env;

beforeEach(() => {
  env = { CARD_ASSETS: makeBucket({ 'club/club-1/abc123.png': 'logo-bytes' }) };
});

const call = (path, { method = 'GET' } = {}) => {
  const url = new URL(`https://www.timer.simple-tech.app${path}`);
  return handleClubAsset(new Request(url, { method }), url, env);
};

describe('GET /api/club-assets/<clubId>/<name>', () => {
  it('serves the logo with no session, no club token and no entitlement', async () => {
    const res = await call('/api/club-assets/club-1/abc123.png');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(await res.text()).toBe('logo-bytes');
  });

  it('caches immutably and publicly', async () => {
    const res = await call('/api/club-assets/club-1/abc123.png');

    // Public, unlike the per-user card assets: the whole point is that the CDN
    // answers this without waking the Worker, which is what keeps the badge
    // compositor's fetch out of the 25 ms warm budget.
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('404s an object that is not there', async () => {
    expect((await call('/api/club-assets/club-1/missing.png')).status).toBe(404);
    expect((await call('/api/club-assets/other-club/abc123.png')).status).toBe(404);
  });

  it('refuses a name that would reshape the object key', async () => {
    // Nothing a caller sends may reach another prefix — `card/<uid>/` lives in
    // the same bucket.
    expect((await call('/api/club-assets/club-1/..%2F..%2Fcard%2Fu1%2Fx')).status).toBe(404);
    expect((await call('/api/club-assets/club-1/a/b')).status).toBe(404);
    expect((await call('/api/club-assets/club-1/')).status).toBe(404);
    expect((await call('/api/club-assets/club-1')).status).toBe(404);
  });

  it('refuses anything but a read', async () => {
    // The upload route arrives with the admin console; until then the logo goes
    // into R2 by hand.
    expect((await call('/api/club-assets/club-1/abc123.png', { method: 'PUT' })).status).toBe(405);
    expect((await call('/api/club-assets/club-1/abc123.png', { method: 'DELETE' })).status).toBe(405);
  });

  it('answers a HEAD without a body', async () => {
    const res = await call('/api/club-assets/club-1/abc123.png', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('says so when the bucket is not bound rather than 404ing', async () => {
    env = {};
    expect((await call('/api/club-assets/club-1/abc123.png')).status).toBe(503);
  });
});

describe('routing', () => {
  const ctx = { waitUntil: () => {} };

  it('is dispatched ahead of the apex redirect, from either host', async () => {
    // A 301 mid-frame would make the badge compositor follow a redirect it has
    // no budget for.
    const apex = await worker.fetch(
      new Request('https://timer.simple-tech.app/api/club-assets/club-1/abc123.png', {
        headers: { host: 'timer.simple-tech.app' },
      }),
      env,
      ctx
    );
    expect(apex.status).toBe(200);

    // And ahead of host routing, so the Zoom app reaches it from zoom.<domain>
    // rather than being rewritten into the SPA shell.
    const zoom = await worker.fetch(
      new Request('https://zoom.timer.simple-tech.app/api/club-assets/club-1/abc123.png', {
        headers: { host: 'zoom.timer.simple-tech.app' },
      }),
      env,
      ctx
    );
    expect(zoom.status).toBe(200);
    expect(await zoom.text()).toBe('logo-bytes');
  });

  it('does not collide with the club state route', async () => {
    // '/api/club-assets/...' must not be read as '/api/club/...'.
    const res = await worker.fetch(
      new Request('https://www.timer.simple-tech.app/api/club-assets/club-1/abc123.png', {
        headers: { host: 'www.timer.simple-tech.app' },
      }),
      env,
      ctx
    );
    expect(res.status).toBe(200);
  });
});
