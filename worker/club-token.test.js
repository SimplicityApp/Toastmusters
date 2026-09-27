import { describe, it, expect } from 'vitest';
import {
  mintClubToken,
  verifyClubToken,
  clubTokenMatchesVersion,
  readClubHeader,
  CLUB_TOKEN_TTL_MS,
} from './club-token.js';

const KEY = 'test-session-signing-key';
const NOW = 1_800_000_000_000;
const claims = (over = {}) => ({ clubId: 'club-1', deviceId: 'dev-1', uid: 'zoom-uid-1', ver: 3, ...over });

describe('club tokens', () => {
  it('round-trips a club, a device and the user who activated it', () => {
    const token = mintClubToken(claims(), KEY, NOW);

    expect(verifyClubToken(token, KEY, NOW)).toEqual({
      clubId: 'club-1',
      deviceId: 'dev-1',
      uid: 'zoom-uid-1',
      ver: 3,
      iat: NOW,
      exp: NOW + CLUB_TOKEN_TTL_MS,
    });
  });

  // Activation is anonymous on purpose: a guest with no Zoom identity has to
  // be able to use a club code.
  it('mints for a guest device with no uid', () => {
    const token = mintClubToken(claims({ uid: null }), KEY, NOW);

    expect(verifyClubToken(token, KEY, NOW)).toMatchObject({ clubId: 'club-1', uid: null });
  });

  it('expires after 24 hours, and honours an injected now', () => {
    const token = mintClubToken(claims(), KEY, NOW);

    expect(verifyClubToken(token, KEY, NOW + CLUB_TOKEN_TTL_MS - 1)).not.toBeNull();
    expect(verifyClubToken(token, KEY, NOW + CLUB_TOKEN_TTL_MS)).toBeNull();
  });

  it('rejects a token signed with a different key', () => {
    expect(verifyClubToken(mintClubToken(claims(), 'another-key', NOW), KEY, NOW)).toBeNull();
  });

  // The whole point of the signature: nobody joins a club, or promotes their
  // device out of a revocation, by editing the payload.
  it('rejects a payload edited to name a different club, device or version', () => {
    const token = mintClubToken(claims(), KEY, NOW);
    const signature = token.slice(token.indexOf('.') + 1);

    for (const forged of [
      { ...claims(), clubId: 'club-someone-else' },
      { ...claims(), deviceId: 'dev-not-revoked' },
      { ...claims(), ver: 99 },
    ]) {
      const payload = Buffer.from(JSON.stringify({ ...forged, iat: NOW, exp: NOW + CLUB_TOKEN_TTL_MS })).toString('base64url');
      expect(verifyClubToken(`${payload}.${signature}`, KEY, NOW)).toBeNull();
    }
  });

  it('rejects a tampered signature', () => {
    const token = mintClubToken(claims(), KEY, NOW);
    const flipped = `${token.slice(0, -1)}${token.at(-1) === 'A' ? 'B' : 'A'}`;

    expect(verifyClubToken(flipped, KEY, NOW)).toBeNull();
  });

  // timingSafeEqual throws on differing sizes, so the length check has to come
  // first — and a length mismatch is not a secret worth protecting.
  it('returns null rather than throwing for signatures of the wrong length', () => {
    const token = mintClubToken(claims(), KEY, NOW);
    const [payload] = token.split('.');

    expect(() => verifyClubToken(`${payload}.short`, KEY, NOW)).not.toThrow();
    expect(verifyClubToken(`${payload}.short`, KEY, NOW)).toBeNull();
  });

  it('rejects malformed tokens instead of throwing', () => {
    for (const junk of ['', '.', 'nodot', '.sig', 'payload.', 'a.b.c', '!!!.???']) {
      expect(verifyClubToken(junk, KEY, NOW)).toBeNull();
    }
  });

  it('refuses to mint without a club, a device or a signing key', () => {
    expect(mintClubToken(claims({ clubId: '' }), KEY, NOW)).toBeNull();
    expect(mintClubToken(claims({ deviceId: null }), KEY, NOW)).toBeNull();
    expect(mintClubToken(claims(), undefined, NOW)).toBeNull();
    expect(mintClubToken(undefined, KEY, NOW)).toBeNull();
  });

  it('falls back to the default lifetime for a nonsense ttl', () => {
    const odd = mintClubToken(claims(), KEY, NOW, -5);
    expect(verifyClubToken(odd, KEY, NOW + CLUB_TOKEN_TTL_MS)).toBeNull();
    expect(verifyClubToken(odd, KEY, NOW)).not.toBeNull();
  });
});

describe('clubTokenMatchesVersion', () => {
  // Reported, not enforced: `ver` moves on a publish, and refusing a stale one
  // would lock every device out for a day after a routine preset change.
  it('spots a token minted before the club published', () => {
    const payload = verifyClubToken(mintClubToken(claims({ ver: 3 }), KEY, NOW), KEY, NOW);

    expect(clubTokenMatchesVersion(payload, { ver: 3 })).toBe(true);
    expect(clubTokenMatchesVersion(payload, { ver: 4 })).toBe(false);
    expect(clubTokenMatchesVersion(payload, null)).toBe(false);
    expect(clubTokenMatchesVersion(null, { ver: 3 })).toBe(false);
  });

  it('treats a missing version as 1 on both sides', () => {
    expect(clubTokenMatchesVersion({}, {})).toBe(true);
  });
});

describe('readClubHeader', () => {
  it('reads and trims the X-Club header', () => {
    expect(readClubHeader(new Request('https://x/', { headers: { 'x-club': '  abc.def  ' } }))).toBe('abc.def');
    expect(readClubHeader(new Request('https://x/'))).toBeNull();
    expect(readClubHeader(new Request('https://x/', { headers: { 'x-club': '   ' } }))).toBeNull();
  });
});
