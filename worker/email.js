/**
 * Email address helpers, shared by club billing (club-admin.js, club-magic.js)
 * and the Zoom contact record (contact.js).
 *
 * A module of their own so that contact.js can use them without importing
 * through club-magic.js, which imports auth.js: one validator and one
 * normaliser, and no import cycle to reason about.
 */

/**
 * Fold an address into the one form we index and store it under.
 *
 * Case only, and the whole address: the local part of an address is
 * case-sensitive by the letter of the RFC and case-insensitive at every
 * provider anyone actually bills through, and treating `Sarah@` and `sarah@` as
 * two clubs would lock an officer out for capitalising their own name.
 */
export const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();

/**
 * An address shaped enough to be worth a lookup.
 *
 * Deliberately loose: the only thing riding on this check is whether we spend a
 * KV read (or keep what Zoom sent), and every stricter pattern rejects
 * addresses that really exist.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const MAX_EMAIL_LENGTH = 254;

export const isEmailish = (email) =>
  typeof email === 'string' && email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email.trim());
