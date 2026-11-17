import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configSchema, type FactoryConfig, type FactoryConfigInput } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { claimNextJob, getJob, getRun, retryJob, setRunProcess } from '../db/queue.js';
import type { FactoryPaths } from '../paths.js';
import { ENVELOPE_SCHEMA_VERSION, type EventEnvelope, type Job } from '../types.js';
import { silentLogger } from '../util/log.js';
import { runDaemon, WorkerLockedError, type DaemonDeps } from './daemon.js';
import { StartFailedError, type ExecutionResult, type Executor } from './executor.js';
import { acquireWorkerLock, readWorkerLock, WORKER_STALE_MS } from './lock.js';
import type { ProcessControl } from './process.js';

const T0 = Date.parse('2026-11-17T10:00:00.000Z');

function makeConfig(over: Partial<FactoryConfigInput> = {}): FactoryConfig {
  return configSchema.parse({
    version: 1,
    maxConcurrent: 2,
    agents: { codex: {}, claude: {}, kiro: {} },
    pools: { art: { agents: ['codex'] }, general: { agents: ['claude', 'kiro'] } },
    actions: { 'implement-issue': { prompt: './prompts/implement issue.md' } },
    dispatch: { allowedActors: ['allen'] },
    ...over,
  });
}

let seq = 0;
function insertJob(db: Db, o: { issue?: number; pool?: string } = {}): string {
  seq++;
  const id = `job_${String(seq).padStart(5, '0')}`;
  const issue = o.issue ?? seq;
  const createdAt = new Date(T0 + seq).toISOString();
  const envelope: EventEnvelope = {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    type: 'issue.labeled',
    repo: { id: 1, fullName: 'owner/repo' },
    issue: { number: issue, title: `Fix the dragon #${issue}`, url: `https://github.com/owner/repo/issues/${issue}` },
    eventId: String(1000 + seq),
    url: `https://github.com/owner/repo/issues/${issue}`,
    actor: 'allen',
    label: 'factory:ready',
    labelsAtEnqueue: ['factory:ready'],
    createdAt,
  };
  db.prepare(
    `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
     VALUES (?, 1, 'owner/repo', 'implement-issue:factory:ready', ?, ?, 'implement-issue', ?, ?, 'queued', 0, ?, ?)`,
  ).run(id, envelope.eventId, issue, o.pool ?? 'general', JSON.stringify(envelope), createdAt, createdAt);
  return id;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makePaths(): FactoryPaths {
  const root = mkdtempSync(join(tmpdir(), 'factory daemon '));
  tmpDirs.push(root);
  const configDir = join(root, 'my config');
  const logDir = join(root, 'state and logs', 'logs');
  return {
    configFile: join(configDir, 'config.yaml'),
    configDir,
    dataDir: join(root, 'state and logs'),
    dbFile: join(root, 'state and logs', 'state.db'),
    logDir,
    runsDir: join(logDir, 'runs'),
  };
}

const noProcesses: ProcessControl = { isAlive: () => false, terminate: async () => {} };

function baseDeps(db: Db, over: Partial<DaemonDeps> = {}): DaemonDeps & { controller: AbortController } {
  const controller = new AbortController();
  return {
    db,
    config: makeConfig(),
    paths: makePaths(),
    log: silentLogger,
    poll: async () => undefined,
    checkDispatchable: async () => ({ ok: true }),
    signal: controller.signal,
    processControl: noProcesses,
    hostname: 'host-a',
    pid: 5000,
    ...over,
    controller,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('worker lock', () => {
  it('refuses a second worker while the holder is alive', () => {
    const db = openDatabase(':memory:');
    const now = () => T0;
    acquireWorkerLock(db, { workerId: 'wrk_a', pid: 1, hostname: 'host-a' }, { now, isPidAlive: () => true });
    expect(() =>
      acquireWorkerLock(db, { workerId: 'wrk_b', pid: 2, hostname: 'host-a' }, { now, isPidAlive: () => true }),
    ).toThrow(WorkerLockedError);
    expect(readWorkerLock(db)?.workerId).toBe('wrk_a');
  });

  it('runDaemon rejects with WorkerLockedError when another worker holds the lock', async () => {
    const db = openDatabase(':memory:');
    acquireWorkerLock(db, { workerId: 'wrk_a', pid: 1, hostname: 'host-a' }, { isPidAlive: () => true });
    const deps = baseDeps(db, { processControl: { isAlive: () => true, terminate: async () => {} } });
    await expect(runDaemon(deps)).rejects.toBeInstanceOf(WorkerLockedError);
    expect(readWorkerLock(db)?.workerId).toBe('wrk_a');
  });

  it('takes over a stale lock', () => {
    const db = openDatabase(':memory:');
    acquireWorkerLock(db, { workerId: 'wrk_a', pid: 1, hostname: 'other-host' }, { now: () => T0, isPidAlive: () => true });
    const later = () => T0 + WORKER_STALE_MS + 1;
    const res = acquireWorkerLock(db, { workerId: 'wrk_b', pid: 2, hostname: 'host-a' }, { now: later, isPidAlive: () => true });
    expect(res).toMatchObject({ takeover: 'stale-heartbeat', previous: { workerId: 'wrk_a' } });
    expect(readWorkerLock(db)?.workerId).toBe('wrk_b');
  });

  it('takes over a fresh lock only when its holder is on this host and its pid is dead', () => {
    const db = openDatabase(':memory:');
    const now = () => T0;
    acquireWorkerLock(db, { workerId: 'wrk_a', pid: 1, hostname: 'other-host' }, { now, isPidAlive: () => true });
    expect(() =>
      acquireWorkerLock(db, { workerId: 'wrk_b', pid: 2, hostname: 'host-a' }, { now, isPidAlive: () => false }),
    ).toThrow(WorkerLockedError);

    db.prepare("UPDATE worker_lock SET hostname = 'host-a'").run();
    const res = acquireWorkerLock(db, { workerId: 'wrk_b', pid: 2, hostname: 'host-a' }, { now, isPidAlive: (p) => p !== 1 });
    expect(res.takeover).toBe('dead-pid');
  });
});

describe('runDaemon', () => {
  it('polls, runs a log-only job under paths with spaces, and stops cleanly on abort', async () => {
    const db = openDatabase(':memory:');
    const deps = baseDeps(db);
    mkdirSync(join(deps.paths.configDir, 'prompts'), { recursive: true });
    writeFileSync(join(deps.paths.configDir, 'prompts', 'implement issue.md'), 'Implement the issue.');
    let jobId = '';
    let polls = 0;
    deps.poll = async () => {
      polls++;
      if (!jobId) jobId = insertJob(db);
    };

    const done = runDaemon(deps);
    await vi.waitFor(() => expect(jobId && getJob(db, jobId)?.status).toBe('succeeded'));
    expect(readWorkerLock(db)?.hostname).toBe('host-a');
    deps.controller.abort();
    await done;

    expect(polls).toBe(1);
    expect(readWorkerLock(db)).toBeNull();
    const run = db.prepare('SELECT * FROM runs WHERE job_id = ?').get(jobId) as { id: string; log_path: string; outcome: string };
    expect(run.outcome).toBe('succeeded');
    expect(run.log_path).toBe(join(deps.paths.runsDir, run.id, 'run.log'));
    const text = readFileSync(run.log_path, 'utf8');
    expect(text).toContain('Live execution is disabled');
    expect(text).toContain(`prompt: ${join(deps.paths.configDir, 'prompts', 'implement issue.md')}\n`);
    expect(text).toContain('agent: claude (adapter claude)');
    expect(text).toContain('pool: general');
    expect(text).toContain('action: implement-issue');
    expect(text).toContain('"eventId": "1');
  });

  it('runs jobs concurrently and marks unfinished runs interrupted on shutdown', async () => {
    const db = openDatabase(':memory:');
    const started: string[] = [];
    const never = deferred<ExecutionResult>();
    const executor: Executor = {
      name: 'hang',
      execute: async (c) => {
        started.push(c.run.agent);
        return never.promise; // ignores its abort signal, like a stuck agent
      },
    };
    const deps = baseDeps(db, { executor, timing: { shutdownTimeoutMs: 20, interruptGraceMs: 20 } });
    const a = insertJob(db, { pool: 'art' });
    const b = insertJob(db);
    const c = insertJob(db);

    const done = runDaemon(deps);
    await vi.waitFor(() => expect(started.sort()).toEqual(['claude', 'codex']));
    expect(getJob(db, c)?.status).toBe('queued'); // global limit 2
    deps.controller.abort();
    await done;

    expect(getJob(db, a)?.status).toBe('interrupted');
    expect(getJob(db, b)?.status).toBe('interrupted');
    expect(getJob(db, c)?.status).toBe('queued');
    expect(readWorkerLock(db)).toBeNull();
  });

  it('cancels a job that fails the pre-start check without running it', async () => {
    const db = openDatabase(':memory:');
    const execute = vi.fn(async (): Promise<ExecutionResult> => ({ outcome: 'succeeded' }));
    const checked: Job[] = [];
    const deps = baseDeps(db, {
      executor: { name: 'spy', execute },
      checkDispatchable: async (job) => {
        checked.push(job);
        return { ok: false, reason: 'issue no longer has the factory:ready label' };
      },
    });
    const id = insertJob(db);
    const done = runDaemon(deps);
    await vi.waitFor(() => expect(getJob(db, id)?.status).toBe('canceled'));
    deps.controller.abort();
    await done;

    expect(execute).not.toHaveBeenCalled();
    expect(checked.map((j) => j.id)).toEqual([id]);
    expect(getJob(db, id)?.statusReason).toBe('issue no longer has the factory:ready label');
    const run = db.prepare('SELECT outcome, ended_at FROM runs WHERE job_id = ?').get(id) as { outcome: string | null; ended_at: string | null };
    expect(run.outcome).toBeNull();
    expect(run.ended_at).not.toBeNull();
  });

  it('tries the next agent when an adapter cannot start', async () => {
    const db = openDatabase(':memory:');
    const executor: Executor = {
      name: 'flaky',
      execute: async (c) => {
        if (c.run.agent === 'claude') throw new StartFailedError('claude: command not found');
        return { outcome: 'succeeded' };
      },
    };
    const deps = baseDeps(db, { executor });
    const id = insertJob(db);
    const done = runDaemon(deps);
    await vi.waitFor(() => expect(getJob(db, id)?.status).toBe('succeeded'));
    deps.controller.abort();
    await done;
    const runs = db.prepare('SELECT agent, outcome FROM runs WHERE job_id = ? ORDER BY attempt').all(id);
    expect(runs).toEqual([
      { agent: 'claude', outcome: 'start_failed' },
      { agent: 'kiro', outcome: 'succeeded' },
    ]);
  });

  it('records poll failures and keeps running', async () => {
    const db = openDatabase(':memory:');
    const deps = baseDeps(db, {
      poll: async () => {
        throw new Error('GitHub API rate limited');
      },
    });
    const done = runDaemon(deps);
    await vi.waitFor(() => {
      const row = db.prepare("SELECT message FROM errors WHERE scope = 'poll'").get() as { message: string } | undefined;
      expect(row?.message).toBe('GitHub API rate limited');
    });
    deps.controller.abort();
    await done;
  });

  it('on restart, interrupts runs left open (reaping their process) and does not requeue them', async () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    // A previous worker on this host crashed mid-run.
    acquireWorkerLock(db, { workerId: 'wrk_old', pid: 4000, hostname: 'host-a' }, { now: () => Date.now(), isPidAlive: () => true });
    const id = insertJob(db);
    const claim = claimNextJob(db, config, { workerId: 'wrk_old', leaseSeconds: 60, runsDir: join('x', 'runs') })!;
    setRunProcess(db, claim.run.id, { pid: 4242, checkoutPath: join('x', 'work trees', id) });

    const terminated: number[] = [];
    const processControl: ProcessControl = {
      isAlive: (pid) => pid === 4242 && !terminated.includes(pid),
      terminate: async (pid) => {
        terminated.push(pid);
      },
    };
    const deps = baseDeps(db, { config, processControl });
    deps.controller.abort(); // reconcile only, then exit
    await runDaemon(deps);

    expect(terminated).toEqual([4242]);
    expect(getJob(db, id)?.status).toBe('interrupted');
    const run = getRun(db, claim.run.id)!;
    expect(run.outcome).toBe('interrupted');
    expect(run.checkoutPath).toBe(join('x', 'work trees', id));
    expect(run.logPath).toBe(claim.run.logPath);
    expect(run.error).toMatch(/terminated leftover agent process 4242/);
    expect(readWorkerLock(db)).toBeNull();

    expect(retryJob(db, id).status).toBe('queued');
  });

  it('does not signal a pid recorded by a worker on another host', async () => {
    const db = openDatabase(':memory:');
    const config = makeConfig();
    acquireWorkerLock(db, { workerId: 'wrk_old', pid: 4000, hostname: 'host-b' }, { now: () => T0, isPidAlive: () => true });
    const id = insertJob(db);
    const claim = claimNextJob(db, config, { workerId: 'wrk_old', leaseSeconds: 60, runsDir: 'runs' })!;
    setRunProcess(db, claim.run.id, { pid: 4242 });
    const terminate = vi.fn(async () => {});
    const deps = baseDeps(db, { config, processControl: { isAlive: () => true, terminate } });
    deps.controller.abort();
    await runDaemon(deps); // lock is stale relative to real time, so it is taken over
    expect(terminate).not.toHaveBeenCalled();
    expect(getJob(db, id)?.status).toBe('interrupted');
  });
});
