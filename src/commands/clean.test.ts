import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { createGitFixture, type GitFixture } from '../../test/git-fixtures.js';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { configSchema, type FactoryConfigInput } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { cancelClaim, claimNextJob, finishRun, getRun, setRunProcess } from '../db/queue.js';
import type { RunOutcome } from '../types.js';
import { silentLogger } from '../util/log.js';
import { PrepareOnlyExecutor } from '../worker/prepare-only.js';
import { cleanCommand, cleanVerdict } from './clean.js';
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
});

// Real git is slow to spawn on Windows runners.
describe('factory clean', { timeout: 60_000 }, () => {
  async function setup() {
    const f = createGitFixture('octo/widgets');
    fixtures.push(f);
    const ctx = fakeContext({ home: join(f.root, 'factory home') });
    ctx.openDb = (file) => openDatabase(file);
    const { paths } = ctx;
    const input: FactoryConfigInput = {
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
          workflows: [{ trigger: { event: 'issue.labeled', label: 'factory:ready' }, action: 'implement-issue', pool: 'general' }],
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
      const c = claimNextJob(db, config, { workerId: 'w', leaseSeconds: 60, runsDir: paths.runsDir })!;
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
      else if (close !== 'open') finishRun(db, c.run.id, { outcome: close });
      const r = getRun(db, c.run.id)!;
      return { runId: r.id, checkout: r.checkoutPath!, branch: `factory/issue-${issue}-${c.job.id}` };
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
    // A path factory did not create (here, the user's own clone) is never removed.
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
    expect(listed).not.toContain(`factory/issue-1-`);
    expect(listed).not.toContain(`factory/issue-6-`);
    expect(listed).toContain(`factory/issue-3-`);
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

  it('does nothing without a state database', async () => {
    const ctx = fakeContext();
    expect(await cleanCommand(ctx)).toBe(0);
    expect(ctx.out.text).toContain('nothing to clean');
  });
});
