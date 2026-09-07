import { SYNCED_KEYS, fieldsToApplyLocally, normalizeProfile } from './profileMerge.js';
import { onLocalWrite } from './storageEvents.js';

/**
 * Keeping one user's settings the same on every device they run the timer from.
 *
 * localStorage stays the source of truth and the app never waits on the
 * network: this is a background reconciler, not a data layer. Offline, signed
 * out, and guest are the normal cases, not error paths — the timer has to work
 * on a laptop in a church hall with no wifi, minutes before a meeting.
 *
 * Values travel as the raw stored strings rather than parsed objects. Some keys
 * hold JSON and some hold bare scalars ('camera', 'true'), and copying the
 * string verbatim means sync never needs to know which is which — so a new
 * setting is covered by adding its key to SYNCED_KEYS and nothing else.
 */

const SYNC_META_KEY = 'toastmaster_sync_meta';
const PROFILE_ENDPOINT = '/api/profile';
const PUSH_DEBOUNCE_MS = 2000;

let pushTimer = null;
let unsubscribe = null;
// Set while remote values are being written locally, so adopting someone else's
// change does not look like a local edit and bounce straight back to the server.
let applyingRemote = false;
let config = null;

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/** When each synced key was last written on this device: `{ [key]: epochMs }`. */
function readMeta() {
  const meta = readJson(SYNC_META_KEY, {});
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
}

function writeMeta(meta) {
  try {
    localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta));
  } catch {
    // Storage full or disabled. Sync degrades to per-load pulls; the app is fine.
  }
}

/**
 * This device's view of the profile.
 *
 * A key with no value and no recorded write is left out entirely, so a fresh
 * device does not claim that every setting is "absent as of now" and delete
 * settings that exist elsewhere.
 *
 * @returns {{rev: number, fields: Object}}
 */
export function readLocalProfile() {
  const meta = readMeta();
  const fields = {};

  for (const key of SYNCED_KEYS) {
    let value = null;
    try {
      value = localStorage.getItem(key);
    } catch {
      continue;
    }
    const updatedAt = meta[key];
    if (value === null && typeof updatedAt !== 'number') continue;
    fields[key] = { value, updatedAt: typeof updatedAt === 'number' ? updatedAt : 0 };
  }

  return { rev: 0, fields };
}

/**
 * Adopt fields that are newer on the server.
 *
 * @param {Object<string, {value: any, updatedAt: number}>} fields
 * @returns {string[]} keys actually changed on this device
 */
export function applyRemoteFields(fields) {
  const meta = readMeta();
  const applied = [];

  applyingRemote = true;
  try {
    for (const [key, entry] of Object.entries(fields)) {
      try {
        if (typeof entry.value === 'string') localStorage.setItem(key, entry.value);
        else if (entry.value === null) localStorage.removeItem(key);
        else continue; // Not a shape this device wrote; leave it alone.
        meta[key] = entry.updatedAt;
        applied.push(key);
      } catch {
        // One unwritable key must not abandon the rest.
      }
    }
  } finally {
    applyingRemote = false;
  }

  if (applied.length) writeMeta(meta);
  return applied;
}

/**
 * Stamp a local edit, so the next push claims it as newer than what the server
 * holds. Called for every write announced by storageEvents.
 */
function recordLocalWrite(key, now = Date.now()) {
  const meta = readMeta();
  meta[key] = now;
  writeMeta(meta);
}

async function request(method, body) {
  const token = config?.getToken?.();
  if (!token) return null;

  const response = await (config.fetchImpl ?? fetch)(PROFILE_ENDPOINT, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) return null;
  return response.json();
}

/**
 * Fetch the stored profile and adopt anything newer than this device's copy.
 *
 * @returns {Promise<string[]>} keys adopted; empty when there was nothing to do
 */
export async function pullProfile() {
  try {
    const result = await request('GET');
    if (!result) return [];

    const toApply = fieldsToApplyLocally(readLocalProfile(), normalizeProfile(result.profile));
    return applyRemoteFields(toApply);
  } catch {
    // Offline, or no session. Nothing to tell the user: their settings are
    // already on this device and the timer does not need the network.
    return [];
  }
}

/**
 * Send this device's fields up and adopt whatever the merge decided.
 *
 * @returns {Promise<string[]>} keys the merge sent back as newer elsewhere
 */
export async function pushProfile() {
  try {
    const local = readLocalProfile();
    if (!Object.keys(local.fields).length) return [];

    const result = await request('PUT', { profile: local });
    if (!result) return [];

    // The response is the merged truth, so a value another device set more
    // recently arrives here rather than being silently lost.
    const toApply = fieldsToApplyLocally(local, normalizeProfile(result.profile));
    return applyRemoteFields(toApply);
  } catch {
    return [];
  }
}

function schedulePush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushProfile();
  }, PUSH_DEBOUNCE_MS);
}

/**
 * Start syncing.
 *
 * Pulls once, then pushes on a debounce whenever a synced key changes —
 * dragging the readout around would otherwise be one request per pixel.
 *
 * @param {Object} options
 * @param {() => string|null} options.getToken - current session token, or null
 * @param {typeof fetch} [options.fetchImpl] - injectable for tests
 * @returns {Promise<string[]>} keys adopted by the initial pull
 */
export async function initProfileSync({ getToken, fetchImpl } = {}) {
  config = { getToken, fetchImpl };

  stopProfileSync({ keepConfig: true });

  const syncedKeys = new Set(SYNCED_KEYS);
  unsubscribe = onLocalWrite((key) => {
    if (applyingRemote || !syncedKeys.has(key)) return;
    recordLocalWrite(key);
    schedulePush();
  });

  return pullProfile();
}

/** Stop syncing and drop any pending push. */
export function stopProfileSync({ keepConfig = false } = {}) {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  if (!keepConfig) config = null;
}
