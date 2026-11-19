/**
 * The GitHub calls Updraft Cloud makes, behind an interface so the flows can be tested without
 * GitHub. Two kinds of credential:
 *   - a user-to-server token from the App's user authorization (link) or from "request user
 *     authorization during installation" (install). It proves who the GitHub user is and what they
 *     may see. It is used within the request that obtained it and never stored.
 *   - the App's JWT, and installation tokens minted from it, for the App's own view.
 */

export interface GitHubUser {
  id: number;
  login: string;
}

export interface GitHubAccount {
  id: number;
  login: string;
  type: 'User' | 'Organization' | string;
}

export interface GitHubInstallation {
  id: number;
  account: GitHubAccount;
  suspendedAt: string | null;
}

export interface GitHubRepository {
  id: number;
  fullName: string;
  private: boolean;
  htmlUrl: string;
}

export interface OrgMembership {
  role: 'admin' | 'member' | string;
  state: 'active' | 'pending' | string;
}

export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export interface GitHubApi {
  /** Exchange an authorization code for a user-to-server token (POST /login/oauth/access_token). */
  exchangeCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri?: string;
    codeVerifier?: string;
  }): Promise<string>;
  getUser(userToken: string): Promise<GitHubUser>;
  /** Ids of this App's installations the user can access (GET /user/installations). */
  listUserInstallationIds(userToken: string): Promise<number[]>;
  /** The user's membership in an org, or null when they are not a member (404). */
  getOrgMembership(userToken: string, org: string): Promise<OrgMembership | null>;
  /** The App's view of one installation (GET /app/installations/{id}), or null when it is not ours. */
  getInstallation(appJwt: string, installationId: number): Promise<GitHubInstallation | null>;
  /**
   * An installation token. With `scope`, one that reaches only those repositories and has only
   * those permissions (POST /app/installations/{id}/access_tokens with repository_ids and
   * permissions): what a job gets, so it can touch nothing but its own repository.
   */
  createInstallationToken(
    appJwt: string,
    installationId: number,
    scope?: { repositoryIds: number[]; permissions: Record<string, string> },
  ): Promise<{ token: string; expiresAt: number; permissions?: Record<string, string> }>;
  /** The App's bot user (`<slug>[bot]`), read with any token. */
  getBotUser(token: string, slug: string): Promise<GitHubUser>;
  listInstallationRepositories(installationToken: string): Promise<GitHubRepository[]>;
}

const API = 'https://api.github.com';
const MAX_PAGES = 10;

type Json = Record<string, unknown>;

export function createGitHubApi(fetchImpl: typeof fetch = (...a) => fetch(...a)): GitHubApi {
  async function call(path: string, token: string, init: RequestInit = {}, scheme = 'Bearer'): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/vnd.github+json');
    headers.set('x-github-api-version', '2022-11-28');
    headers.set('authorization', `${scheme} ${token}`);
    headers.set('user-agent', 'updraft-cloud');
    return fetchImpl(`${API}${path}`, { ...init, headers });
  }

  async function json<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) throw new GitHubError(res.status, `${what} failed (${res.status})`);
    return (await res.json()) as T;
  }

  return {
    async exchangeCode({ clientId, clientSecret, code, redirectUri, codeVerifier }) {
      const body: Json = { client_id: clientId, client_secret: clientSecret, code };
      if (redirectUri) body.redirect_uri = redirectUri;
      if (codeVerifier) body.code_verifier = codeVerifier;
      const res = await fetchImpl('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'updraft-cloud' },
        body: JSON.stringify(body),
      });
      const out = await json<Json>(res, 'code exchange');
      // GitHub answers 200 with { error } for a bad, used or expired code.
      if (typeof out.access_token !== 'string' || !out.access_token) {
        throw new GitHubError(400, `code exchange refused (${typeof out.error === 'string' ? out.error : 'no token'})`);
      }
      return out.access_token;
    },

    async getUser(userToken) {
      const u = await json<Json>(await call('/user', userToken), 'GET /user');
      return { id: Number(u.id), login: String(u.login) };
    },

    async listUserInstallationIds(userToken) {
      const ids: number[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const out = await json<{ installations?: Json[] }>(
          await call(`/user/installations?per_page=100&page=${page}`, userToken),
          'GET /user/installations',
        );
        const batch = out.installations ?? [];
        ids.push(...batch.map((i) => Number(i.id)));
        if (batch.length < 100) break;
      }
      return ids;
    },

    async getOrgMembership(userToken, org) {
      const res = await call(`/user/memberships/orgs/${encodeURIComponent(org)}`, userToken);
      if (res.status === 404 || res.status === 403) return null;
      const m = await json<Json>(res, 'GET /user/memberships/orgs');
      return { role: String(m.role), state: String(m.state) };
    },

    async getInstallation(jwt, installationId) {
      const res = await call(`/app/installations/${installationId}`, jwt);
      if (res.status === 404) return null;
      const i = await json<Json>(res, 'GET /app/installations');
      const account = (i.account ?? {}) as Json;
      return {
        id: Number(i.id),
        account: { id: Number(account.id), login: String(account.login), type: String(account.type) },
        suspendedAt: typeof i.suspended_at === 'string' ? i.suspended_at : null,
      };
    },

    async createInstallationToken(jwt, installationId, scope) {
      const init: RequestInit = { method: 'POST' };
      if (scope) {
        init.body = JSON.stringify({ repository_ids: scope.repositoryIds, permissions: scope.permissions });
        init.headers = { 'content-type': 'application/json' };
      }
      const out = await json<Json>(await call(`/app/installations/${installationId}/access_tokens`, jwt, init), 'POST /app/installations/access_tokens');
      const permissions = out.permissions && typeof out.permissions === 'object' ? (out.permissions as Record<string, string>) : undefined;
      return { token: String(out.token), expiresAt: Date.parse(String(out.expires_at)), ...(permissions ? { permissions } : {}) };
    },

    async getBotUser(token, slug) {
      const login = `${slug}[bot]`;
      const u = await json<Json>(await call(`/users/${encodeURIComponent(login)}`, token), 'GET /users/<bot>');
      return { id: Number(u.id), login: String(u.login ?? login) };
    },

    async listInstallationRepositories(token) {
      const repos: GitHubRepository[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const out = await json<{ repositories?: Json[] }>(
          await call(`/installation/repositories?per_page=100&page=${page}`, token),
          'GET /installation/repositories',
        );
        const batch = out.repositories ?? [];
        repos.push(
          ...batch.map((r) => ({
            id: Number(r.id),
            fullName: String(r.full_name),
            private: r.private === true,
            htmlUrl: String(r.html_url),
          })),
        );
        if (batch.length < 100) break;
      }
      return repos;
    },
  };
}
