import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitFixture, type GitFixture } from '../../test/git-fixtures.js';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { configSchema, type FactoryConfig, type FactoryConfigInput } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { claimNextJob, getJob, setRunProcess, type Claim } from '../db/queue.js';
import { isInside, worktreesRoot } from '../git/worktree.js';
import { resolvePaths, type FactoryPaths } from '../paths.js';
import { silentLogger } from '../util/log.js';
import { runDaemon } from './daemon.js';
import { LogOnlyExecutor, type ExecutionContext } from './executor.js';
import { LiveExecutor } from './live.js';
import { createExecutor, PrepareOnlyExecutor } from './prepare-only.js';

const fixtures: GitFixture[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const f of fixtures.splice(0)) f.cleanup();
});

function setup(repoOver: Record<string, unknown> = {}, over: Partial<FactoryConfigInput> = {}) {
  const f = createGitFixture('octo/widgets');
  fixtures.push(f);
  const paths: FactoryPaths = resolvePaths({ env: { FACTORY_HOME: join(f.root, 'factory home') } });
  const config: FactoryConfig = configSchema.parse({
    version: 1,
    maxConcurrent: 4,
    execution: { mode: 'prepare-only' },
    agents: { claude: { maxConcurrent: 4 } },
    pools: { general: { agents: ['claude'] } },
    actions: { 'implement-issue': {}, triage: { output: 'log' } },
    dispatch: { allowedActors: ['allen'] },
    repositories: {
      'octo/widgets': {
        id: 42,
        // Relative to the config file's directory.
        checkoutPath: relative(paths.configDir, f.clone),
        // The fixture's remote is a local path, so it has to be named explicitly.
        remote: 'origin',
        workflows: [{ trigger: { event: 'issue.labeled', label: 'factory:ready' }, action: 'implement-issue', pool: 'general' }],
        ...repoOver,
      },
    },
    ...over,
  });
  const db = openDatabase(':memory:');
  dbs.push(db);
  return { f, paths, config, db };
}

function claim(db: Db, config: FactoryConfig, paths: FactoryPaths): Claim {
  const c = claimNextJob(db, config, { workerId: 'wrk_test', hostname: 'test-host', leaseSeconds: 60, runsDir: paths.runsDir });
  if (!c) throw new Error('nothing to claim');
  return c;
}

function context(db: Db, config: FactoryConfig, paths: FactoryPaths, runId: string, signal = new AbortController().signal) {
  const recorded: Array<{ pid?: number | null; checkoutPath?: string | null }> = [];
  const ctx: ExecutionContext = {
    config,
    paths,
    log: silentLogger,
    signal,
    now: () => Date.parse('2026-11-17T12:00:00Z'),
    recordProcess: (info) => {
      recorded.push(info);
      setRunProcess(db, runId, info);
    },
  };
  return { ctx, recorded };
}

// Real git is slow to spawn on Windows runners.
describe('PrepareOnlyExecutor', { timeout: 60_000 }, () => {
  it('gives two issues in one repo separate branches, worktrees and logs (worker end to end)', async () => {
    const { f, paths, config, db } = setup();
    const ids: string[] = [];
    const controller = new AbortController();
    const done = runDaemon({
      db,
      config,
      paths,
      log: silentLogger,
      signal: controller.signal,
      executor: createExecutor(config),
      poll: async () => {
        if (ids.length === 0) {
          ids.push(insertQueuedJob(db, { repoId: 42, fullName: 'octo/widgets', issue: 11 }));
          ids.push(insertQueuedJob(db, { repoId: 42, fullName: 'octo/widgets', issue: 12 }));
        }
      },
      checkDispatchable: async () => ({ ok: true }),
      processControl: { isAlive: () => false, startTime: async () => null, terminate: async () => {} },
      hostname: 'host-a',
      pid: 4242,
    });
    await vi.waitFor(() => expect(ids.map((id) => getJob(db, id)?.status)).toEqual(['succeeded', 'succeeded']), {
      timeout: 30_000,
    });
    controller.abort();
    await done;

    const runs = ids.map(
      (id) =>
        db.prepare('SELECT * FROM runs WHERE job_id = ?').get(id) as { id: string; checkout_path: string; log_path: string },
    );
    const [a, b] = runs as [(typeof runs)[0], (typeof runs)[0]];
    expect(a.checkout_path).not.toBe(b.checkout_path);
    expect(a.log_path).not.toBe(b.log_path);
    for (const [i, run] of runs.entries()) {
      const issue = 11 + i;
      const branch = `factory/issue-${issue}-${ids[i]}`;
      expect(run.checkout_path).toBe(join(worktreesRoot(paths), '42', ids[i]!));
      expect(isInside(worktreesRoot(paths), run.checkout_path)).toBe(true);
      expect(f.git(run.checkout_path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
      expect(f.git(f.clone, 'branch', '--list', branch)).toContain(branch);
      const log = readFileSync(run.log_path, 'utf8');
      expect(log).toContain('mode: prepare-only');
      expect(log).toContain(`branch: ${branch}\n`);
      expect(log).toContain(`checkout: ${run.checkout_path}\n`);
      expect(log).toContain(`source clone: ${f.clone}\n`);
      expect(log).toMatch(/base: main at [0-9a-f]{40}\n/);
    }
    // The user's clone is left on its own branch with no stray files.
    expect(f.git(f.clone, 'status', '--porcelain')).toBe('');
    expect(f.git(f.clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('fails (keeping run.log) when the branch already exists, and records no checkout', async () => {
    const { f, paths, config, db } = setup();
    const jobId = insertQueuedJob(db, { repoId: 42, fullName: 'octo/widgets', issue: 5 });
    f.git(f.clone, 'branch', `factory/issue-5-${jobId}`);
    const c = claim(db, config, paths);
    const { ctx, recorded } = context(db, config, paths, c.run.id);
    const result = await new PrepareOnlyExecutor().execute(c, ctx);
    expect(result.outcome).toBe('failed');
    expect(result.error).toMatch(/already exists.*refusing to reuse it/);
    expect(recorded).toEqual([]);
    const log = readFileSync(c.run.logPath!, 'utf8');
    expect(log).toContain('checkout: none (preparation failed)');
    expect(log).toMatch(/error: could not prepare the worktree: branch factory\/issue-5-job_\w+ already exists/);
  });

  it('records a worktree left by a failed git worktree add, so the failed run keeps it', async () => {
    const { f, paths, config, db } = setup();
    f.failPostCheckout();
    insertQueuedJob(db, { repoId: 42, fullName: 'octo/widgets', issue: 8 });
    const c = claim(db, config, paths);
    const { ctx, recorded } = context(db, config, paths, c.run.id);
    const result = await new PrepareOnlyExecutor().execute(c, ctx);
    const checkout = join(worktreesRoot(paths), '42', c.job.id);
    expect(result.outcome).toBe('failed');
    expect(result.error).toMatch(/kept for inspection/);
    expect(recorded).toEqual([{ checkoutPath: checkout }]);
    expect(db.prepare('SELECT checkout_path FROM runs WHERE id = ?').get(c.run.id)).toEqual({ checkout_path: checkout });
    expect(existsSync(checkout)).toBe(true);
    expect(readFileSync(c.run.logPath!, 'utf8')).toContain(
      `checkout: ${checkout} (left by the failed preparation; kept for inspection)`,
    );
  });

  it('suffixes the branch and worktree of a later attempt', async () => {
    const { f, paths, config, db } = setup();
    insertQueuedJob(db, { repoId: 42, fullName: 'octo/widgets', issue: 6 });
    const c = claim(db, config, paths);
    const { ctx } = context(db, config, paths, c.run.id);
    const second = { ...c, run: { ...c.run, attempt: 2 } };
    expect(await new PrepareOnlyExecutor().execute(second, ctx)).toEqual({ outcome: 'succeeded' });
    const checkout = join(worktreesRoot(paths), '42', `${c.job.id}-2`);
    expect(f.git(checkout, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`factory/issue-6-${c.job.id}-2`);
  });

  it('creates no checkout for an action whose output is log', async () => {
    const { paths, config, db } = setup();
    insertQueuedJob(db, { repoId: 42, fullName: 'octo/widgets', issue: 3, action: 'triage' });
    const c = claim(db, config, paths);
    const { ctx, recorded } = context(db, config, paths, c.run.id);
    expect(await new PrepareOnlyExecutor().execute(c, ctx)).toEqual({ outcome: 'succeeded' });
    expect(recorded).toEqual([]);
    expect(existsSync(worktreesRoot(paths))).toBe(false);
    expect(readFileSync(c.run.logPath!, 'utf8')).toContain('checkout: none (action output is log)');
  });

  it('fails without a checkoutPath and is interrupted when the worker is already stopping', async () => {
    const noCheckout = setup({ checkoutPath: undefined });
    insertQueuedJob(noCheckout.db, { repoId: 42, fullName: 'octo/widgets', issue: 1 });
    const c1 = claim(noCheckout.db, noCheckout.config, noCheckout.paths);
    const r1 = await new PrepareOnlyExecutor().execute(c1, context(noCheckout.db, noCheckout.config, noCheckout.paths, c1.run.id).ctx);
    expect(r1).toEqual({ outcome: 'failed', error: expect.stringMatching(/checkoutPath is not set/) });

    const s = setup();
    insertQueuedJob(s.db, { repoId: 42, fullName: 'octo/widgets', issue: 2 });
    const c2 = claim(s.db, s.config, s.paths);
    const stop = new AbortController();
    stop.abort();
    const r2 = await new PrepareOnlyExecutor().execute(c2, context(s.db, s.config, s.paths, c2.run.id, stop.signal).ctx);
    expect(r2.outcome).toBe('interrupted');
    expect(existsSync(worktreesRoot(s.paths))).toBe(false);
  });
});

describe('createExecutor', () => {
  it('selects the executor from execution.mode', () => {
    expect(createExecutor({ execution: { mode: 'prepare-only' } })).toBeInstanceOf(PrepareOnlyExecutor);
    expect(createExecutor({ execution: { mode: 'log-only' } })).toBeInstanceOf(LogOnlyExecutor);
    expect(createExecutor({ execution: { mode: 'live' } })).toBeInstanceOf(LiveExecutor);
  });
});
