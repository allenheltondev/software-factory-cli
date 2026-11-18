import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { createRequire } from 'node:module';
import type { EventEnvelope, Job, JobStatus, Run, RunOutcome, RunSummary } from '../types.js';

export type Db = DatabaseSyncType;

/**
 * node:sqlite prints an ExperimentalWarning on first load. Filter exactly that
 * warning so CLI output stays clean, then load the module.
 */
function loadSqlite(): typeof import('node:sqlite') {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === 'string' ? warning : warning.message;
    if (/SQLite is an experimental feature/.test(msg)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

export const SCHEMA_VERSION = 10;

/** A migration is plain SQL, or a function for steps that need to backfill from existing rows. */
type Migration = string | ((db: Db) => void);

const MIGRATIONS: Record<number, Migration> = {
  1: `
    CREATE TABLE meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- One event-stream checkpoint per watched repository (keyed by stable GitHub ID).
    CREATE TABLE repo_checkpoints (
      repo_id        INTEGER PRIMARY KEY,
      full_name      TEXT    NOT NULL,
      last_event_id  INTEGER,            -- highest GitHub issue-event ID fully processed
      etag           TEXT,               -- ETag of the newest events page, for conditional polling
      initialized_at TEXT    NOT NULL,
      updated_at     TEXT    NOT NULL
    );

    CREATE TABLE jobs (
      id             TEXT    PRIMARY KEY,
      repo_id        INTEGER NOT NULL,
      repo_full_name TEXT    NOT NULL,
      workflow_id    TEXT    NOT NULL,
      event_id       TEXT    NOT NULL,
      issue_number   INTEGER NOT NULL,
      action         TEXT    NOT NULL,
      pool           TEXT    NOT NULL,
      envelope       TEXT    NOT NULL,   -- JSON EventEnvelope
      status         TEXT    NOT NULL CHECK (status IN ('queued','running','succeeded','failed','interrupted','canceled')),
      status_reason  TEXT,
      attempts       INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT    NOT NULL,
      updated_at     TEXT    NOT NULL,
      UNIQUE (repo_id, workflow_id, event_id)
    );
    CREATE INDEX jobs_by_status ON jobs (status, created_at);
    CREATE INDEX jobs_by_issue  ON jobs (repo_id, issue_number, status);

    CREATE TABLE runs (
      id               TEXT    PRIMARY KEY,
      job_id           TEXT    NOT NULL REFERENCES jobs (id),
      attempt          INTEGER NOT NULL,
      pool             TEXT    NOT NULL,
      agent            TEXT    NOT NULL,
      checkout_path    TEXT,
      log_path         TEXT,
      worker_id        TEXT    NOT NULL,
      pid              INTEGER,
      lease_expires_at TEXT    NOT NULL,
      started_at       TEXT    NOT NULL,
      ended_at         TEXT,
      outcome          TEXT CHECK (outcome IN ('succeeded','failed','interrupted','start_failed')),
      error            TEXT
    );
    CREATE INDEX runs_by_job    ON runs (job_id, attempt);
    CREATE INDEX runs_active    ON runs (ended_at);

    -- Round-robin position per pool, so rotation survives restarts.
    CREATE TABLE pool_cursors (
      pool       TEXT    PRIMARY KEY,
      next_index INTEGER NOT NULL
    );

    -- Single-worker lock. One row at most.
    CREATE TABLE worker_lock (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      worker_id    TEXT    NOT NULL,
      pid          INTEGER NOT NULL,
      hostname     TEXT    NOT NULL,
      started_at   TEXT    NOT NULL,
      heartbeat_at TEXT    NOT NULL
    );

    CREATE TABLE errors (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      at             TEXT    NOT NULL,
      scope          TEXT    NOT NULL,   -- e.g. 'poll', 'worker', 'github'
      repo_full_name TEXT,
      job_id         TEXT,
      message        TEXT    NOT NULL
    );
    CREATE INDEX errors_by_time ON errors (at);
  `,
  2: `
    -- created_at of the newest event seen by the last committed scan. The events
    -- endpoint orders by created_at (not id), so the poller scans back to this time
    -- minus an overlap instead of stopping at the first already-seen id.
    ALTER TABLE repo_checkpoints ADD COLUMN last_event_created_at TEXT;
  `,
  3: `
    -- Where the subscription started. Events at or before it are never dispatched, even
    -- when a later scan's overlap window reaches back over them.
    ALTER TABLE repo_checkpoints ADD COLUMN start_event_id INTEGER;
    ALTER TABLE repo_checkpoints ADD COLUMN start_created_at TEXT;
    -- 1 when page 1 of the last scan reached past the overlap boundary (or was the whole
    -- stream). Only then does a page-1 304 prove nothing in the overlap changed.
    ALTER TABLE repo_checkpoints ADD COLUMN page1_covers_overlap INTEGER;
  `,
  4: (db) => {
    db.exec(`
      -- Host the claiming worker ran on. Reconcile only signals a recorded pid when this
      -- equals its own host. NULL (unknown) is never signalled.
      ALTER TABLE runs ADD COLUMN hostname TEXT;
      -- Consecutive start failures since the job was enqueued or last retried by the user.
      -- Replaces the retry_floor:<jobId> rows in meta.
      ALTER TABLE jobs ADD COLUMN start_failures INTEGER NOT NULL DEFAULT 0;
      -- When the worker handed the run to the executor (after the pre-start check). NULL
      -- means the agent never started, so reconcile can requeue the job instead of
      -- marking it interrupted.
      ALTER TABLE runs ADD COLUMN execution_started_at TEXT;
    `);
    // v3 did not record this. Closed runs with an outcome did execute. Open runs might
    // have, so treat them as started: they stay 'interrupted' for inspection, as before.
    // Runs closed without an outcome (canceled/released before start) stay NULL.
    db.exec('UPDATE runs SET execution_started_at = started_at WHERE outcome IS NOT NULL OR ended_at IS NULL');
    // A run's host was only known for the current lock holder; carry that over so the
    // next worker can still reap that holder's processes. Other runs stay NULL.
    db.exec(`
      UPDATE runs SET hostname = (SELECT l.hostname FROM worker_lock l WHERE l.worker_id = runs.worker_id)
      WHERE hostname IS NULL
    `);
    backfillStartFailures(db);
    db.exec("DELETE FROM meta WHERE substr(key, 1, 12) = 'retry_floor:'");
  },
  5: `
    -- OS start time of runs.pid, platform-tagged ("linux:<boot id>:<ticks>", "darwin:<lstart>",
    -- "win32:<filetime>"). Reconcile and shutdown signal a pid only when its current start time
    -- still matches, so a pid the OS reused is never killed. Earlier runs have none and are
    -- never signalled.
    ALTER TABLE runs ADD COLUMN pid_start_time TEXT;
    -- JSON RunSummary written after a live agent run: commits, changed files, last output.
    ALTER TABLE runs ADD COLUMN summary TEXT;
  `,
  6: `
    -- Publication of a succeeded live run (repositories.<repo>.publish): push the job branch,
    -- open a PR, comment on the issue. Kept apart from runs so it never changes a run's outcome.
    -- Each step's result is recorded as it completes; a retry resumes from what is recorded and
    -- re-checks GitHub before every write, so it never creates a duplicate.
    CREATE TABLE publications (
      run_id           TEXT    PRIMARY KEY REFERENCES runs (id),
      job_id           TEXT    NOT NULL,
      repo_id          INTEGER NOT NULL,
      repo_full_name   TEXT    NOT NULL,
      issue_number     INTEGER NOT NULL,
      mode             TEXT    NOT NULL CHECK (mode IN ('draft-pr','pr')),
      state            TEXT    NOT NULL CHECK (state IN ('publishing','published','failed','skipped')),
      branch           TEXT    NOT NULL,
      base_branch      TEXT,
      head_sha         TEXT,               -- commit pushed (or found already on the remote)
      pushed_at        TEXT,
      pr_number        INTEGER,
      pr_url           TEXT,
      comment_id       INTEGER,
      comment_url      TEXT,
      error            TEXT,               -- why it failed, or why it was skipped
      retryable        INTEGER NOT NULL DEFAULT 0,
      attempts         INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,               -- while state = 'publishing'
      next_attempt_at  TEXT,               -- automatic retry of a retryable failure
      created_at       TEXT    NOT NULL,
      updated_at       TEXT    NOT NULL,
      published_at     TEXT
    );
    CREATE INDEX publications_by_state ON publications (state, next_attempt_at);
  `,
  7: `
    -- The comment that tells an issue its live run failed (repositories.<repo>.commentOnFailure).
    -- One row per run that left its job failed; like publications, kept apart from runs so it
    -- never changes a run's outcome, with the same lease and attempt counter for retries.
    CREATE TABLE failure_comments (
      run_id           TEXT    PRIMARY KEY REFERENCES runs (id),
      job_id           TEXT    NOT NULL,
      repo_id          INTEGER NOT NULL,
      repo_full_name   TEXT    NOT NULL,
      issue_number     INTEGER NOT NULL,
      state            TEXT    NOT NULL CHECK (state IN ('posting','posted','failed','skipped')),
      comment_id       INTEGER,
      comment_url      TEXT,
      error            TEXT,               -- why it failed, or why it was skipped
      retryable        INTEGER NOT NULL DEFAULT 0,
      attempts         INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,               -- while state = 'posting'
      next_attempt_at  TEXT,               -- automatic retry of a retryable failure
      created_at       TEXT    NOT NULL,
      updated_at       TEXT    NOT NULL,
      posted_at        TEXT
    );
    CREATE INDEX failure_comments_by_state ON failure_comments (state, next_attempt_at);
  `,
  8: `
    -- Set by "updraft cancel" on a run that is claimed or executing. The CLI is not the worker
    -- process, so it only records the request; the worker stops the run and closes it with no
    -- outcome and its job 'canceled'. It is on the run, not the job, so a request can never
    -- carry over to a later attempt after "updraft retry".
    ALTER TABLE runs ADD COLUMN cancel_requested_at TEXT;
    -- Dedupe keys of jobs deleted by "updraft clean --older-than". The poller re-reads the
    -- newest events of a repository on every scan (for a quiet repository, indefinitely), and
    -- only the jobs unique key stops such an event from being enqueued again. A deleted job
    -- leaves its key here, and commitPollBatch refuses any event listed.
    CREATE TABLE pruned_events (
      repo_id     INTEGER NOT NULL,
      workflow_id TEXT    NOT NULL,
      event_id    TEXT    NOT NULL,
      pruned_at   TEXT    NOT NULL,
      PRIMARY KEY (repo_id, workflow_id, event_id)
    ) WITHOUT ROWID;
  `,
  9: `
    -- A containerized live run (agents.<name>.container): the runtime client that started the
    -- container (an absolute path) and the container's name. Recorded before the container
    -- starts, so that a later worker on the same host can remove it after a crash. The config may
    -- have changed by then, which is why the runtime is recorded and not derived. NULL: the
    -- agent ran on the host.
    ALTER TABLE runs ADD COLUMN container_runtime TEXT;
    ALTER TABLE runs ADD COLUMN container_name TEXT;
  `,
  10: `
    -- The revision loop (repositories.<repo>.revise): a review that requests changes on a PR
    -- Updraft opened queues a revision job, an ordinary row in jobs whose envelope has type
    -- pull_request.changes_requested and whose event_id is "review:<review node id>".

    -- The PRs the loop watches: one row per PR of a published publication, copied here with what
    -- a revision job needs, so a PR stays watched after "updraft clean --older-than" deleted the
    -- job that opened it. 'closed' is final (closed or merged on GitHub, or no longer readable).
    CREATE TABLE revision_prs (
      repo_id                INTEGER NOT NULL,
      pr_number              INTEGER NOT NULL,
      pr_url                 TEXT    NOT NULL,
      source_run_id          TEXT    NOT NULL,   -- the run whose publication opened the PR
      original_event_id      TEXT    NOT NULL,   -- label event that queued that run's job
      workflow_id            TEXT    NOT NULL,
      issue_number           INTEGER NOT NULL,
      issue_title            TEXT    NOT NULL,
      issue_url              TEXT    NOT NULL,
      label                  TEXT    NOT NULL,
      labels                 TEXT    NOT NULL,   -- JSON array: the original job's labelsAtEnqueue
      action                 TEXT    NOT NULL,
      pool                   TEXT    NOT NULL,
      branch                 TEXT    NOT NULL,   -- the PR's head: the job branch that was pushed
      base_branch            TEXT,
      state                  TEXT    NOT NULL CHECK (state IN ('open','closed')),
      seen_updated_at        TEXT,               -- the PR's updated_at when its reviews were last read
      limit_reached_at       TEXT,               -- first change request refused by maxRevisions
      limit_comment_id       INTEGER,            -- the one comment that says so
      limit_comment_url      TEXT,
      limit_comment_attempts INTEGER NOT NULL DEFAULT 0,
      limit_comment_error    TEXT,
      created_at             TEXT    NOT NULL,
      updated_at             TEXT    NOT NULL,
      PRIMARY KEY (repo_id, pr_number)
    ) WITHOUT ROWID;

    -- Position in a repository's pull request listing (most recently updated first), like
    -- repo_checkpoints for issue events.
    CREATE TABLE review_checkpoints (
      repo_id         INTEGER PRIMARY KEY,
      etag            TEXT,                      -- ETag of page 1, for conditional polling
      last_updated_at TEXT,                      -- newest updated_at seen by the last committed scan
      updated_at      TEXT    NOT NULL
    );

    -- Every change request seen on a watched PR, by review id, with what was decided about it the
    -- first time it was seen. A review listed here is never evaluated again, across restarts,
    -- replays and pruning (rows are kept when their job is pruned; job_id then points nowhere).
    CREATE TABLE review_requests (
      repo_id      INTEGER NOT NULL,
      review_id    TEXT    NOT NULL,             -- GitHub node id of the review
      pr_number    INTEGER NOT NULL,
      reviewer     TEXT,
      trigger_kind TEXT    NOT NULL,             -- what kind of change request it is, e.g. changes_requested
      review_url   TEXT,
      submitted_at TEXT,
      state        TEXT    NOT NULL CHECK (state IN ('queued','over-limit','ignored','not-allowed')),
      reason       TEXT,                         -- why it was not queued
      job_id       TEXT,                         -- the revision job, when state = 'queued'
      created_at   TEXT    NOT NULL,
      PRIMARY KEY (repo_id, review_id)
    ) WITHOUT ROWID;
    CREATE INDEX review_requests_by_pr ON review_requests (repo_id, pr_number);

    -- The push and reply of one revision run; the counterpart of publications, with the same
    -- lease and attempt fence. base_sha is the remote head of the PR branch the run started
    -- from (the push fast-forwards from exactly that commit or not at all), head_sha what was
    -- pushed. moved = 1: the push was refused because the branch was no longer at base_sha.
    CREATE TABLE revisions (
      run_id           TEXT    PRIMARY KEY REFERENCES runs (id),
      job_id           TEXT    NOT NULL,
      repo_id          INTEGER NOT NULL,
      repo_full_name   TEXT    NOT NULL,
      issue_number     INTEGER NOT NULL,
      pr_number        INTEGER NOT NULL,
      review_id        TEXT    NOT NULL,
      trigger_kind     TEXT    NOT NULL,
      state            TEXT    NOT NULL CHECK (state IN ('publishing','published','failed','skipped')),
      branch           TEXT    NOT NULL,
      base_sha         TEXT,
      head_sha         TEXT,
      pushed_at        TEXT,
      moved            INTEGER NOT NULL DEFAULT 0,
      comment_id       INTEGER,
      comment_url      TEXT,
      error            TEXT,
      retryable        INTEGER NOT NULL DEFAULT 0,
      attempts         INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      next_attempt_at  TEXT,
      created_at       TEXT    NOT NULL,
      updated_at       TEXT    NOT NULL,
      published_at     TEXT
    );
    CREATE INDEX revisions_by_state ON revisions (state, next_attempt_at);
  `,
};

/**
 * v4: derive jobs.start_failures from run history the way v3 computed the streak:
 * walk the job's runs after its retry floor, newest first, counting start_failed runs,
 * skipping runs closed without an outcome, and stopping at any other run.
 */
function backfillStartFailures(db: Db): void {
  const jobs = db.prepare("SELECT DISTINCT job_id FROM runs WHERE outcome = 'start_failed'").all() as { job_id: string }[];
  const floorOf = db.prepare('SELECT value FROM meta WHERE key = ?');
  const runsOf = db.prepare('SELECT outcome, ended_at FROM runs WHERE job_id = ? AND attempt > ? ORDER BY attempt DESC');
  const set = db.prepare('UPDATE jobs SET start_failures = ? WHERE id = ?');
  for (const { job_id } of jobs) {
    const floorRow = floorOf.get(`retry_floor:${job_id}`) as { value: string } | undefined;
    const floor = floorRow ? Number(floorRow.value) || 0 : 0;
    let count = 0;
    for (const r of runsOf.all(job_id, floor) as { outcome: RunOutcome | null; ended_at: string | null }[]) {
      if (r.outcome === 'start_failed') count++;
      else if (r.outcome === null && r.ended_at !== null) continue;
      else break;
    }
    if (count > 0) set.run(count, job_id);
  }
}

/** `migrateTo` stops at an older schema version; only migration tests should pass it. */
export function openDatabase(file: string, opts: { migrateTo?: number } = {}): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  migrate(db, opts.migrateTo);
  return db;
}

/** Apply pending migrations up to `target` (default: the current schema). Exported for migration tests. */
export function migrate(db: Db, target = SCHEMA_VERSION): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current > SCHEMA_VERSION) {
    throw new Error(`state database schema v${current} is newer than this CLI supports (v${SCHEMA_VERSION})`);
  }
  for (let v = current + 1; v <= target; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`missing migration ${v}`);
    transaction(db, () => {
      if (typeof step === 'string') db.exec(step);
      else step(db);
      db.exec(`PRAGMA user_version = ${v}`);
    });
  }
}

/**
 * Run fn inside BEGIN IMMEDIATE so writers serialize. Not re-entrant: do not
 * nest calls. Rolls back and rethrows on error.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback failure; surface the original error
    }
    throw err;
  }
}

export function recordError(
  db: Db,
  e: { scope: string; message: string; repoFullName?: string | null; jobId?: string | null; at?: string },
): void {
  db.prepare('INSERT INTO errors (at, scope, repo_full_name, job_id, message) VALUES (?, ?, ?, ?, ?)').run(
    e.at ?? new Date().toISOString(),
    e.scope,
    e.repoFullName ?? null,
    e.jobId ?? null,
    e.message,
  );
}

// ---------------------------------------------------------------------------
// Row mappers shared by the ingest (poller) and queue (worker) modules.
// ---------------------------------------------------------------------------

export interface JobRow {
  id: string;
  repo_id: number;
  repo_full_name: string;
  workflow_id: string;
  event_id: string;
  issue_number: number;
  action: string;
  pool: string;
  envelope: string;
  status: JobStatus;
  status_reason: string | null;
  attempts: number;
  start_failures: number;
  created_at: string;
  updated_at: string;
}

export function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    repoId: r.repo_id,
    repoFullName: r.repo_full_name,
    workflowId: r.workflow_id,
    eventId: r.event_id,
    issueNumber: r.issue_number,
    action: r.action,
    pool: r.pool,
    envelope: JSON.parse(r.envelope) as EventEnvelope,
    status: r.status,
    statusReason: r.status_reason,
    attempts: r.attempts,
    startFailures: r.start_failures,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface RunRow {
  id: string;
  job_id: string;
  attempt: number;
  pool: string;
  agent: string;
  checkout_path: string | null;
  log_path: string | null;
  worker_id: string;
  hostname: string | null;
  pid: number | null;
  pid_start_time: string | null;
  lease_expires_at: string;
  started_at: string;
  execution_started_at: string | null;
  ended_at: string | null;
  outcome: RunOutcome | null;
  error: string | null;
  summary: string | null;
  cancel_requested_at: string | null;
  container_runtime: string | null;
  container_name: string | null;
}

function parseSummary(json: string | null): RunSummary | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as RunSummary;
  } catch {
    return null;
  }
}

export function rowToRun(r: RunRow): Run {
  return {
    id: r.id,
    jobId: r.job_id,
    attempt: r.attempt,
    pool: r.pool,
    agent: r.agent,
    checkoutPath: r.checkout_path,
    logPath: r.log_path,
    workerId: r.worker_id,
    hostname: r.hostname,
    pid: r.pid,
    pidStartTime: r.pid_start_time,
    leaseExpiresAt: r.lease_expires_at,
    startedAt: r.started_at,
    executionStartedAt: r.execution_started_at,
    endedAt: r.ended_at,
    outcome: r.outcome,
    error: r.error,
    summary: parseSummary(r.summary),
    cancelRequestedAt: r.cancel_requested_at,
    container: r.container_runtime && r.container_name ? { runtime: r.container_runtime, name: r.container_name } : null,
  };
}
