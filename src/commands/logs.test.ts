import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { configSchema } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { cancelClaim, claimNextJob, finishRun, markExecutionStarted, retryJob, type Claim } from '../db/queue.js';
import { acquireWorkerLock } from '../worker/lock.js';
import { fakeContext } from './fakes.js';
import { logsCommand } from './logs.js';

const config = configSchema.parse({
  version: 1,
  agents: { claude: {} },
  pools: { general: { agents: ['claude'] } },
  actions: { 'implement-issue': {} },
  dispatch: { allowedActors: ['allen'] },
});

const homes: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function setup() {
  const ctx = fakeContext();
  homes.push(ctx.paths.dataDir);
  ctx.openDb = (file) => openDatabase(file);
  const db = openDatabase(ctx.paths.dbFile);
  dbs.push(db);
  const jobId = insertQueuedJob(db, { repoId: 42, fullName: 'octo/widgets', issue: 7 });
  /** Claim the oldest queued job as worker `wrk_1` and start it. */
  const start = (): Claim => {
    const c = claimNextJob(db, config, { workerId: 'wrk_1', hostname: 'host-a', leaseSeconds: 60, runsDir: ctx.paths.runsDir, now: ctx.now })!;
    markExecutionStarted(db, c.run.id, { workerId: 'wrk_1', now: ctx.now });
    return c;
  };
  const startWorker = () => acquireWorkerLock(db, { workerId: 'wrk_1', pid: 1, hostname: 'host-a' }, { now: ctx.now, isPidAlive: () => true });
  const write = (c: Claim, text: string | Buffer) => {
    mkdirSync(dirname(c.run.logPath!), { recursive: true });
    appendFileSync(c.run.logPath!, text);
  };
  return { ctx, db, jobId, start, startWorker, write };
}

/** A `sleep` for --follow that runs one scripted step per poll instead of waiting. */
function scripted(steps: Array<() => void>) {
  let polls = 0;
  const sleep = async () => {
    const step = steps[polls++];
    if (!step) throw new Error(`--follow kept polling after its ${steps.length} scripted step(s)`);
    step();
  };
  return { sleep, polls: () => polls };
}

describe('factory logs', () => {
  it('prints the log of a run, and for a job the log of its latest run, saying which', async () => {
    const { ctx, db, jobId, start, startWorker, write } = setup();
    startWorker();
    const first = start();
    write(first, 'first attempt\n');
    finishRun(db, first.run.id, { outcome: 'failed', error: 'tests failed', now: ctx.now });
    retryJob(db, jobId, ctx.now);
    const second = start();
    write(second, 'second attempt\nstill going\n');

    expect(await logsCommand(ctx, first.run.id)).toBe(0);
    expect(ctx.out.text).toBe('first attempt\n');
    expect(ctx.err.text).toBe('');

    ctx.out.text = '';
    expect(await logsCommand(ctx, jobId)).toBe(0);
    // stdout is the log and nothing else; the note about the chosen run goes to stderr.
    expect(ctx.out.text).toBe('second attempt\nstill going\n');
    expect(ctx.err.text).toBe(`Job ${jobId}: latest run is ${second.run.id} (attempt 2, agent claude, in progress).\n`);
  });

  it('--path prints only the path, whether or not the file exists', async () => {
    const { ctx, jobId, start } = setup();
    const c = start();
    expect(await logsCommand(ctx, c.run.id, { path: true })).toBe(0);
    expect(ctx.out.text).toBe(`${join(ctx.paths.runsDir, c.run.id, 'run.log')}\n`);
    ctx.out.text = '';
    expect(await logsCommand(ctx, jobId, { path: true })).toBe(0);
    expect(ctx.out.text).toBe(`${c.run.logPath}\n`);
  });

  it('explains an unknown id, a job without runs, a missing log and a missing database', async () => {
    const { ctx, db, jobId, start, startWorker, write } = setup();
    startWorker();
    await expect(logsCommand(ctx, 'run_nope')).rejects.toThrow(/No run or job with id run_nope\. "factory status" lists recent ones/);
    await expect(logsCommand(ctx, jobId)).rejects.toThrow(`job ${jobId} is queued and has no runs yet, so there is no log.`);

    const c = start();
    await expect(logsCommand(ctx, c.run.id)).rejects.toThrow(
      `run ${c.run.id} has no log file at ${c.run.logPath}: the run has not written one yet (try --follow)`,
    );
    write(c, 'output\n');
    finishRun(db, c.run.id, { outcome: 'succeeded', now: ctx.now });
    rmSync(dirname(c.run.logPath!), { recursive: true });
    await expect(logsCommand(ctx, c.run.id)).rejects.toThrow(`run ${c.run.id} has no log file at ${c.run.logPath}: it has been deleted`);
    await expect(logsCommand(ctx, c.run.id, { follow: true })).rejects.toThrow(/it has been deleted/);

    // A run canceled by the pre-start check never ran, so it never had a log.
    insertQueuedJob(db, { repoId: 42, fullName: 'octo/widgets', issue: 8 });
    const claimed = claimNextJob(db, config, { workerId: 'wrk_1', hostname: 'host-a', leaseSeconds: 60, runsDir: ctx.paths.runsDir })!;
    cancelClaim(db, claimed.run.id, 'issue closed');
    await expect(logsCommand(ctx, claimed.run.id)).rejects.toThrow(/the run was closed before it started, so it never wrote one/);

    const empty = fakeContext();
    homes.push(empty.paths.dataDir);
    await expect(logsCommand(empty, 'run_x')).rejects.toThrow(/No state database at .*there are no runs yet/);
  });

  it('--follow prints output as it is appended and exits once the run is closed and drained', async () => {
    const { ctx, db, start, startWorker, write } = setup();
    startWorker();
    const c = start();
    const euro = Buffer.from('€'); // three bytes; split across two appends below
    const { sleep, polls } = scripted([
      () => write(c, 'header\n'), // the log does not exist until now
      () => {},
      () => write(c, Buffer.concat([Buffer.from('cost: '), euro.subarray(0, 1)])),
      () => write(c, Buffer.concat([euro.subarray(1), Buffer.from('5\n')])),
      () => {
        // The executor writes its last lines, then the worker closes the run.
        write(c, 'outcome: succeeded\n');
        finishRun(db, c.run.id, { outcome: 'succeeded', now: ctx.now });
      },
    ]);
    const seen: string[] = [];
    const out = ctx.out;
    const write0 = out.write.bind(out);
    out.write = (chunk: string): boolean => {
      seen.push(chunk);
      write0(chunk);
      return true;
    };

    expect(await logsCommand(ctx, c.run.id, { follow: true }, { sleep })).toBe(0);
    expect(polls()).toBe(5);
    expect(ctx.out.text).toBe('header\ncost: €5\noutcome: succeeded\n');
    // Printed as it arrived, and the half-written character was held back, not mangled.
    expect(seen.filter(Boolean)).toEqual(['header\n', 'cost: ', '€5\n', 'outcome: succeeded\n']);
    expect(ctx.err.text).toBe('');
  });

  it('--follow on a finished run prints the log and returns at once', async () => {
    const { ctx, db, start, write } = setup();
    const c = start();
    write(c, 'all of it\n');
    finishRun(db, c.run.id, { outcome: 'failed', now: ctx.now });
    const { sleep } = scripted([]);
    expect(await logsCommand(ctx, c.run.id, { follow: true }, { sleep })).toBe(0);
    expect(ctx.out.text).toBe('all of it\n');
  });

  it('--follow does not wait forever on a run whose worker is gone', async () => {
    const { ctx, start, write } = setup();
    const c = start(); // open, but no worker holds the lock
    write(c, 'partial\n');
    const { sleep } = scripted([]);
    expect(await logsCommand(ctx, c.run.id, { follow: true }, { sleep })).toBe(0);
    expect(ctx.out.text).toBe('partial\n');
    expect(ctx.err.text).toContain(`Run ${c.run.id} is still marked in progress, but no worker is running`);
  });

  it('reads a large log in pieces without losing bytes', async () => {
    const { ctx, db, start } = setup();
    const c = start();
    const text = `${'é'.repeat(150_000)}\nend\n`; // > 64 KiB, with multi-byte characters across read boundaries
    mkdirSync(dirname(c.run.logPath!), { recursive: true });
    writeFileSync(c.run.logPath!, `x${text}`);
    finishRun(db, c.run.id, { outcome: 'succeeded', now: ctx.now });
    expect(await logsCommand(ctx, c.run.id)).toBe(0);
    expect(ctx.out.text).toBe(`x${text}`);
  });
});
