/**
 * What Updraft Cloud keeps, behind an interface (DynamoDB in production, memory in tests).
 *
 * Single table (UpdraftTable), pk/sk:
 *   OAUTH#<state>        STATE                 a pending link or install, single use, TTL 10 minutes
 *   USER#<sub>           PROFILE               the linked GitHub identity of an RSC user
 *   USER#<sub>           OFFER                 installations the user may connect, TTL 10 minutes
 *   GHUSER#<githubId>    LINK                  which RSC user a GitHub identity is linked to (unique)
 *   TENANT#<installId>   META                  a tenant: one installation of the Updraft App
 *   TENANT#<installId>   MEMBER#<sub>          a member, GSI1 USER#<sub> / TENANT#<installId>
 *
 * Everything in a TENANT# partition gets the table's `ttl` (epoch seconds) when the App is
 * uninstalled, so DynamoDB deletes the tenant and its members once the retention has passed.
 */

export type OAuthKind = 'link' | 'install';

export interface OAuthState {
  state: string;
  sub: string;
  kind: OAuthKind;
  /** PKCE verifier (link only: the install flow's authorization carries no challenge). */
  codeVerifier?: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface GitHubLink {
  githubUserId: number;
  githubLogin: string;
  linkedAt: string;
}

export type TenantStatus = 'active' | 'disabled';

export interface Tenant {
  installationId: number;
  accountId: number;
  accountLogin: string;
  accountType: string;
  status: TenantStatus;
  /** Why it is disabled: suspended or uninstalled on GitHub. Uninstalled is final. */
  disabledReason?: 'suspended' | 'uninstalled';
  /** Epoch ms after which an uninstalled tenant is gone (reads stop at once; DynamoDB TTL deletes it). */
  deleteAfter?: number;
  createdAt: string;
  createdBy: string;
}

export type MemberRole = 'owner' | 'editor';

export interface Member {
  installationId: number;
  sub: string;
  role: MemberRole;
  /** The GitHub identity whose authority earned this membership; it counts only while still linked. */
  githubUserId: number;
  githubLogin: string;
  addedAt: string;
}

/** An installation the user was shown to have authority over, for them to connect. */
export interface OfferedInstallation {
  installationId: number;
  accountId: number;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
}

export interface InstallationOffer {
  sub: string;
  githubUserId: number;
  githubLogin: string;
  installations: OfferedInstallation[];
  /** Epoch ms. */
  expiresAt: number;
}

export interface Store {
  putOAuthState(state: OAuthState): Promise<void>;
  /** Removes and returns the state, or null when it does not exist (never issued, or already used). */
  consumeOAuthState(state: string): Promise<OAuthState | null>;

  getLink(sub: string): Promise<GitHubLink | null>;
  /**
   * Links a GitHub identity to a user. `taken`: that identity belongs to another user.
   * `relink`: this user is already linked to a different identity (unlink first).
   */
  link(sub: string, link: GitHubLink): Promise<'linked' | 'taken' | 'relink'>;
  unlink(sub: string): Promise<void>;

  /** Replaces the user's offer (one at a time). */
  putOffer(offer: InstallationOffer): Promise<void>;
  getOffer(sub: string): Promise<InstallationOffer | null>;

  getTenant(installationId: number): Promise<Tenant | null>;
  /**
   * Creates the tenant if it is new (keeping an existing one as it is) and adds or updates the
   * member, atomically with a check that the tenant is not uninstalled (`uninstalled`: nothing added).
   */
  putTenantWithMember(tenant: Tenant, member: Member): Promise<'added' | 'uninstalled'>;
  /**
   * Uninstalled: final. Sets the deadline and the TTL of every item in the tenant's partition.
   * `already`: it was uninstalled before and keeps its original deadline; the partition sweep runs
   * again with that deadline, so one cut short by a failure completes on the next delivery.
   */
  markUninstalled(installationId: number, deleteAfter: number): Promise<'marked' | 'already' | 'no_tenant'>;
  /** Suspended or active again, unless the tenant was uninstalled (one conditional write). */
  setSuspended(installationId: number, suspended: boolean): Promise<'updated' | 'uninstalled' | 'no_tenant'>;
  getMember(installationId: number, sub: string): Promise<Member | null>;
  listMemberships(sub: string): Promise<Member[]>;
}

/** In-memory Store for tests and local dev without AWS. `ttl` is recorded as DynamoDB would hold it. */
export function createMemoryStore(): Store & { ttlOf(installationId: number): { tenant?: number; members: (number | undefined)[] } } {
  const states = new Map<string, OAuthState>();
  const links = new Map<string, GitHubLink>();
  const owners = new Map<number, string>();
  const offers = new Map<string, InstallationOffer>();
  const tenants = new Map<number, Tenant & { ttl?: number }>();
  const members = new Map<string, Member & { ttl?: number }>();
  const memberKey = (id: number, sub: string) => `${id}/${sub}`;
  const strip = <T extends { ttl?: number }>(item: T): Omit<T, 'ttl'> => {
    const { ttl: _ttl, ...rest } = item;
    return rest;
  };

  return {
    async putOAuthState(s) {
      states.set(s.state, { ...s });
    },
    async consumeOAuthState(state) {
      const s = states.get(state) ?? null;
      states.delete(state);
      return s;
    },
    async getLink(sub) {
      return links.get(sub) ?? null;
    },
    async link(sub, link) {
      const owner = owners.get(link.githubUserId);
      if (owner && owner !== sub) return 'taken';
      const existing = links.get(sub);
      if (existing && existing.githubUserId !== link.githubUserId) return 'relink';
      owners.set(link.githubUserId, sub);
      links.set(sub, { ...link });
      return 'linked';
    },
    async unlink(sub) {
      const existing = links.get(sub);
      if (existing) owners.delete(existing.githubUserId);
      links.delete(sub);
      offers.delete(sub);
    },
    async putOffer(offer) {
      offers.set(offer.sub, structuredClone(offer));
    },
    async getOffer(sub) {
      const o = offers.get(sub);
      return o ? structuredClone(o) : null;
    },
    async getTenant(id) {
      const t = tenants.get(id);
      return t ? (strip(t) as Tenant) : null;
    },
    async putTenantWithMember(tenant, member) {
      if (!tenants.has(tenant.installationId)) tenants.set(tenant.installationId, { ...tenant });
      if (tenants.get(tenant.installationId)?.disabledReason === 'uninstalled') return 'uninstalled';
      members.set(memberKey(member.installationId, member.sub), { ...member });
      return 'added';
    },
    async markUninstalled(id, deleteAfter) {
      const t = tenants.get(id);
      if (!t) return 'no_tenant';
      const already = t.disabledReason === 'uninstalled';
      const deadline = already ? (t.deleteAfter ?? deleteAfter) : deleteAfter;
      const ttl = Math.ceil(deadline / 1000);
      if (!already) tenants.set(id, { ...t, status: 'disabled', disabledReason: 'uninstalled', deleteAfter, ttl });
      for (const [k, m] of members) if (m.installationId === id && m.ttl !== ttl) members.set(k, { ...m, ttl });
      return already ? 'already' : 'marked';
    },
    async setSuspended(id, suspended) {
      const t = tenants.get(id);
      if (!t) return 'no_tenant';
      if (t.disabledReason === 'uninstalled') return 'uninstalled';
      const next: Tenant & { ttl?: number } = { ...t, status: suspended ? 'disabled' : 'active' };
      if (suspended) next.disabledReason = 'suspended';
      else delete next.disabledReason;
      tenants.set(id, next);
      return 'updated';
    },
    async getMember(id, sub) {
      const m = members.get(memberKey(id, sub));
      return m ? (strip(m) as Member) : null;
    },
    async listMemberships(sub) {
      return [...members.values()].filter((m) => m.sub === sub).map((m) => strip(m) as Member);
    },
    ttlOf(id) {
      return {
        tenant: tenants.get(id)?.ttl,
        members: [...members.values()].filter((m) => m.installationId === id).map((m) => m.ttl),
      };
    },
  };
}
