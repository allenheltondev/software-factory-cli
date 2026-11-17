import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { createRequire } from 'node:module';
import type { EventEnvelope, Job, JobStatus, Run, RunOutcome } from '../types.js';

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

export const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
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
};

export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current > SCHEMA_VERSION) {
    throw new Error(`state database schema v${current} is newer than this CLI supports (v${SCHEMA_VERSION})`);
  }
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    const sql = MIGRATIONS[v];
    if (!sql) throw new Error(`missing migration ${v}`);
    transaction(db, () => {
      db.exec(sql);
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
  pid: number | null;
  lease_expires_at: string;
  started_at: string;
  ended_at: string | null;
  outcome: RunOutcome | null;
  error: string | null;
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
    pid: r.pid,
    leaseExpiresAt: r.lease_expires_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    outcome: r.outcome,
    error: r.error,
  };
}
