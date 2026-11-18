import type { RepoRef } from '../types.js';

/**
 * The GitHub surface Updraft needs. `client.ts` implements it over the REST
 * API using the active `gh` account's token; tests use in-memory fakes.
 */

export interface GitHubRepo {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
  description: string | null;
  permissions: { admin: boolean; push: boolean; pull: boolean } | null;
}

export interface GitHubLabel {
  name: string;
  color: string;
  description: string | null;
}

export interface GitHubIssueEvent {
  id: number;
  /** e.g. 'labeled', 'unlabeled', 'closed' */
  event: string;
  createdAt: string;
  actor: string | null;
  /** Present for labeled/unlabeled events. */
  label: string | null;
  issue: { number: number; title: string; htmlUrl: string; isPullRequest: boolean } | null;
}

export interface GitHubIssue {
  number: number;
  title: string;
  /** Markdown body; '' when the issue has none. */
  body: string;
  htmlUrl: string;
  state: 'open' | 'closed';
  labels: string[];
  isPullRequest: boolean;
}

/** Who last edited an issue's body, and when. Title changes are `renamed` issue events instead. */
export interface GitHubIssueBodyEdit {
  /** ISO time of the newest body edit; null when the body was never edited. */
  lastEditedAt: string | null;
  /** Login of that edit's author; null when never edited or the account no longer exists. */
  editor: string | null;
}

export interface IssueEventsPage {
  events: GitHubIssueEvent[];
  /** Next page number, or null when this is the last page. */
  nextPage: number | null;
  /** ETag of this response (only meaningful for page 1). */
  etag: string | null;
  /** True when an If-None-Match request returned 304. `events` is empty then. */
  notModified: boolean;
}

export interface GitHubPullRequest {
  number: number;
  htmlUrl: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  /** Branch name of the head (without refs/heads/). */
  headRef: string;
  /** Stable ID of the head's repository; null when that repository was deleted. */
  headRepoId: number | null;
  baseRef: string;
  /** Markdown body; '' when it has none. */
  body: string;
}

export interface CreatePullRequestInput {
  title: string;
  /** Branch in the same repository. */
  head: string;
  base: string;
  body: string;
  draft: boolean;
}

export interface GitHubIssueComment {
  id: number;
  htmlUrl: string;
  body: string;
  user: string | null;
}

export interface GitHubApi {
  getViewer(): Promise<{ login: string; id: number }>;
  /** All repos the account owns, collaborates on, or reaches through an org (paginated internally). */
  listUserRepos(): Promise<GitHubRepo[]>;
  /** Look up by OWNER/REPO; throws GitHubError(404) when inaccessible. */
  getRepo(fullName: string): Promise<GitHubRepo>;
  listLabels(repo: RepoRef): Promise<GitHubLabel[]>;
  /** One page of repository issue events. Page 1 is the newest page. */
  listIssueEvents(repo: RepoRef, opts: { page: number; perPage?: number; etag?: string | null }): Promise<IssueEventsPage>;
  getIssue(repo: RepoRef, issueNumber: number): Promise<GitHubIssue>;
  /** Every event on one issue, oldest first (paginated internally). `issue` is null on these. */
  listEventsForIssue(repo: RepoRef, issueNumber: number): Promise<GitHubIssueEvent[]>;
  /**
   * The newest edit of one issue's body. REST does not expose the editor, so this is a GraphQL
   * query. Throws GitHubError(404) when the issue no longer exists; any other failure (including
   * the repository not resolving to `repo.id`) is an error callers must not read as "not edited".
   */
  getIssueBodyEdit(repo: RepoRef, issueNumber: number): Promise<GitHubIssueBodyEdit>;
  /**
   * Pull requests whose head is `headOwner:head`, in any state (open, closed or merged), newest
   * first (paginated internally).
   */
  listPullRequestsForHead(repo: RepoRef, opts: { headOwner: string; head: string }): Promise<GitHubPullRequest[]>;
  /** Write: open a pull request. Used only by the publication step, never by an agent. */
  createPullRequest(repo: RepoRef, input: CreatePullRequestInput): Promise<GitHubPullRequest>;
  /** Every comment on one issue, oldest first (paginated internally). */
  listIssueComments(repo: RepoRef, issueNumber: number): Promise<GitHubIssueComment[]>;
  /** Write: comment on an issue. Used only by the publication step. */
  createIssueComment(repo: RepoRef, issueNumber: number, body: string): Promise<GitHubIssueComment>;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Seconds to wait before retrying, from Retry-After or rate-limit reset headers. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'GitHubError';
  }

  get isRateLimit(): boolean {
    return this.status === 429 || (this.status === 403 && this.retryAfterSeconds !== null);
  }
}
