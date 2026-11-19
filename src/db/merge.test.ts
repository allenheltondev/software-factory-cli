// `updraft state merge`: what one run changed in its copy of the state database, carried into the
// shared copy. Real database files, as the caller has them: a snapshot, copies of it that "runs"
// change with the worker's own functions, and a shared copy the merges are applied to.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { MemoryOutput } from '../commands/fakes.js';
import { stateInfoCommand, stateMergeCommand } from '../commands/state.js';
import type { CommandContext } from '../commands/context.js';
import { configSchema } from '../config/schema.js';
import { setCooldown } from './capacity.js';
import { openDatabase, openDatabaseReadOnly, recordError, SCHEMA_VERSION, schemaVersion, type Db } from './database.js';
import { commitPollBatch } from './ingest.js';
import { listTables, mergeState, SchemaTooNewError, stateInfo, TABLE_RULES } from './merge.js';
import { pruneJob } from './prune.js';
import { beginPublication } from './publications.js';
import { claimNextJob, finishRun, getJob, retryJob } from './queue.js';
import { recordReviewRequest } from './revisions.js';
import { acquireWorkerLock } from '../worker/lock.js';

const T0 = Date.parse('2026-11-17T10:00:00.000Z');
const config = configSchema.parse({
  version: 1,
  maxConcurrent: 5,
  agents: { claude: { maxConcurrent: 5 }, codex: { maxConcurrent: 5 } },
  pools: { general: { agents: ['claude', 'codex'] }, other: { agents: ['codex', 'claude'] } },
  actions: { 'implement-issue': {} },
  dispatch: { allowedActors: ['allen'] },
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'updraft-merge-test-'));
  dirs.push(d);
  return d;
}

/** Open `file`, change it, and close it again: afterwards the one file is all of it, as an upload would need. */
function edit<T>(file: string, fn: (db: Db) => T): T {
  const db = openDatabase(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function read<T>(file: string, fn: (db: Db) => T): T {
  const db = openDatabaseReadOnly(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** A copy of `from` under a new name, as a download or a pre-run snapshot is. */
function copy(from: string, name: string): string {
  const to = join(dir(), name);
  copyFileSync(from, to);
  return to;
}

const claimOpts = (workerId: string, at: number) => ({ workerId, hostname: `host-${workerId}`, leaseSeconds: 60, runsDir: '/runs', now: () => at });

/** The run was handed to its executor (what markExecutionStarted records for the worker that holds the lock). */
function started(db: Db, runId: string, at: number): void {
  db.prepare('UPDATE runs SET execution_started_at = ? WHERE id = ?').run(new Date(at).toISOString(), runId);
}

/** One job that ran to an end in `db`. */
function finishedJob(db: Db, issue: number, o: { worker: string; at: number; outcome?: 'succeeded' | 'failed'; pool?: string }) {
  const jobId = insertQueuedJob(db, { repoId: 1, fullName: 'o/r', issue, ...(o.pool ? { pool: o.pool } : {}) });
  const c = claimNextJob(db, config, claimOpts(o.worker, o.at))!;
  expect(c.job.id).toBe(jobId);
  started(db, c.run.id, o.at);
  finishRun(db, c.run.id, { outcome: o.outcome ?? 'succeeded', now: () => o.at + 1000 });
  return { jobId, runId: c.run.id };
}

/** Everything a database holds, in an order and shape that does not depend on how it got there. */
function dump(file: string): Record<string, unknown[]> {
  return read(file, (db) => {
    const out: Record<string, unknown[]> = {};
    for (const table of listTables(db)) {
      const rule = TABLE_RULES[table]!;
      const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
      const shaped = rows.map((r) => {
        if (rule.kind !== 'append') return r;
        const { id: _id, ...rest } = r;
        return rest;
      });
      out[table] = shaped.map((r) => JSON.stringify(r)).sort();
    }
    return out;
  });
}

/** A snapshot with one finished job, a checkpoint and an error. */
function snapshot(): string {
  const file = join(dir(), 'snapshot.db');
  edit(file, (db) => {
    finishedJob(db, 1, { worker: 'w0', at: T0 });
    commitPollBatch(db, { repoId: 1, fullName: 'o/r', lastEventId: 100, lastEventCreatedAt: '2026-11-17T09:00:00.000Z', etag: null, jobs: [], now: () => T0 });
    recordError(db, { scope: 'poll', message: 'an old error', at: new Date(T0).toISOString() });
  });
  return file;
}

describe('TABLE_RULES', () => {
  it('has a rule for every table of the schema, and no rule for a table that does not exist', () => {
    const db = openDatabase(':memory:');
    try {
      // A migration that adds a table must add its merge rule to TABLE_RULES in src/db/merge.ts
      // (and its row to docs/shared-state.md): a table without one is refused by the merge.
      expect(listTables(db).sort()).toEqual(Object.keys(TABLE_RULES).sort());
    } finally {
      db.close();
    }
  });

  it('has no column anywhere that points at the id of an append-only table', () => {
    // Appended rows get new ids. If a column ever refers to one (an "error_id", a
    // "metric_event_id"), the merge has to rewrite it; this is the reminder.
    const db = openDatabase(':memory:');
    try {
      const columns = listTables(db).flatMap((t) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name));
      expect(columns.filter((c) => /^(error|errors|metric_event|metric|policy_event|triage_run)_id$/.test(c))).toEqual([]);
      const refs = db.prepare("SELECT sql FROM sqlite_master WHERE sql LIKE '%REFERENCES%'").all() as Array<{ sql: string }>;
      for (const { sql } of refs) expect(sql).not.toMatch(/REFERENCES\s+(errors|metric_events|policy_events|triage_runs)\b/);
    } finally {
      db.close();
    }
  });

  it('documents every table in docs/shared-state.md', () => {
    const doc = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'shared-state.md'), 'utf8');
    for (const table of Object.keys(TABLE_RULES)) expect(doc).toContain(`| \`${table}\` |`);
  });
});

describe('mergeState', () => {
  it('gives the same shared copy whichever of two runs from one snapshot is merged first, when they changed different things', () => {
    const snap = snapshot();
    const a = copy(snap, 'a.db');
    const b = copy(snap, 'b.db');
    const ids = {
      a: edit(a, (db) => {
        const j = finishedJob(db, 11, { worker: 'wa', at: T0 + 60_000 });
        beginPublication(db, { runId: j.runId, jobId: j.jobId, repoId: 1, repoFullName: 'o/r', issueNumber: 11, mode: 'draft-pr', branch: 'b11', leaseSeconds: 60, now: () => T0 + 61_000 });
        commitPollBatch(db, { repoId: 1, fullName: 'o/r', lastEventId: 250, lastEventCreatedAt: '2026-11-17T10:01:00.000Z', etag: null, jobs: [], now: () => T0 + 60_000 });
        recordError(db, { scope: 'worker', message: 'run A stumbled', at: new Date(T0 + 60_000).toISOString() });
        return j;
      }),
      b: edit(b, (db) => {
        const j = finishedJob(db, 12, { worker: 'wb', at: T0 + 90_000, outcome: 'failed', pool: 'other' });
        commitPollBatch(db, { repoId: 1, fullName: 'o/r', lastEventId: 200, lastEventCreatedAt: '2026-11-17T10:00:30.000Z', etag: null, jobs: [], now: () => T0 + 90_000 });
        setCooldown(db, { scope: 'agent', name: 'codex', untilMs: T0 + 3_600_000, reason: 'usage limit', stated: false, nowMs: T0 + 90_000 });
        return j;
      }),
    };

    const ab = copy(snap, 'shared-ab.db');
    const first = mergeState({ changed: a, base: snap, into: ab, now: () => T0 + 200_000 });
    const second = mergeState({ changed: b, base: snap, into: ab, now: () => T0 + 200_000 });
    const ba = copy(snap, 'shared-ba.db');
    mergeState({ changed: b, base: snap, into: ba, now: () => T0 + 200_000 });
    mergeState({ changed: a, base: snap, into: ba, now: () => T0 + 200_000 });

    expect(dump(ab)).toEqual(dump(ba));
    expect(first).toMatchObject({ changed: true, created: false, migratedFrom: null, schemaVersion: SCHEMA_VERSION });
    expect(first.tables.jobs).toMatchObject({ inserted: 1, updated: 0, conflicts: 0 });
    expect(first.tables.runs).toMatchObject({ inserted: 1 });
    expect(first.tables.publications).toMatchObject({ inserted: 1 });
    expect(first.tables.errors).toMatchObject({ appended: 1 });
    expect(first.tables.repo_checkpoints).toMatchObject({ updated: 1, conflicts: 0 });
    // Both moved the same checkpoint: the second merge is a conflict, resolved to the further position.
    expect(second.tables.repo_checkpoints).toMatchObject({ conflicts: 1 });
    read(ab, (db) => {
      expect(db.prepare('SELECT last_event_id, last_event_created_at FROM repo_checkpoints').get()).toEqual({ last_event_id: 250, last_event_created_at: '2026-11-17T10:01:00.000Z' });
      expect((db.prepare('SELECT id, status FROM jobs ORDER BY issue_number').all() as Array<{ id: string; status: string }>).map((j) => j.status)).toEqual(['succeeded', 'succeeded', 'failed']);
      expect(getJob(db, ids.a.jobId)?.status).toBe('succeeded');
      expect(db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 3 });
      expect(db.prepare('SELECT scope, name FROM capacity_cooldowns').all()).toEqual([{ scope: 'agent', name: 'codex' }]);
      // The snapshot's own error is there once; run A's was appended under a new id.
      expect((db.prepare('SELECT message FROM errors ORDER BY id').all() as Array<{ message: string }>).map((e) => e.message)).toEqual(expect.arrayContaining(['an old error', 'run A stumbled']));
      expect(db.prepare("SELECT count(*) AS n FROM errors WHERE message = 'an old error'").get()).toEqual({ n: 1 });
      // The publication was mid-step when run A ended: closed, and not retried (its commits are gone).
      expect(db.prepare('SELECT state, retryable, lease_expires_at FROM publications').get()).toEqual({ state: 'failed', retryable: 0, lease_expires_at: null });
    });
    expect(first.unfinished.stepsClosed).toBe(1);
  });

  it('appends the rows a run added to the append-only tables under new ids, and adds nothing when applied twice', () => {
    const snap = snapshot();
    const a = copy(snap, 'a.db');
    const b = copy(snap, 'b.db');
    // Both runs start from the same AUTOINCREMENT position, so their new rows have the same ids.
    edit(a, (db) => {
      recordError(db, { scope: 'worker', message: 'from A', at: '2026-11-17T10:05:00.000Z' });
      db.prepare("INSERT INTO triage_runs (agent, started_at) VALUES ('claude', '2026-11-17T10:05:00.000Z')").run();
      db.prepare("INSERT INTO policy_events (at, kind, job_id, detail) VALUES ('2026-11-17T10:05:00.000Z', 'deferred', 'job_a', 'A waited')").run();
    });
    edit(b, (db) => {
      recordError(db, { scope: 'worker', message: 'from B', at: '2026-11-17T10:06:00.000Z' });
      db.prepare("INSERT INTO triage_runs (agent, started_at) VALUES ('codex', '2026-11-17T10:06:00.000Z')").run();
    });
    expect(read(a, (db) => db.prepare("SELECT id FROM errors WHERE message = 'from A'").get())).toEqual(read(b, (db) => db.prepare("SELECT id FROM errors WHERE message = 'from B'").get()));

    const shared = copy(snap, 'shared.db');
    expect(mergeState({ changed: a, base: snap, into: shared }).tables.errors).toMatchObject({ appended: 1 });
    const r = mergeState({ changed: b, base: snap, into: shared });
    expect(r.tables.errors).toMatchObject({ appended: 1 });
    expect(r.tables.triage_runs).toMatchObject({ appended: 1 });
    read(shared, (db) => {
      const errors = db.prepare('SELECT id, message FROM errors ORDER BY id').all() as Array<{ id: number; message: string }>;
      expect(errors.map((e) => e.message).filter((m) => m.startsWith('from'))).toEqual(['from A', 'from B']);
      expect(new Set(errors.map((e) => e.id)).size).toBe(errors.length);
      expect(db.prepare('SELECT agent FROM triage_runs ORDER BY started_at').all()).toEqual([{ agent: 'claude' }, { agent: 'codex' }]);
      expect(db.prepare('SELECT count(*) AS n FROM policy_events').get()).toEqual({ n: 1 });
    });

    // The same run merged again (an upload that was retried): nothing new, and the file is left alone.
    const before = readFileSync(shared);
    const again = mergeState({ changed: b, base: snap, into: shared });
    expect(again).toMatchObject({ changed: false, totals: { inserted: 0, updated: 0, appended: 0 } });
    expect(readFileSync(shared).equals(before)).toBe(true);
  });

  it('resolves conflicts by the rule of each table', () => {
    const snap = join(dir(), 'snapshot.db');
    const queued = edit(snap, (db) => {
      const jobId = insertQueuedJob(db, { repoId: 1, fullName: 'o/r', issue: 5 });
      db.prepare("INSERT INTO pool_cursors (pool, next_index) VALUES ('general', 0)").run();
      return jobId;
    });
    const a = copy(snap, 'a.db');
    const b = copy(snap, 'b.db');
    // Run A finishes the job; run B only tried and put it back (a deferral), later than A ended.
    edit(a, (db) => {
      const c = claimNextJob(db, config, claimOpts('wa', T0 + 10_000))!;
      started(db, c.run.id, T0 + 10_000);
      finishRun(db, c.run.id, { outcome: 'succeeded', now: () => T0 + 20_000 });
      setCooldown(db, { scope: 'group', name: 'acct', untilMs: T0 + 7_200_000, reason: 'A', stated: true, nowMs: T0 + 20_000 });
      recordReviewRequest(db, { repoId: 1, reviewId: 'R1', prNumber: 9, reviewer: 'allen', trigger: 'changes_requested', reviewUrl: null, submittedAt: null, state: 'ignored', reason: 'seen by A' }, () => T0 + 20_000);
      db.prepare("INSERT INTO meta (key, value) VALUES ('k', 'A')").run();
    });
    edit(b, (db) => {
      const c = claimNextJob(db, config, claimOpts('wb', T0 + 30_000))!;
      started(db, c.run.id, T0 + 30_000);
      finishRun(db, c.run.id, {
        outcome: 'failed',
        now: () => T0 + 40_000,
        handling: { kind: 'usage-limit', cooldown: { scope: 'group', name: 'acct', untilMs: T0 + 3_600_000, stated: false }, maxDeferrals: 5, detail: 'usage limit' },
      });
      recordReviewRequest(db, { repoId: 1, reviewId: 'R1', prNumber: 9, reviewer: 'allen', trigger: 'changes_requested', reviewUrl: null, submittedAt: null, state: 'not-allowed', reason: 'seen by B' }, () => T0 + 40_000);
      db.prepare("INSERT INTO meta (key, value) VALUES ('k', 'B')").run();
    });

    for (const order of [
      [a, b],
      [b, a],
    ]) {
      const shared = copy(snap, 'shared.db');
      const [first, second] = order as [string, string];
      mergeState({ changed: first, base: snap, into: shared });
      const r = mergeState({ changed: second, base: snap, into: shared });
      expect(r.tables.jobs!.conflicts).toBe(1);
      read(shared, (db) => {
        // jobs: the finished job stays finished, whichever run was merged last; counters keep the larger value.
        expect(db.prepare('SELECT status, attempts, deferrals FROM jobs WHERE id = ?').get(queued)).toEqual({ status: 'succeeded', attempts: 1, deferrals: 1 });
        // runs: both runs are on record.
        expect(db.prepare('SELECT worker_id, outcome FROM runs ORDER BY worker_id').all()).toEqual([
          { worker_id: 'wa', outcome: 'succeeded' },
          { worker_id: 'wb', outcome: 'failed' },
        ]);
        // capacity_cooldowns: the later expiry.
        expect(db.prepare('SELECT until, reason FROM capacity_cooldowns').get()).toEqual({ until: new Date(T0 + 7_200_000).toISOString(), reason: 'A' });
        // review_requests: the decision recorded first stands. meta and pool_cursors: last writer wins.
        const last = second === a ? 'A' : 'B';
        const firstName = first === a ? 'A' : 'B';
        expect(db.prepare('SELECT reason FROM review_requests').get()).toEqual({ reason: `seen by ${firstName}` });
        expect(db.prepare("SELECT value FROM meta WHERE key = 'k'").get()).toEqual({ value: last });
        const cursor = (file: string) => read(file, (x) => x.prepare("SELECT next_index FROM pool_cursors WHERE pool = 'general'").get());
        expect(db.prepare("SELECT next_index FROM pool_cursors WHERE pool = 'general'").get()).toEqual(cursor(second));
      });
    }
  });

  it('keeps a closed or merged pull request closed, and otherwise the later change', () => {
    const snap = join(dir(), 'snapshot.db');
    const pr = (db: Db, n: number) =>
      db
        .prepare(
          `INSERT INTO revision_prs (repo_id, pr_number, pr_url, source_run_id, original_event_id, workflow_id, issue_number, issue_title, issue_url,
             label, labels, action, pool, branch, state, created_at, updated_at)
           VALUES (1, ?, 'u', 'run_x', '1', 'wf', 1, 't', 'u', 'l', '[]', 'implement-issue', 'general', 'b', 'open', ?, ?)`,
        )
        .run(n, new Date(T0).toISOString(), new Date(T0).toISOString());
    edit(snap, (db) => {
      pr(db, 1);
      pr(db, 2);
    });
    const a = copy(snap, 'a.db');
    const b = copy(snap, 'b.db');
    const at = (ms: number) => new Date(T0 + ms).toISOString();
    edit(a, (db) => {
      db.prepare("UPDATE revision_prs SET state = 'closed', merge_state = 'merged', updated_at = ? WHERE pr_number = 1").run(at(1000));
      db.prepare("UPDATE revision_prs SET head_sha = 'aaa', updated_at = ? WHERE pr_number = 2").run(at(5000));
    });
    edit(b, (db) => {
      db.prepare("UPDATE revision_prs SET head_sha = 'late', updated_at = ? WHERE pr_number = 1").run(at(9000));
      db.prepare("UPDATE revision_prs SET head_sha = 'bbb', updated_at = ? WHERE pr_number = 2").run(at(3000));
    });
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      const shared = copy(snap, 'shared.db');
      mergeState({ changed: order[0]!, base: snap, into: shared });
      mergeState({ changed: order[1]!, base: snap, into: shared });
      expect(read(shared, (db) => db.prepare('SELECT pr_number, state, merge_state, head_sha FROM revision_prs ORDER BY pr_number').all())).toEqual([
        { pr_number: 1, state: 'closed', merge_state: 'merged', head_sha: null },
        { pr_number: 2, state: 'open', merge_state: null, head_sha: 'aaa' },
      ]);
    }
  });

  it('folds a job into the one the shared copy already has for the same event, with its runs', () => {
    // Two runs queued a reviewer job for the same head, each under an id of its own.
    const snap = join(dir(), 'snapshot.db');
    edit(snap, () => {});
    const make = (name: string, id: string, worker: string, at: number) => {
      const file = copy(snap, name);
      edit(file, (db) => {
        db.prepare(
          `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
           VALUES (?, 1, 'o/r', 'wf', 'pr-review:9:abc', 3, 'implement-issue', 'general', '{}', 'queued', 0, ?, ?)`,
        ).run(id, new Date(at).toISOString(), new Date(at).toISOString());
        const c = claimNextJob(db, config, claimOpts(worker, at))!;
        started(db, c.run.id, at);
        finishRun(db, c.run.id, { outcome: 'succeeded', now: () => at + 500 });
      });
      return file;
    };
    const a = make('a.db', 'job_from_a', 'wa', T0 + 1000);
    const b = make('b.db', 'job_from_b', 'wb', T0 + 2000);
    const shared = copy(snap, 'shared.db');
    mergeState({ changed: a, base: snap, into: shared });
    const r = mergeState({ changed: b, base: snap, into: shared });
    expect(r.jobsFolded).toEqual({ job_from_b: 'job_from_a' });
    read(shared, (db) => {
      expect(db.prepare('SELECT id FROM jobs').all()).toEqual([{ id: 'job_from_a' }]);
      expect(db.prepare('SELECT job_id, worker_id FROM runs ORDER BY worker_id').all()).toEqual([
        { job_id: 'job_from_a', worker_id: 'wa' },
        { job_id: 'job_from_a', worker_id: 'wb' },
      ]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });
  });

  it('does not bring back a job the shared copy pruned, with or without a snapshot', () => {
    const snap = join(dir(), 'snapshot.db');
    const old = T0 - 40 * 86_400_000;
    const { jobId } = edit(snap, (db) => finishedJob(db, 1, { worker: 'w0', at: old, outcome: 'failed' }));
    // The run retried the job and ran it again...
    const a = copy(snap, 'a.db');
    edit(a, (db) => {
      retryJob(db, jobId, () => T0);
      const c = claimNextJob(db, config, claimOpts('wa', T0))!;
      started(db, c.run.id, T0);
      finishRun(db, c.run.id, { outcome: 'succeeded', now: () => T0 + 1000 });
    });
    // ...while `updraft clean --older-than` pruned it in the shared copy.
    const shared = copy(snap, 'shared.db');
    edit(shared, (db) => expect(pruneJob(db, jobId, new Date(T0 - 86_400_000).toISOString(), () => T0)).toMatchObject({ pruned: true }));

    const r = mergeState({ changed: a, base: snap, into: shared });
    expect(r.tables.jobs).toMatchObject({ inserted: 0, updated: 0, dropped: 1 });
    expect(r.tables.runs).toMatchObject({ inserted: 0, dropped: 1 });
    read(shared, (db) => {
      expect(db.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT count(*) AS n FROM pruned_events').get()).toEqual({ n: 1 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });

    // A run that started from nothing and made the same event's job again: the tombstone still stands.
    const fresh = join(dir(), 'fresh.db');
    const event = read(snap, (db) => db.prepare('SELECT repo_id, workflow_id, event_id FROM jobs').get() as { repo_id: number; workflow_id: string; event_id: string });
    edit(fresh, (db) => {
      db.prepare(
        `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
         VALUES ('job_again', ?, 'o/r', ?, ?, 1, 'implement-issue', 'general', '{}', 'queued', 0, ?, ?)`,
      ).run(event.repo_id, event.workflow_id, event.event_id, new Date(T0).toISOString(), new Date(T0).toISOString());
    });
    expect(mergeState({ changed: fresh, into: shared }).tables.jobs).toMatchObject({ inserted: 0, dropped: 1 });
    expect(read(shared, (db) => db.prepare('SELECT count(*) AS n FROM jobs').get())).toEqual({ n: 0 });
  });

  it("leaves another run's unfinished work alone, closes this run's, and never carries a worker lock", () => {
    // The snapshot holds a job some other machine is (or was) running.
    const snap = join(dir(), 'snapshot.db');
    const foreign = edit(snap, (db) => {
      const jobId = insertQueuedJob(db, { repoId: 1, fullName: 'o/r', issue: 1 });
      const c = claimNextJob(db, config, claimOpts('other', T0))!;
      started(db, c.run.id, T0);
      return { jobId, runId: c.run.id };
    });
    const a = copy(snap, 'a.db');
    const own = edit(a, (db) => {
      const startedJob = insertQueuedJob(db, { repoId: 1, fullName: 'o/r', issue: 2 });
      const c1 = claimNextJob(db, config, claimOpts('wa', T0 + 1000))!;
      started(db, c1.run.id, T0 + 1000);
      const claimed = insertQueuedJob(db, { repoId: 1, fullName: 'o/r', issue: 3 });
      const c2 = claimNextJob(db, config, claimOpts('wa', T0 + 2000))!;
      expect([c1.job.id, c2.job.id]).toEqual([startedJob, claimed]);
      acquireWorkerLock(db, { workerId: 'wa', pid: 1, hostname: 'vm' }, { now: () => T0, isPidAlive: () => true });
      return { started: startedJob, claimed, startedRun: c1.run.id, claimedRun: c2.run.id };
    });
    // The process was killed: the lock row and the open runs are still in its file.
    expect(stateInfo(a)).toMatchObject({ openRuns: 3, workerLock: true, jobs: { running: 3 } });

    const shared = join(dir(), 'shared.db');
    const r = mergeState({ changed: a, base: snap, into: shared, now: () => T0 + 60_000 });
    expect(r).toMatchObject({ created: true, changed: true, unfinished: { runsInterrupted: 1, runsReleased: 1 } });
    read(shared, (db) => {
      // Not in the shared copy at all: this run never touched the other machine's job.
      expect(getJob(db, foreign.jobId)).toBeNull();
      expect(getJob(db, own.started)).toMatchObject({ status: 'interrupted' });
      expect(getJob(db, own.claimed)).toMatchObject({ status: 'queued' });
      expect(db.prepare('SELECT outcome, ended_at IS NOT NULL AS ended FROM runs WHERE id = ?').get(own.startedRun)).toEqual({ outcome: 'interrupted', ended: 1 });
      expect(db.prepare('SELECT outcome, ended_at IS NOT NULL AS ended FROM runs WHERE id = ?').get(own.claimedRun)).toEqual({ outcome: null, ended: 1 });
      expect(db.prepare('SELECT count(*) AS n FROM worker_lock').get()).toEqual({ n: 0 });
    });

    // Into a shared copy that has the other machine's job: it is exactly as it was.
    const shared2 = copy(snap, 'shared2.db');
    mergeState({ changed: a, base: snap, into: shared2, now: () => T0 + 60_000 });
    read(shared2, (db) => {
      expect(getJob(db, foreign.jobId)).toMatchObject({ status: 'running' });
      expect(db.prepare('SELECT ended_at, outcome FROM runs WHERE id = ?').get(foreign.runId)).toEqual({ ended_at: null, outcome: null });
      expect(getJob(db, own.started)).toMatchObject({ status: 'interrupted' });
    });
  });

  it('migrates an older shared copy, and leaves one file with no write-ahead log beside it', () => {
    const d = dir();
    const shared = join(d, 'shared.db');
    const old = openDatabase(shared, { migrateTo: 12 });
    const kept = insertOldJob(old);
    old.close();
    const a = join(dir(), 'a.db');
    const added = edit(a, (db) => finishedJob(db, 21, { worker: 'wa', at: T0 }));

    const r = mergeState({ changed: a, into: shared });
    expect(r).toMatchObject({ changed: true, created: false, migratedFrom: 12, schemaVersion: SCHEMA_VERSION });
    expect(existsSync(`${shared}-wal`)).toBe(false);
    expect(existsSync(`${shared}-shm`)).toBe(false);
    // Nothing else is left in the directory either.
    read(shared, (db) => {
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
      expect(getJob(db, kept)?.status).toBe('canceled');
      expect(getJob(db, added.jobId)?.status).toBe('succeeded');
      // The rollup of the migrated copy has this run's facts too.
      expect(db.prepare("SELECT count(*) AS n FROM metric_events WHERE kind = 'run.ended'").get()).toEqual({ n: 1 });
    });
    // The long-running worker opens it as any state database.
    edit(shared, (db) => expect(getJob(db, added.jobId)?.status).toBe('succeeded'));
  });

  it('migrates an older snapshot aside, without writing to it', () => {
    const snap = join(dir(), 'snapshot.db');
    const old = openDatabase(snap, { migrateTo: 12 });
    insertOldJob(old);
    old.close();
    const bytes = readFileSync(snap);
    // The run opened its copy with the current CLI, which migrated it.
    const a = copy(snap, 'a.db');
    const added = edit(a, (db) => finishedJob(db, 22, { worker: 'wa', at: T0 }));
    const shared = copy(snap, 'shared.db');
    const r = mergeState({ changed: a, base: snap, into: shared });
    expect(r.tables.jobs).toMatchObject({ inserted: 1, updated: 0 });
    expect(readFileSync(snap).equals(bytes)).toBe(true);
    expect(read(shared, (db) => getJob(db, added.jobId)?.status)).toBe('succeeded');
  });

  it('refuses a shared copy that is newer than this CLI, and leaves it untouched', () => {
    const shared = join(dir(), 'shared.db');
    edit(shared, (db) => db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`));
    const bytes = readFileSync(shared);
    const a = join(dir(), 'a.db');
    edit(a, (db) => finishedJob(db, 23, { worker: 'wa', at: T0 }));
    expect(() => mergeState({ changed: a, into: shared })).toThrow(SchemaTooNewError);
    expect(readFileSync(shared).equals(bytes)).toBe(true);
  });

  it('reports changed: false, and does not rewrite the shared copy, when the run changed nothing', () => {
    const snap = snapshot();
    const a = copy(snap, 'a.db');
    // The run opened its copy and took the lock, and nothing else.
    edit(a, (db) => acquireWorkerLock(db, { workerId: 'wa', pid: 1, hostname: 'vm' }, { now: () => T0, isPidAlive: () => true }));
    const shared = copy(snap, 'shared.db');
    edit(shared, (db) => finishedJob(db, 30, { worker: 'other', at: T0 + 5000 }));
    const bytes = readFileSync(shared);
    const r = mergeState({ changed: a, base: snap, into: shared });
    expect(r).toMatchObject({ changed: false, created: false, totals: { inserted: 0, updated: 0, appended: 0, conflicts: 0, dropped: 0 } });
    expect(readFileSync(shared).equals(bytes)).toBe(true);
    // And nothing was left next to it.
    expect(existsSync(`${shared}-wal`)).toBe(false);
  });

  it('reads what a killed process left in the write-ahead log beside its database', () => {
    const d = dir();
    const live = join(d, 'live.db');
    const db = openDatabase(live);
    try {
      const { jobId } = finishedJob(db, 60, { worker: 'wa', at: T0 });
      // The process never closed its database: the job is in live.db-wal, not in live.db.
      expect(existsSync(`${live}-wal`)).toBe(true);
      const killed = join(dir(), 'state.db');
      copyFileSync(live, killed);
      copyFileSync(`${live}-wal`, `${killed}-wal`);

      const shared = join(dir(), 'shared.db');
      const r = mergeState({ changed: killed, into: shared });
      expect(r.tables.jobs).toMatchObject({ inserted: 1 });
      expect(read(shared, (x) => getJob(x, jobId)?.status)).toBe('succeeded');
      expect(existsSync(`${shared}-wal`)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('leaves the shared copy as it was when the merge fails part-way', () => {
    const snap = snapshot();
    const a = copy(snap, 'a.db');
    edit(a, (db) => {
      finishedJob(db, 40, { worker: 'wa', at: T0 });
      db.exec('CREATE TABLE surprise (id INTEGER PRIMARY KEY)');
    });
    const shared = copy(snap, 'shared.db');
    const bytes = readFileSync(shared);
    expect(() => mergeState({ changed: a, base: snap, into: shared })).toThrow(/no merge rule for table\(s\) surprise/);
    expect(readFileSync(shared).equals(bytes)).toBe(true);
  });
});

/** A job in a database that is still at an old schema version (fewer columns). */
function insertOldJob(db: Db): string {
  db.prepare(
    `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
     VALUES ('job_old', 1, 'o/r', 'wf', '77', 7, 'implement-issue', 'general', ?, 'canceled', 0, ?, ?)`,
  ).run(JSON.stringify({ type: 'issue.labeled' }), new Date(T0).toISOString(), new Date(T0).toISOString());
  return 'job_old';
}

describe('updraft state merge / info', () => {
  const ctx = () => {
    const out = new MemoryOutput();
    const err = new MemoryOutput();
    return { ctx: { out, err, now: () => T0 + 100_000 } as unknown as CommandContext, out, err };
  };

  it('prints one JSON object with per-table counts, the schema version and whether anything changed', async () => {
    const snap = snapshot();
    const a = copy(snap, 'a.db');
    edit(a, (db) => finishedJob(db, 50, { worker: 'wa', at: T0 }));
    const shared = copy(snap, 'shared.db');
    const c = ctx();
    expect(await stateMergeCommand(c.ctx, { changed: a, base: snap, into: shared, json: true })).toBe(0);
    const lines = c.out.text.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      ok: true,
      changed: true,
      schemaVersion: SCHEMA_VERSION,
      created: false,
      tables: { jobs: { inserted: 1, updated: 0, appended: 0, conflicts: 0, dropped: 0 }, runs: { inserted: 1 }, metric_events: { appended: 3 } },
      totals: { inserted: 2 },
      exitCode: 0,
    });

    const again = ctx();
    expect(await stateMergeCommand(again.ctx, { changed: a, base: snap, into: shared, json: true })).toBe(0);
    expect(JSON.parse(again.out.text)).toMatchObject({ ok: true, changed: false });
  });

  it('exits 5 for a newer shared copy and 2 for a missing file, with the reason in the JSON', async () => {
    const a = join(dir(), 'a.db');
    edit(a, () => {});
    const shared = join(dir(), 'shared.db');
    edit(shared, (db) => db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 3}`));
    const c = ctx();
    expect(await stateMergeCommand(c.ctx, { changed: a, into: shared, json: true })).toBe(5);
    expect(JSON.parse(c.out.text)).toMatchObject({ ok: false, changed: false, reason: 'schema-too-new', exitCode: 5 });
    expect(c.err.text).toContain('newer than this CLI supports');

    const missing = ctx();
    expect(await stateMergeCommand(missing.ctx, { changed: join(dir(), 'nope.db'), into: join(dir(), 'new.db'), json: true })).toBe(2);
    expect(JSON.parse(missing.out.text)).toMatchObject({ ok: false, reason: 'bad-input', exitCode: 2 });
    const same = ctx();
    expect(await stateMergeCommand(same.ctx, { changed: a, into: a })).toBe(2);
  });

  it('info reads the schema version and row counts without changing the file', async () => {
    const snap = snapshot();
    const bytes = readFileSync(snap);
    const c = ctx();
    expect(await stateInfoCommand(c.ctx, { db: snap, json: true })).toBe(0);
    expect(JSON.parse(c.out.text)).toMatchObject({
      exists: true,
      schemaVersion: SCHEMA_VERSION,
      supportedSchemaVersion: SCHEMA_VERSION,
      compatible: true,
      tables: { jobs: 1, runs: 1, errors: 1, worker_lock: 0 },
      jobs: { succeeded: 1 },
      openRuns: 0,
      workerLock: false,
    });
    expect(readFileSync(snap).equals(bytes)).toBe(true);
    const text = ctx();
    expect(await stateInfoCommand(text.ctx, { db: snap })).toBe(0);
    expect(text.out.text).toContain(`schema v${SCHEMA_VERSION}`);
    const missing = ctx();
    expect(await stateInfoCommand(missing.ctx, { db: join(dir(), 'nope.db'), json: true })).toBe(2);
    expect(JSON.parse(missing.out.text)).toMatchObject({ exists: false });
  });
});
