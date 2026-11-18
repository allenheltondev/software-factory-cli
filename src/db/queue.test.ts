import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configSchema, type FactoryConfig, type FactoryConfigInput } from '../config/schema.js';
import { ENVELOPE_SCHEMA_VERSION, type EventEnvelope } from '../types.js';
import { openDatabase, type Db } from './database.js';
import {
  CANCELED_BY_USER,
  MAX_START_FAILURES,
  cancelClaim,
  claimNextJob,
  finishRun,
  getJob,
  getRun,
  getStatusSnapshot,
  listCancelRequestedRuns,
  markExecutionStarted,
  releaseClaim,
  requestJobCancel,
  retryJob,
  type Claim,
} from './queue.js';
import { acquireWorkerLock, WORKER_STALE_MS } from '../worker/lock.js';

const T0 = Date.parse('2026-11-17T10:00:00.000Z');
const now = () => T0;
const RUNS_DIR = join('C:', 'factory state', 'runs');

function makeConfig(over: Partial<FactoryConfigInput> = {}): FactoryConfig {
  return configSchema.parse({
    version: 1,
    maxConcurrent: 5,
    agents: { codex: { maxConcurrent: 1 }, claude: { maxConcurrent: 1 }, kiro: { maxConcurrent: 1 } },
    pools: { art: { agents: ['codex'] }, general: { agents: ['claude', 'kiro'] } },
    actions: { 'implement-issue': { prompt: './prompts/implement-issue.md' } },
    dispatch: { allowedActors: ['allen'] },
    ...over,
  });
}

let seq = 0;
function insertJob(
  db: Db,
  o: { issue?: number; repoId?: number; pool?: string; action?: string; eventId?: string } = {},
): string {
  seq++;
  const id = `job_${String(seq).padStart(5, '0')}`;
  const repoId = o.repoId ?? 1;
  const issue = o.issue ?? seq;
  const createdAt = new Date(T0 - 1_000_000 + seq * 1000).toISOString();
  const envelope: EventEnvelope = {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    type: 'issue.labeled',
    repo: { id: repoId, fullName: 'owner/repo' },
    issue: { number: issue, title: `Issue ${issue}`, url: `https://github.com/owner/repo/issues/${issue}` },
    eventId: o.eventId ?? String(seq),
    url: `https://github.com/owner/repo/issues/${issue}`,
    actor: 'allen',
    label: 'factory:ready',
    labelsAtEnqueue: ['factory:ready'],
    createdAt,
  };
  db.prepare(
    `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
     VALUES (?, ?, 'owner/repo', 'implement-issue:factory:ready', ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
  ).run(id, repoId, envelope.eventId, issue, o.action ?? 'implement-issue', o.pool ?? 'general', JSON.stringify(envelope), createdAt, createdAt);
  return id;
}

const claim = (db: Db, config: FactoryConfig): Claim | null =>
  claimNextJob(db, config, { workerId: 'wrk_test', hostname: 'host-a', leaseSeconds: 60, runsDir: RUNS_DIR, now });

describe('claimNextJob', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('keeps a job queued while both general agents are busy', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    insertJob(db);
    insertJob(db);
    const third = insertJob(db);
    expect(claim(db, config)?.run.agent).toBe('claude');
    expect(claim(db, config)?.run.agent).toBe('kiro');
    expect(claim(db, config)).toBeNull();
    expect(getJob(db, third)?.status).toBe('queued');
  });

  it('creates the run and marks the job running', () => {
    const db = openDatabase(':memory:');
    const id = insertJob(db);
    const c = claim(db, makeConfig())!;
    expect(c.job).toMatchObject({ id, status: 'running', attempts: 1 });
    expect(c.run).toMatchObject({
      jobId: id,
      attempt: 1,
      pool: 'general',
      agent: 'claude',
      checkoutPath: null,
      workerId: 'wrk_test',
      startedAt: new Date(T0).toISOString(),
      leaseExpiresAt: new Date(T0 + 60_000).toISOString(),
      endedAt: null,
    });
    expect(c.run.logPath).toBe(join(RUNS_DIR, c.run.id, 'run.log'));
  });

  it('honors the global limit', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig({ maxConcurrent: 2 });
    insertJob(db, { pool: 'art' });
    insertJob(db);
    const g2 = insertJob(db);
    expect(claim(db, config)?.run.agent).toBe('codex');
    expect(claim(db, config)?.run.agent).toBe('claude');
    expect(claim(db, config)).toBeNull();
    expect(getJob(db, g2)?.status).toBe('queued');
  });

  it('applies per-agent limits across pools', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig({
      pools: { solo: { agents: ['claude'] }, general: { agents: ['claude', 'kiro'] } },
    });
    insertJob(db, { pool: 'solo' });
    insertJob(db, { pool: 'general' });
    const s2 = insertJob(db, { pool: 'solo' });
    expect(claim(db, config)?.run.agent).toBe('claude');
    // general's cursor points at claude, but claude is busy with the solo job.
    expect(claim(db, config)?.run.agent).toBe('kiro');
    expect(claim(db, config)).toBeNull();
    expect(getJob(db, s2)?.status).toBe('queued');
  });

  it('ignores disabled agents', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig({
      agents: { codex: {}, claude: { enabled: false }, kiro: {} },
    });
    insertJob(db);
    insertJob(db);
    expect(claim(db, config)?.run.agent).toBe('kiro');
    expect(claim(db, config)).toBeNull();
  });

  it('skips a saturated pool and starts later jobs from other pools', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    insertJob(db, { pool: 'art' });
    const a2 = insertJob(db, { pool: 'art' });
    const g1 = insertJob(db);
    expect(claim(db, config)?.run.agent).toBe('codex');
    expect(claim(db, config)?.job.id).toBe(g1);
    expect(getJob(db, a2)?.status).toBe('queued');
  });

  it('alternates round-robin and keeps the rotation across a reopened database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory queue '));
    tmpDirs.push(dir);
    const file = join(dir, 'state dir', 'state.db');
    const config = makeConfig();
    let db = openDatabase(file);
    for (let i = 0; i < 4; i++) insertJob(db);

    const first = claim(db, config)!;
    finishRun(db, first.run.id, { outcome: 'succeeded', now });
    const second = claim(db, config)!;
    finishRun(db, second.run.id, { outcome: 'succeeded', now });
    expect([first.run.agent, second.run.agent]).toEqual(['claude', 'kiro']);
    db.close();

    db = openDatabase(file);
    const third = claim(db, config)!;
    finishRun(db, third.run.id, { outcome: 'succeeded', now });
    const fourth = claim(db, config)!;
    expect([third.run.agent, fourth.run.agent]).toEqual(['claude', 'kiro']);
    db.close();
  });

  it('serializes jobs for the same issue while a different issue in the repo runs in parallel', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig({ agents: { codex: {}, claude: { maxConcurrent: 3 }, kiro: { maxConcurrent: 3 } } });
    const a = insertJob(db, { issue: 7 });
    const b = insertJob(db, { issue: 7 });
    const c = insertJob(db, { issue: 8 });
    const ca = claim(db, config)!;
    expect(ca.job.id).toBe(a);
    expect(claim(db, config)?.job.id).toBe(c);
    expect(claim(db, config)).toBeNull();
    expect(getJob(db, b)?.status).toBe('queued');
    finishRun(db, ca.run.id, { outcome: 'succeeded', now });
    expect(claim(db, config)?.job.id).toBe(b);
  });

  it('lets a re-added label job run only after the prior job for that issue finishes', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    const first = insertJob(db, { issue: 42, eventId: '1001' });
    const first_ = claim(db, config)!;
    expect(first_.job.id).toBe(first);
    // label removed and re-added while the first job runs: a new event, a new job
    const second = insertJob(db, { issue: 42, eventId: '1002' });
    expect(claim(db, config)).toBeNull();
    expect(getJob(db, second)?.status).toBe('queued');
    finishRun(db, first_.run.id, { outcome: 'failed', error: 'agent exited 1', now });
    expect(claim(db, config)?.job.id).toBe(second);
  });

  it('fails (not drops) a job whose pool or action was removed from the config', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    const orphan = insertJob(db, { pool: 'removed-pool' });
    const noAction = insertJob(db, { action: 'removed-action' });
    const ok = insertJob(db);
    expect(claim(db, config)?.job.id).toBe(ok);
    expect(getJob(db, orphan)).toMatchObject({ status: 'failed' });
    expect(getJob(db, orphan)?.statusReason).toMatch(/pool "removed-pool" is no longer configured/);
    expect(getJob(db, noAction)?.statusReason).toMatch(/action "removed-action"/);
    const errors = db.prepare("SELECT job_id FROM errors WHERE scope = 'queue'").all() as { job_id: string }[];
    expect(errors.map((e) => e.job_id).sort()).toEqual([orphan, noAction].sort());
  });

  it('is not fooled by pool names that match Object.prototype members', () => {
    const db = openDatabase(':memory:');
    const id = insertJob(db, { pool: 'constructor' });
    expect(claim(db, makeConfig())).toBeNull();
    expect(getJob(db, id)?.status).toBe('failed');
  });
});

describe('finishRun', () => {
  it('maps outcomes to job states', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig({ agents: { codex: {}, claude: { maxConcurrent: 3 }, kiro: { maxConcurrent: 3 } } });
    const ids = [insertJob(db), insertJob(db), insertJob(db)];
    const outcomes = ['succeeded', 'failed', 'interrupted'] as const;
    for (const outcome of outcomes) {
      const c = claim(db, config)!;
      finishRun(db, c.run.id, { outcome, error: outcome === 'succeeded' ? null : `${outcome}!`, now });
      expect(getRun(db, c.run.id)).toMatchObject({ outcome, endedAt: new Date(T0).toISOString() });
    }
    expect(ids.map((id) => getJob(db, id)?.status)).toEqual([...outcomes]);
    // idempotent: finishing the already-succeeded run again changes nothing.
    // (Select by outcome; run IDs created in the same millisecond have random order.)
    const doneRun = db.prepare("SELECT id FROM runs WHERE outcome = 'succeeded'").get() as { id: string };
    finishRun(db, doneRun.id, { outcome: 'failed', now });
    expect(getRun(db, doneRun.id)?.outcome).toBe('succeeded');
    expect(getJob(db, ids[0]!)?.status).toBe('succeeded');
  });

  it('requeues on start_failed, prefers another agent, and caps repeated start failures', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    const id = insertJob(db);

    const c1 = claim(db, config)!;
    expect(c1.run.agent).toBe('claude');
    expect(c1.run.hostname).toBe('host-a');
    expect(getRun(db, c1.run.id)?.hostname).toBe('host-a');
    finishRun(db, c1.run.id, { outcome: 'start_failed', error: 'claude not found', now });
    expect(getJob(db, id)).toMatchObject({ status: 'queued', attempts: 1, startFailures: 1 });
    expect(getJob(db, id)?.statusReason).toMatch(/claude could not start/);

    // Even with the cursor pointing back at claude, the agent that just failed is avoided.
    db.prepare("UPDATE pool_cursors SET next_index = 0 WHERE pool = 'general'").run();
    const c2 = claim(db, config)!;
    expect(c2.run.agent).toBe('kiro');
    expect(c2.run.attempt).toBe(2);
    finishRun(db, c2.run.id, { outcome: 'start_failed', error: 'KIRO_API_KEY missing', now });
    expect(getJob(db, id)).toMatchObject({ status: 'queued', startFailures: 2 });

    // A claim released before start (no outcome) neither counts nor breaks the streak.
    const released = claim(db, config)!;
    releaseClaim(db, released.run.id, 'GitHub unreachable', now);
    expect(getJob(db, id)?.startFailures).toBe(2);

    const c3 = claim(db, config)!;
    finishRun(db, c3.run.id, { outcome: 'start_failed', error: 'still broken', now });
    expect(MAX_START_FAILURES).toBe(3);
    expect(getJob(db, id)).toMatchObject({ status: 'failed', startFailures: 3 });
    expect(getJob(db, id)?.statusReason).toMatch(/no agent could start after 3 attempts/);

    // A deliberate retry resets the start-failure count, and nothing is kept in meta.
    expect(retryJob(db, id, now).startFailures).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM meta').get()).toEqual({ n: 0 });
    const c4 = claim(db, config)!;
    finishRun(db, c4.run.id, { outcome: 'start_failed', error: 'once more', now });
    expect(getJob(db, id)).toMatchObject({ status: 'queued', startFailures: 1 });
    // After a retry, earlier start failures no longer steer agent choice: only c4's agent is avoided.
    db.prepare("UPDATE pool_cursors SET next_index = 0 WHERE pool = 'general'").run();
    expect(claim(db, config)?.run.agent).toBe(c4.run.agent === 'claude' ? 'kiro' : 'claude');
  });
});

describe('cancelClaim / releaseClaim', () => {
  it('cancels the job without recording an agent outcome and frees the slot', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig({ pools: { general: { agents: ['claude'] } } });
    const id = insertJob(db);
    const next = insertJob(db);
    const c = claim(db, config)!;
    cancelClaim(db, c.run.id, 'issue was closed', now);
    expect(getJob(db, id)).toMatchObject({ status: 'canceled', statusReason: 'issue was closed' });
    expect(getRun(db, c.run.id)).toMatchObject({ outcome: null, endedAt: new Date(T0).toISOString() });
    expect(claim(db, config)?.job.id).toBe(next);
  });

  it('releases a claim back to the queue', () => {
    const db = openDatabase(':memory:');
    const id = insertJob(db);
    const c = claim(db, makeConfig())!;
    releaseClaim(db, c.run.id, 'GitHub unreachable', now);
    expect(getJob(db, id)?.status).toBe('queued');
    expect(claim(db, makeConfig())?.job.id).toBe(id);
  });
});

describe('markExecutionStarted', () => {
  it('marks an open, unstarted run only while the worker holds the lock', () => {
    const db = openDatabase(':memory:');
    insertJob(db);
    const c = claim(db, makeConfig())!;
    expect(c.run.executionStartedAt).toBeNull();
    // wrk_test does not hold the lock (nobody does).
    expect(markExecutionStarted(db, c.run.id, { workerId: 'wrk_test', now })).toBeNull();
    db.prepare(
      "INSERT INTO worker_lock (id, worker_id, pid, hostname, started_at, heartbeat_at) VALUES (1, 'wrk_test', 1, 'host-a', ?, ?)",
    ).run(new Date(T0).toISOString(), new Date(T0).toISOString());
    expect(markExecutionStarted(db, c.run.id, { workerId: 'wrk_test', now })).toBe(new Date(T0).toISOString());
    expect(getRun(db, c.run.id)?.executionStartedAt).toBe(new Date(T0).toISOString());
    expect(markExecutionStarted(db, c.run.id, { workerId: 'wrk_test', now })).toBeNull(); // only once

    insertJob(db);
    const closed = claim(db, makeConfig())!;
    releaseClaim(db, closed.run.id, 'requeued by another worker', now);
    expect(markExecutionStarted(db, closed.run.id, { workerId: 'wrk_test', now })).toBeNull();
  });
});

describe('retryJob', () => {
  it('requeues failed, interrupted and canceled jobs only', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig({ agents: { codex: {}, claude: { maxConcurrent: 3 }, kiro: { maxConcurrent: 3 } } });
    const failed = insertJob(db);
    const c = claim(db, config)!;
    finishRun(db, c.run.id, { outcome: 'failed', error: 'boom', now });
    expect(retryJob(db, failed, now)).toMatchObject({ status: 'queued', statusReason: 'retried by user (was failed)' });

    const running = claim(db, config)!;
    expect(() => retryJob(db, running.job.id)).toThrow(/is running; only failed, interrupted or canceled/);
    const queued = insertJob(db);
    expect(() => retryJob(db, queued)).toThrow(/is queued/);
    expect(() => retryJob(db, 'job_missing')).toThrow(/job job_missing not found/);
  });
});

describe('getStatusSnapshot', () => {
  it('reports counts, agent load, active runs, recent jobs/errors, checkpoints and worker staleness', () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    insertJob(db, { pool: 'gone' });
    insertJob(db);
    insertJob(db);
    const c = claim(db, config)!; // fails the 'gone' job and claims one general job
    db.prepare(
      "INSERT INTO repo_checkpoints (repo_id, full_name, last_event_id, initialized_at, updated_at) VALUES (1, 'owner/repo', 99, ?, ?)",
    ).run(new Date(T0).toISOString(), new Date(T0).toISOString());
    db.prepare(
      "INSERT INTO worker_lock (id, worker_id, pid, hostname, started_at, heartbeat_at) VALUES (1, 'wrk_x', 123, 'host', ?, ?)",
    ).run(new Date(T0).toISOString(), new Date(T0 - 60_000).toISOString());

    const s = getStatusSnapshot(db, config, now);
    expect(s.counts).toEqual({ queued: 1, running: 1, succeeded: 0, failed: 1, interrupted: 0, canceled: 0 });
    expect(s.agents).toEqual([
      { agent: 'codex', enabled: true, running: 0, maxConcurrent: 1 },
      { agent: 'claude', enabled: true, running: 1, maxConcurrent: 1 },
      { agent: 'kiro', enabled: true, running: 0, maxConcurrent: 1 },
    ]);
    expect(s.activeRuns.map((a) => a.run.id)).toEqual([c.run.id]);
    expect(s.activeRuns[0]?.job.id).toBe(c.job.id);
    expect(s.recentJobs).toHaveLength(3);
    expect(s.recentErrors[0]?.scope).toBe('queue');
    expect(s.checkpoints).toEqual([{ repoId: 1, fullName: 'owner/repo', lastEventId: 99, updatedAt: new Date(T0).toISOString() }]);
    expect(s.worker).toMatchObject({ workerId: 'wrk_x', stale: true });
    expect(getStatusSnapshot(db, config, () => T0 - 50_000).worker?.stale).toBe(false);
  });
});

describe('requestJobCancel (factory cancel)', () => {
  /** A database whose worker lock is held, freshly, by the worker that claims in these tests. */
  function withWorker(workerId = 'wrk_test') {
    const db = openDatabase(':memory:');
    acquireWorkerLock(db, { workerId, pid: 1, hostname: 'host-a' }, { now, isPidAlive: () => true });
    return db;
  }

  it('cancels a queued job directly, so it is never claimed', () => {
    const db = withWorker();
    const id = insertJob(db);
    expect(requestJobCancel(db, id, now)).toMatchObject({ kind: 'canceled', job: { status: 'canceled', statusReason: CANCELED_BY_USER } });
    expect(claim(db, makeConfig())).toBeNull();
    expect(requestJobCancel(db, id, now)).toMatchObject({ kind: 'terminal', job: { status: 'canceled' } });
    expect(requestJobCancel(db, 'job_missing', now)).toEqual({ kind: 'not-found' });
  });

  it('records a request on the open run of a running job; closing the run then cancels the job', () => {
    const db = withWorker();
    const id = insertJob(db);
    const c = claim(db, makeConfig())!;
    markExecutionStarted(db, c.run.id, { workerId: 'wrk_test', now });
    const res = requestJobCancel(db, id, now);
    expect(res).toMatchObject({ kind: 'requested', alreadyRequested: false, run: { id: c.run.id, cancelRequestedAt: new Date(T0).toISOString() } });
    expect(requestJobCancel(db, id, now)).toMatchObject({ kind: 'requested', alreadyRequested: true });
    // Nothing is canceled yet: the worker has to stop the run.
    expect(getJob(db, id)?.status).toBe('running');
    expect(listCancelRequestedRuns(db)).toEqual([c.run.id]);

    // The executor reports the stop as 'interrupted'; the request turns that into canceled.
    expect(finishRun(db, c.run.id, { outcome: 'interrupted', error: 'canceled by user before the run finished', now })).toEqual({
      outcome: null,
      canceledByUser: true,
    });
    expect(getJob(db, id)).toMatchObject({ status: 'canceled', statusReason: CANCELED_BY_USER });
    expect(getRun(db, c.run.id)).toMatchObject({ outcome: null, error: CANCELED_BY_USER, endedAt: new Date(T0).toISOString() });
    expect(listCancelRequestedRuns(db)).toEqual([]);
    // A user cancel is not an error.
    expect(db.prepare('SELECT count(*) AS n FROM errors').get()).toEqual({ n: 0 });
  });

  it.each(['succeeded', 'failed', 'start_failed'] as const)(
    'a request recorded before the run closes wins over a run that ends %s on its own',
    (outcome) => {
      const db = withWorker();
      const id = insertJob(db);
      const c = claim(db, makeConfig())!;
      markExecutionStarted(db, c.run.id, { workerId: 'wrk_test', now });
      expect(requestJobCancel(db, id, now).kind).toBe('requested');
      expect(finishRun(db, c.run.id, { outcome, error: outcome === 'succeeded' ? null : 'boom', now })).toEqual({
        outcome: null,
        canceledByUser: true,
      });
      // Not requeued (start_failed normally is), and what really happened stays on the run.
      expect(getJob(db, id)).toMatchObject({ status: 'canceled', statusReason: CANCELED_BY_USER, startFailures: 0 });
      expect(getRun(db, c.run.id)?.error).toBe(
        `${CANCELED_BY_USER} (the run had already ended: ${outcome}${outcome === 'succeeded' ? '' : ', boom'})`,
      );
      expect(claim(db, makeConfig())).toBeNull();
    },
  );

  it('a run that closes first wins: the request is refused and nothing changes', () => {
    const db = withWorker();
    const id = insertJob(db);
    const c = claim(db, makeConfig())!;
    expect(finishRun(db, c.run.id, { outcome: 'succeeded', now })).toEqual({ outcome: 'succeeded', canceledByUser: false });
    expect(requestJobCancel(db, id, now)).toMatchObject({ kind: 'terminal', job: { status: 'succeeded' } });
    expect(getRun(db, c.run.id)).toMatchObject({ outcome: 'succeeded', cancelRequestedAt: null });
    expect(finishRun(db, c.run.id, { outcome: 'failed', now })).toBeNull();
  });

  it('a request made while the run is only claimed stops it from starting, and it is not requeued', () => {
    const db = withWorker();
    const id = insertJob(db);
    const c = claim(db, makeConfig())!;
    expect(requestJobCancel(db, id, now).kind).toBe('requested');
    expect(markExecutionStarted(db, c.run.id, { workerId: 'wrk_test', now })).toBeNull();
    // The worker (or a later worker's reconcile) releases the claim; the cancel wins over the requeue.
    releaseClaim(db, c.run.id, 'run was closed before it started', now);
    expect(getJob(db, id)).toMatchObject({ status: 'canceled', statusReason: CANCELED_BY_USER });
    expect(getRun(db, c.run.id)).toMatchObject({ outcome: null, error: `canceled before start: ${CANCELED_BY_USER}` });
  });

  it('a request does not carry over to the next attempt after a retry', () => {
    const db = withWorker();
    const config = makeConfig();
    const id = insertJob(db);
    const first = claim(db, config)!;
    markExecutionStarted(db, first.run.id, { workerId: 'wrk_test', now });
    requestJobCancel(db, id, now);
    finishRun(db, first.run.id, { outcome: 'interrupted', now });

    // retry and cancel never apply to the same state, so whichever commits first decides.
    expect(retryJob(db, id, now).status).toBe('queued');
    const second = claim(db, config)!;
    expect(second.run).toMatchObject({ jobId: id, attempt: 2, cancelRequestedAt: null });
    expect(listCancelRequestedRuns(db)).toEqual([]);
    expect(markExecutionStarted(db, second.run.id, { workerId: 'wrk_test', now })).not.toBeNull();
    expect(finishRun(db, second.run.id, { outcome: 'succeeded', now })).toEqual({ outcome: 'succeeded', canceledByUser: false });
    expect(getJob(db, id)?.status).toBe('succeeded');
    expect(() => retryJob(db, id, now)).toThrow(/only failed, interrupted or canceled/);
  });

  it('records nothing for a running job that no live worker owns', () => {
    const db = openDatabase(':memory:');
    const id = insertJob(db);
    const c = claim(db, makeConfig())!;
    // No lock at all.
    expect(requestJobCancel(db, id, now)).toMatchObject({ kind: 'stale', run: { id: c.run.id } });
    // The lock is held by a worker that took over and has not reconciled this run yet.
    acquireWorkerLock(db, { workerId: 'wrk_new', pid: 2, hostname: 'host-a' }, { now, isPidAlive: () => true });
    expect(requestJobCancel(db, id, now).kind).toBe('stale');
    // The claiming worker holds the lock, but its heartbeat is stale.
    db.prepare("UPDATE worker_lock SET worker_id = 'wrk_test'").run();
    expect(requestJobCancel(db, id, () => T0 + WORKER_STALE_MS + 1).kind).toBe('stale');
    expect(getRun(db, c.run.id)?.cancelRequestedAt).toBeNull();
    expect(getJob(db, id)?.status).toBe('running');
    expect(requestJobCancel(db, id, () => T0 + WORKER_STALE_MS).kind).toBe('requested');
  });
});
