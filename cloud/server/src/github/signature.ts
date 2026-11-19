import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * GitHub webhook signature check, the same rule as the #63 launcher
 * (deploy/aws-microvm/launcher/lib/signature.mjs): X-Hub-Signature-256 is "sha256=" followed by the
 * hex HMAC-SHA256 of the raw request body, keyed with the App's webhook secret.
 */

const HEADER_PATTERN = /^sha256=([0-9a-f]{64})$/i;

export function verifySignature(rawBody: string | Buffer, header: string | undefined, secret: string): boolean {
  // An empty secret would make the HMAC computable by anyone; never accept it.
  if (!secret) return false;
  if (typeof header !== 'string') return false;
  const match = HEADER_PATTERN.exec(header.trim());
  if (!match?.[1]) return false;
  const received = Buffer.from(match[1], 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(received, expected);
}

/** The header value GitHub would send for this body and secret. Used by tests. */
export function signBody(rawBody: string | Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}
