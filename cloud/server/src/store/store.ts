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
  /** The config version jobs start with; absent until one is published (no config, no jobs). */
  activeConfigVersion?: number;
}

/** One published config: an immutable bundle under tenants/<id>/config/<version>/ in the tenant bucket. */
export interface ConfigVersion {
  installationId: number;
  version: number;
  /** pending: allocated, the upload may not have finished (never activated). ready: fully uploaded. */
  status: 'pending' | 'ready';
  sha256: string;
  files: string[];
  publishedBy: string;
  publishedAt: string;
}

/** That an agent key is set (never its value, which lives only in Secrets Manager). */
export interface AgentKeyMeta {
  name: string;
  updatedAt: string;
  updatedBy: string;
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

export interface InstallationAccount {
  id: number;
  login: string;
  type: string;
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
   * `tombstone`: there was no tenant, so one is recorded already uninstalled (and expiring with the
   * same TTL): a Connect or install callback racing the delete cannot create the tenant afterwards.
   */
  markUninstalled(installationId: number, deleteAfter: number, account?: InstallationAccount): Promise<'marked' | 'already' | 'tombstone'>;
  /** Suspended or active again, unless the tenant was uninstalled (one conditional write). */
  setSuspended(installationId: number, suspended: boolean): Promise<'updated' | 'uninstalled' | 'no_tenant'>;
  getMember(installationId: number, sub: string): Promise<Member | null>;
  listMemberships(sub: string): Promise<Member[]>;

  /**
   * Allocates the next config version as `pending` (versions only ever grow). `uninstalled`: the
   * tenant is gone or going, so nothing is allocated; `no_tenant`: there is no such tenant.
   */
  createConfigVersion(installationId: number, meta: Omit<ConfigVersion, 'installationId' | 'version' | 'status'>): Promise<number | 'uninstalled' | 'no_tenant'>;
  /** The bundle is fully uploaded. */
  markConfigReady(installationId: number, version: number): Promise<void>;
  /**
   * Makes a ready version the one jobs start with, in one transaction with the checks. Only ever
   * forward: `superseded` when a newer version is active already (a slow publish finishing after
   * a later one). The previous active version stays active on any refusal.
   */
  activateConfig(installationId: number, version: number): Promise<'activated' | 'superseded' | 'not_ready' | 'uninstalled' | 'no_tenant'>;
  listConfigVersions(installationId: number): Promise<ConfigVersion[]>;

  /** Refused (`uninstalled`) once the tenant is uninstalled or gone, so no row escapes the sweep. */
  putAgentKeyMeta(installationId: number, meta: AgentKeyMeta): Promise<'stored' | 'uninstalled'>;
  listAgentKeyMeta(installationId: number): Promise<AgentKeyMeta[]>;

  /**
   * Uninstalled tenants whose deadline has passed and whose data outside the table (the S3 prefix,
   * the key secrets) is not deleted yet. markUninstalled records them, without a TTL, so they
   * outlive the tenant's own rows.
   */
  listDueCleanups(now: number): Promise<CleanupEntry[]>;
  /** The tenant's data outside the table is gone: forget the entry. */
  completeCleanup(entry: CleanupEntry): Promise<void>;
  /**
   * At the deadline: deletes every row of the tenant's partition, including any an interrupted
   * uninstall sweep left without a TTL. Safe to repeat.
   */
  purgeTenantPartition(installationId: number): Promise<void>;
}

export interface CleanupEntry {
  installationId: number;
  deleteAfter: number;
}

/** In-memory Store for tests and local dev without AWS. `ttl` is recorded as DynamoDB would hold it. */
export function createMemoryStore(): Store & { ttlOf(installationId: number): { tenant?: number; members: (number | undefined)[] } } {
  const states = new Map<string, OAuthState>();
  const links = new Map<string, GitHubLink>();
  const owners = new Map<number, string>();
  const offers = new Map<string, InstallationOffer>();
  const tenants = new Map<number, Tenant & { ttl?: number }>();
  const members = new Map<string, Member & { ttl?: number }>();
  const configs = new Map<string, ConfigVersion>();
  const cleanups = new Map<number, CleanupEntry>();
  const keys = new Map<string, AgentKeyMeta>();
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
    async markUninstalled(id, deleteAfter, account) {
      const t = tenants.get(id);
      if (!t) {
        tenants.set(id, {
          installationId: id,
          accountId: account?.id ?? 0,
          accountLogin: account?.login ?? '',
          accountType: account?.type ?? '',
          status: 'disabled',
          disabledReason: 'uninstalled',
          deleteAfter,
          ttl: Math.ceil(deleteAfter / 1000),
          createdAt: new Date(0).toISOString(),
          createdBy: 'github:installation.deleted',
        });
        cleanups.set(id, { installationId: id, deleteAfter });
        return 'tombstone';
      }
      const already = t.disabledReason === 'uninstalled';
      const deadline = already ? (t.deleteAfter ?? deleteAfter) : deleteAfter;
      const ttl = Math.ceil(deadline / 1000);
      if (!already) tenants.set(id, { ...t, status: 'disabled', disabledReason: 'uninstalled', deleteAfter, ttl });
      for (const [k, m] of members) if (m.installationId === id && m.ttl !== ttl) members.set(k, { ...m, ttl });
      cleanups.set(id, { installationId: id, deleteAfter: deadline });
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
    async createConfigVersion(id, meta) {
      const t = tenants.get(id);
      if (!t) return 'no_tenant';
      if (t.disabledReason === 'uninstalled') return 'uninstalled';
      const version = Math.max(0, ...[...configs.values()].filter((c) => c.installationId === id).map((c) => c.version)) + 1;
      configs.set(`${id}/${version}`, { ...meta, installationId: id, version, status: 'pending' });
      return version;
    },
    async markConfigReady(id, version) {
      const c = configs.get(`${id}/${version}`);
      if (c) configs.set(`${id}/${version}`, { ...c, status: 'ready' });
    },
    async activateConfig(id, version) {
      const t = tenants.get(id);
      if (!t) return 'no_tenant';
      if (t.disabledReason === 'uninstalled') return 'uninstalled';
      if (configs.get(`${id}/${version}`)?.status !== 'ready') return 'not_ready';
      if (t.activeConfigVersion !== undefined && t.activeConfigVersion >= version) return 'superseded';
      tenants.set(id, { ...t, activeConfigVersion: version });
      return 'activated';
    },
    async listConfigVersions(id) {
      return [...configs.values()].filter((c) => c.installationId === id).sort((a, b) => a.version - b.version).map((c) => ({ ...c }));
    },
    async putAgentKeyMeta(id, meta) {
      const t = tenants.get(id);
      if (!t || t.disabledReason === 'uninstalled') return 'uninstalled';
      keys.set(`${id}/${meta.name}`, { ...meta });
      return 'stored';
    },
    async listDueCleanups(now) {
      return [...cleanups.values()].filter((c) => c.deleteAfter <= now).map((c) => ({ ...c }));
    },
    async purgeTenantPartition(id) {
      tenants.delete(id);
      for (const [k, m] of members) if (m.installationId === id) members.delete(k);
      for (const [k, c] of configs) if (c.installationId === id) configs.delete(k);
      for (const k of [...keys.keys()]) if (k.startsWith(`${id}/`)) keys.delete(k);
    },
    async completeCleanup(entry) {
      if (cleanups.get(entry.installationId)?.deleteAfter === entry.deleteAfter) cleanups.delete(entry.installationId);
    },
    async listAgentKeyMeta(id) {
      return [...keys.entries()].filter(([k]) => k.startsWith(`${id}/`)).map(([, v]) => ({ ...v })).sort((a, b) => a.name.localeCompare(b.name));
    },
    ttlOf(id) {
      return {
        tenant: tenants.get(id)?.ttl,
        members: [...members.values()].filter((m) => m.installationId === id).map((m) => m.ttl),
      };
    },
  };
}
