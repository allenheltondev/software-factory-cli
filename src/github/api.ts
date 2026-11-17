import type { RepoRef } from '../types.js';

/**
 * The GitHub surface the factory needs. `client.ts` implements it over the REST
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

export interface IssueEventsPage {
  events: GitHubIssueEvent[];
  /** Next page number, or null when this is the last page. */
  nextPage: number | null;
  /** ETag of this response (only meaningful for page 1). */
  etag: string | null;
  /** True when an If-None-Match request returned 304. `events` is empty then. */
  notModified: boolean;
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
