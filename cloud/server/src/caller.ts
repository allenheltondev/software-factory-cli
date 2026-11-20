/**
 * Who is calling. In production, API Gateway's Cognito authorizer has already verified the ID
 * token's signature, issuer and expiry, and hands its claims to the function as strings
 * (`requestContext.authorizer.claims`). Locally, `local.ts` verifies the token itself and passes
 * the same claims here.
 *
 * The authorizer accepts a token minted for any app client in the shared Ready, Set, Cloud pool.
 * Only tokens for this stack's own client may reach the API, so `aud` is checked here.
 */

export interface Caller {
  /** The Cognito `sub`: the stable id every Updraft record is keyed by. */
  sub: string;
  email?: string;
  name?: string;
  /** The caller's Ready, Set, Cloud (Cognito) groups. */
  groups?: string[];
}

export type Claims = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** A Caller from verified ID-token claims, or null when they are not for this app's client. */
export function callerFromClaims(claims: Claims | null | undefined, clientId: string): Caller | null {
  if (!claims || !clientId) return null;
  if (claims.token_use !== 'id') return null;
  if (claims.aud !== clientId) return null;
  const sub = str(claims.sub);
  if (!sub) return null;

  const caller: Caller = { sub };
  const email = str(claims.email);
  if (email) caller.email = email;
  const name = [str(claims.given_name), str(claims.family_name)].filter(Boolean).join(' ');
  if (name) caller.name = name;
  const groups = groupsFrom(claims['cognito:groups']);
  if (groups.length > 0) caller.groups = groups;
  return caller;
}

/**
 * `cognito:groups` as a list, from a verified token's own claims, where it is an array. API
 * Gateway's authorizer hands claims over as strings, which flatten an array ("[a, b]") so that a
 * group name containing a comma or a space (both legal) cannot be told from two groups: such a
 * string grants nothing, and the API takes the groups from the token itself (lambda.ts).
 */
export function groupsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((g): g is string => typeof g === 'string' && g !== '');
}
