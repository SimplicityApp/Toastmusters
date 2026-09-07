import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { handleAsset } from './assets.js';
import { mintSessionToken } from './session-token.js';

const SIGNING_KEY = 'test-session-signing-key';

/** In-memory stand-in for the R2 bucket, with the same get/put/head/list shape. */
function makeBucket() {
  const store = new Map();
  return {
    store,
    get: async (key) => {
      const found = store.get(key);
      return found ? { body: found.bytes, httpMetadata: found.httpMetadata } : null;
    },
    head: async (key) => (store.has(key) ? { size: store.get(key).bytes.byteLength } : null),
    put: async (key, bytes, options) => {
      store.set(key, { bytes, httpMetadata: options?.httpMetadata });
    },
    list: async ({ prefix }) => ({
      objects: [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, v]) => ({ key, size: v.bytes.byteLength })),
      truncated: false,
    }),
  };
}

let bucket;
let env;

beforeEach(() => {
  bucket = makeBucket();
  env = { CARD_ASSETS: bucket, SESSION_SIGNING_KEY: SIGNING_KEY };
});

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const bodyOf = (text) => new TextEncoder().encode(text);

function call(method, hash, { uid = 'u1', body, token, headers = {} } = {}) {
  const bearer = token ?? (uid ? mintSessionToken(uid, SIGNING_KEY) : null);
  const url = new URL(`https://zoom.timer.simple-tech.app/api/assets/${hash}`);
  const request = new Request(url, {
    method,
    headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
    ...(body === undefined ? {} : { body }),
  });
  return handleAsset(request, url, env);
}

describe('asset authentication and addressing', () => {
  it('refuses an unauthenticated request', async () => {
    const bytes = bodyOf('image');

    expect((await call('PUT', sha256(bytes), { uid: null, body: bytes })).status).toBe(401);
    expect((await call('GET', sha256(bytes), { uid: null })).status).toBe(401);
  });

  // A hash must not be a capability: knowing one must not reveal another
  // user's artwork.
  it('does not let one user read another user\'s asset', async () => {
    const bytes = bodyOf('private artwork');
    const hash = sha256(bytes);
    await call('PUT', hash, { uid: 'owner', body: bytes });

    expect((await call('GET', hash, { uid: 'someone-else' })).status).toBe(404);
    expect((await call('GET', hash, { uid: 'owner' })).status).toBe(200);
  });

  // Nothing a client sends may shape the object key.
  it('rejects anything that is not a literal sha-256 digest', async () => {
    for (const bad of ['', 'nope', '../../etc/passwd', 'A'.repeat(64), 'ab'.repeat(40)]) {
      expect((await call('GET', bad)).status).toBe(400);
    }
  });
});

describe('storing an asset', () => {
  it('stores bytes that match their claimed id, and reads them back', async () => {
    const bytes = bodyOf('a card image');
    const hash = sha256(bytes);

    const put = await call('PUT', hash, { body: bytes, headers: { 'content-type': 'image/jpeg' } });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ stored: true, deduped: false });

    const get = await call('GET', hash);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/jpeg');
  });

  // Without this the store is not content-addressed: a client could park
  // arbitrary content under an id another device is about to fetch.
  it('refuses bytes that do not hash to their claimed id', async () => {
    const res = await call('PUT', sha256(bodyOf('expected')), { body: bodyOf('something else') });

    expect(res.status).toBe(400);
    expect(bucket.store.size).toBe(0);
  });

  it('treats a repeat upload as already stored', async () => {
    const bytes = bodyOf('same picture');
    const hash = sha256(bytes);
    await call('PUT', hash, { body: bytes });

    const again = await call('PUT', hash, { body: bytes });

    expect(await again.json()).toEqual({ stored: true, deduped: true });
    expect(bucket.store.size).toBe(1);
  });

  it('rejects an empty body', async () => {
    expect((await call('PUT', sha256(new Uint8Array()), { body: undefined })).status).toBe(400);
  });

  it('rejects an oversized asset by its declared length', async () => {
    const bytes = bodyOf('small');
    const res = await call('PUT', sha256(bytes), {
      body: bytes,
      headers: { 'content-length': String(5 * 1024 * 1024) },
    });

    expect(res.status).toBe(413);
  });

  it('rejects an oversized asset that lied about its length', async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024);
    const res = await call('PUT', sha256(bytes), { body: bytes });

    expect(res.status).toBe(413);
  });

  it('refuses to exceed the per-user storage budget', async () => {
    // Eleven distinct 2MB assets: the first ten fit in the 20MB budget.
    for (let i = 0; i < 10; i++) {
      const bytes = new Uint8Array(2 * 1024 * 1024);
      bytes[0] = i;
      const res = await call('PUT', sha256(bytes), { body: bytes });
      expect(res.status).toBe(200);
    }

    const overflow = new Uint8Array(2 * 1024 * 1024);
    overflow[0] = 99;
    const res = await call('PUT', sha256(overflow), { body: overflow });

    expect(res.status).toBe(507);
  });

  // One user's quota must not be charged against another's.
  it('budgets each user separately', async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024);
    for (let i = 0; i < 10; i++) {
      const b = new Uint8Array(2 * 1024 * 1024);
      b[0] = i;
      await call('PUT', sha256(b), { uid: 'heavy-user', body: b });
    }

    expect((await call('PUT', sha256(bytes), { uid: 'light-user', body: bytes })).status).toBe(200);
  });
});

describe('asset endpoint edges', () => {
  it('404s an asset that was never stored', async () => {
    expect((await call('GET', sha256(bodyOf('absent')))).status).toBe(404);
  });

  it('rejects methods other than GET and PUT', async () => {
    for (const method of ['POST', 'DELETE']) {
      expect((await call(method, sha256(bodyOf('x')))).status).toBe(405);
    }
  });

  it('reports 503 when the bucket binding is missing', async () => {
    const url = new URL('https://x/api/assets/' + sha256(bodyOf('x')));
    const res = await handleAsset(new Request(url), url, { SESSION_SIGNING_KEY: SIGNING_KEY });

    expect(res.status).toBe(503);
  });

  // Content-addressed bytes never change, but they belong to one user.
  it('caches a fetched asset privately', async () => {
    const bytes = bodyOf('art');
    await call('PUT', sha256(bytes), { body: bytes });

    const res = await call('GET', sha256(bytes));

    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
  });
});
