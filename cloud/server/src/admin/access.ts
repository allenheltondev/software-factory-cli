import type { Caller } from '../caller.js';

/**
 * Who may use the admin view (#68): an allow-list in the SSM parameter `/updraft/admins`, one per
 * account. Entries are separated by commas or whitespace; each is a Cognito `sub`, or
 * `group:<name>` for everyone in that Ready, Set, Cloud group.
 *
 * The stack does not create the parameter, so nobody is an admin until an operator writes it.
 * It is read at most once a minute; one that cannot be read makes nobody an admin.
 */
export const ADMINS_PARAMETER = '/updraft/admins';

export interface AdminAllowList {
  subs: ReadonlySet<string>;
  groups: ReadonlySet<string>;
}

export const NOBODY: AdminAllowList = { subs: new Set(), groups: new Set() };

export function parseAllowList(value: string | null | undefined): AdminAllowList {
  const subs = new Set<string>();
  const groups = new Set<string>();
  for (const entry of (value ?? '').split(/[\s,]+/).filter(Boolean)) {
    if (entry.startsWith('group:')) {
      const name = entry.slice('group:'.length);
      if (name) groups.add(name);
    } else subs.add(entry);
  }
  return { subs, groups };
}

export function isAdmin(caller: Caller, list: AdminAllowList): boolean {
  return list.subs.has(caller.sub) || (caller.groups ?? []).some((g) => list.groups.has(g));
}

export interface AdminAccess {
  isAdmin(caller: Caller): Promise<boolean>;
}

/** `read` resolves to the parameter's value, or null when there is none. */
export function createAdminAccess({
  read,
  now = Date.now,
  ttlMs = 60_000,
  log = (entry) => console.log(JSON.stringify(entry)),
}: {
  read: () => Promise<string | null>;
  now?: () => number;
  ttlMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}): AdminAccess {
  let cached: { list: AdminAllowList; at: number } | undefined;
  return {
    async isAdmin(caller) {
      if (!cached || now() - cached.at >= ttlMs) {
        let list = NOBODY;
        try {
          list = parseAllowList(await read());
        } catch (err) {
          log({ warning: 'the admin allow-list could not be read; nobody is an admin', name: (err as Error)?.name });
        }
        cached = { list, at: now() };
      }
      return isAdmin(caller, cached.list);
    },
  };
}
