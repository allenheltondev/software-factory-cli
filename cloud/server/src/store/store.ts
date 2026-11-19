/**
 * What Updraft Cloud keeps, behind an interface (DynamoDB in production, memory in tests).
 *
 * Single table (UpdraftTable), pk/sk:
 *   OAUTH#<state>        STATE                 a pending link or install, single use, TTL 10 minutes
 *   USER#<sub>           PROFILE               the linked GitHub identity of an RSC user
 *   GHUSER#<githubId>    LINK                  which RSC user a GitHub identity is linked to (unique)
 *   TENANT#<installId>   META                  a tenant: one installation of the Updraft App
 *   TENANT#<installId>   MEMBER#<sub>          a member, GSI1 USER#<sub> / TENANT#<installId>
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
  /** Why it is disabled: suspended or uninstalled on GitHub. */
  disabledReason?: 'suspended' | 'uninstalled';
  /** Epoch ms after which an uninstalled tenant's data is deleted. */
  deleteAfter?: number;
  createdAt: string;
  createdBy: string;
}

export type MemberRole = 'owner' | 'editor';

export interface Member {
  installationId: number;
  sub: string;
  role: MemberRole;
  githubLogin: string;
  addedAt: string;
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

  getTenant(installationId: number): Promise<Tenant | null>;
  /** Creates the tenant if it is new (keeping an existing one as it is) and adds or updates the member. */
  putTenantWithMember(tenant: Tenant, member: Member): Promise<void>;
  updateTenantStatus(installationId: number, update: Pick<Tenant, 'status' | 'disabledReason' | 'deleteAfter'>): Promise<boolean>;
  getMember(installationId: number, sub: string): Promise<Member | null>;
  listMemberships(sub: string): Promise<Member[]>;
}

/** In-memory Store for tests and local dev without AWS. */
export function createMemoryStore(): Store & { dump(): Record<string, unknown> } {
  const states = new Map<string, OAuthState>();
  const links = new Map<string, GitHubLink>();
  const owners = new Map<number, string>();
  const tenants = new Map<number, Tenant>();
  const members = new Map<string, Member>();
  const memberKey = (id: number, sub: string) => `${id}/${sub}`;

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
    },
    async getTenant(id) {
      return tenants.get(id) ?? null;
    },
    async putTenantWithMember(tenant, member) {
      if (!tenants.has(tenant.installationId)) tenants.set(tenant.installationId, { ...tenant });
      members.set(memberKey(member.installationId, member.sub), { ...member });
    },
    async updateTenantStatus(id, update) {
      const t = tenants.get(id);
      if (!t) return false;
      const next: Tenant = { ...t, status: update.status };
      if (update.disabledReason) next.disabledReason = update.disabledReason;
      else delete next.disabledReason;
      if (update.deleteAfter) next.deleteAfter = update.deleteAfter;
      else delete next.deleteAfter;
      tenants.set(id, next);
      return true;
    },
    async getMember(id, sub) {
      return members.get(memberKey(id, sub)) ?? null;
    },
    async listMemberships(sub) {
      return [...members.values()].filter((m) => m.sub === sub);
    },
    dump() {
      return { states: [...states.values()], links: [...links], tenants: [...tenants.values()], members: [...members.values()] };
    },
  };
}
