import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configSchema, type UpdraftConfig, type UpdraftConfigInput } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import {
  CANCELED_BY_USER,
  claimNextJob,
  getJob,
  getRun,
  markExecutionStarted,
  MAX_START_FAILURES,
  requestJobCancel,
  retryJob,
  setRunProcess,
  WorkerLockLostError,
} from '../db/queue.js';
import type { GitHubApi } from '../github/api.js';
import type { UpdraftPaths } from '../paths.js';
import { createFailureCommenter } from '../publish/failure-comment.js';
import { ENVELOPE_SCHEMA_VERSION, type EventEnvelope, type Job } from '../types.js';
import { silentLogger, type Logger } from '../util/log.js';
import { runDaemon, WorkerLockedError, type DaemonDeps } from './daemon.js';
import { canceledByUser, StartFailedError, type ExecutionResult, type Executor } from './executor.js';
import { acquireWorkerLock, readWorkerLock, WORKER_STALE_MS } from './lock.js';
import type { ProcessControl } from './process.js';

const T0 = Date.parse('2026-11-17T10:00:00.000Z');

function makeConfig(over: Partial<UpdraftConfigInput> = {}): UpdraftConfig {
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
    label: 'updraft:ready',
    labelsAtEnqueue: ['updraft:ready'],
    createdAt,
  };
  db.prepare(
    `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
     VALUES (?, 1, 'owner/repo', 'implement-issue:updraft:ready', ?, ?, 'implement-issue', ?, ?, 'queued', 0, ?, ?)`,
  ).run(id, envelope.eventId, issue, o.pool ?? 'general', JSON.stringify(envelope), createdAt, createdAt);
  return id;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makePaths(): UpdraftPaths {
  const root = mkdtempSync(join(tmpdir(), 'updraft daemon '));
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

const noProcesses: ProcessControl = { isAlive: () => false, startTime: async () => null, terminate: async () => {} };

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
    const deps = baseDeps(db, { processControl: { isAlive: () => true, startTime: async () => null, terminate: async () => {} } });
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
    expect(text).toContain('mode: log-only. No agent process was started');
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

  it('on shutdown, signals a stuck run\'s agent only if its recorded start time still matches', async () => {
    const db = openDatabase(':memory:');
    const never = deferred<ExecutionResult>();
    const seen: Array<{ stopping: boolean; issue: unknown }> = [];
    const executor: Executor = {
      name: 'stuck',
      execute: async (c, ctx) => {
        seen.push({ stopping: Boolean(ctx.workerStopping?.aborted), issue: ctx.issue });
        // codex's agent is still the same process; claude's pid now belongs to another process.
        const pid = c.run.agent === 'codex' ? 7001 : 7002;
        ctx.recordProcess({ pid });
        ctx.recordProcess({ pidStartTime: `t:${pid}` });
        ctx.workerStopping?.addEventListener('abort', () => seen.push({ stopping: true, issue: null }));
        return never.promise;
      },
    };
    const terminated: number[] = [];
    const processControl: ProcessControl = {
      isAlive: (pid) => [7001, 7002].includes(pid) && !terminated.includes(pid),
      startTime: async (pid) => (pid === 7001 ? 't:7001' : 't:someone-else'),
      terminate: async (pid) => {
        terminated.push(pid);
      },
    };
    const issue = { title: 'T', body: 'B', labels: ['updraft:ready'], url: 'u' };
    const deps = baseDeps(db, {
      executor,
      processControl,
      checkDispatchable: async () => ({ ok: true, issue }),
      timing: { shutdownTimeoutMs: 20, interruptGraceMs: 20 },
    });
    const a = insertJob(db, { pool: 'art' });
    const b = insertJob(db);
    const done = runDaemon(deps);
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual([
      { stopping: false, issue },
      { stopping: false, issue },
    ]);
    deps.controller.abort();
    await done;

    // workerStopping fired as soon as shutdown began, before the per-run signal.
    expect(seen.filter((s) => s.stopping)).toHaveLength(2);
    expect(terminated).toEqual([7001]);
    const runA = db.prepare('SELECT error FROM runs WHERE job_id = ?').get(a) as { error: string };
    const runB = db.prepare('SELECT error FROM runs WHERE job_id = ?').get(b) as { error: string };
    expect(runA.error).toBe('worker stopped before the run finished; terminated leftover agent process 7001');
    expect(runB.error).toBe(
      'worker stopped before the run finished; agent pid 7002 was not signalled (it now belongs to a different process)',
    );
  });

  it('cancels a job that fails the pre-start check without running it', async () => {
    const db = openDatabase(':memory:');
    const execute = vi.fn(async (): Promise<ExecutionResult> => ({ outcome: 'succeeded' }));
    const checked: Job[] = [];
    const deps = baseDeps(db, {
      executor: { name: 'spy', execute },
      checkDispatchable: async (job) => {
        checked.push(job);
        return { ok: false, reason: 'issue no longer has the updraft:ready label' };
      },
    });
    const id = insertJob(db);
    const done = runDaemon(deps);
    await vi.waitFor(() => expect(getJob(db, id)?.status).toBe('canceled'));
    deps.controller.abort();
    await done;

    expect(execute).not.toHaveBeenCalled();
    expect(checked.map((j) => j.id)).toEqual([id]);
    expect(getJob(db, id)?.statusReason).toBe('issue no longer has the updraft:ready label');
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

  it('hands only succeeded runs to the publisher, after recording them, and retries due publications after each poll', async () => {
    const db = openDatabase(':memory:');
    const executor: Executor = {
      name: 'mixed',
      execute: async (c): Promise<ExecutionResult> =>
        c.job.issueNumber === 1 ? { outcome: 'failed', error: 'tests failed' } : { outcome: 'succeeded' },
    };
    const published: Array<{ runId: string; outcome: string | null }> = [];
    let retries = 0;
    const publisher = {
      afterRun: async (runId: string) => {
        published.push({ runId, outcome: getRun(db, runId)?.outcome ?? null });
      },
      retryDue: async () => {
        retries++;
      },
      sweepUnpublished: async () => {},
    };
    const deps = baseDeps(db, { executor, publisher });
    const failing = insertJob(db, { issue: 1 });
    const passing = insertJob(db, { issue: 2 });
    const done = runDaemon(deps);
    await vi.waitFor(() => expect([getJob(db, failing)?.status, getJob(db, passing)?.status]).toEqual(['failed', 'succeeded']));
    await vi.waitFor(() => expect(published).toHaveLength(1));
    deps.controller.abort();
    await done;
    const passingRun = db.prepare('SELECT id FROM runs WHERE job_id = ?').get(passing) as { id: string };
    expect(published).toEqual([{ runId: passingRun.id, outcome: 'succeeded' }]);
    expect(retries).toBeGreaterThanOrEqual(1);
  });

  it('hands failed and start_failed runs to the failure commenter, after recording them, and retries after each poll', async () => {
    const db = openDatabase(':memory:');
    const outcomes: Record<number, ExecutionResult> = {
      1: { outcome: 'failed', error: 'tests failed' },
      2: { outcome: 'succeeded' },
      3: { outcome: 'start_failed', error: 'agent CLI not found' },
      4: { outcome: 'interrupted', error: 'worker stopped' },
    };
    const started = new Map<number, number>();
    const executor: Executor = {
      name: 'mixed',
      execute: async (c): Promise<ExecutionResult> => {
        const n = (started.get(c.job.issueNumber) ?? 0) + 1;
        started.set(c.job.issueNumber, n);
        // The requeued start failure succeeds on the next agent.
        return c.job.issueNumber === 3 && n > 1 ? { outcome: 'succeeded' } : outcomes[c.job.issueNumber]!;
      },
    };
    const seen: Array<{ issue: number; outcome: string | null; jobStatus: string | undefined }> = [];
    let retries = 0;
    const failureCommenter = {
      afterRun: async (runId: string) => {
        const run = getRun(db, runId)!;
        const job = getJob(db, run.jobId)!;
        seen.push({ issue: job.issueNumber, outcome: run.outcome, jobStatus: job.status });
      },
      retryDue: async () => {
        retries++;
      },
      sweepUnpublished: async () => {},
    };
    const deps = baseDeps(db, { executor, failureCommenter, config: makeConfig({ maxConcurrent: 1 }) });
    const jobs = [1, 2, 3, 4].map((issue) => insertJob(db, { issue }));
    const done = runDaemon(deps);
    await vi.waitFor(() => expect(jobs.map((j) => getJob(db, j)?.status)).toEqual(['failed', 'succeeded', 'succeeded', 'interrupted']));
    deps.controller.abort();
    await done;
    expect(seen).toEqual([
      { issue: 1, outcome: 'failed', jobStatus: 'failed' },
      { issue: 3, outcome: 'start_failed', jobStatus: 'queued' },
    ]);
    expect(retries).toBeGreaterThanOrEqual(1);
  });

  it('with commentOnFailure, comments once when a job ends failed and not when it is requeued, canceled or interrupted', async () => {
    const db = openDatabase(':memory:');
    const config = makeConfig({
      execution: { mode: 'live' },
      repositories: {
        'owner/repo': {
          id: 1,
          commentOnFailure: true,
          workflows: [{ trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general' }],
        },
      },
    });
    const comments: Array<{ issue: number; body: string }> = [];
    const api = {
      listIssueComments: async (_repo: unknown, issue: number) => comments.filter((c) => c.issue === issue).map((c, i) => ({ id: i, htmlUrl: 'u', body: c.body, user: 'allen' })),
      createIssueComment: async (_repo: unknown, issue: number, body: string) => {
        comments.push({ issue, body });
        return { id: comments.length, htmlUrl: `https://github.com/owner/repo/issues/${issue}#issuecomment-${comments.length}`, body, user: 'allen' };
      },
    } as unknown as GitHubApi;
    const stuck = deferred<ExecutionResult>();
    const executor: Executor = {
      name: 'mixed',
      execute: async (c): Promise<ExecutionResult> => {
        switch (c.job.issueNumber) {
          case 1:
            return { outcome: 'failed', error: 'agent exited with code 1: the agent said SECRET' };
          case 2:
            throw new StartFailedError(`${c.run.agent} cannot start: agent CLI not found`);
          case 4:
            return stuck.promise;
          default:
            return { outcome: 'succeeded' };
        }
      },
    };
    const paths = makePaths();
    const deps = baseDeps(db, {
      executor,
      config,
      paths,
      checkDispatchable: async (job) => (job.issueNumber === 3 ? { ok: false, reason: 'issue was closed' } : { ok: true }),
      failureCommenter: createFailureCommenter({ db, config, paths, api, log: silentLogger }),
      timing: { shutdownTimeoutMs: 20, interruptGraceMs: 20 },
    });
    const [failing, unstartable, canceled, hanging] = [1, 2, 3, 4].map((issue) => insertJob(db, { issue }));
    const done = runDaemon(deps);
    await vi.waitFor(() =>
      expect([failing, unstartable, canceled, hanging].map((j) => getJob(db, j!)?.status)).toEqual(['failed', 'failed', 'canceled', 'running']),
    );
    await vi.waitFor(() => expect(comments).toHaveLength(2));
    deps.controller.abort();
    await done;
    stuck.resolve({ outcome: 'interrupted' });
    expect(getJob(db, hanging!)?.status).toBe('interrupted');

    // One comment per failed job: the failed run, and the last of the start failures.
    expect(comments.map((c) => c.issue).sort()).toEqual([getJob(db, failing!)!.issueNumber, getJob(db, unstartable!)!.issueNumber]);
    const failed = comments.find((c) => c.issue === 1)!.body;
    expect(failed).toContain('agent exited with code 1');
    expect(failed).not.toContain('SECRET');
    expect(failed).toContain(`updraft retry ${failing}`);
    const startRuns = db.prepare('SELECT id FROM runs WHERE job_id = ? ORDER BY attempt').all(unstartable!) as { id: string }[];
    expect(startRuns).toHaveLength(MAX_START_FAILURES);
    const noStart = comments.find((c) => c.issue === 2)!.body;
    expect(noStart).toContain(`no agent could start after ${MAX_START_FAILURES} consecutive attempts`);
    expect(noStart).toContain(`<!-- updraft-run-failed: ${startRuns.at(-1)!.id} -->`);
    expect(db.prepare("SELECT run_id, state FROM failure_comments ORDER BY issue_number").all()).toEqual([
      { run_id: (db.prepare('SELECT id FROM runs WHERE job_id = ?').get(failing!) as { id: string }).id, state: 'posted' },
      { run_id: startRuns.at(-1)!.id, state: 'posted' },
    ]);
  });

  it('announces the assignment only for claims that pass the dispatch check, and never blocks the agent', async () => {
    const db = openDatabase(':memory:');
    const announced: { job: string; run: string; agent: string }[] = [];
    const assignmentCommenter = {
      announce: async (job: Job, run: { id: string; agent: string }) => {
        announced.push({ job: job.id, run: run.id, agent: run.agent });
        throw new Error('GitHub is down'); // a misbehaving commenter must not matter
      },
    };
    const executor: Executor = { name: 'fake', execute: async () => ({ outcome: 'succeeded' }) };
    const deps = baseDeps(db, {
      executor,
      assignmentCommenter: assignmentCommenter as never,
      checkDispatchable: async (job) => (job.issueNumber === 2 ? { ok: false, reason: 'issue was closed' } : { ok: true }),
    });
    const [accepted, rejected] = [1, 2].map((issue) => insertJob(db, { issue }));
    const done = runDaemon(deps);
    await vi.waitFor(() => expect([accepted, rejected].map((j) => getJob(db, j!)?.status)).toEqual(['succeeded', 'canceled']));
    deps.controller.abort();
    await done;
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ job: accepted, agent: getRun(db, announced[0]!.run)!.agent });
  });

  it('at start, records the publish settings and sweeps unpublished runs once, after reconcile and before the first poll', async () => {
    const db = openDatabase(':memory:');
    const workflows = [{ trigger: { event: 'issue.labeled' as const, label: 'updraft:ready' }, action: 'implement-issue', pool: 'general' }];
    const config = makeConfig({ repositories: { 'owner/repo': { id: 1, publish: 'draft-pr', workflows } } });
    // A previous worker crashed mid-run; reconcile closes that run.
    acquireWorkerLock(db, { workerId: 'wrk_old', pid: 4000, hostname: 'host-a' }, { now: () => Date.now(), isPidAlive: () => true });
    insertJob(db);
    const claim = claimNextJob(db, config, { workerId: 'wrk_old', hostname: 'host-a', leaseSeconds: 60, runsDir: join('x', 'runs') })!;
    markExecutionStarted(db, claim.run.id, { workerId: 'wrk_old' });

    const events: string[] = [];
    const publisher = {
      afterRun: async () => {},
      retryDue: async () => {
        events.push('retryDue');
      },
      sweepUnpublished: async () => {
        const setting = db.prepare('SELECT mode, enabled_at FROM publish_settings WHERE repo_id = 1').get() as { mode: string; enabled_at: string };
        events.push(`sweep (left-over run ${getRun(db, claim.run.id)?.outcome}, publish ${setting.mode} since ${setting.enabled_at})`);
      },
    };
    const deps = baseDeps(db, {
      config,
      publisher,
      now: () => T0,
      poll: async () => {
        events.push('poll');
        deps.controller.abort();
      },
    });
    await runDaemon(deps);
    expect(events).toEqual([`sweep (left-over run interrupted, publish draft-pr since ${new Date(T0).toISOString()})`, 'poll']);
  });

  it('logs an info-level "worker alive" line once per status interval, with polls and failures since the last one', async () => {
    const db = openDatabase(':memory:');
    const lines: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const recording: Logger = {
      debug: () => {},
      info: (msg, fields) => lines.push({ msg, fields }),
      warn: () => {},
      error: () => {},
      child: () => recording,
    };
    // Every read of the clock moves it 10 minutes, so polls come back to back and an hour of
    // worker time passes in a few of them.
    let t = Date.parse('2026-01-01T00:00:00Z');
    let calls = 0;
    const deps = baseDeps(db, {
      log: recording,
      now: () => (t += 10 * 60_000),
      timing: { statusLogMs: 60 * 60_000 },
      poll: async () => {
        calls++;
        if (calls % 2 === 0) throw new Error('rate limited');
      },
    });
    const done = runDaemon(deps);
    await vi.waitFor(() => expect(lines.filter((l) => l.msg === 'worker alive').length).toBeGreaterThanOrEqual(2));
    deps.controller.abort();
    await done;
    const alive = lines.filter((l) => l.msg === 'worker alive');
    const first = alive[0]!.fields!;
    expect(first.inFlight).toBe(0);
    expect(first.polls as number).toBeGreaterThan(0);
    expect(first.pollFailures as number).toBeLessThanOrEqual(first.polls as number);
    // Counters restart after each line, and uptime keeps growing.
    const total = alive.reduce((n, l) => n + (l.fields!.polls as number), 0);
    expect(total).toBeLessThanOrEqual(calls);
    expect(alive[1]!.fields!.uptimeMinutes as number).toBeGreaterThan(first.uptimeMinutes as number);
  });

  it('logs no "worker alive" line before the status interval has passed', async () => {
    const db = openDatabase(':memory:');
    const msgs: string[] = [];
    const recording: Logger = {
      debug: () => {},
      info: (msg) => msgs.push(msg),
      warn: () => {},
      error: () => {},
      child: () => recording,
    };
    let polls = 0;
    const deps = baseDeps(db, { log: recording, poll: async () => void polls++ });
    const done = runDaemon(deps);
    await vi.waitFor(() => expect(polls).toBeGreaterThanOrEqual(1));
    deps.controller.abort();
    await done;
    expect(msgs).not.toContain('worker alive');
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
    const claim = claimNextJob(db, config, { workerId: 'wrk_old', hostname: 'host-a', leaseSeconds: 60, runsDir: join('x', 'runs') })!;
    expect(markExecutionStarted(db, claim.run.id, { workerId: 'wrk_old' })).not.toBeNull();
    setRunProcess(db, claim.run.id, { pid: 4242, pidStartTime: 'test:4242', checkoutPath: join('x', 'work trees', id) });

    const terminated: number[] = [];
    const processControl: ProcessControl = {
      isAlive: (pid) => pid === 4242 && !terminated.includes(pid),
      startTime: async (pid) => `test:${pid}`,
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
    const claim = claimNextJob(db, config, { workerId: 'wrk_old', hostname: 'host-b', leaseSeconds: 60, runsDir: 'runs' })!;
    markExecutionStarted(db, claim.run.id, { workerId: 'wrk_old' });
    setRunProcess(db, claim.run.id, { pid: 4242 });
    const terminate = vi.fn(async () => {});
    const deps = baseDeps(db, { config, processControl: { isAlive: () => true, startTime: async () => 'test:4242', terminate } });
    deps.controller.abort();
    await runDaemon(deps); // lock is stale relative to real time, so it is taken over
    expect(terminate).not.toHaveBeenCalled();
    expect(getJob(db, id)?.status).toBe('interrupted');
    expect(getRun(db, claim.run.id)?.error).toMatch(/pid 4242 was not signalled \(recorded on host host-b\)/);
  });
});

describe('runDaemon: lock ownership', () => {
  it('keeps the lock heartbeat fresh while a poll is slow', async () => {
    const db = openDatabase(':memory:');
    const heartbeats: string[] = [];
    const deps = baseDeps(db, { timing: { heartbeatMs: 10 } });
    deps.poll = async () => {
      // Simulate a slow GitHub round-trip spanning several heartbeat intervals.
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 15));
        heartbeats.push(readWorkerLock(db)!.heartbeatAt);
      }
    };
    const done = runDaemon(deps);
    await vi.waitFor(() => expect(heartbeats).toHaveLength(6));
    deps.controller.abort();
    await done;
    expect(new Set(heartbeats).size).toBeGreaterThan(2);
  });

  it('does not start a job when its lock is taken over during the pre-start check', async () => {
    const db = openDatabase(':memory:');
    const execute = vi.fn(async (): Promise<ExecutionResult> => ({ outcome: 'succeeded' }));
    const deps = baseDeps(db, {
      executor: { name: 'spy', execute },
      checkDispatchable: async () => {
        // Another worker takes over while this check is waiting on GitHub.
        db.prepare("UPDATE worker_lock SET worker_id = 'wrk_other', pid = 9999").run();
        return { ok: true };
      },
    });
    const id = insertJob(db);
    await runDaemon(deps); // stops by itself after losing the lock

    expect(execute).not.toHaveBeenCalled();
    expect(getJob(db, id)?.status).toBe('queued');
    expect(readWorkerLock(db)?.workerId).toBe('wrk_other'); // the new holder's lock is untouched
    const errors = db.prepare("SELECT message FROM errors WHERE scope = 'worker'").all() as { message: string }[];
    expect(errors.map((e) => e.message).join('\n')).toMatch(/lost the worker lock/);
  });

  it('a worker that takes over during the pre-start check requeues the claimed job (and runs it)', async () => {
    const db = openDatabase(':memory:');
    const checking = deferred<void>();
    const github = deferred<{ ok: true }>();
    const oldExecute = vi.fn(async (): Promise<ExecutionResult> => ({ outcome: 'succeeded' }));
    const a = baseDeps(db, {
      workerId: 'wrk_a',
      pid: 5000,
      executor: { name: 'old', execute: oldExecute },
      checkDispatchable: async () => {
        checking.resolve();
        return github.promise; // worker A hangs on GitHub, then its process dies
      },
    });
    const id = insertJob(db);
    const doneA = runDaemon(a);
    await checking.promise;
    const claimed = db.prepare('SELECT id FROM runs WHERE job_id = ?').get(id) as { id: string };
    expect(getRun(db, claimed.id)?.executionStartedAt).toBeNull();

    // Worker B on the same host sees A's pid is dead, takes over and reconciles.
    const newExecute = vi.fn(async (): Promise<ExecutionResult> => ({ outcome: 'succeeded' }));
    const b = baseDeps(db, {
      workerId: 'wrk_b',
      pid: 6000,
      executor: { name: 'new', execute: newExecute },
      processControl: { isAlive: (p) => p !== 5000, startTime: async () => null, terminate: async () => {} },
    });
    const doneB = runDaemon(b);
    await vi.waitFor(() => expect(getJob(db, id)?.status).toBe('succeeded'));
    b.controller.abort();
    await doneB;

    // A's check finally returns; it notices it lost the lock and never executes.
    github.resolve({ ok: true });
    await doneA;
    expect(oldExecute).not.toHaveBeenCalled();
    expect(newExecute).toHaveBeenCalledTimes(1);
    const runs = db.prepare('SELECT worker_id, outcome, error FROM runs WHERE job_id = ? ORDER BY attempt').all(id) as {
      worker_id: string;
      outcome: string | null;
      error: string | null;
    }[];
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ worker_id: 'wrk_a', outcome: null });
    expect(runs[0]?.error).toMatch(/released before start: requeued: worker wrk_a stopped before the run started/);
    expect(runs[1]).toMatchObject({ worker_id: 'wrk_b', outcome: 'succeeded' });
  });

  it('a worker that takes over mid-run marks the started run interrupted', async () => {
    const db = openDatabase(':memory:');
    const executing = deferred<void>();
    const agent = deferred<ExecutionResult>();
    const a = baseDeps(db, {
      workerId: 'wrk_a',
      pid: 5000,
      executor: {
        name: 'slow',
        execute: async () => {
          executing.resolve();
          return agent.promise;
        },
      },
    });
    const id = insertJob(db);
    const doneA = runDaemon(a);
    await executing.promise;
    const run = db.prepare('SELECT id FROM runs WHERE job_id = ?').get(id) as { id: string };
    expect(getRun(db, run.id)?.executionStartedAt).not.toBeNull();

    const b = baseDeps(db, {
      workerId: 'wrk_b',
      pid: 6000,
      processControl: { isAlive: (p) => p !== 5000, startTime: async () => null, terminate: async () => {} },
    });
    b.controller.abort(); // take over and reconcile only
    await runDaemon(b);
    expect(getJob(db, id)?.status).toBe('interrupted');
    expect(getRun(db, run.id)).toMatchObject({ outcome: 'interrupted' });
    expect(getRun(db, run.id)?.error).toMatch(/worker wrk_a stopped while the run was in progress/);

    // A's late result does not overwrite the reconciled state; A then stops on its lost lock.
    agent.resolve({ outcome: 'succeeded' });
    await doneA;
    expect(getJob(db, id)?.status).toBe('interrupted');
    expect(db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 1 });
  });

  it('claimNextJob refuses to claim for a worker that does not hold the lock', () => {
    const db = openDatabase(':memory:');
    acquireWorkerLock(db, { workerId: 'wrk_new', pid: 2, hostname: 'host-a' }, { isPidAlive: () => true });
    insertJob(db);
    const opts = { workerId: 'wrk_old', hostname: 'host-a', leaseSeconds: 90, runsDir: makePaths().runsDir, lockWorkerId: 'wrk_old' };
    expect(() => claimNextJob(db, makeConfig(), opts)).toThrow(WorkerLockLostError);
    expect(db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 });
    expect(claimNextJob(db, makeConfig(), { ...opts, workerId: 'wrk_new', lockWorkerId: 'wrk_new' })).not.toBeNull();
  });
});

describe('runDaemon: updraft cancel', () => {
  const noPublisher = () => {
    const published: string[] = [];
    return {
      published,
      publisher: {
        afterRun: async (runId: string) => {
          published.push(runId);
        },
        retryDue: async () => {},
        sweepUnpublished: async () => {},
      },
    };
  };

  it('stops a running run the way a shutdown does, and records the run and job as canceled', async () => {
    const db = openDatabase(':memory:');
    const executing = deferred<void>();
    const stops: Array<{ byUser: boolean; reason: unknown; workerStopping: boolean }> = [];
    const executor: Executor = {
      name: 'stoppable',
      // Like the live executor: stop on the run's signal and report the stop as 'interrupted'.
      execute: (_c, ctx) =>
        new Promise<ExecutionResult>((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            stops.push({ byUser: canceledByUser(ctx.signal), reason: ctx.signal.reason, workerStopping: Boolean(ctx.workerStopping?.aborted) });
            resolve({ outcome: 'interrupted', error: 'canceled by user before the run finished; the agent process tree was stopped' });
          });
          executing.resolve();
        }),
    };
    const { published, publisher } = noPublisher();
    const deps = baseDeps(db, { executor, publisher, timing: { cancelCheckMs: 10, shutdownTimeoutMs: 20, interruptGraceMs: 20 } });
    const id = insertJob(db);
    const other = insertJob(db);
    const done = runDaemon(deps);
    await executing.promise;
    await vi.waitFor(() => expect(getJob(db, other)?.status).toBe('running'));

    expect(requestJobCancel(db, id)).toMatchObject({ kind: 'requested', alreadyRequested: false });
    await vi.waitFor(() => expect(getJob(db, id)?.status).toBe('canceled'));
    // Only the canceled run was stopped, and by its own signal rather than a worker shutdown.
    expect(stops).toEqual([{ byUser: true, reason: CANCELED_BY_USER, workerStopping: false }]);
    expect(getJob(db, other)?.status).toBe('running');
    expect(getJob(db, id)).toMatchObject({ statusReason: CANCELED_BY_USER, attempts: 1 });
    const runs = db.prepare('SELECT outcome, error, ended_at FROM runs WHERE job_id = ?').all(id) as Array<{
      outcome: string | null;
      error: string;
      ended_at: string | null;
    }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: null, error: CANCELED_BY_USER });
    expect(runs[0]?.ended_at).not.toBeNull();

    deps.controller.abort();
    await done;
    // Not requeued, not published, and no error row for a deliberate cancel.
    expect(getJob(db, id)?.status).toBe('canceled');
    expect(published).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM errors WHERE job_id = ?').get(id)).toEqual({ n: 0 });
  });

  it('a cancel that races with the run succeeding on its own ends canceled and is not published', async () => {
    const db = openDatabase(':memory:');
    const executing = deferred<void>();
    const agent = deferred<ExecutionResult>();
    const { published, publisher } = noPublisher();
    const deps = baseDeps(db, {
      publisher,
      // The check never fires here: the request is only seen when the run is recorded.
      timing: { cancelCheckMs: 60_000 },
      executor: {
        name: 'finishing',
        execute: async () => {
          executing.resolve();
          return agent.promise;
        },
      },
    });
    const id = insertJob(db);
    const done = runDaemon(deps);
    await executing.promise;
    expect(requestJobCancel(db, id).kind).toBe('requested');
    agent.resolve({ outcome: 'succeeded' });
    await vi.waitFor(() => expect(getJob(db, id)?.status).toBe('canceled'));
    deps.controller.abort();
    await done;
    expect(db.prepare('SELECT outcome, error FROM runs WHERE job_id = ?').get(id)).toEqual({
      outcome: null,
      error: `${CANCELED_BY_USER} (the run had already ended: succeeded)`,
    });
    expect(published).toEqual([]);
  });

  it('a cancel during the pre-start check keeps the agent from starting and does not requeue the job', async () => {
    const db = openDatabase(':memory:');
    const checking = deferred<void>();
    const check = deferred<{ ok: true }>();
    const execute = vi.fn(async (): Promise<ExecutionResult> => ({ outcome: 'succeeded' }));
    const deps = baseDeps(db, {
      executor: { name: 'spy', execute },
      checkDispatchable: async () => {
        checking.resolve();
        return check.promise;
      },
    });
    const id = insertJob(db);
    const done = runDaemon(deps);
    await checking.promise;
    expect(requestJobCancel(db, id).kind).toBe('requested');
    check.resolve({ ok: true });
    await vi.waitFor(() => expect(getJob(db, id)?.status).toBe('canceled'));
    deps.controller.abort();
    await done;
    expect(execute).not.toHaveBeenCalled();
    expect(getJob(db, id)).toMatchObject({ statusReason: CANCELED_BY_USER, attempts: 1 });
    expect(db.prepare('SELECT outcome, execution_started_at, error FROM runs WHERE job_id = ?').all(id)).toEqual([
      { outcome: null, execution_started_at: null, error: `canceled before start: ${CANCELED_BY_USER}` },
    ]);
  });

  it('a worker that takes over a run with a pending cancel records it canceled, not interrupted', async () => {
    const db = openDatabase(':memory:');
    const executing = deferred<void>();
    const agent = deferred<ExecutionResult>();
    const a = baseDeps(db, {
      workerId: 'wrk_a',
      pid: 5000,
      timing: { cancelCheckMs: 60_000 }, // A stops responding before it sees the request
      executor: {
        name: 'slow',
        execute: async () => {
          executing.resolve();
          return agent.promise;
        },
      },
    });
    const id = insertJob(db);
    const doneA = runDaemon(a);
    await executing.promise;
    expect(requestJobCancel(db, id).kind).toBe('requested');

    const b = baseDeps(db, {
      workerId: 'wrk_b',
      pid: 6000,
      processControl: { isAlive: (p) => p !== 5000, startTime: async () => null, terminate: async () => {} },
    });
    b.controller.abort(); // take over and reconcile only
    await runDaemon(b);
    expect(getJob(db, id)).toMatchObject({ status: 'canceled', statusReason: CANCELED_BY_USER });
    // The run now belongs to nobody the CLI could ask; a second cancel says the job is done.
    expect(requestJobCancel(db, id).kind).toBe('terminal');

    agent.resolve({ outcome: 'succeeded' });
    await doneA;
    expect(getJob(db, id)?.status).toBe('canceled');
    expect(db.prepare('SELECT outcome FROM runs WHERE job_id = ?').all(id)).toEqual([{ outcome: null }]);
  });
});
