import { DurableObject } from 'cloudflare:workers';
import { entitlementStore, readClubRecord } from './entitlements.js';
import { clubMemberKey, clubOwnerUid, isLiveMember } from './club-admin.js';

/**
 * The 3 places a club's code can fill, counted where two joins cannot race.
 *
 * A club's Pro covers its owner plus up to 3 other Zoom accounts. KV has no
 * transaction and its list can lag a write by a minute, so "count the member
 * rows, then add one" lets two people who type the code at the same moment both
 * see a free place. One Durable Object per club (`idFromName(clubId)`) holds the
 * set of uids that hold a place, and every claim runs through it: the check and
 * the add happen on an in-memory set with no `await` between them, so two claims
 * cannot interleave, in the runtime or in a test whose storage yields on every
 * call. The owner never takes a place and is never in the set.
 *
 * The member rows in KV stay the authority on who is in the club and with what
 * role; this object only answers "is there room". The roster's people list
 * still comes from KV, so a join can take a few seconds to appear there while
 * the count is already exact.
 */

/** Places besides the owner. */
export const CLUB_PLACES = 3;

const HOLDERS_KEY = 'holders';

/**
 * The uids that hold a place, as the club's member rows say on first use: live
 * rows (not blocked, not a legacy `revokedAt` one), minus the owner.
 *
 * Read once, the first time the object is used, so clubs that already had
 * members need no migration step. Rows written after that are counted through
 * `claim`, never by reading KV again.
 */
async function seedHolders(env, clubId) {
  const store = entitlementStore(env);
  if (!store || !clubId) return [];

  const club = await readClubRecord(env, clubId);
  const owner = club ? await clubOwnerUid(env, club) : null;
  const prefix = clubMemberKey(clubId, '');

  const holders = [];
  let cursor;
  do {
    // eslint-disable-next-line no-await-in-loop
    const listed = await store.list({ prefix, cursor });
    for (const entry of listed.keys ?? []) {
      const uid = entry.name.slice(prefix.length);
      if (!uid || uid === owner) continue;
      // eslint-disable-next-line no-await-in-loop
      const row = await store.get(entry.name, 'json').catch(() => null);
      if (isLiveMember(row)) holders.push(uid);
    }
    cursor = listed.list_complete === false ? listed.cursor : undefined;
  } while (cursor);
  return holders;
}

export class ClubPlaces extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    /** @type {Set<string>|null} */
    this.holders = null;
    /** @type {Promise<void>|null} */
    this.loading = null;
  }

  /**
   * The set, from storage or (first use only) from KV. Single-flight, so calls
   * that arrive together all wait for one load rather than each seeding.
   */
  async load() {
    if (this.holders) return this.holders;
    if (!this.loading) {
      this.loading = this.ctx.blockConcurrencyWhile(async () => {
        const stored = await this.ctx.storage.get(HOLDERS_KEY);
        if (Array.isArray(stored)) {
          this.holders = new Set(stored);
          return;
        }
        const seeded = await seedHolders(this.env, this.ctx.id?.name);
        await this.ctx.storage.put(HOLDERS_KEY, seeded);
        this.holders = new Set(seeded);
      });
      this.loading.catch(() => {
        // A failed load is retried by the next call rather than remembered.
        this.loading = null;
      });
    }
    await this.loading;
    return this.holders;
  }

  save() {
    return this.ctx.storage.put(HOLDERS_KEY, [...this.holders]);
  }

  /**
   * Take a place for this account, if one is free. An account that already
   * holds one is `ok` and takes no second place.
   *
   * @returns {Promise<{ok: true, placesUsed: number}|{full: true, placesUsed: number}>}
   */
  async claim(uid) {
    const holders = await this.load();
    // From here to the add, nothing awaits: this is the whole of the cap.
    if (holders.has(uid)) return { ok: true, placesUsed: holders.size };
    if (holders.size >= CLUB_PLACES) return { full: true, placesUsed: holders.size };
    holders.add(uid);
    const placesUsed = holders.size;
    await this.save();
    return { ok: true, placesUsed };
  }

  /** Free this account's place. Releasing someone who holds none changes nothing. */
  async release(uid) {
    const holders = await this.load();
    if (!holders.delete(uid)) return { placesUsed: holders.size };
    const placesUsed = holders.size;
    await this.save();
    return { placesUsed };
  }

  /** How many places are taken. */
  async count() {
    return (await this.load()).size;
  }
}

/** The places object for one club. Throws when the binding is missing. */
export function clubPlaces(env, clubId) {
  const namespace = env?.CLUB_PLACES;
  if (!namespace) throw new Error('CLUB_PLACES is not bound');
  return namespace.get(namespace.idFromName(clubId));
}

/** The place count, or null when the object cannot be reached. */
export async function countPlaces(env, clubId) {
  try {
    return await clubPlaces(env, clubId).count();
  } catch {
    return null;
  }
}
