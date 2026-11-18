// The parts of GitHub the publish, revise and review loop touches, in memory: one repository,
// one issue and at most one pull request. Anything else a test reaches is reported as a bug.
import {
  GitHubError,
  type CommitChecks,
  type CreatePullRequestInput,
  type GitHubApi,
  type GitHubIssue,
  type GitHubIssueComment,
  type GitHubIssueEvent,
  type GitHubPullRequest,
  type GitHubReview,
  type IssueEventsPage,
  type MergePullRequestInput,
  type PullRequestDetails,
  type PullRequestReviewSummary,
  type PullRequestReviews,
  type PullRequestUpdatesPage,
} from '../src/github/api.js';
import type { RepoRef } from '../src/types.js';

type Failable = 'createPullRequestReview' | 'listPullRequestReviews' | 'getPullRequest' | 'markPullRequestReady' | 'getCommitChecks' | 'mergePullRequest' | 'createIssueComment';

export class FakeLoopGitHub {
  login = 'updraft-bot';
  pull: { number: number; state: 'open' | 'closed'; merged: boolean; draft: boolean; headRef: string; baseRef: string; mergeable: boolean | null; mergeableState: string } | null = null;
  /** The pull request's head commit right now (tests point this at the real remote, or at a variable). */
  headSha: () => string = () => '0'.repeat(40);
  /** Reviews as REST lists them: the worker's comment reviews and people's reviews. */
  reviews: PullRequestReviewSummary[] = [];
  /** People's reviews as the review poller reads them (GraphQL). */
  humanReviews: GitHubReview[] = [];
  comments: Array<GitHubIssueComment & { issue: number }> = [];
  /** One passing check by default: auto-merge needs independent CI to have passed. */
  checks: CommitChecks = { total: 1, failing: [], pending: [], succeeded: ['ci / build'], complete: true };
  issueEvents: GitHubIssueEvent[] = [];
  /** Every write, in order. */
  readonly writes: string[] = [];
  /** Every call, in order. */
  readonly calls: string[] = [];
  readonly merges: MergePullRequestInput[] = [];
  /** Errors to throw on the next call of a method (consumed once), or on every call. */
  failNext: Partial<Record<Failable, GitHubError>> = {};
  failAlways: Partial<Record<Failable, GitHubError>> = {};
  /** Refuse a review's commit_id as GitHub does for a commit that is not in the PR. */
  refuseCommitId = false;
  updatedAt = '2026-11-18T12:00:00Z';
  private version = 0;
  private nextId = 1;

  constructor(
    readonly fullName: string,
    readonly issue: number,
    private readonly nextPullNumber = 100,
  ) {}

  /** Something on the pull request changed: the listing shows it and its ETag differs. */
  touch(): void {
    this.version++;
    this.updatedAt = new Date(Date.parse(this.updatedAt) + 60_000).toISOString();
  }

  private maybeFail(name: Failable): void {
    const once = this.failNext[name];
    if (once) {
      delete this.failNext[name];
      throw once;
    }
    const always = this.failAlways[name];
    if (always) throw always;
  }

  /** A person submits a review. */
  humanReview(author: string, state: 'CHANGES_REQUESTED' | 'APPROVED' | 'COMMENTED' | 'DISMISSED', body = ''): GitHubReview {
    this.touch();
    const id = this.nextId++;
    const url = `https://github.com/${this.fullName}/pull/${this.pull?.number ?? this.nextPullNumber}#pullrequestreview-${id}`;
    const review: GitHubReview = { id: `PRR_${id}`, state, author, submittedAt: this.updatedAt, body, url, lastEditedAt: null, editor: null, comments: [], commentCount: 0 };
    this.humanReviews.push(review);
    this.reviews.push({ id, state, user: author, body, htmlUrl: url, submittedAt: this.updatedAt, commitId: this.headSha() });
    return review;
  }

  async getViewer(): Promise<{ login: string; id: number }> {
    this.calls.push('getViewer');
    return { login: this.login, id: 1 };
  }
  async getWorkerIdentity(): Promise<{ kind: 'user'; login: string; id: number }> {
    this.calls.push('getWorkerIdentity');
    return { kind: 'user', login: this.login, id: 1 };
  }
  async listIssueEvents(): Promise<IssueEventsPage> {
    return { events: [], nextPage: null, etag: null, notModified: false };
  }
  async getIssue(): Promise<GitHubIssue> {
    return { number: this.issue, title: 'Add a widget', body: 'Please add a widget.', htmlUrl: `https://github.com/${this.fullName}/issues/${this.issue}`, state: 'open', labels: ['updraft:ready'], isPullRequest: false };
  }
  async listEventsForIssue(): Promise<GitHubIssueEvent[]> {
    return this.issueEvents;
  }
  async getIssueBodyEdit(): Promise<{ lastEditedAt: null; editor: null }> {
    return { lastEditedAt: null, editor: null };
  }
  async listPullRequestsForHead(): Promise<GitHubPullRequest[]> {
    return [];
  }
  async createPullRequest(_repo: RepoRef, input: CreatePullRequestInput): Promise<GitHubPullRequest> {
    this.writes.push(`open ${input.draft ? 'draft ' : ''}PR ${input.head} -> ${input.base}`);
    this.pull = { number: this.nextPullNumber, state: 'open', merged: false, draft: input.draft, headRef: input.head, baseRef: input.base, mergeable: true, mergeableState: 'clean' };
    this.touch();
    return { number: this.pull.number, htmlUrl: `https://github.com/${this.fullName}/pull/${this.pull.number}`, state: 'open', draft: input.draft, merged: false, headRef: input.head, headRepoId: 42, baseRef: input.base, body: input.body };
  }
  async listIssueComments(_repo: RepoRef, issue: number): Promise<GitHubIssueComment[]> {
    this.calls.push(`listIssueComments #${issue}`);
    return this.comments.filter((c) => c.issue === issue);
  }
  async createIssueComment(_repo: RepoRef, issue: number, body: string): Promise<GitHubIssueComment> {
    this.maybeFail('createIssueComment');
    this.writes.push(`comment #${issue}`);
    const id = this.nextId++;
    const c = { id, htmlUrl: `https://github.com/${this.fullName}/issues/${issue}#issuecomment-${id}`, body, user: this.login, issue };
    this.comments.push(c);
    this.touch();
    return c;
  }
  async listPullRequestUpdates(_repo: RepoRef, opts: { etag?: string | null }): Promise<PullRequestUpdatesPage> {
    this.calls.push('listPullRequestUpdates');
    const etag = `W/"${this.version}"`;
    if (opts.etag === etag) return { pulls: [], nextPage: null, etag, notModified: true };
    const pulls = this.pull ? [{ number: this.pull.number, state: this.pull.state, merged: this.pull.merged, updatedAt: this.updatedAt }] : [];
    return { pulls, nextPage: null, etag, notModified: false };
  }
  private need(): NonNullable<FakeLoopGitHub['pull']> {
    if (!this.pull) throw new GitHubError('pull request not found', 404);
    return this.pull;
  }
  async getPullRequestReviews(): Promise<PullRequestReviews> {
    this.calls.push('getPullRequestReviews');
    const p = this.need();
    return { number: p.number, state: p.state, merged: p.merged, updatedAt: this.updatedAt, headRef: p.headRef, headSha: this.headSha(), reviews: this.humanReviews };
  }
  async getPullRequest(): Promise<PullRequestDetails> {
    this.calls.push('getPullRequest');
    this.maybeFail('getPullRequest');
    const p = this.need();
    return { number: p.number, nodeId: `PR_node_${p.number}`, htmlUrl: `https://github.com/${this.fullName}/pull/${p.number}`, state: p.state, merged: p.merged, draft: p.draft, headRef: p.headRef, headSha: this.headSha(), baseRef: p.baseRef, mergeable: p.mergeable, mergeableState: p.mergeableState };
  }
  async listPullRequestReviews(): Promise<PullRequestReviewSummary[]> {
    this.calls.push('listPullRequestReviews');
    this.maybeFail('listPullRequestReviews');
    return [...this.reviews];
  }
  async createPullRequestReview(_repo: RepoRef, pull: number, input: { body: string; commitId?: string }): Promise<PullRequestReviewSummary> {
    this.maybeFail('createPullRequestReview');
    if (this.refuseCommitId && input.commitId) throw new GitHubError('POST /pulls/reviews failed: 422 Unprocessable Entity: commit_id is not part of the pull request', 422);
    this.writes.push(`review #${pull} COMMENT at ${input.commitId ?? '(no commit)'}`);
    const id = this.nextId++;
    const r: PullRequestReviewSummary = { id, state: 'COMMENTED', user: this.login, body: input.body, htmlUrl: `https://github.com/${this.fullName}/pull/${pull}#pullrequestreview-${id}`, submittedAt: this.updatedAt, commitId: input.commitId ?? null };
    this.reviews.push(r);
    this.touch();
    return r;
  }
  async markPullRequestReady(_repo: RepoRef, nodeId: string): Promise<void> {
    this.maybeFail('markPullRequestReady');
    this.writes.push(`ready ${nodeId}`);
    this.need().draft = false;
    this.touch();
  }
  async getCommitChecks(_repo: RepoRef, sha: string): Promise<CommitChecks> {
    this.calls.push(`getCommitChecks ${sha}`);
    this.maybeFail('getCommitChecks');
    return this.checks;
  }
  async mergePullRequest(_repo: RepoRef, pull: number, input: MergePullRequestInput): Promise<{ merged: boolean; sha: string | null; message: string }> {
    this.calls.push('mergePullRequest');
    this.maybeFail('mergePullRequest');
    const p = this.need();
    // As GitHub does: the merge is only for the head it names.
    if (input.sha !== this.headSha()) throw new GitHubError('PUT /pulls/merge failed: 409 Head branch was modified. Review and try the merge again.', 409);
    this.writes.push(`merge #${pull} ${input.method} at ${input.sha}`);
    this.merges.push(input);
    p.state = 'closed';
    p.merged = true;
    this.touch();
    return { merged: true, sha: 'f'.repeat(40), message: 'Pull Request successfully merged' };
  }

  get api(): GitHubApi {
    return new Proxy(this, {
      get(target, prop) {
        // Not a thenable: an awaited api must resolve to itself.
        if (prop in target || prop === 'then' || typeof prop === 'symbol') return Reflect.get(target, prop, target) as unknown;
        return () => {
          throw new Error(`the loop must not call ${String(prop)}`);
        };
      },
    }) as unknown as GitHubApi;
  }
}
