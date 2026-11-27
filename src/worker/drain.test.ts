import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { configSchema, type UpdraftConfig } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { beginPublication, finishPublication, getPublication, listDuePublications } from '../db/publications.js';
import { getJob, latestRunOfJob, NOT_STARTED_YET } from '../db/queue.js';
import { resolvePaths, type UpdraftPaths } from '../paths.js';
import type { Publisher } from '../publish/publish.js';
import { silentLogger } from '../util/log.js';
import type { DaemonDeps } from './daemon.js';
import { drainQueue, MIN_DEFERRED_CHECKS, nextRetryAt, type DrainOptions } from './drain.js';
import type { ExecutionResult, Executor } from './executor.js';
import type { ProcessControl } from './process.js';

const tmpDirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const config: UpdraftConfig = configSchema.parse({
  version: 1,
  agents: { claude: {} },
  pools: { general: { agents: ['claude'] } },
  actions: { 'implement-issue': { prompt: './prompts/implement.md' } },
  dispatch: { allowedActors: ['allen'] },
});
const noProcesses: ProcessControl = { isAlive: () => false, startTime: async () => null, terminate: async () => {} };
const FAST: DrainOptions = { tickMs: 10, stallMs: 150, settleMs: 5_000 };

function setup(over: Partial<Omit<DaemonDeps, 'poll' | 'idle'>> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'updraft drain '));
  tmpDirs.push(root);
  const paths: UpdraftPaths = resolvePaths({ env: { UPDRAFT_HOME: root } });
  const db = openDatabase(':memory:');
  dbs.push(db);
  const controller = new AbortController();
  const executed: string[] = [];
  const executor: Executor = {
    name: 'test',
    execute: async (claim): Promise<ExecutionResult> => {
      executed.push(claim.job.id);
      return { outcome: 'succeeded' };
    },
  };
  const deps: Omit<DaemonDeps, 'poll' | 'idle'> = {
    db,
    config,
    paths,
    log: silentLogger,
    checkDispatchable: async () => ({ ok: true }),
    signal: controller.signal,
    executor,
    processControl: noProcesses,
    hostname: 'host-a',
    pid: 5000,
    timing: { heartbeatMs: 20, shutdownTimeoutMs: 100, interruptGraceMs: 100 },
    ...over,
  };
  return { db, deps, controller, executed };
}

const jobOfRun = (db: Db, runId: string) => (db.prepare('SELECT job_id FROM runs WHERE id = ?').get(runId) as { job_id: string }).job_id;

/** A publisher whose first attempt for each run fails for a passing reason, due again after `retryInMs`. */
function flakyPublisher(db: Db, retryInMs: number): Publisher & { attempts: number } {
  const attempt = (runId: string, fail: boolean) => {
    const begun = beginPublication(db, { runId, jobId: jobOfRun(db, runId), repoId: 1, repoFullName: 'o/r', issueNumber: 1, mode: 'pr', branch: 'b', leaseSeconds: 60 });
    if (!begun.ok) return;
    publisher.attempts++;
    finishPublication(
      db,
      runId,
      begun.publication.attempts,
      fail ? { state: 'failed', error: 'GitHub is unavailable for now', retryable: true, nextAttemptAt: new Date(Date.now() + retryInMs).toISOString() } : { state: 'published' },
    );
  };
  const publisher = {
    attempts: 0,
    afterRun: async (runId: string) => attempt(runId, true),
    retryDue: async () => {
      for (const runId of listDuePublications(db, { maxAttempts: 5 })) attempt(runId, false);
    },
    sweepUnpublished: async () => {},
  };
  return publisher;
}

/** Runs until the worker tells it to stop. */
const hangingExecutor: Executor = {
  name: 'hang',
  execute: (_claim, ctx) =>
    new Promise<ExecutionResult>((resolve) => {
      const stop = () => resolve({ outcome: 'interrupted', error: 'worker stopped' });
      ctx.workerStopping?.addEventListener('abort', stop, { once: true });
      ctx.signal.addEventListener('abort', stop, { once: true });
    }),
};

describe('drainQueue', { timeout: 20_000 }, () => {
  it('ends at once when there is no job: nothing is polled or waited for', async () => {
    const s = setup();
    const started = Date.now();
    // Ticks of a minute: ending promptly cannot be the tick's doing.
    expect(await drainQueue(s.deps, { tickMs: 60_000, stallMs: 60_000 })).toEqual({ ended: 'idle' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(s.executed).toEqual([]);
    // The worker lock is released: the state directory is free again.
    expect(s.db.prepare('SELECT count(*) AS n FROM worker_lock').get()).toEqual({ n: 0 });
  });

  it('runs what is queued through the worker, then ends without waiting for a tick', async () => {
    const s = setup();
    const a = insertQueuedJob(s.db, { repoId: 1, fullName: 'o/r', issue: 1 });
    const b = insertQueuedJob(s.db, { repoId: 1, fullName: 'o/r', issue: 2 });
    const started = Date.now();
    expect(await drainQueue(s.deps, { tickMs: 60_000, stallMs: 60_000 })).toEqual({ ended: 'idle' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(s.executed).toEqual([a, b]);
    expect(getJob(s.db, a)!.status).toBe('succeeded');
    expect(getJob(s.db, b)!.status).toBe('succeeded');
  });

  it('cancels a job its pre-start check rejects and ends without running anything', async () => {
    const s = setup({ checkDispatchable: async () => ({ ok: false, reason: 'issue #1 is closed' }) });
    const a = insertQueuedJob(s.db, { repoId: 1, fullName: 'o/r', issue: 1 });
    expect(await drainQueue(s.deps, FAST)).toEqual({ ended: 'idle' });
    expect(s.executed).toEqual([]);
    expect(getJob(s.db, a)).toMatchObject({ status: 'canceled', statusReason: 'issue #1 is closed' });
  });

  it('waits for a retry that comes due soon, and makes it', async () => {
    const s = setup();
    const publisher = flakyPublisher(s.db, 150);
    const a = insertQueuedJob(s.db, { repoId: 1, fullName: 'o/r', issue: 1 });
    expect(await drainQueue({ ...s.deps, publisher }, FAST)).toEqual({ ended: 'idle' });
    expect(publisher.attempts).toBe(2);
    expect(getPublication(s.db, latestRunOfJob(s.db, a)!.id)!.state).toBe('published');
    expect(nextRetryAt(s.db)).toBeNull();
  });

  it('does not wait for a retry scheduled for later than it settles', async () => {
    const s = setup();
    const publisher = flakyPublisher(s.db, 60 * 60_000);
    const a = insertQueuedJob(s.db, { repoId: 1, fullName: 'o/r', issue: 1 });
    const started = Date.now();
    expect(await drainQueue({ ...s.deps, publisher }, { ...FAST, settleMs: 500 })).toEqual({ ended: 'retries-abandoned' });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(publisher.attempts).toBe(1);
    expect(getPublication(s.db, latestRunOfJob(s.db, a)!.id)!.state).toBe('failed');
    expect(nextRetryAt(s.db)).toBeGreaterThan(Date.now());
  });

  it('gives up on a job nothing can start, and leaves it queued', async () => {
    let checks = 0;
    const s = setup({
      checkDispatchable: async () => {
        checks++;
        throw new Error('GitHub is down');
      },
    });
    const a = insertQueuedJob(s.db, { repoId: 1, fullName: 'o/r', issue: 1 });
    expect(await drainQueue(s.deps, FAST)).toEqual({ ended: 'stalled' });
    expect(checks).toBeGreaterThan(1); // tried again on later ticks before giving up
    expect(getJob(s.db, a)!.status).toBe('queued');
    expect(s.executed).toEqual([]);
  });

  // The flaky #197 test on windows-latest: a reviewer job whose pushed head GitHub did not show
  // yet ("not yet", three times) was given up on as stuck when those checks took longer than
  // stallMs on a slow machine. It is given checks, not time.
  it('waits for a job whose pre-start check says "not yet", however slow each check is, and runs it once it says yes', async () => {
    let checks = 0;
    const s = setup({
      checkDispatchable: async () => {
        checks++;
        // Each check takes longer than the whole stall window.
        await new Promise((r) => setTimeout(r, FAST.stallMs! * 2));
        return checks <= 3 ? { ok: false, reason: 'GitHub has not caught up yet', retry: true } : { ok: true };
      },
    });
    const a = insertQueuedJob(s.db, { repoId: 1, fullName: 'o/r', issue: 1 });
    expect(await drainQueue(s.deps, FAST)).toEqual({ ended: 'idle' });
    expect(checks).toBe(4);
    expect(s.executed).toEqual([a]);
  });

  it('gives up on a job whose check says "not yet" for good, after MIN_DEFERRED_CHECKS more checks, and leaves it queued', async () => {
    let checks = 0;
    const s = setup({
      checkDispatchable: async () => {
        checks++;
        return { ok: false, reason: 'GitHub has not caught up yet', retry: true };
      },
    });
    const a = insertQueuedJob(s.db, { repoId: 1, fullName: 'o/r', issue: 1 });
    expect(await drainQueue(s.deps, FAST)).toEqual({ ended: 'stalled' });
    expect(checks).toBeGreaterThanOrEqual(MIN_DEFERRED_CHECKS);
    expect(getJob(s.db, a)).toMatchObject({ status: 'queued', statusReason: `${NOT_STARTED_YET}GitHub has not caught up yet` });
    expect(s.executed).toEqual([]);
  });

  it('stops a running job at the deadline', async () => {
    const s = setup({ executor: hangingExecutor });
    const a = insertQueuedJob(s.db, { repoId: 1, fullName: 'o/r', issue: 1 });
    expect(await drainQueue(s.deps, { ...FAST, deadlineMs: 200 })).toEqual({ ended: 'deadline' });
    expect(getJob(s.db, a)!.status).toBe('interrupted');
  });

  it('stops when the caller aborts', async () => {
    const s = setup({ executor: hangingExecutor });
    const a = insertQueuedJob(s.db, { repoId: 1, fullName: 'o/r', issue: 1 });
    setTimeout(() => s.controller.abort(), 100);
    expect(await drainQueue(s.deps, FAST)).toEqual({ ended: 'stopped' });
    expect(getJob(s.db, a)!.status).toBe('interrupted');
  });
});
