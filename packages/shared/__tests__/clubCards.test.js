import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { Blob as NodeBlob } from 'node:buffer';

/**
 * The club's card set on a device: which set shows, where its images come
 * from, and how a publisher's own set becomes the club's.
 */

const CLUB_KEY = 'toastmaster_club';
const CARDS_KEY = 'toastmaster_club_cards';
const SOURCE_KEY = 'toastmaster_card_source';
const SETTINGS_KEY = 'toastmaster_custom_card_images';

const BLUE = 'a'.repeat(64);
const RED = 'b'.repeat(64);

// cardImages.js and club.js both keep per-session state, so every test loads
// fresh copies. IndexedDB and localStorage survive the reload, as they would a
// page reload.
async function load() {
  vi.resetModules();
  const cardImages = await import('../cardImages.js');
  const club = await import('../club.js');
  const clubCards = await import('../clubCards.js');
  return { ...cardImages, ...club, ...clubCards };
}

function joinClub({ entitled = true, role = null, ver = 3, cards = { images: { blue: BLUE, red: RED } } } = {}) {
  localStorage.setItem(
    CLUB_KEY,
    JSON.stringify({ clubToken: 'club-token', ver, club: { id: 'c1', name: 'Downtown' }, entitled, plan: 'pro', role })
  );
  if (cards) localStorage.setItem(CARDS_KEY, JSON.stringify(cards));
}

const imageBlob = (text) => new NodeBlob([text], { type: 'image/jpeg' });

beforeEach(() => {
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  // fake-indexeddb cannot clone jsdom's Blob; Node's round-trips.
  globalThis.Blob = NodeBlob;
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:test/${++n}`);
  URL.revokeObjectURL = vi.fn();
});

describe('which set shows', () => {
  it('is the device\'s own choice when there is no club set', async () => {
    const mod = await load();
    expect(mod.activeCardSetId()).toBe('classic');
    expect(mod.clubCardSetAvailable()).toBe(false);
  });

  // The same rule as the club's presets: a device that never chose opens on the club's.
  it('is the club\'s set on a device that never chose cards of its own', async () => {
    joinClub();
    const mod = await load();
    expect(mod.activeCardSetId()).toBe(mod.CLUB_CARD_SET_ID);
  });

  it('stays on a device\'s own set when it has one', async () => {
    joinClub();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ version: 3, selectedSetId: 'modern', customSets: [] }));
    const mod = await load();
    expect(mod.activeCardSetId()).toBe('modern');
  });

  it('follows the switch once someone moves it', async () => {
    joinClub();
    const mod = await load();
    expect(mod.selectCardSet('classic')).toBe(true);
    expect(localStorage.getItem(SOURCE_KEY)).toBe('own');
    expect(mod.activeCardSetId()).toBe('classic');
    expect(mod.selectCardSet(mod.CLUB_CARD_SET_ID)).toBe(true);
    expect(mod.activeCardSetId()).toBe(mod.CLUB_CARD_SET_ID);
  });

  // A lapsed club keeps its record; its set just stops being on offer.
  it('falls back to the device\'s own set when the club lapses', async () => {
    joinClub({ entitled: false });
    localStorage.setItem(SOURCE_KEY, 'club');
    const mod = await load();
    expect(mod.activeCardSetId()).toBe('classic');
    expect(mod.selectCardSet(mod.CLUB_CARD_SET_ID)).toBe(false);
  });

  it('shows a set someone just added, even with a club set on offer', async () => {
    joinClub();
    const mod = await load();
    const id = await mod.addCustomCardSet({ green: imageBlob('green') });
    expect(mod.activeCardSetId()).toBe(id);
  });
});

describe('resolving a card from the club set', () => {
  it('serves a stored image, and Classic for a skipped colour or one not yet here', async () => {
    joinClub();
    const mod = await load();
    await mod.initCardImages();
    expect(mod.resolveCardImage('blue')).toEqual({ file: 'timer-blue-background.png' });

    await mod.storeClubCardBlobs([[BLUE, imageBlob('blue')]]);
    expect(mod.resolveCardImage('blue')).toEqual({ url: expect.stringMatching(/^blob:/) });
    expect(mod.resolveCardImage('green')).toEqual({ file: 'timer-green-background.png' });
    expect(mod.resolveCardImage('red')).toEqual({ file: 'timer-red-background.png' });
  });

  it('keeps the current set\'s images through a reload and sweeps a replaced set\'s', async () => {
    joinClub();
    let mod = await load();
    await mod.initCardImages();
    await mod.storeClubCardBlobs([[BLUE, imageBlob('blue')], [RED, imageBlob('red')]]);

    // The club republishes with only a new red card.
    const NEW_RED = 'c'.repeat(64);
    localStorage.setItem(CARDS_KEY, JSON.stringify({ images: { red: NEW_RED } }));
    mod = await load();
    await mod.initCardImages();
    expect(mod.missingClubCardHashes()).toEqual([NEW_RED]);
    const stored = await mod.readStoredCardBlobs();
    expect([...stored.keys()]).toEqual([]);
  });

  it('tells subscribers when images arrive', async () => {
    joinClub();
    const mod = await load();
    const heard = vi.fn();
    mod.subscribeCardImages(heard);
    await mod.storeClubCardBlobs([[BLUE, imageBlob('blue')]]);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('syncClubCardImages', () => {
  it('fetches only what is missing, with the club credential', async () => {
    joinClub();
    const mod = await load();
    const fetchImpl = vi.fn(async (url) => ({
      ok: true,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      blob: async () => imageBlob(url),
    }));

    expect(await mod.syncClubCardImages({ fetchImpl })).toEqual([BLUE, RED]);
    expect(fetchImpl).toHaveBeenCalledWith(`/api/club/cards/${BLUE}`, expect.objectContaining({
      headers: { 'X-Club': 'club-token' },
    }));

    fetchImpl.mockClear();
    expect(await mod.syncClubCardImages({ fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does nothing without a club set, and survives a failed download', async () => {
    let mod = await load();
    const fetchImpl = vi.fn();
    expect(await mod.syncClubCardImages({ fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();

    joinClub();
    mod = await load();
    const failing = vi.fn(async () => ({ ok: false, status: 404 }));
    expect(await mod.syncClubCardImages({ fetchImpl: failing })).toEqual([]);
  });

  // A dev server's SPA fallback, or a captive portal, answers 200 with a page.
  it('keeps only responses that are images', async () => {
    joinClub();
    const mod = await load();
    const page = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html' }),
      blob: async () => imageBlob('<html>'),
    }));
    expect(await mod.syncClubCardImages({ fetchImpl: page })).toEqual([]);
    expect(mod.missingClubCardHashes()).toEqual([BLUE, RED]);
  });
});

describe('the club cache', () => {
  const okJson = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

  it('takes a new set when ver moves, and one it never had even when ver has not', async () => {
    joinClub({ cards: null, ver: 3 });
    let mod = await load();
    await mod.refreshClub({
      force: true,
      fetchImpl: async () => okJson({ ver: 3, club: { id: 'c1' }, entitled: true, cards: { images: { blue: BLUE } } }),
    });
    expect(mod.loadClubCards().images).toEqual({ blue: BLUE });

    mod = await load();
    await mod.refreshClub({
      force: true,
      fetchImpl: async () => okJson({ ver: 4, club: { id: 'c1' }, entitled: true, cards: null }),
    });
    expect(mod.loadClubCards()).toBeNull();
  });

  it('forgets the set and the switch on leaving', async () => {
    joinClub();
    localStorage.setItem(SOURCE_KEY, 'club');
    const mod = await load();
    mod.leaveClub({ fetchImpl: vi.fn(async () => ({})) });
    expect(localStorage.getItem(CARDS_KEY)).toBeNull();
    expect(localStorage.getItem(SOURCE_KEY)).toBeNull();
    expect(mod.activeCardSetId()).toBe('classic');
  });
});

describe('publishCardSet', () => {
  async function withCustomSet(role = 'editor') {
    joinClub({ role, cards: null });
    const mod = await load();
    const id = await mod.addCustomCardSet({ blue: imageBlob('blue pixels'), red: imageBlob('red pixels') });
    return { mod, id };
  }

  it('is offered to admins and editors only', async () => {
    joinClub({ role: 'member' });
    expect((await load()).canPublishCards()).toBe(false);
    joinClub({ role: 'editor' });
    expect((await load()).canPublishCards()).toBe(true);
    joinClub({ role: 'admin', entitled: false });
    expect((await load()).canPublishCards()).toBe(false);
  });

  it('uploads each image, publishes the set and remembers it as the club\'s', async () => {
    const { mod, id } = await withCustomSet();
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push([init.method, url]);
      if (url === '/api/club/cards') {
        const body = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ ver: 4, cards: { ...body, publishedBy: 'me', publishedAt: 1 } }) };
      }
      return { ok: true, status: 200, json: async () => ({ stored: true }) };
    });

    const result = await mod.publishCardSet(id, { label: 'Custom 1', getToken: () => 'tok', fetchImpl });
    expect(result.ok).toBe(true);
    expect(calls.map(([method]) => method)).toEqual(['PUT', 'PUT', 'PUT']);
    expect(calls[2][1]).toBe('/api/club/cards');
    const [, uploadInit] = fetchImpl.mock.calls[0];
    expect(uploadInit.headers).toMatchObject({ 'X-Club': 'club-token', Authorization: 'Bearer tok' });

    expect(mod.loadClub().ver).toBe(4);
    expect(Object.keys(mod.loadClubCards().images)).toEqual(['blue', 'red']);
    // The publisher already holds the pixels; nothing is left to download.
    expect(mod.missingClubCardHashes()).toEqual([]);
  });

  // Another publisher's set may prune an upload between our upload and our publish.
  it('re-uploads what the server says is missing, once', async () => {
    const { mod, id } = await withCustomSet();
    let publishes = 0;
    let missingHash;
    const fetchImpl = vi.fn(async (url, init) => {
      if (url !== '/api/club/cards') return { ok: true, status: 200, json: async () => ({ stored: true }) };
      publishes += 1;
      const body = JSON.parse(init.body);
      if (publishes === 1) {
        missingHash = body.images.blue;
        return { ok: false, status: 409, json: async () => ({ error: 'missing_images', missing: [missingHash] }) };
      }
      return { ok: true, status: 200, json: async () => ({ ver: 5, cards: body }) };
    });

    expect((await mod.publishCardSet(id, { fetchImpl })).ok).toBe(true);
    expect(publishes).toBe(2);
    expect(fetchImpl.mock.calls.filter(([url]) => url === `/api/club/cards/${missingHash}`)).toHaveLength(2);
  });

  it('says why it was refused', async () => {
    const { mod, id } = await withCustomSet('member');
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) }));
    expect(await mod.publishCardSet(id, { fetchImpl })).toEqual({ ok: false, error: 'forbidden' });
    expect(await mod.publishCardSet('custom-9', { fetchImpl })).toEqual({ ok: false, error: 'no_set' });
    const offline = vi.fn(async () => { throw new Error('offline'); });
    expect(await mod.publishCardSet(id, { fetchImpl: offline })).toEqual({ ok: false, error: 'network' });
  });
});
