import { describe, expect, it } from 'vitest';
import { buildHistory, metricRows } from '../../test/factory-history.js';
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

  it('treats runs with an outcome or still open as started, and runs closed without one as never started', () => {
    const db = v3Database();
    migrate(db);
    const started = db.prepare('SELECT id, execution_started_at FROM runs ORDER BY id').all() as {
      id: string;
      execution_started_at: string | null;
    }[];
    const never = started.filter((r) => r.execution_started_at === null).map((r) => r.id);
    // The released claim never started; the open run might have, so reconcile keeps it 'interrupted'.
    expect(never).toEqual(['run_job_a_2']);
    expect(started.find((r) => r.id === 'run_job_c_2')?.execution_started_at).toBe(at);
  });
});

describe('migration v5', () => {
  it('adds an empty process start time and summary to existing runs (reconcile never signals such a pid)', () => {
    const db = openDatabase(':memory:', { migrateTo: 4 });
    db.prepare(
      `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
       VALUES ('job_1', 1, 'o/r', 'wf', 'e1', 1, 'implement-issue', 'general', '{}', 'running', 1, 't', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, hostname, pid, lease_expires_at, started_at, execution_started_at)
       VALUES ('run_1', 'job_1', 1, 'general', 'claude', 'wrk_1', 'host-a', 4242, 't', 't', 't')`,
    ).run();
    migrate(db, 5);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 });
    expect(db.prepare('SELECT pid, pid_start_time, summary FROM runs').get()).toEqual({ pid: 4242, pid_start_time: null, summary: null });
  });
});

describe('migration v6', () => {
  it('adds an empty publications table; existing runs stay unpublished', () => {
    const db = openDatabase(':memory:', { migrateTo: 5 });
    db.prepare(
      `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
       VALUES ('job_1', 1, 'o/r', 'wf', 'e1', 1, 'implement-issue', 'general', '{}', 'succeeded', 1, 't', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at, ended_at, outcome)
       VALUES ('run_1', 'job_1', 1, 'general', 'claude', 'wrk_1', 't', 't', 't', 'succeeded')`,
    ).run();
    migrate(db, 6);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 6 });
    expect(db.prepare('SELECT count(*) AS n FROM publications').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT outcome FROM runs').get()).toEqual({ outcome: 'succeeded' });
  });
});

describe('migration v7', () => {
  it('adds an empty failure_comments table; existing runs and publications are untouched', () => {
    const db = openDatabase(':memory:', { migrateTo: 6 });
    db.prepare(
      `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
       VALUES ('job_1', 1, 'o/r', 'wf', 'e1', 1, 'implement-issue', 'general', '{}', 'failed', 1, 't', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at, ended_at, outcome)
       VALUES ('run_1', 'job_1', 1, 'general', 'claude', 'wrk_1', 't', 't', 't', 'failed')`,
    ).run();
    migrate(db, 7);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 });
    expect(db.prepare('SELECT count(*) AS n FROM failure_comments').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT outcome FROM runs').get()).toEqual({ outcome: 'failed' });
  });
});

describe('migration v8', () => {
  it('adds an unset cancel request to existing runs and an empty pruned_events table', () => {
    const db = openDatabase(':memory:', { migrateTo: 7 });
    db.prepare(
      `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
       VALUES ('job_1', 1, 'o/r', 'wf', 'e1', 1, 'implement-issue', 'general', '{}', 'running', 1, 't', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at)
       VALUES ('run_1', 'job_1', 1, 'general', 'claude', 'wrk_1', 't', 't')`,
    ).run();
    migrate(db, 8);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 });
    expect(db.prepare('SELECT cancel_requested_at FROM runs').get()).toEqual({ cancel_requested_at: null });
    expect(db.prepare('SELECT count(*) AS n FROM pruned_events').get()).toEqual({ n: 0 });
  });
});

describe('migration v9', () => {
  it('adds empty container columns; an existing open run is treated as a host run', () => {
    const db = openDatabase(':memory:', { migrateTo: 8 });
    db.prepare(
      `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
       VALUES ('job_1', 1, 'o/r', 'wf', 'e1', 1, 'implement-issue', 'general', '{}', 'running', 1, 't', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, hostname, pid, lease_expires_at, started_at, execution_started_at)
       VALUES ('run_1', 'job_1', 1, 'general', 'claude', 'wrk_1', 'host-a', 4242, 't', 't', 't')`,
    ).run();
    migrate(db, 9);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 });
    expect(db.prepare('SELECT pid, container_runtime, container_name FROM runs').get()).toEqual({ pid: 4242, container_runtime: null, container_name: null });
  });
});

describe('migration v10', () => {
  it('adds the empty revision tables; existing jobs, runs and publications are untouched and nothing is watched yet', () => {
    const db = openDatabase(':memory:', { migrateTo: 9 });
    db.prepare(
      `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
       VALUES ('job_1', 1, 'o/r', 'wf', 'e1', 1, 'implement-issue', 'general', '{}', 'succeeded', 1, 't', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at, ended_at, outcome)
       VALUES ('run_1', 'job_1', 1, 'general', 'claude', 'wrk_1', 't', 't', 't', 'succeeded')`,
    ).run();
    db.prepare(
      `INSERT INTO publications (run_id, job_id, repo_id, repo_full_name, issue_number, mode, state, branch, pr_number, pr_url, attempts, created_at, updated_at)
       VALUES ('run_1', 'job_1', 1, 'o/r', 1, 'pr', 'published', 'updraft/issue-1-job_1', 5, 'https://github.com/o/r/pull/5', 1, 't', 't')`,
    ).run();
    migrate(db, 10);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10 });
    for (const table of ['revision_prs', 'review_checkpoints', 'review_requests', 'revisions']) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    }
    expect(db.prepare('SELECT state, pr_number FROM publications').get()).toEqual({ state: 'published', pr_number: 5 });
    expect(db.prepare('SELECT status FROM jobs').get()).toEqual({ status: 'succeeded' });

    // The new tables hold what the revision loop writes, and refuse what it never does.
    db.prepare(
      `INSERT INTO review_requests (repo_id, review_id, pr_number, reviewer, trigger_kind, state, created_at) VALUES (1, 'PRR_1', 5, 'allen', 'changes_requested', 'over-limit', 't')`,
    ).run();
    expect(() =>
      db.prepare(`INSERT INTO review_requests (repo_id, review_id, pr_number, trigger_kind, state, created_at) VALUES (1, 'PRR_1', 5, 'changes_requested', 'queued', 't')`).run(),
    ).toThrow(/UNIQUE|PRIMARY/i);
    db.prepare(
      `INSERT INTO revisions (run_id, job_id, repo_id, repo_full_name, issue_number, pr_number, review_id, trigger_kind, state, branch, base_sha, created_at, updated_at)
       VALUES ('run_1', 'job_1', 1, 'o/r', 1, 5, 'PRR_1', 'changes_requested', 'publishing', 'updraft/issue-1-job_1', 'abc', 't', 't')`,
    ).run();
    expect(db.prepare('SELECT moved, attempts, head_sha FROM revisions').get()).toEqual({ moved: 0, attempts: 0, head_sha: null });
    expect(() =>
      db
        .prepare(
          `INSERT INTO revisions (run_id, job_id, repo_id, repo_full_name, issue_number, pr_number, review_id, trigger_kind, state, branch, created_at, updated_at)
           VALUES ('run_missing', 'job_1', 1, 'o/r', 1, 5, 'PRR_2', 'changes_requested', 'publishing', 'b', 't', 't')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe('migration v11', () => {
  it('adds the review loop columns and table; a watched PR starts at the head the worker last pushed, with no verdict', () => {
    const db = openDatabase(':memory:', { migrateTo: 10 });
    db.prepare(
      `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
       VALUES ('job_1', 1, 'o/r', 'wf', 'e1', 1, 'implement-issue', 'general', '{}', 'succeeded', 1, 't', 't'),
              ('job_2', 1, 'o/r', 'wf', 'review:PRR_1', 1, 'implement-issue', 'general', '{}', 'succeeded', 1, 't', 't'),
              ('job_3', 1, 'o/r', 'wf', 'e3', 2, 'implement-issue', 'general', '{}', 'succeeded', 1, 't', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at, ended_at, outcome)
       VALUES ('run_1', 'job_1', 1, 'general', 'claude', 'w', 't', 't', 't', 'succeeded'),
              ('run_2', 'job_2', 1, 'general', 'codex', 'w', 't', 't', 't', 'succeeded'),
              ('run_3', 'job_3', 1, 'general', 'kiro', 'w', 't', 't', 't', 'succeeded')`,
    ).run();
    db.prepare(
      `INSERT INTO publications (run_id, job_id, repo_id, repo_full_name, issue_number, mode, state, branch, head_sha, pushed_at, pr_number, pr_url, attempts, created_at, updated_at)
       VALUES ('run_1', 'job_1', 1, 'o/r', 1, 'pr', 'published', 'b1', 'sha_a', '2026-01-01T00:00:00.000Z', 5, 'u5', 1, 't', 't'),
              ('run_3', 'job_3', 1, 'o/r', 2, 'pr', 'published', 'b3', 'sha_c', '2026-01-03T00:00:00.000Z', 6, 'u6', 1, 't', 't')`,
    ).run();
    const watch = db.prepare(
      `INSERT INTO revision_prs (repo_id, pr_number, pr_url, source_run_id, original_event_id, workflow_id, issue_number, issue_title, issue_url, label, labels,
                                 action, pool, branch, state, created_at, updated_at)
       VALUES (1, ?, ?, ?, 'e', 'wf', ?, 't', 'u', 'l', '[]', 'implement-issue', 'general', ?, 'open', 't', 't')`,
    );
    watch.run(5, 'u5', 'run_1', 1, 'b1');
    watch.run(6, 'u6', 'run_3', 2, 'b3');
    watch.run(7, 'u7', 'run_pruned', 3, 'b7');
    // PR 5 was revised once since.
    db.prepare(
      `INSERT INTO revisions (run_id, job_id, repo_id, repo_full_name, issue_number, pr_number, review_id, trigger_kind, state, branch, base_sha, head_sha, pushed_at, created_at, updated_at)
       VALUES ('run_2', 'job_2', 1, 'o/r', 1, 5, 'PRR_1', 'changes_requested', 'published', 'b1', 'sha_a', 'sha_b', '2026-01-02T00:00:00.000Z', 't', 't')`,
    ).run();

    migrate(db, 11);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 11 });
    const rows = db
      .prepare('SELECT pr_number, head_sha, head_at, author_agent, verdict, verdict_sha, merge_state, merge_attempts, merge_comment_attempts, ready_marked_at FROM revision_prs ORDER BY pr_number')
      .all();
    const blank = { verdict: null, verdict_sha: null, merge_state: null, merge_attempts: 0, merge_comment_attempts: 0, ready_marked_at: null };
    expect(rows).toEqual([
      { pr_number: 5, head_sha: 'sha_b', head_at: '2026-01-02T00:00:00.000Z', author_agent: 'codex', ...blank },
      { pr_number: 6, head_sha: 'sha_c', head_at: '2026-01-03T00:00:00.000Z', author_agent: 'kiro', ...blank },
      { pr_number: 7, head_sha: null, head_at: null, author_agent: null, ...blank },
    ]);
    expect(db.prepare('SELECT count(*) AS n FROM pr_reviews').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 3 });

    // The new table and columns hold what the review loop writes, and refuse what it never does.
    const review = (runId: string, verdict: string) =>
      db
        .prepare(
          `INSERT INTO pr_reviews (run_id, job_id, repo_id, repo_full_name, issue_number, pr_number, head_sha, agent, verdict, findings, state, created_at, updated_at)
           VALUES (?, 'job_1', 1, 'o/r', 1, 5, 'sha_b', 'codex', ?, 'f', 'publishing', 't', 't')`,
        )
        .run(runId, verdict);
    review('run_1', 'ready-to-merge');
    expect(db.prepare('SELECT attempts, retryable, outcome, review_id FROM pr_reviews').get()).toEqual({ attempts: 0, retryable: 0, outcome: null, review_id: null });
    expect(() => review('run_2', 'approved')).toThrow(/CHECK/i);
    expect(() => review('run_1', 'changes-requested')).toThrow(/UNIQUE|PRIMARY/i);
    expect(() => review('run_missing', 'ready-to-merge')).toThrow(/FOREIGN KEY/i);
    expect(() => db.prepare("UPDATE pr_reviews SET outcome = 'merged'").run()).toThrow(/CHECK/i);
    db.prepare("UPDATE revision_prs SET merge_state = 'waiting' WHERE pr_number = 5").run();
    expect(() => db.prepare("UPDATE revision_prs SET merge_state = 'forced' WHERE pr_number = 5").run()).toThrow(/CHECK/i);
  });
});

describe('migration v12', () => {
  it('adds an empty publish_settings table to a v11 database, so publish counts as turned on at the next start', () => {
    const db = openDatabase(':memory:', { migrateTo: 11 });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 11 });
    migrate(db, 12);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 });
    expect(db.prepare('SELECT count(*) AS n FROM publish_settings').get()).toEqual({ n: 0 });
    // The tables the earlier migrations made are untouched.
    for (const table of ['failure_comments', 'pruned_events', 'revisions', 'pr_reviews']) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });
});

describe('migration v13', () => {
  const END = Date.parse('2026-11-18T12:00:00.000Z');

  it('adds the metric_events rollup and pr_reviews.findings_count, and backfills the rollup from a v12 database', () => {
    const db = openDatabase(':memory:', { migrateTo: 12 });
    db.prepare(
      `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
       VALUES ('job_1', 1, 'o/r', 'wf', 'e1', 1, 'implement-issue', 'general', ?, 'succeeded', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:30:00.000Z'),
              ('job_2', 1, 'o/r', 'wf', 'pr-review:5:sha_a', 1, 'implement-issue', 'reviewers', ?, 'succeeded', 1, '2026-01-01T01:00:00.000Z', '2026-01-01T01:10:00.000Z'),
              ('job_3', 1, 'o/r', 'wf', 'e3', 2, 'implement-issue', 'general', 'not json', 'queued', 0, 't', 't')`,
    ).run(
      JSON.stringify({ type: 'issue.labeled', createdAt: '2025-12-31T23:00:00.000Z' }),
      JSON.stringify({ type: 'pull_request.review', review: { pullRequest: { number: 5 } } }),
    );
    db.prepare(
      // run_1 recorded an agent pid, the evidence its agent launched; run_2 has none, so its agent
      // run time and queue wait are unknown rather than measured from its execution start.
      `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, pid, lease_expires_at, started_at, execution_started_at, ended_at, outcome, summary)
       VALUES ('run_1', 'job_1', 1, 'general', 'claude', 'w', 4242, 't', 't', '2026-01-01T00:05:00.000Z', '2026-01-01T00:30:00.000Z', 'succeeded', ?),
              ('run_2', 'job_2', 1, 'reviewers', 'codex', 'w', NULL, 't', 't', '2026-01-01T01:02:00.000Z', '2026-01-01T01:10:00.000Z', 'succeeded', 'not json')`,
    ).run(JSON.stringify({ verification: { passed: true } }));
    db.prepare(
      `INSERT INTO publications (run_id, job_id, repo_id, repo_full_name, issue_number, mode, state, branch, head_sha, pushed_at, pr_number, pr_url, attempts, created_at, updated_at, published_at)
       VALUES ('run_1', 'job_1', 1, 'o/r', 1, 'pr', 'published', 'b1', 'sha_a', 't', 5, 'u5', 1, 't', 't', '2026-01-01T00:40:00.000Z')`,
    ).run();
    const watch = db.prepare(
      `INSERT INTO revision_prs (repo_id, pr_number, pr_url, source_run_id, original_event_id, workflow_id, issue_number, issue_title, issue_url, label, labels,
                                 action, pool, branch, state, created_at, updated_at, merge_state, merge_sha, merge_reason, merged_at, limit_reached_at, author_agent)
       VALUES (1, ?, 'u', ?, 'e', 'wf', 1, 'a title that must not be copied', 'u', 'l', '[]', 'implement-issue', 'general', 'b', 'open', ?, ?, ?, ?, ?, ?, ?, 'claude')`,
    );
    watch.run(5, 'run_1', '2026-01-01T00:41:00.000Z', '2026-01-02T00:00:00.000Z', 'merged', 'sha_a', null, '2026-01-02T00:00:00.000Z', null);
    watch.run(6, 'run_gone', '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z', 'blocked', 'sha_x', 'it is still a draft', null, '2026-01-03T12:00:00.000Z');
    db.prepare(
      `INSERT INTO pr_reviews (run_id, job_id, repo_id, repo_full_name, issue_number, pr_number, head_sha, agent, verdict, findings, state, created_at, updated_at)
       VALUES ('run_2', 'job_2', 1, 'o/r', 1, 5, 'sha_a', 'codex', 'ready-to-merge', 'findings text', 'published', '2026-01-01T01:10:00.000Z', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO review_requests (repo_id, review_id, pr_number, reviewer, trigger_kind, state, created_at)
       VALUES (1, 'PRR_1', 6, 'someone', 'changes_requested', 'over-limit', '2026-01-03T12:00:00.000Z')`,
    ).run();

    migrate(db);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.prepare('SELECT findings_count FROM pr_reviews').all()).toEqual([{ findings_count: null }]);
    const rows = db
      .prepare(
        'SELECT kind, subject_id, at, repo_full_name, job_kind, pr_number, agent, outcome, reason, start_at, wait_ms, findings, backfilled FROM metric_events ORDER BY kind, subject_id',
      )
      .all();
    const none = { start_at: null, wait_ms: null, findings: null, backfilled: 1, repo_full_name: 'o/r' };
    expect(rows).toEqual([
      { ...none, kind: 'change_request', subject_id: '1:PRR_1', at: '2026-01-03T12:00:00.000Z', job_kind: null, pr_number: 6, agent: null, outcome: 'over-limit', reason: 'changes_requested' },
      { ...none, kind: 'job.finished', subject_id: 'job_1:1:0:succeeded', at: '2026-01-01T00:30:00.000Z', job_kind: 'implement', pr_number: null, agent: 'claude', outcome: 'succeeded', reason: null, start_at: '2026-01-01T00:00:00.000Z' },
      { ...none, kind: 'job.finished', subject_id: 'job_2:1:0:succeeded', at: '2026-01-01T01:10:00.000Z', job_kind: 'review', pr_number: 5, agent: 'codex', outcome: 'succeeded', reason: null, start_at: '2026-01-01T01:00:00.000Z' },
      { ...none, kind: 'pr.limit_reached', subject_id: '1#6', at: '2026-01-03T12:00:00.000Z', job_kind: null, pr_number: 6, agent: 'claude', outcome: 'limit-reached', reason: null },
      { ...none, kind: 'pr.merge_blocked', subject_id: '1#6@sha_x', at: '2026-01-04T00:00:00.000Z', job_kind: null, pr_number: 6, agent: 'claude', outcome: 'blocked', reason: 'draft' },
      { ...none, kind: 'pr.merged', subject_id: '1#5', at: '2026-01-02T00:00:00.000Z', job_kind: null, pr_number: 5, agent: 'claude', outcome: 'merged', reason: null, start_at: '2026-01-01T00:40:00.000Z' },
      { ...none, kind: 'pr.opened', subject_id: '1#5', at: '2026-01-01T00:40:00.000Z', job_kind: 'implement', pr_number: 5, agent: 'claude', outcome: 'pr', reason: null, start_at: '2025-12-31T23:00:00.000Z' },
      // Watched, but its publication is gone: counted at the time watching started, with no lead time.
      { ...none, kind: 'pr.opened', subject_id: '1#6', at: '2026-01-03T00:00:00.000Z', job_kind: 'implement', pr_number: 6, agent: null, outcome: null, reason: 'approximate' },
      // A review from before the count existed has none.
      { ...none, kind: 'review.verdict', subject_id: 'run_2', at: '2026-01-01T01:10:00.000Z', job_kind: 'review', pr_number: 5, agent: 'codex', outcome: 'ready-to-merge', reason: null },
      { ...none, kind: 'run.ended', subject_id: 'run_1', at: '2026-01-01T00:30:00.000Z', job_kind: 'implement', pr_number: null, agent: 'claude', outcome: 'succeeded', reason: 'verify-passed', start_at: '2026-01-01T00:05:00.000Z', wait_ms: 300_000 },
      // A summary that is not JSON is read as no verify result, without failing the migration.
      { ...none, kind: 'run.ended', subject_id: 'run_2', at: '2026-01-01T01:10:00.000Z', job_kind: 'review', pr_number: 5, agent: 'codex', outcome: 'succeeded', reason: null, start_at: null, wait_ms: null },
    ]);
    // Nothing of the text in the rows it was built from.
    expect(JSON.stringify(db.prepare('SELECT * FROM metric_events').all())).not.toMatch(/title|findings text|someone/);
    // The idempotency key holds.
    expect(() => db.prepare("INSERT INTO metric_events (kind, subject_id, at, repo_id, recorded_at) VALUES ('run.ended', 'run_1', 't', 1, 't')").run()).toThrow(/UNIQUE/i);
  });

  it('carries a live history through a downgrade and the migration again, short only of what the rows no longer hold', () => {
    const h = buildHistory(END);
    const live = metricRows(h.db);
    h.db.exec(
      'DROP TABLE capacity_cooldowns; DROP TABLE policy_events; ALTER TABLE jobs DROP COLUMN escalation_hops; ALTER TABLE jobs DROP COLUMN deferrals; DROP TABLE triage_cache; DROP TABLE triage_runs; DROP TABLE metric_events; ALTER TABLE pr_reviews DROP COLUMN findings_count; ALTER TABLE runs DROP COLUMN agent_started_at; ' +
        'ALTER TABLE jobs DROP COLUMN retries; PRAGMA user_version = 12;',
    );
    migrate(h.db);
    // The findings counts lived only in the dropped column, a retried job's earlier failure only in
    // the rollup, and its retry count only in jobs.retries (part of its job.finished key); everything
    // else comes back as it was recorded. Agent starts come back from the recorded pids.
    const strip = (rows: typeof live) =>
      rows.map((r) => ({ ...r, findings: null, subject_id: r.kind === 'job.finished' ? String(r.subject_id).replace(/:\d+:(\w+)$/, ':$1') : r.subject_id }));
    const retriedFailure = (r: (typeof live)[number]) =>
      r.kind === 'job.finished' && r.outcome === 'failed' && live.some((x) => x.kind === 'job.finished' && x.job_id === r.job_id && x.subject_id !== r.subject_id);
    expect(live.filter(retriedFailure)).toHaveLength(1);
    expect(strip(metricRows(h.db))).toEqual(strip(live.filter((r) => !retriedFailure(r))));
  });
});

describe('migration v20', () => {
  it('lets pr_reviews hold the needs-verification outcome, keeping every row, column and index of a v19 database', () => {
    const db = openDatabase(':memory:', { migrateTo: 19 });
    db.prepare(
      `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
       VALUES ('job_1', 1, 'o/r', 'wf', 'pr-review:5:sha_a', 1, 'implement-issue', 'reviewers', '{}', 'succeeded', 1, 't', 't')`,
    ).run();
    for (const id of ['run_1', 'run_2', 'run_3']) {
      db.prepare(`INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at) VALUES (?, 'job_1', ?, 'reviewers', 'codex', 'w', 't', 't')`).run(
        id,
        Number(id.slice(-1)),
      );
    }
    db.prepare(
      `INSERT INTO pr_reviews (run_id, job_id, repo_id, repo_full_name, issue_number, pr_number, head_sha, agent, verdict, findings, state, outcome, findings_count, created_at, updated_at)
       VALUES ('run_1', 'job_1', 1, 'o/r', 1, 5, 'sha_a', 'codex', 'changes-requested', 'text', 'published', 'revision-queued', 2, 't1', 't2')`,
    ).run();
    const insert = (runId: string, outcome: string) =>
      db
        .prepare(
          `INSERT INTO pr_reviews (run_id, job_id, repo_id, repo_full_name, issue_number, pr_number, head_sha, agent, verdict, findings, state, outcome, created_at, updated_at)
           VALUES (?, 'job_1', 1, 'o/r', 1, 5, 'sha_b', 'codex', 'changes-requested', 'text', 'published', ?, 't3', 't4')`,
        )
        .run(runId, outcome);
    expect(() => insert('run_2', 'needs-verification')).toThrow(/CHECK/i);
    const indexes = () =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pr_reviews' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    const before = indexes();
    migrate(db, 20);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 20 });
    expect(db.prepare('SELECT run_id, outcome, findings_count, created_at FROM pr_reviews').all()).toEqual([
      { run_id: 'run_1', outcome: 'revision-queued', findings_count: 2, created_at: 't1' },
    ]);
    expect(indexes()).toEqual(before);
    insert('run_2', 'needs-verification');
    expect(() => insert('run_3', 'something-else')).toThrow(/CHECK/i);
    // Again, as after a hand downgrade: nothing to do.
    db.exec('PRAGMA user_version = 19');
    migrate(db, 20);
    expect(db.prepare('SELECT count(*) AS n FROM pr_reviews').get()).toEqual({ n: 2 });
  });

  it('refuses to stamp v20 on a pr_reviews whose outcome constraint it does not recognize', () => {
    const db = openDatabase(':memory:', { migrateTo: 19 });
    db.exec("DROP TABLE pr_reviews; CREATE TABLE pr_reviews (run_id TEXT PRIMARY KEY, outcome TEXT CHECK (outcome IN ('ready','stale')))");
    expect(() => migrate(db, 20)).toThrow(/does not recognize/);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 19 });
  });
});

describe('migration v21', () => {
  it('adds the suggestion step: a watched PR and its findings start with nothing settled, and a second run changes nothing', () => {
    const db = openDatabase(':memory:', { migrateTo: 20 });
    const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('revision_prs')).not.toContain('suggest_state');
    migrate(db, 21);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 21 });
    expect(cols('revision_prs')).toEqual(expect.arrayContaining(['suggest_state', 'suggest_sha', 'suggest_reason', 'suggest_job_id', 'suggest_attempts', 'suggest_issue_number', 'suggest_issue_url']));
    expect(cols('review_findings')).toEqual(expect.arrayContaining(['settled_as', 'settled_at', 'settled_issue']));
    // As after a hand downgrade: the columns are there already.
    db.exec('PRAGMA user_version = 20');
    migrate(db, 21);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 21 });
  });
});

describe('migration v22', () => {
  it('adds the one re-run per head and the merge block code, reading the code of an earlier block from its reason', () => {
    const db = openDatabase(':memory:', { migrateTo: 21 });
    const cols = () => (db.prepare('PRAGMA table_info(revision_prs)').all() as { name: string }[]).map((c) => c.name);
    expect(cols()).not.toContain('ci_rerun_sha');
    db.prepare(
      `INSERT INTO revision_prs (repo_id, pr_number, pr_url, source_run_id, original_event_id, workflow_id, issue_number, issue_title, issue_url, label, labels, action, pool, branch,
                                state, created_at, updated_at, merge_state, merge_sha, merge_reason)
       VALUES (1, 5, 'u', 'run_1', 'e', 'w', 2, 't', 'u', 'l', '[]', 'a', 'p', 'b', 'open', 't', 't', 'blocked', 'abc', '1 check(s) of abc did not pass: test')`,
    ).run();
    migrate(db, 22);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 22 });
    expect(cols()).toEqual(expect.arrayContaining(['ci_rerun_sha', 'ci_rerun_at', 'ci_rerun_checks', 'ci_rerun_files', 'merge_code', 'merge_checked_at']));
    expect(db.prepare('SELECT merge_code FROM revision_prs').get()).toEqual({ merge_code: 'checks-failed' });
    db.exec('PRAGMA user_version = 21');
    migrate(db, 22);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 22 });
  });
});
