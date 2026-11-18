import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { createGitFixture, type GitFixture } from '../../test/git-fixtures.js';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { configSchema, type UpdraftConfigInput } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { beginPublication, finishPublication } from '../db/publications.js';
import { cancelClaim, claimNextJob, finishRun, getJob, getRun, markExecutionStarted, setRunProcess } from '../db/queue.js';
import type { RunOutcome } from '../types.js';
import { silentLogger } from '../util/log.js';
import { PrepareOnlyExecutor } from '../worker/prepare-only.js';
import { recordError } from '../db/database.js';
import { cleanCommand, cleanVerdict, parseAge } from './clean.js';
import { EXIT } from './errors.js';
import { fakeContext } from './fakes.js';

const fixtures: GitFixture[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const f of fixtures.splice(0)) f.cleanup();
});

describe('cleanVerdict', () => {
  it('removes succeeded, closed-before-start and start-failed runs; keeps failed, interrupted and open ones', () => {
    const ended = '2026-11-17T00:00:00Z';
    expect(cleanVerdict({ outcome: 'succeeded', endedAt: ended }).remove).toBe(true);
    expect(cleanVerdict({ outcome: null, endedAt: ended }).remove).toBe(true);
    expect(cleanVerdict({ outcome: 'start_failed', endedAt: ended }).remove).toBe(true);
    expect(cleanVerdict({ outcome: 'failed', endedAt: ended }).remove).toBe(false);
    expect(cleanVerdict({ outcome: 'interrupted', endedAt: ended }).remove).toBe(false);
    expect(cleanVerdict({ outcome: null, endedAt: null }).remove).toBe(false);
  });

  it('keeps the worktree of a run canceled after its agent started, which may hold work', () => {
    const ended = '2026-11-17T00:00:00Z';
    // Canceled or released before start: nothing ran in the checkout.
    expect(cleanVerdict({ outcome: null, endedAt: ended, executionStartedAt: null })).toEqual({ remove: true, why: 'closed before start' });
    // `updraft cancel` on a running job closes the run with no outcome too.
    expect(cleanVerdict({ outcome: null, endedAt: ended, executionStartedAt: ended })).toEqual({
      remove: false,
      why: 'canceled after the agent started; kept for inspection',
    });
    expect(cleanVerdict({ outcome: 'succeeded', endedAt: ended, executionStartedAt: ended }).remove).toBe(true);
  });
});

describe('parseAge', () => {
  it('reads hours, days and weeks, and rejects anything else as a usage error', () => {
    expect(parseAge('30d')).toBe(30 * 86_400_000);
    expect(parseAge('12h')).toBe(12 * 3_600_000);
    expect(parseAge(' 2W ')).toBe(14 * 86_400_000);
    expect(parseAge('0d')).toBe(0);
    for (const bad of ['', '30', 'd', '-1d', '1.5d', '30 days', '1m']) {
      expect(() => parseAge(bad), bad).toThrow(expect.objectContaining({ exitCode: EXIT.USAGE }));
    }
  });
});

// Real git is slow to spawn on Windows runners.
describe('updraft clean', { timeout: 60_000 }, () => {
  async function setup() {
    const f = createGitFixture('octo/widgets');
    fixtures.push(f);
    const ctx = fakeContext({ home: join(f.root, 'updraft home') });
    ctx.openDb = (file) => openDatabase(file);
    const { paths } = ctx;
    const input: UpdraftConfigInput = {
      version: 1,
      maxConcurrent: 8,
      execution: { mode: 'prepare-only' },
      agents: { claude: { maxConcurrent: 8 } },
      pools: { general: { agents: ['claude'] } },
      actions: { 'implement-issue': {} },
      dispatch: { allowedActors: ['allen'] },
      repositories: {
        'octo/widgets': {
          id: 42,
          checkoutPath: f.clone,
          remote: 'origin',
          workflows: [{ trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general' }],
        },
      },
    };
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(paths.configFile, stringify(input));
    const config = configSchema.parse(input);
    const db = openDatabase(paths.dbFile);
    dbs.push(db);

    /** Prepare a worktree for a new job, then close its run as `close` says. */
    const run = async (issue: number, close: RunOutcome | 'canceled' | 'open') => {
      insertQueuedJob(db, { repoId: 42, fullName: 'octo/widgets', issue });
      const c = claimNextJob(db, config, { workerId: 'w', hostname: 'test-host', leaseSeconds: 60, runsDir: paths.runsDir })!;
      const result = await new PrepareOnlyExecutor().execute(c, {
        config,
        paths,
        log: silentLogger,
        signal: new AbortController().signal,
        now: Date.now,
        recordProcess: (info) => setRunProcess(db, c.run.id, info),
      });
      expect(result.outcome).toBe('succeeded');
      if (close === 'canceled') cancelClaim(db, c.run.id, 'issue closed');
      else if (close !== 'open') {
        markExecutionStarted(db, c.run.id, { workerId: 'w' });
        finishRun(db, c.run.id, { outcome: close });
      }
      const r = getRun(db, c.run.id)!;
      return { runId: r.id, jobId: c.job.id, checkout: r.checkoutPath!, logDir: dirname(r.logPath!), branch: `updraft/issue-${issue}-${c.job.id}` };
    };
    return { f, ctx, db, run };
  }

  it('removes only eligible worktrees, keeps branches, and is idempotent', async () => {
    const { f, ctx, db, run } = await setup();
    const succeeded = await run(1, 'succeeded');
    const canceled = await run(2, 'canceled');
    const failed = await run(3, 'failed');
    const interrupted = await run(4, 'interrupted');
    const open = await run(5, 'open');
    const vanished = await run(6, 'succeeded');
    rmSync(vanished.checkout, { recursive: true, force: true });
    // A path updraft did not create (here, the user's own clone) is never removed.
    const outside = await run(7, 'succeeded');
    setRunProcess(db, outside.runId, { checkoutPath: f.clone });

    expect(await cleanCommand(ctx, { dryRun: true })).toBe(0);
    expect(ctx.out.text).toContain(`Would remove ${succeeded.checkout} `);
    expect(ctx.out.text).toContain(`Would remove ${canceled.checkout} `);
    expect(ctx.out.text).toContain(`Kept ${failed.checkout} `);
    expect(ctx.out.text).toContain('would remove 3 worktree(s), kept 4.');
    for (const r of [succeeded, canceled, failed, interrupted, open]) expect(existsSync(r.checkout)).toBe(true);

    ctx.out.text = '';
    expect(await cleanCommand(ctx)).toBe(0);
    expect(ctx.err.text).toBe('');
    expect(ctx.out.text).toContain('removed 3 worktree(s), kept 4.');
    for (const r of [succeeded, canceled]) {
      expect(existsSync(r.checkout)).toBe(false);
      expect(getRun(db, r.runId)?.checkoutPath).toBeNull();
    }
    expect(getRun(db, vanished.runId)?.checkoutPath).toBeNull();
    for (const r of [failed, interrupted, open]) {
      expect(existsSync(r.checkout)).toBe(true);
      expect(getRun(db, r.runId)?.checkoutPath).toBe(r.checkout);
    }
    expect(existsSync(join(f.clone, 'README.md'))).toBe(true);
    expect(getRun(db, outside.runId)?.checkoutPath).toBe(f.clone);

    const listed = f.git(f.clone, 'worktree', 'list', '--porcelain');
    expect(listed).not.toContain(`updraft/issue-1-`);
    expect(listed).not.toContain(`updraft/issue-6-`);
    expect(listed).toContain(`updraft/issue-3-`);
    // Branches are kept, including those of removed worktrees.
    for (const r of [succeeded, canceled, failed, vanished]) expect(f.git(f.clone, 'branch', '--list', r.branch)).toContain(r.branch);

    ctx.out.text = '';
    expect(await cleanCommand(ctx)).toBe(0);
    expect(ctx.out.text).toContain('removed 0 worktree(s), kept 4.');
  });

  it('reports and skips a worktree with uncommitted changes', async () => {
    const { ctx, run } = await setup();
    const dirty = await run(1, 'succeeded');
    writeFileSync(join(dirty.checkout, 'scratch.txt'), 'wip');
    expect(await cleanCommand(ctx)).toBe(1);
    expect(ctx.err.text).toContain(`Could not remove ${dirty.checkout}`);
    expect(existsSync(join(dirty.checkout, 'scratch.txt'))).toBe(true);
  });

  const DAY = 86_400_000;

  it('--older-than prunes old terminal jobs with their runs, publications, logs and clean worktrees', async () => {
    const { f, ctx, db, run } = await setup();
    const succeeded = await run(1, 'succeeded');
    const failed = await run(2, 'failed');
    const dirty = await run(3, 'failed');
    writeFileSync(join(dirty.checkout, 'scratch.txt'), 'wip');
    const open = await run(4, 'open');
    const published = await run(6, 'succeeded');
    const pub = { jobId: published.jobId, repoId: 42, repoFullName: 'octo/widgets', issueNumber: 6, mode: 'pr' as const, branch: 'b', leaseSeconds: 60 };
    expect(beginPublication(db, { runId: published.runId, ...pub }).ok).toBe(true);
    expect(finishPublication(db, published.runId, 1, { state: 'published' })).toBe(true);
    const publishing = await run(7, 'succeeded');
    expect(beginPublication(db, { runId: publishing.runId, ...pub, jobId: publishing.jobId, issueNumber: 7 }).ok).toBe(true);
    const awaitingRetry = await run(8, 'succeeded');
    expect(beginPublication(db, { runId: awaitingRetry.runId, ...pub, jobId: awaitingRetry.jobId, issueNumber: 8 }).ok).toBe(true);
    expect(finishPublication(db, awaitingRetry.runId, 1, { state: 'failed', error: '502', retryable: true })).toBe(true);
    for (const r of [succeeded, failed, dirty, published]) expect(existsSync(join(r.logDir, 'run.log'))).toBe(true);
    recordError(db, { scope: 'poll', message: 'old poll error' });

    // Everything above is 40 days old; one more job finished, and one error happened, yesterday.
    const nowMs = Date.now() + 40 * DAY;
    ctx.now = () => nowMs;
    const yesterday = new Date(nowMs - DAY).toISOString();
    const recent = await run(9, 'failed');
    db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(yesterday, recent.jobId);
    db.prepare('UPDATE runs SET ended_at = ? WHERE id = ?').run(yesterday, recent.runId);
    db.prepare('UPDATE errors SET at = ? WHERE job_id = ?').run(yesterday, recent.jobId);
    recordError(db, { scope: 'poll', message: 'recent poll error', at: yesterday });
    // Inserted last (the helper claims the oldest queued job); it is as old as the others.
    const queued = insertQueuedJob(db, { repoId: 42, fullName: 'octo/widgets', issue: 5 });

    const counts = () =>
      Object.fromEntries(
        ['jobs', 'runs', 'publications', 'errors', 'pruned_events'].map((t) => [t, (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n]),
      );
    const before = counts();

    // Dry run: the report, and nothing changed (not even the worktrees plain clean would remove).
    expect(await cleanCommand(ctx, { dryRun: true, olderThan: '30d' })).toBe(0);
    expect(ctx.out.text).toContain(`Would prune job ${succeeded.jobId} `);
    expect(ctx.out.text).toContain(`Would prune job ${failed.jobId} `);
    expect(ctx.out.text).toContain(`Kept job ${dirty.jobId} `);
    expect(ctx.out.text).toMatch(/would prune 3 job\(s\) finished before \S+ \(3 run\(s\), 3 log dir\(s\), 1 worktree\(s\)\) and 3 old error row\(s\), kept 3 old job\(s\)\./);
    expect(counts()).toEqual(before);
    for (const r of [succeeded, failed, dirty, published]) {
      expect(existsSync(r.checkout)).toBe(true);
      expect(existsSync(r.logDir)).toBe(true);
    }

    ctx.out.text = '';
    expect(await cleanCommand(ctx, { olderThan: '30d' })).toBe(0);
    expect(ctx.err.text).toBe('');
    // Old, terminal and nothing pending: gone with runs, publication, log directory and worktree.
    for (const r of [succeeded, failed, published]) {
      expect(getJob(db, r.jobId), r.jobId).toBeNull();
      expect(getRun(db, r.runId)).toBeNull();
      expect(existsSync(r.logDir)).toBe(false);
      expect(existsSync(r.checkout)).toBe(false);
      // Branches are kept, so a pruned job's commits are still reachable.
      expect(f.git(f.clone, 'branch', '--list', r.branch)).toContain(r.branch);
    }
    expect(ctx.out.text).toContain(`Pruned job ${failed.jobId} (octo/widgets#2, failed, finished `);
    expect(ctx.out.text).toMatch(/pruned 3 job\(s\) finished before \S+ \(3 run\(s\), 3 log dir\(s\), 1 worktree\(s\)\) and 3 old error row\(s\), kept 3 old job\(s\)\./);

    // A worktree with uncommitted work is never orphaned: its job stays, whole.
    expect(ctx.out.text).toContain(`Kept job ${dirty.jobId} (octo/widgets#3, failed, finished `);
    expect(ctx.out.text).toContain(`its worktree ${dirty.checkout} has uncommitted or untracked changes`);
    expect(getRun(db, dirty.runId)?.checkoutPath).toBe(dirty.checkout);
    expect(existsSync(join(dirty.checkout, 'scratch.txt'))).toBe(true);
    expect(existsSync(join(dirty.logDir, 'run.log'))).toBe(true);

    // A publication in progress or awaiting retry keeps its job, whatever its age.
    expect(ctx.out.text).toContain(`Kept job ${publishing.jobId} (octo/widgets#7, succeeded, finished `);
    expect(ctx.out.text).toContain(`the publication of run ${publishing.runId} is in progress or awaiting retry`);
    expect(ctx.out.text).toContain(`the publication of run ${awaitingRetry.runId} is in progress or awaiting retry`);
    expect(db.prepare('SELECT run_id FROM publications ORDER BY run_id').all()).toEqual(
      [publishing.runId, awaitingRetry.runId].sort().map((run_id) => ({ run_id })),
    );

    // Queued, running and recent jobs are not even considered.
    for (const id of [queued, open.jobId, recent.jobId]) {
      expect(getJob(db, id), id).not.toBeNull();
      expect(ctx.out.text).not.toContain(`job ${id} `);
    }
    expect(existsSync(open.checkout)).toBe(true);
    expect(existsSync(recent.logDir)).toBe(true);

    // Old errors are gone (with the pruned jobs' own); recent ones stay.
    expect(db.prepare('SELECT job_id, scope FROM errors ORDER BY id').all()).toEqual([
      { job_id: recent.jobId, scope: 'worker' },
      { job_id: null, scope: 'poll' },
    ]);
    // Every pruned job left its dedupe key behind.
    expect(counts()).toMatchObject({ jobs: 6, pruned_events: 3 });

    // Once the uncommitted file is gone, the next pass prunes that job too. Idempotent otherwise.
    rmSync(join(dirty.checkout, 'scratch.txt'));
    ctx.out.text = '';
    expect(await cleanCommand(ctx, { olderThan: '30d' })).toBe(0);
    expect(ctx.out.text).toContain(`Pruned job ${dirty.jobId} `);
    expect(ctx.out.text).toMatch(/pruned 1 job\(s\) .* and 0 old error row\(s\), kept 2 old job\(s\)\./);
    expect(existsSync(dirty.checkout)).toBe(false);
    expect(f.git(f.clone, 'worktree', 'list', '--porcelain')).not.toContain('updraft/issue-3-');
  });

  it('--older-than rejects a bad age before removing anything', async () => {
    const { ctx, run } = await setup();
    const succeeded = await run(1, 'succeeded');
    await expect(cleanCommand(ctx, { olderThan: 'a month' })).rejects.toMatchObject({ exitCode: EXIT.USAGE, message: expect.stringContaining('30d') });
    expect(existsSync(succeeded.checkout)).toBe(true);
    expect(ctx.out.text).toBe('');
  });

  it('does nothing without a state database', async () => {
    const ctx = fakeContext();
    expect(await cleanCommand(ctx)).toBe(0);
    expect(ctx.out.text).toContain('nothing to clean');
  });
});
