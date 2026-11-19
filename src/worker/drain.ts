// Drain mode: the worker of `updraft start`, run until its work is done instead of forever.
// Behind `updraft run-event`, where one process handles one event and exits.
//
// It is runDaemon itself (the same claim, pre-start check, executor, publication, review loop and
// failure comment), with these differences:
// - Nothing is polled. Whatever is to run was queued before the drain started, or is queued by
//   the work itself: a published run queues its reviewer job, a "changes requested" verdict its
//   revision, the pushed revision the next reviewer job.
// - It ends on its own, through runDaemon's `idle` hook: when no job is queued, nothing is in
//   flight (a run is in flight until its publication, review posting or failure comment was
//   attempted), no auto-merge is still waiting for checks, and no retry is worth waiting for.
// - What the worker does after each poll (retries, reviewer jobs, the auto-merge step, notices)
//   happens every few seconds instead, with GitHub asked about a waiting merge only every
//   `mergePollMs`. A publication or comment that failed for a passing reason is retried when it
//   comes due, but only while that is within `settleMs` of the queue running empty: a process
//   that exists for one event does not wait an hour for GitHub.
// - With `scope` (src/worker/scope.ts), the state database is one that other machines write to
//   as well: only the event's own jobs and pull requests are worked on, runs other workers left
//   open in it are neither reconciled nor counted, and "done" is about the event's work alone.
// - A queued job that a usage-limit cooldown holds back is waited for when the cooldown ends
//   before the deadline (or within `cooldownWaitMs` when there is none). Otherwise the drain
//   ends `deferred` and the job stays queued in the state database for a later run.
import { DEFAULT_AUTO_MERGE_WAIT_MINUTES } from '../config/schema.js';
import type { Publisher } from '../publish/publish.js';
import { runDaemon, type DaemonDeps } from './daemon.js';
import { pendingWork, type EventScope } from './scope.js';

export interface DrainOptions {
  /** Stop everything this long after the drain started, running agent included. Default: no limit (the action's timeout bounds the agent). */
  deadlineMs?: number;
  /** After the queue ran empty, how long scheduled retries are still waited for. Default 5 minutes. */
  settleMs?: number;
  /** How long a queued job may sit with nothing running before the drain gives up on it. Default 60s. */
  stallMs?: number;
  /** How often retries and stuck jobs are looked at. Default 5s. */
  tickMs?: number;
  /** How often GitHub is asked about an auto-merge that is waiting for checks. Default 30s. */
  mergePollMs?: number;
  /** Without a deadline: how long a usage-limit cooldown is waited for before the drain ends `deferred`. Default 5 minutes. */
  cooldownWaitMs?: number;
  /** The event's own work in a shared state database. Absent: everything in the database is this drain's. */
  scope?: EventScope;
  /** Injected in tests. */
  runDaemon?: (deps: DaemonDeps) => Promise<void>;
}

/**
 * How a drain ended.
 * - idle: nothing queued, nothing running, nothing to retry, no merge pending.
 * - retries-abandoned: as idle, but a retry was scheduled for later than the drain waits, or an
 *   auto-merge could not be settled in the time it is given.
 * - stalled: a job stayed queued and nothing could start it (no agent for it, or its pre-start
 *   check kept failing).
 * - deferred: a job is queued behind a usage-limit cooldown that ends later than the drain waits.
 * - deadline: `deadlineMs` passed; what was running was stopped.
 * - stopped: the caller's signal was aborted.
 */
export type DrainEnd = 'idle' | 'retries-abandoned' | 'stalled' | 'deferred' | 'deadline' | 'stopped';

export const DEFAULT_SETTLE_MS = 5 * 60_000;
export const DEFAULT_STALL_MS = 60_000;
export const DEFAULT_TICK_MS = 5_000;
export const DEFAULT_MERGE_POLL_MS = 30_000;
export const DEFAULT_COOLDOWN_WAIT_MS = 5 * 60_000;

export { nextRetryAt } from './scope.js';

export interface DrainResult {
  ended: DrainEnd;
  /** With `deferred` only: when the cooldown that holds the work back ends (epoch millis). */
  deferredUntil?: number;
}

/**
 * Run the worker until its work is done. `deps` is what `updraft start` gives runDaemon, without
 * a poll. Resolves with why it ended; rejects as runDaemon does (WorkerLockedError).
 */
export async function drainQueue(deps: Omit<DaemonDeps, 'poll' | 'idle' | 'scope'>, opts: DrainOptions = {}): Promise<DrainResult> {
  const now = deps.now ?? Date.now;
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const mergePollMs = opts.mergePollMs ?? DEFAULT_MERGE_POLL_MS;
  const scope = opts.scope ?? null;
  const startedAt = now();
  const deadlineAt = opts.deadlineMs !== undefined ? startedAt + opts.deadlineMs : null;
  const controller = new AbortController();
  let ended: DrainEnd | null = null;
  let deferredUntil: number | null = null;
  const stop = () => {
    ended ??= 'stopped';
    controller.abort();
  };
  if (deps.signal.aborted) stop();
  deps.signal.addEventListener('abort', stop, { once: true });
  const deadline =
    opts.deadlineMs !== undefined
      ? setTimeout(() => {
          ended ??= 'deadline';
          deps.log.warn('drain deadline reached; stopping', { deadlineMs: opts.deadlineMs });
          controller.abort();
        }, opts.deadlineMs)
      : undefined;

  const pending = () => pendingWork(deps.db, deps.config, scope, now);
  // A merge waits for checks for at most autoMergeWaitMinutes; past that plus the settle time,
  // GitHub is not answering and the drain stops asking.
  const mergeWaitMs = Math.max(0, ...Object.values(deps.config.repositories).map((r) => (r.autoMergeWaitMinutes ?? DEFAULT_AUTO_MERGE_WAIT_MINUTES) * 60_000)) + settleMs;

  let stalled: { signature: string; since: number } | null = null;
  let settleUntil: number | null = null;
  let mergeSince: number | null = null;
  const idle = (): boolean => {
    const p = pending();
    if (p.queued.length) {
      if (p.cooldownEndsAt !== null) {
        // Held back by a usage limit, not stuck: the job starts by itself once the cooldown ends.
        stalled = null;
        const waitUntil = deadlineAt ?? startedAt + (opts.cooldownWaitMs ?? DEFAULT_COOLDOWN_WAIT_MS);
        if (p.cooldownEndsAt <= waitUntil) return false;
        ended ??= 'deferred';
        deferredUntil = p.cooldownEndsAt;
        deps.log.warn('queued work waits for a usage-limit cooldown that ends later than this run waits; leaving it queued', {
          cooldownEndsAt: new Date(p.cooldownEndsAt).toISOString(),
          jobs: p.queued.map((j) => j.id),
        });
        return true;
      }
      // Queued, and this pass did not start it. Normal for a moment (a pre-start check that
      // could not reach GitHub is tried again on the next tick); not for long.
      const signature = p.queued.map((j) => `${j.id}:${j.startFailures}`).join(',');
      if (stalled?.signature !== signature) stalled = { signature, since: now() };
      if (now() - stalled.since < stallMs) return false;
      ended ??= 'stalled';
      deps.log.warn('queued work could not be started; giving up', { waitedMs: now() - stalled.since });
      return true;
    }
    stalled = null;
    if (p.merges.length || p.notices) {
      mergeSince ??= now();
      if (now() - mergeSince < mergeWaitMs) return false; // the publisher takes the merge step on a tick
      ended ??= 'retries-abandoned';
      deps.log.warn('an auto-merge could not be settled in the time it is given; leaving it', { pullRequests: p.merges.map((m) => m.prNumber) });
      return true;
    }
    mergeSince = null;
    if (p.nextRetryAt === null) {
      ended ??= 'idle';
      return true;
    }
    settleUntil ??= now() + settleMs;
    if (p.nextRetryAt <= settleUntil) return false; // the daemon retries it when due, on a tick
    ended ??= 'retries-abandoned';
    deps.log.warn('a retry is scheduled for later than this run waits; leaving it', { retryAt: new Date(p.nextRetryAt).toISOString() });
    return true;
  };

  // The daemon calls retryDue after every "poll", which here is every tick. Everything in it is
  // local except the auto-merge step, which asks GitHub about each candidate: a merge that is
  // waiting for checks is asked about every mergePollMs, not every tick.
  let lastMergeStepAt = Number.NEGATIVE_INFINITY;
  const inner = deps.publisher;
  const publisher: Publisher | undefined = inner && {
    afterRun: (runId, signal) => inner.afterRun(runId, signal),
    sweepUnpublished: (signal, o) => inner.sweepUnpublished(signal, o),
    async retryDue(signal) {
      const p = pending();
      const waiting = p.merges.length > 0 && p.notices === 0 && p.merges.every((m) => m.mergeSha === m.headSha && (m.mergeState === 'waiting' || m.mergeState === 'merging'));
      const retryDue = p.nextRetryAt !== null && p.nextRetryAt <= now();
      if (waiting && !retryDue && now() - lastMergeStepAt < mergePollMs) return;
      if (p.merges.length) lastMergeStepAt = now();
      await inner.retryDue(signal);
    },
  };

  try {
    await (opts.runDaemon ?? runDaemon)({
      ...deps,
      ...(publisher ? { publisher } : {}),
      ...(scope ? { scope } : {}),
      signal: controller.signal,
      poll: async () => {},
      idle,
      timing: { ...deps.timing, pollMs: tickMs },
    });
  } finally {
    clearTimeout(deadline);
    deps.signal.removeEventListener('abort', stop);
  }
  return { ended: ended ?? 'stopped', ...(ended === 'deferred' && deferredUntil !== null ? { deferredUntil } : {}) };
}
