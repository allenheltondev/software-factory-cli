// `updraft run-event`: carry ONE GitHub webhook event through to the end, then exit.
// docs/run-event.md is the contract; this file is the wiring.
//
//   payload file -> decideWebhook (the poller's ingestion rules, from the API)
//                -> "already in this state database?" (shared between runs: docs/shared-state.md);
//                   a pull request that is not, and that GitHub says is ours: "state pending"
//                -> "already handled?" (GitHub, for runs that could not see each other's state);
//                   handled, and nothing of it on record: the publication is restored
//                -> the clone, created if missing
//                -> the queue, with a job id derived from the event; or, for a pull request
//                   event, the review poller (reviews.ts) for that pull request
//                -> a hold on the event's work, for the runs that see this one's checkpoints
//                -> drainQueue (runDaemon until the event's work is done: pre-start check, live
//                   executor, verification, publication, the review loop, auto-merge, failure
//                   comment), scoped to the event (src/worker/scope.ts)
//                -> the last look at the event's pull requests, and what it queues
//                -> one summary, one exit code, for everything the run did for the event
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config/io.js';
import { ciSettings, autoMergeMethod, DEFAULT_MAX_REVISIONS, publishMode, reviewActive, reviseActive, suggestionsActive, type UpdraftConfig } from '../config/schema.js';
import type { Db } from '../db/database.js';
import { routeReasonCode, routeSourceOf } from '../db/metrics.js';
import { getFailureComment } from '../db/failure-comments.js';
import { putHold, releaseHolds } from '../db/holds.js';
import { cancelQueuedJob, commitPollBatch } from '../db/ingest.js';
import { getLoopPr, listResumableMerges, prStage, scheduleAllReviews } from '../db/pr-reviews.js';
import { getPublication } from '../db/publications.js';
import { getJob, latestRunOfJob, MAX_START_FAILURES, RETRYABLE, retryJob } from '../db/queue.js';
import { countRevisions, getRevisionPr, syncRevisionPrs } from '../db/revisions.js';
import { cloneRefFormat, ensureClone, githubCloneUrl, housekeepManagedClone, workerNetworkGit, type NetworkGit } from '../git/clone.js';
import { listRemotes, runGit, selectRepoRemote, type GitOptions } from '../git/git.js';
import { jobBranchName, withCheckoutLock } from '../git/worktree.js';
import { GitHubError, type GitHubApi } from '../github/api.js';
import { redactGitHubSecrets } from '../github/app-auth.js';
import { appCommitIdentity, type GitHubCredentials } from '../github/credentials.js';
import { checkJobDispatchable } from '../poller/poller.js';
import { pollRepoReviews } from '../poller/reviews.js';
import { decideWebhook, type WebhookDeps, type WebhookEventInfo } from '../poller/webhook.js';
import { consoleContextFromEnv, createAssignmentCommenter, type AssignmentCommenter } from '../publish/assignment-comment.js';
import { createFailureCommenter, failureCommentsEnabled } from '../publish/failure-comment.js';
import { createPublisher, publicationEnabled, type PublishDeps } from '../publish/publish.js';
import { evaluateCiAll, postCiNotices } from '../publish/ci.js';
import { evaluateAutoMerges } from '../publish/merge.js';
import { evaluateSuggestionsAll } from '../publish/suggestions.js';
import { resolveVerifiedThreadsAll } from '../publish/thread-resolve.js';
import { createReviewLoopPublisher, reviewsEnabled } from '../publish/review.js';
import { createRevisionPublisher, findRevisionClaims, revisionsEnabled, SUPERSEDED_PREFIX } from '../publish/revision.js';
import { reviewOf, revisionOf, type Job, type RepoRef, type VerificationSummary } from '../types.js';
import { createLogger, type Logger, type LoggerOptions } from '../util/log.js';
import type { DaemonDeps } from '../worker/daemon.js';
import { drainQueue, type DrainEnd, type DrainOptions, type DrainResult } from '../worker/drain.js';
import { findRepoConfig } from '../worker/executor.js';
import type { LiveExecutorOptions } from '../worker/live.js';
import { createExecutor } from '../worker/prepare-only.js';
import { newId } from '../util/ids.js';
import { createEventScope, foreignWork, nothingPending, pendingWork, withoutForeignWork, type GuardedScope } from '../worker/scope.js';
import { println, type CommandContext } from './context.js';
import { CliError, describeError, EXIT } from './errors.js';
import {
  failStalledPublication,
  findStalledPublication,
  holdEnd,
  requeueAbandonedJob,
  resumeStalledPublication,
  settleAbandonedJob,
  type AbandonedRunSummary,
  type StalledPublication,
} from './run-event-abandoned.js';
import { readOwnPullRequest, restorePublication } from './run-event-restore.js';
import { adoptReviewRequests } from './run-event-shared-state.js';
import { installSignalHandlers } from './start.js';

export interface RunEventOptions {
  eventFile: string;
  /** The X-GitHub-Event header of the delivery. Default "issues". */
  eventName?: string;
  /** The X-GitHub-Delivery header, for the logs and the summary only. */
  deliveryId?: string;
  json?: boolean;
  /** Stop everything after this many minutes. */
  deadlineMinutes?: string;
  /** Fetch with the worker's GitHub credentials even into a clone run-event did not create. */
  workerGitCredentials?: boolean;
  /**
   * Requeue the event's jobs that failed, were interrupted or canceled before running it, as
   * `updraft retry` does, so a delivery runs them again instead of ending as a duplicate.
   */
  retry?: boolean;
  /**
   * A copy of the shared state database that the caller keeps fresher than the one this run
   * started from. Read, never written, before each last look (run-event-shared-state.ts).
   */
  sharedState?: string;
}

export interface RunEventDeps {
  createLogger: (opts: LoggerOptions) => Logger;
  /** Install SIGINT/SIGTERM handlers that call `abort`; returns an uninstaller. */
  onShutdownSignal: (abort: (signal: string) => void) => () => void;
  /** Where a clone that has to be created comes from. Default https://github.com/OWNER/REPO.git. */
  cloneUrl: (repoFullName: string) => string;
  /** Injected in tests. */
  runDaemon?: (deps: DaemonDeps) => Promise<void>;
  /** Drain timings; injected in tests. */
  drain?: Omit<DrainOptions, 'runDaemon' | 'deadlineMs' | 'scope'>;
  eventLookup?: WebhookDeps['eventLookup'];
  /** Extra options for the live executor; injected in tests. */
  executor?: LiveExecutorOptions;
}

export const defaultRunEventDeps: RunEventDeps = {
  createLogger,
  onShutdownSignal: installSignalHandlers,
  cloneUrl: githubCloneUrl,
};

/** One job of the event. An event is one job unless several workflows share its trigger label. */
export interface RunEventJobSummary {
  jobId: string;
  workflowId: string;
  /** The job's final status in the queue: succeeded, failed, canceled, interrupted, or queued when it never started. */
  status: string;
  runId: string | null;
  agent: string | null;
  kind?: 'implement' | 'review' | 'revision' | 'other';
  /**
   * How the run was routed, from the run's own `run.selected` row and the job's routing decision:
   * `tier` is the tier that ran, `requestedTier` the one the router chose (they differ after an
   * escalation), `reason` a fixed code (metrics.ts routeReasonCode).
   */
  routing?: { source: 'pool' | 'tier' | 'fixed'; pool?: string; tier?: string; requestedTier?: string; reason?: string; risk?: string; confidence?: number; hops?: number };
  /** The run's outcome (succeeded, failed, start_failed, interrupted); null when no agent run ended. */
  runOutcome: string | null;
  /** The worker's own reason when the job did not succeed (or its publication failed). */
  error: string | null;
  branch: string | null;
  baseSha: string | null;
  headSha: string | null;
  commitCount: number | null;
  verification: { passed: boolean; commands: Array<{ command: string; status: string }> } | null;
  /** The publication's state (published, skipped, failed, publishing); null when nothing was published or publish is off. */
  publication: string | null;
  publicationError: string | null;
  prNumber: number | null;
  prUrl: string | null;
  /** The comment posted on the issue for a failed job (commentOnFailure), when one was posted. */
  failureCommentUrl: string | null;
  logPath: string | null;
}

/** A job the event's work queued while this run was going: a reviewer run, a revision. */
export interface RunEventFollowOnJob extends RunEventJobSummary {
  kind: 'review' | 'revision' | 'other';
  /** As the top-level `outcome`, for this job alone. */
  outcome: string;
}

/** The look at the event's pull requests that a run takes before it ends (docs/run-event.md, "The last look"). */
export interface RunEventFinalLook {
  /** How often the pull requests were read from the API after the work had run out. */
  looks: number;
  /** Jobs those reads queued (a person's change request, a head someone pushed), which this run then ran. */
  queued: number;
  /** Reviews that were not looked at because `--shared-state` showed that another run has them on record. */
  knownElsewhere: number;
  /** Why a look failed; null when none did. A failed look changes nothing else about the run. */
  error: string | null;
}

/** Where the review loop left a pull request of the event (repositories.<repo>.review, revise, autoMerge). */
export interface RunEventLoopSummary {
  pullRequest: number;
  url: string;
  /** Revision rounds the pull request has had (change requests that queued a revision), against maxRevisions. */
  rounds: number;
  maxRevisions: number;
  /** Reviewer verdicts recorded for it, all runs of all events together. */
  reviews: number;
  /** The newest verdict (ready-to-merge, changes-requested) and the commit it is for; null before the first. */
  verdict: string | null;
  verdictSha: string | null;
  /** The newest head commit the state database knows of. */
  headSha: string | null;
  /** The stage `updraft status` shows (awaiting-review, reviewing, changes-requested, revising, ready-to-merge, merging, merged, needs-human, closed), and its detail line. */
  stage: string;
  detail: string;
  /** True once the draft was marked ready for review. */
  ready: boolean;
  merged: boolean;
  mergeCommitSha: string | null;
  /** Why it is not merged; null when it is. */
  notMergedReason: string | null;
  /**
   * The one automatic re-run of failed checks on the head (docs/ci-fix.md, "One re-run"): the
   * head, when, and which checks; null when that head was not re-run.
   */
  ciRerun: { sha: string; at: string | null; checks: string[] } | null;
}

/**
 * What `updraft run-event --json` prints: one object, always, whatever happened.
 * `outcome` and `exitCode` say how it went; the job fields describe the event's job.
 */
export interface RunEventSummary extends Omit<RunEventJobSummary, 'jobId' | 'workflowId' | 'status'> {
  event: WebhookEventInfo;
  /** True when a job was queued for the event in this run. */
  dispatched: boolean;
  /** True when this run continued work that an earlier run of the event left in the state database. */
  resumed: boolean;
  /**
   * - nothing-to-do: no job was queued (`reason` says why).
   * - succeeded: the job ran and, where publish is on, its result was published (or there was nothing to publish),
   *   and so did every job that followed from it in this run (reviewer runs, revisions).
   * - canceled: the job was queued and the pre-start check canceled it before any agent started.
   * - failed: an agent run of the event's job, or of a job that followed from it, failed, could not start, or was interrupted.
   * - publish-failed: a run succeeded and its publication, revision push or review posting did not.
   * - state-pending: a pull request event for a pull request Updraft opened that this state
   *   database does not know yet; nothing was done, and the event is to be run again with a
   *   newer copy of the state database.
   * - superseded: the run succeeded, but another run of the same event published first; this
   *   run's commits were not pushed and nothing on GitHub was changed by it.
   * - not-started: the job was still queued when the drain ended.
   * - deferred: work of the event is queued behind a usage-limit cooldown that ends after this
   *   run would; it stays queued in the state database, and delivering the event again later
   *   continues it (`deferredUntil`).
   * - error: the command itself failed (configuration, GitHub, the event file).
   */
  outcome: 'nothing-to-do' | 'succeeded' | 'canceled' | 'superseded' | 'failed' | 'publish-failed' | 'not-started' | 'deferred' | 'state-pending' | 'error';
  /**
   * Why nothing was done (or nothing was published), as a code: a NothingToDoReason,
   * "already-handled", "duplicate-delivery", "pull-request-not-watched", "pull-request-closed",
   * "no-new-work", "canceled-before-start", "published-by-another-run", "cooldown", "state-pending"
   * or (with outcome `error`) "state-not-restorable".
   */
  reason: string | null;
  /**
   * True when this run put a publication back on record from the GitHub API: the event's pull
   * request exists, and the state database had nothing of the run that opened it.
   */
  stateRestored: boolean;
  /**
   * Set when the state database had the event's job as `running` under a run that is gone (it
   * checkpointed and vanished; its hold has ended): that run was closed, and `resumed` says
   * whether this run then did the job itself. Null otherwise.
   */
  abandonedRun: AbandonedRunSummary | null;
  /** With outcome `deferred`: when the cooldown ends (ISO time). Null otherwise. */
  deferredUntil: string | null;
  /** The review loop's result for the event's pull request; null when the event has none, or the loop is off. */
  loop: RunEventLoopSummary | null;
  /** One line for a person. */
  message: string;
  jobId: string | null;
  workflowId: string | null;
  status: string | null;
  /** How the drain ended; null when it never started. */
  drain: DrainEnd | null;
  /** Every job of the event, when there is more than one; the top-level fields describe the first. */
  jobs?: RunEventJobSummary[];
  /** The jobs that followed from the event's in this run, when there are any. They count towards `outcome`. */
  followOnJobs?: RunEventFollowOnJob[];
  /** Null when no last look was due: the run has no open pull request, or neither revise nor review is on. */
  finalLook: RunEventFinalLook | null;
  exitCode: number;
}

const NO_JOB: Omit<RunEventJobSummary, 'jobId' | 'workflowId' | 'status'> = {
  runId: null,
  agent: null,
  runOutcome: null,
  error: null,
  branch: null,
  baseSha: null,
  headSha: null,
  commitCount: null,
  verification: null,
  publication: null,
  publicationError: null,
  prNumber: null,
  prUrl: null,
  failureCommentUrl: null,
  logPath: null,
};

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function readEvent(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(resolve(file), 'utf8');
  } catch (err) {
    throw new CliError(`could not read the event file ${file}: ${errText(err)}`, EXIT.USAGE);
  }
  try {
    // A byte order mark is not JSON, and some tools write one.
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch (err) {
    throw new CliError(`the event file ${file} is not JSON: ${errText(err)}`, EXIT.USAGE);
  }
}

function parseDeadline(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new CliError(`--deadline-minutes must be a positive number, not "${value}"`, EXIT.USAGE);
  return Math.round(minutes * 60_000);
}

/** What already exists on GitHub for a job of this event: the reason a second run stops. */
interface ExistingWork {
  /** The attempt the branch belongs to (jobBranchName). */
  attempt: number;
  branch: string;
  sha: string | null;
  prNumber: number | null;
  prUrl: string | null;
}

/**
 * Has this event's job already produced something on GitHub? The job id, and so the branch name,
 * is the same in every run of the event; a later attempt after a start failure adds "-<n>".
 * A pull request whose head is such a branch counts in any state (a merged PR's branch is usually
 * deleted), and so does the branch alone (a run that pushed and has not opened its PR yet, or
 * never will). Read with the same credentials and remote the run itself would fetch with.
 */
const branchNames = (job: { id: string; issueNumber: number }) => Array.from({ length: MAX_START_FAILURES }, (_, i) => jobBranchName(job, i + 1));

/** The pull request half of findExistingWork: the API alone, no clone. */
async function findExistingPullRequest(o: { api: GitHubApi; repo: RepoRef; job: { id: string; issueNumber: number } }): Promise<ExistingWork | null> {
  const owner = o.repo.fullName.split('/')[0]!;
  for (const [i, branch] of branchNames(o.job).entries()) {
    const pulls = (await o.api.listPullRequestsForHead(o.repo, { headOwner: owner, head: branch })).filter(
      (p) => p.headRef === branch && (p.headRepoId === null || p.headRepoId === o.repo.id),
    );
    const pr = pulls.find((p) => p.state === 'open') ?? pulls[0];
    if (pr) return { attempt: i + 1, branch, sha: null, prNumber: pr.number, prUrl: pr.htmlUrl };
  }
  return null;
}

async function findExistingWork(o: {
  api: GitHubApi;
  repo: RepoRef;
  job: { id: string; issueNumber: number };
  checkoutPath: string;
  remote: string;
  net: GitOptions;
}): Promise<ExistingWork | null> {
  const names = branchNames(o.job);
  const pr = await findExistingPullRequest(o);
  if (pr) return pr;
  const listed = (await withCheckoutLock(o.checkoutPath, () => runGit(['ls-remote', o.remote, ...names.map((n) => `refs/heads/${n}`)], o.net))).stdout;
  for (const line of listed.split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    const branch = names.find((n) => ref === `refs/heads/${n}`);
    if (sha && branch) return { attempt: names.indexOf(branch) + 1, branch, sha, prNumber: null, prUrl: null };
  }
  return null;
}

function describeExisting(e: ExistingWork): string {
  return e.prUrl
    ? `pull request #${e.prNumber} (${e.prUrl}) already exists for this event`
    : `the branch ${e.branch} already exists on GitHub for this event (at ${e.sha?.slice(0, 12)}), pushed by another run of it; ` +
        'if no pull request follows, delete the branch and redeliver the event';
}

/**
 * The cheap half of "one revision per review" (src/publish/revision.ts): before an agent is
 * started for a review, ask the pull request whether a revision for that review is there
 * already. It is when the worker's own identity left a claim for the review on the pull request
 * and the branch is at the commit that claim pushed (or the claim was a reply that had nothing
 * to push). Returns the reason to cancel the job with, or null.
 *
 * A pull request that is still at the commit the review was submitted against has had no push
 * since the review, so nothing is listed for it: one read of the pull request, usually.
 */
async function revisionAnsweredElsewhere(api: GitHubApi, job: Job): Promise<string | null> {
  const revision = revisionOf(job);
  if (!revision) return null;
  const repo = { id: job.repoId, fullName: job.repoFullName };
  const n = revision.pullRequest.number;
  let head: string;
  try {
    head = (await api.getPullRequest(repo, n)).headSha;
  } catch (err) {
    if (err instanceof GitHubError && [301, 404, 410].includes(err.status)) return null; // the ordinary check says what to do about that
    throw err;
  }
  if (revision.review.headSha !== undefined && head === revision.review.headSha) return null;
  // Only what can be seen to have landed: the pull request is at the claimed commit, or the claim
  // was a reply with nothing to push. A head that merely moved on proves nothing (the claiming
  // run may have died before pushing, and a person pushed); the publisher's ancestry check after
  // a fetch decides those (src/publish/revision.ts).
  const claim = (await findRevisionClaims(api, repo, n, revision.review.id)).find((c) => c.headSha === head || c.headSha === c.baseSha);
  if (!claim) return null;
  return `${SUPERSEDED_PREFIX}another run already answered this review on pull request #${n} (${claim.url}${claim.runId ? `, run ${claim.runId}` : ''}); no agent was started`;
}

function summarizeVerification(v: VerificationSummary | undefined): RunEventJobSummary['verification'] {
  if (!v) return null;
  return { passed: v.passed, commands: v.commands.map((c) => ({ command: c.command, status: c.status })) };
}

function summarizeJob(db: Db, config: UpdraftConfig, jobId: string): RunEventJobSummary {
  const job = getJob(db, jobId)!;
  const run = latestRunOfJob(db, jobId);
  const revision = revisionOf(job);
  const review = reviewOf(job);
  const kind = revision ? 'revision' : review ? 'review' : 'implement';
  const route = job.envelope.routing;
  const selection = run ? db.prepare("SELECT tier, requested_tier, reason, hops, route_source FROM metric_events WHERE kind = 'run.selected' AND subject_id = ?").get(run.id) as
    { tier: string | null; requested_tier: string | null; reason: string | null; hops: number | null; route_source: string | null } | undefined : undefined;
  const provenance = selection?.route_source ?? routeSourceOf(route ?? null);
  const source = provenance === 'override' || provenance === 'legacy-label' ? 'fixed'
    : provenance === 'local-rule' || provenance === 'cli-triage' || provenance === 'fallback' ? 'tier'
      : 'pool';
  const routing: NonNullable<RunEventJobSummary['routing']> = {
    source,
    pool: run?.pool ?? job.pool,
    tier: selection?.tier ?? route?.tier,
    requestedTier: selection?.requested_tier ?? route?.tier,
    reason: selection?.reason ?? routeReasonCode(route ?? null) ?? undefined,
    risk: route?.risk,
    confidence: route?.confidence,
    hops: selection?.hops ?? undefined,
  };
  // A revision run is pushed to its pull request and a reviewer run is posted on it: each has
  // its own record in place of a publication, reported in the publication fields.
  const loopPr = revision?.pullRequest ?? review?.pullRequest;
  if (loopPr) {
    const table = revision ? 'revisions' : 'pr_reviews';
    const step = run ? (db.prepare(`SELECT state, error, head_sha FROM ${table} WHERE run_id = ?`).get(run.id) as { state: string; error: string | null; head_sha: string | null } | undefined) : undefined;
    const failed = job.status === 'succeeded' && step?.state === 'failed';
    return {
      jobId,
      workflowId: job.workflowId,
      status: job.status,
      runId: run?.id ?? null,
      agent: run?.agent ?? null,
      kind,
      routing,
      runOutcome: run?.outcome ?? null,
      error: job.status === 'succeeded' ? (failed ? (step?.error ?? null) : null) : (job.statusReason ?? run?.error ?? null),
      branch: run?.summary?.branch ?? null,
      baseSha: run?.summary?.baseSha ?? null,
      headSha: step?.head_sha ?? run?.summary?.headSha ?? null,
      commitCount: run?.summary?.commitCount ?? null,
      verification: summarizeVerification(run?.summary?.verification),
      publication: step?.state ?? null,
      publicationError: step && step.state !== 'published' ? step.error : null,
      prNumber: loopPr.number,
      prUrl: loopPr.url,
      failureCommentUrl: (run ? getFailureComment(db, run.id) : null)?.commentUrl ?? null,
      logPath: run?.logPath ?? null,
    };
  }
  const pub = run ? getPublication(db, run.id) : null;
  const comment = run ? getFailureComment(db, run.id) : null;
  const found = findRepoConfig(config, job);
  const publishing = found ? publishMode(found.repo) !== 'none' : false;
  let error = job.status === 'succeeded' ? null : (job.statusReason ?? run?.error ?? null);
  if (job.status === 'succeeded' && pub?.state === 'failed') error = pub.error;
  if (job.status === 'succeeded' && publishing && run?.summary && run.summary.commitCount > 0 && !pub) error = 'the run succeeded but its publication was never attempted';
  return {
    jobId,
    workflowId: job.workflowId,
    status: job.status,
    runId: run?.id ?? null,
    agent: run?.agent ?? null,
    kind,
    routing,
    runOutcome: run?.outcome ?? null,
    error,
    branch: run?.summary?.branch ?? pub?.branch ?? null,
    baseSha: run?.summary?.baseSha ?? null,
    headSha: run?.summary?.headSha ?? pub?.headSha ?? null,
    commitCount: run?.summary?.commitCount ?? null,
    verification: summarizeVerification(run?.summary?.verification),
    publication: pub?.state ?? null,
    publicationError: pub && pub.state !== 'published' ? pub.error : null,
    prNumber: pub?.prNumber ?? null,
    prUrl: pub?.prUrl ?? null,
    failureCommentUrl: comment?.commentUrl ?? null,
    logPath: run?.logPath ?? null,
  };
}

type JobOutcome = Exclude<RunEventSummary['outcome'], 'nothing-to-do' | 'error' | 'state-pending'>;

function jobOutcome(j: RunEventJobSummary): JobOutcome {
  switch (j.status) {
    case 'succeeded':
      return j.error ? 'publish-failed' : 'succeeded';
    case 'canceled':
      return 'canceled';
    case 'queued':
    case 'running':
      return 'not-started';
    default:
      return 'failed';
  }
}

/** Worst first: what the whole event is reported as when it has several jobs. */
const OUTCOME_RANK: JobOutcome[] = ['failed', 'publish-failed', 'not-started', 'deferred', 'succeeded', 'superseded', 'canceled'];

function summarizeLoop(db: Db, config: UpdraftConfig, repoId: number, prNumber: number): RunEventLoopSummary | null {
  const pr = getLoopPr(db, repoId, prNumber);
  const cfg = Object.values(config.repositories).find((r) => r.id === repoId);
  if (!pr || !cfg) return null;
  const maxRevisions = cfg.maxRevisions ?? DEFAULT_MAX_REVISIONS;
  const stage = prStage(db, pr, maxRevisions, { ci: ciSettings(config, cfg) !== null, suggestions: suggestionsActive(config, cfg) });
  const merged = pr.mergeState === 'merged';
  let notMergedReason: string | null = null;
  if (!merged) {
    if (!autoMergeMethod(config, cfg)) notMergedReason = 'autoMerge is off for the repository';
    else if (pr.mergeSha === pr.headSha && pr.mergeReason) notMergedReason = pr.mergeReason;
    else notMergedReason = stage.detail;
  }
  return {
    pullRequest: pr.prNumber,
    url: pr.prUrl,
    rounds: countRevisions(db, repoId, prNumber),
    maxRevisions,
    reviews: (db.prepare('SELECT count(*) AS n FROM pr_reviews WHERE repo_id = ? AND pr_number = ?').get(repoId, prNumber) as { n: number }).n,
    verdict: pr.verdict,
    verdictSha: pr.verdictSha,
    headSha: pr.headSha,
    stage: stage.stage,
    detail: stage.detail,
    ready: pr.readyMarkedAt !== null,
    merged,
    mergeCommitSha: pr.mergeCommitSha,
    notMergedReason,
    ciRerun: pr.ciRerunSha && pr.ciRerunSha === pr.headSha ? { sha: pr.ciRerunSha, at: pr.ciRerunAt, checks: pr.ciRerunChecks } : null,
  };
}

function jobMessage(j: RunEventJobSummary, outcome: JobOutcome): string {
  switch (outcome) {
    case 'succeeded':
      if (j.prUrl) return `job ${j.jobId} succeeded: ${j.prUrl}`;
      if (j.publication === 'skipped') return `job ${j.jobId} succeeded; nothing was published (${j.publicationError ?? 'no commits'})`;
      return `job ${j.jobId} succeeded${j.branch ? ` on branch ${j.branch}` : ''}; publish is off for the repository`;
    case 'canceled':
      return `job ${j.jobId} was canceled before an agent started: ${j.error ?? 'no reason recorded'}`;
    case 'publish-failed':
      return `job ${j.jobId} succeeded but was not published: ${j.error}`;
    case 'superseded':
      if (j.error?.startsWith(SUPERSEDED_PREFIX)) return `job ${j.jobId} succeeded, but another run revised for the same review first; nothing was pushed (${j.error})`;
      return `job ${j.jobId} succeeded, but another run of this event published first; nothing was pushed (${j.error})`;
    case 'not-started':
      return `job ${j.jobId} did not start: ${j.error ?? 'nothing could start it before the run ended'}`;
    case 'deferred':
      return `job ${j.jobId} is waiting for a usage-limit cooldown: ${j.error ?? 'no agent of its pool can take it now'}`;
    case 'failed':
      return `job ${j.jobId} failed: ${j.error ?? 'no reason recorded'}`;
  }
}

/** `updraft run-event`: non-interactive, one event, then exit. Never prompts. */
export async function runEventCommand(ctx: CommandContext, opts: RunEventOptions, deps: RunEventDeps = defaultRunEventDeps): Promise<number> {
  const summary: RunEventSummary = {
    event: {
      name: opts.eventName ?? 'issues',
      action: null,
      deliveryId: opts.deliveryId ?? null,
      repository: null,
      repositoryId: null,
      issue: null,
      pullRequest: null,
      label: null,
      sender: null,
      eventId: null,
    },
    dispatched: false,
    resumed: false,
    outcome: 'error',
    reason: null,
    stateRestored: false,
    abandonedRun: null,
    deferredUntil: null,
    loop: null,
    message: '',
    jobId: null,
    workflowId: null,
    status: null,
    ...NO_JOB,
    drain: null,
    finalLook: null,
    exitCode: EXIT.FAILURE,
  };
  try {
    summary.exitCode = await runEvent(ctx, opts, deps, summary);
  } catch (err) {
    const described = describeError(err);
    summary.outcome = 'error';
    summary.error = redactGitHubSecrets(described.message);
    summary.message = summary.error;
    summary.exitCode = described.exitCode === EXIT.OK ? EXIT.FAILURE : described.exitCode;
  }
  if (opts.json) {
    println(ctx.out, JSON.stringify(summary));
    if (summary.outcome === 'error') println(ctx.err, `error: ${summary.message}`);
  } else if (summary.outcome === 'error') {
    println(ctx.err, `error: ${summary.message}`);
  } else {
    println(ctx.out, summary.outcome === 'nothing-to-do' ? `Nothing to do: ${summary.message}` : summary.message);
  }
  return summary.exitCode;
}

/** How long the end of the command waits for an assignment comment that is still being delivered. */
const ANNOUNCE_WAIT_MS = 10_000;

/** How often a run looks at its pull requests once more after its work ran out: each look after the first needs the one before to have queued something. */
const MAX_FINAL_LOOKS = 3;
/** With less of the deadline left than this, no further look is taken. */
const FINAL_LOOK_MIN_MS = 30_000;
/** How long a hold outlasts the run's deadline (the caller's merge of the state follows the run), and how long it lasts without one. */
const HOLD_GRACE_MS = 15 * 60_000;
const HOLD_WITHOUT_DEADLINE_MS = 6 * 3_600_000;

function loopMessage(l: RunEventLoopSummary): string {
  return `pull request #${l.pullRequest} is ${l.stage} after ${l.rounds} revision round(s) (${l.detail})`;
}

async function runEvent(ctx: CommandContext, opts: RunEventOptions, deps: RunEventDeps, summary: RunEventSummary): Promise<number> {
  const { paths } = ctx;
  const deadlineMs = parseDeadline(opts.deadlineMinutes);
  const payload = readEvent(opts.eventFile);
  const loaded = loadConfig(paths.configFile);
  const { config } = loaded;
  // The logger only calls write(); ctx.err is process.stderr outside tests. Nothing but the
  // summary goes to stdout.
  const log = deps
    .createLogger({ stream: ctx.err as NodeJS.WritableStream, file: join(paths.logDir, 'updraft.log') })
    .child(opts.deliveryId ? { delivery: opts.deliveryId } : {});
  for (const w of loaded.warnings) log.warn(`config: ${w.path}: ${w.message}`);
  if (config.execution.mode !== 'live') {
    throw new CliError(
      `run-event starts an agent, which needs execution.mode: live; it is ${config.execution.mode} in ${paths.configFile}. Nothing was started.`,
    );
  }

  const nothing = (reason: string, message: string): number => {
    summary.outcome = 'nothing-to-do';
    summary.reason = reason;
    summary.message = message;
    log.info('nothing to do', { reason, detail: message });
    return EXIT.OK;
  };

  const controller = new AbortController();
  const uninstall = deps.onShutdownSignal((signal) => {
    log.info('shutdown requested; stopping', { signal });
    controller.abort();
  });
  let db: Db | undefined;
  const announcements = new Set<Promise<void>>();
  /** This run, to the other runs that share the state database (src/db/holds.ts). */
  const holder = newId('wrk');
  let holding = false;
  try {
    const credentials: GitHubCredentials = ctx.createCredentials(config, { log: log.child({ component: 'github' }) });
    const api = await ctx.createApi({ log: log.child({ component: 'github' }), credentials });

    // 1. What the event is, and whether the poller's rules queue anything for it. Those rules
    // can run a triage, which caches its answer in the state database, so the database is
    // there for them, but opened only when something asks: an event with nothing to do must
    // not create state. A state database that is already there (a snapshot of the shared one,
    // docs/shared-state.md) is used as it is.
    const hadState = existsSync(paths.dbFile);
    const stateDb = (): Db => {
      if (db) return db;
      try {
        return (db = ctx.openDb(paths.dbFile));
      } catch (err) {
        if (err instanceof Error && /newer than this CLI supports/.test(err.message)) {
          throw new CliError(`${paths.dbFile}: ${err.message}. Nothing was started; handle the event with a newer updraft.`, EXIT.SCHEMA_TOO_NEW);
        }
        throw err;
      }
    };
    const decision = await decideWebhook(
      {
        api,
        config,
        get db() {
          return stateDb();
        },
        configDir: paths.configDir,
        now: ctx.now,
        log: log.child({ component: 'event' }),
        signal: controller.signal,
        ...(deps.eventLookup ? { eventLookup: deps.eventLookup } : {}),
      },
      { eventName: summary.event.name, deliveryId: opts.deliveryId ?? null, payload },
    );
    summary.event = decision.event;
    if (decision.dispatch === false) return nothing(decision.reason, decision.message);
    const { repo } = decision;
    const repoCfg = config.repositories[repo.fullName]!;
    // The schema requires checkoutPath in live mode; here it may name a directory that does not exist yet.
    if (!repoCfg.checkoutPath) throw new CliError(`repositories.${repo.fullName}.checkoutPath is not set; run-event creates the clone there`);
    const checkoutPath = resolve(paths.configDir, repoCfg.checkoutPath);

    // 2. What the state database already holds for the event. Everything from here on is
    // limited to the event's own jobs and pull requests (scope): the rest of the database
    // belongs to other events, whose machines may still be working.
    let scope: GuardedScope | undefined;
    /** A scope for this event that leaves alone what other runs hold (checkpoints make their work in flight visible here). */
    const newScope = (openDb: Db): GuardedScope => withoutForeignWork(createEventScope(openDb), foreignWork(openDb, holder, ctx.now()));
    const loopsOn = reviseActive(config, repoCfg) || reviewActive(config, repoCfg);
    const publishing = publishMode(repoCfg) !== 'none';
    const issueJobs = decision.dispatch === true ? decision.jobs : [];
    /** Event jobs the state database already has. */
    let known: Array<{ id: string; status: string; issueNumber: number }> = [];
    /**
     * Of those, the ones the database shows as `running` although no run that is still going
     * holds them: a machine checkpointed and vanished. Settled below, once GitHub was asked.
     */
    let abandoned: typeof known = [];
    /** Jobs of this event whose agent finished and whose publication a vanished run left mid-step. */
    let stalled: StalledPublication[] = [];

    /**
     * The pull request GitHub has for a job of the event is not on record: put its publication
     * back from what the API establishes (run-event-restore.ts). False when there is nothing to
     * restore: the pull request is closed or gone, it is on record after all, or neither loop is
     * on for the repository. Throws when a fact it needs cannot be established: better a loud
     * failure than a pull request nothing will ever act on.
     */
    const restore = async (openDb: () => Db, job: { id: string; issueNumber: number }, existing: ExistingWork, ensureJob: () => void): Promise<boolean> => {
      // The rows are what the revision and review loops read; without either, nothing misses them.
      if (existing.prNumber === null || !publishing || !loopsOn) return false;
      if (hadState) {
        syncRevisionPrs(stateDb(), repo.id);
        if (getRevisionPr(stateDb(), repo.id, existing.prNumber)) return false; // on record: nothing was lost
      }
      const answer = await readOwnPullRequest(api, repo, existing.prNumber);
      if (answer.kind === 'gone' || answer.kind === 'closed') return false;
      let missing: string | null = null;
      if (answer.kind === 'not-ours') missing = answer.why;
      else if (answer.own.pr.headRef !== existing.branch) missing = `its head branch is ${answer.own.pr.headRef}, not ${existing.branch}`;
      else if (answer.own.agent === null || !Object.hasOwn(config.agents, answer.own.agent)) missing = 'the agent of the run that opened it cannot be read from its body, or is no longer configured';
      if (missing !== null || answer.kind !== 'ours' || answer.own.agent === null) {
        summary.reason = 'state-not-restorable';
        throw new CliError(
          `pull request #${existing.prNumber} (${existing.prUrl}) exists for this event, the state database has no record of it, and it cannot be restored from GitHub: ${missing}. ` +
            'Nothing will act on reviews of it until it is on record. Merge the original run\'s state database if it was kept (docs/shared-state.md, "Recovery"), ' +
            'or close the pull request and apply the label again',
        );
      }
      ensureJob();
      try {
        restorePublication(openDb(), { repo, jobId: job.id, attempt: existing.attempt, own: { ...answer.own, agent: answer.own.agent }, mode: publishMode(repoCfg) === 'pr' ? 'pr' : 'draft-pr', deliveryId: opts.deliveryId ?? null, now: ctx.now });
      } catch (err) {
        summary.reason = 'state-not-restorable';
        throw new CliError(`pull request #${existing.prNumber} exists for this event, but its publication cannot be put back on record: ${errText(err)}`);
      }
      summary.stateRestored = true;
      Object.assign(summary, summarizeJob(openDb(), config, job.id));
      summary.loop = summarizeLoop(openDb(), config, repo.id, existing.prNumber);
      log.warn('restored a publication the state database had lost', { job: job.id, pr: existing.prNumber, run: answer.own.runId });
      return true;
    };
    const restoredMessage = (e: ExistingWork) => `${describeExisting(e)}; the state database had no record of it, and its publication was restored from the GitHub API, so reviews of it are acted on again`;

    if (decision.dispatch === 'poll-reviews') {
      const n = decision.pullRequest;
      // Not on record. Before this is "not ours", GitHub is asked: the run that opened a pull
      // request uploads its state long after the pull request exists, and an event that arrives
      // in between must not be answered "nothing to do" and forgotten.
      const notOnRecord = async (): Promise<number> => {
        const answer = await readOwnPullRequest(api, repo, n);
        if (answer.kind !== 'ours') {
          const why = answer.kind === 'not-ours' ? `GitHub says ${answer.why}` : answer.kind === 'closed' ? 'it is closed or merged' : 'GitHub has no such pull request';
          return nothing('pull-request-not-watched', `pull request #${n} of ${repo.fullName} is not one Updraft opened, as far as this state database knows, and ${why}; nothing acts on it`);
        }
        summary.outcome = 'state-pending';
        summary.reason = 'state-pending';
        summary.prNumber = answer.own.pr.number;
        summary.prUrl = answer.own.pr.htmlUrl;
        summary.message =
          `pull request #${n} of ${repo.fullName} was opened by Updraft (run ${answer.own.runId}), but this state database does not know it yet: ` +
          'the run that opened it has not saved its state. Nothing was done. Run this event again with a newer copy of the state database; ' +
          'if the state never arrives, deliver the issue event of that pull request again, which restores it';
        log.warn('the pull request is ours, and the state database does not know it yet', { pr: n, run: answer.own.runId });
        return EXIT.STATE_PENDING;
      };
      // Without state there is no record of any pull request Updraft opened.
      if (!hadState) return notOnRecord();
      const openDb = stateDb();
      syncRevisionPrs(openDb, repo.id);
      const watched = getRevisionPr(openDb, repo.id, n);
      if (!watched) return notOnRecord();
      if (watched.state !== 'open') return nothing('pull-request-closed', `pull request #${n} of ${repo.fullName} was closed or merged; it is no longer watched`);
      scope = newScope(openDb);
      scope.addPr(repo.id, n);
      log.info('event matched', { repo: repo.fullName, pr: n, action: decision.event.action });
      // The review poller, for this pull request: the API says what its reviews and its head
      // are, and the loop's own rules decide what that queues or cancels.
      const polled = await pollRepoReviews({ db: openDb, api, config }, repo, repoCfg, log.child({ component: 'reviews', repo: repo.fullName }), { only: n });
      // The CI step (ciFix) for this pull request, now: a check or status event says its checks
      // changed, and any other event is a moment to reconcile them, so a missed delivery or a run
      // that stopped early does not leave a failed head without its fix. Waiting costs nothing here.
      // Within the scope: a pull request another run still holds is that run's to take the step for.
      // The worker's clock, as for the review poller above and the publishers of the drain: the CI
      // step's wait is measured across both.
      const ciDeps = { db: openDb, config, api, log: log.child({ component: 'ci' }), scope };
      // Verified threads not resolved yet (#190): every event is a moment to try again.
      await resolveVerifiedThreadsAll({ ...ciDeps, log: log.child({ component: 'threads' }) }, undefined, { only: { repoId: repo.id, prNumber: n } });
      // The suggestion step first (review.suggestions): a head's checks are read once its suggestions are settled.
      const suggested = await evaluateSuggestionsAll({ ...ciDeps, log: log.child({ component: 'suggestions' }) }, undefined, { only: { repoId: repo.id, prNumber: n } });
      const ci = await evaluateCiAll(ciDeps, undefined, { only: { repoId: repo.id, prNumber: n }, force: true });
      if (ci.length) await postCiNotices(ciDeps);
      // A merge blocked on the checks of this head is looked at now: they may pass after a re-run
      // (by Updraft or by a person), and the merge goes ahead with no new commit. Not pending work,
      // so the drain below would not get to it.
      const requireCi = ciSettings(config, repoCfg) !== null;
      if (autoMergeMethod(config, repoCfg) && listResumableMerges(openDb, repo.id, { requireCi, requireSuggestions: suggestionsActive(config, repoCfg) }).some((pr) => pr.prNumber === n)) {
        await evaluateAutoMerges({ ...ciDeps, log: log.child({ component: 'merge' }) }, undefined, { only: { repoId: repo.id, prNumber: n } });
        if (getLoopPr(openDb, repo.id, n)?.mergeState === 'merged') {
          summary.loop = summarizeLoop(openDb, config, repo.id, n);
          return nothing('pull-request-closed', `pull request #${n} of ${repo.fullName} was merged by Updraft: its checks pass now on the head whose merge was blocked on them`);
        }
      }
      const ciQueued = ci.filter((r) => r.status === 'fixing').length;
      const suggestionsQueued = suggested.filter((r) => r.status === 'fixing').length;
      summary.dispatched = (polled?.revisionsQueued ?? 0) + (polled?.reviewsQueued ?? 0) + ciQueued + suggestionsQueued > 0;
      // What it queued is this run's own, also on a pull request another run still holds.
      if (summary.dispatched) scope.engage();
      summary.loop = summarizeLoop(openDb, config, repo.id, n);
      if (nothingPending(pendingWork(openDb, config, scope))) {
        if (getRevisionPr(openDb, repo.id, n)?.state !== 'open') {
          return nothing('pull-request-closed', `pull request #${n} of ${repo.fullName} was closed or merged; ${polled?.jobsCanceled ?? 0} queued job(s) for it were canceled`);
        }
        return nothing('no-new-work', `nothing on pull request #${n} of ${repo.fullName} asks for work: no new change request by an allowed actor, and no head commit without a review`);
      }
      scope.engage();
      summary.resumed = !summary.dispatched;
    } else {
      log.info('event matched', { repo: repo.fullName, issue: decision.event.issue, event: decision.event.eventId, jobs: issueJobs.map((j) => j.id) });
      if (hadState) {
        const openDb = stateDb();
        known = issueJobs.flatMap((j) => {
          const found = getJob(openDb, j.id);
          return found ? [{ id: found.id, status: found.status, issueNumber: found.issueNumber }] : [];
        });
        // --retry: what `updraft retry` does to each job that ended without its work, before the
        // duplicate check below sees it. A job that cannot be requeued (held for a human) stays as it is.
        if (opts.retry) {
          known = known.map((k) => {
            if (!(RETRYABLE as readonly string[]).includes(k.status)) return k;
            try {
              const requeued = retryJob(openDb, k.id, ctx.now);
              log.info('requeued a job of the event', { job: k.id, was: k.status });
              return { ...k, status: requeued.status };
            } catch (err) {
              log.warn('could not requeue a job of the event', { job: k.id, error: err instanceof Error ? err.message : String(err) });
              return k;
            }
          });
        }
      }
      if (known.length) {
        const openDb = stateDb();
        scope = newScope(openDb);
        for (const j of known) scope.addJob(j.id);
        const mine = scope;
        // A published head whose reviewer job was never queued is work that is left, too.
        if (reviewsEnabled(config)) scheduleAllReviews(openDb, config, undefined, (pr) => mine.pr(pr.repoId, pr.prNumber));
        const left = !nothingPending(pendingWork(openDb, config, scope));
        // Never while a live hold covers the job: that run is, as far as anyone can know, at work.
        abandoned = known.filter((k) => k.status === 'running' && !mine.heldByAnother(k.id));
        stalled = known.flatMap((k) => {
          const found = k.status === 'succeeded' && !mine.heldByAnother(k.id) ? findStalledPublication(openDb, k.id) : null;
          return found ? [found] : [];
        });
        if (known.length === issueJobs.length && !left) {
          // A job that got as far as an agent and has no publication on record: a checkpoint
          // carried it while its run was going, and that run's end was never saved. If GitHub
          // has its pull request, the publication is restored; another run's live work is left.
          const published = openDb.prepare("SELECT 1 AS x FROM publications WHERE job_id = ? AND state IN ('published', 'skipped')");
          for (const k of known) {
            if (!publishing || !['running', 'interrupted', 'succeeded'].includes(k.status) || mine.heldByAnother(k.id) || published.get(k.id)) continue;
            const existing = await findExistingPullRequest({ api, repo, job: k });
            if (existing && (await restore(() => openDb, k, existing, () => {}))) return nothing('already-handled', restoredMessage(existing));
          }
          if (!abandoned.length && !stalled.length) {
            const pr = scope.prs()[0];
            if (pr) summary.loop = summarizeLoop(openDb, config, pr.repoId, pr.prNumber);
            const held = known.some((j) => mine.heldByAnother(j.id));
            return nothing(
              'duplicate-delivery',
              `this state database already has the job for this event, and ${held ? 'another run that is still going is working on it' : 'nothing of it is left to do'} (${known.map((j) => `${j.id}: ${j.status}`).join(', ')})`,
            );
          }
        }
        summary.resumed = left;
      }
    }

    // 3. The clone, and how the worker's own git commands reach GitHub from it.
    const clone = await ensureClone({
      checkoutPath,
      cloneUrl: deps.cloneUrl(repo.fullName),
      // Reftable only when every agent's git is the host's one (see cloneRefFormat).
      refFormat: cloneRefFormat(config.agents),
      ...(deps.executor?.git ? { git: deps.executor.git } : {}),
    });
    if (clone.created) log.info('created the clone', { path: checkoutPath });
    // Agents' git gets no automatic gc in a clone the worker made (ensureClone); a clone that
    // outlives one event gets it here, before this event's run, at most once a day.
    else if (clone.managed) {
      const gc = await housekeepManagedClone({ checkoutPath, hooksPath: join(paths.dataDir, 'no-hooks'), now: ctx.now, ...(deps.executor?.git ? { git: deps.executor.git } : {}) });
      if (gc.ran || gc.why.includes('failed')) log.info('housekeeping of the clone', { path: checkoutPath, ran: gc.ran, detail: gc.why });
    }
    const withWorkerCredentials = clone.managed || opts.workerGitCredentials === true;
    const local: GitOptions = { cwd: checkoutPath, ...(deps.executor?.git ? { git: deps.executor.git } : {}) };
    const selection = selectRepoRemote(await listRemotes(local), repo.fullName, repoCfg.remote);
    if (!selection.ok) throw new CliError(`${checkoutPath}: ${selection.error}`);
    const remote = selection.remote;
    const networkGit = async (): Promise<NetworkGit | null> =>
      withWorkerCredentials
        ? workerNetworkGit({
            base: ctx.env,
            remoteUrl: remote.url,
            repoFullName: repo.fullName,
            token: (name) => credentials.token(name),
            hooksPath: join(paths.dataDir, 'no-hooks'),
          })
        : null;
    const net = await networkGit();

    const fresh = issueJobs.filter((j) => !known.some((k) => k.id === j.id));
    /** Jobs GitHub was just asked about: step 4 does not ask again. */
    const asked = new Set<string>();
    // 3b. A job of this event that a vanished run left `running` (docs/run-event.md, "An
    // abandoned run"). GitHub first: work of that run that got there is not done twice. Then the
    // run is closed, as the final merge of its database would have closed it, and where nothing
    // of it exists this delivery is the retry.
    for (const k of abandoned) {
      const openDb = stateDb();
      let existing: ExistingWork | null;
      try {
        existing = await findExistingWork({ api, repo, job: k, checkoutPath, remote: remote.name, net: { ...local, signal: controller.signal, ...(net ? { env: net.env } : {}) } });
      } catch (err) {
        throw new CliError(`could not check whether the event was already handled: ${net ? net.redact(errText(err)) : errText(err)}`);
      }
      asked.add(k.id);
      if (existing && (await restore(() => openDb, k, existing, () => {}))) return nothing('already-handled', restoredMessage(existing));
      const heldUntil = holdEnd(openDb, k.id);
      const attempts = getJob(openDb, k.id)?.attempts ?? 0;
      const closed = settleAbandonedJob(openDb, k.id, ctx.now);
      k.status = closed.status;
      const what = `the state database had job ${k.id} as running under a run that is gone${closed.runId ? ` (${closed.runId})` : ''}: its hold ${heldUntil ? `ended ${heldUntil}` : 'is not on record'}, so the run was closed as ${closed.settled}`;
      const report = (resumed: boolean, detail: string) => {
        summary.abandonedRun = { jobId: k.id, runId: closed.runId, heldUntil, settled: closed.settled, resumed, existingBranch: existing?.branch ?? null, detail };
        log.warn('settled a run that checkpointed and vanished', { job: k.id, run: closed.runId, heldUntil, resumed, ...(existing ? { branch: existing.branch } : {}) });
        Object.assign(summary, summarizeJob(openDb, config, k.id));
      };
      if (existing) {
        // Its branch (or a pull request nothing could be restored from) is on GitHub: running the
        // job again would leave two results. The job is `interrupted` now, which `updraft retry` takes.
        const detail =
          existing.prNumber !== null
            ? `${what}; ${describeExisting(existing)}, so nothing was started`
            : `${what}; the branch ${existing.branch} is on GitHub for this event (at ${existing.sha?.slice(0, 12)}) with no pull request, so nothing was started. ` +
              `To run the job again: delete that branch, "updraft retry ${k.id}" on a copy of the shared state database, and deliver the event again`;
        report(false, detail);
        return nothing('already-handled', detail);
      }
      if (closed.status === 'interrupted') {
        // The next attempt's branch must be one the checks above know (branchNames).
        let refusal: string | null = attempts >= MAX_START_FAILURES ? `the job has had ${attempts} attempts, and a redelivery starts no more than ${MAX_START_FAILURES}` : null;
        if (refusal === null) {
          try {
            requeueAbandonedJob(openDb, k.id, `requeued by a redelivery of its event${opts.deliveryId ? ` (${opts.deliveryId})` : ''}: the run that had it is gone`, ctx.now);
          } catch (err) {
            refusal = errText(err);
          }
        }
        if (refusal !== null) {
          const detail = `${what}; nothing was started: ${refusal}. "updraft retry ${k.id}" on a copy of the shared state database, then another delivery of the event, runs it again`;
          report(false, detail);
          return nothing('duplicate-delivery', detail);
        }
        k.status = 'queued';
      }
      // Queued again (requeued here, or released because the run was only ever claimed): this run does it.
      report(k.status === 'queued', `${what}; nothing of it is on GitHub, so this delivery runs the job as its next attempt`);
      summary.resumed = true;
    }
    // 3c. A job whose agent finished and whose publication a vanished run left mid-step (it was
    // checkpointed as `succeeded`, publishing, with no pull request; docs/run-event.md, "An
    // abandoned run"). GitHub decides: its branch at exactly the commit the run ended on is
    // published from here; no branch means the commits died with the machine and the job runs
    // again; any other commit there cannot be vouched for and is left to a person.
    for (const s of stalled) {
      const openDb = stateDb();
      const k = known.find((j) => j.id === s.jobId)!;
      let existing: ExistingWork | null;
      try {
        existing = await findExistingWork({ api, repo, job: k, checkoutPath, remote: remote.name, net: { ...local, signal: controller.signal, ...(net ? { env: net.env } : {}) } });
      } catch (err) {
        throw new CliError(`could not check whether the event was already handled: ${net ? net.redact(errText(err)) : errText(err)}`);
      }
      asked.add(k.id);
      if (existing?.prNumber != null) {
        // A pull request the restore above could not take as this run's: its own error said why.
        throw new CliError(`pull request #${existing.prNumber} exists for job ${k.id}, whose publication was left mid-step; nothing was changed`);
      }
      const what = `the state database had job ${k.id} as succeeded with its publication left mid-step by a run that is gone (${s.runId})`;
      const report = (resumed: boolean, detail: string) => {
        summary.abandonedRun = { jobId: k.id, runId: s.runId, heldUntil: holdEnd(openDb, k.id), settled: 'publication', resumed, existingBranch: existing?.branch ?? null, detail };
        log.warn('took over a publication a vanished run left mid-step', { job: k.id, run: s.runId, resumed, ...(existing ? { branch: existing.branch } : {}) });
        Object.assign(summary, summarizeJob(openDb, config, k.id));
      };
      if (existing && s.endedSha && existing.branch === s.branch && existing.sha === s.endedSha) {
        // Exactly what the run ended on: bring the branch back into this clone, and let the
        // publisher (which publishes only from it) find it already pushed and open the PR.
        const branchRef = `refs/heads/${s.branch}`;
        await withCheckoutLock(checkoutPath, async () => {
          await runGit(['fetch', '--no-tags', '--quiet', remote.name, `+${branchRef}:${branchRef}`], { ...local, signal: controller.signal, ...(net ? { env: net.env } : {}) });
          const fetched = (await runGit(['rev-parse', '--verify', '--quiet', `${branchRef}^{commit}`], local)).stdout.trim();
          if (fetched !== s.endedSha) throw new CliError(`fetched ${s.branch} at ${fetched.slice(0, 12)}, not at ${s.endedSha!.slice(0, 12)} where run ${s.runId} ended; nothing was published`);
        });
        resumeStalledPublication(openDb, s.runId, `resumed by a redelivery of its event${opts.deliveryId ? ` (${opts.deliveryId})` : ''}: the run that was publishing is gone, and its branch is on GitHub at the commit it ended on`, ctx.now);
        report(true, `${what}; its branch ${s.branch} is on GitHub at ${s.endedSha.slice(0, 12)}, the commit the run ended on, so this delivery opens its pull request (no agent runs again)`);
        scope?.engage();
        summary.resumed = true;
        continue;
      }
      if (existing) {
        const detail =
          `${what}; its branch ${existing.branch} is on GitHub at ${existing.sha?.slice(0, 12)}, ` +
          (s.endedSha ? `not at ${s.endedSha.slice(0, 12)} where the run ended,` : 'and the run recorded no commit it ended on,') +
          ` so nothing can be published for it. The job is now failed. To run it again: delete that branch, "updraft retry ${k.id}" on a copy of the shared state database, and deliver the event again`;
        failStalledPublication(openDb, s, `not published: ${detail}`, ctx.now);
        report(false, detail);
        summary.reason = 'publication-not-recoverable';
        throw new CliError(detail);
      }
      // Nothing on GitHub: the commits died with the machine. The delivery is the retry.
      failStalledPublication(openDb, s, 'not published: the run that was publishing is gone, and its commits never reached GitHub', ctx.now);
      const attempts = getJob(openDb, k.id)?.attempts ?? 0;
      let refusal: string | null = attempts >= MAX_START_FAILURES ? `the job has had ${attempts} attempts, and a redelivery starts no more than ${MAX_START_FAILURES}` : null;
      if (refusal === null) {
        try {
          requeueAbandonedJob(openDb, k.id, `requeued by a redelivery of its event${opts.deliveryId ? ` (${opts.deliveryId})` : ''}: the run that was publishing it is gone, and its commits never reached GitHub`, ctx.now);
        } catch (err) {
          refusal = errText(err);
        }
      }
      if (refusal !== null) {
        const detail = `${what}; its commits never reached GitHub and nothing was started: ${refusal}. "updraft retry ${k.id}" on a copy of the shared state database, then another delivery of the event, runs it again`;
        report(false, detail);
        return nothing('duplicate-delivery', detail);
      }
      k.status = 'queued';
      report(true, `${what}; its commits never reached GitHub, so this delivery runs the job as its next attempt`);
      summary.resumed = true;
    }
    if (decision.dispatch === true) {
      // 4. Was this event already handled by a run whose state this one has not seen? Only
      // GitHub can say. Asked for the jobs that have not started: new ones, and ones an earlier
      // run left queued. An event that was leaves no state behind.
      const unstarted = [...fresh.map((j) => ({ id: j.id, issueNumber: j.issueNumber })), ...known.filter((k) => k.status === 'queued' && !asked.has(k.id) && (scope?.job(k.id) ?? true))];
      for (const job of unstarted) {
        let existing: ExistingWork | null;
        try {
          existing = await findExistingWork({ api, repo, job, checkoutPath, remote: remote.name, net: { ...local, signal: controller.signal, ...(net ? { env: net.env } : {}) } });
        } catch (err) {
          throw new CliError(`could not check whether the event was already handled: ${net ? net.redact(errText(err)) : errText(err)}`);
        }
        if (!existing) continue;
        // The pull request is there and the state database has nothing of it: the run that opened
        // it never saved its state. Put the publication back, so that reviews are acted on again.
        const newJob = fresh.find((j) => j.id === job.id);
        const queueIt = () => {
          if (newJob) commitPollBatch(stateDb(), { repoId: repo.id, fullName: repo.fullName, lastEventId: decision.applied.id, lastEventCreatedAt: decision.applied.createdAt, etag: null, jobs: [newJob], now: ctx.now });
        };
        if (await restore(stateDb, job, existing, queueIt)) {
          for (const k of known) if (k.status === 'queued' && k.id !== job.id) cancelQueuedJob(stateDb(), k.id, describeExisting(existing));
          return nothing('already-handled', restoredMessage(existing));
        }
        // A queued job in the state database for work that is on GitHub already must not run later either.
        for (const k of known) if (k.status === 'queued') cancelQueuedJob(stateDb(), k.id, describeExisting(existing));
        return nothing('already-handled', describeExisting(existing));
      }
    }

    const openDb = stateDb();
    scope ??= newScope(openDb);
    if (decision.dispatch === true) {
      // 5. Queue it, under ids any other run of this event would derive too.
      const inserted = fresh.length
        ? commitPollBatch(openDb, {
            repoId: repo.id,
            fullName: repo.fullName,
            lastEventId: decision.applied.id,
            lastEventCreatedAt: decision.applied.createdAt,
            etag: null,
            jobs: fresh,
            now: ctx.now,
          })
        : [];
      if (!inserted.length && !known.length) {
        return nothing('duplicate-delivery', `this state database already had a job for this event and pruned it (${issueJobs.map((j) => j.id).join(', ')})`);
      }
      summary.dispatched = inserted.length > 0;
      for (const j of inserted) {
        scope.addJob(j.id);
        log.info('job queued', { job: j.id, issue: j.issueNumber, workflow: j.workflowId, pool: j.pool, event: j.eventId });
      }
      if (summary.resumed) log.info('continuing work an earlier run of this event left', { jobs: known.map((j) => `${j.id}: ${j.status}`) });
    }
    /** The jobs the summary describes: the event's own, or for a pull request event what is queued for it now. */
    const eventJobIds =
      decision.dispatch === true
        ? issueJobs.map((j) => j.id).filter((id) => getJob(openDb, id) !== null)
        : pendingWork(openDb, config, scope).queued.map((j) => j.id);
    // Jobs that had reached an end before this run did anything: whatever else is in scope when
    // the run ends is work that followed from the event in this run (a reviewer run, a revision).
    const settledBefore = new Set((openDb.prepare("SELECT id FROM jobs WHERE status IN ('succeeded', 'failed', 'interrupted', 'canceled')").all() as Array<{ id: string }>).map((r) => r.id));
    // Tell the other runs that share this database what this one is working on: a checkpoint
    // shows them its rows while they are still in flight.
    const holdUntil = new Date(ctx.now() + (deadlineMs ?? HOLD_WITHOUT_DEADLINE_MS) + HOLD_GRACE_MS).toISOString();
    const hold = { holder, delivery: opts.deliveryId ?? null, until: holdUntil };
    if (decision.dispatch === true) for (const id of eventJobIds) putHold(openDb, { job: id }, hold);
    else putHold(openDb, { pr: { repoId: repo.id, prNumber: decision.pullRequest } }, hold);
    holding = true;

    // 6. Drain: the worker of `updraft start`, wired as it is there, until the event's work is done.
    const eventScope = scope;
    const consoleContext = consoleContextFromEnv(process.env);
    const publishDeps = (component: string): PublishDeps => ({
      db: openDb,
      config,
      paths,
      api,
      log: log.child({ component }),
      token: (repoFullName) => credentials.token(repoFullName, { fresh: true }),
      workerKind: credentials.kind,
      env: ctx.env,
      scope: eventScope,
      claimReviews: true,
      console: consoleContext,
    });
    const publication = publicationEnabled(config) ? createPublisher(publishDeps('publish')) : undefined;
    const revising = revisionsEnabled(config) ? createRevisionPublisher(publishDeps('revision'), publication) : publication;
    const publisher = reviewsEnabled(config) ? createReviewLoopPublisher(publishDeps('review'), revising) : revising;
    // The worker does not wait for an assignment comment; a process that is about to exit has to.
    const announcer = createAssignmentCommenter({ db: openDb, config, api, log: log.child({ component: 'assignment-comment' }), console: consoleContext });
    const assignmentCommenter: AssignmentCommenter = {
      announce(job, run, signal) {
        const p: Promise<void> = announcer.announce(job, run, signal).finally(() => announcements.delete(p));
        announcements.add(p);
        return p;
      },
      ended: (job, run, signal, why) => announcer.ended?.(job, run, signal, why) ?? Promise.resolve(),
      finished: (job, run, signal) => announcer.finished?.(job, run, signal) ?? Promise.resolve(),
    };
    const appAuth = credentials.app;
    const startedAt = Date.now();
    const drain = (timeLeftMs: number | undefined): Promise<DrainResult> =>
      drainQueue(
        {
          db: openDb,
          config,
          paths,
          log: log.child({ component: 'worker' }),
          checkDispatchable: async (job) => {
            // Another machine may have revised for this review already, from a state this run never saw: GitHub knows.
            const elsewhere = await revisionAnsweredElsewhere(api, job);
            return elsewhere ? { ok: false, reason: elsewhere } : checkJobDispatchable({ api, config, db: openDb }, job);
          },
          signal: controller.signal,
          executor: createExecutor(config, {
            ...deps.executor,
            ...(appAuth && config.github?.app?.commitAsApp ? { commitIdentity: (repoFullName: string) => appCommitIdentity(appAuth, repoFullName) } : {}),
            networkGit,
          }),
          ...(publisher ? { publisher } : {}),
          assignmentCommenter,
          ...(failureCommentsEnabled(config)
            ? { failureCommenter: createFailureCommenter({ db: openDb, config, paths, api, log: log.child({ component: 'failure-comment' }), scope: eventScope }) }
            : {}),
        },
        { ...deps.drain, scope: eventScope, ...(timeLeftMs !== undefined ? { deadlineMs: timeLeftMs } : {}), ...(deps.runDaemon ? { runDaemon: deps.runDaemon } : {}) },
      );
    let drained = await drain(deadlineMs);

    // 6b. The last look. A person's review that was submitted while the agents of this run were
    // at work was delivered to a machine that could not know the pull request yet; this run can,
    // so before it ends it reads its open pull requests once more, with the review poller, and
    // runs what that queues. A further look needs the one before to have queued something, so
    // this ends by itself; the deadline bounds it like everything else.
    if (loopsOn) {
      const look: RunEventFinalLook = { looks: 0, queued: 0, knownElsewhere: 0, error: null };
      for (let i = 0; i < MAX_FINAL_LOOKS; i++) {
        if (drained.ended === 'deadline' || drained.ended === 'stopped' || controller.signal.aborted) break;
        const timeLeftMs = deadlineMs === undefined ? undefined : deadlineMs - (Date.now() - startedAt);
        if (timeLeftMs !== undefined && timeLeftMs < FINAL_LOOK_MIN_MS) break;
        syncRevisionPrs(openDb, repo.id);
        const open = eventScope.prs().filter((p) => p.repoId === repo.id && getRevisionPr(openDb, p.repoId, p.prNumber)?.state === 'open' && getLoopPr(openDb, p.repoId, p.prNumber)?.mergeState !== 'merged');
        if (!open.length) break;
        summary.finalLook = look;
        let queued = 0;
        try {
          for (const p of open) {
            // What another run has decided about this pull request's reviews since this run's
            // snapshot, where the caller can say: read after GitHub was, so as late as possible.
            const sharedState = opts.sharedState;
            const beforeIngest =
              sharedState === undefined
                ? undefined
                : (prNumber: number) => {
                    const known = adoptReviewRequests(openDb, resolve(sharedState), p.repoId, prNumber);
                    look.knownElsewhere += known.adopted;
                    if (known.skipped) log.warn('--shared-state was not read', { file: sharedState, reason: known.skipped });
                    else if (known.adopted) log.info('reviews another run has on record are left to it', { pr: prNumber, reviews: known.adopted });
                  };
            const polled = await pollRepoReviews({ db: openDb, api, config }, repo, repoCfg, log.child({ component: 'reviews', repo: repo.fullName }), { only: p.prNumber, ...(beforeIngest ? { beforeIngest } : {}) });
            queued += (polled?.revisionsQueued ?? 0) + (polled?.reviewsQueued ?? 0);
          }
        } catch (err) {
          look.error = redactGitHubSecrets(errText(err));
          log.warn('the last look at the pull request failed; a review submitted during this run is left to its own delivery', { error: look.error });
          break;
        }
        look.looks++;
        look.queued += queued;
        // Queued behind a cooldown: it stays queued, as the rest does.
        if (queued === 0 || drained.ended === 'deferred') break;
        log.info('the last look found new work on the pull request; running it', { queued });
        eventScope.engage();
        drained = await drain(timeLeftMs);
      }
    }
    summary.drain = drained.ended;
    if (announcements.size) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.allSettled([...announcements]), new Promise<void>((r) => (timer = setTimeout(r, ANNOUNCE_WAIT_MS)))]);
      clearTimeout(timer);
    }

    // 7. What became of it.
    const deferred = drained.ended === 'deferred';
    const jobs = eventJobIds.map((id) => summarizeJob(openDb, config, id));
    /** A revision that gave way to another run's for the same review: it succeeded, and what it made was not pushed. */
    const gaveWay = (j: RunEventJobSummary) => j.status === 'succeeded' && j.publication === 'skipped' && (j.publicationError?.startsWith(SUPERSEDED_PREFIX) ?? false);
    const outcomeOf = (j: RunEventJobSummary): JobOutcome => {
      if (deferred && j.status === 'queued') return 'deferred';
      if (!gaveWay(j)) return jobOutcome(j);
      j.error = j.publicationError;
      return 'superseded';
    };
    const outcomes = jobs.map(outcomeOf);
    // What followed from the event in this run counts as much as the event's own job: a reviewer
    // run that failed, a revision that was not pushed. (A follow-on job that was canceled is not
    // a failure: its pull request was closed, or its review withdrawn.)
    const followOn: RunEventFollowOnJob[] = (openDb.prepare('SELECT id FROM jobs ORDER BY created_at, rowid').all() as Array<{ id: string }>)
      .filter((r) => !settledBefore.has(r.id) && !eventJobIds.includes(r.id) && eventScope.job(r.id))
      .map((r) => {
        const j = summarizeJob(openDb, config, r.id);
        const job = getJob(openDb, r.id);
        const kind = job && reviewOf(job) ? 'review' : job && revisionOf(job) ? 'revision' : 'other';
        const outcome = outcomeOf(j);
        return { ...j, kind, outcome };
      });
    // A publication that never pushed, while GitHub has a branch or PR for the event: two runs of
    // the event raced, and the other one's create-only push won.
    for (const [i, j] of jobs.entries()) {
      if (decision.dispatch !== true || outcomes[i] !== 'publish-failed' || !j.runId || getPublication(openDb, j.runId)?.pushedAt) continue;
      const job = getJob(openDb, j.jobId);
      if (!job || reviewOf(job) || revisionOf(job)) continue;
      const other = await findExistingWork({ api, repo, job, checkoutPath, remote: remote.name, net: { ...local, ...(net ? { env: net.env } : {}) } }).catch(() => null);
      if (!other) continue;
      outcomes[i] = 'superseded';
      j.error = describeExisting(other);
      if (other.prUrl) Object.assign(j, { prNumber: other.prNumber, prUrl: other.prUrl });
    }
    const counted = [...outcomes, ...followOn.map((j) => j.outcome as JobOutcome).filter((o) => o !== 'canceled')];
    let worst: JobOutcome = OUTCOME_RANK.find((o) => counted.includes(o)) ?? 'succeeded';
    // The event's own job is done, and what follows it (a reviewer run, a revision) is what waits.
    if (deferred && (worst === 'succeeded' || worst === 'superseded' || worst === 'canceled')) worst = 'deferred';
    const first = jobs[0];
    if (first) Object.assign(summary, first);
    const loopPr = scope.prs()[0];
    summary.loop = loopPr ? summarizeLoop(openDb, config, loopPr.repoId, loopPr.prNumber) : null;
    summary.outcome = worst;
    const parts = jobs.map((j, i) => jobMessage(j, outcomes[i]!));
    for (const j of followOn) if (j.outcome !== 'succeeded' && j.outcome !== 'canceled') parts.push(`${j.kind === 'other' ? 'follow-on' : j.kind} ${jobMessage(j, j.outcome as JobOutcome)}`);
    if (summary.loop && (reviewsEnabled(config) || revisionsEnabled(config))) parts.push(loopMessage(summary.loop));
    summary.message = parts.join('; ') || 'nothing was left to run';
    if (drained.ended === 'deadline' || drained.ended === 'stopped') {
      summary.message += drained.ended === 'deadline' ? ` (stopped at the ${opts.deadlineMinutes}-minute deadline)` : ' (stopped by a signal)';
    }
    if (worst === 'canceled') summary.reason = 'canceled-before-start';
    if (worst === 'superseded') summary.reason = 'published-by-another-run';
    if (worst === 'deferred') {
      summary.reason = 'cooldown';
      summary.deferredUntil = drained.deferredUntil !== undefined ? new Date(drained.deferredUntil).toISOString() : null;
      summary.message += ` (a usage-limit cooldown holds the rest back${summary.deferredUntil ? ` until ${summary.deferredUntil}` : ''}; it stays queued, and delivering the event again after that continues it)`;
    }
    if (jobs.length > 1) summary.jobs = jobs;
    if (followOn.length) summary.followOnJobs = followOn;
    log.info('event handled', { outcome: worst, drain: drained.ended, jobs: jobs.map((j) => j.jobId), ...(summary.loop ? { pr: summary.loop.pullRequest, stage: summary.loop.stage } : {}) });
    if (worst === 'deferred') return EXIT.DEFERRED;
    return worst === 'succeeded' || worst === 'canceled' || worst === 'superseded' ? EXIT.OK : EXIT.FAILURE;
  } finally {
    uninstall();
    try {
      // The run is over: what it held is free for the next run, whatever became of it.
      if (holding && db) releaseHolds(db, holder, new Date(ctx.now()).toISOString());
    } catch {
      // the merge of this database releases what the run could not
    }
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}

