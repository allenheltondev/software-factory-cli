import { createHash, randomBytes } from 'node:crypto';
import type { Caller } from '../caller.js';
import { GitHubError, type GitHubApi, type GitHubInstallation, type GitHubRepository, type GitHubUser } from '../github/client.js';
import { appJwt } from '../github/jwt.js';
import type { AppSettings, LoadSettings } from '../github/settings.js';
import type { Member, OAuthKind, Store, Tenant } from '../store/store.js';

/**
 * Linking a GitHub identity to a Ready, Set, Cloud user, and onboarding installations of the
 * Updraft App as tenants (#67).
 *
 * Both flows leave through GitHub and come back to the SPA's /github/callback, which posts what
 * GitHub returned to `completeCallback`. A `state` the server issued, single use, bound to the
 * caller's `sub` and valid for ten minutes, is the only thing that ties a callback to a session;
 * a callback without one is never acted on. An installation id in the query is never trusted: it
 * must be among the installations the GitHub user can access, the App must see it, and the user
 * must have authority over its account (the account itself, or an admin of the org).
 */

export const STATE_TTL_MS = 10 * 60 * 1000;

export type FlowErrorCode =
  | 'github_app_not_configured'
  | 'state_invalid'
  | 'github_exchange_failed'
  | 'github_identity_taken'
  | 'github_already_linked'
  | 'github_account_mismatch'
  | 'not_linked'
  | 'installation_not_found'
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

export type CallbackResult =
  | { kind: 'linked'; githubLogin: string }
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
    const existing = await store.getTenant(installationId);
    if (existing?.status === 'disabled' && existing.disabledReason === 'uninstalled') {
      throw new FlowError('tenant_disabled', 409, 'This installation was removed from GitHub; install the App again');
    }
    const at = new Date(now()).toISOString();
    await store.putTenantWithMember(
      {
        installationId,
        accountId: installation.account.id,
        accountLogin: installation.account.login,
        accountType: installation.account.type,
        status: installation.suspendedAt ? 'disabled' : 'active',
        ...(installation.suspendedAt ? { disabledReason: 'suspended' as const } : {}),
        createdAt: at,
        createdBy: caller.sub,
      },
      { installationId, sub: caller.sub, role: 'owner', githubLogin: user.login, addedAt: at },
    );
    return installation;
  }

  async function memberOf(caller: Caller, installationId: number): Promise<{ tenant: Tenant; member: Member }> {
    const member = await store.getMember(installationId, caller.sub);
    const tenant = member ? await store.getTenant(installationId) : null;
    // The same answer for "no such tenant" and "not yours", so ids cannot be probed.
    if (!member || !tenant) throw new FlowError('not_authorized', 403, 'You are not a member of that installation');
    return { tenant, member };
  }

  const installationTokens = new Map<number, { token: string; expiresAt: number }>();

  return {
    async status(caller: Caller): Promise<GitHubStatus> {
      const [s, link, memberships] = await Promise.all([loadSettings(), store.getLink(caller.sub), store.listMemberships(caller.sub)]);
      const tenants: TenantSummary[] = [];
      for (const m of memberships) {
        const t = await store.getTenant(m.installationId);
        if (!t) continue;
        tenants.push({
          installationId: t.installationId,
          accountLogin: t.accountLogin,
          accountType: t.accountType,
          status: t.status,
          ...(t.disabledReason ? { disabledReason: t.disabledReason } : {}),
          role: m.role,
        });
      }
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
        const { user } = await identify(s, input.code, issued.codeVerifier, callbackUrl(s));
        await ensureLinked(caller, user);
        return { kind: 'linked', githubLogin: user.login };
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

    async unlink(caller: Caller): Promise<void> {
      await store.unlink(caller.sub);
    },

    async repositories(caller: Caller, installationId: number): Promise<{ tenant: TenantSummary; repositories: GitHubRepository[] }> {
      const s = await settings();
      const { tenant, member } = await memberOf(caller, installationId);
      const summary: TenantSummary = {
        installationId,
        accountLogin: tenant.accountLogin,
        accountType: tenant.accountType,
        status: tenant.status,
        ...(tenant.disabledReason ? { disabledReason: tenant.disabledReason } : {}),
        role: member.role,
      };
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
