// OWNER: queue/worker workstream. Claim-side persistence: atomic claims, runs,
// leases, retry, and status queries.
import { join } from 'node:path';
import { DEFAULT_MAX_REVISIONS, reviewPoolFor, reviewSettings, workflowId, type UpdraftConfig } from '../config/schema.js';
import { recordError, rowToJob, rowToRun, transaction, type Db, type JobRow, type RunRow } from './database.js';
import { reviewOf, type Job, type JobStatus, type Publication, type Revision, type Run, type RunContainer, type RunOutcome, type RunSummary } from '../types.js';
import { listRecentFailureComments, type FailureComment } from './failure-comments.js';
import { listRecentPublications } from './publications.js';
import { getLoopPr, listRecentLoopPrs, listRecentPrReviews, prStage, type LoopPr, type PrReview, type PrStageInfo } from './pr-reviews.js';
import {
  issuesAwaitingRevisionPush,
  listLimitedRevisionPrs,
  listRecentReviewRequests,
  listRecentRevisions,
  type ReviewRequest,
  type RevisionPr,
} from './revisions.js';
import { newId, nowIso } from '../util/ids.js';
import {
  activeCooldowns,
  capacityBlock,
  listRecentPolicyEvents,
  recordPolicyEvent,
  setCooldown,
  type CapacityKey,
  type Cooldown,
  type PolicyEvent,
} from './capacity.js';
import { noteJobFinished, noteRunEnded } from './metrics.js';
import { WORKER_STALE_MS } from '../worker/lock.js';

export interface Claim {
  job: Job;
  run: Run;
}

/** The claiming worker no longer holds the single-worker lock. */
export class WorkerLockLostError extends Error {
  constructor(readonly workerId: string) {
    super(`worker ${workerId} no longer holds the worker lock`);
    this.name = 'WorkerLockLostError';
  }
}

/** True if `workerId` currently holds the single-worker lock. */
export function holdsWorkerLock(db: Db, workerId: string): boolean {
  const row = db.prepare('SELECT worker_id FROM worker_lock WHERE id = 1').get() as { worker_id: string } | undefined;
  return row?.worker_id === workerId;
}

/**
 * How many consecutive start failures (adapter could not start) a job may have
 * before it is marked failed instead of being requeued for another agent.
 * Counted in jobs.start_failures; the count resets when the user retries the job.
 */
export const MAX_START_FAILURES = 3;

/** Reason recorded on a job (and its run) canceled with `updraft cancel`. */
export const CANCELED_BY_USER = 'canceled by user';

const JOB_STATUSES: readonly JobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'interrupted', 'canceled'];
const RETRYABLE: readonly JobStatus[] = ['failed', 'interrupted', 'canceled'];

/** Config maps are plain objects; never let a job's pool/agent name resolve to an Object.prototype member. */
export function ownEntry<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function getJobRow(db: Db, jobId: string): JobRow | undefined {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
}

function getRunRow(db: Db, runId: string): RunRow | undefined {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
}

function runningByAgent(db: Db, ownedBy: string | null = null): Map<string, number> {
  const rows = db
    .prepare('SELECT agent, count(*) AS n FROM runs WHERE ended_at IS NULL AND (? IS NULL OR worker_id = ?) GROUP BY agent')
    .all(ownedBy, ownedBy) as {
    agent: string;
    n: number;
  }[];
  return new Map(rows.map((r) => [r.agent, r.n]));
}

const issueKey = (repoId: number, issue: number) => `${repoId}#${issue}`;

/**
 * Agents that failed to start this job in its current streak of start failures: the
 * agents of its newest `start_failures` start_failed runs. Empty after a user retry.
 */
function startFailedAgents(db: Db, jobId: string, startFailures: number): Set<string> {
  if (startFailures <= 0) return new Set();
  const rows = db
    .prepare("SELECT agent FROM runs WHERE job_id = ? AND outcome = 'start_failed' ORDER BY attempt DESC LIMIT ?")
    .all(jobId, startFailures) as { agent: string }[];
  return new Set(rows.map((r) => r.agent));
}

function failUnroutable(db: Db, row: JobRow, problem: string, at: string): void {
  const reason = `${problem}; fix the config, restart the worker and run "updraft retry ${row.id}"`;
  db.prepare("UPDATE jobs SET status = 'failed', status_reason = ?, updated_at = ? WHERE id = ?").run(reason, at, row.id);
  noteJobFinished(db, row.id);
  recordError(db, { scope: 'queue', repoFullName: row.repo_full_name, jobId: row.id, message: reason, at });
}

/**
 * The pool_cursors key of a job's round-robin rotation. Reviewer jobs rotate on a cursor of their
 * own, so who reviews takes turns among the reviewers whatever coding jobs the same pool runs in
 * between (with one shared cursor, a pool that both codes and reviews would hand each review to
 * whichever agent follows the author). Pool names cannot contain ":", so the keys never collide.
 */
export function cursorKey(row: Pick<JobRow, 'pool' | 'event_id'>): string {
  return isReviewJobRow(row) ? `review:${row.pool}` : row.pool;
}

function isReviewJobRow(row: Pick<JobRow, 'event_id'>): boolean {
  return row.event_id.startsWith('pr-review:');
}

/**
 * Pick an agent for a job from `poolAgents` using the persisted round-robin cursor `cursor`
 * (cursorKey): walk the pool from next_index and take the first enabled agent with
 * capacity, preferring agents that have not just failed to start this job.
 * Advances the cursor past the chosen agent. Returns null if none has capacity.
 */
function pickAgent(
  db: Db,
  config: UpdraftConfig,
  job: JobRow,
  cursor: string,
  poolAgents: readonly string[],
  load: Map<string, number>,
  /** Never picked, whatever its capacity (the author of the code a reviewer job reviews). */
  exclude: string | null = null,
  /** Capacity policy (docs/capacity-and-escalation.md): why an agent cannot take the run now, or null. */
  blocked: ((agent: string) => string | null) | null = null,
  blockedReasons: string[] = [],
): string | null {
  const n = poolAgents.length;
  if (n === 0) return null;
  const cursorRow = db.prepare('SELECT next_index FROM pool_cursors WHERE pool = ?').get(cursor) as
    | { next_index: number }
    | undefined;
  const start = (((cursorRow?.next_index ?? 0) % n) + n) % n;
  const capable: { name: string; index: number }[] = [];
  for (let k = 0; k < n; k++) {
    const index = (start + k) % n;
    const name = poolAgents[index]!;
    const agent = ownEntry(config.agents, name);
    if (name !== exclude && agent && agent.enabled && (load.get(name) ?? 0) < agent.maxConcurrent) {
      const why = blocked?.(name) ?? null;
      if (why) blockedReasons.push(`${name}: ${why}`);
      else capable.push({ name, index });
    }
  }
  if (capable.length === 0) return null;
  const failed = startFailedAgents(db, job.id, job.start_failures);
  const choice = capable.find((c) => !failed.has(c.name)) ?? capable[0]!;
  db.prepare(
    'INSERT INTO pool_cursors (pool, next_index) VALUES (?, ?) ON CONFLICT (pool) DO UPDATE SET next_index = excluded.next_index',
  ).run(cursor, (choice.index + 1) % n);
  return choice.name;
}

/**
 * The pool a reviewer job is routed to under the current config (reviewPoolFor). A job records
 * the pool it was queued for, but the config may have changed since: a workflow's reviewPool
 * replaced by the repository's review.pool, or the old pool removed. A head is reviewed once, so
 * scheduling never queues a second job for it; the route is settled here, when the job (queued
 * earlier or retried) is claimed. Falls back to the recorded pool when the repository, the job's
 * review request or its pull request cannot be found.
 */
function currentReviewPool(db: Db, config: UpdraftConfig, row: JobRow): string {
  const repo = Object.values(config.repositories).find((r) => r.id === row.repo_id);
  if (!repo) return row.pool;
  let prNumber: number | undefined;
  try {
    prNumber = reviewOf(rowToJob(row))?.pullRequest.number;
  } catch {
    return row.pool;
  }
  if (prNumber === undefined) return row.pool;
  const wf = repo.workflows.find((w) => workflowId(w) === row.workflow_id);
  return reviewPoolFor(repo, wf, getLoopPr(db, row.repo_id, prNumber)?.pool ?? row.pool);
}

/**
 * A reviewer job (repositories.<repo>.review) must not be run by the agent that wrote the code
 * under review while the pool has another enabled agent: that agent is excluded from the pick,
 * and the job waits for one of the others to have capacity. When the pool has no other enabled
 * agent, the author reviews its own work only if the repository says so
 * (review: { allowSameAgent: true }); otherwise the job cannot be routed (`problem`).
 */
function reviewerExclusion(config: UpdraftConfig, row: JobRow, poolAgents: readonly string[]): { exclude: string | null; problem?: string } {
  if (!isReviewJobRow(row)) return { exclude: null };
  let author: string | null;
  try {
    author = reviewOf(rowToJob(row))?.authorAgent ?? null;
  } catch {
    author = null;
  }
  if (!author) return { exclude: null };
  const others = poolAgents.filter((a) => a !== author && ownEntry(config.agents, a)?.enabled);
  if (others.length > 0) return { exclude: author };
  const repo = Object.values(config.repositories).find((r) => r.id === row.repo_id);
  if (repo && reviewSettings(repo).allowSameAgent) return { exclude: null };
  return {
    exclude: author,
    problem:
      `pool "${row.pool}" has no enabled agent other than "${author}", which wrote the code under review; add another agent to the review pool, ` +
      'or set review: { allowSameAgent: true } for the repository',
  };
}

/**
 * Atomically pick the oldest claimable queued job and start a run for it on an
 * eligible agent with capacity, honoring the global limit, per-agent limits
 * (across pools and repos), round-robin order per pool, and at most one running
 * job per (repo, issue). A revision job belongs to the issue of the PR it revises, so it also
 * waits for that issue's other jobs, and for an earlier revision whose push has not settled.
 * A reviewer job is the same, and is never given to the agent that wrote the code it reviews
 * while another agent can take it (reviewerExclusion).
 * Returns null when nothing can start now.
 *
 * A queued job whose pool or action is no longer in the config is marked
 * `failed` with a reason and an error row (never silently dropped); the user can
 * `updraft retry` it after fixing the config. Jobs in `excludeJobIds` are skipped.
 *
 * With `lockWorkerId`, the claim first checks, inside the same transaction, that this
 * worker still holds the single-worker lock, and throws WorkerLockLostError otherwise.
 * A worker whose lock was taken over can never start new work.
 *
 * `hostname` is recorded on the run so a later worker only signals the run's agent pid
 * when it is on the same host.
 */
export function claimNextJob(
  db: Db,
  config: UpdraftConfig,
  opts: {
    workerId: string;
    /** Host the claiming worker runs on (os.hostname()). */
    hostname: string;
    leaseSeconds: number;
    runsDir: string;
    now?: () => number;
    excludeJobIds?: ReadonlySet<string>;
    lockWorkerId?: string;
    /**
     * Count only this worker's own open runs towards the limits and the one-job-per-issue rule.
     * For a single-event run on a state database shared between machines (drain.ts): open runs
     * of other workers in it are another machine's, or were, and this process cannot tell which.
     */
    ownRunsOnly?: boolean;
  },
): Claim | null {
  const clock = opts.now ?? Date.now;
  const ownedBy = opts.ownRunsOnly ? opts.workerId : null;
  return transaction(db, () => {
    if (opts.lockWorkerId !== undefined && !holdsWorkerLock(db, opts.lockWorkerId)) {
      throw new WorkerLockLostError(opts.lockWorkerId);
    }
    const open = (db.prepare('SELECT count(*) AS n FROM runs WHERE ended_at IS NULL AND (? IS NULL OR worker_id = ?)').get(ownedBy, ownedBy) as { n: number }).n;
    if (open >= config.maxConcurrent) return null;

    const load = runningByAgent(db, ownedBy);
    const cooldowns = config.capacity ? activeCooldowns(db, clock()) : [];
    const blocked = config.capacity ? (name: string) => capacityBlock(config, name, cooldowns, load) : null;
    const busyIssues = new Set(
      (
        db
          .prepare(
            `SELECT DISTINCT repo_id, issue_number FROM jobs
             WHERE (? IS NULL AND status = 'running') OR id IN (SELECT job_id FROM runs WHERE ended_at IS NULL AND (? IS NULL OR worker_id = ?))`,
          )
          .all(ownedBy, ownedBy, ownedBy) as { repo_id: number; issue_number: number }[]
      ).map((r) => issueKey(r.repo_id, r.issue_number)),
    );
    // A revision starts from the PR branch's remote head: it must not start while the previous
    // revision's commits are still on their way there.
    for (const r of issuesAwaitingRevisionPush(db, clock)) busyIssues.add(issueKey(r.repoId, r.issueNumber));
    const queued = db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, rowid").all() as unknown as JobRow[];
    const nowMs = clock();
    const at = new Date(nowMs).toISOString();

    for (const queuedRow of queued) {
      if (opts.excludeJobIds?.has(queuedRow.id)) continue;
      if (busyIssues.has(issueKey(queuedRow.repo_id, queuedRow.issue_number))) continue;

      let row = queuedRow;
      if (isReviewJobRow(row)) {
        const route = currentReviewPool(db, config, row);
        if (route !== row.pool) {
          db.prepare('UPDATE jobs SET pool = ?, updated_at = ? WHERE id = ?').run(route, at, row.id);
          row = { ...row, pool: route, updated_at: at };
        }
      }

      const pool = ownEntry(config.pools, row.pool);
      if (!pool) {
        failUnroutable(db, row, `pool "${row.pool}" is no longer configured`, at);
        continue;
      }
      if (!ownEntry(config.actions, row.action)) {
        failUnroutable(db, row, `action "${row.action}" is no longer configured`, at);
        continue;
      }

      const reviewer = reviewerExclusion(config, row, pool.agents);
      if (reviewer.problem) {
        failUnroutable(db, row, reviewer.problem, at);
        continue;
      }
      const blockedReasons: string[] = [];
      const agent = pickAgent(db, config, row, cursorKey(row), pool.agents, load, reviewer.exclude, blocked, blockedReasons);
      if (!agent) {
        // Saturated, or held back by capacity policy. Say so on the job (once) so `status` can explain the wait.
        if (blockedReasons.length) {
          const waiting = `waiting: no eligible agent in pool "${row.pool}" (${blockedReasons.join('; ')})`.slice(0, 500);
          if (row.status_reason !== waiting) db.prepare('UPDATE jobs SET status_reason = ? WHERE id = ?').run(waiting, row.id);
        }
        continue; // later jobs in other pools may still start
      }

      const runId = newId('run');
      const runRow: RunRow = {
        id: runId,
        job_id: row.id,
        attempt: row.attempts + 1,
        pool: row.pool,
        agent,
        checkout_path: null,
        log_path: join(opts.runsDir, runId, 'run.log'),
        worker_id: opts.workerId,
        hostname: opts.hostname,
        pid: null,
        pid_start_time: null,
        lease_expires_at: new Date(nowMs + opts.leaseSeconds * 1000).toISOString(),
        started_at: at,
        execution_started_at: null,
        ended_at: null,
        outcome: null,
        error: null,
        summary: null,
        cancel_requested_at: null,
        container_runtime: null,
        container_name: null,
      };
      db.prepare(
        `INSERT INTO runs (id, job_id, attempt, pool, agent, checkout_path, log_path, worker_id, hostname, pid, lease_expires_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        runRow.id,
        runRow.job_id,
        runRow.attempt,
        runRow.pool,
        runRow.agent,
        runRow.checkout_path,
        runRow.log_path,
        runRow.worker_id,
        runRow.hostname,
        runRow.pid,
        runRow.lease_expires_at,
        runRow.started_at,
      );
      db.prepare(
        "UPDATE jobs SET status = 'running', status_reason = NULL, attempts = attempts + 1, updated_at = ? WHERE id = ?",
      ).run(at, row.id);
      return { job: rowToJob(getJobRow(db, row.id)!), run: rowToRun(runRow) };
    }
    return null;
  });
}

export function heartbeatRun(db: Db, runId: string, leaseSeconds: number, now?: () => number): void {
  const clock = now ?? Date.now;
  db.prepare('UPDATE runs SET lease_expires_at = ? WHERE id = ? AND ended_at IS NULL').run(
    new Date(clock() + leaseSeconds * 1000).toISOString(),
    runId,
  );
}

export interface RunProcessInfo {
  /** Agent pid. Setting it clears any start time recorded for an earlier pid. */
  pid?: number | null;
  /** OS start time of `pid` (see processStartTime); recorded once known, right after the pid. */
  pidStartTime?: string | null;
  checkoutPath?: string | null;
  /** The container about to be started for the run (see Run.container); recorded before it starts. */
  container?: RunContainer | null;
}

/** Record the agent subprocess and/or checkout for a running run (used by live adapters and reconcile). */
export function setRunProcess(db: Db, runId: string, info: RunProcessInfo, now: () => number = Date.now): void {
  if (info.pid !== undefined) {
    // agent_started_at: the first time a pid is recorded is when the agent process was spawned.
    db.prepare('UPDATE runs SET pid = ?, pid_start_time = ?, agent_started_at = coalesce(agent_started_at, ?) WHERE id = ?').run(
      info.pid,
      info.pidStartTime ?? null,
      info.pid === null ? null : nowIso(now),
      runId,
    );
  } else if (info.pidStartTime !== undefined) {
    db.prepare('UPDATE runs SET pid_start_time = ? WHERE id = ?').run(info.pidStartTime, runId);
  }
  if (info.checkoutPath !== undefined)
    db.prepare('UPDATE runs SET checkout_path = ? WHERE id = ?').run(info.checkoutPath, runId);
  if (info.container !== undefined)
    db.prepare('UPDATE runs SET container_runtime = ?, container_name = ? WHERE id = ?').run(
      info.container?.runtime ?? null,
      info.container?.name ?? null,
      runId,
    );
}

/** Store the post-run summary of a live agent run. */
export function setRunSummary(db: Db, runId: string, summary: RunSummary): void {
  db.prepare('UPDATE runs SET summary = ? WHERE id = ?').run(JSON.stringify(summary), runId);
}

/**
 * Mark a claimed run as executing, immediately before the worker hands it to the executor.
 * Atomic with the lock check: succeeds only while the run is open, not yet started, not
 * canceled by the user, and `workerId` still holds the worker lock. Returns the timestamp, or
 * null if the worker must not start it (the user canceled it, or the lock changed hands and the
 * new holder may already have requeued it).
 */
export function markExecutionStarted(db: Db, runId: string, opts: { workerId: string; now?: () => number }): string | null {
  const at = nowIso(opts.now ?? Date.now);
  const res = db
    .prepare(
      `UPDATE runs SET execution_started_at = ?
       WHERE id = ? AND ended_at IS NULL AND execution_started_at IS NULL AND cancel_requested_at IS NULL
         AND EXISTS (SELECT 1 FROM worker_lock WHERE id = 1 AND worker_id = ?)`,
    )
    .run(at, runId, opts.workerId);
  return Number(res.changes) > 0 ? at : null;
}

export function getRun(db: Db, runId: string): Run | null {
  const row = getRunRow(db, runId);
  return row ? rowToRun(row) : null;
}

export function getJob(db: Db, jobId: string): Job | null {
  const row = getJobRow(db, jobId);
  return row ? rowToJob(row) : null;
}

export function listOpenRuns(db: Db): Run[] {
  return (db.prepare('SELECT * FROM runs WHERE ended_at IS NULL ORDER BY started_at').all() as unknown as RunRow[]).map(rowToRun);
}

/** How finishRun closed a run. `outcome` is null when the run ended as canceled by the user. */
export interface FinishedRun {
  outcome: RunOutcome | null;
  canceledByUser: boolean;
}

/**
 * Close a run and move its job to the matching terminal state (or back to queued for start_failed).
 *
 * - succeeded / failed / interrupted: job gets the same status (checkout and log are kept).
 * - start_failed: the slot is released and the job requeued so another eligible agent is
 *   tried; after MAX_START_FAILURES consecutive start failures the job is marked failed.
 * - the user asked to cancel the run (`updraft cancel` set cancel_requested_at): whatever
 *   `result.outcome` says, the run closes with no outcome and the job is 'canceled'. The request
 *   and this close are both transactions, so exactly one wins: a request recorded before the run
 *   closed is always honored (never requeued, never published), and one that arrives after sees a
 *   job that is no longer running.
 *
 * Idempotent: closing an already-closed run is a no-op and returns null. Only a job still
 * `running` is moved.
 */
/**
 * What the worker's policy decided to do with a failed run instead of leaving its job failed
 * (docs/capacity-and-escalation.md). The run itself is still recorded as an ordinary failed run
 * whose error explains why; the job goes back in the queue.
 */
export type FailureHandling =
  | {
      kind: 'usage-limit';
      cooldown: CapacityKey & { untilMs: number; stated: boolean };
      /** Times one job may be put back by usage limits before it fails. */
      maxDeferrals: number;
      detail: string;
    }
  | { kind: 'escalate'; fromTier: string; toTier: string; pool: string; reason: string; source: string };

export function finishRun(
  db: Db,
  runId: string,
  result: { outcome: RunOutcome; error?: string | null; now?: () => number; handling?: FailureHandling },
): FinishedRun | null {
  const at = nowIso(result.now ?? Date.now);
  return transaction(db, () => {
    const run = getRunRow(db, runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.ended_at !== null) return null;
    const error = result.error ?? null;

    if (run.cancel_requested_at !== null) {
      // An executor that was stopped reports 'interrupted'; anything else means the agent had
      // already exited when the request was noticed, which is worth keeping on the run.
      const detail =
        result.outcome === 'interrupted' ? '' : ` (the run had already ended: ${result.outcome}${error ? `, ${error}` : ''})`;
      db.prepare('UPDATE runs SET ended_at = ?, outcome = NULL, error = ? WHERE id = ?').run(at, `${CANCELED_BY_USER}${detail}`, runId);
      db.prepare("UPDATE jobs SET status = 'canceled', status_reason = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(
        CANCELED_BY_USER,
        at,
        run.job_id,
      );
      noteRunEnded(db, runId);
      noteJobFinished(db, run.job_id);
      return { outcome: null, canceledByUser: true };
    }

    db.prepare('UPDATE runs SET ended_at = ?, outcome = ?, error = ? WHERE id = ?').run(at, result.outcome, error, runId);
    noteRunEnded(db, runId);
    const finished: FinishedRun = { outcome: result.outcome, canceledByUser: false };

    const job = getJobRow(db, run.job_id);
    if (!job || job.status !== 'running') return finished;

    let status: JobStatus;
    let reason: string | null;
    switch (result.outcome) {
      case 'succeeded':
        status = 'succeeded';
        reason = null;
        break;
      case 'failed':
        status = 'failed';
        reason = error ?? `run ${runId} on ${run.agent} failed`;
        if (result.handling) {
          const h = result.handling;
          const nowMs = (result.now ?? Date.now)();
          if (h.kind === 'usage-limit') {
            setCooldown(db, { ...h.cooldown, reason: h.detail, jobId: job.id, runId, nowMs });
            recordPolicyEvent(db, {
              kind: 'cooldown',
              jobId: job.id,
              runId,
              detail: `${h.cooldown.scope} "${h.cooldown.name}" cooling down until ${new Date(h.cooldown.untilMs).toISOString()} (${h.cooldown.stated ? 'retry-after stated by the CLI' : 'configured default'}): ${h.detail}`,
              now: result.now,
            });
            if (job.deferrals + 1 > h.maxDeferrals) {
              reason = `usage limit hit ${job.deferrals + 1} times (cap ${h.maxDeferrals}); not requeued: ${h.detail}`;
              recordPolicyEvent(db, { kind: 'exhausted', jobId: job.id, runId, detail: reason, now: result.now });
            } else {
              db.prepare('UPDATE jobs SET deferrals = deferrals + 1 WHERE id = ?').run(job.id);
              status = 'queued';
              reason = `waiting: ${run.agent} hit a usage limit; ${h.cooldown.scope} "${h.cooldown.name}" cools down until ${new Date(h.cooldown.untilMs).toISOString()}`;
              recordPolicyEvent(db, { kind: 'deferred', jobId: job.id, runId, detail: `requeued after a usage limit on ${run.agent} (deferral ${job.deferrals + 1} of ${h.maxDeferrals})`, now: result.now });
            }
          } else {
            db.prepare('UPDATE jobs SET pool = ?, escalation_hops = escalation_hops + 1 WHERE id = ?').run(h.pool, job.id);
            status = 'queued';
            reason = `escalated ${h.fromTier} -> ${h.toTier} (pool ${h.pool}): ${h.reason}`;
            recordPolicyEvent(db, { kind: 'escalated', jobId: job.id, runId, detail: `${h.source}: ${reason}`, now: result.now });
          }
        }
        break;
      case 'interrupted':
        status = 'interrupted';
        reason = error ?? `run ${runId} on ${run.agent} was interrupted`;
        break;
      case 'start_failed': {
        const count = job.start_failures + 1;
        db.prepare('UPDATE jobs SET start_failures = ? WHERE id = ?').run(count, job.id);
        const detail = error ?? 'unknown error';
        if (count >= MAX_START_FAILURES) {
          status = 'failed';
          reason = `no agent could start after ${count} attempts; last error on ${run.agent}: ${detail}`;
        } else {
          status = 'queued';
          reason = `${run.agent} could not start (${detail}); requeued for another agent`;
        }
        break;
      }
    }
    db.prepare('UPDATE jobs SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?').run(
      status,
      reason,
      at,
      job.id,
    );
    noteJobFinished(db, job.id);
    if (result.outcome !== 'succeeded') {
      recordError(db, {
        scope: 'worker',
        repoFullName: job.repo_full_name,
        jobId: job.id,
        message: `run ${runId} (${run.agent}) ${result.outcome}: ${reason}`,
        at,
      });
    }
    return finished;
  });
}

function closeClaim(db: Db, runId: string, jobStatus: 'canceled' | 'queued', reason: string, now?: () => number): void {
  const at = nowIso(now ?? Date.now);
  transaction(db, () => {
    const run = getRunRow(db, runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.ended_at !== null) return;
    // A user cancel recorded while the run was claimed wins over requeueing it, and over the
    // pre-start check's own reason: the job must not come back on its own.
    if (run.cancel_requested_at !== null) {
      jobStatus = 'canceled';
      reason = CANCELED_BY_USER;
    }
    // outcome stays NULL: the agent never started, so this is not an agent failure.
    db.prepare('UPDATE runs SET ended_at = ?, error = ? WHERE id = ?').run(
      at,
      `${jobStatus === 'canceled' ? 'canceled' : 'released'} before start: ${reason}`,
      runId,
    );
    db.prepare("UPDATE jobs SET status = ?, status_reason = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(
      jobStatus,
      reason,
      at,
      run.job_id,
    );
    noteRunEnded(db, runId);
    noteJobFinished(db, run.job_id);
  });
}

/**
 * The pre-start check rejected a claimed job (issue closed or dispatch label removed):
 * cancel the job with the reason and close the run with no outcome (not an agent failure).
 */
export function cancelClaim(db: Db, runId: string, reason: string, now?: () => number): void {
  closeClaim(db, runId, 'canceled', reason, now);
}

/**
 * Give a claimed job back to the queue without starting it (e.g. the pre-start
 * check could not reach GitHub, or the worker is stopping). The run closes with no outcome.
 */
export function releaseClaim(db: Db, runId: string, reason: string, now?: () => number): void {
  closeClaim(db, runId, 'queued', reason, now);
}

/**
 * Deliberately requeue a failed, interrupted or canceled job and reset its start-failure
 * count, so it gets a fresh MAX_START_FAILURES budget. Throws for other states.
 */
export function retryJob(db: Db, jobId: string, now?: () => number): Job {
  const at = nowIso(now ?? Date.now);
  return transaction(db, () => {
    const row = getJobRow(db, jobId);
    if (!row) throw new Error(`job ${jobId} not found`);
    if (!RETRYABLE.includes(row.status)) {
      throw new Error(`job ${jobId} is ${row.status}; only failed, interrupted or canceled jobs can be retried`);
    }
    const held = (JSON.parse(row.envelope) as { routing?: { hold?: string } }).routing?.hold;
    if (held) {
      throw new Error(
        `job ${jobId} was held for a human (${held}); retrying would run it on a pool that was not eligible. ` +
          'Add a tier override label (or fix the pools) and re-apply the trigger label to queue a new job.',
      );
    }
    db.prepare(
      "UPDATE jobs SET status = 'queued', status_reason = ?, start_failures = 0, retries = retries + 1, updated_at = ? WHERE id = ?",
    ).run(`retried by user (was ${row.status})`, at, jobId);
    return rowToJob(getJobRow(db, jobId)!);
  });
}

export type CancelRequest =
  /** The job was queued; it is canceled now. */
  | { kind: 'canceled'; job: Job }
  /** The job is running under a live worker; the request is recorded on `run` for the worker to act on. */
  | { kind: 'requested'; job: Job; run: Run; alreadyRequested: boolean }
  /** The job is 'running' but no live worker owns its run, so nobody would act on a request. Nothing changed. */
  | { kind: 'stale'; job: Job; run: Run | null }
  /** The job already reached a terminal state. Nothing changed. */
  | { kind: 'terminal'; job: Job }
  | { kind: 'not-found' };

/**
 * `updraft cancel`: cancel a queued job directly, or record a cancel request on the open run of
 * a running one. One transaction, so it serializes with the worker closing the run (finishRun,
 * closeClaim), a lock takeover and `updraft retry`: the job is judged by the state it has when
 * this commits, and the request lands on the run that is open at that moment and no other.
 *
 * A request is only recorded while the worker that claimed the run holds a fresh lock. Otherwise
 * the run is a leftover that the next worker's reconcile closes, and a recorded request would
 * only claim something that is not going to happen.
 */
export function requestJobCancel(db: Db, jobId: string, now?: () => number): CancelRequest {
  const clock = now ?? Date.now;
  const at = nowIso(clock);
  return transaction(db, (): CancelRequest => {
    const row = getJobRow(db, jobId);
    if (!row) return { kind: 'not-found' };
    if (row.status === 'queued') {
      db.prepare("UPDATE jobs SET status = 'canceled', status_reason = ?, updated_at = ? WHERE id = ?").run(CANCELED_BY_USER, at, jobId);
      noteJobFinished(db, jobId);
      return { kind: 'canceled', job: rowToJob(getJobRow(db, jobId)!) };
    }
    const job = rowToJob(row);
    if (row.status !== 'running') return { kind: 'terminal', job };

    const runRow = db
      .prepare('SELECT * FROM runs WHERE job_id = ? AND ended_at IS NULL ORDER BY attempt DESC LIMIT 1')
      .get(jobId) as RunRow | undefined;
    if (!runRow) return { kind: 'stale', job, run: null };
    const lock = db.prepare('SELECT worker_id, heartbeat_at FROM worker_lock WHERE id = 1').get() as
      | { worker_id: string; heartbeat_at: string }
      | undefined;
    const owned = lock !== undefined && lock.worker_id === runRow.worker_id && clock() - Date.parse(lock.heartbeat_at) <= WORKER_STALE_MS;
    if (!owned) return { kind: 'stale', job, run: rowToRun(runRow) };

    const alreadyRequested = runRow.cancel_requested_at !== null;
    if (!alreadyRequested) db.prepare('UPDATE runs SET cancel_requested_at = ? WHERE id = ?').run(at, runRow.id);
    return { kind: 'requested', job, run: rowToRun(getRunRow(db, runRow.id)!), alreadyRequested };
  });
}

/** Open runs the user asked to cancel; the worker aborts the ones it is executing. */
export function listCancelRequestedRuns(db: Db): string[] {
  return (
    db.prepare('SELECT id FROM runs WHERE ended_at IS NULL AND cancel_requested_at IS NOT NULL').all() as { id: string }[]
  ).map((r) => r.id);
}

/** The newest run of a job (by attempt), or null if it never had one. */
export function latestRunOfJob(db: Db, jobId: string): Run | null {
  const row = db.prepare('SELECT * FROM runs WHERE job_id = ? ORDER BY attempt DESC, started_at DESC LIMIT 1').get(jobId) as
    | RunRow
    | undefined;
  return row ? rowToRun(row) : null;
}

export interface AgentLoad {
  agent: string;
  enabled: boolean;
  running: number;
  maxConcurrent: number;
}

export interface StatusSnapshot {
  worker: { workerId: string; pid: number; hostname: string; startedAt: string; heartbeatAt: string; stale: boolean } | null;
  counts: Record<JobStatus, number>;
  agents: AgentLoad[];
  activeRuns: Array<{ run: Run; job: Job }>;
  recentJobs: Job[];
  /** Finished live agent runs (those with a summary), newest first. */
  recentAgentRuns: Array<{ run: Run; job: Job }>;
  recentErrors: Array<{ at: string; scope: string; repoFullName: string | null; jobId: string | null; message: string }>;
  checkpoints: Array<{ repoId: number; fullName: string; lastEventId: number | null; updatedAt: string }>;
  /** Recent publications (pushed branches and PRs), newest first. */
  publications?: Publication[];
  /** Recent failure comments (posted, pending or not posted), newest first. */
  failureComments?: FailureComment[];
  /** Recent revision pushes and replies (repositories.<repo>.revise), newest first. */
  revisions?: Revision[];
  /** Recent change requests on watched PRs and what was decided about each, newest first. */
  reviewRequests?: ReviewRequest[];
  /** PRs that reached maxRevisions, newest first. */
  limitedPullRequests?: RevisionPr[];
  /** Watched PRs with their stage in the review loop (repositories.<repo>.review), most recently changed first. */
  pullRequests?: Array<{ pr: LoopPr; stage: PrStageInfo }>;
  /** Recent reviewer verdicts and their posting, newest first. */
  reviews?: PrReview[];
  /** Capacity groups or profiles cooling down after a usage limit, with when they wake (docs/capacity-and-escalation.md). */
  cooldowns?: Cooldown[];
  /** Recent cooldowns, deferrals and escalations by job and run, oldest first. */
  policyEvents?: PolicyEvent[];
}

export function getStatusSnapshot(db: Db, config: UpdraftConfig, now?: () => number): StatusSnapshot {
  const nowMs = (now ?? Date.now)();

  const lock = db.prepare('SELECT * FROM worker_lock WHERE id = 1').get() as
    | { worker_id: string; pid: number; hostname: string; started_at: string; heartbeat_at: string }
    | undefined;
  const worker = lock
    ? {
        workerId: lock.worker_id,
        pid: lock.pid,
        hostname: lock.hostname,
        startedAt: lock.started_at,
        heartbeatAt: lock.heartbeat_at,
        stale: nowMs - Date.parse(lock.heartbeat_at) > WORKER_STALE_MS,
      }
    : null;

  const counts = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
  for (const r of db.prepare('SELECT status, count(*) AS n FROM jobs GROUP BY status').all() as {
    status: JobStatus;
    n: number;
  }[]) {
    counts[r.status] = r.n;
  }

  const load = runningByAgent(db);
  const agents: AgentLoad[] = Object.entries(config.agents).map(([agent, cfg]) => ({
    agent,
    enabled: cfg.enabled,
    running: load.get(agent) ?? 0,
    maxConcurrent: cfg.maxConcurrent,
  }));
  // Runs still open on agents that were removed from the config stay visible.
  for (const [agent, running] of load) {
    if (!ownEntry(config.agents, agent)) agents.push({ agent, enabled: false, running, maxConcurrent: 0 });
  }

  const activeRuns = listOpenRuns(db).map((run) => ({ run, job: rowToJob(getJobRow(db, run.jobId)!) }));

  const recentJobs = (
    db.prepare('SELECT * FROM jobs ORDER BY updated_at DESC, rowid DESC LIMIT 10').all() as unknown as JobRow[]
  ).map(rowToJob);

  const recentAgentRuns = (
    db
      .prepare('SELECT * FROM runs WHERE ended_at IS NOT NULL AND summary IS NOT NULL ORDER BY ended_at DESC, rowid DESC LIMIT 5')
      .all() as unknown as RunRow[]
  ).map((row) => {
    const run = rowToRun(row);
    return { run, job: rowToJob(getJobRow(db, run.jobId)!) };
  });

  const recentErrors = (
    db.prepare('SELECT at, scope, repo_full_name, job_id, message FROM errors ORDER BY id DESC LIMIT 10').all() as {
      at: string;
      scope: string;
      repo_full_name: string | null;
      job_id: string | null;
      message: string;
    }[]
  ).map((e) => ({ at: e.at, scope: e.scope, repoFullName: e.repo_full_name, jobId: e.job_id, message: e.message }));

  const checkpoints = (
    db
      .prepare('SELECT repo_id, full_name, last_event_id, updated_at FROM repo_checkpoints ORDER BY full_name')
      .all() as { repo_id: number; full_name: string; last_event_id: number | null; updated_at: string }[]
  ).map((c) => ({ repoId: c.repo_id, fullName: c.full_name, lastEventId: c.last_event_id, updatedAt: c.updated_at }));

  const publications = listRecentPublications(db, 10);

  const failureComments = listRecentFailureComments(db, 10);

  return {
    worker,
    counts,
    agents,
    activeRuns,
    recentJobs,
    recentAgentRuns,
    recentErrors,
    checkpoints,
    publications,
    failureComments,
    revisions: listRecentRevisions(db, 10),
    reviewRequests: listRecentReviewRequests(db, 10),
    limitedPullRequests: listLimitedRevisionPrs(db, 10),
    // Only where the review loop is configured: without it a watched PR has no stage to speak of.
    pullRequests: listRecentLoopPrs(db, 20).flatMap((pr) => {
      const repo = Object.values(config.repositories).find((r) => r.id === pr.repoId);
      return repo && reviewSettings(repo).enabled ? [{ pr, stage: prStage(db, pr, repo.maxRevisions ?? DEFAULT_MAX_REVISIONS) }] : [];
    }),
    reviews: listRecentPrReviews(db, 10),
    // Only where capacity or escalation policy is in use (or has ever acted); otherwise absent.
    ...policySnapshot(db, config, nowMs),
  };
}

function policySnapshot(db: Db, config: UpdraftConfig, nowMs: number): Pick<StatusSnapshot, 'cooldowns' | 'policyEvents'> {
  try {
    return config.capacity || hasPolicyEvents(db) ? { cooldowns: activeCooldowns(db, nowMs), policyEvents: listRecentPolicyEvents(db, 10) } : {};
  } catch {
    return {}; // a database from before the tables existed (status reads without migrating)
  }
}

function hasPolicyEvents(db: Db): boolean {
  try {
    return db.prepare('SELECT 1 FROM policy_events LIMIT 1').get() !== undefined;
  } catch {
    return false; // a database from before the table existed
  }
}
