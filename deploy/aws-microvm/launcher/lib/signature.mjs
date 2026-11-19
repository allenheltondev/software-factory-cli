// GitHub webhook signature check: X-Hub-Signature-256 is "sha256=" followed by the hex
// HMAC-SHA256 of the raw request body, keyed with the App's webhook secret.
import crypto from 'node:crypto';

const HEADER_PATTERN = /^sha256=([0-9a-f]{64})$/i;

/**
 * @param {Buffer} rawBody the request body exactly as received (before any parsing)
 * @param {string | undefined} header the X-Hub-Signature-256 header value
 * @param {string} secret the webhook secret
 * @returns {boolean} true only when the header is well formed and matches
 */
export function verifySignature(rawBody, header, secret) {
  // An empty secret would make the HMAC computable by anyone; never accept it.
  if (typeof secret !== 'string' || secret.length === 0) return false;
  if (typeof header !== 'string') return false;
  const match = HEADER_PATTERN.exec(header.trim());
  if (!match) return false;
  const received = Buffer.from(match[1], 'hex');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  // Both are 32 bytes here (the pattern guarantees 64 hex digits), so the comparison never
  // throws on a length mismatch and takes the same time wherever the first difference is.
  return crypto.timingSafeEqual(received, expected);
}

/** The header value GitHub would send for this body and secret. Used by tests and tools. */
export function signBody(rawBody, secret) {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}
