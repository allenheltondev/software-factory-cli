import { createSign } from 'node:crypto';

/**
 * The App's own JWT (RS256), for the App-level endpoints (`GET /app/installations/{id}`, installation
 * tokens). GitHub accepts at most ten minutes; issue it 60 seconds in the past for clock drift.
 */
export function appJwt(appId: string, privateKeyPem: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat, exp: iat + 9 * 60, iss: appId })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKeyPem).toString('base64url');
  return `${unsigned}.${signature}`;
}
