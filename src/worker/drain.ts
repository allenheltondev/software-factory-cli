// Drain mode: the worker of `updraft start`, run until the queue is empty instead of forever.
// Behind `updraft run-event`, where one process handles one event and exits.
//
// It is runDaemon itself (the same claim, pre-start check, executor, publication and failure
// comment), with three differences:
// - Nothing is polled. Whatever is to run was queued before the drain started.
// - It ends on its own, through runDaemon's `idle` hook: when no job is queued, nothing is in
//   flight (a run is in flight until its publication or failure comment was attempted), and no
//   retry is worth waiting for.
// - Retries are looked at every few seconds, not once per poll interval. A publication or failure
//   comment that failed for a passing reason is retried when it comes due, as always, but only
//   while that is within `settleMs` of the queue running empty: a process that exists for one
//   event does not wait an hour for GitHub. What is left is in the summary, and in the state
//   directory for whoever keeps it.
import type { Db } from '../db/database.js';
import { runDaemon, type DaemonDeps } from './daemon.js';

export interface DrainOptions {
  /** Stop everything this long after the drain started, running agent included. Default: no limit (the action's timeout bounds the agent). */
  deadlineMs?: number;
  /** After the queue ran empty, how long scheduled retries are still waited for. Default 5 minutes. */
  settleMs?: number;
  /** How long a queued job may sit with nothing running before the drain gives up on it. Default 60s. */
  stallMs?: number;
  /** How often retries and stuck jobs are looked at. Default 5s. */
  tickMs?: number;
  /** Injected in tests. */
  runDaemon?: (deps: DaemonDeps) => Promise<void>;
}

/**
 * How a drain ended.
 * - idle: nothing queued, nothing running, nothing to retry.
 * - retries-abandoned: as idle, but a retry was scheduled for later than the drain waits.
 * - stalled: a job stayed queued and nothing could start it (no agent for it, or its pre-start
 *   check kept failing).
 * - deadline: `deadlineMs` passed; what was running was stopped.
 * - stopped: the caller's signal was aborted.
 */
export type DrainEnd = 'idle' | 'retries-abandoned' | 'stalled' | 'deadline' | 'stopped';

export const DEFAULT_SETTLE_MS = 5 * 60_000;
export const DEFAULT_STALL_MS = 60_000;
export const DEFAULT_TICK_MS = 5_000;

/** Tables whose rows carry a retry the worker makes on its own (publish.ts, failure-comment.ts, revision.ts, review.ts). */
const RETRY_TABLES = ['publications', 'failure_comments', 'revisions', 'pr_reviews'] as const;

/** When the earliest scheduled retry is due (epoch millis), or null when none is scheduled. */
export function nextRetryAt(db: Db): number | null {
  let next: number | null = null;
  for (const table of RETRY_TABLES) {
    const row = db
      .prepare(`SELECT min(next_attempt_at) AS at FROM ${table} WHERE state = 'failed' AND retryable = 1 AND next_attempt_at IS NOT NULL`)
      .get() as { at: string | null } | undefined;
    const at = row?.at ? Date.parse(row.at) : Number.NaN;
    if (Number.isFinite(at) && (next === null || at < next)) next = at;
  }
  return next;
}

/** Which jobs are queued, and how often each failed to start: unchanged while nothing makes progress on them. */
function queuedSignature(db: Db): string {
  const rows = db.prepare("SELECT id, start_failures FROM jobs WHERE status = 'queued' ORDER BY id").all() as Array<{ id: string; start_failures: number }>;
  return rows.map((r) => `${r.id}:${r.start_failures}`).join(',');
}

/**
 * Run the worker until the queue is drained. `deps` is what `updraft start` gives runDaemon,
 * without a poll. Resolves with why it ended; rejects as runDaemon does (WorkerLockedError).
 */
export async function drainQueue(deps: Omit<DaemonDeps, 'poll' | 'idle'>, opts: DrainOptions = {}): Promise<{ ended: DrainEnd }> {
  const now = deps.now ?? Date.now;
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const controller = new AbortController();
  let ended: DrainEnd | null = null;
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

  let stalled: { signature: string; since: number } | null = null;
  let settleUntil: number | null = null;
  const idle = (): boolean => {
    const signature = queuedSignature(deps.db);
    if (signature !== '') {
      // Queued, and this pass did not start it. Normal for a moment (a pre-start check that
      // could not reach GitHub is tried again on the next tick); not for long.
      if (stalled?.signature !== signature) stalled = { signature, since: now() };
      if (now() - stalled.since < stallMs) return false;
      ended ??= 'stalled';
      deps.log.warn('queued work could not be started; giving up', { waitedMs: now() - stalled.since });
      return true;
    }
    stalled = null;
    const retryAt = nextRetryAt(deps.db);
    if (retryAt === null) {
      ended ??= 'idle';
      return true;
    }
    settleUntil ??= now() + settleMs;
    if (retryAt <= settleUntil) return false; // the daemon retries it when due, on a tick
    ended ??= 'retries-abandoned';
    deps.log.warn('a retry is scheduled for later than this run waits; leaving it', { retryAt: new Date(retryAt).toISOString() });
    return true;
  };

  try {
    await (opts.runDaemon ?? runDaemon)({
      ...deps,
      signal: controller.signal,
      poll: async () => {},
      idle,
      timing: { ...deps.timing, pollMs: tickMs },
    });
  } finally {
    clearTimeout(deadline);
    deps.signal.removeEventListener('abort', stop);
  }
  return { ended: ended ?? 'stopped' };
}
