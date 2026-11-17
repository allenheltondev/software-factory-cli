import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, migrate, openDatabase, transaction, type Db } from './database.js';

describe('openDatabase', () => {
  it('migrates a fresh database to the current schema', () => {
    const db = openDatabase(':memory:');
    const v = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(v.user_version).toBe(SCHEMA_VERSION);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (t) => t.name,
    );
    expect(tables).toEqual(expect.arrayContaining(['jobs', 'runs', 'repo_checkpoints', 'worker_lock', 'errors']));
  });

  it('rolls back failed transactions', () => {
    const db = openDatabase(':memory:');
    expect(() =>
      transaction(db, () => {
        db.prepare("INSERT INTO meta (key, value) VALUES ('a', '1')").run();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare("SELECT count(*) AS n FROM meta").get()).toEqual({ n: 0 });
  });
});

describe('migration v4', () => {
  const at = '2026-11-17T10:00:00.000Z';

  /** A state DB as v3 left it, with run history covering each backfill case. */
  function v3Database(): Db {
    const db = openDatabase(':memory:', { migrateTo: 3 });
    const job = db.prepare(
      `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
       VALUES (?, 1, 'o/r', 'wf', ?, ?, 'implement-issue', 'general', '{}', ?, ?, ?, ?)`,
    );
    const run = db.prepare(
      `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at, ended_at, outcome)
       VALUES (?, ?, ?, 'general', 'claude', ?, ?, ?, ?, ?)`,
    );
    const add = (jobId: string, attempt: number, outcome: string | null, ended = true, workerId = 'wrk_gone') =>
      run.run(`run_${jobId}_${attempt}`, jobId, attempt, workerId, at, at, ended ? at : null, outcome);

    // Streak of 2 start failures; a claim released before start does not break it.
    job.run('job_a', 'a', 1, 'queued', 3, at, at);
    add('job_a', 1, 'start_failed');
    add('job_a', 2, null);
    add('job_a', 3, 'start_failed');
    // Retried by the user after attempt 2; only the failure after that floor counts.
    job.run('job_b', 'b', 2, 'queued', 3, at, at);
    add('job_b', 1, 'start_failed');
    add('job_b', 2, 'start_failed');
    add('job_b', 3, 'start_failed');
    db.prepare("INSERT INTO meta (key, value) VALUES ('retry_floor:job_b', '2'), ('other', 'kept')").run();
    // An ordinary failure, then an open run left by the current lock holder.
    job.run('job_c', 'c', 3, 'running', 2, at, at);
    add('job_c', 1, 'failed');
    add('job_c', 2, null, false, 'wrk_old');
    db.prepare(
      "INSERT INTO worker_lock (id, worker_id, pid, hostname, started_at, heartbeat_at) VALUES (1, 'wrk_old', 1, 'host-a', ?, ?)",
    ).run(at, at);
    return db;
  }

  it('backfills start_failures from run history and drops retry_floor rows', () => {
    const db = v3Database();
    migrate(db);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect(db.prepare('SELECT id, start_failures FROM jobs ORDER BY id').all()).toEqual([
      { id: 'job_a', start_failures: 2 },
      { id: 'job_b', start_failures: 1 },
      { id: 'job_c', start_failures: 0 },
    ]);
    expect(db.prepare('SELECT key FROM meta').all()).toEqual([{ key: 'other' }]);
  });

  it("records the lock holder's host on its runs and leaves other runs' host unknown", () => {
    const db = v3Database();
    migrate(db);
    expect(db.prepare("SELECT id, hostname FROM runs WHERE job_id = 'job_c' ORDER BY attempt").all()).toEqual([
      { id: 'run_job_c_1', hostname: null },
      { id: 'run_job_c_2', hostname: 'host-a' },
    ]);
  });
});
