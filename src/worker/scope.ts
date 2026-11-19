// What one event's run may touch in a state database that is shared between machines.
// Behind `updraft run-event` (docs/run-event.md, docs/shared-state.md).
//
// The long-running worker owns its whole database: every queued job is its to run, every due
// retry its to make. A single-event run starts from a snapshot of a database that many such runs
// write to, so most of what it finds belongs to other events, handled by other machines that may
// still be at it. Its own part is:
// - the jobs of its event (queued by it, or found queued for it), and
// - the pull requests those jobs opened, or that the event is about, with everything the review
//   loop hangs off a pull request: reviewer jobs, revision jobs, review postings, revision
//   pushes, the merge.
// Everything else in the database is read and never changed.
import { autoMergeMethod, reviseActive, type UpdraftConfig } from '../config/schema.js';
import { activeCooldowns } from '../db/capacity.js';
import type { Db } from '../db/database.js';
import { listMergeCandidates, listPendingMergeNotices, type LoopPr } from '../db/pr-reviews.js';
import { getJob, getRun } from '../db/queue.js';
import { listPendingLimitNotices, REVISION_MAX_AUTO_ATTEMPTS } from '../db/revisions.js';
import { MAX_NOTICE_ATTEMPTS } from '../publish/merge.js';
import type { PublishScope } from '../publish/publish.js';
import { reviewOf, revisionOf } from '../types.js';

export interface EventScope extends PublishScope {
  /** True for a job of the event, and for a reviewer or revision job of a pull request in scope. */
  job(jobId: string): boolean;
  addJob(jobId: string): void;
  addPr(repoId: number, prNumber: number): void;
  /** The pull requests in scope that the database watches, by (repository id, number). */
  prs(): Array<{ repoId: number; prNumber: number }>;
}

const prKey = (repoId: number, prNumber: number) => `${repoId}#${prNumber}`;

export function createEventScope(db: Db): EventScope {
  const jobs = new Set<string>();
  const prs = new Set<string>();
  const sourceJob = db.prepare('SELECT r.job_id FROM revision_prs w JOIN runs r ON r.id = w.source_run_id WHERE w.repo_id = ? AND w.pr_number = ?');
  const pr = (repoId: number, prNumber: number): boolean => {
    if (prs.has(prKey(repoId, prNumber))) return true;
    const row = sourceJob.get(repoId, prNumber) as { job_id: string } | undefined;
    return row !== undefined && jobs.has(row.job_id);
  };
  const job = (jobId: string): boolean => {
    if (jobs.has(jobId)) return true;
    let found;
    try {
      found = getJob(db, jobId);
    } catch {
      return false; // an envelope that cannot be read is not this event's
    }
    if (!found) return false;
    const n = reviewOf(found)?.pullRequest.number ?? revisionOf(found)?.pullRequest.number;
    return n !== undefined && pr(found.repoId, n);
  };
  return {
    job,
    pr,
    run(runId) {
      const run = getRun(db, runId);
      return run !== null && job(run.jobId);
    },
    addJob: (jobId) => void jobs.add(jobId),
    addPr: (repoId, prNumber) => void prs.add(prKey(repoId, prNumber)),
    prs() {
      const all = db.prepare('SELECT repo_id, pr_number FROM revision_prs').all() as Array<{ repo_id: number; pr_number: number }>;
      return all.filter((r) => pr(r.repo_id, r.pr_number)).map((r) => ({ repoId: r.repo_id, prNumber: r.pr_number }));
    },
  };
}

/** Tables whose rows carry a retry the worker makes on its own (publish.ts, failure-comment.ts, revision.ts, review.ts). */
const RETRY_TABLES = ['publications', 'failure_comments', 'revisions', 'pr_reviews'] as const;

/** When the earliest scheduled retry is due (epoch millis), within `scope` when one is given, or null when none is scheduled. */
export function nextRetryAt(db: Db, scope: Pick<EventScope, 'run'> | null = null): number | null {
  let next: number | null = null;
  for (const table of RETRY_TABLES) {
    const rows = db.prepare(`SELECT run_id, next_attempt_at FROM ${table} WHERE state = 'failed' AND retryable = 1 AND next_attempt_at IS NOT NULL`).all() as Array<{
      run_id: string;
      next_attempt_at: string;
    }>;
    for (const r of rows) {
      const at = Date.parse(r.next_attempt_at);
      if (Number.isFinite(at) && (next === null || at < next) && (scope?.run(r.run_id) ?? true)) next = at;
    }
  }
  return next;
}

export interface PendingWork {
  /** Queued jobs, each with how often it failed to start: unchanged while nothing makes progress on them. */
  queued: Array<{ id: string; startFailures: number; waiting: boolean }>;
  /** When the earliest scheduled retry is due (epoch millis), or null when none is scheduled. */
  nextRetryAt: number | null;
  /** Pull requests whose auto-merge has not settled: still to be evaluated, waiting for checks, or sent without an answer. */
  merges: LoopPr[];
  /** Comments that say why a pull request was not merged, or that it reached maxRevisions, still to be posted. */
  notices: number;
  /**
   * When the earliest usage-limit cooldown in force ends (epoch millis), if a queued job is
   * waiting for capacity; null otherwise.
   */
  cooldownEndsAt: number | null;
}

/** What is left to do in `db`, within `scope` when one is given. Local state only. */
export function pendingWork(db: Db, config: UpdraftConfig, scope: EventScope | null, now: () => number = Date.now): PendingWork {
  const inScope = { job: (id: string) => scope?.job(id) ?? true, run: (id: string) => scope?.run(id) ?? true, pr: (r: number, n: number) => scope?.pr(r, n) ?? true };
  const queued = (db.prepare("SELECT id, start_failures, status_reason FROM jobs WHERE status = 'queued' ORDER BY id").all() as Array<{ id: string; start_failures: number; status_reason: string | null }>)
    .filter((r) => inScope.job(r.id))
    .map((r) => ({ id: r.id, startFailures: r.start_failures, waiting: r.status_reason?.startsWith('waiting:') ?? false }));

  const nextRetry = nextRetryAt(db, scope);

  const merges: LoopPr[] = [];
  let notices = 0;
  const repos = new Map(Object.values(config.repositories).map((cfg) => [cfg.id, cfg]));
  for (const cfg of repos.values()) {
    if (!autoMergeMethod(config, cfg)) continue;
    merges.push(...listMergeCandidates(db, cfg.id).filter((pr) => inScope.pr(pr.repoId, pr.prNumber)));
  }
  // The same conditions under which merge.ts and revision.ts post them: a notice nobody will post is not pending.
  for (const pr of listPendingMergeNotices(db, MAX_NOTICE_ATTEMPTS)) {
    const cfg = repos.get(pr.repoId);
    if (cfg && autoMergeMethod(config, cfg) && pr.mergeSha && inScope.pr(pr.repoId, pr.prNumber)) notices++;
  }
  for (const pr of listPendingLimitNotices(db, REVISION_MAX_AUTO_ATTEMPTS)) {
    const cfg = repos.get(pr.repoId);
    if (cfg && reviseActive(config, cfg) && inScope.pr(pr.repoId, pr.prNumber)) notices++;
  }

  let cooldownEndsAt: number | null = null;
  if (config.capacity && queued.some((j) => j.waiting)) {
    const first = activeCooldowns(db, now())[0];
    if (first) cooldownEndsAt = Date.parse(first.until);
  }
  return { queued, nextRetryAt: nextRetry, merges, notices, cooldownEndsAt };
}

/** True when nothing in `p` is left that a worker would act on. */
export function nothingPending(p: PendingWork): boolean {
  return p.queued.length === 0 && p.nextRetryAt === null && p.merges.length === 0 && p.notices === 0;
}
