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
//
// Body edits (getIssueBodyEdit) are not in the REST API: an issue there has `updated_at` but no
// editor. GraphQL's Issue has `lastEditedAt` and `editor` (checked against the published schema,
// @octokit/graphql-schema 15.26.1; not against a live repository). GraphQL addresses a
// repository by owner and name, which can be stale after a rename or point at a different
// repository that took the name, so the query also returns the repository's `databaseId` and
// the result is refused unless it is `repo.id`. GraphQL reports most failures as 200 with an
// `errors` array; those become GitHubErrors here.
//
// The revision loop (getPullRequestReviews, listPullRequestUpdates) could NOT be checked against
// GitHub at all; it is written from the REST and GraphQL documentation as remembered:
// - `GET .../pulls?state=all&sort=updated&direction=desc` lists PRs most recently updated first,
//   each with `number`, `state`, `merged_at` and `updated_at`, and a submitted review moves the
//   PR's `updated_at`. Page 1 is assumed to take If-None-Match like the events listing.
// - GraphQL `PullRequest` has `number`, `state` (OPEN/CLOSED/MERGED), `updatedAt`, `headRefName`,
//   `headRefOid` and `reviews(last:)`; `PullRequestReview` has `id`, `state`, `submittedAt`,
//   `body`, `url`, `author`, `lastEditedAt`, `editor` and `comments(first:)` with `totalCount`;
//   `PullRequestReviewComment` has `path`, `line`, `diffHunk`, `body`, `author`, `lastEditedAt`
//   and `editor`. A wrong field name fails the whole query, loudly, as a 502.
//
// The review loop's calls (getPullRequest, listPullRequestReviews, createPullRequestReview,
// markPullRequestReady, getCommitChecks, mergePullRequest) could not be checked against GitHub
// either; they are written from the REST and GraphQL documentation as remembered:
// - `GET .../pulls/{n}` has `node_id`, `state`, `merged`, `draft`, `head.ref`, `head.sha`,
//   `base.ref`, `mergeable` (true, false, or null while GitHub computes it) and `mergeable_state`.
// - `GET .../pulls/{n}/reviews` lists reviews oldest first, each with `id`, `state`, `user`,
//   `body`, `html_url`, `submitted_at` and `commit_id`; a dismissed review has state DISMISSED.
// - `POST .../pulls/{n}/reviews` with `event: "COMMENT"`, a `body` and a `commit_id` submits a
//   comment review at once; the PR's own author may submit one (only APPROVE and REQUEST_CHANGES
//   are refused for the author), and a `commit_id` that is not in the PR is answered with 422.
// - GraphQL mutation `markPullRequestReadyForReview(input: {pullRequestId})` takes the PR's node
//   id and returns `pullRequest { isDraft }`.
// - `GET .../commits/{sha}/status` has `statuses[]` with `context` and `state` (success, pending,
//   failure, error), newest per context; its top-level `state` is "pending" when there are none,
//   so it is not used. `GET .../commits/{sha}/check-runs` returns `{ total_count, check_runs[] }`,
//   by default only the latest run per name, each with `name`, `status` (completed or not) and
//   `conclusion` (success, neutral, skipped, failure, cancelled, timed_out, action_required, stale).
// - `PUT .../pulls/{n}/merge` with `sha` and `merge_method` answers 200 `{ merged, sha, message }`,
//   405 when the PR cannot be merged, 409 when the head is not `sha`.
// - A GitHub Actions check run's `html_url` is `https://github.com/{o}/{r}/actions/runs/{run}/job/{job}`;
//   `POST .../actions/runs/{run}/rerun-failed-jobs` answers 201 with no body.
import { execFile } from 'node:child_process';
import type { RepoRef } from '../types.js';
import type { Logger } from '../util/log.js';
import { repoPermissionOf } from '../control/commands.js';
import { appRequestProblem, redactGitHubSecrets } from './app-auth.js';
import { appIdentity, createUserCredentials, repoOfRequest, userIdentity, type GitHubCredentials } from './credentials.js';
import {
  GitHubError,
  type CheckAnnotation,
  type CheckDetail,
  type CommitChecks,
  type GitHubApi,
  type GitHubIssue,
  type GitHubIssueBodyEdit,
  type GitHubIssueComment,
  type RepoIssueComment,
  type GitHubIssueEvent,
  type GitHubPullRequest,
  type GitHubRepo,
  type GitHubReview,
  type PullRequestReviewComment,
  type ReviewThread,
  type IssueEventsPage,
  type PullRequestDetails,
  type PullRequestReviewSummary,
  type PullRequestReviews,
  type PullRequestUpdatesPage,
} from './api.js';

export interface CreateGitHubApiOptions {
  /** Explicit token. Otherwise GH_TOKEN, GITHUB_TOKEN, then `gh auth token`. */
  token?: string;
  /**
   * Where each request's token comes from (credentials.ts): the person's account, or a GitHub App
   * installation. Takes precedence over `token`. Default: the person's account, as above.
   */
  credentials?: GitHubCredentials;
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

export const USER_AGENT = 'updraft';
export const API_VERSION = '2022-11-28';
const DEFAULT_BASE_URL = 'https://api.github.com';
/** The workflow run of a GitHub Actions check run, from its URL (`.../actions/runs/{run}/job/{job}`); nothing for any other check. */
export function workflowRunOf(...urls: Array<string | null | undefined>): { workflowRunId?: number } {
  for (const url of urls) {
    const m = typeof url === 'string' ? /^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/actions\/runs\/(\d{1,15})\/job\/\d{1,15}(?:[/?#]|$)/.exec(url) : null;
    if (m) return { workflowRunId: Number(m[1]) };
  }
  return {};
}

/** A check's summary or description kept by getCommitChecks. */
const DETAIL_SUMMARY_MAX = 2_000;

/** A failure worth trying again later rather than reporting: no answer, a 5xx, a rate limit. */
function isTransientGitHubError(err: unknown): boolean {
  return err instanceof GitHubError && (err.status === 0 || err.status >= 500 || err.isRateLimit);
}

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
        { cause: err },
      );
    }
    const detail = e.stderr?.trim() || e.message;
    throw new Error(
      `No GitHub token found: \`gh auth token\` failed (${detail}). ` +
        'Run `gh auth login` for github.com under this user account, or set GH_TOKEN.',
      { cause: err },
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
  allow_squash_merge?: boolean;
  allow_merge_commit?: boolean;
  allow_rebase_merge?: boolean;
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
  user?: { login?: string } | null;
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

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: Array<{ type?: string; message?: string; path?: Array<string | number> }>;
}
interface RawIssueBodyEdit {
  repository: {
    databaseId: number | null;
    issue: { lastEditedAt: string | null; editor: { login: string } | null } | null;
  } | null;
}

const ISSUE_BODY_EDIT_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    databaseId
    issue(number: $number) {
      lastEditedAt
      editor { login }
    }
  }
}`;

interface RawActor {
  login: string;
}
interface RawReviewComment {
  path: string | null;
  line: number | null;
  diffHunk: string | null;
  body: string | null;
  author: RawActor | null;
  lastEditedAt: string | null;
  editor: RawActor | null;
}
interface RawReview {
  id: string;
  state: string;
  submittedAt: string | null;
  body: string | null;
  url: string;
  author: RawActor | null;
  lastEditedAt: string | null;
  editor: RawActor | null;
  commit?: { oid: string } | null;
  comments: { totalCount: number; nodes: Array<RawReviewComment | null> | null } | null;
}
interface RawPullRequestReviews {
  repository: {
    databaseId: number | null;
    pullRequest: {
      number: number;
      state: string;
      updatedAt: string;
      headRefName: string;
      headRefOid: string;
      reviews: { nodes: Array<RawReview | null> | null } | null;
    } | null;
  } | null;
}

/** How many of a pull request's newest reviews, and of each review's comments, one read fetches. */
export const REVIEWS_PER_READ = 50;
export const REVIEW_COMMENTS_PER_READ = 100;

const PULL_REQUEST_REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    databaseId
    pullRequest(number: $number) {
      number
      state
      updatedAt
      headRefName
      headRefOid
      reviews(last: ${REVIEWS_PER_READ}) {
        nodes {
          id
          state
          submittedAt
          body
          url
          author { login }
          lastEditedAt
          editor { login }
          commit { oid }
          comments(first: ${REVIEW_COMMENTS_PER_READ}) {
            totalCount
            nodes {
              path
              line
              diffHunk
              body
              author { login }
              lastEditedAt
              editor { login }
            }
          }
        }
      }
    }
  }
}`;

function mapReview(r: RawReview): GitHubReview {
  const comments = (r.comments?.nodes ?? []).filter((c) => c !== null);
  return {
    id: r.id,
    state: r.state,
    author: r.author?.login ?? null,
    submittedAt: r.submittedAt ?? null,
    body: r.body ?? '',
    url: r.url,
    lastEditedAt: r.lastEditedAt ?? null,
    editor: r.editor?.login ?? null,
    commitSha: r.commit?.oid ?? null,
    comments: comments.map((c) => ({
      author: c.author?.login ?? null,
      body: c.body ?? '',
      path: c.path ?? '',
      line: c.line ?? null,
      diffHunk: c.diffHunk ?? '',
      lastEditedAt: c.lastEditedAt ?? null,
      editor: c.editor?.login ?? null,
    })),
    commentCount: Math.max(r.comments?.totalCount ?? 0, comments.length),
  };
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

interface RawRepoComment extends RawComment {
  issue_url?: string;
  created_at?: string;
  updated_at?: string;
  user: { login: string; type?: string } | null;
}

function mapRepoComment(r: RawRepoComment): RepoIssueComment | null {
  const issue = Number(/\/issues\/(\d+)$/.exec(r.issue_url ?? '')?.[1]);
  if (!Number.isSafeInteger(issue) || !r.created_at || !r.updated_at) return null;
  return {
    id: r.id,
    htmlUrl: r.html_url,
    body: r.body ?? '',
    user: r.user?.login ?? null,
    userType: r.user?.type ?? null,
    issueNumber: issue,
    onPullRequest: /\/pull\/\d+/.test(r.html_url),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
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
    // GitHub includes these only for accounts that may change the repository.
    mergeMethods:
      typeof r.allow_squash_merge === 'boolean' && typeof r.allow_merge_commit === 'boolean' && typeof r.allow_rebase_merge === 'boolean'
        ? { squash: r.allow_squash_merge, merge: r.allow_merge_commit, rebase: r.allow_rebase_merge }
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
    author: typeof r.user?.login === 'string' ? r.user.login : null,
  };
}

interface RawPullRequestDetails {
  number: number;
  node_id: string;
  html_url: string;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  title?: string | null;
  draft?: boolean;
  head: { ref: string; sha: string; repo?: { id: number } | null };
  base: { ref: string };
  user?: { login: string } | null;
  body?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
}

interface RawReviewSummary {
  id: number;
  state?: string;
  user?: { login?: string } | null;
  body?: string | null;
  html_url?: string;
  submitted_at?: string | null;
  commit_id?: string | null;
}

function mapReviewSummary(r: RawReviewSummary): PullRequestReviewSummary {
  return {
    id: r.id,
    state: r.state ?? '',
    user: r.user?.login ?? null,
    body: r.body ?? '',
    htmlUrl: r.html_url ?? '',
    submittedAt: r.submitted_at ?? null,
    commitId: r.commit_id ?? null,
  };
}

interface RawPullRequestFile {
  filename?: string;
  status?: string;
  patch?: string | null;
}

interface RawRestReviewComment {
  id: number;
  pull_request_review_id?: number | null;
  in_reply_to_id?: number | null;
  user?: { login?: string } | null;
  body?: string | null;
  path?: string | null;
  html_url?: string;
}

function mapReviewComment(r: RawRestReviewComment): PullRequestReviewComment {
  return {
    id: r.id,
    reviewId: r.pull_request_review_id ?? null,
    inReplyToId: r.in_reply_to_id ?? null,
    user: r.user?.login ?? null,
    body: r.body ?? '',
    path: r.path ?? '',
    htmlUrl: r.html_url ?? '',
  };
}

interface RawReviewThreads {
  repository: {
    databaseId: number | null;
    pullRequest: {
      reviewThreads?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: Array<{ id: string; isResolved?: boolean; comments?: { nodes?: Array<{ databaseId?: number | null; author?: { login?: string } | null } | null> } } | null>;
      };
    } | null;
  } | null;
}

/** Pages of 100 review threads read at most: a pull request with more is reported as not fully read. */
const MAX_THREAD_PAGES = 20;

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    databaseId
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved comments(first: 1) { nodes { databaseId author { login } } } }
      }
    }
  }
}`;

const RESOLVE_THREAD_MUTATION = `mutation($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) {
    thread { isResolved }
  }
}`;

const UNRESOLVE_THREAD_MUTATION = `mutation($id: ID!) {
  unresolveReviewThread(input: { threadId: $id }) {
    thread { isResolved }
  }
}`;

const MARK_READY_MUTATION = `mutation($id: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $id }) {
    pullRequest { isDraft }
  }
}`;

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
  /** GET unless set. Writes are used only by the publication, revision and review steps. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON request body (POST). */
  body?: unknown;
  query?: Record<string, string | number>;
  etag?: string | null;
  /** 'manual' surfaces 3xx as GitHubError(status) instead of following it. */
  redirect?: 'follow' | 'manual';
  /**
   * OWNER/REPO this request is about, for requests that do not name it in their path or GraphQL
   * variables (a mutation addressed by node id). An installation token belongs to one
   * installation, so without this a GitHub App has no way to pick one.
   */
  repo?: string;
}

interface RawResponse<T> {
  status: number;
  data: T | null;
  headers: Headers;
}

/**
 * A request that never got a response. Its message is kept for diagnosis, but a fetch error can
 * repeat a header value (Node's header validation does), so the token this request sent is cut
 * out of it, every piece of it, and then anything else shaped like a credential.
 */
function networkError(method: string, display: string, err: unknown, timeoutMs: number, sent?: string): GitHubError {
  const e = err as Error;
  let why = e?.name === 'TimeoutError' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (e?.message ?? String(err));
  if (sent) {
    for (const piece of [sent, ...sent.split(/\s+/)]) if (piece.length >= 4) why = why.split(piece).join('***');
  }
  return new GitHubError(`${method} ${display}: network error: ${redactGitHubSecrets(why)}`, 0);
}

export async function createGitHubApi(opts: CreateGitHubApiOptions = {}): Promise<GitHubApi> {
  const explicitToken = opts.token;
  const credentials =
    opts.credentials ??
    createUserCredentials(() => (explicitToken !== undefined ? Promise.resolve(explicitToken) : resolveGitHubToken(opts.env ?? process.env)));
  // A missing sign-in fails here, when the client is created, not on the first request.
  if (credentials.kind === 'user') await credentials.token(null);
  /** Names of the repositories addressed by id so far: an App's token is chosen by repository. */
  const repoNames = new Map<number, string>();
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
    const about = ro.repo ?? repoOfRequest(url.startsWith(baseUrl) ? url.slice(baseUrl.length) : new URL(url).pathname, ro.body, repoNames);
    let token = await credentials.token(about);
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
      throw networkError(method, display, err, timeoutMs, token);
    }
    if (res.status === 401 && credentials.kind === 'app') {
      // An installation token can stop working before it expires (the installation was changed,
      // the token revoked): drop it and try once with a new one.
      credentials.reject(token);
      token = await credentials.token(about);
      headers.Authorization = `Bearer ${token}`;
      init.signal = AbortSignal.timeout(timeoutMs);
      try {
        res = await doFetch(url, init);
      } catch (err) {
        throw networkError(method, display, err, timeoutMs, token);
      }
    }
    log?.debug('github request', { method, url: display, status: res.status });

    if (res.status === 304) return { status: 304, data: null, headers: res.headers };
    // No content (a DELETE): nothing to read.
    if (res.status === 204) return { status: 204, data: null, headers: res.headers };
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
      if (credentials.kind === 'app' && retryAfter === null) {
        const problem = appRequestProblem({ method, path: display, status: res.status, detail, repoFullName: about });
        if (problem) throw problem;
      }
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

  const repoPath = (repo: RepoRef) => {
    repoNames.set(repo.id, repo.fullName);
    return `/repositories/${repo.id}`;
  };

  async function threadMutation(repo: RepoRef, threadId: string, query: string, doing: string): Promise<void> {
    const what = `${doing} a review thread of ${repo.fullName}`;
    const res = await request<GraphQLResponse<Record<string, { thread?: { isResolved?: boolean } | null } | null>>>('/graphql', {
      method: 'POST',
      body: { query, variables: { id: threadId } },
      // The mutation names only a node id; say which repository it is for.
      repo: repo.fullName,
    });
    const errors = Array.isArray(res.data?.errors) ? res.data.errors : [];
    if (errors.length) {
      const detail = errors.map((e) => e.message ?? e.type ?? 'unknown error').join('; ');
      const limited = errors.some((e) => e.type === 'RATE_LIMITED');
      const denied = errors.some((e) => e.type === 'FORBIDDEN' || e.type === 'NOT_FOUND');
      throw new GitHubError(`POST /graphql (${what}) failed: ${detail}`, limited ? 429 : denied ? 403 : 422, limited ? (retryAfterFrom(res.headers) ?? 60) : null);
    }
  }

  return {
    async getViewer() {
      const res = await request<{ login: string; id: number }>('/user');
      return { login: res.data!.login, id: res.data!.id };
    },

    async getWorkerIdentity() {
      // `GET /user` is for user tokens only; an App is identified by its own `GET /app`.
      if (credentials.app) return appIdentity(await credentials.app.app());
      const res = await request<{ login: string; id: number }>('/user');
      return userIdentity(res.data!);
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

    async getIssueBodyEdit(repo, issueNumber): Promise<GitHubIssueBodyEdit> {
      const [owner, name, ...rest] = repo.fullName.split('/');
      if (!owner || !name || rest.length) throw new GitHubError(`invalid repository name "${repo.fullName}"`, 502);
      const what = `edit history of ${repo.fullName}#${issueNumber}`;
      const res = await request<GraphQLResponse<RawIssueBodyEdit>>('/graphql', {
        method: 'POST',
        body: { query: ISSUE_BODY_EDIT_QUERY, variables: { owner, name, number: issueNumber } },
      });
      const errors = Array.isArray(res.data?.errors) ? res.data.errors : [];
      const repository = res.data?.data?.repository ?? null;
      const onlyIssueMissing =
        repository !== null && errors.every((e) => e.type === 'NOT_FOUND' && e.path?.at(-1) === 'issue');
      if (errors.length && !onlyIssueMissing) {
        const detail = errors.map((e) => e.message ?? e.type ?? 'unknown error').join('; ');
        // 429 so callers back off as they do for REST. Everything else is 502, deliberately not
        // a "gone" status: a lookup that failed (even NOT_FOUND for the repository, which REST
        // reaches by ID) must leave jobs queued, neither canceled nor run.
        const limited = errors.some((e) => e.type === 'RATE_LIMITED');
        throw new GitHubError(
          `POST /graphql (${what}) failed: ${detail}`,
          limited ? 429 : 502,
          limited ? (retryAfterFrom(res.headers) ?? 60) : null,
        );
      }
      if (!repository) throw new GitHubError(`POST /graphql (${what}) returned no repository`, 502);
      if (repository.databaseId !== repo.id) {
        throw new GitHubError(
          `POST /graphql (${what}): "${repo.fullName}" now names repository ${repository.databaseId ?? 'unknown'}, not ${repo.id}; ` +
            'the repository was renamed or replaced, so update its name in the config',
          502,
        );
      }
      if (!repository.issue) throw new GitHubError(`POST /graphql (${what}): issue not found`, 404);
      return { lastEditedAt: repository.issue.lastEditedAt ?? null, editor: repository.issue.editor?.login ?? null };
    },

    async listPullRequestUpdates(repo, { page, perPage = 100, etag }): Promise<PullRequestUpdatesPage> {
      const res = await request<Array<{ number: number; state: string; merged_at?: string | null; updated_at: string }>>(`${repoPath(repo)}/pulls`, {
        query: { state: 'all', sort: 'updated', direction: 'desc', per_page: perPage, page },
        etag: etag ?? null,
      });
      if (res.status === 304) return { pulls: [], nextPage: null, etag: etag ?? null, notModified: true };
      const nextUrl = parseLinkHeader(res.headers.get('link'))['next'];
      let nextPage: number | null = null;
      if (nextUrl) {
        const p = Number(new URL(nextUrl).searchParams.get('page'));
        nextPage = Number.isFinite(p) && p > 0 ? p : page + 1;
      }
      return {
        pulls: (res.data ?? []).map((r) => ({
          number: r.number,
          state: r.state === 'closed' ? 'closed' : 'open',
          merged: r.merged_at != null,
          updatedAt: r.updated_at,
        })),
        nextPage,
        etag: res.headers.get('etag'),
        notModified: false,
      };
    },

    async getPullRequestReviews(repo, pullNumber): Promise<PullRequestReviews> {
      const [owner, name, ...rest] = repo.fullName.split('/');
      if (!owner || !name || rest.length) throw new GitHubError(`invalid repository name "${repo.fullName}"`, 502);
      const what = `reviews of ${repo.fullName}#${pullNumber}`;
      const res = await request<GraphQLResponse<RawPullRequestReviews>>('/graphql', {
        method: 'POST',
        body: { query: PULL_REQUEST_REVIEWS_QUERY, variables: { owner, name, number: pullNumber } },
      });
      // The same reading of GraphQL failures as getIssueBodyEdit: only "this pull request does
      // not exist" in a repository that did resolve is a 404; everything else must not look gone.
      const errors = Array.isArray(res.data?.errors) ? res.data.errors : [];
      const repository = res.data?.data?.repository ?? null;
      const onlyPullMissing =
        repository !== null && errors.every((e) => e.type === 'NOT_FOUND' && e.path?.at(-1) === 'pullRequest');
      if (errors.length && !onlyPullMissing) {
        const detail = errors.map((e) => e.message ?? e.type ?? 'unknown error').join('; ');
        const limited = errors.some((e) => e.type === 'RATE_LIMITED');
        throw new GitHubError(
          `POST /graphql (${what}) failed: ${detail}`,
          limited ? 429 : 502,
          limited ? (retryAfterFrom(res.headers) ?? 60) : null,
        );
      }
      if (!repository) throw new GitHubError(`POST /graphql (${what}) returned no repository`, 502);
      if (repository.databaseId !== repo.id) {
        throw new GitHubError(
          `POST /graphql (${what}): "${repo.fullName}" now names repository ${repository.databaseId ?? 'unknown'}, not ${repo.id}; ` +
            'the repository was renamed or replaced, so update its name in the config',
          502,
        );
      }
      const pr = repository.pullRequest;
      if (!pr) throw new GitHubError(`POST /graphql (${what}): pull request not found`, 404);
      return {
        number: pr.number,
        state: pr.state === 'OPEN' ? 'open' : 'closed',
        merged: pr.state === 'MERGED',
        updatedAt: pr.updatedAt,
        headRef: pr.headRefName,
        headSha: pr.headRefOid,
        reviews: (pr.reviews?.nodes ?? []).filter((r) => r !== null).map(mapReview),
      };
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

    async updatePullRequestBody(repo, pullNumber, body) {
      await request<RawPullRequest>(`${repoPath(repo)}/pulls/${pullNumber}`, { method: 'PATCH', body: { body } });
    },

    async getBranchSha(repo, branch) {
      try {
        const res = await request<{ object?: { sha?: unknown } }>(`${repoPath(repo)}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
        const sha = res.data?.object?.sha;
        return typeof sha === 'string' ? sha : null;
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) return null;
        throw err;
      }
    },

    async listMatchingRefs(repo, prefix) {
      const res = await request<Array<{ ref?: unknown }>>(`${repoPath(repo)}/git/matching-refs/${prefix.replace(/^refs\//, '').split('/').map(encodeURIComponent).join('/')}`);
      return (res.data ?? []).map((r) => r.ref).filter((r): r is string => typeof r === 'string' && r.startsWith(prefix));
    },

    async deleteRef(repo, ref) {
      await request<unknown>(`${repoPath(repo)}/git/refs/${ref.replace(/^refs\//, '').split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
    },

    async openIssue(repo, input) {
      const res = await request<RawIssue>(`${repoPath(repo)}/issues`, { method: 'POST', body: { title: input.title, body: input.body } });
      return mapIssue(res.data!);
    },

    async updateIssueBody(repo, issueNumber, body) {
      await request<unknown>(`${repoPath(repo)}/issues/${issueNumber}`, { method: 'PATCH', body: { body } });
    },

    async listIssuesByCreator(repo, creator, opts = {}) {
      // The worker opens pull requests too, which this listing includes: read past them, page by page.
      const out: GitHubIssue[] = [];
      let next: string | undefined = buildUrl(`${repoPath(repo)}/issues`, { creator, state: 'all', sort: 'created', direction: 'desc', per_page: 100 });
      for (let page = 0; next && page < (opts.maxPages ?? 10); page++) {
        const res: RawResponse<RawIssue[]> = await request<RawIssue[]>(next);
        out.push(...(res.data ?? []).map(mapIssue).filter((i) => !i.isPullRequest));
        next = parseLinkHeader(res.headers.get('link'))['next'];
      }
      return out;
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

    async listRepoIssueComments(repo, { since, page, perPage = 100 }) {
      const res = await request<RawRepoComment[]>(buildUrl(`${repoPath(repo)}/issues/comments`, { since, sort: 'updated', direction: 'asc', per_page: perPage, page }));
      const next = parseLinkHeader(res.headers.get('link'))['next'];
      return { comments: (res.data ?? []).flatMap((c) => mapRepoComment(c) ?? []), nextPage: next ? page + 1 : null };
    },

    async getRepoPermission(repo, login) {
      const res = await request<{ permission?: unknown; role_name?: unknown }>(`${repoPath(repo)}/collaborators/${encodeURIComponent(login)}/permission`);
      return repoPermissionOf(res.data);
    },

    async updateIssueComment(repo, commentId, body) {
      const res = await request<RawComment>(`${repoPath(repo)}/issues/comments/${commentId}`, {
        method: 'PATCH',
        body: { body },
      });
      return mapComment(res.data!);
    },

    async getPullRequest(repo, pullNumber): Promise<PullRequestDetails> {
      const r = (await request<RawPullRequestDetails>(`${repoPath(repo)}/pulls/${pullNumber}`)).data!;
      return {
        number: r.number,
        nodeId: r.node_id,
        htmlUrl: r.html_url,
        state: r.state === 'closed' ? 'closed' : 'open',
        merged: r.merged === true || r.merged_at != null,
        draft: r.draft === true,
        headRef: r.head.ref,
        headSha: r.head.sha,
        baseRef: r.base.ref,
        mergeable: typeof r.mergeable === 'boolean' ? r.mergeable : null,
        mergeableState: r.mergeable_state ?? 'unknown',
        author: r.user?.login ?? null,
        body: r.body ?? '',
        headRepoId: r.head.repo?.id ?? null,
        title: r.title ?? '',
        mergedAt: r.merged_at ?? null,
        mergeCommitSha: r.merged === true || r.merged_at != null ? (r.merge_commit_sha ?? null) : null,
      };
    },

    async listPullRequestReviews(repo, pullNumber) {
      const raw = await paginate<RawReviewSummary>(`${repoPath(repo)}/pulls/${pullNumber}/reviews`);
      return raw.map(mapReviewSummary);
    },

    async createPullRequestReview(repo, pullNumber, input) {
      const event = input.event ?? 'COMMENT';
      // A formal review is always about one exact commit: never an approval of whatever the head is by then.
      if (event !== 'COMMENT' && !input.commitId) throw new Error(`a ${event} review needs the commit it is for`);
      const res = await request<RawReviewSummary>(`${repoPath(repo)}/pulls/${pullNumber}/reviews`, {
        method: 'POST',
        body: {
          event,
          body: input.body,
          ...(input.commitId ? { commit_id: input.commitId } : {}),
          ...(input.comments?.length
            ? {
                comments: input.comments.map((c) => ({
                  path: c.path,
                  line: c.line,
                  side: c.side,
                  ...(c.startLine !== undefined ? { start_line: c.startLine, start_side: c.startSide ?? c.side } : {}),
                  body: c.body,
                })),
              }
            : {}),
        },
      });
      return mapReviewSummary(res.data!);
    },

    async dismissPullRequestReview(repo, pullNumber, reviewId, message) {
      await request(`${repoPath(repo)}/pulls/${pullNumber}/reviews/${reviewId}/dismissals`, { method: 'PUT', body: { message, event: 'DISMISS' } });
    },

    async listPullRequestFiles(repo, pullNumber) {
      const raw = await paginate<RawPullRequestFile>(`${repoPath(repo)}/pulls/${pullNumber}/files`);
      return raw.map((f) => ({ path: f.filename ?? '', status: f.status ?? '', patch: typeof f.patch === 'string' ? f.patch : null }));
    },

    async listPullRequestReviewComments(repo, pullNumber) {
      const raw = await paginate<RawRestReviewComment>(`${repoPath(repo)}/pulls/${pullNumber}/comments`, { sort: 'created', direction: 'asc' });
      return raw.map(mapReviewComment);
    },

    async replyToReviewComment(repo, pullNumber, commentId, body) {
      const res = await request<RawRestReviewComment>(`${repoPath(repo)}/pulls/${pullNumber}/comments/${commentId}/replies`, { method: 'POST', body: { body } });
      return mapReviewComment(res.data!);
    },

    async listReviewThreads(repo, pullNumber) {
      const [owner, name, ...rest] = repo.fullName.split('/');
      if (!owner || !name || rest.length) throw new GitHubError(`invalid repository name "${repo.fullName}"`, 502);
      const what = `review threads of ${repo.fullName}#${pullNumber}`;
      const out: ReviewThread[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_THREAD_PAGES; page++) {
        const res: RawResponse<GraphQLResponse<RawReviewThreads>> = await request<GraphQLResponse<RawReviewThreads>>('/graphql', {
          method: 'POST',
          body: { query: REVIEW_THREADS_QUERY, variables: { owner, name, number: pullNumber, cursor } },
        });
        const errors = Array.isArray(res.data?.errors) ? res.data.errors : [];
        if (errors.length) {
          const detail = errors.map((e) => e.message ?? e.type ?? 'unknown error').join('; ');
          const limited = errors.some((e) => e.type === 'RATE_LIMITED');
          throw new GitHubError(`POST /graphql (${what}) failed: ${detail}`, limited ? 429 : 502, limited ? (retryAfterFrom(res.headers) ?? 60) : null);
        }
        const repository = res.data?.data?.repository ?? null;
        if (!repository) throw new GitHubError(`POST /graphql (${what}) returned no repository`, 502);
        if (repository.databaseId !== repo.id) {
          throw new GitHubError(`POST /graphql (${what}): "${repo.fullName}" now names repository ${repository.databaseId ?? 'unknown'}, not ${repo.id}`, 502);
        }
        if (!repository.pullRequest) throw new GitHubError(`POST /graphql (${what}): pull request not found`, 404);
        const threads = repository.pullRequest.reviewThreads;
        for (const t of threads?.nodes ?? []) {
          if (!t) continue;
          const first = t.comments?.nodes?.[0] ?? null;
          out.push({ id: t.id, isResolved: t.isResolved === true, rootCommentId: first?.databaseId ?? null, rootAuthor: first?.author?.login ?? null });
        }
        if (!threads?.pageInfo?.hasNextPage) return out;
        cursor = threads.pageInfo.endCursor ?? null;
        if (!cursor) break;
      }
      // Not read to the end: a thread that is not listed must not read as "not there".
      throw new GitHubError(`POST /graphql (${what}): more than ${MAX_THREAD_PAGES * 100} review threads, or no cursor to read on; not all were read`, 422);
    },

    async resolveReviewThread(repo, threadId) {
      await threadMutation(repo, threadId, RESOLVE_THREAD_MUTATION, 'resolving');
    },

    async unresolveReviewThread(repo, threadId) {
      await threadMutation(repo, threadId, UNRESOLVE_THREAD_MUTATION, 'reopening');
    },

    async markPullRequestReady(repo, nodeId) {
      const what = `marking a pull request of ${repo.fullName} ready for review`;
      const res = await request<GraphQLResponse<{ markPullRequestReadyForReview?: { pullRequest?: { isDraft?: boolean } | null } | null }>>('/graphql', {
        method: 'POST',
        body: { query: MARK_READY_MUTATION, variables: { id: nodeId } },
        // The mutation names only a node id; say which repository it is for.
        repo: repo.fullName,
      });
      const errors = Array.isArray(res.data?.errors) ? res.data.errors : [];
      if (errors.length) {
        const detail = errors.map((e) => e.message ?? e.type ?? 'unknown error').join('; ');
        const limited = errors.some((e) => e.type === 'RATE_LIMITED');
        const denied = errors.some((e) => e.type === 'FORBIDDEN' || e.type === 'NOT_FOUND');
        throw new GitHubError(`POST /graphql (${what}) failed: ${detail}`, limited ? 429 : denied ? 403 : 422, limited ? (retryAfterFrom(res.headers) ?? 60) : null);
      }
    },

    async getCommitChecks(repo, sha): Promise<CommitChecks> {
      const failing: string[] = [];
      const pending: string[] = [];
      const succeeded: string[] = [];
      const details: CheckDetail[] = [];
      let total = 0;
      // Both listings are paginated. Every page is read, and a listing that could not be read to
      // its end (more pages than this client follows, or fewer entries than GitHub counted) makes
      // the result incomplete: a failing or pending entry may be among those not seen.
      let complete = true;
      const seenStatuses = new Set<string>();
      let statusCount: number | null = null;
      let next: string | undefined = buildUrl(`${repoPath(repo)}/commits/${encodeURIComponent(sha)}/status`, { per_page: 100 });
      for (let i = 0; next; i++) {
        if (i >= MAX_LIST_PAGES) {
          complete = false;
          break;
        }
        const res: RawResponse<{
          total_count?: number;
          statuses?: Array<{ context?: string; state?: string; target_url?: string | null; description?: string | null }>;
        }> = await request(next);
        if (typeof res.data?.total_count === 'number') statusCount = res.data.total_count;
        for (const s of res.data?.statuses ?? []) {
          const name = s.context ?? '(status)';
          // The combined status lists the newest status of each context; a context repeated
          // across pages is still one check.
          if (seenStatuses.has(name)) continue;
          seenStatuses.add(name);
          total++;
          const outcome = s.state === 'pending' ? 'pending' : s.state === 'success' ? 'success' : 'failure';
          if (outcome === 'pending') pending.push(name);
          else if (outcome === 'success') succeeded.push(name);
          else failing.push(name);
          details.push({
            kind: 'status',
            name,
            outcome,
            conclusion: s.state ?? null,
            url: s.target_url ?? null,
            ...(s.description ? { summary: s.description.slice(0, DETAIL_SUMMARY_MAX) } : {}),
          });
        }
        next = parseLinkHeader(res.headers.get('link'))['next'];
      }
      if (statusCount !== null && seenStatuses.size < statusCount) complete = false;

      let runCount: number | null = null;
      let runsSeen = 0;
      next = buildUrl(`${repoPath(repo)}/commits/${encodeURIComponent(sha)}/check-runs`, { per_page: 100 });
      for (let i = 0; next; i++) {
        if (i >= MAX_LIST_PAGES) {
          complete = false;
          break;
        }
        const res: RawResponse<{
          total_count?: number;
          check_runs?: Array<{
            id?: number;
            name?: string;
            status?: string;
            conclusion?: string | null;
            completed_at?: string | null;
            html_url?: string | null;
            details_url?: string | null;
            app?: { slug?: string | null } | null;
            output?: { title?: string | null; summary?: string | null } | null;
          }>;
        }> = await request(next);
        if (typeof res.data?.total_count === 'number') runCount = res.data.total_count;
        for (const c of res.data?.check_runs ?? []) {
          runsSeen++;
          total++;
          const name = c.name ?? '(check run)';
          let outcome: CheckDetail['outcome'];
          if (c.status !== 'completed') outcome = 'pending';
          else if (c.conclusion === 'success') outcome = 'success';
          // Skipped and neutral do not block, and do not count as a pass either.
          else if (['neutral', 'skipped'].includes(c.conclusion ?? '')) outcome = 'skipped';
          else outcome = 'failure';
          if (outcome === 'pending') pending.push(name);
          else if (outcome === 'success') succeeded.push(name);
          else if (outcome === 'failure') failing.push(name);
          const summary = [c.output?.title, c.output?.summary].filter((t): t is string => typeof t === 'string' && t.trim() !== '').join('\n');
          details.push({
            kind: 'check-run',
            name,
            outcome,
            conclusion: c.status === 'completed' ? (c.conclusion ?? null) : null,
            url: c.html_url ?? c.details_url ?? null,
            ...(typeof c.id === 'number' ? { checkRunId: c.id } : {}),
            app: c.app?.slug ?? null,
            ...workflowRunOf(c.html_url, c.details_url),
            ...(c.status === 'completed' && typeof c.completed_at === 'string' ? { completedAt: c.completed_at } : {}),
            ...(summary ? { summary: summary.slice(0, DETAIL_SUMMARY_MAX) } : {}),
          });
        }
        next = parseLinkHeader(res.headers.get('link'))['next'];
      }
      if (runCount !== null && runsSeen < runCount) complete = false;
      return { total, failing, pending, succeeded, complete, details };
    },

    async getCheckRunDiagnostics(repo, checkRunId, o = {}) {
      const problems: string[] = [];
      const annotations: CheckAnnotation[] = [];
      try {
        const res = await request<Array<{ path?: string; start_line?: number | null; annotation_level?: string; message?: string; title?: string | null }>>(
          `${repoPath(repo)}/check-runs/${checkRunId}/annotations`,
          { query: { per_page: 50 } },
        );
        for (const a of res.data ?? []) {
          annotations.push({ path: a.path ?? '', line: a.start_line ?? null, level: a.annotation_level ?? 'failure', message: a.message ?? '', title: a.title ?? null });
        }
      } catch (err) {
        if (isTransientGitHubError(err)) throw err;
        problems.push(`the annotations could not be read: ${err instanceof Error ? err.message : String(err)}`);
      }
      // For a GitHub Actions check run the check run id is its job's id. The logs endpoint answers
      // with a redirect to a short-lived download URL; that URL carries its own authorization, so
      // it is fetched without the token, which never leaves for another host.
      let logTail: string | null = null;
      const maxBytes = o.maxLogBytes ?? 64_000;
      try {
        const url = buildUrl(`${repoPath(repo)}/actions/jobs/${checkRunId}/logs`);
        const token = await credentials.token(repo.fullName);
        let res: Response;
        try {
          res = await doFetch(url, {
            method: 'GET',
            redirect: 'manual',
            headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': USER_AGENT, Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          throw networkError('GET', url.replace(baseUrl, ''), err, timeoutMs, token);
        }
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location && /^https:\/\//.test(location)) {
          const blob = await doFetch(location, { method: 'GET', headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
          if (blob.ok) {
            const text = await blob.text();
            logTail = text.length > maxBytes ? text.slice(text.length - maxBytes) : text;
          } else {
            problems.push(`the job log could not be downloaded (${blob.status})`);
          }
        } else if (res.ok) {
          const text = await res.text();
          logTail = text.length > maxBytes ? text.slice(text.length - maxBytes) : text;
        } else if (res.status === 404 || res.status === 410) {
          problems.push('there is no GitHub Actions log for this check (it is not an Actions job, or the log expired)');
        } else {
          problems.push(`the job log could not be read (${res.status}${res.status === 403 ? ': the token needs Actions: read' : ''})`);
        }
      } catch (err) {
        if (isTransientGitHubError(err)) throw err;
        problems.push(`the job log could not be read: ${redactGitHubSecrets(err instanceof Error ? err.message : String(err))}`);
      }
      return { annotations, logTail, problems };
    },

    async rerunFailedJobs(repo, workflowRunId) {
      try {
        await request(`${repoPath(repo)}/actions/runs/${workflowRunId}/rerun-failed-jobs`, { method: 'POST', body: {} });
      } catch (err) {
        // 201 with an empty body: the re-run was accepted, there is just nothing to read.
        if (!(err instanceof SyntaxError)) throw err;
      }
    },

    async mergePullRequest(repo, pullNumber, input) {
      const res = await request<{ merged?: boolean; sha?: string | null; message?: string }>(`${repoPath(repo)}/pulls/${pullNumber}/merge`, {
        method: 'PUT',
        body: { sha: input.sha, merge_method: input.method },
      });
      return { merged: res.data?.merged === true, sha: res.data?.sha ?? null, message: res.data?.message ?? '' };
    },
  };
}
