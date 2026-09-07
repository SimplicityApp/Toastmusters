import { describe, it, expect } from 'vitest';
import {
  mintSessionToken,
  verifySessionToken,
  readBearerToken,
  TOKEN_TTL_MS,
} from './session-token.js';

const KEY = 'test-session-signing-key';
const NOW = 1_756_000_000_000;

describe('session tokens', () => {
  it('round-trips a uid', () => {
    const token = mintSessionToken('zoom-uid-1', KEY, NOW);

    expect(verifySessionToken(token, KEY, NOW)).toEqual({
      uid: 'zoom-uid-1',
      exp: NOW + TOKEN_TTL_MS,
    });
  });

  it('rejects the token once it expires', () => {
    const token = mintSessionToken('u', KEY, NOW);

    expect(verifySessionToken(token, KEY, NOW + TOKEN_TTL_MS - 1)).not.toBeNull();
    expect(verifySessionToken(token, KEY, NOW + TOKEN_TTL_MS)).toBeNull();
  });

  it('rejects a token signed with a different key', () => {
    const token = mintSessionToken('u', 'another-key', NOW);

    expect(verifySessionToken(token, KEY, NOW)).toBeNull();
  });

  // The whole point of the signature: nobody can promote themselves to another
  // uid by editing the payload.
  it('rejects a payload edited to name a different user', () => {
    const token = mintSessionToken('victim-uid', KEY, NOW);
    const signature = token.slice(token.indexOf('.') + 1);
    const forgedPayload = Buffer.from(
      JSON.stringify({ uid: 'attacker-uid', iat: NOW, exp: NOW + TOKEN_TTL_MS })
    ).toString('base64url');

    expect(verifySessionToken(`${forgedPayload}.${signature}`, KEY, NOW)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const token = mintSessionToken('u', KEY, NOW);
    const flipped = `${token.slice(0, -1)}${token.at(-1) === 'A' ? 'B' : 'A'}`;

    expect(verifySessionToken(flipped, KEY, NOW)).toBeNull();
  });

  it('rejects malformed tokens instead of throwing', () => {
    for (const junk of ['', '.', 'nodot', '.sig', 'payload.', 'a.b.c', '!!!.???']) {
      expect(verifySessionToken(junk, KEY, NOW)).toBeNull();
    }
  });

  it('refuses to mint or verify without a signing key', () => {
    expect(mintSessionToken('u', undefined, NOW)).toBeNull();
    expect(mintSessionToken('u', '', NOW)).toBeNull();
    expect(verifySessionToken(mintSessionToken('u', KEY, NOW), undefined, NOW)).toBeNull();
  });

  it('refuses to mint without a uid', () => {
    for (const bad of ['', null, undefined, 42]) {
      expect(mintSessionToken(bad, KEY, NOW)).toBeNull();
    }
  });
});

describe('readBearerToken', () => {
  it('reads a bearer token case-insensitively', () => {
    const withHeader = (value) => new Request('https://x/', { headers: { authorization: value } });

    expect(readBearerToken(withHeader('Bearer abc.def'))).toBe('abc.def');
    expect(readBearerToken(withHeader('bearer abc.def'))).toBe('abc.def');
  });

  it('returns null when there is no usable bearer token', () => {
    expect(readBearerToken(new Request('https://x/'))).toBeNull();
    expect(
      readBearerToken(new Request('https://x/', { headers: { authorization: 'Basic abc' } }))
    ).toBeNull();
    expect(
      readBearerToken(new Request('https://x/', { headers: { authorization: 'Bearer' } }))
    ).toBeNull();
  });
});
