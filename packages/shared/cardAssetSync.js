import {
  CARD_COLORS,
  cardImageKey,
  getCardImageSettings,
  readStoredCardBlobs,
  storeCardBlobs,
} from './cardImages.js';
import { notifyLocalWrite } from './storageEvents.js';

/**
 * Carrying a user's uploaded card artwork to their other devices.
 *
 * The pictures themselves go to R2, content-addressed by SHA-256, and only the
 * hashes ride along in the synced profile. They are the one thing in this app a
 * user cannot recreate if a browser evicts IndexedDB, which is why they sync at
 * all — every other setting can be redone in a minute.
 *
 * The hash map lives in its own storage key rather than inside the card
 * settings, so cardImages.js's versioned metadata format is left exactly as it
 * is. No migration, and a device that has never synced simply has no map.
 */

export const CARD_ASSET_HASHES_KEY = 'toastmaster_card_asset_hashes';
const ASSET_ENDPOINT = '/api/assets';

/**
 * SHA-256 of a Blob, as lowercase hex — the id the Worker will verify the bytes
 * against, so it has to be computed exactly the same way.
 *
 * @param {Blob} blob
 * @returns {Promise<string|null>} null where WebCrypto is unavailable
 */
export async function hashBlob(blob) {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  try {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** `{ [imageKey]: sha256 }` for every card image this user has synced. */
export function readHashMap() {
  try {
    const raw = localStorage.getItem(CARD_ASSET_HASHES_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeHashMap(map) {
  try {
    localStorage.setItem(CARD_ASSET_HASHES_KEY, JSON.stringify(map));
    notifyLocalWrite(CARD_ASSET_HASHES_KEY);
  } catch {
    // Without the map the artwork simply does not sync; nothing else breaks.
  }
}

/**
 * Every image key the user's custom sets currently reference.
 *
 * Read from the settings rather than from IndexedDB so an orphaned Blob that
 * no set points at is never uploaded.
 *
 * @returns {string[]}
 */
export function referencedImageKeys() {
  const { customSets = [] } = getCardImageSettings() ?? {};
  const keys = [];
  for (const set of customSets) {
    const colors = Array.isArray(set?.colors) ? set.colors : CARD_COLORS;
    for (const color of colors) keys.push(cardImageKey(set.id, color));
  }
  return keys;
}

/**
 * Where the Blobs come from and go to.
 *
 * Injectable because IndexedDB cannot be exercised honestly in the test
 * harness: fake-indexeddb structured-clones a Blob into a plain object with no
 * size, type or arrayBuffer, so a round trip there proves nothing about a real
 * browser. Injecting the store keeps these functions testable without loosening
 * the Blob check that production relies on.
 */
const blobStore = (config) => ({
  read: config?.readBlobs ?? readStoredCardBlobs,
  write: config?.writeBlobs ?? storeCardBlobs,
});

async function authorizedFetch(config, path, init = {}) {
  const token = config?.getToken?.();
  if (!token) return null;

  const response = await (config.fetchImpl ?? fetch)(`${ASSET_ENDPOINT}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  return response;
}

/**
 * Upload any referenced artwork the server does not have yet, and record its
 * hashes so other devices can find it.
 *
 * @returns {Promise<string[]>} image keys uploaded
 */
export async function pushCardAssets(config) {
  try {
    const blobs = await blobStore(config).read();
    const map = readHashMap();
    const uploaded = [];
    let mapChanged = false;

    for (const key of referencedImageKeys()) {
      const blob = blobs.get(key);
      if (!blob) continue;

      const hash = await hashBlob(blob);
      if (!hash) continue;
      // Already recorded under this hash: the bytes are unchanged, so the
      // server has them and there is nothing to send.
      if (map[key] === hash) continue;

      const response = await authorizedFetch(config, hash, {
        method: 'PUT',
        body: blob,
        headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      });
      if (!response?.ok) continue;

      map[key] = hash;
      mapChanged = true;
      uploaded.push(key);
    }

    if (mapChanged) writeHashMap(map);
    return uploaded;
  } catch {
    // Artwork sync is a convenience; the cards on this device still work.
    return [];
  }
}

/**
 * Fetch artwork this device is missing but the profile references.
 *
 * Runs after the profile has synced, because the hash map arrives with it —
 * that map is what says which pictures ought to be here.
 *
 * @returns {Promise<string[]>} image keys downloaded
 */
export async function pullCardAssets(config) {
  try {
    const map = readHashMap();
    if (!Object.keys(map).length) return [];

    const present = await blobStore(config).read();
    const referenced = new Set(referencedImageKeys());
    const fetched = [];

    for (const [key, hash] of Object.entries(map)) {
      // Only what a set actually points at: a stale map entry must not pull
      // down artwork nothing will ever display.
      if (!referenced.has(key) || present.has(key)) continue;
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) continue;

      const response = await authorizedFetch(config, hash, { method: 'GET' });
      if (!response?.ok) continue;

      const blob = await response.blob();
      // The server addresses by hash, but this device verifies it too: bytes
      // that do not match what was asked for never reach storage.
      if ((await hashBlob(blob)) !== hash) continue;

      fetched.push([key, blob]);
    }

    return fetched.length ? blobStore(config).write(fetched) : [];
  } catch {
    return [];
  }
}

/**
 * Reconcile this device's artwork with the server, in both directions.
 *
 * @param {Object} options
 * @param {() => string|null} options.getToken
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{uploaded: string[], downloaded: string[]}>}
 */
export async function syncCardAssets({ getToken, fetchImpl, readBlobs, writeBlobs } = {}) {
  const config = { getToken, fetchImpl, readBlobs, writeBlobs };
  if (!getToken?.()) return { uploaded: [], downloaded: [] };

  // Download first: a device that just adopted a profile should show the
  // artwork it names before offering anything of its own.
  const downloaded = await pullCardAssets(config);
  const uploaded = await pushCardAssets(config);
  return { uploaded, downloaded };
}
