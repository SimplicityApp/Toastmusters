import crypto from 'node:crypto';

/**
 * Test-only helpers. Not matched by vitest's `**\/*.test.js` include, and never
 * imported by worker/index.js, so none of this reaches the deployed bundle.
 */

/**
 * Encrypt a payload exactly the way Zoom encrypts an app context, so tests
 * exercise the real envelope rather than a shape invented to match our parser.
 *
 *   [ivLength: 1][iv][aadLength: 2][aad][cipherTextLength: 4][cipherText][tag: 16]
 *
 * base64, AES-256-GCM, key = SHA-256 of the client secret, lengths little-endian.
 *
 * @param {Object} payload - the context JSON (uid, mid, typ, ts, exp)
 * @param {Object} [options]
 * @param {string} options.secret - client secret to derive the key from
 * @param {Buffer} [options.aad] - additional authenticated data
 * @returns {string} base64 context string
 */
export function encryptZoomContext(payload, { secret, aad = Buffer.from('zoom-app') } = {}) {
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const cipherText = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const ivLength = Buffer.alloc(1);
  ivLength.writeUInt8(iv.length);
  const aadLength = Buffer.alloc(2);
  aadLength.writeUInt16LE(aad.length);
  const cipherTextLength = Buffer.alloc(4);
  cipherTextLength.writeInt32LE(cipherText.length);

  return Buffer.concat([
    ivLength,
    iv,
    aadLength,
    aad,
    cipherTextLength,
    cipherText,
    tag,
  ]).toString('base64');
}
