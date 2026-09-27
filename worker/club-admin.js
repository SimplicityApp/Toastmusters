import crypto from 'node:crypto';
import { entitlementStore, clubKey } from './entitlements.js';

/**
 * Minting a club, and the codes that let a device join one.
 *
 * Creation is a plain function from day one even though a human runs it from
 * scripts/club-cli.mjs: Phase 7 feeds it real checkout data out of
 * `club-pending:<cus_id>`, and automating creation later means calling this
 * same function from the Stripe webhook rather than writing a second one.
 */

/**
 * Crockford base32: I, L, O and U are absent so nobody misreads a code over
 * the phone or types an accidental obscenity.
 */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Six characters, 32 symbols: 1.07 billion suffixes.
 *
 * All of a code's entropy lives here. The prefix is derived from the club's
 * name and therefore guessable — anyone targeting Downtown Speakers already
 * knows "DTSP" — so lengthening the suffix is the only thing that makes a code
 * hard to hit. Throttling on the activation route backs it up; the two fail
 * differently, which is why both are kept.
 */
export const CODE_SUFFIX_LENGTH = 6;

const PREFIX_LENGTH = 4;
const VOWELS = new Set(['A', 'E', 'I', 'O', 'U']);

/**
 * Fold whatever a person typed into the canonical form we store and look up.
 *
 * Case, spaces and dashes are noise. The three letters Crockford leaves out
 * are folded onto the digits they are mistaken for, so a code copied out of a
 * WhatsApp message with an O for a zero still resolves.
 *
 * @param {unknown} raw
 * @returns {string} '' when nothing usable was typed
 */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .split('')
    .filter((char) => CODE_ALPHABET.includes(char))
    .join('');
}

/** Split a normalized code back into its display form, `DTSP-7K2QM9`. */
export function formatCode(code) {
  const normalized = normalizeCode(code);
  if (normalized.length <= CODE_SUFFIX_LENGTH) return normalized;
  const at = normalized.length - CODE_SUFFIX_LENGTH;
  return `${normalized.slice(0, at)}-${normalized.slice(at)}`;
}

/**
 * A short, club-derived prefix: initials first, then padded out of the first
 * word's consonants so a one-word club still reads as itself.
 *
 * Purely cosmetic — it carries no entropy and the CLI can override it.
 *
 * @param {string} name
 * @returns {string} exactly PREFIX_LENGTH alphabet characters
 */
export function clubPrefix(name) {
  const words = String(name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);

  if (!words.length) return 'CLUB';

  let out = words.slice(0, PREFIX_LENGTH).map((word) => word[0]).join('');
  for (const char of words[0].slice(1)) {
    if (out.length >= PREFIX_LENGTH) break;
    if (!VOWELS.has(char)) out += char;
  }
  for (const char of words.join('')) {
    if (out.length >= PREFIX_LENGTH) break;
    out += char;
  }

  const normalized = normalizeCode(out.slice(0, PREFIX_LENGTH));
  return normalized.length === PREFIX_LENGTH ? normalized : (normalized + 'CLUB').slice(0, PREFIX_LENGTH);
}

/**
 * A fresh code for a club.
 *
 * @param {string} name - or an explicit prefix
 * @param {() => number} [randomInt] - injectable for tests; returns 0..31
 * @returns {string} normalized (undashed); use formatCode() to show it
 */
export function mintCode(name, randomInt = () => crypto.randomInt(CODE_ALPHABET.length)) {
  let suffix = '';
  for (let i = 0; i < CODE_SUFFIX_LENGTH; i += 1) {
    suffix += CODE_ALPHABET[randomInt() % CODE_ALPHABET.length];
  }
  return `${clubPrefix(name)}${suffix}`;
}

export const clubByCodeKey = (code) => `club-by-code:${normalizeCode(code)}`;
export const clubByCustomerKey = (customerId) => `club-by-customer:${customerId}`;
export const clubDeviceKey = (clubId, deviceId) => `club-device:${clubId}:${deviceId}`;
export const clubMemberKey = (clubId, uid) => `club-member:${clubId}:zoom:${uid}`;

async function freeCode(store, name, randomInt, attempts = 8) {
  for (let i = 0; i < attempts; i += 1) {
    const code = mintCode(name, randomInt);
    // eslint-disable-next-line no-await-in-loop
    if (!(await store.get(clubByCodeKey(code)))) return code;
  }
  throw new Error('Could not mint an unused club code');
}

/**
 * Create a club from what checkout captured (or what an operator typed).
 *
 * The buyer becomes the first admin in the same step that mints the club: we
 * already have their uid here, and a club whose only officer has to be added
 * by hand is a club that arrives broken.
 *
 * @param {Object} env - PROFILES (or ENTITLEMENTS) KV
 * @param {{uid?: string|null, clubName?: string|null, email?: string|null,
 *   stripeCustomerId?: string|null, status?: string, currentPeriodEnd?: number|null,
 *   timezone?: string|null}} pending
 * @param {{now?: number, clubId?: string, code?: string, prefix?: string,
 *   randomInt?: () => number}} [options] - `prefix` overrides the name-derived
 *   one, which is cosmetic and carries no entropy
 * @returns {Promise<{clubId: string, code: string, club: Object}>}
 */
export async function createClubFromPending(env, pending = {}, options = {}) {
  const store = entitlementStore(env);
  if (!store) throw new Error('No KV namespace bound (PROFILES or ENTITLEMENTS)');

  const now = options.now ?? Date.now();
  const clubId = options.clubId ?? crypto.randomUUID();
  const name = pending.clubName?.trim() || null;
  const code = options.code
    ? normalizeCode(options.code)
    : await freeCode(store, options.prefix || name || clubId, options.randomInt);

  // A buyer who skipped the optional name still gets a club; the placeholder
  // names itself after the code's suffix so the officer can recognise it in an
  // email, and renaming is a one-field edit.
  const displayName = name ?? `Club ${code.slice(-4)}`;

  const club = {
    name: displayName,
    code,
    ver: 1,
    kit: null,
    stripeCustomerId: pending.stripeCustomerId ?? null,
    billingEmail: pending.email ?? null,
    plan: 'pro',
    status: pending.status ?? 'active',
    currentPeriodEnd: typeof pending.currentPeriodEnd === 'number' ? pending.currentPeriodEnd : null,
    cancelAtPeriodEnd: false,
    timezone: pending.timezone ?? null,
    createdAt: now,
  };

  await store.put(clubKey(clubId), JSON.stringify(club));
  await store.put(clubByCodeKey(code), clubId);
  if (pending.stripeCustomerId) await store.put(clubByCustomerKey(pending.stripeCustomerId), clubId);
  if (pending.uid) {
    await store.put(
      clubMemberKey(clubId, pending.uid),
      JSON.stringify({ role: 'admin', displayName: null, addedAt: now, revokedAt: null })
    );
  }

  return { clubId, code, club };
}

/**
 * Issue a new code and cut off every device holding the old one.
 *
 * Rotation is the lever a leaked code needs. Bumping `ver` alone would not do
 * it — `ver` moves on every publish, and treating a stale one as a forgery
 * would lock every device out for a day after a routine preset change. So
 * rotation revokes the device records instead, which bites on the very next
 * write rather than whenever a cached token happens to expire.
 *
 * @param {Object} env
 * @param {string} clubId
 * @param {{now?: number, code?: string, randomInt?: () => number, revokeDevices?: boolean}} [options]
 * @returns {Promise<{code: string, club: Object, revoked: number}>}
 */
export async function rotateClubCode(env, clubId, options = {}) {
  const store = entitlementStore(env);
  if (!store) throw new Error('No KV namespace bound (PROFILES or ENTITLEMENTS)');

  const now = options.now ?? Date.now();
  const club = await store.get(clubKey(clubId), 'json');
  if (!club) throw new Error(`No club record at ${clubKey(clubId)}`);

  const previous = club.code ? normalizeCode(club.code) : null;
  const code = options.code ? normalizeCode(options.code) : await freeCode(store, club.name, options.randomInt);

  const next = { ...club, code, ver: (club.ver ?? 1) + 1 };
  await store.put(clubKey(clubId), JSON.stringify(next));
  await store.put(clubByCodeKey(code), clubId);
  if (previous && previous !== code) await store.delete(clubByCodeKey(previous));

  let revoked = 0;
  if (options.revokeDevices !== false) {
    let cursor;
    do {
      // eslint-disable-next-line no-await-in-loop
      const listed = await store.list({ prefix: `club-device:${clubId}:`, cursor });
      for (const entry of listed.keys ?? []) {
        // eslint-disable-next-line no-await-in-loop
        const device = await store.get(entry.name, 'json');
        if (!device || device.revokedAt) continue;
        // eslint-disable-next-line no-await-in-loop
        await store.put(entry.name, JSON.stringify({ ...device, revokedAt: now }));
        revoked += 1;
      }
      cursor = listed.list_complete === false ? listed.cursor : undefined;
    } while (cursor);
  }

  return { code, club: next, revoked };
}
