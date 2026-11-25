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
  /** What the installation grants the App (`contents: write`, ...). */
  permissions?: Record<string, string>;
  /** The webhook events the installation is subscribed to (`issues`, `check_suite`, ...); absent when GitHub did not say. */
  events?: string[];
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

export interface PullRequestHead {
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
  headRef: string;
}

export interface LabeledIssue {
  number: number;
  title: string;
  htmlUrl: string;
  labels: string[];
}

export interface LabelEvent {
  id: number;
  actor: string | null;
  createdAt: string;
  label: string;
}

export interface CommitCheckCounts {
  /** Check runs and statuses seen. */
  total: number;
  pending: number;
  failed: number;
  passed: number;
  complete: boolean;
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
  /** `truncated`: GitHub had more than the pages read, so a repository missing here may still be reachable. */
  listInstallationRepositories(installationToken: string): Promise<GitHubRepository[] & { truncated?: true }>;
  issueState?(installationToken: string, repository: string, issue: number): Promise<{ open: boolean; labels: string[]; pullRequest?: true }>;
  /** A pull request's state and head (GET /repos/{owner}/{repo}/pulls/{n}). For the workflow reconciler. */
  pullRequestHead?(installationToken: string, repository: string, pullRequest: number): Promise<PullRequestHead>;
  /**
   * The checks of one commit, check runs and commit statuses together (newest per name or
   * context), as counts. `complete` is false when a listing could not be read to its end: then
   * nothing is known to be finished. For the workflow reconciler.
   */
  commitChecks?(installationToken: string, repository: string, sha: string): Promise<CommitCheckCounts>;
  /**
   * Open issues (not pull requests) carrying `label`, updated since `since` (ISO), newest first, at
   * most `limit`. For the missed-label scan (workflows/label-scan.ts).
   */
  labeledIssues?(installationToken: string, repository: string, label: string, since: string, limit: number): Promise<LabeledIssue[]>;
  /** The newest time `label` was applied to an issue: the event's id, who applied it and when; null when it never was. */
  latestLabelEvent?(installationToken: string, repository: string, issue: number, label: string): Promise<LabelEvent | null>;
  /** Comments on an issue (POST /repos/{owner}/{repo}/issues/{number}/comments). */
  createIssueComment(installationToken: string, repository: string, issue: number, body: string): Promise<void>;
  /** The same, answering the new comment's id: for a comment edited later (the admission queue's acknowledgement). */
  postIssueComment?(installationToken: string, repository: string, issue: number, body: string): Promise<number>;
  /** Replaces a comment's body (PATCH /repos/{owner}/{repo}/issues/comments/{id}). */
  updateIssueComment?(installationToken: string, repository: string, commentId: number, body: string): Promise<void>;
  /** The id of the App's own comment on the issue whose body carries `marker`, or null (newest first, a bounded search). */
  findIssueComment?(installationToken: string, repository: string, issue: number, marker: string, author?: string): Promise<number | null>;
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
        ...(i.permissions && typeof i.permissions === 'object'
          ? { permissions: Object.fromEntries(Object.entries(i.permissions as Json).filter(([, v]) => typeof v === 'string')) as Record<string, string> }
          : {}),
        ...(Array.isArray(i.events) ? { events: (i.events as unknown[]).filter((e): e is string => typeof e === 'string') } : {}),
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

    async issueState(token, repository, issue) {
      const [owner = '', repo = ''] = repository.split('/');
      const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issue}`;
      const out = await json<Json>(await call(path, token), 'GET /repos/issues');
      const labels = Array.isArray(out.labels) ? out.labels.flatMap((label: unknown) =>
        label && typeof label === 'object' && 'name' in label && typeof label.name === 'string' ? [label.name] : []) : [];
      return { open: out.state === 'open', labels, ...(out.pull_request ? { pullRequest: true as const } : {}) };
    },

    async pullRequestHead(token, repository, pullRequest) {
      const [owner = '', repo = ''] = repository.split('/');
      const out = await json<Json>(await call(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullRequest}`, token), 'GET /repos/pulls');
      const head = (out.head ?? {}) as Json;
      return { state: out.state === 'open' ? 'open' : 'closed', merged: out.merged === true, headSha: String(head.sha ?? ''), headRef: String(head.ref ?? '') };
    },

    async commitChecks(token, repository, sha) {
      const [owner = '', repo = ''] = repository.split('/');
      const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}`;
      const counts = { total: 0, pending: 0, failed: 0, passed: 0, complete: true };
      // Check runs: the newest per name (GitHub's default filter=latest).
      let seenRuns = 0;
      let totalRuns = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const out = await json<{ total_count?: number; check_runs?: Json[] }>(await call(`${base}/check-runs?per_page=100&page=${page}`, token), 'GET /repos/commits/check-runs');
        totalRuns = Number(out.total_count ?? 0);
        const runs = out.check_runs ?? [];
        for (const r of runs) {
          seenRuns++;
          counts.total++;
          if (r.status !== 'completed') counts.pending++;
          else if (['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'].includes(String(r.conclusion))) counts.failed++;
          else counts.passed++;
        }
        if (runs.length < 100) break;
      }
      if (seenRuns < totalRuns) counts.complete = false;
      // Commit statuses: the combined view lists the newest per context.
      const status = await json<{ statuses?: Json[]; total_count?: number }>(await call(`${base}/status?per_page=100`, token), 'GET /repos/commits/status');
      const statuses = status.statuses ?? [];
      for (const st of statuses) {
        counts.total++;
        if (st.state === 'pending') counts.pending++;
        else if (st.state === 'success') counts.passed++;
        else counts.failed++;
      }
      if (typeof status.total_count === 'number' && status.total_count > statuses.length) counts.complete = false;
      return counts;
    },

    async labeledIssues(token, repository, label, since, limit) {
      const [owner = '', repo = ''] = repository.split('/');
      const q = new URLSearchParams({ state: 'open', labels: label, since, sort: 'updated', direction: 'desc', per_page: String(Math.min(100, limit)) });
      const out = await json<Json[]>(await call(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${q}`, token), 'GET /repos/issues');
      return (Array.isArray(out) ? out : [])
        .filter((i) => !i.pull_request && typeof i.number === 'number')
        .slice(0, limit)
        .map((i) => ({
          number: Number(i.number),
          title: String(i.title ?? ''),
          htmlUrl: String(i.html_url ?? ''),
          labels: Array.isArray(i.labels) ? (i.labels as Json[]).flatMap((l) => (typeof l?.name === 'string' ? [l.name] : [])) : [],
        }));
    },

    async latestLabelEvent(token, repository, issue, label) {
      const [owner = '', repo = ''] = repository.split('/');
      let newest: LabelEvent | null = null;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const out = await json<Json[]>(await call(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issue}/events?per_page=100&page=${page}`, token), 'GET /repos/issues/events');
        const events = Array.isArray(out) ? out : [];
        for (const e of events) {
          const name = (e.label as Json | undefined)?.name;
          if (e.event !== 'labeled' || typeof name !== 'string' || name.toLowerCase() !== label.toLowerCase() || typeof e.id !== 'number') continue;
          const at = String(e.created_at ?? '');
          if (!newest || at >= newest.createdAt) newest = { id: e.id, actor: typeof (e.actor as Json | undefined)?.login === 'string' ? String((e.actor as Json).login) : null, createdAt: at, label: name };
        }
        if (events.length < 100) break;
      }
      return newest;
    },

    async createIssueComment(token, repository, issue, body) {
      const [owner = '', repo = ''] = repository.split('/');
      const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issue}/comments`;
      const res = await call(path, token, { method: 'POST', body: JSON.stringify({ body }), headers: { 'content-type': 'application/json' } });
      await json<Json>(res, 'POST /repos/issues/comments');
    },

    async postIssueComment(token, repository, issue, body) {
      const [owner = '', repo = ''] = repository.split('/');
      const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issue}/comments`;
      const out = await json<Json>(await call(path, token, { method: 'POST', body: JSON.stringify({ body }), headers: { 'content-type': 'application/json' } }), 'POST /repos/issues/comments');
      const id = Number(out.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw new GitHubError(502, 'POST /repos/issues/comments answered no comment id');
      return id;
    },

    async updateIssueComment(token, repository, commentId, body) {
      const [owner = '', repo = ''] = repository.split('/');
      const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`;
      await json<Json>(await call(path, token, { method: 'PATCH', body: JSON.stringify({ body }), headers: { 'content-type': 'application/json' } }), 'PATCH /repos/issues/comments');
    },

    async findIssueComment(token, repository, issue, marker, author) {
      const [owner = '', repo = ''] = repository.split('/');
      const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issue}/comments`;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const out = await json<Json[]>(await call(`${base}?per_page=100&page=${page}`, token), 'GET /repos/issues/comments');
        const comments = Array.isArray(out) ? out : [];
        const found = comments.find((c) => typeof c.body === 'string' && c.body.includes(marker) && (author === undefined || (c.user as Json | undefined)?.login === author));
        if (found && Number.isSafeInteger(found.id)) return Number(found.id);
        if (comments.length < 100) break;
      }
      return null;
    },

    async listInstallationRepositories(token) {
      const repos: GitHubRepository[] & { truncated?: true } = [];
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
        if (page === MAX_PAGES) repos.truncated = true;
      }
      return repos;
    },
  };
}
