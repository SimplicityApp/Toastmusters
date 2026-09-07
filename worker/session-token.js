import crypto from 'node:crypto';

/**
 * Signed session tokens binding a request to one Zoom user.
 *
 * Analytics can live with a client-asserted identity — the worst case is a
 * skewed chart. Storage cannot: a sync endpoint that believes a client-supplied
 * uid lets anyone read and overwrite anyone else's agenda, rules and artwork.
 *
 * So the uid is established in exactly one place — decrypting Zoom's app
 * context, server-side — and everything downstream carries this token instead
 * of naming a user. The client never gets to say who it is.
 *
 * Signed with SESSION_SIGNING_KEY, which is deliberately NOT ZOOM_CLIENT_SECRET:
 * that one is a Zoom credential used as an encryption key elsewhere, and reusing
 * it here would tie two unrelated trust domains to one rotation.
 */

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const SEPARATOR = '.';

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(encodedPayload, secret) {
  return crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

/**
 * Mint a token for a resolved Zoom user.
 *
 * @param {string} uid - Zoom user id, from a verified context decrypt only
 * @param {string} secret - SESSION_SIGNING_KEY
 * @param {number} [now] - epoch ms, injectable for tests
 * @returns {string|null} `payload.signature`, or null if it cannot be signed
 */
export function mintSessionToken(uid, secret, now = Date.now()) {
  if (!uid || typeof uid !== 'string' || !secret) return null;

  const encodedPayload = base64url(JSON.stringify({ uid, iat: now, exp: now + TOKEN_TTL_MS }));
  return `${encodedPayload}${SEPARATOR}${sign(encodedPayload, secret)}`;
}

/**
 * Verify a token and recover the uid it was minted for.
 *
 * @param {string|null|undefined} token
 * @param {string|undefined} secret - SESSION_SIGNING_KEY
 * @param {number} [now] - epoch ms, injectable for tests
 * @returns {{uid: string, exp: number}|null} null whenever the token cannot be trusted
 */
export function verifySessionToken(token, secret, now = Date.now()) {
  if (!token || typeof token !== 'string' || !secret) return null;

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

  if (!payload || typeof payload.uid !== 'string' || !payload.uid) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;

  return { uid: payload.uid, exp: payload.exp };
}

/**
 * Pull a bearer token out of a request's Authorization header.
 *
 * @param {Request} request
 * @returns {string|null}
 */
export function readBearerToken(request) {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export { TOKEN_TTL_MS };
