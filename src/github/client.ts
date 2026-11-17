// OWNER: GitHub/poller workstream.
//
// REST client for the GitHub surface in api.ts, over global fetch (injectable).
//
// Endpoint behavior verified with read-only `gh api` calls against cli/cli (2026-11-17):
// - `/repositories/{id}/...` routes work for repos, issues, labels and issue events, and
//   GitHub's own Link headers for `/repos/cli/cli/issues/events` point at
//   `/repositories/212613049/issues/events`. RepoRef-based calls therefore use the
//   stable-ID routes so a rename does not break polling.
// - `GET .../issues/events` returns newest first. Page 1 is the newest page. The order is
//   `created_at` descending, NOT strictly by id: within the same second a larger id can
//   follow a smaller one (seen: 36285272421 @14:11:02 followed by 36285273096 @14:11:01).
//   The id behaves like an insertion sequence while created_at is the occurrence time,
//   so the poller filters by `id > lastEventId` over whole pages instead of stopping at
//   the first already-seen id (see poller.ts).
// - Pagination is Link-header based (rel="next"/"last") and capped at 300 pages of 100;
//   page 301 returns 422 "pagination is limited for this resource".
// - Conditional requests work: If-None-Match with page 1's (weak) ETag returns 304 Not
//   Modified. The ETag is the same via the ID route and the owner/name route, but it
//   depends on query params, so always request page 1 with the same per_page.
// - Issues that were transferred return 301 (to a repo you can read), 404 (one you
//   cannot) or 410 when deleted. getIssue does not follow redirects so a transferred
//   issue surfaces as GitHubError(301) instead of silently returning another repo's issue.
import { execFile } from 'node:child_process';
import type { RepoRef } from '../types.js';
import type { Logger } from '../util/log.js';
import {
  GitHubError,
  type GitHubApi,
  type GitHubIssue,
  type GitHubIssueComment,
  type GitHubIssueEvent,
  type GitHubLabel,
  type GitHubPullRequest,
  type GitHubRepo,
  type IssueEventsPage,
} from './api.js';

export interface CreateGitHubApiOptions {
  /** Explicit token. Otherwise GH_TOKEN, GITHUB_TOKEN, then `gh auth token`. */
  token?: string;
  /** Defaults to https://api.github.com */
  baseUrl?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  log?: Logger;
  env?: NodeJS.ProcessEnv;
  /** Per-request deadline, including reading the response body. Defaults to {@link REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
}

/** No GitHub request (headers and body) may take longer than this; a hung one fails as a network error. */
export const REQUEST_TIMEOUT_MS = 60_000;

export const USER_AGENT = 'software-factory-cli';
export const API_VERSION = '2022-11-28';
const DEFAULT_BASE_URL = 'https://api.github.com';
/** Safety stop for internally paginated lists (100 per page). */
const MAX_LIST_PAGES = 100;

/** Runs `gh` with args and resolves stdout. Injectable for tests. */
export type GhRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<string>;

const defaultGhRunner: GhRunner = (args, env) =>
  new Promise((resolve, reject) => {
    // No shell: gh ships as gh.exe on Windows, which libuv resolves from PATH directly.
    execFile('gh', args, { env, windowsHide: true, timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) {
        Object.assign(err, { stderr: String(stderr ?? '') });
        reject(err);
      } else {
        resolve(String(stdout));
      }
    });
  });

/** Resolve a token for github.com: GH_TOKEN, GITHUB_TOKEN, then `gh auth token`. */
export async function resolveGitHubToken(
  env: NodeJS.ProcessEnv = process.env,
  runGh: GhRunner = defaultGhRunner,
): Promise<string> {
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN'] as const) {
    const v = env[key]?.trim();
    if (v) return v;
  }
  let out: string;
  try {
    out = await runGh(['auth', 'token', '--hostname', 'github.com'], env);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') {
      throw new Error(
        'No GitHub token found: GH_TOKEN and GITHUB_TOKEN are unset and the GitHub CLI (gh) is not on PATH. ' +
          'Install gh from https://cli.github.com and run `gh auth login`, or set GH_TOKEN.',
      );
    }
    const detail = e.stderr?.trim() || e.message;
    throw new Error(
      `No GitHub token found: \`gh auth token\` failed (${detail}). ` +
        'Run `gh auth login` for github.com under this user account, or set GH_TOKEN.',
    );
  }
  const token = out.trim();
  if (!token) {
    throw new Error('`gh auth token` returned no token. Run `gh auth login` for github.com, or set GH_TOKEN.');
  }
  return token;
}

/** Parse an RFC 8288 Link header into rel → URL. */
export function parseLinkHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?([^";]+)"?/.exec(part.trim());
    if (m) for (const rel of m[2]!.split(/\s+/)) out[rel] = m[1]!;
  }
  return out;
}

/** Seconds to wait from Retry-After, or from x-ratelimit-reset when the budget is exhausted. */
export function retryAfterFrom(headers: Headers, now: number = Date.now()): number | null {
  const ra = headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, Math.ceil(secs));
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - now) / 1000));
  }
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return Math.max(0, Math.ceil(reset - now / 1000));
  }
  return null;
}

interface RawRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  archived: boolean;
  default_branch: string;
  description: string | null;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}
interface RawLabel {
  name: string;
  color: string;
  description: string | null;
}
interface RawIssue {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  state: string;
  labels: Array<string | { name?: string }>;
  pull_request?: unknown;
}
interface RawIssueEvent {
  id: number;
  event: string;
  created_at: string;
  actor: { login: string } | null;
  label?: { name: string } | null;
  issue?: { number: number; title: string; html_url: string; pull_request?: unknown } | null;
}

interface RawPullRequest {
  number: number;
  html_url: string;
  state: string;
  draft?: boolean;
  merged_at?: string | null;
  body?: string | null;
  head: { ref: string; repo: { id: number } | null };
  base: { ref: string };
}
interface RawComment {
  id: number;
  html_url: string;
  body?: string | null;
  user: { login: string } | null;
}

function mapPull(r: RawPullRequest): GitHubPullRequest {
  return {
    number: r.number,
    htmlUrl: r.html_url,
    state: r.state === 'closed' ? 'closed' : 'open',
    draft: Boolean(r.draft),
    merged: r.merged_at != null,
    headRef: r.head.ref,
    headRepoId: r.head.repo?.id ?? null,
    baseRef: r.base.ref,
    body: r.body ?? '',
  };
}

function mapComment(r: RawComment): GitHubIssueComment {
  return { id: r.id, htmlUrl: r.html_url, body: r.body ?? '', user: r.user?.login ?? null };
}

function mapRepo(r: RawRepo): GitHubRepo {
  return {
    id: r.id,
    fullName: r.full_name,
    owner: r.owner.login,
    name: r.name,
    private: r.private,
    archived: r.archived,
    defaultBranch: r.default_branch,
    description: r.description ?? null,
    permissions: r.permissions
      ? { admin: !!r.permissions.admin, push: !!r.permissions.push, pull: !!r.permissions.pull }
      : null,
  };
}

function mapIssue(r: RawIssue): GitHubIssue {
  return {
    number: r.number,
    title: r.title,
    body: r.body ?? '',
    htmlUrl: r.html_url,
    state: r.state === 'closed' ? 'closed' : 'open',
    labels: r.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter((l) => l !== ''),
    isPullRequest: r.pull_request != null,
  };
}

function mapEvent(r: RawIssueEvent): GitHubIssueEvent {
  return {
    id: r.id,
    event: r.event,
    createdAt: r.created_at,
    actor: r.actor?.login ?? null,
    label: r.label?.name ?? null,
    issue: r.issue
      ? {
          number: r.issue.number,
          title: r.issue.title,
          htmlUrl: r.issue.html_url,
          isPullRequest: r.issue.pull_request != null,
        }
      : null,
  };
}

interface RequestOptions {
  /** GET unless set. Writes (POST) are used only by the publication step. */
  method?: 'GET' | 'POST';
  /** JSON request body (POST). */
  body?: unknown;
  query?: Record<string, string | number>;
  etag?: string | null;
  /** 'manual' surfaces 3xx as GitHubError(status) instead of following it. */
  redirect?: 'follow' | 'manual';
}

interface RawResponse<T> {
  status: number;
  data: T | null;
  headers: Headers;
}

function networkError(method: string, display: string, err: unknown, timeoutMs: number): GitHubError {
  const e = err as Error;
  const why = e?.name === 'TimeoutError' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (e?.message ?? String(err));
  return new GitHubError(`${method} ${display}: network error: ${why}`, 0);
}

export async function createGitHubApi(opts: CreateGitHubApiOptions = {}): Promise<GitHubApi> {
  const token = opts.token ?? (await resolveGitHubToken(opts.env ?? process.env));
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch = opts.fetch ?? globalThis.fetch;
  const log = opts.log;
  const timeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  const buildUrl = (pathOrUrl: string, query?: Record<string, string | number>): string => {
    const url = new URL(/^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${baseUrl}${pathOrUrl}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    return url.toString();
  };

  async function request<T>(pathOrUrl: string, ro: RequestOptions = {}): Promise<RawResponse<T>> {
    const url = buildUrl(pathOrUrl, ro.query);
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
      Authorization: `Bearer ${token}`,
    };
    if (ro.etag) headers['If-None-Match'] = ro.etag;
    const method = ro.method ?? 'GET';
    const init: RequestInit = { method, headers, redirect: ro.redirect ?? 'follow', signal: AbortSignal.timeout(timeoutMs) };
    if (ro.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(ro.body);
    }
    const display = url.replace(baseUrl, '');

    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch (err) {
      throw networkError(method, display, err, timeoutMs);
    }
    log?.debug('github request', { method, url: display, status: res.status });

    if (res.status === 304) return { status: 304, data: null, headers: res.headers };
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      // Only reachable with redirect: 'manual' (getIssue): the subject moved.
      throw new GitHubError(`${method} ${display}: moved (${res.status || 301})`, res.status || 301);
    }
    if (!res.ok) {
      let detail = '';
      try {
        // Validation failures (422) carry the specific reason in errors[].message.
        const body = (await res.json()) as { message?: string; errors?: Array<{ message?: string } | string> };
        const parts = [body?.message ?? ''];
        for (const e of Array.isArray(body?.errors) ? body.errors : []) {
          const m = typeof e === 'string' ? e : e?.message;
          if (m && !parts.includes(m)) parts.push(m);
        }
        detail = parts.filter(Boolean).join(': ');
      } catch {
        // non-JSON error body
      }
      const retryAfter = retryAfterFrom(res.headers);
      let hint = '';
      if (res.status === 401) hint = ' (token invalid or expired; run `gh auth login` or set GH_TOKEN)';
      else if (retryAfter !== null && (res.status === 403 || res.status === 429))
        hint = ` (rate limited; retry in ${retryAfter}s)`;
      throw new GitHubError(
        `${method} ${display} failed: ${res.status}${detail ? ` ${detail}` : ''}${hint}`,
        res.status,
        retryAfter,
      );
    }
    let data: T;
    try {
      data = (await res.json()) as T;
    } catch (err) {
      // A body cut off by the deadline (or the connection) is a network error, not a bad response.
      if (err instanceof SyntaxError) throw err;
      throw networkError(method, display, err, timeoutMs);
    }
    return { status: res.status, data, headers: res.headers };
  }

  async function paginate<T>(path: string, query: Record<string, string | number> = {}): Promise<T[]> {
    const all: T[] = [];
    let next: string | undefined = buildUrl(path, { per_page: 100, ...query });
    for (let i = 0; next && i < MAX_LIST_PAGES; i++) {
      const res: RawResponse<T[]> = await request<T[]>(next);
      all.push(...(res.data ?? []));
      next = parseLinkHeader(res.headers.get('link'))['next'];
    }
    return all;
  }

  const repoPath = (repo: RepoRef) => `/repositories/${repo.id}`;

  return {
    async getViewer() {
      const res = await request<{ login: string; id: number }>('/user');
      return { login: res.data!.login, id: res.data!.id };
    },

    async listUserRepos() {
      const raw = await paginate<RawRepo>('/user/repos', {
        affiliation: 'owner,collaborator,organization_member',
        sort: 'full_name',
      });
      return raw.map(mapRepo);
    },

    async getRepo(fullName) {
      const [owner, name, ...rest] = fullName.split('/');
      if (!owner || !name || rest.length) throw new GitHubError(`invalid repository name "${fullName}"`, 404);
      // Owner/name route on purpose: follows rename redirects to the repo's stable ID.
      const res = await request<RawRepo>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
      return mapRepo(res.data!);
    },

    async listLabels(repo) {
      const raw = await paginate<RawLabel>(`${repoPath(repo)}/labels`);
      return raw.map((l) => ({ name: l.name, color: l.color, description: l.description ?? null }));
    },

    async listIssueEvents(repo, { page, perPage = 100, etag }): Promise<IssueEventsPage> {
      const res = await request<RawIssueEvent[]>(`${repoPath(repo)}/issues/events`, {
        query: { per_page: perPage, page },
        etag: etag ?? null,
      });
      if (res.status === 304) return { events: [], nextPage: null, etag: etag ?? null, notModified: true };
      const nextUrl = parseLinkHeader(res.headers.get('link'))['next'];
      let nextPage: number | null = null;
      if (nextUrl) {
        const p = Number(new URL(nextUrl).searchParams.get('page'));
        nextPage = Number.isFinite(p) && p > 0 ? p : page + 1;
      }
      return {
        events: (res.data ?? []).map(mapEvent),
        nextPage,
        etag: res.headers.get('etag'),
        notModified: false,
      };
    },

    async getIssue(repo, issueNumber) {
      // A 301 here means the issue was transferred; surface it as GitHubError(301).
      const res = await request<RawIssue>(`${repoPath(repo)}/issues/${issueNumber}`, { redirect: 'manual' });
      return mapIssue(res.data!);
    },

    async listEventsForIssue(repo, issueNumber) {
      const raw = await paginate<RawIssueEvent>(`${repoPath(repo)}/issues/${issueNumber}/events`);
      return raw.map(mapEvent);
    },

    async listPullRequestsForHead(repo, { headOwner, head }) {
      const raw = await paginate<RawPullRequest>(`${repoPath(repo)}/pulls`, {
        state: 'all',
        head: `${headOwner}:${head}`,
        sort: 'created',
        direction: 'desc',
      });
      return raw.map(mapPull);
    },

    async createPullRequest(repo, input) {
      const res = await request<RawPullRequest>(`${repoPath(repo)}/pulls`, {
        method: 'POST',
        body: { title: input.title, head: input.head, base: input.base, body: input.body, draft: input.draft },
      });
      return mapPull(res.data!);
    },

    async listIssueComments(repo, issueNumber) {
      const raw = await paginate<RawComment>(`${repoPath(repo)}/issues/${issueNumber}/comments`);
      return raw.map(mapComment);
    },

    async createIssueComment(repo, issueNumber, body) {
      const res = await request<RawComment>(`${repoPath(repo)}/issues/${issueNumber}/comments`, {
        method: 'POST',
        body: { body },
      });
      return mapComment(res.data!);
    },
  };
}
