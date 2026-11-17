// OWNER: queue/worker workstream. The long-running worker behind `factory start`.
import { hostname as osHostname } from 'node:os';
import type { FactoryConfig } from '../config/schema.js';
import { recordError, type Db } from '../db/database.js';
import {
  cancelClaim,
  claimNextJob,
  finishRun,
  getRun,
  heartbeatRun,
  holdsWorkerLock,
  markExecutionStarted,
  releaseClaim,
  setRunProcess,
  setRunSummary,
  WorkerLockLostError,
  type Claim,
} from '../db/queue.js';
import { syncPublishSettings } from '../db/publish-settings.js';
import type { FactoryPaths } from '../paths.js';
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
import { defaultProcessControl, terminateIfSameProcess, type ProcessControl } from './process.js';
import { reconcileInterruptedRuns } from './reconcile.js';

export { WorkerLockedError } from './lock.js';

export interface DaemonTiming {
  /** Lock heartbeat and run-lease refresh interval. Default 15s. */
  heartbeatMs?: number;
  /** Run lease length. Default 2x the stale-lock threshold (90s). */
  leaseSeconds?: number;
  /** On abort, how long to wait for in-flight runs to finish on their own. Default 20s. */
  shutdownTimeoutMs?: number;
  /** After signalling unfinished runs to stop, how long to wait before marking them interrupted. Default 5s. */
  interruptGraceMs?: number;
}

export interface DaemonDeps {
  db: Db;
  config: FactoryConfig;
  paths: FactoryPaths;
  log: Logger;
  /** One poll cycle (wired to poller.pollOnce by `factory start`). */
  poll: () => Promise<unknown>;
  /** Final pre-start check (wired to poller.checkJobDispatchable). `issue` is passed to the executor. */
  checkDispatchable: (job: Job) => Promise<{ ok: true; issue?: IssueSnapshot } | { ok: false; reason: string }>;
  /** Abort to stop gracefully (SIGINT/SIGTERM). */
  signal: AbortSignal;
  now?: () => number;
  /** Defaults to the log-only executor. */
  executor?: Executor;
  /** Process liveness/termination; injectable for tests. */
  processControl?: ProcessControl;
  /**
   * Publication (repositories.<repo>.publish): called after a succeeded run is recorded, after
   * each poll to retry transient failures, and once at start (after reconcile) for succeeded runs
   * left without a publication record. Never changes a run's outcome. Absent: nothing is published.
   */
  publisher?: Publisher;
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
 * The long-running worker behind `factory start`:
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
  const executor = deps.executor ?? new LogOnlyExecutor();
  const heartbeatMs = deps.timing?.heartbeatMs ?? WORKER_HEARTBEAT_MS;
  const leaseSeconds = deps.timing?.leaseSeconds ?? Math.ceil((2 * WORKER_STALE_MS) / 1000);
  const shutdownTimeoutMs = deps.timing?.shutdownTimeoutMs ?? 20_000;
  const interruptGraceMs = deps.timing?.interruptGraceMs ?? 5_000;
  const pollMs = config.pollIntervalSeconds * 1000;
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
      recordProcess: (info) => setRunProcess(db, run.id, info),
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
      let recorded = false;
      try {
        finishRun(db, run.id, { outcome: result.outcome, error: result.error ?? null, now });
        recorded = true;
        runLog.info('run finished', { outcome: result.outcome, ...(result.error ? { error: result.error } : {}) });
      } catch (err) {
        runLog.error('could not record run result', { error: message(err) });
      }
      // The run is closed (its slot is free); publishing it is a separate step with its own record.
      if (recorded && result.outcome === 'succeeded' && deps.publisher) {
        await deps.publisher.afterRun(run.id, controller.signal);
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
        // The lock changed hands after the check above; the new holder may already have
        // requeued this run, in which case releaseClaim is a no-op.
        if (!holdsWorkerLock(db, workerId)) markLockLost();
        releaseClaim(db, run.id, lockLost ? 'worker lost its lock' : 'run was closed before it started', now);
        if (lockLost) return;
        continue;
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
      if (current?.pid != null) {
        note = (await terminateIfSameProcess(processControl, current.pid, current.pidStartTime).catch(() => ({ note: '' }))).note;
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
  try {
    await reconcileInterruptedRuns(db, { hostname, processControl, log, now });

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
    while (!signal.aborted && !lockLost) {
      if (now() >= nextPollAt) {
        try {
          await deps.poll();
        } catch (err) {
          log.error('poll failed', { error: message(err) });
          safeRecordError('poll', message(err));
        }
        nextPollAt = now() + pollMs;
        deferred.clear();
        if (deps.publisher && !signal.aborted && !lockLost) await deps.publisher.retryDue(signal);
      }
      if (signal.aborted) break;

      await startJobs();

      // Bounded by heartbeatMs so a stalled clock or missed notify can't park the loop.
      await wake.wait(Math.min(nextPollAt - now(), heartbeatMs), signal);
    }
  } finally {
    log.info('worker stopping', { inFlight: inFlight.size });
    await shutdown();
    clearInterval(heartbeatTimer);
    releaseWorkerLock(db, workerId);
    log.info('worker stopped');
  }
}
