// `updraft run-event`: carry ONE GitHub webhook event through to the end, then exit.
// docs/run-event.md is the contract; this file is the wiring.
//
//   payload file -> decideWebhook (the poller's ingestion rules, from the API)
//                -> "already in this state database?" (shared between runs: docs/shared-state.md)
//                -> "already handled?" (GitHub, for runs that could not see each other's state)
//                -> the clone, created if missing
//                -> the queue, with a job id derived from the event; or, for a pull request
//                   event, the review poller (reviews.ts) for that pull request
//                -> drainQueue (runDaemon until the event's work is done: pre-start check, live
//                   executor, verification, publication, the review loop, auto-merge, failure
//                   comment), scoped to the event (src/worker/scope.ts)
//                -> one summary, one exit code
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config/io.js';
import { autoMergeMethod, DEFAULT_MAX_REVISIONS, publishMode, type UpdraftConfig } from '../config/schema.js';
import type { Db } from '../db/database.js';
import { getFailureComment } from '../db/failure-comments.js';
import { cancelQueuedJob, commitPollBatch } from '../db/ingest.js';
import { getLoopPr, prStage, scheduleAllReviews } from '../db/pr-reviews.js';
import { getPublication } from '../db/publications.js';
import { getJob, latestRunOfJob, MAX_START_FAILURES } from '../db/queue.js';
import { countRevisions, getRevisionPr, syncRevisionPrs } from '../db/revisions.js';
import { ensureClone, githubCloneUrl, workerNetworkGit, type NetworkGit } from '../git/clone.js';
import { listRemotes, runGit, selectRepoRemote, type GitOptions } from '../git/git.js';
import { jobBranchName, withCheckoutLock } from '../git/worktree.js';
import type { GitHubApi } from '../github/api.js';
import { redactGitHubSecrets } from '../github/app-auth.js';
import { appCommitIdentity, type GitHubCredentials } from '../github/credentials.js';
import { checkJobDispatchable } from '../poller/poller.js';
import { pollRepoReviews } from '../poller/reviews.js';
import { decideWebhook, type WebhookDeps, type WebhookEventInfo } from '../poller/webhook.js';
import { createAssignmentCommenter, type AssignmentCommenter } from '../publish/assignment-comment.js';
import { createFailureCommenter, failureCommentsEnabled } from '../publish/failure-comment.js';
import { createPublisher, publicationEnabled, type PublishDeps } from '../publish/publish.js';
import { createReviewLoopPublisher, reviewsEnabled } from '../publish/review.js';
import { createRevisionPublisher, revisionsEnabled } from '../publish/revision.js';
import { reviewOf, revisionOf, type RepoRef, type VerificationSummary } from '../types.js';
import { createLogger, type Logger, type LoggerOptions } from '../util/log.js';
import type { DaemonDeps } from '../worker/daemon.js';
import { drainQueue, type DrainEnd, type DrainOptions } from '../worker/drain.js';
import { findRepoConfig } from '../worker/executor.js';
import type { LiveExecutorOptions } from '../worker/live.js';
import { createExecutor } from '../worker/prepare-only.js';
import { createEventScope, nothingPending, pendingWork, type EventScope } from '../worker/scope.js';
import { println, type CommandContext } from './context.js';
import { CliError, describeError, EXIT } from './errors.js';
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
   * - succeeded: the job ran and, where publish is on, its result was published (or there was nothing to publish).
   * - canceled: the job was queued and the pre-start check canceled it before any agent started.
   * - failed: the agent run failed, could not start, or was interrupted.
   * - publish-failed: the run succeeded and its publication did not.
   * - superseded: the run succeeded, but another run of the same event published first; this
   *   run's commits were not pushed and nothing on GitHub was changed by it.
   * - not-started: the job was still queued when the drain ended.
   * - deferred: work of the event is queued behind a usage-limit cooldown that ends after this
   *   run would; it stays queued in the state database, and delivering the event again later
   *   continues it (`deferredUntil`).
   * - error: the command itself failed (configuration, GitHub, the event file).
   */
  outcome: 'nothing-to-do' | 'succeeded' | 'canceled' | 'superseded' | 'failed' | 'publish-failed' | 'not-started' | 'deferred' | 'error';
  /**
   * Why nothing was done (or nothing was published), as a code: a NothingToDoReason,
   * "already-handled", "duplicate-delivery", "pull-request-not-watched", "pull-request-closed",
   * "no-new-work", "canceled-before-start", "published-by-another-run" or "cooldown".
   */
  reason: string | null;
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
async function findExistingWork(o: {
  api: GitHubApi;
  repo: RepoRef;
  job: { id: string; issueNumber: number };
  checkoutPath: string;
  remote: string;
  net: GitOptions;
}): Promise<ExistingWork | null> {
  const names = Array.from({ length: MAX_START_FAILURES }, (_, i) => jobBranchName(o.job, i + 1));
  const owner = o.repo.fullName.split('/')[0]!;
  for (const branch of names) {
    const pulls = (await o.api.listPullRequestsForHead(o.repo, { headOwner: owner, head: branch })).filter(
      (p) => p.headRef === branch && (p.headRepoId === null || p.headRepoId === o.repo.id),
    );
    const pr = pulls.find((p) => p.state === 'open') ?? pulls[0];
    if (pr) return { branch, sha: null, prNumber: pr.number, prUrl: pr.htmlUrl };
  }
  const listed = (await withCheckoutLock(o.checkoutPath, () => runGit(['ls-remote', o.remote, ...names.map((n) => `refs/heads/${n}`)], o.net))).stdout;
  for (const line of listed.split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    const branch = names.find((n) => ref === `refs/heads/${n}`);
    if (sha && branch) return { branch, sha, prNumber: null, prUrl: null };
  }
  return null;
}

function describeExisting(e: ExistingWork): string {
  return e.prUrl
    ? `pull request #${e.prNumber} (${e.prUrl}) already exists for this event`
    : `the branch ${e.branch} already exists on GitHub for this event (at ${e.sha?.slice(0, 12)}), pushed by another run of it; ` +
        'if no pull request follows, delete the branch and redeliver the event';
}

function summarizeVerification(v: VerificationSummary | undefined): RunEventJobSummary['verification'] {
  if (!v) return null;
  return { passed: v.passed, commands: v.commands.map((c) => ({ command: c.command, status: c.status })) };
}

function summarizeJob(db: Db, config: UpdraftConfig, jobId: string): RunEventJobSummary {
  const job = getJob(db, jobId)!;
  const run = latestRunOfJob(db, jobId);
  // A revision run is pushed to its pull request and a reviewer run is posted on it: each has
  // its own record in place of a publication, reported in the publication fields.
  const loopPr = revisionOf(job)?.pullRequest ?? reviewOf(job)?.pullRequest;
  if (loopPr) {
    const table = revisionOf(job) ? 'revisions' : 'pr_reviews';
    const step = run ? (db.prepare(`SELECT state, error, head_sha FROM ${table} WHERE run_id = ?`).get(run.id) as { state: string; error: string | null; head_sha: string | null } | undefined) : undefined;
    const failed = job.status === 'succeeded' && step?.state === 'failed';
    return {
      jobId,
      workflowId: job.workflowId,
      status: job.status,
      runId: run?.id ?? null,
      agent: run?.agent ?? null,
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

type JobOutcome = Exclude<RunEventSummary['outcome'], 'nothing-to-do' | 'error'>;

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
  const stage = prStage(db, pr, maxRevisions);
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
    deferredUntil: null,
    loop: null,
    message: '',
    jobId: null,
    workflowId: null,
    status: null,
    ...NO_JOB,
    drain: null,
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
    let scope: EventScope | undefined;
    const issueJobs = decision.dispatch === true ? decision.jobs : [];
    /** Event jobs the state database already has. */
    let known: Array<{ id: string; status: string; issueNumber: number }> = [];
    if (decision.dispatch === 'poll-reviews') {
      const n = decision.pullRequest;
      const notWatched = () =>
        nothing('pull-request-not-watched', `pull request #${n} of ${repo.fullName} is not one Updraft opened, as far as this state database knows; nothing acts on it`);
      // Without state there is no record of any pull request Updraft opened.
      if (!hadState) return notWatched();
      const openDb = stateDb();
      syncRevisionPrs(openDb, repo.id);
      const watched = getRevisionPr(openDb, repo.id, n);
      if (!watched) return notWatched();
      if (watched.state !== 'open') return nothing('pull-request-closed', `pull request #${n} of ${repo.fullName} was closed or merged; it is no longer watched`);
      scope = createEventScope(openDb);
      scope.addPr(repo.id, n);
      log.info('event matched', { repo: repo.fullName, pr: n, action: decision.event.action });
      // The review poller, for this pull request: the API says what its reviews and its head
      // are, and the loop's own rules decide what that queues or cancels.
      const polled = await pollRepoReviews({ db: openDb, api, config }, repo, repoCfg, log.child({ component: 'reviews', repo: repo.fullName }), { only: n });
      summary.dispatched = (polled?.revisionsQueued ?? 0) + (polled?.reviewsQueued ?? 0) > 0;
      summary.loop = summarizeLoop(openDb, config, repo.id, n);
      if (nothingPending(pendingWork(openDb, config, scope))) {
        if (getRevisionPr(openDb, repo.id, n)?.state !== 'open') {
          return nothing('pull-request-closed', `pull request #${n} of ${repo.fullName} was closed or merged; ${polled?.jobsCanceled ?? 0} queued job(s) for it were canceled`);
        }
        return nothing('no-new-work', `nothing on pull request #${n} of ${repo.fullName} asks for work: no new change request by an allowed actor, and no head commit without a review`);
      }
      summary.resumed = !summary.dispatched;
    } else {
      log.info('event matched', { repo: repo.fullName, issue: decision.event.issue, event: decision.event.eventId, jobs: issueJobs.map((j) => j.id) });
      if (hadState) {
        const openDb = stateDb();
        known = issueJobs.flatMap((j) => {
          const found = getJob(openDb, j.id);
          return found ? [{ id: found.id, status: found.status, issueNumber: found.issueNumber }] : [];
        });
      }
      if (known.length) {
        const openDb = stateDb();
        scope = createEventScope(openDb);
        for (const j of known) scope.addJob(j.id);
        const mine = scope;
        // A published head whose reviewer job was never queued is work that is left, too.
        if (reviewsEnabled(config)) scheduleAllReviews(openDb, config, undefined, (pr) => mine.pr(pr.repoId, pr.prNumber));
        const left = !nothingPending(pendingWork(openDb, config, scope));
        if (known.length === issueJobs.length && !left) {
          const pr = scope.prs()[0];
          if (pr) summary.loop = summarizeLoop(openDb, config, pr.repoId, pr.prNumber);
          return nothing('duplicate-delivery', `this state database already has the job for this event, and nothing of it is left to do (${known.map((j) => `${j.id}: ${j.status}`).join(', ')})`);
        }
        summary.resumed = left;
      }
    }

    // 3. The clone, and how the worker's own git commands reach GitHub from it.
    const clone = await ensureClone({ checkoutPath, cloneUrl: deps.cloneUrl(repo.fullName), ...(deps.executor?.git ? { git: deps.executor.git } : {}) });
    if (clone.created) log.info('created the clone', { path: checkoutPath });
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
    if (decision.dispatch === true) {
      // 4. Was this event already handled by a run whose state this one has not seen? Only
      // GitHub can say. Asked for the jobs that have not started: new ones, and ones an earlier
      // run left queued. An event that was leaves no state behind.
      const unstarted = [...fresh.map((j) => ({ id: j.id, issueNumber: j.issueNumber })), ...known.filter((k) => k.status === 'queued')];
      for (const job of unstarted) {
        let existing: ExistingWork | null;
        try {
          existing = await findExistingWork({ api, repo, job, checkoutPath, remote: remote.name, net: { ...local, signal: controller.signal, ...(net ? { env: net.env } : {}) } });
        } catch (err) {
          throw new CliError(`could not check whether the event was already handled: ${net ? net.redact(errText(err)) : errText(err)}`);
        }
        if (!existing) continue;
        // A queued job in the state database for work that is on GitHub already must not run later either.
        for (const k of known) if (k.status === 'queued') cancelQueuedJob(stateDb(), k.id, describeExisting(existing));
        return nothing('already-handled', describeExisting(existing));
      }
    }

    const openDb = stateDb();
    scope ??= createEventScope(openDb);
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

    // 6. Drain: the worker of `updraft start`, wired as it is there, until the event's work is done.
    const eventScope = scope;
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
    });
    const publication = publicationEnabled(config) ? createPublisher(publishDeps('publish')) : undefined;
    const revising = revisionsEnabled(config) ? createRevisionPublisher(publishDeps('revision'), publication) : publication;
    const publisher = reviewsEnabled(config) ? createReviewLoopPublisher(publishDeps('review'), revising) : revising;
    // The worker does not wait for an assignment comment; a process that is about to exit has to.
    const announcer = createAssignmentCommenter({ db: openDb, config, api, log: log.child({ component: 'assignment-comment' }) });
    const assignmentCommenter: AssignmentCommenter = {
      announce(job, run, signal) {
        const p: Promise<void> = announcer.announce(job, run, signal).finally(() => announcements.delete(p));
        announcements.add(p);
        return p;
      },
    };
    const appAuth = credentials.app;
    const drained = await drainQueue(
      {
        db: openDb,
        config,
        paths,
        log: log.child({ component: 'worker' }),
        checkDispatchable: (job) => checkJobDispatchable({ api, config }, job),
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
      { ...deps.drain, scope: eventScope, ...(deadlineMs !== undefined ? { deadlineMs } : {}), ...(deps.runDaemon ? { runDaemon: deps.runDaemon } : {}) },
    );
    summary.drain = drained.ended;
    if (announcements.size) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.allSettled([...announcements]), new Promise<void>((r) => (timer = setTimeout(r, ANNOUNCE_WAIT_MS)))]);
      clearTimeout(timer);
    }

    // 7. What became of it.
    const deferred = drained.ended === 'deferred';
    const jobs = eventJobIds.map((id) => summarizeJob(openDb, config, id));
    const outcomes = jobs.map((j) => (deferred && j.status === 'queued' ? 'deferred' : jobOutcome(j)));
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
    let worst: JobOutcome = OUTCOME_RANK.find((o) => outcomes.includes(o)) ?? 'succeeded';
    // The event's own job is done, and what follows it (a reviewer run, a revision) is what waits.
    if (deferred && (worst === 'succeeded' || worst === 'superseded' || worst === 'canceled')) worst = 'deferred';
    const first = jobs[0];
    if (first) Object.assign(summary, first);
    const loopPr = scope.prs()[0];
    summary.loop = loopPr ? summarizeLoop(openDb, config, loopPr.repoId, loopPr.prNumber) : null;
    summary.outcome = worst;
    const parts = jobs.map((j, i) => jobMessage(j, outcomes[i]!));
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
    log.info('event handled', { outcome: worst, drain: drained.ended, jobs: jobs.map((j) => j.jobId), ...(summary.loop ? { pr: summary.loop.pullRequest, stage: summary.loop.stage } : {}) });
    if (worst === 'deferred') return EXIT.DEFERRED;
    return worst === 'succeeded' || worst === 'canceled' || worst === 'superseded' ? EXIT.OK : EXIT.FAILURE;
  } finally {
    uninstall();
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}

