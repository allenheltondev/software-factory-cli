// Persistence for waits on a pull request in another repository (repositories.<repo>.dependencies,
// docs/dependencies.md). A wait is recorded together with the run that declared it (finishRun),
// checked by src/poller/dependencies.ts, and ends exactly once: resumed (the pull request was
// merged and a follow-up job queued), closed (closed without merging, or no longer readable),
// canceled (the issue or the config no longer asks for the work, or `updraft cancel`) or expired.
import type { DependencyResume, EventEnvelope, Job } from '../types.js';
import { newId, nowIso } from '../util/ids.js';
import { rowToJob, transaction, type Db, type JobRow } from './database.js';
import { noteDependencyEnded, noteDependencyWaiting } from './metrics.js';

export type DependencyWaitState = 'waiting' | 'resumed' | 'closed' | 'canceled' | 'expired';

/** Attempts (first try included) at each issue comment before the worker gives up on it. */
export const WAIT_COMMENT_MAX_ATTEMPTS = 5;

/** The longest the agent's note can be, as stored and as given to the follow-up run. */
export const MAX_WAIT_NOTE = 4_000;

export interface DependencyWait {
  runId: string;
  jobId: string;
  repoId: number;
  repoFullName: string;
  issueNumber: number;
  workflowId: string;
  originalEventId: string;
  /** Waits in this chain, this one included. */
  waits: number;
  depRepo: string;
  depRepoId: number | null;
  depNumber: number;
  depUrl: string;
  /** Untrusted text, as last read from GitHub. */
  depTitle: string | null;
  /** Untrusted text: the waiting run's final message without its UPDRAFT-WAITING-ON line. */
  note: string;
  state: DependencyWaitState;
  reason: string | null;
  checks: number;
  failures: number;
  lastError: string | null;
  lastCheckedAt: string | null;
  nextCheckAt: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  resumeJobId: string | null;
  waitComment: { id: number | null; url: string | null; attempts: number; error: string | null };
  endComment: { id: number | null; url: string | null; attempts: number; error: string | null };
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

interface DependencyWaitRow {
  run_id: string;
  job_id: string;
  repo_id: number;
  repo_full_name: string;
  issue_number: number;
  workflow_id: string;
  original_event_id: string;
  waits: number;
  dep_repo: string;
  dep_repo_id: number | null;
  dep_number: number;
  dep_url: string;
  dep_title: string | null;
  note: string;
  state: DependencyWaitState;
  reason: string | null;
  checks: number;
  failures: number;
  last_error: string | null;
  last_checked_at: string | null;
  next_check_at: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  resume_job_id: string | null;
  wait_comment_id: number | null;
  wait_comment_url: string | null;
  wait_comment_attempts: number;
  wait_comment_error: string | null;
  end_comment_id: number | null;
  end_comment_url: string | null;
  end_comment_attempts: number;
  end_comment_error: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

function rowToWait(r: DependencyWaitRow): DependencyWait {
  return {
    runId: r.run_id,
    jobId: r.job_id,
    repoId: r.repo_id,
    repoFullName: r.repo_full_name,
    issueNumber: r.issue_number,
    workflowId: r.workflow_id,
    originalEventId: r.original_event_id,
    waits: r.waits,
    depRepo: r.dep_repo,
    depRepoId: r.dep_repo_id,
    depNumber: r.dep_number,
    depUrl: r.dep_url,
    depTitle: r.dep_title,
    note: r.note,
    state: r.state,
    reason: r.reason,
    checks: r.checks,
    failures: r.failures,
    lastError: r.last_error,
    lastCheckedAt: r.last_checked_at,
    nextCheckAt: r.next_check_at,
    mergedAt: r.merged_at,
    mergeCommitSha: r.merge_commit_sha,
    resumeJobId: r.resume_job_id,
    waitComment: { id: r.wait_comment_id, url: r.wait_comment_url, attempts: r.wait_comment_attempts, error: r.wait_comment_error },
    endComment: { id: r.end_comment_id, url: r.end_comment_url, attempts: r.end_comment_attempts, error: r.end_comment_error },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    endedAt: r.ended_at,
  };
}

/** `OWNER/REPO#N`, the way the wait is named everywhere. */
export function dependencyRef(w: Pick<DependencyWait, 'depRepo' | 'depNumber'>): string {
  return `${w.depRepo}#${w.depNumber}`;
}

/** What a run declared, as the executor validated it against the config. */
export interface DeclaredDependency {
  /** OWNER/REPO as the config spells it. */
  repo: string;
  number: number;
  /** The run's final message without its UPDRAFT-WAITING-ON line. Untrusted text. */
  note: string;
}

/**
 * Record a wait for a run that just succeeded. Call inside the transaction that closes the run
 * (finishRun): the run then never exists as succeeded without its wait, so nothing publishes it in
 * between. `firstCheckAt` is when the pull request is first looked at.
 */
export function insertDependencyWait(
  db: Db,
  o: { runId: string; agent: string; job: JobRow; dependency: DeclaredDependency; firstCheckAt: string; at: string },
): void {
  const env = JSON.parse(o.job.envelope) as EventEnvelope;
  const resume = env.type === 'issue.labeled' ? env.resume : undefined;
  const d = o.dependency;
  db.prepare(
    `INSERT INTO dependency_waits
       (run_id, job_id, repo_id, repo_full_name, issue_number, workflow_id, original_event_id, waits,
        dep_repo, dep_number, dep_url, note, state, next_check_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?)
     ON CONFLICT (run_id) DO NOTHING`,
  ).run(
    o.runId,
    o.job.id,
    o.job.repo_id,
    o.job.repo_full_name,
    o.job.issue_number,
    o.job.workflow_id,
    resume?.originalEventId ?? o.job.event_id,
    (resume?.waits ?? 0) + 1,
    d.repo,
    d.number,
    `https://github.com/${d.repo}/pull/${d.number}`,
    d.note.length > MAX_WAIT_NOTE ? `${d.note.slice(0, MAX_WAIT_NOTE - 1)}…` : d.note,
    o.firstCheckAt,
    o.at,
    o.at,
  );
  noteDependencyWaiting(db, { runId: o.runId, jobId: o.job.id, repoId: o.job.repo_id, repoFullName: o.job.repo_full_name, agent: o.agent, at: o.at });
}

export function getDependencyWait(db: Db, runId: string): DependencyWait | null {
  const row = db.prepare('SELECT * FROM dependency_waits WHERE run_id = ?').get(runId) as DependencyWaitRow | undefined;
  return row ? rowToWait(row) : null;
}

/** The newest wait a job's runs declared, or null. */
export function waitOfJob(db: Db, jobId: string): DependencyWait | null {
  const row = db.prepare('SELECT * FROM dependency_waits WHERE job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(jobId) as
    | DependencyWaitRow
    | undefined;
  return row ? rowToWait(row) : null;
}

/** Waits whose next check is due, oldest due first. */
export function listDueWaits(db: Db, o: { now: () => number; limit: number }): DependencyWait[] {
  return (
    db
      .prepare("SELECT * FROM dependency_waits WHERE state = 'waiting' AND next_check_at <= ? ORDER BY next_check_at, rowid LIMIT ?")
      .all(nowIso(o.now), o.limit) as unknown as DependencyWaitRow[]
  ).map(rowToWait);
}

/**
 * Waits with an issue comment still to post: the "waiting" one while the wait still waits (once it
 * has ended it would only mislead), or for closed and expired waits the "stopped waiting" one.
 */
export function listPendingWaitComments(db: Db, limit = 20): DependencyWait[] {
  return (
    db
      .prepare(
        `SELECT * FROM dependency_waits
         WHERE (state = 'waiting' AND wait_comment_id IS NULL AND wait_comment_attempts < $max)
            OR (state IN ('closed', 'expired') AND end_comment_id IS NULL AND end_comment_attempts < $max)
         ORDER BY updated_at, rowid LIMIT $limit`,
      )
      .all({ max: WAIT_COMMENT_MAX_ATTEMPTS, limit }) as unknown as DependencyWaitRow[]
  ).map(rowToWait);
}

/** For `updraft status`: every wait still waiting, then the most recently ended ones. */
export function listStatusWaits(db: Db, endedLimit = 10): DependencyWait[] {
  const waiting = db.prepare("SELECT * FROM dependency_waits WHERE state = 'waiting' ORDER BY created_at, rowid").all() as unknown as DependencyWaitRow[];
  const ended = db
    .prepare("SELECT * FROM dependency_waits WHERE state <> 'waiting' ORDER BY coalesce(ended_at, updated_at) DESC, rowid DESC LIMIT ?")
    .all(endedLimit) as unknown as DependencyWaitRow[];
  return [...waiting, ...ended].map(rowToWait);
}

/** A check that found the pull request still open (or the issue still wanting it): when to look again. */
export function recordWaitChecked(
  db: Db,
  runId: string,
  o: { nextCheckAt: string; depRepoId?: number; depUrl?: string; depTitle?: string; now: () => number },
): void {
  const at = nowIso(o.now);
  db.prepare(
    `UPDATE dependency_waits SET checks = checks + 1, failures = 0, last_error = NULL, last_checked_at = ?, next_check_at = ?,
       dep_repo_id = coalesce(?, dep_repo_id), dep_url = coalesce(?, dep_url), dep_title = coalesce(?, dep_title), updated_at = ?
     WHERE run_id = ? AND state = 'waiting'`,
  ).run(at, o.nextCheckAt, o.depRepoId ?? null, o.depUrl ?? null, o.depTitle ?? null, at, runId);
}

/** A check that could not read GitHub: kept waiting, looked at again at `nextCheckAt`. */
export function recordWaitCheckFailed(db: Db, runId: string, o: { error: string; nextCheckAt: string; now: () => number }): void {
  const at = nowIso(o.now);
  db.prepare(
    `UPDATE dependency_waits SET checks = checks + 1, failures = failures + 1, last_error = ?, last_checked_at = ?, next_check_at = ?, updated_at = ?
     WHERE run_id = ? AND state = 'waiting'`,
  ).run(o.error, at, o.nextCheckAt, at, runId);
}

/**
 * End a wait without a follow-up. Only a wait that is still waiting ends: returns false when it had
 * already ended (a check and `updraft cancel` raced; the first one stands).
 */
export function endDependencyWait(
  db: Db,
  runId: string,
  o: { state: 'closed' | 'canceled' | 'expired'; reason: string; depTitle?: string; now: () => number },
): boolean {
  const at = nowIso(o.now);
  return transaction(db, () => {
    const res = db
      .prepare(
        `UPDATE dependency_waits SET state = ?, reason = ?, dep_title = coalesce(?, dep_title), ended_at = ?, updated_at = ?, last_checked_at = ?
         WHERE run_id = ? AND state = 'waiting'`,
      )
      .run(o.state, o.reason, o.depTitle ?? null, at, at, at, runId);
    if (Number(res.changes) === 0) return false;
    const w = getDependencyWait(db, runId)!;
    noteDependencyEnded(db, { runId, jobId: w.jobId, repoId: w.repoId, repoFullName: w.repoFullName, outcome: o.state, startAt: w.createdAt, at });
    return true;
  });
}

export type ResumeResult = { status: 'queued'; job: Job } | { status: 'already'; jobId: string | null } | { status: 'gone'; reason: string };

/**
 * The pull request was merged: queue the follow-up job and end the wait as resumed, in one
 * transaction. The job is a copy of the waiting job (same workflow, action, issue, routing, and the
 * pool and escalation hops it had reached), with event id "dep:<run id>", so the jobs unique key
 * (and pruned_events) gives one follow-up per wait across restarts. It is an ordinary queued job:
 * claims, concurrency limits, cooldowns and the pre-start check apply to it as to any other.
 */
export function resumeDependencyWait(
  db: Db,
  runId: string,
  o: { pullRequest: DependencyResume['pullRequest']; now: () => number },
): ResumeResult {
  const at = nowIso(o.now);
  return transaction(db, (): ResumeResult => {
    const w = getDependencyWait(db, runId);
    if (!w) return { status: 'gone', reason: `no wait recorded for run ${runId}` };
    if (w.state !== 'waiting') return { status: 'already', jobId: w.resumeJobId };
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(w.jobId) as (JobRow & { escalation_hops: number }) | undefined;
    if (!job) {
      // Only "updraft clean" deletes jobs, and it keeps a job whose wait is still waiting; be safe anyway.
      const reason = `job ${w.jobId} no longer exists, so there is nothing to continue`;
      db.prepare("UPDATE dependency_waits SET state = 'canceled', reason = ?, ended_at = ?, updated_at = ? WHERE run_id = ?").run(reason, at, at, runId);
      noteDependencyEnded(db, { runId, jobId: w.jobId, repoId: w.repoId, repoFullName: w.repoFullName, outcome: 'canceled', startAt: w.createdAt, at });
      return { status: 'gone', reason };
    }
    const original = JSON.parse(job.envelope) as EventEnvelope;
    const eventId = `dep:${runId}`;
    const envelope: EventEnvelope = {
      ...original,
      eventId,
      resume: {
        originalEventId: w.originalEventId,
        waitingRunId: runId,
        waitingJobId: w.jobId,
        waits: w.waits,
        pullRequest: o.pullRequest,
        note: w.note,
      },
    };
    const id = newId('job');
    const res = db
      .prepare(
        `INSERT INTO jobs
           (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope,
            status, status_reason, attempts, escalation_hops, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM pruned_events WHERE repo_id = ? AND workflow_id = ? AND event_id = ?)
         ON CONFLICT (repo_id, workflow_id, event_id) DO NOTHING`,
      )
      .run(
        id,
        job.repo_id,
        job.repo_full_name,
        job.workflow_id,
        eventId,
        job.issue_number,
        job.action,
        job.pool,
        JSON.stringify(envelope),
        `${dependencyRef(w)} was merged; continuing the issue after job ${w.jobId}`,
        job.escalation_hops,
        at,
        at,
        job.repo_id,
        job.workflow_id,
        eventId,
      );
    const existing = Number(res.changes) === 0
      ? ((db.prepare('SELECT id FROM jobs WHERE repo_id = ? AND workflow_id = ? AND event_id = ?').get(job.repo_id, job.workflow_id, eventId) as { id: string } | undefined)?.id ?? null)
      : id;
    db.prepare(
      `UPDATE dependency_waits SET state = 'resumed', reason = ?, merged_at = ?, merge_commit_sha = ?, dep_title = ?, resume_job_id = ?,
         ended_at = ?, updated_at = ?, last_checked_at = ?, checks = checks + 1, failures = 0, last_error = NULL
       WHERE run_id = ?`,
    ).run(
      `${dependencyRef(w)} was merged`,
      o.pullRequest.mergedAt,
      o.pullRequest.mergeCommitSha,
      o.pullRequest.title,
      existing,
      at,
      at,
      at,
      runId,
    );
    noteDependencyEnded(db, { runId, jobId: w.jobId, repoId: w.repoId, repoFullName: w.repoFullName, outcome: 'resumed', startAt: w.createdAt, at });
    if (Number(res.changes) === 0) return { status: 'already', jobId: existing };
    return { status: 'queued', job: rowToJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow) };
  });
}

/** What became of one attempt at an issue comment of a wait. `giveUp`: no later attempt can help. */
export function recordWaitComment(
  db: Db,
  runId: string,
  which: 'wait' | 'end',
  o: { posted: { id: number; url: string } } | { error: string; giveUp: boolean },
  now: () => number,
): void {
  const at = nowIso(now);
  const c = which === 'wait' ? 'wait_comment' : 'end_comment';
  if ('posted' in o) {
    db.prepare(`UPDATE dependency_waits SET ${c}_id = ?, ${c}_url = ?, ${c}_attempts = ${c}_attempts + 1, ${c}_error = NULL, updated_at = ? WHERE run_id = ?`).run(
      o.posted.id,
      o.posted.url,
      at,
      runId,
    );
    return;
  }
  db.prepare(
    `UPDATE dependency_waits SET ${c}_attempts = ${o.giveUp ? '?' : `${c}_attempts + 1`}, ${c}_error = ?, updated_at = ? WHERE run_id = ?`,
  ).run(...(o.giveUp ? [WAIT_COMMENT_MAX_ATTEMPTS] : []), o.error, at, runId);
}

/** True when any wait is still waiting. */
export function hasDependencyWaits(db: Db): boolean {
  return db.prepare("SELECT 1 FROM dependency_waits WHERE state = 'waiting' LIMIT 1").get() !== undefined;
}

/** Waits still waiting, per repository id, for `updraft stats` (not windowed: the state right now). */
export function countWaitingByRepo(db: Db): Array<{ repoId: number; repoFullName: string; n: number }> {
  return (
    db.prepare("SELECT repo_id, repo_full_name, count(*) AS n FROM dependency_waits WHERE state = 'waiting' GROUP BY repo_id").all() as {
      repo_id: number;
      repo_full_name: string;
      n: number;
    }[]
  ).map((r) => ({ repoId: r.repo_id, repoFullName: r.repo_full_name, n: r.n }));
}
