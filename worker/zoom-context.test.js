import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { decryptAppContext } from './zoom-context.js';
import { encryptZoomContext } from './test-helpers.js';

const SECRET = 'test-zoom-client-secret';
const NOW = 1_756_000_000_000; // fixed clock; Date.now() is never called in tests

const encryptContext = (payload, { secret = SECRET, ...rest } = {}) =>
  encryptZoomContext(payload, { secret, ...rest });

const futureExpMs = NOW + 60_000;

describe('decryptAppContext', () => {
  it('round-trips a meeting context', () => {
    const context = encryptContext({
      uid: 'abc123uid',
      mid: 'meeting-uuid-xyz',
      typ: 'meeting',
      ts: NOW,
      exp: futureExpMs,
    });

    expect(decryptAppContext(context, SECRET, NOW)).toEqual({
      uid: 'abc123uid',
      mid: 'meeting-uuid-xyz',
      typ: 'meeting',
      exp: futureExpMs,
    });
  });

  it('accepts an expiry expressed in seconds', () => {
    const expSeconds = Math.floor(futureExpMs / 1000);
    const context = encryptContext({ uid: 'u', typ: 'panel', exp: expSeconds });

    expect(decryptAppContext(context, SECRET, NOW)?.uid).toBe('u');
  });

  it('tolerates the URL-safe base64 alphabet', () => {
    const context = encryptContext({ uid: 'u', exp: futureExpMs })
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    expect(decryptAppContext(context, SECRET, NOW)?.uid).toBe('u');
  });

  // Guest mode: Zoom omits uid entirely. This must decrypt successfully with
  // nobody in it, so the app can carry on anonymously rather than treating a
  // guest as a broken context and retrying forever.
  it('decrypts a guest context to a null uid, not a failure', () => {
    const context = encryptContext({ mid: 'm', typ: 'meeting', exp: futureExpMs });

    const result = decryptAppContext(context, SECRET, NOW);
    expect(result).not.toBeNull();
    expect(result.uid).toBeNull();
    expect(result.mid).toBe('m');
  });

  it('refuses an expired context', () => {
    const context = encryptContext({ uid: 'u', exp: NOW - 1 });

    expect(decryptAppContext(context, SECRET, NOW)).toBeNull();
  });

  // Without an expiry the context is a bearer credential that never dies.
  it('refuses a context with no expiry', () => {
    const context = encryptContext({ uid: 'u', typ: 'meeting' });

    expect(decryptAppContext(context, SECRET, NOW)).toBeNull();
  });

  it('refuses a context encrypted with a different secret', () => {
    const context = encryptContext({ uid: 'u', exp: futureExpMs }, { secret: 'other-secret' });

    expect(decryptAppContext(context, SECRET, NOW)).toBeNull();
  });

  it('refuses a tampered auth tag', () => {
    const buf = Buffer.from(encryptContext({ uid: 'u', exp: futureExpMs }), 'base64');
    buf[buf.length - 1] ^= 0xff;

    expect(decryptAppContext(buf.toString('base64'), SECRET, NOW)).toBeNull();
  });

  it('refuses tampered ciphertext', () => {
    const buf = Buffer.from(encryptContext({ uid: 'u', exp: futureExpMs }), 'base64');
    // Past the 1-byte iv length, the 12-byte iv, and the 2-byte aad length.
    buf[20] ^= 0xff;

    expect(decryptAppContext(buf.toString('base64'), SECRET, NOW)).toBeNull();
  });

  it('refuses a truncated envelope instead of throwing', () => {
    const full = Buffer.from(encryptContext({ uid: 'u', exp: futureExpMs }), 'base64');

    for (const cut of [1, 5, 20, full.length - 8]) {
      expect(decryptAppContext(full.subarray(0, cut).toString('base64'), SECRET, NOW)).toBeNull();
    }
  });

  it('refuses values that are not a Zoom context at all', () => {
    for (const junk of ['', 'not-base64-$$$', 'aGVsbG8gd29ybGQ=', 'AA==']) {
      expect(decryptAppContext(junk, SECRET, NOW)).toBeNull();
    }
  });

  it('refuses everything when the client secret is missing', () => {
    const context = encryptContext({ uid: 'u', exp: futureExpMs });

    expect(decryptAppContext(context, undefined, NOW)).toBeNull();
    expect(decryptAppContext(context, '', NOW)).toBeNull();
  });

  it('refuses non-string input', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(decryptAppContext(bad, SECRET, NOW)).toBeNull();
    }
  });
});
