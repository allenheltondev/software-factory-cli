import { createHash, randomBytes } from 'node:crypto';
import type { Caller } from '../caller.js';
import { GitHubError, type GitHubApi, type GitHubInstallation, type GitHubRepository, type GitHubUser } from '../github/client.js';
import { appJwt } from '../github/jwt.js';
import type { AppSettings, LoadSettings } from '../github/settings.js';
import type { GitHubLink, Member, OAuthKind, OfferedInstallation, Store, Tenant } from '../store/store.js';

/**
 * Linking a GitHub identity to a Ready, Set, Cloud user, and onboarding installations of the
 * Updraft App as tenants (#67).
 *
 * Both flows leave through GitHub and come back to the SPA's /github/callback, which posts what
 * GitHub returned to `completeCallback`. A `state` the server issued, single use, bound to the
 * caller's `sub` and valid for ten minutes, is the only thing that ties a callback to a session;
 * a callback without one is never acted on. An installation id is never trusted: it must be among
 * the installations the GitHub user can access, the App must see it, and the user must have
 * authority over its account (the account itself, or an active admin of the org).
 *
 * - Installing: GitHub's install page, with "request user authorization during installation", so
 *   the callback carries a fresh code and the new installation's id.
 * - Linking (a fresh PKCE authorization) also finds the installations the user already has
 *   authority over and offers them; `connect` onboards one the user picks within ten minutes.
 *   That is how an installation made outside Updraft, or one whose install callback expired, is
 *   connected.
 * - A membership records the GitHub identity whose authority earned it, and counts only while the
 *   caller is still linked to that identity: unlinking, or relinking another account, ends access.
 * - An uninstalled tenant is gone once its deadline passes, before DynamoDB's TTL deletes it.
 */

export const STATE_TTL_MS = 10 * 60 * 1000;
export const OFFER_TTL_MS = 10 * 60 * 1000;
/** At most this many existing installations are checked and offered per link. */
export const MAX_OFFERED = 50;

export type FlowErrorCode =
  | 'github_app_not_configured'
  | 'state_invalid'
  | 'github_exchange_failed'
  | 'github_identity_taken'
  | 'github_already_linked'
  | 'github_account_mismatch'
  | 'not_linked'
  | 'installation_not_found'
  | 'offer_expired'
  | 'not_authorized'
  | 'tenant_disabled';

export class FlowError extends Error {
  readonly code: FlowErrorCode;
  readonly status: number;
  constructor(code: FlowErrorCode, status: number, message: string) {
    super(message);
    this.name = 'FlowError';
    this.code = code;
    this.status = status;
  }
}

export interface CallbackInput {
  code?: string;
  state?: string;
  installationId?: string;
  setupAction?: string;
}

/** An existing installation the user may connect (or already has). */
export interface ConnectableInstallation {
  installationId: number;
  accountLogin: string;
  accountType: string;
  connected: boolean;
}

export type CallbackResult =
  | { kind: 'linked'; githubLogin: string; installations: ConnectableInstallation[] }
  | { kind: 'installed'; githubLogin: string; installationId: number; accountLogin: string }
  /** An org member asked an owner to install the App; nothing to onboard until they approve. */
  | { kind: 'requested'; githubLogin: string };

export interface TenantSummary {
  installationId: number;
  accountLogin: string;
  accountType: string;
  status: Tenant['status'];
  disabledReason?: Tenant['disabledReason'];
  role: Member['role'];
}

export interface GitHubStatus {
  configured: boolean;
  appSlug?: string;
  linked: { githubLogin: string; githubUserId: number } | null;
  tenants: TenantSummary[];
}

export interface FlowDeps {
  store: Store;
  github: GitHubApi;
  loadSettings: LoadSettings;
  now?: () => number;
  randomToken?: () => string;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export function createGitHubFlows({ store, github, loadSettings, now = () => Date.now(), randomToken = () => b64url(randomBytes(32)) }: FlowDeps) {
  async function settings(): Promise<AppSettings> {
    const s = await loadSettings();
    if (!s) throw new FlowError('github_app_not_configured', 503, 'The Updraft GitHub App is not registered for this deployment yet');
    return s;
  }

  const callbackUrl = (s: AppSettings) => `${s.appUrl}/github/callback`;
  const gone = (t: Tenant) => t.deleteAfter !== undefined && t.deleteAfter <= now();

  const summarize = (t: Tenant, m: Member): TenantSummary => ({
    installationId: t.installationId,
    accountLogin: t.accountLogin,
    accountType: t.accountType,
    status: t.status,
    ...(t.disabledReason ? { disabledReason: t.disabledReason } : {}),
    role: m.role,
  });

  async function newState(caller: Caller, kind: OAuthKind, codeVerifier?: string): Promise<string> {
    const state = randomToken();
    await store.putOAuthState({ state, sub: caller.sub, kind, expiresAt: now() + STATE_TTL_MS, ...(codeVerifier ? { codeVerifier } : {}) });
    return state;
  }

  /** The user-to-server token for a code, and who it belongs to. */
  async function identify(s: AppSettings, code: string, codeVerifier?: string, redirectUri?: string): Promise<{ token: string; user: GitHubUser }> {
    let token: string;
    try {
      token = await github.exchangeCode({
        clientId: s.clientId,
        clientSecret: s.clientSecret,
        code,
        ...(redirectUri ? { redirectUri } : {}),
        ...(codeVerifier ? { codeVerifier } : {}),
      });
    } catch (err) {
      if (err instanceof GitHubError) throw new FlowError('github_exchange_failed', 400, 'GitHub did not accept the authorization; start again');
      throw err;
    }
    return { token, user: await github.getUser(token) };
  }

  /** Link the identity to the caller, or confirm it is the one already linked. */
  async function ensureLinked(caller: Caller, user: GitHubUser): Promise<void> {
    const existing = await store.getLink(caller.sub);
    if (existing && existing.githubUserId !== user.id) {
      throw new FlowError(
        'github_account_mismatch',
        409,
        `You are linked to @${existing.githubLogin}, but GitHub signed you in as @${user.login}. Unlink first, or switch GitHub accounts.`,
      );
    }
    if (existing) return;
    const result = await store.link(caller.sub, { githubUserId: user.id, githubLogin: user.login, linkedAt: new Date(now()).toISOString() });
    if (result === 'taken') throw new FlowError('github_identity_taken', 409, `@${user.login} is already linked to another Ready, Set, Cloud account`);
    if (result === 'relink') throw new FlowError('github_already_linked', 409, 'This account is linked to a different GitHub identity; unlink it first');
  }

  /** Whether this GitHub user may manage the installation's account. */
  async function hasAuthority(token: string, user: GitHubUser, installation: GitHubInstallation): Promise<boolean> {
    const account = installation.account;
    if (account.type === 'User') return account.id === user.id;
    if (account.type === 'Organization') {
      const membership = await github.getOrgMembership(token, account.login);
      return membership?.role === 'admin' && membership.state === 'active';
    }
    return false;
  }

  /** Writes the tenant (if new) and the caller as owner, bound to the GitHub identity that proved authority. */
  async function addOwner(caller: Caller, user: GitHubUser, installation: OfferedInstallation): Promise<void> {
    const existing = await store.getTenant(installation.installationId);
    if (existing?.disabledReason === 'uninstalled') {
      throw new FlowError('tenant_disabled', 409, 'This installation was removed from GitHub; install the App again');
    }
    const at = new Date(now()).toISOString();
    await store.putTenantWithMember(
      {
        installationId: installation.installationId,
        accountId: installation.accountId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        status: installation.suspended ? 'disabled' : 'active',
        ...(installation.suspended ? { disabledReason: 'suspended' as const } : {}),
        createdAt: at,
        createdBy: caller.sub,
      },
      { installationId: installation.installationId, sub: caller.sub, role: 'owner', githubUserId: user.id, githubLogin: user.login, addedAt: at },
    );
  }

  const offered = (i: GitHubInstallation): OfferedInstallation => ({
    installationId: i.id,
    accountId: i.account.id,
    accountLogin: i.account.login,
    accountType: i.account.type,
    suspended: i.suspendedAt !== null,
  });

  async function onboard(caller: Caller, s: AppSettings, token: string, user: GitHubUser, installationId: number) {
    // 1. The user can access it (so it is theirs to name), 2. the App sees it (so it is ours).
    const accessible = await github.listUserInstallationIds(token);
    if (!accessible.includes(installationId)) {
      throw new FlowError('installation_not_found', 404, 'GitHub does not list that installation for your account');
    }
    const installation = await github.getInstallation(appJwt(s.appId, s.privateKey, now()), installationId);
    if (!installation) throw new FlowError('installation_not_found', 404, 'That installation is not an installation of the Updraft App');
    // 3. They have authority over the account it is installed on.
    if (!(await hasAuthority(token, user, installation))) {
      throw new FlowError(
        'not_authorized',
        403,
        installation.account.type === 'Organization'
          ? `Only an owner of the ${installation.account.login} organization can connect it to Updraft`
          : `Only @${installation.account.login} can connect this installation`,
      );
    }
    await addOwner(caller, user, offered(installation));
    return installation;
  }

  /** Installations this user has authority over right now, offered to connect for OFFER_TTL_MS. */
  async function offerExisting(caller: Caller, s: AppSettings, token: string, user: GitHubUser): Promise<ConnectableInstallation[]> {
    const jwt = appJwt(s.appId, s.privateKey, now());
    const eligible: OfferedInstallation[] = [];
    for (const id of (await github.listUserInstallationIds(token)).slice(0, MAX_OFFERED)) {
      const installation = await github.getInstallation(jwt, id);
      if (installation && (await hasAuthority(token, user, installation))) eligible.push(offered(installation));
    }
    await store.putOffer({ sub: caller.sub, githubUserId: user.id, githubLogin: user.login, installations: eligible, expiresAt: now() + OFFER_TTL_MS });
    const out: ConnectableInstallation[] = [];
    for (const i of eligible) {
      const member = await store.getMember(i.installationId, caller.sub);
      const tenant = member ? await store.getTenant(i.installationId) : null;
      out.push({
        installationId: i.installationId,
        accountLogin: i.accountLogin,
        accountType: i.accountType,
        connected: Boolean(member && tenant && !gone(tenant) && member.githubUserId === user.id),
      });
    }
    return out.sort((a, b) => a.accountLogin.localeCompare(b.accountLogin));
  }

  /** The caller's memberships that still count: same GitHub identity as now linked, tenant not gone. */
  async function liveMemberships(caller: Caller, link: GitHubLink | null): Promise<{ tenant: Tenant; member: Member }[]> {
    if (!link) return [];
    const out: { tenant: Tenant; member: Member }[] = [];
    for (const member of await store.listMemberships(caller.sub)) {
      if (member.githubUserId !== link.githubUserId) continue;
      const tenant = await store.getTenant(member.installationId);
      if (tenant && !gone(tenant)) out.push({ tenant, member });
    }
    return out;
  }

  async function memberOf(caller: Caller, installationId: number): Promise<{ tenant: Tenant; member: Member }> {
    const [link, member] = await Promise.all([store.getLink(caller.sub), store.getMember(installationId, caller.sub)]);
    const tenant = member && link && member.githubUserId === link.githubUserId ? await store.getTenant(installationId) : null;
    // The same answer for "no such tenant", "not yours" and "no longer yours", so ids cannot be probed.
    if (!member || !tenant || gone(tenant)) throw new FlowError('not_authorized', 403, 'You are not a member of that installation');
    return { tenant, member };
  }

  const installationTokens = new Map<number, { token: string; expiresAt: number }>();

  return {
    async status(caller: Caller): Promise<GitHubStatus> {
      const [s, link] = await Promise.all([loadSettings(), store.getLink(caller.sub)]);
      const tenants = (await liveMemberships(caller, link)).map(({ tenant, member }) => summarize(tenant, member));
      return {
        configured: s !== null,
        ...(s ? { appSlug: s.slug } : {}),
        linked: link ? { githubLogin: link.githubLogin, githubUserId: link.githubUserId } : null,
        tenants: tenants.sort((a, b) => a.accountLogin.localeCompare(b.accountLogin)),
      };
    },

    /** The GitHub URL that starts linking (the App's user authorization, with PKCE). */
    async startLink(caller: Caller): Promise<{ url: string }> {
      const s = await settings();
      const verifier = randomToken();
      const challenge = b64url(createHash('sha256').update(verifier).digest());
      const state = await newState(caller, 'link', verifier);
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', s.clientId);
      url.searchParams.set('redirect_uri', callbackUrl(s));
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('allow_signup', 'false');
      return { url: url.toString() };
    },

    /** The GitHub URL that installs the App (or configures an existing installation). */
    async startInstall(caller: Caller): Promise<{ url: string }> {
      const s = await settings();
      const state = await newState(caller, 'install');
      const url = new URL(`https://github.com/apps/${encodeURIComponent(s.slug)}/installations/new`);
      url.searchParams.set('state', state);
      return { url: url.toString() };
    },

    async completeCallback(caller: Caller, input: CallbackInput): Promise<CallbackResult> {
      const s = await settings();
      // Consume first: whatever happens next, this state cannot be used again.
      const issued = input.state ? await store.consumeOAuthState(input.state) : null;
      if (!issued || issued.sub !== caller.sub || issued.expiresAt < now()) {
        throw new FlowError('state_invalid', 400, 'This GitHub sign-in did not start here, was already used, or took too long; start again');
      }
      if (!input.code) throw new FlowError('github_exchange_failed', 400, 'GitHub returned no authorization code; start again');

      if (issued.kind === 'link') {
        const { token, user } = await identify(s, input.code, issued.codeVerifier, callbackUrl(s));
        await ensureLinked(caller, user);
        return { kind: 'linked', githubLogin: user.login, installations: await offerExisting(caller, s, token, user) };
      }

      const { token, user } = await identify(s, input.code);
      await ensureLinked(caller, user);
      if (input.setupAction === 'request') return { kind: 'requested', githubLogin: user.login };
      const installationId = Number(input.installationId);
      if (!Number.isSafeInteger(installationId) || installationId <= 0) {
        throw new FlowError('installation_not_found', 400, 'GitHub returned no installation; start again');
      }
      const installation = await onboard(caller, s, token, user, installationId);
      return { kind: 'installed', githubLogin: user.login, installationId, accountLogin: installation.account.login };
    },

    /**
     * Connects an installation from the caller's current offer: authority was checked with a fresh
     * GitHub token when the offer was made, at most OFFER_TTL_MS ago, for the identity still linked.
     */
    async connect(caller: Caller, installationId: number): Promise<{ installationId: number; accountLogin: string }> {
      await settings();
      const [offer, link] = await Promise.all([store.getOffer(caller.sub), store.getLink(caller.sub)]);
      if (!offer || offer.expiresAt < now() || !link || link.githubUserId !== offer.githubUserId) {
        throw new FlowError('offer_expired', 409, 'Find your installations again: link GitHub from the dashboard');
      }
      const installation = offer.installations.find((i) => i.installationId === installationId);
      if (!installation) throw new FlowError('not_authorized', 403, 'That installation was not offered to you');
      await addOwner(caller, { id: offer.githubUserId, login: offer.githubLogin }, installation);
      return { installationId, accountLogin: installation.accountLogin };
    },

    async unlink(caller: Caller): Promise<void> {
      await store.unlink(caller.sub);
    },

    async repositories(caller: Caller, installationId: number): Promise<{ tenant: TenantSummary; repositories: GitHubRepository[] }> {
      const s = await settings();
      const { tenant, member } = await memberOf(caller, installationId);
      const summary = summarize(tenant, member);
      if (tenant.status !== 'active') return { tenant: summary, repositories: [] };
      let cached = installationTokens.get(installationId);
      if (!cached || cached.expiresAt - now() < 5 * 60 * 1000) {
        cached = await github.createInstallationToken(appJwt(s.appId, s.privateKey, now()), installationId);
        installationTokens.set(installationId, cached);
      }
      const repositories = await github.listInstallationRepositories(cached.token);
      return { tenant: summary, repositories: repositories.sort((a, b) => a.fullName.localeCompare(b.fullName)) };
    },
  };
}

export type GitHubFlows = ReturnType<typeof createGitHubFlows>;
