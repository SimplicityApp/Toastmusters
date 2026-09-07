// Timing-card artwork selection: which set of card images the timer shows.
//
// Two built-in sets ship with the app as static files under /backgrounds; the
// organizer can also add custom sets of uploaded images. Neither app has a
// backend for uploads, so custom sets live in the browser, split across two
// stores by what each is good at:
//
//   - localStorage: the metadata — which set is selected and which colors each
//     custom set has. A few hundred bytes, read synchronously, so the render
//     and overlay paths can resolve a card without ever awaiting.
//   - IndexedDB: the image pixels, as Blobs. Megabytes live here because
//     localStorage tops out around 5MB and blocks the main thread for reads
//     proportional to payload size; IndexedDB stores Blobs natively (no base64
//     tax) and reads them off the main thread.
//
// initCardImages() bridges the two: it loads the stored Blobs once, turns them
// into object URLs, and keeps those in an in-memory map that the synchronous
// resolver reads. Until it resolves, custom sets fall back to the built-in
// files — the same thing a user sees before customizing anything.
//
// Earlier versions kept the images as data: URLs inside localStorage; init
// migrates that data into IndexedDB and keeps serving the data URLs for the
// rest of the session, so migration is invisible.

import { notifyLocalWrite } from './storageEvents.js';
const SETTINGS_KEY = 'toastmaster_custom_card_images';
const SETTINGS_VERSION = 3;

const DB_NAME = 'toastmaster-timer';
const DB_VERSION = 1;
const IMAGE_STORE = 'card-images';

// The organizer's own virtual background, uploaded here so the app can put it
// back without asking Zoom for it.
//
// Everything the restore path could not do reliably came from not knowing what
// to put back: getCurrentVirtualBackground names a background by an id that
// getVirtualBackgroundData need not accept, none of those three APIs is in the
// shipped SDK typing, and a client may grant none of them. Held here, the
// pixels are ours — the restore needs no getter, cannot pick the wrong
// background, and cannot fall through to None.
//
// Shares the image store with the card sets, under a key no set can collide
// with: set keys are `${setId}:${color}` and every setId starts with 'custom-'.
// Its own localStorage flag rather than a field in the card settings, because
// that object is normalized down to known fields and deleted outright when it
// holds nothing but defaults.
const OWN_BACKGROUND_IMAGE_KEY = 'own-background';
const OWN_BACKGROUND_FLAG_KEY = 'toastmaster_own_background';

export const CARD_COLORS = ['blue', 'green', 'yellow', 'red'];

// Cache-buster for the built-in files. They are served with
// `max-age=31536000, immutable`, so this must be bumped whenever their
// content changes or existing clients keep the old asset for a year.
export const CARD_ASSET_VERSION = '3';

// The built-in sets, in the order the picker shows them. File names are
// relative to the backgrounds directory each app serves them from.
export const DEFAULT_CARD_SETS = [
  {
    id: 'classic',
    label: 'Classic',
    files: {
      blue: 'timer-blue-background.png',
      green: 'timer-green-background.png',
      yellow: 'timer-yellow-background.png',
      red: 'timer-red-background.png',
    },
  },
  {
    id: 'modern',
    label: 'Modern',
    files: {
      blue: 'timer-blue-modern.png',
      green: 'timer-green-modern.png',
      yellow: 'timer-yellow-modern.png',
      red: 'timer-red-modern.png',
    },
  },
];

const DEFAULT_SET_ID = DEFAULT_CARD_SETS[0].id;
const CLASSIC_FILES = DEFAULT_CARD_SETS[0].files;

function getDefaultCardSet(id) {
  return DEFAULT_CARD_SETS.find((set) => set.id === id) || null;
}

function isCardDataUrl(value) {
  return typeof value === 'string' && value.startsWith('data:image/');
}

// Uploads are re-encoded to fit this box before storing. 1280x720 matches the
// built-in cards and the Zoom overlay pipeline's own working size; anything
// larger would only be downscaled again on every push.
const CARD_MAX_WIDTH = 1280;
const CARD_MAX_HEIGHT = 720;
const CARD_JPEG_QUALITY = 0.85;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

// Metadata: { selectedSetId, customSets: [{ id, colors: [...] }] }.
let settingsCache = null;

// `${setId}:${color}` -> a displayable URL: an object URL minted from the
// stored Blob, or a legacy data URL still being served out of localStorage.
const imageUrlCache = new Map();

let initPromise = null;
let dbPromise = null;

function imageKey(setId, color) {
  return `${setId}:${color}`;
}

// ---------------------------------------------------------------------------
// Metadata (localStorage)
// ---------------------------------------------------------------------------

function normalizeMeta(raw) {
  const meta = { selectedSetId: DEFAULT_SET_ID, customSets: [] };
  if (!raw || typeof raw !== 'object') return meta;

  if (Array.isArray(raw.customSets)) {
    for (const set of raw.customSets) {
      if (!set || typeof set.id !== 'string' || !set.id.startsWith('custom-')) continue;
      const colors = CARD_COLORS.filter((color) => set.colors?.includes(color));
      if (colors.length > 0 && !meta.customSets.some((s) => s.id === set.id)) {
        meta.customSets.push({ id: set.id, colors });
      }
    }
  }

  const selected = raw.selectedSetId;
  if (getDefaultCardSet(selected) || meta.customSets.some((s) => s.id === selected)) {
    meta.selectedSetId = selected;
  }
  return meta;
}

/**
 * Parse whatever is in localStorage into current-format metadata, plus any
 * image payloads still stored inline by the two earlier formats: v1 was a
 * plain color -> data URL map, v2 kept data URLs inside customSets[].images.
 * Inline images are returned so init can move them into IndexedDB; they are
 * also seeded into the URL cache, so legacy data keeps displaying without
 * waiting for init at all.
 */
function readStoredState() {
  const inlineImages = new Map();
  let meta = normalizeMeta(null);
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (!('customSets' in parsed) && !('selectedSetId' in parsed)) {
          // v1: per-color overrides at the top level.
          const colors = CARD_COLORS.filter((color) => isCardDataUrl(parsed[color]));
          if (colors.length > 0) {
            meta = normalizeMeta({ selectedSetId: 'custom-1', customSets: [{ id: 'custom-1', colors }] });
            for (const color of colors) inlineImages.set(imageKey('custom-1', color), parsed[color]);
          }
        } else {
          // v2 sets carry images inline; v3 carries colors lists only.
          const sets = Array.isArray(parsed.customSets) ? parsed.customSets : [];
          meta = normalizeMeta({
            selectedSetId: parsed.selectedSetId,
            customSets: sets.map((set) => ({
              id: set?.id,
              colors: Array.isArray(set?.colors)
                ? set.colors
                : CARD_COLORS.filter((color) => isCardDataUrl(set?.images?.[color])),
            })),
          });
          for (const set of sets) {
            if (!set || typeof set.id !== 'string') continue;
            for (const color of CARD_COLORS) {
              if (isCardDataUrl(set.images?.[color])) inlineImages.set(imageKey(set.id, color), set.images[color]);
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Failed to load card image settings:', error);
  }

  for (const [key, dataUrl] of inlineImages) {
    if (!imageUrlCache.has(key)) imageUrlCache.set(key, dataUrl);
  }
  settingsCache = meta;
  return { meta, inlineImages };
}

/**
 * The stored settings metadata, cached: which set is selected and which
 * colors each custom set has. Synchronous, so hot paths (status changes, page
 * background updates) can call it freely. Image URLs come from
 * resolveCardImage / getCustomCardImage instead.
 */
export function getCardImageSettings() {
  if (settingsCache === null) readStoredState();
  return settingsCache;
}

function writeSettings(meta) {
  const normalized = normalizeMeta(meta);
  try {
    if (normalized.selectedSetId === DEFAULT_SET_ID && normalized.customSets.length === 0) {
      localStorage.removeItem(SETTINGS_KEY);
      notifyLocalWrite(SETTINGS_KEY);
    } else {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ version: SETTINGS_VERSION, ...normalized }));
      notifyLocalWrite(SETTINGS_KEY);
    }
    settingsCache = normalized;
    return true;
  } catch (error) {
    console.error('Failed to save card image settings:', error);
    // The cache must keep describing what is actually stored.
    settingsCache = null;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Image store (IndexedDB)
// ---------------------------------------------------------------------------

/**
 * Open (and create) the image database. Resolves null when IndexedDB is
 * missing or refuses to open — the app then runs with the built-in sets, and
 * legacy inline images keep working straight from localStorage.
 */
function openImageDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      console.error('Failed to open the card image database:', error);
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IMAGE_STORE)) {
        request.result.createObjectStore(IMAGE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      console.error('Failed to open the card image database:', request.error);
      resolve(null);
    };
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** Run one IndexedDB transaction over the image store as a promise. */
function imageTx(db, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE, mode);
    const result = work(tx.objectStore(IMAGE_STORE));
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error);
  });
}

function idbPutMany(db, entries) {
  return imageTx(db, 'readwrite', (store) => {
    for (const [key, blob] of entries) store.put(blob, key);
  });
}

function idbDeleteMany(db, keys) {
  return imageTx(db, 'readwrite', (store) => {
    for (const key of keys) store.delete(key);
  });
}

function idbGetAllEntries(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE, 'readonly');
    const store = tx.objectStore(IMAGE_STORE);
    const keysReq = store.getAllKeys();
    const valuesReq = store.getAll();
    tx.oncomplete = () => {
      const entries = new Map();
      keysReq.result.forEach((key, i) => entries.set(key, valuesReq.result[i]));
      resolve(entries);
    };
    tx.onerror = () => reject(tx.error);
  });
}

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const type = header.slice(5, header.indexOf(';') > -1 ? header.indexOf(';') : header.length) || 'image/jpeg';
  const bytesText = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bytesText.length);
  for (let i = 0; i < bytesText.length; i++) bytes[i] = bytesText.charCodeAt(i);
  return new Blob([bytes], { type });
}

// Duck-typed rather than `instanceof Blob`: the structured clone coming back
// out of IndexedDB may be a Blob from another realm (worker, test harness),
// which fails instanceof while being perfectly usable.
function isBlobLike(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.size === 'number' &&
    typeof value.type === 'string' &&
    typeof value.arrayBuffer === 'function'
  );
}

function cacheBlobUrl(key, blob) {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  imageUrlCache.set(key, URL.createObjectURL(blob));
}

function revokeCached(key) {
  const url = imageUrlCache.get(key);
  if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
  imageUrlCache.delete(key);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Load the custom card images into memory: migrate any legacy inline data
 * URLs into IndexedDB, mint object URLs for the stored Blobs, and sweep
 * orphaned Blobs no set references. Idempotent — every caller shares one run.
 * Never rejects; on any failure the app keeps working with the built-in sets.
 *
 * Call this once at app startup, before custom sets are expected to show;
 * until it resolves, resolveCardImage falls back to the built-in files.
 */
export function initCardImages() {
  if (!initPromise) {
    initPromise = loadImagesIntoCache().catch((error) => {
      console.error('Failed to initialize card images:', error);
    });
  }
  return initPromise;
}

async function loadImagesIntoCache() {
  const { meta, inlineImages } = readStoredState();
  const db = await openImageDb();
  if (!db) return;

  // Migrate legacy inline payloads: pixels to IndexedDB, metadata-only to
  // localStorage. The already-seeded data URLs keep serving this session.
  if (inlineImages.size > 0) {
    const entries = [];
    for (const [key, dataUrl] of inlineImages) {
      try {
        entries.push([key, dataUrlToBlob(dataUrl)]);
      } catch {
        // A corrupt entry migrates as a dropped color rather than a failure.
      }
    }
    await idbPutMany(db, entries);
    writeSettings(meta);
  }

  const stored = await idbGetAllEntries(db);

  // Object URLs for every set the metadata lists — all sets, not just the
  // selected one, because the picker shows thumbnails of each. Object URLs
  // are handles, not copies; the bytes stay in IndexedDB until decoded.
  const referenced = new Set();
  // Not referenced by any card set, and swept as an orphan without this.
  if (hasOwnBackground()) {
    referenced.add(OWN_BACKGROUND_IMAGE_KEY);
    const blob = stored.get(OWN_BACKGROUND_IMAGE_KEY);
    if (!imageUrlCache.has(OWN_BACKGROUND_IMAGE_KEY) && isBlobLike(blob)) {
      cacheBlobUrl(OWN_BACKGROUND_IMAGE_KEY, blob);
    } else if (!isBlobLike(blob)) {
      // The flag outlived its pixels — a cleared database, a failed write. Say
      // the truth rather than promising a restore that has nothing to restore.
      writeOwnBackgroundFlag(false);
      referenced.delete(OWN_BACKGROUND_IMAGE_KEY);
    }
  }
  for (const set of getCardImageSettings().customSets) {
    for (const color of set.colors) {
      const key = imageKey(set.id, color);
      referenced.add(key);
      if (!imageUrlCache.has(key) && isBlobLike(stored.get(key))) {
        cacheBlobUrl(key, stored.get(key));
      }
    }
  }

  // A crash between a Blob write and its metadata write leaves orphans;
  // they are invisible, so sweep them here rather than letting them pile up.
  const orphans = [...stored.keys()].filter((key) => !referenced.has(key));
  if (orphans.length > 0) await idbDeleteMany(db, orphans);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The image the selected set shows for a color: a displayable URL for an
 * uploaded image, or the file name of a built-in card. Synchronous — a custom
 * color whose Blob has not been loaded (init still running, or storage
 * failed) falls back to the classic file, and an unknown color falls back to
 * blue, the card the timer opens on.
 *
 * @param {string} color
 * @returns {{url: string} | {file: string}}
 */
export function resolveCardImage(color) {
  const { selectedSetId } = getCardImageSettings();
  const defaultSet = getDefaultCardSet(selectedSetId);
  if (defaultSet) {
    return { file: defaultSet.files[color] || defaultSet.files.blue };
  }
  const url = imageUrlCache.get(imageKey(selectedSetId, color));
  if (url) return { url };
  return { file: CLASSIC_FILES[color] || CLASSIC_FILES.blue };
}

/**
 * The uploaded image of one custom set for one color, as a displayable URL —
 * what the picker uses for thumbnails. Null when the set has no upload for
 * that color, or its Blob is not loaded (yet).
 */
export function getCustomCardImage(setId, color) {
  return imageUrlCache.get(imageKey(setId, color)) || null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Select which set the timer shows. Metadata-only, so it is synchronous.
 * @returns {boolean} false when the id names no existing set or storage
 *   refused the write
 */
export function selectCardSet(setId) {
  const meta = getCardImageSettings();
  if (!getDefaultCardSet(setId) && !meta.customSets.some((set) => set.id === setId)) return false;
  return writeSettings({ ...meta, selectedSetId: setId });
}

/**
 * Store a new custom set and select it. Blobs go to IndexedDB first, the
 * metadata write publishes them, and the URL cache picks them up — so a
 * failure at any step leaves at worst an orphaned Blob for init to sweep.
 *
 * @param {Object<string, Blob>} imagesByColor - color -> re-encoded upload
 * @returns {Promise<string|null>} the new set id, or null when nothing could
 *   be stored — the caller should tell the user rather than silently losing
 *   their upload
 */
export async function addCustomCardSet(imagesByColor) {
  await initCardImages();
  const colors = CARD_COLORS.filter((color) => imagesByColor?.[color] instanceof Blob);
  if (colors.length === 0) return null;

  const db = await openImageDb();
  if (!db) return null;

  const meta = getCardImageSettings();
  const id = nextCustomSetId(meta.customSets);
  try {
    await idbPutMany(db, colors.map((color) => [imageKey(id, color), imagesByColor[color]]));
  } catch (error) {
    console.error('Failed to store card images:', error);
    return null;
  }

  const nextMeta = {
    selectedSetId: id,
    customSets: [...meta.customSets, { id, colors }],
  };
  if (!writeSettings(nextMeta)) return null;

  for (const color of colors) cacheBlobUrl(imageKey(id, color), imagesByColor[color]);

  // IndexedDB is best-effort storage the browser may evict under pressure;
  // uploaded artwork is the one thing the user cannot get back, so ask for
  // persistence at the moment they store some. Chromium decides silently;
  // a refusal changes nothing today.
  try {
    navigator?.storage?.persist?.();
  } catch {
    // Unsupported — nothing to do.
  }
  return id;
}

/**
 * Delete a custom set. If it was selected, selection returns to the default
 * built-in set. The metadata write is what deletes it; Blob cleanup after it
 * is best-effort, backstopped by init's orphan sweep.
 * @returns {Promise<boolean>}
 */
export async function deleteCustomCardSet(setId) {
  await initCardImages();
  const meta = getCardImageSettings();
  const set = meta.customSets.find((s) => s.id === setId);
  if (!set) return false;

  const nextMeta = {
    selectedSetId: meta.selectedSetId === setId ? DEFAULT_SET_ID : meta.selectedSetId,
    customSets: meta.customSets.filter((s) => s.id !== setId),
  };
  if (!writeSettings(nextMeta)) return false;

  const keys = set.colors.map((color) => imageKey(setId, color));
  for (const key of keys) revokeCached(key);
  const db = await openImageDb();
  if (db) {
    try {
      await idbDeleteMany(db, keys);
    } catch (error) {
      console.error('Failed to delete stored card images:', error);
    }
  }
  return true;
}

/**
 * An id no existing custom set uses.
 */
export function nextCustomSetId(customSets) {
  let n = 1;
  const taken = new Set((customSets || []).map((set) => set.id));
  while (taken.has(`custom-${n}`)) n += 1;
  return `custom-${n}`;
}

/**
 * Turn an uploaded file into the Blob the store takes: decoded, scaled to fit
 * the card box, and re-encoded as JPEG. Re-encoding is not optional — a phone
 * photo is many MB and would cost storage and decode time on every overlay
 * push, and re-encoding also strips whatever metadata the file carried.
 *
 * @param {File|Blob} file - The upload, any image type the browser decodes
 * @returns {Promise<Blob>} JPEG blob ready for addCustomCardSet
 */
export function fileToCardBlob(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const { naturalWidth: width, naturalHeight: height } = img;
      if (!width || !height) {
        reject(new Error('The file did not decode as an image'));
        return;
      }
      const scale = Math.min(1, CARD_MAX_WIDTH / width, CARD_MAX_HEIGHT / height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext('2d');
      // JPEG has no alpha, so transparency would encode as black; white is
      // what a transparent logo on a timing card is drawn against.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('The image could not be re-encoded'))),
        'image/jpeg',
        CARD_JPEG_QUALITY
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('The file could not be read as an image'));
    };
    img.src = objectUrl;
  });
}

// ---------------------------------------------------------------------------
// The organizer's own background
// ---------------------------------------------------------------------------

function writeOwnBackgroundFlag(present) {
  try {
    if (present) localStorage.setItem(OWN_BACKGROUND_FLAG_KEY, '1');
    else localStorage.removeItem(OWN_BACKGROUND_FLAG_KEY);
  } catch (error) {
    console.error('Failed to record the own-background setting:', error);
  }
}

/**
 * Whether the organizer has given the app a background of their own to put
 * back. Synchronous and available before init, because the restore path has to
 * decide which strategy it is using without awaiting anything.
 *
 * True here is a promise about intent, not about pixels: init drops the flag if
 * the image behind it has gone, and getOwnBackgroundUrl answers null until the
 * blob is loaded.
 *
 * @returns {boolean}
 */
export function hasOwnBackground() {
  try {
    return localStorage.getItem(OWN_BACKGROUND_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The organizer's own background as a displayable URL, or null when none is
 * set or its Blob is not loaded yet (init still running, or storage failed).
 * @returns {string|null}
 */
export function getOwnBackgroundUrl() {
  return imageUrlCache.get(OWN_BACKGROUND_IMAGE_KEY) || null;
}

/**
 * Store the organizer's own background and start using it.
 *
 * Blob first, flag second: a failure between the two leaves an orphan for init
 * to sweep, where the reverse would leave a flag promising a restore with no
 * pixels behind it.
 *
 * @param {Blob} blob - Re-encoded upload, from fileToCardBlob
 * @returns {Promise<boolean>} false when nothing could be stored
 */
export async function saveOwnBackground(blob) {
  const db = await openImageDb();
  if (!db || !isBlobLike(blob)) return false;
  try {
    await idbPutMany(db, [[OWN_BACKGROUND_IMAGE_KEY, blob]]);
  } catch (error) {
    console.error('Failed to store the own background:', error);
    return false;
  }
  revokeCached(OWN_BACKGROUND_IMAGE_KEY);
  cacheBlobUrl(OWN_BACKGROUND_IMAGE_KEY, blob);
  writeOwnBackgroundFlag(true);
  return true;
}

/**
 * Forget the organizer's own background, returning the restore path to reading
 * what Zoom reports. The flag goes first here: once it is down nothing will
 * look for the pixels, so a failed delete is an orphan rather than a promise
 * the app cannot keep.
 *
 * @returns {Promise<void>}
 */
export async function clearOwnBackground() {
  writeOwnBackgroundFlag(false);
  revokeCached(OWN_BACKGROUND_IMAGE_KEY);
  const db = await openImageDb();
  if (!db) return;
  try {
    await idbDeleteMany(db, [OWN_BACKGROUND_IMAGE_KEY]);
  } catch (error) {
    console.error('Failed to delete the own background:', error);
  }
}

// ---------------------------------------------------------------------------
// Blob access for cross-device sync
// ---------------------------------------------------------------------------
//
// Uploaded artwork is the one thing a user cannot get back if this device loses
// it, so it follows them to their other machines. The sync layer needs to read
// the Blobs to upload them and write Blobs it downloaded; everything else about
// how they are stored stays private to this module.

/**
 * The IndexedDB key for one card of one set. Exported so the sync layer can
 * name the same Blob this module does without duplicating the format.
 *
 * @param {string} setId
 * @param {string} color
 * @returns {string}
 */
export function cardImageKey(setId, color) {
  return imageKey(setId, color);
}

/**
 * Every stored card Blob, keyed as above.
 *
 * @returns {Promise<Map<string, Blob>>} empty when IndexedDB is unavailable
 */
export async function readStoredCardBlobs() {
  const db = await openImageDb();
  if (!db) return new Map();

  try {
    const entries = await idbGetAllEntries(db);
    const blobs = new Map();
    for (const [key, value] of entries) {
      if (isBlobLike(value)) blobs.set(key, value);
    }
    return blobs;
  } catch {
    return new Map();
  }
}

/**
 * Store Blobs fetched from another device and publish them to the UI.
 *
 * The object-URL cache is refreshed here rather than left to the next init, so
 * artwork that arrives after startup appears without a reload.
 *
 * @param {Array<[string, Blob]>} entries - [imageKey, Blob]
 * @returns {Promise<string[]>} keys actually stored
 */
export async function storeCardBlobs(entries) {
  const usable = entries.filter(([key, blob]) => key && isBlobLike(blob));
  if (usable.length === 0) return [];

  const db = await openImageDb();
  if (!db) return [];

  try {
    await idbPutMany(db, usable);
  } catch (error) {
    console.error('Failed to store synced card images:', error);
    return [];
  }

  for (const [key, blob] of usable) {
    revokeCached(key);
    cacheBlobUrl(key, blob);
  }
  return usable.map(([key]) => key);
}
