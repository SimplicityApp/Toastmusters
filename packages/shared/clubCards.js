import { loadClub, loadClubCards, subscribeClub, rememberPublishedCards } from './club.js';
import {
  CARD_COLORS,
  cardImageKey,
  getCardImageSettings,
  initCardImages,
  missingClubCardHashes,
  notifyCardImages,
  readStoredCardBlobs,
  storeClubCardBlobs,
} from './cardImages.js';

/**
 * Moving the club's card set between devices: downloading it where it is
 * missing, and publishing one of this device's own sets as the club's.
 *
 * The pixels go to R2 under the club, content-addressed by SHA-256; the club
 * state carries only the hashes. A device holds the images in IndexedDB, so
 * the card-switch path never waits on the network.
 */

const CARDS_ENDPOINT = '/api/club/cards';

/**
 * SHA-256 of a Blob, as lowercase hex: the id the Worker checks the bytes
 * against, so it is computed exactly the way the Worker computes it.
 *
 * @param {Blob} blob
 * @returns {Promise<string|null>} null where WebCrypto is unavailable
 */
export async function hashCardBlob(blob) {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  try {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** Whether this device's signed-in user may publish a card set to the club. */
export function canPublishCards() {
  const club = loadClub();
  if (!club?.entitled) return false;
  return club.role === 'admin' || club.role === 'editor';
}

/**
 * Fetch the club set's images this device does not hold yet. Never rejects:
 * a card that has not arrived shows the Classic card, which is what a device
 * with no club shows anyway.
 *
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<string[]>} hashes stored
 */
export async function syncClubCardImages({ fetchImpl } = {}) {
  const club = loadClub();
  if (!club?.clubToken || !loadClubCards()) return [];
  await initCardImages();

  const entries = [];
  for (const hash of missingClubCardHashes()) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await (fetchImpl ?? fetch)(`${CARDS_ENDPOINT}/${hash}`, {
        headers: { 'X-Club': club.clubToken },
        credentials: 'same-origin',
      });
      if (!response.ok) continue;
      // Only an image is kept. An SPA fallback or a captive portal answers 200
      // with a page, and a page stored as a card would show as a broken image
      // until the club republished.
      if (!(response.headers?.get?.('content-type') || '').startsWith('image/')) continue;
      // eslint-disable-next-line no-await-in-loop
      entries.push([hash, await response.blob()]);
    } catch {
      // Offline. The next app start, or the next club change, tries again.
    }
  }
  return storeClubCardBlobs(entries);
}

/** What the timer would show from the club, so a change to it can be noticed. */
function clubCardsSignature() {
  const club = loadClub();
  const cards = loadClubCards();
  return `${Boolean(club?.entitled)}|${CARD_COLORS.map((color) => cards?.images?.[color] ?? '').join(',')}`;
}

/**
 * Keep the club's set on this device for as long as the app runs.
 *
 * Fetches what is missing now, and again whenever the club changes: a new
 * publish, a removal, a lapse or leaving. Each of those also tells the timer
 * to re-show its card, since the set it should show may have changed.
 *
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {() => void} stop
 */
export function startClubCardSync({ fetchImpl } = {}) {
  let last = clubCardsSignature();
  syncClubCardImages({ fetchImpl }).catch(() => {});
  return subscribeClub(() => {
    const next = clubCardsSignature();
    if (next === last) return;
    last = next;
    notifyCardImages();
    syncClubCardImages({ fetchImpl }).catch(() => {});
  });
}

function errorFor(status, body) {
  if (body?.error) return body.error;
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 402) return 'upgrade_required';
  return 'publish_failed';
}

async function readBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Publish one of this device's own sets as the club's.
 *
 * Refused server-side for anyone but an admin or editor, like a presets
 * publish. Uploads go first, then the set; if another publisher's set pruned an
 * image in between, the missing ones are uploaded once more and the set is
 * sent again.
 *
 * @param {string} setId - a custom set id, e.g. 'custom-1'
 * @param {{label?: string, getToken?: () => string|null, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{ok: true, ver: number, cards: Object}|{ok: false, error: string}>}
 *   never rejects
 */
export async function publishCardSet(setId, { label, getToken, fetchImpl } = {}) {
  const club = loadClub();
  if (!club?.clubToken) return { ok: false, error: 'no_club' };

  const set = getCardImageSettings().customSets.find((s) => s.id === setId);
  if (!set) return { ok: false, error: 'no_set' };

  const stored = await readStoredCardBlobs();
  const blobs = new Map();
  const images = {};
  for (const color of set.colors) {
    const blob = stored.get(cardImageKey(setId, color));
    if (!blob) continue;
    // eslint-disable-next-line no-await-in-loop
    const hash = await hashCardBlob(blob);
    if (!hash) return { ok: false, error: 'unsupported_browser' };
    images[color] = hash;
    blobs.set(hash, blob);
  }
  if (!Object.keys(images).length) return { ok: false, error: 'no_set' };

  const token = getToken?.();
  const headers = {
    'X-Club': club.clubToken,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const send = (url, init) => (fetchImpl ?? fetch)(url, { credentials: 'same-origin', cache: 'no-store', ...init });

  const upload = async (hashes) => {
    for (const hash of hashes) {
      const blob = blobs.get(hash);
      // eslint-disable-next-line no-await-in-loop
      const response = await send(`${CARDS_ENDPOINT}/${hash}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': blob.type || 'image/jpeg' },
        body: blob,
      });
      // eslint-disable-next-line no-await-in-loop
      if (!response.ok) return errorFor(response.status, await readBody(response));
    }
    return null;
  };

  try {
    const uploadError = await upload([...blobs.keys()]);
    if (uploadError) return { ok: false, error: uploadError };

    const body = JSON.stringify({ label: label ?? null, images });
    const put = () =>
      send(CARDS_ENDPOINT, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body });

    let response = await put();
    let result = await readBody(response);
    if (response.status === 409 && Array.isArray(result?.missing)) {
      const retryError = await upload(result.missing.filter((hash) => blobs.has(hash)));
      if (retryError) return { ok: false, error: retryError };
      response = await put();
      result = await readBody(response);
    }
    if (!response.ok || !result?.cards) return { ok: false, error: errorFor(response.status, result) };

    // The publisher already holds every image, so it never downloads its own set.
    await storeClubCardBlobs([...blobs.entries()]);
    rememberPublishedCards(result.ver, result.cards);
    return { ok: true, ver: result.ver, cards: result.cards };
  } catch {
    return { ok: false, error: 'network' };
  }
}
