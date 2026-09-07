import crypto from 'node:crypto';

/**
 * Decrypt the Zoom App context that identifies who opened the app.
 *
 * Zoom sends this two ways, and both land here:
 *  - as the `X-Zoom-App-Context` header on the initial document request, which
 *    the Worker already sees — no SDK capability, no Marketplace change;
 *  - as the `context` string from the SDK's `getAppContext()`, which survives
 *    popout, reload and client-side navigation, where the header does not.
 *
 * The payload's `uid` is the one durable thing about a user we can get without
 * asking them for anything: Zoom documents it as the user id, stable across
 * meetings and sessions. `participantUUID` from getUserContext() is NOT a
 * substitute — that one is meeting-scoped (see readSelfParticipantUUID in the
 * Zoom app), which is why identity could never be built on it.
 *
 * Guests have no `uid` at all ("In Guest Mode, x-zoom-app-context header does
 * not contain the uid field"), so a guest payload is a valid decrypt with
 * nobody in it, not a failure.
 *
 * Format, per Zoom's spec — every length is little-endian:
 *   [ivLength: 1][iv][aadLength: 2][aad][cipherTextLength: 4][cipherText][tag: 16]
 * base64, AES-256-GCM, key = SHA-256 of the client secret.
 */

const TAG_LENGTH = 16;

/**
 * Zoom sends standard base64, but the value travels in a header and through a
 * JSON body, so tolerate the URL-safe alphabet rather than failing to decrypt
 * over two substituted characters.
 */
function toBuffer(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64');
}

/**
 * Pull the length-prefixed sections apart.
 *
 * Every read is bounds-checked against the buffer we actually got. Node's
 * Buffer reads throw on overrun and subarray silently returns something short,
 * so a truncated or non-Zoom value would otherwise either blow up in the
 * request path or reach the cipher as a nonsense-but-plausible input.
 *
 * @returns {{iv: Buffer, aad: Buffer, cipherText: Buffer, tag: Buffer}|null}
 */
function parseEnvelope(buf) {
  let offset = 0;
  const need = (bytes) => offset + bytes <= buf.length;

  if (!need(1)) return null;
  const ivLength = buf.readUInt8(offset);
  offset += 1;
  if (!need(ivLength)) return null;
  const iv = buf.subarray(offset, offset + ivLength);
  offset += ivLength;

  if (!need(2)) return null;
  const aadLength = buf.readUInt16LE(offset);
  offset += 2;
  if (!need(aadLength)) return null;
  const aad = buf.subarray(offset, offset + aadLength);
  offset += aadLength;

  if (!need(4)) return null;
  const cipherTextLength = buf.readInt32LE(offset);
  offset += 4;
  if (cipherTextLength < 0 || !need(cipherTextLength)) return null;
  const cipherText = buf.subarray(offset, offset + cipherTextLength);
  offset += cipherTextLength;

  if (!need(TAG_LENGTH)) return null;
  const tag = buf.subarray(offset, offset + TAG_LENGTH);

  if (ivLength === 0 || cipherTextLength === 0) return null;
  return { iv, aad, cipherText, tag };
}

/**
 * Decrypt and validate a Zoom App context.
 *
 * Never throws: this runs on every app load, and a malformed or expired context
 * means "we don't know who this is", which the app is built to carry on with.
 * Every failure is a null, so no caller can accidentally treat a broken decrypt
 * as an identity.
 *
 * @param {string|null|undefined} value - base64 context, from the header or getAppContext()
 * @param {string|undefined} clientSecret - ZOOM_CLIENT_SECRET
 * @param {number} [now] - current epoch ms, injectable for tests
 * @returns {{uid: string|null, mid: string|null, typ: string|null, exp: number|null}|null}
 *   null when the context could not be trusted; a payload with uid === null for guests
 */
export function decryptAppContext(value, clientSecret, now = Date.now()) {
  if (!value || typeof value !== 'string' || !clientSecret) return null;

  let payload;
  try {
    const envelope = parseEnvelope(toBuffer(value));
    if (!envelope) return null;

    const key = crypto.createHash('sha256').update(clientSecret).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, envelope.iv);
    decipher.setAAD(envelope.aad);
    decipher.setAuthTag(envelope.tag);

    // final() is what verifies the auth tag, so a wrong secret or a tampered
    // ciphertext fails here rather than yielding garbage.
    const plaintext =
      decipher.update(envelope.cipherText, undefined, 'utf8') + decipher.final('utf8');
    payload = JSON.parse(plaintext);
  } catch {
    return null;
  }

  if (!payload || typeof payload !== 'object') return null;

  // Zoom stamps an expiry precisely so a captured context cannot be replayed
  // forever. Without this check the whole thing is a bearer credential with no
  // lifetime. Contexts missing exp are refused rather than trusted forever.
  const exp = typeof payload.exp === 'number' ? payload.exp : null;
  if (exp === null) return null;
  // Zoom documents exp as "long, the expiration timestamp" without pinning the
  // unit, and their samples differ. Both readings are safe to accept because
  // the ranges cannot overlap in practice: 1e12 is the year 33658 in seconds
  // and September 2001 in milliseconds, so a real timestamp is unambiguous.
  const expMs = exp < 1e12 ? exp * 1000 : exp;
  if (expMs <= now) return null;

  return {
    uid: typeof payload.uid === 'string' && payload.uid ? payload.uid : null,
    mid: typeof payload.mid === 'string' && payload.mid ? payload.mid : null,
    typ: typeof payload.typ === 'string' && payload.typ ? payload.typ : null,
    exp,
  };
}
