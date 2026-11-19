// OWNER: queue/worker workstream. The long-running worker behind `updraft start`.
import { hostname as osHostname } from 'node:os';
import type { UpdraftConfig } from '../config/schema.js';
import { recordError, type Db } from '../db/database.js';
import {
  CANCELED_BY_USER,
  cancelClaim,
  claimNextJob,
  finishRun,
  getJob,
  getRun,
  heartbeatRun,
  holdsWorkerLock,
  listCancelRequestedRuns,
  markExecutionStarted,
  releaseClaim,
  setRunProcess,
  setRunSummary,
  WorkerLockLostError,
  type Claim,
  type FinishedRun,
} from '../db/queue.js';
import { syncPublishSettings } from '../db/publish-settings.js';
import type { UpdraftPaths } from '../paths.js';
import type { AssignmentCommenter } from '../publish/assignment-comment.js';
import type { FailureCommenter } from '../publish/failure-comment.js';
import type { Publisher } from '../publish/publish.js';
import type { IssueSnapshot, Job } from '../types.js';
import { newId } from '../util/ids.js';
import type { Logger } from '../util/log.js';
import {
  LogOnlyExecutor,
  StartFailedError,
  type ExecutionContext,
  type ExecutionResult,
  type Executor,
} from './executor.js';
import {
  WORKER_HEARTBEAT_MS,
  WORKER_STALE_MS,
  acquireWorkerLock,
  heartbeatWorkerLock,
  releaseWorkerLock,
} from './lock.js';
import { defaultContainerControl, type ContainerControl } from './container.js';
import { defaultProcessControl, terminateIfSameProcess, type ProcessControl } from './process.js';
import { reconcileInterruptedRuns } from './reconcile.js';
import { decideFailureHandling, hasEscalation, type PolicyOutcome } from './failure-policy.js';

export { WorkerLockedError } from './lock.js';

/**
 * How often the worker looks for `updraft cancel` requests on the runs it is executing. The
 * heartbeat (15s) is too slow for someone watching an agent do the wrong thing, and the check is
 * one indexed query on the local database, skipped while nothing is running.
 */
export const CANCEL_CHECK_MS = 2_000;

/**
 * How often the worker logs an info-level "worker alive" line. Polls are logged at debug only,
 * so without this a worker that stopped silently (killed, crashed before its handlers ran)
 * leaves no way to tell from the log when it was last running.
 */
export const STATUS_LOG_MS = 60 * 60_000;

export interface DaemonTiming {
  /** Interval of the info-level "worker alive" line. Default 1h. */
  statusLogMs?: number;
  /** Lock heartbeat and run-lease refresh interval. Default 15s. */
  heartbeatMs?: number;
  /** How often to look for user cancel requests on in-flight runs. Default 2s. */
  cancelCheckMs?: number;
  /** Run lease length. Default 2x the stale-lock threshold (90s). */
  leaseSeconds?: number;
  /** On abort, how long to wait for in-flight runs to finish on their own. Default 20s. */
  shutdownTimeoutMs?: number;
  /** After signalling unfinished runs to stop, how long to wait before marking them interrupted. Default 5s. */
  interruptGraceMs?: number;
  /** Time between polls (and so between retry passes). Default config.pollIntervalSeconds. */
  pollMs?: number;
}

export interface DaemonDeps {
  db: Db;
  config: UpdraftConfig;
  paths: UpdraftPaths;
  log: Logger;
  /** One poll cycle (wired to poller.pollOnce by `updraft start`). */
  poll: () => Promise<unknown>;
  /** Final pre-start check (wired to poller.checkJobDispatchable). `issue` is passed to the executor. */
  checkDispatchable: (job: Job) => Promise<{ ok: true; issue?: IssueSnapshot } | { ok: false; reason: string }>;
  /** Abort to stop gracefully (SIGINT/SIGTERM). */
  signal: AbortSignal;
  /**
   * Drain mode (src/worker/drain.ts, behind `updraft run-event`): asked after each pass that
   * leaves nothing in flight, that is, with no run executing, being published or being commented
   * on. Returning true ends the loop as an abort would. Absent: the worker runs until aborted.
   */
  idle?: () => boolean;
  now?: () => number;
  /** Defaults to the log-only executor. */
  executor?: Executor;
  /** Process liveness/termination; injectable for tests. */
  processControl?: ProcessControl;
  /** Removal of a containerized run's container; injectable for tests. */
  containers?: ContainerControl;
  /**
   * Publication (repositories.<repo>.publish): called after a succeeded run is recorded, and after
   * each poll to retry transient failures. Never changes a run's outcome. Absent: nothing is published.
   */
  publisher?: Publisher;
  /**
   * Failure comments (repositories.<repo>.commentOnFailure): called after a failed or start_failed
   * run is recorded (it decides whether the job ended failed), and after each poll to retry
   * transient failures. Never changes a run's outcome. Absent: nothing is posted.
   */
  failureCommenter?: FailureCommenter;
  /**
   * Assignment comment: announced on the issue once a live implementation run passed its final
   * dispatch check, just before the agent starts. Not awaited; never changes a run. Absent: none.
   */
  assignmentCommenter?: AssignmentCommenter;
  /** Identity overrides, mainly for tests. */
  workerId?: string;
  hostname?: string;
  pid?: number;
  timing?: DaemonTiming;
}

/** Resolves after ms, on abort, or when notify() is called (whichever is first). */
class Wakeup {
  private pending = false;
  private resolveCurrent: (() => void) | null = null;

  notify(): void {
    if (this.resolveCurrent) this.resolveCurrent();
    else this.pending = true;
  }

  wait(ms: number, signal: AbortSignal): Promise<void> {
    if (this.pending || signal.aborted) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        this.resolveCurrent = null;
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      signal.addEventListener('abort', done, { once: true });
      this.resolveCurrent = done;
    });
  }
}

/** Wait for all promises or until ms elapses; never leaves a timer behind. */
async function settleWithin(promises: Promise<unknown>[], ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled(promises),
    new Promise<void>((r) => {
      timer = setTimeout(r, ms);
    }),
  ]);
  clearTimeout(timer);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface InFlight {
  claim: Claim;
  controller: AbortController;
  done: Promise<void>;
}

/**
 * The long-running worker behind `updraft start`:
 * acquire the single-worker lock, reconcile interrupted runs from a previous
 * process, then loop: poll every pollIntervalSeconds, claim and execute jobs
 * with the configured executor, heartbeat leases, and exit cleanly on abort.
 * Rejects with WorkerLockedError if another live worker holds the lock.
 */
export async function runDaemon(deps: DaemonDeps): Promise<void> {
  const { db, config, paths, signal } = deps;
  const now = deps.now ?? Date.now;
  const workerId = deps.workerId ?? newId('wrk');
  const hostname = deps.hostname ?? osHostname();
  const pid = deps.pid ?? process.pid;
  const processControl = deps.processControl ?? defaultProcessControl;
  const containers = deps.containers ?? defaultContainerControl;
  const executor = deps.executor ?? new LogOnlyExecutor();
  const heartbeatMs = deps.timing?.heartbeatMs ?? WORKER_HEARTBEAT_MS;
  const cancelCheckMs = deps.timing?.cancelCheckMs ?? CANCEL_CHECK_MS;
  const leaseSeconds = deps.timing?.leaseSeconds ?? Math.ceil((2 * WORKER_STALE_MS) / 1000);
  const shutdownTimeoutMs = deps.timing?.shutdownTimeoutMs ?? 20_000;
  const interruptGraceMs = deps.timing?.interruptGraceMs ?? 5_000;
  const pollMs = deps.timing?.pollMs ?? config.pollIntervalSeconds * 1000;
  const log = deps.log.child({ workerId });

  const safeRecordError = (scope: string, msg: string, extra: { jobId?: string; repoFullName?: string } = {}) => {
    try {
      recordError(db, { scope, message: msg, at: new Date(now()).toISOString(), ...extra });
    } catch (err) {
      log.error('could not record error', { error: message(err) });
    }
  };

  const { previous, takeover } = acquireWorkerLock(db, { workerId, pid, hostname }, {
    now,
    isPidAlive: (p) => processControl.isAlive(p),
  });
  if (previous) {
    log.warn('took over worker lock', { reason: takeover, previousPid: previous.pid, previousHost: previous.hostname });
  }
  log.info('worker started', { pid, hostname, executor: executor.name, maxConcurrent: config.maxConcurrent });

  const inFlight = new Map<string, InFlight>();
  const wake = new Wakeup();
  /** Jobs whose pre-start check errored; skipped until the next poll so a GitHub outage doesn't spin. */
  const deferred = new Set<string>();
  let lockLost = false;

  const markLockLost = () => {
    if (lockLost) return;
    lockLost = true;
    log.error('worker lock was taken over by another worker; stopping');
    safeRecordError('worker', `worker ${workerId} lost the worker lock; stopping`);
    wake.notify();
  };

  const launch = (claim: Claim, issue: IssueSnapshot | undefined) => {
    const { run, job } = claim;
    const controller = new AbortController();
    const runLog = log.child({ runId: run.id, jobId: job.id, agent: run.agent });
    const ctx: ExecutionContext = {
      config,
      paths,
      log: runLog,
      signal: controller.signal,
      workerStopping: signal,
      now,
      ...(issue ? { issue } : {}),
      recordProcess: (info) => setRunProcess(db, run.id, info, now),
    };
    runLog.info('run started', { repo: job.repoFullName, issue: job.issueNumber, pool: run.pool, logPath: run.logPath });
    const done = (async () => {
      let result: ExecutionResult;
      try {
        result = await executor.execute(claim, ctx);
      } catch (err) {
        result = { outcome: err instanceof StartFailedError ? 'start_failed' : 'failed', error: message(err) };
      }
      if (result.summary) {
        try {
          setRunSummary(db, run.id, result.summary);
        } catch (err) {
          runLog.error('could not record run summary', { error: message(err) });
        }
      }
      // What was recorded can differ from what the executor reported: a run the user canceled
      // closes as canceled even if its agent finished first, and a run another worker already
      // reconciled is left as that worker recorded it.
      let finished: FinishedRun | null = null;
      let policyRequeued = false;
      try {
        // Opt-in policy (usage limits, escalation): may close a clean-exit pre-edit deferral as
        // failed and put the job back instead of failing it. A no-op without that configuration.
        let policy: PolicyOutcome = { outcome: result.outcome, error: result.error ?? null };
        if (config.capacity || hasEscalation(config)) {
          try {
            policy = decideFailureHandling(db, config, job, run, result, now());
          } catch (err) {
            runLog.error('could not apply failure policy; recording the run as reported', { error: message(err) });
          }
        }
        finished = finishRun(db, run.id, {
          outcome: policy.outcome,
          error: policy.error ?? null,
          now,
          ...(policy.handling ? { handling: policy.handling } : {}),
        });
        policyRequeued = !!policy.handling && getJob(db, job.id)?.status === 'queued';
        if (policy.handling) runLog.info('failure policy applied', { kind: policy.handling.kind, detail: policy.error ?? undefined });
        if (finished?.canceledByUser) runLog.info('run canceled by user', { executorOutcome: result.outcome });
        else runLog.info('run finished', { outcome: result.outcome, ...(result.error ? { error: result.error } : {}) });
      } catch (err) {
        runLog.error('could not record run result', { error: message(err) });
      }
      // The run is closed (its slot is free); publishing it is a separate step with its own record.
      if (finished?.outcome === 'succeeded' && deps.publisher) {
        await deps.publisher.afterRun(run.id, controller.signal);
      }
      // Not for interrupted runs: the worker is stopping, and whoever stops it is there to retry.
      // Decided by what was recorded: a run the user canceled is closed as canceled whatever the
      // executor reported, and must not be announced as a failure.
      if (finished && !policyRequeued && !finished.canceledByUser && (finished.outcome === 'failed' || finished.outcome === 'start_failed') && deps.failureCommenter) {
        await deps.failureCommenter.afterRun(run.id, controller.signal);
      }
    })().finally(() => {
      inFlight.delete(run.id);
      wake.notify();
    });
    inFlight.set(run.id, { claim, controller, done });
  };

  const startJobs = async () => {
    while (!signal.aborted && !lockLost) {
      let claim: Claim | null;
      try {
        claim = claimNextJob(db, config, {
          workerId,
          hostname,
          leaseSeconds,
          runsDir: paths.runsDir,
          now,
          excludeJobIds: deferred,
          lockWorkerId: workerId,
        });
      } catch (err) {
        if (err instanceof WorkerLockLostError) {
          markLockLost();
          return;
        }
        log.error('claim failed', { error: message(err) });
        safeRecordError('worker', `claim failed: ${message(err)}`);
        return;
      }
      if (!claim) return;
      const { job, run } = claim;

      let check: Awaited<ReturnType<DaemonDeps['checkDispatchable']>>;
      try {
        check = await deps.checkDispatchable(job);
      } catch (err) {
        deferred.add(job.id);
        const msg = `pre-start check failed: ${message(err)}`;
        log.warn('pre-start check failed; job stays queued until the next poll', { jobId: job.id, error: message(err) });
        safeRecordError('worker', msg, { jobId: job.id, repoFullName: job.repoFullName });
        releaseClaim(db, run.id, msg, now);
        continue;
      }
      // The check awaited GitHub; the lock may have changed hands meanwhile. If so, the new
      // holder has already reconciled this run, and releaseClaim is a no-op on a closed run.
      if (!lockLost && !holdsWorkerLock(db, workerId)) markLockLost();
      if (signal.aborted || lockLost) {
        releaseClaim(db, run.id, lockLost ? 'worker lost its lock' : 'worker stopping', now);
        return;
      }
      if (!check.ok) {
        cancelClaim(db, run.id, check.reason, now);
        log.info('job canceled before start', { jobId: job.id, reason: check.reason });
        continue;
      }
      // Recorded just before execute, atomically with the lock check: from here on a worker
      // that takes over treats the run as started (interrupted), not as safe to requeue.
      const executionStartedAt = markExecutionStarted(db, run.id, { workerId, now });
      if (!executionStartedAt) {
        // Either the user canceled the job while it was being checked (releaseClaim then cancels
        // it instead of requeueing), or the lock changed hands after the check above; the new
        // holder may already have requeued this run, in which case releaseClaim is a no-op.
        if (!holdsWorkerLock(db, workerId)) markLockLost();
        if (getRun(db, run.id)?.cancelRequestedAt) log.info('job canceled by user before start', { jobId: job.id, runId: run.id });
        releaseClaim(db, run.id, lockLost ? 'worker lost its lock' : 'run was closed before it started', now);
        if (lockLost) return;
        continue;
      }
      // Not awaited: delivery never delays or changes the run. announce() never throws.
      if (deps.assignmentCommenter) {
        deps.assignmentCommenter
          .announce(job, run, signal)
          .catch((err: unknown) => log.error('assignment comment crashed', { runId: run.id, error: message(err) }));
      }
      launch({ job, run: { ...run, executionStartedAt } }, check.issue);
    }
  };

  /**
   * Runs on its own timer, so slow GitHub calls in poll() or the pre-start check never
   * delay it (SQLite calls are synchronous; the timer fires whenever the loop awaits).
   */
  const heartbeat = () => {
    if (lockLost) return;
    try {
      if (!heartbeatWorkerLock(db, workerId, now)) {
        markLockLost();
        return;
      }
      for (const runId of inFlight.keys()) heartbeatRun(db, runId, leaseSeconds, now);
    } catch (err) {
      log.error('heartbeat failed', { error: message(err) });
    }
  };

  /**
   * `updraft cancel` runs in another process and can only record its request in the database.
   * Abort the controller of each requested run: the executor stops the agent's process tree
   * exactly as it does on shutdown, and finishRun then closes the run as canceled. On its own
   * timer for the same reason as the heartbeat: the loop may be awaiting GitHub.
   */
  const checkCancelRequests = () => {
    if (lockLost || inFlight.size === 0) return;
    try {
      for (const runId of listCancelRequestedRuns(db)) {
        const f = inFlight.get(runId);
        if (!f || f.controller.signal.aborted) continue;
        log.info('cancel requested by user; stopping run', { runId, jobId: f.claim.job.id });
        f.controller.abort(CANCELED_BY_USER);
      }
    } catch (err) {
      log.error('could not check for cancel requests', { error: message(err) });
    }
  };

  const shutdown = async () => {
    if (inFlight.size === 0) return;
    log.info('waiting for in-flight runs', { count: inFlight.size, timeoutMs: shutdownTimeoutMs });
    await settleWithin([...inFlight.values()].map((f) => f.done), shutdownTimeoutMs);
    if (inFlight.size === 0) return;

    for (const f of inFlight.values()) f.controller.abort();
    await settleWithin([...inFlight.values()].map((f) => f.done), interruptGraceMs);

    for (const [runId, f] of inFlight) {
      // The executor did not stop its agent within the grace period. Same host by construction;
      // still verify the start time so a pid the OS reused is never killed.
      const current = getRun(db, runId);
      let note = '';
      if (current?.container) {
        // Before the client: stopping the runtime client alone can leave the container running.
        note = (await containers.remove(current.container.runtime, current.container.name).catch(() => ({ note: '' }))).note;
      }
      if (current?.pid != null) {
        const pidNote = (await terminateIfSameProcess(processControl, current.pid, current.pidStartTime).catch(() => ({ note: '' }))).note;
        note = [note, pidNote].filter(Boolean).join('; ');
      }
      try {
        finishRun(db, runId, {
          outcome: 'interrupted',
          error: `worker stopped before the run finished${note ? `; ${note}` : ''}`,
          now,
        });
      } catch (err) {
        log.error('could not mark run interrupted', { runId, error: message(err) });
      }
      log.warn('run interrupted by shutdown', { runId, jobId: f.claim.job.id });
    }
  };

  const heartbeatTimer = setInterval(heartbeat, heartbeatMs);
  const cancelTimer = setInterval(checkCancelRequests, cancelCheckMs);
  try {
    await reconcileInterruptedRuns(db, { hostname, processControl, containers, log, now });

    // Record when publish was turned on or off per repository (the config has no history), then
    // publish succeeded runs a previous worker stopped before publishing, if they ended since.
    let settingsSynced = false;
    try {
      for (const c of syncPublishSettings(db, config, now)) {
        log.info('publish setting changed', { repo: c.repoFullName, from: c.from, to: c.to, enabledAt: c.enabledAt });
      }
      settingsSynced = true;
    } catch (err) {
      log.error('could not record publish settings; skipping the startup publication sweep', { error: message(err) });
    }
    if (settingsSynced && deps.publisher && !signal.aborted && !lockLost) await deps.publisher.sweepUnpublished(signal);

    let nextPollAt = now();
    const statusLogMs = deps.timing?.statusLogMs ?? STATUS_LOG_MS;
    const startedAt = now();
    let lastStatusAt = startedAt;
    let polls = 0;
    let pollFailures = 0;
    while (!signal.aborted && !lockLost) {
      if (now() >= nextPollAt) {
        polls++;
        try {
          await deps.poll();
        } catch (err) {
          pollFailures++;
          log.error('poll failed', { error: message(err) });
          safeRecordError('poll', message(err));
        }
        nextPollAt = now() + pollMs;
        if (now() - lastStatusAt >= statusLogMs) {
          log.info('worker alive', {
            uptimeMinutes: Math.round((now() - startedAt) / 60_000),
            polls,
            pollFailures,
            inFlight: inFlight.size,
          });
          lastStatusAt = now();
          polls = 0;
          pollFailures = 0;
        }
        deferred.clear();
        if (deps.publisher && !signal.aborted && !lockLost) await deps.publisher.retryDue(signal);
        if (deps.failureCommenter && !signal.aborted && !lockLost) await deps.failureCommenter.retryDue(signal);
      }
      if (signal.aborted) break;

      await startJobs();
      if (deps.idle && inFlight.size === 0 && !signal.aborted && !lockLost && deps.idle()) break;

      // Bounded by heartbeatMs so a stalled clock or missed notify can't park the loop.
      await wake.wait(Math.min(nextPollAt - now(), heartbeatMs), signal);
    }
  } finally {
    log.info('worker stopping', { inFlight: inFlight.size });
    clearInterval(cancelTimer);
    await shutdown();
    clearInterval(heartbeatTimer);
    releaseWorkerLock(db, workerId);
    log.info('worker stopped');
  }
}
