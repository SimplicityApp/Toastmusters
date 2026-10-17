import { describe, it, expect } from 'vitest';
import { isEmailish, normalizeEmail } from './email.js';
import { normalizeEmail as fromClubAdmin } from './club-admin.js';
import { isEmailish as fromClubMagic } from './club-magic.js';

describe('normalizeEmail', () => {
  it('trims and lowercases the whole address', () => {
    expect(normalizeEmail('  Sarah.Smith@Example.COM ')).toBe('sarah.smith@example.com');
  });

  it('turns a missing value into an empty string rather than throwing', () => {
    expect(normalizeEmail(undefined)).toBe('');
    expect(normalizeEmail(null)).toBe('');
  });
});

describe('isEmailish', () => {
  it('accepts ordinary addresses, including surrounding whitespace', () => {
    for (const email of ['a@b.co', 'first.last+tag@sub.example.org', ' padded@example.com ']) {
      expect(isEmailish(email), email).toBe(true);
    }
  });

  it('refuses anything that is not shaped like an address', () => {
    for (const email of ['', 'no-at-sign', 'a@b', '@example.com', 'a@.com', 'a b@example.com', 'a@b..com', null, undefined, 42]) {
      expect(isEmailish(email), String(email)).toBe(false);
    }
  });

  it('refuses an address longer than 254 characters', () => {
    expect(isEmailish(`${'a'.repeat(250)}@b.co`)).toBe(false);
  });
});

// The helpers moved here from club-admin.js and club-magic.js; both still
// export them so their existing importers keep working.
describe('the old homes', () => {
  it('re-export the same functions', () => {
    expect(fromClubAdmin).toBe(normalizeEmail);
    expect(fromClubMagic).toBe(isEmailish);
  });
});
