import type { Caller } from '../caller.js';

/**
 * Who may use the admin view (#68): the members of one Cognito group in the Ready, Set, Cloud user
 * pool, named by the stack's `AdminGroup` parameter (ADMIN_GROUP; `admin` by default), as the
 * other Ready, Set, Cloud apps check their admins. Membership comes from the verified ID token's
 * `cognito:groups`, so a change applies from the person's next token (within the hour).
 */
export const DEFAULT_ADMIN_GROUP = 'admin';

export interface AdminAccess {
  isAdmin(caller: Caller): Promise<boolean>;
}

export function isAdmin(caller: Caller, group: string): boolean {
  return group !== '' && (caller.groups ?? []).includes(group);
}

/** An empty group makes nobody an admin. */
export function adminAccess(group: string): AdminAccess {
  const required = group.trim();
  return { isAdmin: async (caller) => isAdmin(caller, required) };
}
