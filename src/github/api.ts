import type { RepoRef } from '../types.js';
import type { WorkerIdentity } from './credentials.js';

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
  /** Which merge methods the repository allows; absent or null when GitHub did not say. */
  mergeMethods?: { squash: boolean; merge: boolean; rebase: boolean } | null;
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

/** One pull request in the by-update listing: enough to tell whether it changed and whether it is still open. */
export interface PullRequestUpdate {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  /** ISO time of the newest change GitHub counts for the PR (a review, a comment, a push...). */
  updatedAt: string;
}

export interface PullRequestUpdatesPage {
  pulls: PullRequestUpdate[];
  nextPage: number | null;
  /** ETag of this response (only meaningful for page 1). */
  etag: string | null;
  /** True when an If-None-Match request returned 304. `pulls` is empty then. */
  notModified: boolean;
}

/** One inline comment of a review. `editor`/`lastEditedAt` are null when it was never edited. */
export interface GitHubReviewComment {
  author: string | null;
  body: string;
  path: string;
  line: number | null;
  diffHunk: string;
  lastEditedAt: string | null;
  editor: string | null;
}

export interface GitHubReview {
  /** GraphQL node id: stable, and unlike the numeric database id not limited to 32 bits. */
  id: string;
  /** PENDING, COMMENTED, APPROVED, CHANGES_REQUESTED or DISMISSED. */
  state: string;
  author: string | null;
  submittedAt: string | null;
  body: string;
  url: string;
  /** ISO time of the newest edit of the body; null when it was never edited. */
  lastEditedAt: string | null;
  /** Who made that edit; null when never edited or the account no longer exists. */
  editor: string | null;
  /** The review's own inline comments, oldest first (at most the first 100). */
  comments: GitHubReviewComment[];
  /** How many inline comments the review has in all. */
  commentCount: number;
}

/** A pull request with its newest reviews, read in one request. */
export interface PullRequestReviews {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  updatedAt: string;
  headRef: string;
  headSha: string;
  /** Oldest first; at most the newest 50. */
  reviews: GitHubReview[];
}

/** One pull request as REST reports it, for the end of the review loop (ready for review, auto-merge). */
export interface PullRequestDetails {
  number: number;
  /** GraphQL node id; the markPullRequestReadyForReview mutation takes it. */
  nodeId: string;
  htmlUrl: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  /** Whether GitHub can merge it without conflicts; null while GitHub is still working that out. */
  mergeable: boolean | null;
  /** GitHub's own word for it: clean, dirty, blocked, behind, unstable, draft, unknown... For messages only. */
  mergeableState: string;
  /** Login of the account that opened it, as REST reports it (`<app-slug>[bot]` for an App); null when unknown. */
  author?: string | null;
  /** Markdown body; '' when it has none. */
  body?: string;
  /** Stable ID of the head's repository; null when that repository was deleted. */
  headRepoId?: number | null;
}

/** A submitted review as REST lists it (no editors, no inline comments). */
export interface PullRequestReviewSummary {
  id: number;
  /** COMMENTED, APPROVED, CHANGES_REQUESTED, DISMISSED or PENDING. */
  state: string;
  user: string | null;
  body: string;
  htmlUrl: string;
  submittedAt: string | null;
  /** The commit the review was submitted against. */
  commitId: string | null;
}

/**
 * The checks GitHub reports for one commit: commit statuses and check runs together, newest per
 * context or name. A commit with none has `total` 0 and both lists empty.
 */
export interface CommitChecks {
  total: number;
  /** Names of statuses in state failure or error, and of completed check runs that did not conclude success, neutral or skipped. */
  failing: string[];
  /** Names of statuses in state pending and of check runs that have not completed. */
  pending: string[];
  /**
   * Names of statuses in state success and of check runs that concluded success. A skipped or
   * neutral check run is in none of the three lists: it neither failed nor showed anything passed.
   */
  succeeded: string[];
  /**
   * False when a listing could not be read to its end. `failing` and `pending` are then only
   * what was seen, and the commit must not be treated as passing.
   */
  complete: boolean;
}

export interface MergePullRequestInput {
  /** The head commit the merge is for; GitHub refuses the merge when the head is anything else. */
  sha: string;
  method: 'squash' | 'merge' | 'rebase';
}

export interface GitHubApi {
  /**
   * The person behind the `gh` sign-in. Only for the interactive commands that act as that person
   * (`updraft configure`, `updraft add`); it fails under a GitHub App. For "who is the worker",
   * use getWorkerIdentity.
   */
  getViewer(): Promise<{ login: string; id: number }>;
  /**
   * Who the worker is on GitHub: the `gh` account, or `<app-slug>[bot]` when a GitHub App is
   * configured (github.app). Its pull requests, comments and pushes carry this name; compare a
   * login against it with isWorkerLogin (src/github/credentials.ts).
   */
  getWorkerIdentity(): Promise<WorkerIdentity>;
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
  /**
   * One page of the repository's pull requests in any state, most recently updated first. Page 1
   * takes an ETag, like listIssueEvents. Used by the revision loop to notice new reviews and
   * closed PRs with one request per repository.
   */
  listPullRequestUpdates(repo: RepoRef, opts: { page: number; perPage?: number; etag?: string | null }): Promise<PullRequestUpdatesPage>;
  /**
   * One pull request with its newest reviews, their inline comments, and who last edited each
   * text. REST exposes no editor, so this is a GraphQL query with the same repository-id check as
   * getIssueBodyEdit. Throws GitHubError(404) when the pull request no longer exists.
   */
  getPullRequestReviews(repo: RepoRef, pullNumber: number): Promise<PullRequestReviews>;
  /** Write: open a pull request. Used only by the publication step, never by an agent. */
  createPullRequest(repo: RepoRef, input: CreatePullRequestInput): Promise<GitHubPullRequest>;
  /** Every comment on one issue, oldest first (paginated internally). */
  listIssueComments(repo: RepoRef, issueNumber: number): Promise<GitHubIssueComment[]>;
  /** Write: comment on an issue. Used only by the publication step. */
  createIssueComment(repo: RepoRef, issueNumber: number, body: string): Promise<GitHubIssueComment>;
  /** One pull request with its head, base, draft flag and mergeability (REST). Throws GitHubError(404) when it does not exist. */
  getPullRequest(repo: RepoRef, pullNumber: number): Promise<PullRequestDetails>;
  /** Every submitted review of one pull request, oldest first (REST, paginated internally). */
  listPullRequestReviews(repo: RepoRef, pullNumber: number): Promise<PullRequestReviewSummary[]>;
  /**
   * Write: submit a COMMENT review on a pull request. Never an approval or a change request: the
   * account that opened a pull request may not submit those on it. `commitId` pins it to a commit.
   */
  createPullRequestReview(repo: RepoRef, pullNumber: number, input: { body: string; commitId?: string }): Promise<PullRequestReviewSummary>;
  /** Write: turn a draft pull request into one that is ready for review (GraphQL; REST cannot). */
  markPullRequestReady(repo: RepoRef, nodeId: string): Promise<void>;
  /** Commit statuses and check runs of one commit (two REST requests, plus one per further 100 check runs). */
  getCommitChecks(repo: RepoRef, sha: string): Promise<CommitChecks>;
  /**
   * Write: merge a pull request at exactly `sha`. Used only by auto-merge. Throws GitHubError with
   * GitHub's status when the merge is refused: 405 not mergeable (conflicts, branch protection, a
   * draft), 409 the head is no longer `sha`, 403/404 no permission, 422 invalid.
   */
  mergePullRequest(repo: RepoRef, pullNumber: number, input: MergePullRequestInput): Promise<{ merged: boolean; sha: string | null; message: string }>;
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
