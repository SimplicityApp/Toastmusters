import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

const blobOf = (text) => new Blob([text], { type: 'image/jpeg' });

/**
 * An in-memory stand-in for the IndexedDB blob store.
 *
 * Necessary rather than convenient: fake-indexeddb structured-clones a Blob
 * into a plain object with no size, type or arrayBuffer, so a real round trip
 * through it proves nothing about a browser and the Blob check correctly
 * rejects what comes back. The sync module takes the store as an injected
 * dependency for exactly this reason.
 */
function makeBlobStore(initial = []) {
  const blobs = new Map(initial);
  return {
    blobs,
    readBlobs: async () => blobs,
    writeBlobs: async (entries) => {
      for (const [key, blob] of entries) blobs.set(key, blob);
      return entries.map(([key]) => key);
    },
  };
}

const withStore = (fetchImpl, store, token = 'tok') => ({
  getToken: () => token,
  fetchImpl,
  readBlobs: store.readBlobs,
  writeBlobs: store.writeBlobs,
});

/**
 * cardImages.js caches its settings and its IndexedDB handle at module scope,
 * so clearing storage is not enough to isolate a test — the modules have to be
 * reloaded too. Same approach the Zoom SDK suite uses for the same reason.
 */
async function loadModules() {
  vi.resetModules();
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();

  const cardImages = await import('../cardImages.js');
  const cardAssetSync = await import('../cardAssetSync.js');
  return { ...cardImages, ...cardAssetSync };
}

/** A bucket keyed by hash, standing in for the Worker's R2-backed endpoint. */
function makeServer() {
  const stored = new Map();
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const hash = String(url).split('/').pop();
    if ((init.method ?? 'GET') === 'PUT') {
      stored.set(hash, init.body);
      return { ok: true, json: async () => ({ stored: true }) };
    }
    const found = stored.get(hash);
    return found
      ? { ok: true, blob: async () => found }
      : { ok: false, status: 404, blob: async () => null };
  });
  return { stored, fetchImpl };
}

/**
 * Register a custom set and hand back a blob store holding its artwork —
 * the state a device has after someone uploads cards.
 */
async function withCustomSet(mod, imagesByColor) {
  const setId = await mod.addCustomCardSet(imagesByColor);
  const store = makeBlobStore(
    Object.entries(imagesByColor).map(([color, blob]) => [mod.cardImageKey(setId, color), blob])
  );
  return { setId, store };
}

let mod;
beforeEach(async () => {
  mod = await loadModules();
});

describe('hashBlob', () => {
  it('hashes to lowercase hex the Worker can verify', async () => {
    expect(await mod.hashBlob(blobOf('some bytes'))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same hash for the same bytes and a different one otherwise', async () => {
    expect(await mod.hashBlob(blobOf('a'))).toBe(await mod.hashBlob(blobOf('a')));
    expect(await mod.hashBlob(blobOf('a'))).not.toBe(await mod.hashBlob(blobOf('b')));
  });
});

describe('readHashMap', () => {
  it('is empty on a device that has never synced', () => {
    expect(mod.readHashMap()).toEqual({});
  });

  it('degrades a corrupt map to empty rather than throwing', () => {
    for (const junk of ['not json', '[]', 'null', '42']) {
      localStorage.setItem(mod.CARD_ASSET_HASHES_KEY, junk);
      expect(mod.readHashMap()).toEqual({});
    }
  });
});

describe('referencedImageKeys', () => {
  it('is empty when the user has no custom sets', () => {
    expect(mod.referencedImageKeys()).toEqual([]);
  });

  it('names one key per colour in each custom set', async () => {
    const { setId } = await withCustomSet(mod, { green: blobOf('g'), red: blobOf('r') });

    expect(mod.referencedImageKeys()).toEqual(
      expect.arrayContaining([mod.cardImageKey(setId, 'green'), mod.cardImageKey(setId, 'red')])
    );
  });
});

describe('pushCardAssets', () => {
  it('uploads referenced artwork and records its hashes', async () => {
    const { setId, store } = await withCustomSet(mod, {
      green: blobOf('green art'),
      red: blobOf('red art'),
    });
    const { fetchImpl, stored } = makeServer();

    const uploaded = await mod.pushCardAssets(withStore(fetchImpl, store));

    expect(uploaded).toContain(mod.cardImageKey(setId, 'green'));
    expect(stored.size).toBe(2);
    expect(mod.readHashMap()[mod.cardImageKey(setId, 'green')]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not re-upload bytes it has already recorded', async () => {
    const { store } = await withCustomSet(mod, { green: blobOf('green art') });
    const { fetchImpl } = makeServer();
    await mod.pushCardAssets(withStore(fetchImpl, store));
    fetchImpl.mockClear();

    await mod.pushCardAssets(withStore(fetchImpl, store));

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uploads nothing without a session token', async () => {
    const { store } = await withCustomSet(mod, { green: blobOf('green art') });
    const { fetchImpl } = makeServer();

    expect(
      await mod.pushCardAssets({ ...withStore(fetchImpl, store), getToken: () => null })
    ).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('records nothing when the upload is refused', async () => {
    const { store } = await withCustomSet(mod, { green: blobOf('green art') });
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 507 }));

    expect(await mod.pushCardAssets(withStore(fetchImpl, store))).toEqual([]);
    expect(mod.readHashMap()).toEqual({});
  });

  it('survives the network being gone', async () => {
    const { store } = await withCustomSet(mod, { green: blobOf('green art') });
    const fetchImpl = vi.fn(() => Promise.reject(new Error('offline')));

    await expect(mod.pushCardAssets(withStore(fetchImpl, store))).resolves.toEqual([]);
  });

  it('does not upload an orphaned blob no set references', async () => {
    const { store } = await withCustomSet(mod, { green: blobOf('green art') });
    store.blobs.set('custom-99:red', blobOf('orphan'));
    const { fetchImpl, stored } = makeServer();

    await mod.pushCardAssets(withStore(fetchImpl, store));

    expect(stored.size).toBe(1);
  });
});

describe('pullCardAssets', () => {
  // The whole point: artwork uploaded on one machine appears on another.
  it('downloads artwork the profile references but this device lacks', async () => {
    const { setId, store } = await withCustomSet(mod, { green: blobOf('shared art') });
    const { fetchImpl, stored } = makeServer();
    await mod.pushCardAssets(withStore(fetchImpl, store));
    const syncedHashes = localStorage.getItem(mod.CARD_ASSET_HASHES_KEY);
    const syncedSettings = localStorage.getItem('toastmaster_custom_card_images');
    expect(stored.size).toBe(1);

    // Device B: the synced settings arrive, but it has no artwork of its own.
    mod = await loadModules();
    localStorage.setItem(mod.CARD_ASSET_HASHES_KEY, syncedHashes);
    localStorage.setItem('toastmaster_custom_card_images', syncedSettings);
    const deviceB = makeBlobStore();

    const downloaded = await mod.pullCardAssets(withStore(fetchImpl, deviceB));

    expect(downloaded).toContain(mod.cardImageKey(setId, 'green'));
    expect(deviceB.blobs.has(mod.cardImageKey(setId, 'green'))).toBe(true);
  });

  it('downloads nothing when the map is empty', async () => {
    const { fetchImpl } = makeServer();

    expect(await mod.pullCardAssets(withStore(fetchImpl, makeBlobStore()))).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not re-download artwork it already has', async () => {
    const { store } = await withCustomSet(mod, { green: blobOf('art') });
    const { fetchImpl } = makeServer();
    await mod.pushCardAssets(withStore(fetchImpl, store));
    fetchImpl.mockClear();

    await mod.pullCardAssets(withStore(fetchImpl, store));

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores map entries that are not real digests', async () => {
    localStorage.setItem(
      mod.CARD_ASSET_HASHES_KEY,
      JSON.stringify({ 'custom-1:green': '../../etc/passwd' })
    );
    const { fetchImpl } = makeServer();

    await mod.pullCardAssets(withStore(fetchImpl, makeBlobStore()));

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not fetch artwork no set points at any more', async () => {
    localStorage.setItem(
      mod.CARD_ASSET_HASHES_KEY,
      JSON.stringify({ 'custom-99:green': 'a'.repeat(64) })
    );
    const { fetchImpl } = makeServer();

    await mod.pullCardAssets(withStore(fetchImpl, makeBlobStore()));

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // The server addresses by hash, but a client must not take that on trust.
  it('discards downloaded bytes that do not match the hash asked for', async () => {
    const { setId, store } = await withCustomSet(mod, { green: blobOf('real art') });
    const { fetchImpl } = makeServer();
    await mod.pushCardAssets(withStore(fetchImpl, store));
    const syncedHashes = localStorage.getItem(mod.CARD_ASSET_HASHES_KEY);
    const syncedSettings = localStorage.getItem('toastmaster_custom_card_images');

    mod = await loadModules();
    localStorage.setItem(mod.CARD_ASSET_HASHES_KEY, syncedHashes);
    localStorage.setItem('toastmaster_custom_card_images', syncedSettings);

    const substituting = vi.fn(async () => ({ ok: true, blob: async () => blobOf('substituted') }));
    const deviceB = makeBlobStore();
    const downloaded = await mod.pullCardAssets(withStore(substituting, deviceB));

    expect(downloaded).not.toContain(mod.cardImageKey(setId, 'green'));
    expect(deviceB.blobs.size).toBe(0);
  });
});

describe('syncCardAssets', () => {
  it('does nothing at all without a token', async () => {
    const { fetchImpl } = makeServer();

    expect(
      await mod.syncCardAssets({
        ...withStore(fetchImpl, makeBlobStore()),
        getToken: () => null,
      })
    ).toEqual({ uploaded: [], downloaded: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reconciles in both directions', async () => {
    const { store } = await withCustomSet(mod, { green: blobOf('art') });
    const { fetchImpl } = makeServer();

    const result = await mod.syncCardAssets(withStore(fetchImpl, store));

    expect(result.uploaded.length).toBeGreaterThan(0);
  });
});
