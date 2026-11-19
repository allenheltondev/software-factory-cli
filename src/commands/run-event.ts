// `updraft run-event`: carry ONE GitHub webhook event through to the end, then exit.
// docs/run-event.md is the contract; this file is the wiring.
//
//   payload file -> decideWebhook (the poller's ingestion rules, from the API)
//                -> "already handled?" (GitHub is the only state shared between processes)
//                -> the clone, created if missing
//                -> the queue, with a job id derived from the event
//                -> drainQueue (runDaemon until the queue is empty: pre-start check, live
//                   executor, verification, publication, failure comment)
//                -> one summary, one exit code
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config/io.js';
import { publishMode, type UpdraftConfig } from '../config/schema.js';
import type { Db } from '../db/database.js';
import { getFailureComment } from '../db/failure-comments.js';
import { commitPollBatch } from '../db/ingest.js';
import { getPublication } from '../db/publications.js';
import { getJob, latestRunOfJob, MAX_START_FAILURES } from '../db/queue.js';
import { ensureClone, githubCloneUrl, workerNetworkGit, type NetworkGit } from '../git/clone.js';
import { listRemotes, runGit, selectRepoRemote, type GitOptions } from '../git/git.js';
import { jobBranchName, withCheckoutLock } from '../git/worktree.js';
import type { GitHubApi } from '../github/api.js';
import { redactGitHubSecrets } from '../github/app-auth.js';
import { appCommitIdentity, type GitHubCredentials } from '../github/credentials.js';
import { checkJobDispatchable } from '../poller/poller.js';
import { decideWebhook, type WebhookDeps, type WebhookEventInfo } from '../poller/webhook.js';
import { createFailureCommenter, failureCommentsEnabled } from '../publish/failure-comment.js';
import { createPublisher, publicationEnabled } from '../publish/publish.js';
import type { RepoRef, VerificationSummary } from '../types.js';
import { createLogger, type Logger, type LoggerOptions } from '../util/log.js';
import type { DaemonDeps } from '../worker/daemon.js';
import { drainQueue, type DrainEnd, type DrainOptions } from '../worker/drain.js';
import { findRepoConfig } from '../worker/executor.js';
import type { LiveExecutorOptions } from '../worker/live.js';
import { createExecutor } from '../worker/prepare-only.js';
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
  drain?: Omit<DrainOptions, 'runDaemon' | 'deadlineMs'>;
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

/**
 * What `updraft run-event --json` prints: one object, always, whatever happened.
 * `outcome` and `exitCode` say how it went; the job fields describe the event's job.
 */
export interface RunEventSummary extends Omit<RunEventJobSummary, 'jobId' | 'workflowId' | 'status'> {
  event: WebhookEventInfo;
  /** True when a job was queued for the event in this run. */
  dispatched: boolean;
  /**
   * - nothing-to-do: no job was queued (`reason` says why).
   * - succeeded: the job ran and, where publish is on, its result was published (or there was nothing to publish).
   * - canceled: the job was queued and the pre-start check canceled it before any agent started.
   * - failed: the agent run failed, could not start, or was interrupted.
   * - publish-failed: the run succeeded and its publication did not.
   * - superseded: the run succeeded, but another run of the same event published first; this
   *   run's commits were not pushed and nothing on GitHub was changed by it.
   * - not-started: the job was still queued when the drain ended.
   * - error: the command itself failed (configuration, GitHub, the event file).
   */
  outcome: 'nothing-to-do' | 'succeeded' | 'canceled' | 'superseded' | 'failed' | 'publish-failed' | 'not-started' | 'error';
  /**
   * Why nothing was done (or nothing was published), as a code: a NothingToDoReason,
   * "already-handled", "duplicate-delivery", "canceled-before-start" or "published-by-another-run".
   */
  reason: string | null;
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
const OUTCOME_RANK: JobOutcome[] = ['failed', 'publish-failed', 'not-started', 'succeeded', 'superseded', 'canceled'];

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
      label: null,
      sender: null,
      eventId: null,
    },
    dispatched: false,
    outcome: 'error',
    reason: null,
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
  try {
    const credentials: GitHubCredentials = ctx.createCredentials(config, { log: log.child({ component: 'github' }) });
    const api = await ctx.createApi({ log: log.child({ component: 'github' }), credentials });

    // 1. What the event is, and whether the poller's rules queue anything for it. Those rules
    // can run a triage, which caches its answer in the state database, so the database is
    // there for them, but opened only when something asks: an event with nothing to do must
    // not leave state behind.
    const stateDb = (): Db => (db ??= ctx.openDb(paths.dbFile));
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
    if (!decision.dispatch) return nothing(decision.reason, decision.message);
    const { repo } = decision;
    const repoCfg = config.repositories[repo.fullName]!;
    // The schema requires checkoutPath in live mode; here it may name a directory that does not exist yet.
    if (!repoCfg.checkoutPath) throw new CliError(`repositories.${repo.fullName}.checkoutPath is not set; run-event creates the clone there`);
    const checkoutPath = resolve(paths.configDir, repoCfg.checkoutPath);
    log.info('event matched', { repo: repo.fullName, issue: decision.event.issue, event: decision.event.eventId, jobs: decision.jobs.map((j) => j.id) });

    // 2. The clone, and how the worker's own git commands reach GitHub from it.
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

    // 3. Was this event already handled by another run of it? Only GitHub can say.
    const net = await networkGit();
    for (const job of decision.jobs) {
      let existing: ExistingWork | null;
      try {
        existing = await findExistingWork({ api, repo, job, checkoutPath, remote: remote.name, net: { ...local, signal: controller.signal, ...(net ? { env: net.env } : {}) } });
      } catch (err) {
        throw new CliError(`could not check whether the event was already handled: ${net ? net.redact(errText(err)) : errText(err)}`);
      }
      if (existing) return nothing('already-handled', describeExisting(existing));
    }

    // 4. Queue it, under ids any other run of this event would derive too.
    const openDb = stateDb();
    const inserted = commitPollBatch(openDb, {
      repoId: repo.id,
      fullName: repo.fullName,
      lastEventId: decision.applied.id,
      lastEventCreatedAt: decision.applied.createdAt,
      etag: null,
      jobs: decision.jobs,
      now: ctx.now,
    });
    if (!inserted.length) {
      return nothing('duplicate-delivery', `this state directory already has the job for this event (${decision.jobs.map((j) => j.id).join(', ')})`);
    }
    summary.dispatched = true;
    for (const j of inserted) log.info('job queued', { job: j.id, issue: j.issueNumber, workflow: j.workflowId, pool: j.pool, event: j.eventId });

    // 5. Drain: the worker of `updraft start`, until the queue is empty.
    const publisher = publicationEnabled(config)
      ? createPublisher({
          db: openDb,
          config,
          paths,
          api,
          log: log.child({ component: 'publish' }),
          token: (repoFullName) => credentials.token(repoFullName, { fresh: true }),
          workerKind: credentials.kind,
          env: ctx.env,
        })
      : undefined;
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
        ...(failureCommentsEnabled(config)
          ? { failureCommenter: createFailureCommenter({ db: openDb, config, paths, api, log: log.child({ component: 'failure-comment' }) }) }
          : {}),
      },
      { ...deps.drain, ...(deadlineMs !== undefined ? { deadlineMs } : {}), ...(deps.runDaemon ? { runDaemon: deps.runDaemon } : {}) },
    );
    summary.drain = drained.ended;

    // 6. What became of it.
    const jobs = inserted.map((j) => summarizeJob(openDb, config, j.id));
    const outcomes = jobs.map(jobOutcome);
    // A publication that never pushed, while GitHub has a branch or PR for the event: two runs of
    // the event raced, and the other one's create-only push won.
    for (const [i, j] of jobs.entries()) {
      if (outcomes[i] !== 'publish-failed' || !j.runId || getPublication(openDb, j.runId)?.pushedAt) continue;
      const job = inserted.find((x) => x.id === j.jobId)!;
      const other = await findExistingWork({ api, repo, job, checkoutPath, remote: remote.name, net: { ...local, ...(net ? { env: net.env } : {}) } }).catch(() => null);
      if (!other) continue;
      outcomes[i] = 'superseded';
      j.error = describeExisting(other);
      if (other.prUrl) Object.assign(j, { prNumber: other.prNumber, prUrl: other.prUrl });
    }
    const worst = OUTCOME_RANK.find((o) => outcomes.includes(o)) ?? 'failed';
    const first = jobs[0]!;
    Object.assign(summary, first);
    summary.outcome = worst;
    summary.message = jobs.map((j, i) => jobMessage(j, outcomes[i]!)).join('; ');
    if (drained.ended === 'deadline' || drained.ended === 'stopped') {
      summary.message += drained.ended === 'deadline' ? ` (stopped at the ${opts.deadlineMinutes}-minute deadline)` : ' (stopped by a signal)';
    }
    if (worst === 'canceled') summary.reason = 'canceled-before-start';
    if (worst === 'superseded') summary.reason = 'published-by-another-run';
    if (jobs.length > 1) summary.jobs = jobs;
    log.info('event handled', { outcome: worst, drain: drained.ended, jobs: jobs.map((j) => j.jobId) });
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
