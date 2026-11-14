import crypto from 'node:crypto';

/**
 * Signed club tokens: the second credential a request may carry.
 *
 * A club is not an identity. It is a thing a device joined by typing a code,
 * and it travels in its own header (`X-Club`) alongside — never inside — the
 * session token. Either credential may be absent: a guest who typed a code has
 * only this one, a subscriber who never joined a club has only the other.
 *
 * Folding the club into the session token would mean solving it twice. The Zoom
 * bearer is re-minted on every webview load from Zoom's encrypted context, and
 * the web cookie is HttpOnly and unreadable by the SPA that has to display
 * "you're on Downtown Speakers". A separate credential works identically on
 * both surfaces, and is the only shape that serves the /pro/<code> landing
 * page, where a browser with no Zoom identity must still come away on Pro.
 *
 * Same construction and the same signing key as session-token.js: one HMAC to
 * rotate, one set of failure modes to reason about. Sending a token rather than
 * the raw code also keeps the code itself out of request logs.
 */

const CLUB_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long past its `exp` a token can still be traded in at GET /api/club.
 *
 * The 24-hour TTL above bounds what a token buys on its own: every read that
 * does not consult KV. The refresh is different. It reads the device record and
 * the club record before it mints anything, so a revoked device (403), a device
 * that left (403) and a deleted club (404) are refused there whatever the
 * token's age. A strict 24 hours on that one route added no protection and cost
 * a club its devices: a device refreshes at most once a day, so the token it
 * sends is nearly always already expired. A club that meets weekly lost every
 * device every week.
 *
 * 180 days rather than 90 because a club's timing laptop can sit in a drawer
 * through a summer recess, and many clubs break from June to September. Past
 * this the device has to type the code again.
 */
const CLUB_TOKEN_REFRESH_GRACE_MS = 180 * 24 * 60 * 60 * 1000;

const SEPARATOR = '.';

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(encodedPayload, secret) {
  return crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

/**
 * Mint a token for one device's membership of one club.
 *
 * `deviceId` is what revocation hangs off, so it is part of the signed payload
 * rather than something the client names later. `uid` is optional on purpose:
 * activation is anonymous, and a guest device is a first-class case.
 *
 * @param {{clubId: string, deviceId: string, uid?: string|null, ver?: number}} claims
 * @param {string} secret - SESSION_SIGNING_KEY
 * @param {number} [now] - epoch ms, injectable for tests
 * @param {number} [ttlMs] - lifetime; defaults to 24h, re-minted by GET /api/club
 * @returns {string|null} `payload.signature`, or null if it cannot be signed
 */
export function mintClubToken({ clubId, deviceId, uid = null, ver = 1 } = {}, secret, now = Date.now(), ttlMs = CLUB_TOKEN_TTL_MS) {
  if (!clubId || typeof clubId !== 'string') return null;
  if (!deviceId || typeof deviceId !== 'string') return null;
  if (!secret) return null;
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : CLUB_TOKEN_TTL_MS;

  const encodedPayload = base64url(
    JSON.stringify({
      clubId,
      deviceId,
      uid: typeof uid === 'string' && uid ? uid : null,
      ver: Number.isFinite(ver) ? ver : 1,
      iat: now,
      exp: now + ttl,
    })
  );
  return `${encodedPayload}${SEPARATOR}${sign(encodedPayload, secret)}`;
}

/**
 * Verify a club token and recover its claims.
 *
 * HMAC and expiry only — no KV read, which is what keeps this cheap enough to
 * send on every request. Revocation is enforced separately, on the paths that
 * were already going to write (see worker/club.js).
 *
 * `graceMs` accepts a token that expired up to that long ago. Only the refresh
 * passes it (CLUB_TOKEN_REFRESH_GRACE_MS), because only the refresh checks the
 * device and club records before it trusts the claims. Every other caller keeps
 * the strict default of zero.
 *
 * @param {string|null|undefined} token
 * @param {string|undefined} secret - SESSION_SIGNING_KEY
 * @param {number} [now] - epoch ms, injectable for tests
 * @param {{graceMs?: number}} [options]
 * @returns {{clubId: string, deviceId: string, uid: string|null, ver: number,
 *   iat: number|null, exp: number}|null} null whenever the token cannot be trusted
 */
export function verifyClubToken(token, secret, now = Date.now(), { graceMs = 0 } = {}) {
  if (!token || typeof token !== 'string' || !secret) return null;
  const grace = Number.isFinite(graceMs) && graceMs > 0 ? graceMs : 0;

  const separatorAt = token.indexOf(SEPARATOR);
  if (separatorAt <= 0 || separatorAt === token.length - 1) return null;
  const encodedPayload = token.slice(0, separatorAt);
  const signature = token.slice(separatorAt + 1);

  const expected = sign(encodedPayload, secret);
  // Length must match before timingSafeEqual, which throws on differing sizes —
  // and a length mismatch is not a secret worth protecting.
  if (signature.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  // Only parsed after the signature checks out, so malformed JSON can never be
  // reached by anyone who does not hold the signing key.
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload || typeof payload.clubId !== 'string' || !payload.clubId) return null;
  if (typeof payload.deviceId !== 'string' || !payload.deviceId) return null;
  if (typeof payload.exp !== 'number' || payload.exp + grace <= now) return null;

  return {
    clubId: payload.clubId,
    deviceId: payload.deviceId,
    uid: typeof payload.uid === 'string' && payload.uid ? payload.uid : null,
    ver: typeof payload.ver === 'number' ? payload.ver : 1,
    iat: typeof payload.iat === 'number' ? payload.iat : null,
    exp: payload.exp,
  };
}

/**
 * Whether a token was minted against the club's current content version.
 *
 * Reported rather than enforced: `ver` moves on a publish or a kit edit
 * (phases 2 and 3), and a device holding a stale one is simply a device with
 * older presets — refusing its writes for up to 24 hours would punish it for
 * someone else's edit. Access is cut off by revoking the device record, which
 * takes effect on the very next write.
 *
 * @param {{ver: number}|null} claims
 * @param {{ver?: number}|null} club
 */
export function clubTokenMatchesVersion(claims, club) {
  if (!claims || !club) return false;
  return (claims.ver ?? 1) === (club.ver ?? 1);
}

/** Pull the club token out of a request's X-Club header. */
export function readClubHeader(request) {
  const header = request.headers.get('x-club');
  if (!header) return null;
  const value = header.trim();
  return value || null;
}

export { CLUB_TOKEN_TTL_MS, CLUB_TOKEN_REFRESH_GRACE_MS };
