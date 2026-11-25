/**
 * Shared domain types. Persisted shapes here are versioned; bump
 * ENVELOPE_SCHEMA_VERSION when the envelope changes incompatibly.
 */

export const ENVELOPE_SCHEMA_VERSION = 1;

export interface RepoRef {
  /** Stable GitHub repository ID. Use this for persisted state. */
  id: number;
  /** owner/name at the time the event was observed. Display only. */
  fullName: string;
}

/**
 * Transport-independent description of the GitHub event that caused a job.
 * Polling builds these today; a webhook relay could build the same shape later.
 */
/** How a job's pool was chosen (see docs/tier-routing.md). Decided at enqueue, then fixed for the job. */
export interface RoutingDecision {
  rule: 'default' | 'legacy-label' | 'override-label' | 'heuristic' | 'triage';
  pool: string;
  /** Set when tier routing is on. */
  tier?: 'routine' | 'standard' | 'complex' | 'high-risk';
  complexity?: 'routine' | 'standard' | 'complex';
  risk?: 'low' | 'medium' | 'high';
  confidence?: number;
  /** Why this rule chose this way. */
  detail?: string;
  /** Set when no eligible pool exists: the job is not run and needs a human. */
  hold?: string;
  /** Heuristic rule only: the local classifier's confidence was below tiers.minConfidence. */
  uncertain?: boolean;
  /** Set when CLI triage was consulted (docs/triage.md). Holds no issue text. */
  triage?: TriageNote;
}

/** What CLI triage contributed to a routing decision, kept on the job for status and logs. */
export interface TriageNote {
  /** cli: a triage run just answered; cache: an earlier answer was reused; fallback: no usable answer, local routing stands. */
  origin: 'cli' | 'cache' | 'fallback';
  agent: string;
  /** The agent's validated verdict; absent for a fallback. */
  complexity?: 'routine' | 'standard' | 'complex';
  risk?: 'low' | 'medium' | 'high';
  confidence?: number;
  /** The agent's short explanation (clipped, untrusted text), or the reason for the fallback. */
  reason: string;
  /** Why a verdict was not followed in full (a policy floor was higher). */
  conflict?: string;
}

export interface EventEnvelope {
  schemaVersion: typeof ENVELOPE_SCHEMA_VERSION;
  /**
   * issue.labeled: a trigger label was applied to an issue. pull_request.changes_requested: a
   * review asked for changes on a PR Updraft published; `revision` then says which and with what text.
   * pull_request.review: Updraft's own reviewer run of one head commit of such a PR
   * (repositories.<repo>.review); `review` then says which commit and with what context.
   */
  type: 'issue.labeled' | 'pull_request.changes_requested' | 'pull_request.review';
  repo: RepoRef;
  issue: { number: number; title: string; url: string };
  /** GitHub issue-event ID (stringified). For a revision: "review:<review id>". For a reviewer run: "pr-review:<pr>:<head sha>". */
  eventId: string;
  /** Link to the event's subject (the issue URL). */
  url: string;
  actor: string | null;
  label: string;
  /** Labels on the issue when the job was enqueued (used for routing). */
  labelsAtEnqueue: string[];
  createdAt: string;
  /** Routing decision for issue jobs when tier routing is on. */
  routing?: RoutingDecision;
  /** Present exactly when `type` is pull_request.changes_requested. */
  revision?: RevisionRequest;
  /** Present exactly when `type` is pull_request.review. */
  review?: ReviewRunRequest;
  /**
   * An issue.labeled job only: this job continues the issue after a pull request it waited on was
   * merged (repositories.<repo>.dependencies, docs/dependencies.md). `eventId` is then
   * "dep:<waiting run id>", and the issue text is vouched for against `resume.originalEventId`.
   */
  resume?: DependencyResume;
}

/** What a follow-up job knows about the wait it continues (docs/dependencies.md). */
export interface DependencyResume {
  /** Event id of the label application that queued the first job of the issue; the issue text is vouched for against it. */
  originalEventId: string;
  /** The run that declared the wait, and its job. */
  waitingRunId: string;
  waitingJobId: string;
  /** Waits in this chain so far, the one that just ended included (1 for the first follow-up). */
  waits: number;
  /** The pull request that was waited on, as the worker read it when it saw the merge. `title` is untrusted text. */
  pullRequest: { repo: string; number: number; url: string; title: string; mergedAt: string | null; mergeCommitSha: string | null };
  /** The waiting run's final message without its UPDRAFT-WAITING-ON line, capped. Untrusted text. */
  note: string;
}

/** The wait a follow-up job continues, or null for any other job. */
export function resumeOf(job: { envelope?: EventEnvelope }): DependencyResume | null {
  return job.envelope?.type === 'issue.labeled' ? (job.envelope.resume ?? null) : null;
}

/**
 * The label application a job's issue text is vouched for against: the job's own event, or for a
 * follow-up job (docs/dependencies.md) the one that queued the first job of the issue.
 */
export function labelEventIdOf(job: { eventId: string; envelope?: EventEnvelope }): string {
  return resumeOf(job)?.originalEventId ?? job.eventId;
}

/**
 * What made a review count as a change request (see reviewTrigger in src/poller/review-trigger.ts).
 * changes_requested: a submitted review with state CHANGES_REQUESTED by an allowed actor.
 * updraft_review: a changes-requested verdict of Updraft's own reviewer run, taken from the
 * worker's database when the verdict is recorded (never read back from GitHub).
 * ci_failure: GitHub's checks failed on a head the reviewer found ready (repositories.<repo>.ciFix,
 * src/publish/ci.ts); the "review" is the worker's own summary of the failed checks.
 */
export type RevisionTriggerKind = 'changes_requested' | 'updraft_review' | 'ci_failure';

/** One inline comment of the triggering review, as it read when the review was ingested. Untrusted text. */
export interface ReviewCommentSnapshot {
  path: string;
  /** Line in the file the comment is attached to; null for a file-level or outdated comment. */
  line: number | null;
  body: string;
  /** The diff hunk GitHub shows above the comment (capped); '' when there is none. */
  diffHunk: string;
}

/**
 * The triggering review as it read when it was ingested. A revision run uses this snapshot and
 * never re-reads the review, so an edit made after ingestion cannot reach the agent.
 */
export interface ReviewSnapshot {
  /** GitHub's node id of the review; the dedupe key. */
  id: string;
  url: string;
  author: string;
  submittedAt: string;
  body: string;
  comments: ReviewCommentSnapshot[];
  /** Inline comments left out: beyond the cap, or not written by an allowed actor. */
  omittedComments: number;
  /**
   * The commit the review was submitted against: the pull request's head at that moment, as
   * GitHub records it with the review. It is the same on every machine that reads the review,
   * which is what lets one tell that the branch has moved since (docs/revisions.md, "One
   * revision per review"). Absent for reviews ingested before it was recorded, and when GitHub
   * does not say.
   */
  headSha?: string;
}

/**
 * A finding of Updraft's reviewer that a revision answers (docs/review-loop.md, "Findings as
 * threads"): the reviewer's text (untrusted) and the thread it is discussed in. `key` names the
 * thread: the coding agent reports on each key.
 */
export interface RevisionFinding {
  key: string;
  severity: 'blocker' | 'suggestion';
  title: string;
  problem: string;
  suggestion: string | null;
  path: string | null;
  line: number | null;
  threadUrl: string | null;
}

/** The revision a pull_request.changes_requested job carries out. */
export interface RevisionRequest {
  trigger: RevisionTriggerKind;
  /** `branch` is the PR's head: the job branch Updraft pushed when it opened the PR. */
  pullRequest: { number: number; url: string; branch: string };
  /** The run whose publication opened the PR. */
  sourceRunId: string;
  /** Event id of the label application that queued the original job; the issue text is vouched for against it. */
  originalEventId: string;
  review: ReviewSnapshot;
  /**
   * updraft_review and ci_failure: the head commit the verdict (or the failed checks) was for. The
   * revision is dropped as stale unless the pull request is still at this commit when it starts.
   */
  reviewedSha?: string;
  /** updraft_review with structured findings: each one to report on. Absent for a legacy review, a person's review and a CI fix. */
  findings?: RevisionFinding[];
}

/** What Updraft's reviewer concluded about one head commit. Anything else is not a verdict. */
export type ReviewVerdict = 'ready-to-merge' | 'changes-requested';
export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ['ready-to-merge', 'changes-requested'];

/** An earlier Updraft review of the same pull request, as given to a later reviewer run. Untrusted text. */
export interface PriorReviewSnapshot {
  headSha: string;
  verdict: ReviewVerdict;
  agent: string;
  findings: string;
}

/** The reviewer run a pull_request.review job carries out. */
export interface ReviewRunRequest {
  /** `branch` is the PR's head branch, `baseBranch` the branch it was opened against (null when unknown). */
  pullRequest: { number: number; url: string; branch: string; baseBranch: string | null };
  /** The commit to review. The verdict is bound to it. */
  headSha: string;
  /** Agent of the pull request's latest code run when the job was queued; never picked as the reviewer while another agent can be. */
  authorAgent: string | null;
  /** The run whose publication opened the PR. */
  sourceRunId: string;
  /** Event id of the label application that queued the original job; the issue text is vouched for against it. */
  originalEventId: string;
  /** Findings of earlier Updraft reviews of this PR, oldest first, as recorded when this job was queued. */
  priorReviews: PriorReviewSnapshot[];
  /** Change requests by allowed actors that queued a revision of this PR, oldest first, as snapshotted when each was ingested. */
  changeRequests: ReviewSnapshot[];
  /**
   * Structured findings of earlier rounds that no reviewer has verified yet, oldest first, with the
   * coding agent's report on each (a claim): what this reviewer checks. Absent before findings existed.
   */
  openFindings?: OpenFindingSnapshot[];
  /** Earlier findings not verified yet that are not in openFindings (more than one review can check). */
  openFindingsOmitted?: number;
}

/** An earlier finding to re-check (docs/review-loop.md, "Findings as threads"). Its text and report are untrusted. */
export interface OpenFindingSnapshot {
  key: string;
  severity: 'blocker' | 'suggestion';
  title: string;
  problem: string;
  path: string | null;
  line: number | null;
  /** What a reviewer last found, if any. */
  status: 'open' | 'unresolved';
  /** The coding agent's report, if a revision answered it. */
  resolution: { status: 'fixed' | 'disagreed' | 'deferred' | 'unable' | 'unreported'; note: string | null; sha: string } | null;
}

/** The reviewer run a job carries out, or null for any other job. */
export function reviewOf(job: { envelope?: EventEnvelope }): ReviewRunRequest | null {
  return job.envelope?.type === 'pull_request.review' ? (job.envelope.review ?? null) : null;
}

/** The revision a job carries out, or null for an issue job. */
export function revisionOf(job: { envelope?: EventEnvelope }): RevisionRequest | null {
  return job.envelope?.type === 'pull_request.changes_requested' ? (job.envelope.revision ?? null) : null;
}

/** The issue as fetched by the worker's pre-start check, handed to the executor. Untrusted text. */
export interface IssueSnapshot {
  title: string;
  body: string;
  labels: string[];
  url: string;
  /**
   * Revision jobs only: why the body must not be given to the agent (the issue changed since an
   * allowed actor approved it). `body` is '' then.
   */
  withheld?: string;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'canceled';

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'interrupted', 'canceled'];

export interface Job {
  id: string;
  repoId: number;
  repoFullName: string;
  workflowId: string;
  eventId: string;
  issueNumber: number;
  action: string;
  /** Pool chosen once at enqueue time. */
  pool: string;
  envelope: EventEnvelope;
  status: JobStatus;
  statusReason: string | null;
  attempts: number;
  /** Consecutive start failures since enqueue or the user's last retry (capped by MAX_START_FAILURES). */
  startFailures: number;
  createdAt: string;
  updatedAt: string;
}

export type RunOutcome = 'succeeded' | 'failed' | 'interrupted' | 'start_failed';

export interface Run {
  id: string;
  jobId: string;
  attempt: number;
  pool: string;
  agent: string;
  checkoutPath: string | null;
  logPath: string | null;
  workerId: string;
  /** Host of the worker that claimed the run (null for runs from before it was recorded). */
  hostname: string | null;
  pid: number | null;
  /**
   * OS start time of `pid`, platform-tagged (see processStartTime). A pid is only signalled when
   * this still matches, so a reused pid is never killed. Null for runs recorded before v5.
   */
  pidStartTime: string | null;
  leaseExpiresAt: string;
  /** When the job was claimed. */
  startedAt: string;
  /** When the worker handed the run to the executor; null while claimed but not started. */
  executionStartedAt: string | null;
  endedAt: string | null;
  outcome: RunOutcome | null;
  error: string | null;
  /** What a live agent run left behind; null for log-only and prepare-only runs. */
  summary: RunSummary | null;
  /**
   * When the user asked to cancel this run (`updraft cancel`). A run closed with this set has no
   * outcome and its job is 'canceled', whatever the executor reported.
   */
  cancelRequestedAt: string | null;
  /**
   * The container a containerized live run started (agents.<name>.container): the runtime client
   * and the container's name, so a later worker on the same host can remove it. Null when the
   * agent ran on the host.
   */
  container: RunContainer | null;
}

export interface RunContainer {
  /** Absolute path of the runtime client (docker, podman) that started the container. */
  runtime: string;
  name: string;
}

/** Recorded after a live agent run, in run.log and the state DB (`updraft status`). */
export interface RunSummary {
  branch: string;
  baseSha: string;
  /**
   * The commit the job branch was at when the run ended, read by the worker. Publication pushes
   * exactly this commit and refuses if the branch has moved since: a later retry must not publish,
   * under this run's verification, a commit the run never produced. Absent in older summaries.
   */
  headSha?: string;
  worktree: string;
  /** Commits on the job branch since the base commit, newest first ("<short sha> <subject>"), capped. */
  commits: string[];
  commitCount: number;
  /** Tracked files that differ from the base commit, committed or not. */
  filesChanged: number;
  /** Last line of `git diff --stat <base>`, e.g. "3 files changed, 10 insertions(+), 2 deletions(-)". */
  diffStat: string;
  /** Files in the worktree that git does not track yet. */
  untracked: number;
  /** The agent's last output lines (stdout and stderr). */
  lastOutput: string[];
  /** Parts of the summary that could not be computed. */
  notes: string[];
  /** Result of the action's verify commands; absent when none ran (and in summaries from before they existed). */
  verification?: VerificationSummary;
  /** A reviewer run only: the commit it reviewed and what it concluded. Absent when no verdict could be read. */
  review?: ReviewResult;
  /** A revision of structured findings only: the agent's own report per finding key (a claim, never a check). */
  resolutions?: { finding: string; status: 'fixed' | 'disagreed' | 'deferred' | 'unable'; note: string | null; tests: string | null }[];
}

/** The parsed result of a reviewer run. `findings` is the reviewer's text before the verdict line: untrusted. */
export interface ReviewResult {
  headSha: string;
  baseSha: string | null;
  verdict: ReviewVerdict;
  findings: string;
  /**
   * The reviewer's UPDRAFT-FINDINGS count; null when its line was missing, repeated or malformed.
   * Telemetry only: it never affects the verdict. Absent in summaries from before it existed.
   */
  findingsCount?: number | null;
}

/**
 * passed/failed: the command exited 0 / non-zero (or could not be started, or was killed by a
 * signal). timed_out/interrupted: the worker stopped it at the step's time limit / on shutdown.
 * not_run: an earlier command did not pass.
 */
export type VerificationStatus = 'passed' | 'failed' | 'timed_out' | 'interrupted' | 'not_run';

export interface VerificationCommandResult {
  /** The command as configured (an argv command joined for display). */
  command: string;
  status: VerificationStatus;
  exitCode: number | null;
  seconds: number;
}

/** What the worker's verification step (actions.<name>.verify) did after the agent succeeded. */
export interface VerificationSummary {
  passed: boolean;
  commands: VerificationCommandResult[];
  /**
   * Entries of `git status --porcelain` in the worktree before the first command and after the
   * last one that ran; null when git could not tell. Uncommitted changes are never published, so
   * a non-zero `before` means the commands saw files the commits don't contain, and a higher
   * `after` means the commands themselves changed the worktree.
   */
  uncommittedBefore: number | null;
  uncommittedAfter: number | null;
  /** The commit checked out when the first command started; null when git could not tell. Absent in older summaries. */
  sha?: string | null;
  /**
   * True only when the commands tested exactly `sha`: the worktree had no uncommitted or untracked
   * files when they started, and HEAD was still `sha` when they ended. Otherwise a pass says
   * nothing certain about the commit that gets published (a test can pass because of a fix that
   * was never committed). Absent in older summaries, which is read as false.
   */
  exact?: boolean;
  /**
   * Set for a containerized run whose tree has submodules: the worker does not run git inside
   * them on the host, so uncommitted files there were not counted and `exact` is false.
   */
  submodulesNotInspected?: boolean;
}

export type PublicationState = 'publishing' | 'published' | 'failed' | 'skipped';

/**
 * The push and reply of one revision run (src/publish/revision.ts). published: the PR branch was
 * fast-forwarded and the reply posted. skipped: nothing was pushed (no commits, or the PR was
 * closed). failed: see `error`; `moved` says the PR branch was no longer where the run started.
 */
export interface Revision {
  runId: string;
  jobId: string;
  repoId: number;
  repoFullName: string;
  issueNumber: number;
  prNumber: number;
  reviewId: string;
  trigger: RevisionTriggerKind;
  state: PublicationState;
  /** The PR's own branch on the remote. */
  branch: string;
  /** The remote head of `branch` the run started from; the push only fast-forwards from exactly this. */
  baseSha: string | null;
  /** The commit pushed (or found already on the remote at this SHA). */
  headSha: string | null;
  pushedAt: string | null;
  /** True when the push was refused because the PR branch had moved. Never retried automatically. */
  moved: boolean;
  commentId: number | null;
  commentUrl: string | null;
  error: string | null;
  retryable: boolean;
  attempts: number;
  leaseExpiresAt: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

/** Publication of a succeeded live run: job branch pushed, PR opened, issue commented. */
export interface Publication {
  runId: string;
  jobId: string;
  repoId: number;
  repoFullName: string;
  issueNumber: number;
  mode: 'draft-pr' | 'pr';
  state: PublicationState;
  branch: string;
  baseBranch: string | null;
  /** The commit pushed, or found already on the remote at the same SHA. */
  headSha: string | null;
  pushedAt: string | null;
  prNumber: number | null;
  prUrl: string | null;
  commentId: number | null;
  commentUrl: string | null;
  /** Why it failed, or why it was skipped. */
  error: string | null;
  /** A transient failure (network, 5xx, rate limit) the worker retries on its own. */
  retryable: boolean;
  attempts: number;
  leaseExpiresAt: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}
