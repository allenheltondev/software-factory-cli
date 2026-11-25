// The parts of GitHub the publish, revise and review loop touches, in memory: one repository,
// one issue and at most one pull request. Anything else a test reaches is reported as a bug.
import {
  GitHubError,
  type CheckRunDiagnostics,
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
  type PullRequestFile,
  type PullRequestReviewComment,
  type PullRequestReviewSummary,
  type ReviewCommentInput,
  type ReviewThread,
  type PullRequestReviews,
  type PullRequestUpdatesPage,
} from '../src/github/api.js';
import type { RepoRef } from '../src/types.js';

type Failable =
  | 'createPullRequestReview'
  | 'listPullRequestReviews'
  | 'getPullRequest'
  | 'markPullRequestReady'
  | 'getCommitChecks'
  | 'getCheckRunDiagnostics'
  | 'mergePullRequest'
  | 'createIssueComment'
  | 'replyToReviewComment'
  | 'resolveReviewThread'
  | 'listReviewThreads';

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
  /** Annotations and log of each failed check run, by check run id (the CI step). */
  diagnostics: Record<number, CheckRunDiagnostics> = {};
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
  /** The body the pull request was opened with (it carries the run's marker), and who opened it. */
  pullBody = '';
  pullAuthor: string | null = null;
  /** The pull request's diff, as listPullRequestFiles reports it. */
  files: PullRequestFile[] = [];
  /** Inline review comments and replies, oldest first. */
  reviewComments: Array<PullRequestReviewComment & { line?: number; side?: string; startLine?: number }> = [];
  /** Threads (by their first comment's id) that are resolved. */
  readonly resolved = new Set<number>();
  /** Refuse a review with inline comments (422), as GitHub does for a line outside the diff. */
  refuseInline = false;
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
    const review: GitHubReview = { id: `PRR_${id}`, state, author, submittedAt: this.updatedAt, body, url, lastEditedAt: null, editor: null, comments: [], commentCount: 0, commitSha: this.headSha() };
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
    this.pullBody = input.body;
    this.pullAuthor = this.login;
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
  async updateIssueComment(_repo: RepoRef, commentId: number, body: string): Promise<GitHubIssueComment> {
    const c = this.comments.find((x) => x.id === commentId);
    if (!c) throw new GitHubError('comment not found', 404);
    this.writes.push(`edit comment #${c.issue}`);
    c.body = body;
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
  async getPullRequest(_repo?: RepoRef, pullNumber?: number): Promise<PullRequestDetails> {
    this.calls.push('getPullRequest');
    this.maybeFail('getPullRequest');
    const p = this.need();
    if (pullNumber !== undefined && pullNumber !== p.number) throw new GitHubError('pull request not found', 404);
    return { number: p.number, nodeId: `PR_node_${p.number}`, htmlUrl: `https://github.com/${this.fullName}/pull/${p.number}`, state: p.state, merged: p.merged, draft: p.draft, headRef: p.headRef, headSha: this.headSha(), baseRef: p.baseRef, mergeable: p.mergeable, mergeableState: p.mergeableState, author: this.pullAuthor, body: this.pullBody, headRepoId: 42 };
  }
  async listPullRequestReviews(): Promise<PullRequestReviewSummary[]> {
    this.calls.push('listPullRequestReviews');
    this.maybeFail('listPullRequestReviews');
    return [...this.reviews];
  }
  async createPullRequestReview(_repo: RepoRef, pull: number, input: { body: string; commitId?: string; comments?: ReviewCommentInput[] }): Promise<PullRequestReviewSummary> {
    this.maybeFail('createPullRequestReview');
    if (this.refuseCommitId && input.commitId) throw new GitHubError('POST /pulls/reviews failed: 422 Unprocessable Entity: commit_id is not part of the pull request', 422);
    if (this.refuseInline && input.comments?.length) throw new GitHubError('POST /pulls/reviews failed: 422 Unprocessable Entity: Line could not be resolved', 422);
    this.writes.push(`review #${pull} COMMENT at ${input.commitId ?? '(no commit)'}${input.comments?.length ? ` with ${input.comments.length} inline` : ''}`);
    const id = this.nextId++;
    const r: PullRequestReviewSummary = { id, state: 'COMMENTED', user: this.login, body: input.body, htmlUrl: `https://github.com/${this.fullName}/pull/${pull}#pullrequestreview-${id}`, submittedAt: this.updatedAt, commitId: input.commitId ?? null };
    this.reviews.push(r);
    for (const c of input.comments ?? []) {
      const cid = this.nextId++;
      this.reviewComments.push({ id: cid, reviewId: id, inReplyToId: null, user: this.login, body: c.body, path: c.path, htmlUrl: `https://github.com/${this.fullName}/pull/${pull}#discussion_r${cid}`, line: c.line, side: c.side, ...(c.startLine !== undefined ? { startLine: c.startLine } : {}) });
    }
    this.touch();
    return r;
  }
  async listPullRequestFiles(): Promise<PullRequestFile[]> {
    this.calls.push('listPullRequestFiles');
    return [...this.files];
  }
  async listPullRequestReviewComments(): Promise<PullRequestReviewComment[]> {
    this.calls.push('listPullRequestReviewComments');
    return this.reviewComments.map(({ line: _l, side: _s, startLine: _st, ...c }) => ({ ...c }));
  }
  /** A person (or anyone) replies in a thread. */
  reply(commentId: number, user: string, body: string): PullRequestReviewComment {
    const root = this.reviewComments.find((c) => c.id === commentId);
    if (!root) throw new GitHubError('comment not found', 404);
    const id = this.nextId++;
    const c = { id, reviewId: null, inReplyToId: root.inReplyToId ?? root.id, user, body, path: root.path, htmlUrl: `https://github.com/${this.fullName}/pull/${this.pull?.number}#discussion_r${id}` };
    this.reviewComments.push(c);
    this.touch();
    return c;
  }
  async replyToReviewComment(_repo: RepoRef, pull: number, commentId: number, body: string): Promise<PullRequestReviewComment> {
    this.maybeFail('replyToReviewComment');
    this.writes.push(`reply #${pull} to ${commentId}`);
    return this.reply(commentId, this.login, body);
  }
  async listReviewThreads(): Promise<ReviewThread[]> {
    this.calls.push('listReviewThreads');
    this.maybeFail('listReviewThreads');
    return this.reviewComments.filter((c) => c.inReplyToId === null).map((c) => ({ id: `T_${c.id}`, isResolved: this.resolved.has(c.id), rootCommentId: c.id, rootAuthor: c.user }));
  }
  async resolveReviewThread(_repo: RepoRef, threadId: string): Promise<void> {
    this.maybeFail('resolveReviewThread');
    this.writes.push(`resolve ${threadId}`);
    this.resolved.add(Number(threadId.replace(/^T_/, '')));
    this.touch();
  }
  /** The thread replies under a first comment, oldest first. */
  thread(rootId: number): PullRequestReviewComment[] {
    return this.reviewComments.filter((c) => c.inReplyToId === rootId);
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
  async getCheckRunDiagnostics(_repo: RepoRef, checkRunId: number): Promise<CheckRunDiagnostics> {
    this.calls.push(`getCheckRunDiagnostics ${checkRunId}`);
    this.maybeFail('getCheckRunDiagnostics');
    return this.diagnostics[checkRunId] ?? { annotations: [], logTail: null, problems: ['there is no GitHub Actions log for this check'] };
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
