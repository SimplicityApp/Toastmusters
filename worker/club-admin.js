import crypto from 'node:crypto';
import { entitlementStore, clubKey } from './entitlements.js';
import { normalizeEmail } from './email.js';
import { lookupUidByCustomer } from './billing.js';

/**
 * Minting a club, the codes that let a Zoom account join one, and who is in it.
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

/**
 * Where checkout parks the raw material a club record is made from.
 *
 * Payment is the only moment the club's name and an address to reach the buyer
 * both naturally exist, so the webhook writes them here rather than leaving
 * them in Stripe for someone to dig out later. A human then runs the CLI over
 * this prefix and calls `createClubFromPending()`; moving that call into the
 * webhook is a one-line change when volume justifies it.
 *
 * Keyed by the Stripe customer because that is the one identifier every later
 * subscription event also carries, and because it is what `club-by-customer:`
 * is keyed by — so "has this payment already become a club?" is one read.
 */
export const CLUB_PENDING_PREFIX = 'club-pending:';
export const clubPendingKey = (customerId) => `${CLUB_PENDING_PREFIX}${customerId}`;

// Billing addresses are folded by the shared normaliser (worker/email.js).
// Re-exported so the modules that already import it from here keep working.
export { normalizeEmail };

/**
 * The club a billing address owns.
 *
 * An index rather than a scan, because the magic-link route is public: without
 * it, answering "does this address own a club?" would mean listing every club
 * record on every request, including every request from someone guessing.
 */
export const clubByEmailKey = (email) => `club-by-email:${normalizeEmail(email)}`;
export const clubMemberKey = (clubId, uid) => `club-member:${clubId}:zoom:${uid}`;
export const clubPresetsKey = (clubId) => `club-presets:${clubId}`;
export const clubCardsKey = (clubId) => `club-cards:${clubId}`;

/**
 * The club an account is in, found from its uid alone: `{ clubId, at }`.
 *
 * Member rows are keyed club-first (`club-member:<clubId>:zoom:<uid>`), which
 * answers "what may this person do *here*" in one read and "which club is this
 * person in" not at all. Club Pro follows the account, so every request that
 * carries a session needs the second question answered, and so does the
 * console when *Manage your club* opens a browser that has never typed a code.
 *
 * Single-valued, because an account is in one club at a time. A pointer, never
 * the authority: `memberClub()` re-reads the member row it points at, so a
 * stale pointer reads as no club rather than as access.
 */
export const clubOfKey = (uid) => `club-of:zoom:${uid}`;

/** Point this account at this club. */
export async function writeClubIndex(store, uid, clubId, now = Date.now()) {
  if (!store || !uid || !clubId) return;
  await store.put(clubOfKey(uid), JSON.stringify({ clubId, at: now }));
}

/**
 * Drop the pointer when this account leaves this club — and only then, so a
 * removal from club A never unhooks an account that has since joined B.
 */
export async function clearClubIndex(store, uid, clubId) {
  if (!store || !uid || !clubId) return;
  const current = await store.get(clubOfKey(uid), 'json').catch(() => null);
  if (current?.clubId === clubId) await store.delete(clubOfKey(uid)).catch(() => {});
}

/**
 * Whether a member row lets its account into the club.
 *
 * A blocked row (`blockedAt`) is kept so the code refuses the account; it is
 * not a member. A `revokedAt` row is a leftover from device-era removals and
 * counts as no row at all, so that account joins like anyone else.
 */
export const isLiveMember = (row) => Boolean(row) && !row.blockedAt && !row.revokedAt;

/**
 * The account that pays for the club, which nobody can remove, block, demote
 * or count against its places.
 *
 * Written on the record at creation (`ownerUid`). A record from before that is
 * matched through its Stripe customer; a club minted by hand with neither has
 * no known owner, and the last-admin rule is then its only guard.
 *
 * @returns {Promise<string|null>}
 */
export async function clubOwnerUid(env, club) {
  if (!club) return null;
  if (typeof club.ownerUid === 'string' && club.ownerUid) return club.ownerUid;
  if (!club.stripeCustomerId) return null;
  return lookupUidByCustomer(env, club.stripeCustomerId);
}

/**
 * What a person may change club-wide.
 *
 * Roles live only on member records. A blocked or legacy-revoked row reads as
 * no role at all rather than as a demotion, so losing the role and losing the
 * person are one code path.
 *
 * Never throws: it is consulted on the app-start refresh, and a KV hiccup must
 * degrade to "no role", not to an error the app has to handle.
 *
 * @param {Object} env
 * @param {string|null|undefined} clubId
 * @param {string|null|undefined} uid
 * @returns {Promise<'admin'|'editor'|'member'|null>}
 */
export async function readMemberRole(env, clubId, uid) {
  if (!clubId || !uid) return null;
  const store = entitlementStore(env);
  if (!store) return null;
  let member;
  try {
    member = await store.get(clubMemberKey(clubId, uid), 'json');
  } catch {
    return null;
  }
  return isLiveMember(member) ? roleOf(member) : null;
}

const roleOf = (member) => (member.role === 'admin' || member.role === 'editor' ? member.role : 'member');

/**
 * The club this account is in, from its session uid alone.
 *
 * This is what every club route asks instead of reading a club token: the
 * index names the club, and the member row under it decides. An index that
 * points at a missing club, a missing row, a blocked row or a legacy revoked
 * one is no club, and is deleted on the way past so the next read is one get.
 * A read that fails is no club too, but deletes nothing.
 *
 * @param {Object} env
 * @param {string|null|undefined} uid
 * @returns {Promise<{clubId: string, club: Object, role: 'admin'|'editor'|'member'}|null>}
 */
export async function memberClub(env, uid) {
  if (!uid) return null;
  const store = entitlementStore(env);
  if (!store) return null;

  let index;
  let club;
  let row;
  try {
    index = await store.get(clubOfKey(uid), 'json');
    if (!index?.clubId) return null;
    [club, row] = await Promise.all([
      store.get(clubKey(index.clubId), 'json'),
      store.get(clubMemberKey(index.clubId, uid), 'json'),
    ]);
  } catch {
    return null;
  }

  if (!club || !isLiveMember(row)) {
    await store.delete(clubOfKey(uid)).catch(() => {});
    return null;
  }
  return { clubId: index.clubId, club, role: roleOf(row) };
}

/**
 * How many people can still administer this club: live admin rows. A blocked
 * row that still says admin does not count.
 */
export async function activeAdmins(store, clubId) {
  const prefix = clubMemberKey(clubId, '');
  let count = 0;
  let cursor;
  do {
    // eslint-disable-next-line no-await-in-loop
    const listed = await store.list({ prefix, cursor });
    for (const entry of listed.keys ?? []) {
      // eslint-disable-next-line no-await-in-loop
      const row = await store.get(entry.name, 'json').catch(() => null);
      if (isLiveMember(row) && row.role === 'admin') count += 1;
    }
    cursor = listed.list_complete === false ? listed.cursor : undefined;
  } while (cursor);
  return count;
}

/** Whether a role may publish the club's presets, kit and badge placement. */
export const canPublish = (role) => role === 'admin' || role === 'editor';

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
 * The buyer becomes the owner and first admin in the same step that mints the
 * club: we already have their uid here, and a club whose only officer has to
 * be added by hand is a club that arrives broken. The owner takes none of the
 * club's places.
 *
 * @param {Object} env - PROFILES (or ENTITLEMENTS) KV
 * @param {{uid?: string|null, clubName?: string|null, email?: string|null,
 *   stripeCustomerId?: string|null, status?: string, currentPeriodEnd?: number|null,
 *   cancelAtPeriodEnd?: boolean, timezone?: string|null}} pending
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
    // Carried rather than assumed false: a club minted from a subscription that
    // is already winding down must lapse on the date the buyer was told, not
    // renew itself into existence.
    cancelAtPeriodEnd: Boolean(pending.cancelAtPeriodEnd),
    timezone: pending.timezone ?? null,
    // The account that pays: never removed, blocked, demoted or counted.
    ownerUid: pending.uid ?? null,
    createdAt: now,
  };

  await store.put(clubKey(clubId), JSON.stringify(club));
  await store.put(clubByCodeKey(code), clubId);
  if (pending.stripeCustomerId) await store.put(clubByCustomerKey(pending.stripeCustomerId), clubId);
  // The magic link's only lookup. Written here because this is the one moment
  // the address is known to belong to this club; nothing else ever writes it.
  if (club.billingEmail) await store.put(clubByEmailKey(club.billingEmail), clubId);
  if (pending.uid) {
    await store.put(clubMemberKey(clubId, pending.uid), JSON.stringify({ role: 'admin', displayName: null, addedAt: now }));
    // So the club follows the buyer's account everywhere they are signed in,
    // the console included, without ever typing the code.
    await writeClubIndex(store, pending.uid, clubId, now);
  }

  return { clubId, code, club };
}

/**
 * Issue a new code. The old one admits nobody from now on.
 *
 * Rotation is the lever a leaked code needs, and it only has to close the door:
 * the people already in the club are in by account, so every member, every
 * role and every block stays exactly as it was.
 *
 * @param {Object} env
 * @param {string} clubId
 * @param {{code?: string, randomInt?: () => number}} [options]
 * @returns {Promise<{code: string, club: Object}>}
 */
export async function rotateClubCode(env, clubId, options = {}) {
  const store = entitlementStore(env);
  if (!store) throw new Error('No KV namespace bound (PROFILES or ENTITLEMENTS)');

  const club = await store.get(clubKey(clubId), 'json');
  if (!club) throw new Error(`No club record at ${clubKey(clubId)}`);

  const previous = club.code ? normalizeCode(club.code) : null;
  const code = options.code ? normalizeCode(options.code) : await freeCode(store, club.name, options.randomInt);

  const next = { ...club, code, ver: (club.ver ?? 1) + 1 };
  await store.put(clubKey(clubId), JSON.stringify(next));
  await store.put(clubByCodeKey(code), clubId);
  if (previous && previous !== code) await store.delete(clubByCodeKey(previous));

  return { code, club: next };
}
