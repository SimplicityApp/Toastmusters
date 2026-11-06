import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from './index.js';
import {
  handleClubCards,
  normalizeCardSet,
  cardSetUnchanged,
  sniffImageType,
  clubCardObjectKey,
  PRUNE_GRACE_MS,
  MAX_CARD_BYTES,
} from './club-cards.js';
import { handleClubActivate, handleClubState } from './club.js';
import { createClubFromPending, clubMemberKey, clubDeviceKey, clubCardsKey } from './club-admin.js';
import { mintSessionToken } from './session-token.js';
import { verifyClubToken } from './club-token.js';
import { clubKey } from './entitlements.js';

/**
 * The club's card set: artwork an admin or editor publishes once and every club
 * device shows. Private on purpose, unlike the logo, which is why the objects
 * live outside the prefix `/api/club-assets/*` serves.
 */

const SIGNING_KEY = 'test-session-signing-key';

function makeKv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    store,
    get: async (key, type) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
    list: async ({ prefix = '' } = {}) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

function makeBucket() {
  const store = new Map();
  return {
    store,
    head: async (key) => (store.has(key) ? { size: store.get(key).bytes.byteLength, httpMetadata: store.get(key).options?.httpMetadata } : null),
    get: async (key) => {
      const entry = store.get(key);
      if (!entry) return null;
      return { body: entry.bytes, httpMetadata: entry.options?.httpMetadata };
    },
    put: async (key, bytes, options) => { store.set(key, { bytes, options, uploaded: new Date(Date.now()) }); },
    delete: async (key) => { store.delete(key); },
    list: async ({ prefix = '' } = {}) => ({
      objects: [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, entry]) => ({ key, size: entry.bytes.byteLength, uploaded: entry.uploaded })),
      truncated: false,
    }),
  };
}

const jpeg = (seed = 1, size = 64) => {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  bytes[size - 1] = seed;
  return bytes;
};
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

let kv;
let bucket;
let env;
let seeded;

beforeEach(() => {
  kv = makeKv();
  bucket = makeBucket();
  env = { PROFILES: kv, CARD_ASSETS: bucket, SESSION_SIGNING_KEY: SIGNING_KEY, ENTITLEMENT_ENFORCE: '1' };
  seeded = null;
});

/**
 * Activate one device on the test's club, as `uid` with `role`. The club is
 * seeded on the first call, so every device in a test joins the same one.
 */
async function activated({ uid, role } = {}) {
  seeded ??= await createClubFromPending(
    env,
    { clubName: 'Downtown Speakers', uid: 'buyer-uid' },
    { code: 'DTSP7K2QM9' }
  );
  const { clubId } = seeded;
  if (uid && role) {
    await kv.put(clubMemberKey(clubId, uid), JSON.stringify({ role, displayName: null, addedAt: 1, revokedAt: null }));
  }
  const res = await handleClubActivate(
    new Request('https://x/api/club/activate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(uid ? { authorization: `Bearer ${mintSessionToken(uid, SIGNING_KEY)}` } : {}),
      },
      body: JSON.stringify({ code: 'DTSP-7K2QM9' }),
    }),
    env
  );
  const body = await res.json();
  return { clubId, ...body, claims: verifyClubToken(body.clubToken, SIGNING_KEY) };
}

const headers = (clubToken, uid) => ({
  ...(clubToken ? { 'x-club': clubToken } : {}),
  ...(uid ? { authorization: `Bearer ${mintSessionToken(uid, SIGNING_KEY)}` } : {}),
});

const upload = (clubToken, uid, bytes, hash = sha(bytes)) =>
  handleClubCards(
    new Request(`https://x/api/club/cards/${hash}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg', ...headers(clubToken, uid) },
      body: bytes,
    }),
    `cards/${hash}`,
    env
  );

const publish = (clubToken, uid, body) =>
  handleClubCards(
    new Request('https://x/api/club/cards', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers(clubToken, uid) },
      body: JSON.stringify(body),
    }),
    'cards',
    env
  );

const download = (clubToken, hash, uid) =>
  handleClubCards(new Request(`https://x/api/club/cards/${hash}`, { headers: headers(clubToken, uid) }), `cards/${hash}`, env);

const remove = (clubToken, uid) =>
  handleClubCards(new Request('https://x/api/club/cards', { method: 'DELETE', headers: headers(clubToken, uid) }), 'cards', env);

const clubState = async (clubToken) =>
  (await handleClubState(new Request('https://x/api/club', { headers: { 'x-club': clubToken } }), env)).json();

// ---------------------------------------------------------------------------

describe('sniffImageType', () => {
  it('reads JPEG, PNG and WebP from their bytes', () => {
    expect(sniffImageType(jpeg())).toBe('image/jpeg');
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
  });

  // Same origin as every session cookie: an SVG is a document that can carry script.
  it('refuses SVG and anything else', () => {
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('normalizeCardSet', () => {
  const hash = 'a'.repeat(64);

  it('keeps known colours and a trimmed label', () => {
    expect(normalizeCardSet({ label: '  Club cards ', images: { blue: hash, red: hash } })).toEqual({
      label: 'Club cards',
      images: { blue: hash, red: hash },
    });
    expect(normalizeCardSet({ images: { green: hash } })).toEqual({ label: null, images: { green: hash } });
  });

  it('refuses an empty set, an unknown colour, or a hash that is not a digest', () => {
    expect(normalizeCardSet({ images: {} })).toBeNull();
    expect(normalizeCardSet({ images: { purple: hash } })).toBeNull();
    expect(normalizeCardSet({ images: { blue: '../../club/x' } })).toBeNull();
    expect(normalizeCardSet(null)).toBeNull();
  });

  it('caps the label', () => {
    expect(normalizeCardSet({ label: 'x'.repeat(100), images: { blue: hash } }).label).toHaveLength(40);
  });
});

describe('cardSetUnchanged', () => {
  it('compares label and every colour', () => {
    const a = { label: null, images: { blue: 'a'.repeat(64) } };
    expect(cardSetUnchanged(null, a)).toBe(false);
    expect(cardSetUnchanged({ ...a, publishedAt: 1 }, a)).toBe(true);
    expect(cardSetUnchanged(a, { ...a, label: 'New' })).toBe(false);
    expect(cardSetUnchanged(a, { label: null, images: { blue: 'a'.repeat(64), red: 'b'.repeat(64) } })).toBe(false);
  });
});

describe('PUT /api/club/cards/<hash>', () => {
  it('stores an editor\'s image under the club-card prefix, typed from its bytes', async () => {
    const { clubToken, clubId } = await activated({ uid: 'editor-uid', role: 'editor' });
    const bytes = jpeg();
    const res = await upload(clubToken, 'editor-uid', bytes);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: true, deduped: false });
    const stored = bucket.store.get(clubCardObjectKey(clubId, sha(bytes)));
    expect(stored.options.httpMetadata.contentType).toBe('image/jpeg');

    // A retry is free.
    expect(await (await upload(clubToken, 'editor-uid', bytes)).json()).toEqual({ stored: true, deduped: true });
  });

  // Uploading spends the club's quota and feeds a publish, so it needs the same
  // person-level role a publish does.
  it('needs a uid, a club, and an admin or editor role', async () => {
    const { clubToken } = await activated({ uid: 'member-uid', role: 'member' });
    expect((await upload(clubToken, null, jpeg())).status).toBe(401);
    expect((await upload(null, 'member-uid', jpeg())).status).toBe(401);
    expect((await upload(clubToken, 'member-uid', jpeg())).status).toBe(403);
  });

  it('refuses a revoked device on the very next request', async () => {
    const { clubToken, clubId, claims } = await activated({ uid: 'editor-uid', role: 'editor' });
    const device = JSON.parse(kv.store.get(clubDeviceKey(clubId, claims.deviceId)));
    await kv.put(clubDeviceKey(clubId, claims.deviceId), JSON.stringify({ ...device, revokedAt: Date.now() }));
    expect((await upload(clubToken, 'editor-uid', jpeg())).status).toBe(403);
  });

  it('refuses a lapsed club with the upgrade answer', async () => {
    const { clubToken, clubId } = await activated({ uid: 'editor-uid', role: 'editor' });
    const club = JSON.parse(kv.store.get(clubKey(clubId)));
    await kv.put(clubKey(clubId), JSON.stringify({ ...club, status: 'canceled', currentPeriodEnd: Date.now() - 1000 }));
    expect((await upload(clubToken, 'editor-uid', jpeg())).status).toBe(402);
  });

  it('refuses bytes that do not match their name, are not an image, or are too large', async () => {
    const { clubToken } = await activated({ uid: 'editor-uid', role: 'editor' });
    expect((await upload(clubToken, 'editor-uid', jpeg(1), sha(jpeg(2)))).status).toBe(400);
    expect((await upload(clubToken, 'editor-uid', new TextEncoder().encode('<svg/>'))).status).toBe(415);
    expect((await upload(clubToken, 'editor-uid', jpeg(1, MAX_CARD_BYTES + 1))).status).toBe(413);
    expect(bucket.store.size).toBe(0);
  });

  it('stops at the club quota', async () => {
    const { clubToken, clubId } = await activated({ uid: 'editor-uid', role: 'editor' });
    bucket.store.set(clubCardObjectKey(clubId, 'f'.repeat(64)), {
      bytes: new Uint8Array(20 * 1024 * 1024 - 10),
      uploaded: new Date(),
    });
    expect((await upload(clubToken, 'editor-uid', jpeg())).status).toBe(507);
  });
});

describe('PUT /api/club/cards', () => {
  it('publishes uploaded images, bumps ver, and every device sees the set', async () => {
    const { clubToken, ver } = await activated({ uid: 'editor-uid', role: 'editor' });
    const blue = jpeg(1);
    const red = jpeg(2);
    await upload(clubToken, 'editor-uid', blue);
    await upload(clubToken, 'editor-uid', red);

    const res = await publish(clubToken, 'editor-uid', { label: 'Club cards', images: { blue: sha(blue), red: sha(red) } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ver).toBe(ver + 1);
    expect(body.cards).toMatchObject({ label: 'Club cards', images: { blue: sha(blue), red: sha(red) }, publishedBy: 'editor-uid' });

    const guest = await activated();
    const state = await clubState(guest.clubToken);
    expect(state.ver).toBe(ver + 1);
    expect(state.cards.images).toEqual({ blue: sha(blue), red: sha(red) });
  });

  // A set naming an image that is not stored would be a card no device can load.
  it('refuses a set whose images were never uploaded', async () => {
    const { clubToken } = await activated({ uid: 'editor-uid', role: 'editor' });
    const res = await publish(clubToken, 'editor-uid', { images: { blue: 'a'.repeat(64) } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'missing_images', missing: ['a'.repeat(64)] });
  });

  it('writes nothing for an identical publish', async () => {
    const { clubToken, clubId } = await activated({ uid: 'editor-uid', role: 'editor' });
    const blue = jpeg();
    await upload(clubToken, 'editor-uid', blue);
    const first = await (await publish(clubToken, 'editor-uid', { images: { blue: sha(blue) } })).json();
    const again = await (await publish(clubToken, 'editor-uid', { images: { blue: sha(blue) } })).json();
    expect(again.ver).toBe(first.ver);
    expect(JSON.parse(kv.store.get(clubKey(clubId))).ver).toBe(first.ver);
  });

  it('refuses a member, and a body that is not a set', async () => {
    const { clubToken } = await activated({ uid: 'member-uid', role: 'member' });
    expect((await publish(clubToken, 'member-uid', { images: { blue: 'a'.repeat(64) } })).status).toBe(403);
    const editor = await activated({ uid: 'editor-uid', role: 'editor' });
    expect((await publish(editor.clubToken, 'editor-uid', { images: { purple: 'a'.repeat(64) } })).status).toBe(400);
  });

  // Old sets go; uploads still waiting for someone else's publish stay.
  it('prunes images no set names any more, sparing recent uploads', async () => {
    const { clubToken, clubId } = await activated({ uid: 'editor-uid', role: 'editor' });
    const old = jpeg(1);
    const pending = jpeg(2);
    const current = jpeg(3);
    for (const bytes of [old, pending, current]) await upload(clubToken, 'editor-uid', bytes);
    bucket.store.get(clubCardObjectKey(clubId, sha(old))).uploaded = new Date(Date.now() - PRUNE_GRACE_MS - 1000);

    await publish(clubToken, 'editor-uid', { images: { blue: sha(current) } });
    expect(bucket.store.has(clubCardObjectKey(clubId, sha(old)))).toBe(false);
    expect(bucket.store.has(clubCardObjectKey(clubId, sha(pending)))).toBe(true);
    expect(bucket.store.has(clubCardObjectKey(clubId, sha(current)))).toBe(true);
  });
});

describe('GET /api/club/cards/<hash>', () => {
  it('serves the image to any device holding the club, privately', async () => {
    const { clubToken } = await activated({ uid: 'editor-uid', role: 'editor' });
    const bytes = jpeg();
    await upload(clubToken, 'editor-uid', bytes);

    const guest = await activated();
    const res = await download(guest.clubToken, sha(bytes));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toContain('private');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it('needs a club, and only reaches that club\'s images', async () => {
    const { clubToken, clubId } = await activated({ uid: 'editor-uid', role: 'editor' });
    expect((await download(null, 'a'.repeat(64))).status).toBe(401);
    // Someone else's club holds this hash; ours does not.
    bucket.store.set(clubCardObjectKey('other-club', 'b'.repeat(64)), { bytes: jpeg(), uploaded: new Date() });
    expect((await download(clubToken, 'b'.repeat(64))).status).toBe(404);
    expect(clubId).not.toBe('other-club');
  });

  // The console may hold no club token: an admin's sign-in is enough.
  it('serves the console an admin signed in without a club token', async () => {
    const { clubToken } = await activated({ uid: 'buyer-uid' });
    const bytes = jpeg();
    await upload(clubToken, 'buyer-uid', bytes);
    expect((await download(null, sha(bytes), 'buyer-uid')).status).toBe(200);
  });

  // `/api/club-assets/*` is public and serves anything under `club/<clubId>/`.
  it('is not reachable through the public club-assets route', async () => {
    const { clubToken, clubId } = await activated({ uid: 'editor-uid', role: 'editor' });
    const bytes = jpeg();
    await upload(clubToken, 'editor-uid', bytes);
    const res = await worker.fetch(
      new Request(`https://timer.simple-tech.app/api/club-assets/${clubId}/${sha(bytes)}`, {
        headers: { host: 'timer.simple-tech.app' },
      }),
      env,
      { waitUntil: () => {} }
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/club/cards', () => {
  it('lets an admin take the set down, bumping ver', async () => {
    const { clubToken, clubId } = await activated({ uid: 'buyer-uid' });
    const bytes = jpeg();
    await upload(clubToken, 'buyer-uid', bytes);
    const published = await (await publish(clubToken, 'buyer-uid', { images: { blue: sha(bytes) } })).json();

    const res = await remove(clubToken, 'buyer-uid');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ver: published.ver + 1, cards: null });
    expect(kv.store.has(clubCardsKey(clubId))).toBe(false);
    expect((await clubState(clubToken)).cards).toBeNull();
  });

  it('is admin only', async () => {
    const { clubToken } = await activated({ uid: 'editor-uid', role: 'editor' });
    expect((await remove(clubToken, 'editor-uid')).status).toBe(403);
    expect((await remove(null, null)).status).toBe(401);
  });
});

describe('routing', () => {
  it('dispatches /api/club/cards with the other club routes', async () => {
    const res = await worker.fetch(
      new Request('https://timer.simple-tech.app/api/club/cards', {
        method: 'PUT',
        headers: { host: 'timer.simple-tech.app', 'content-type': 'application/json' },
        body: '{}',
      }),
      env,
      { waitUntil: () => {} }
    );
    expect(res.status).toBe(401);
  });

  it('answers 404 for a name that is not a digest', async () => {
    expect((await handleClubCards(new Request('https://x/api/club/cards/..%2Fx'), 'cards/../x', env)).status).toBe(404);
  });
});
