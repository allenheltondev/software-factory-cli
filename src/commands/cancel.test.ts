import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { configSchema } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { CANCELED_BY_USER, claimNextJob, finishRun, getJob, getRun } from '../db/queue.js';
import { acquireWorkerLock, WORKER_STALE_MS } from '../worker/lock.js';
import { cancelCommand } from './cancel.js';
import { EXIT } from './errors.js';
import { fakeContext } from './fakes.js';

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
  /** Claim the job as worker `wrk_1`. */
  const claim = () => claimNextJob(db, config, { workerId: 'wrk_1', hostname: 'host-a', leaseSeconds: 60, runsDir: ctx.paths.runsDir, now: ctx.now })!;
  const startWorker = (workerId = 'wrk_1') =>
    acquireWorkerLock(db, { workerId, pid: 1, hostname: 'host-a' }, { now: ctx.now, isPidAlive: () => true });
  return { ctx, db, jobId, claim, startWorker };
}

describe('factory cancel', () => {
  it('cancels a queued job directly, with or without a worker', async () => {
    const { ctx, db, jobId } = setup();
    expect(await cancelCommand(ctx, jobId)).toBe(EXIT.OK);
    expect(getJob(db, jobId)).toMatchObject({ status: 'canceled', statusReason: CANCELED_BY_USER });
    expect(ctx.out.text).toContain(`Canceled ${jobId} (octo/widgets#7, wf); it was queued and will not run.`);
    expect(ctx.out.text).toContain(`"factory retry ${jobId}" queues it again.`);
  });

  it('records a request for a running job and leaves stopping it to the worker', async () => {
    const { ctx, db, jobId, claim, startWorker } = setup();
    startWorker();
    const { run } = claim();
    expect(await cancelCommand(ctx, jobId)).toBe(EXIT.OK);
    expect(ctx.out.text).toContain(`Cancel requested for ${jobId} (octo/widgets#7, wf): run ${run.id} on claude.`);
    expect(ctx.out.text).toContain('Its worktree and branch are kept, and nothing is published.');
    // The job is still running: only the worker can stop the agent.
    expect(getJob(db, jobId)?.status).toBe('running');
    expect(getRun(db, run.id)?.cancelRequestedAt).toBe(new Date(ctx.now()).toISOString());

    ctx.out.text = '';
    expect(await cancelCommand(ctx, jobId)).toBe(EXIT.OK);
    expect(ctx.out.text).toContain(`Cancel was already requested for ${jobId}`);
  });

  it('does not pretend to cancel a running job when no worker is running', async () => {
    const { ctx, db, jobId, claim, startWorker } = setup();
    startWorker();
    const { run } = claim();
    const later = ctx.now() + WORKER_STALE_MS + 1; // the worker died; its heartbeat went stale
    ctx.now = () => later;
    await expect(cancelCommand(ctx, jobId)).rejects.toMatchObject({
      exitCode: EXIT.FAILURE,
      message: expect.stringMatching(new RegExp(`job ${jobId} is marked running \\(run ${run.id}\\), but no worker is running.*next "factory start"`)),
    });
    expect(getRun(db, run.id)?.cancelRequestedAt).toBeNull();
    expect(getJob(db, jobId)?.status).toBe('running');
    expect(ctx.out.text).toBe('');
  });

  it('fails clearly for a finished job, an unknown id, a run id and a missing database', async () => {
    const { ctx, jobId, claim, startWorker, db } = setup();
    startWorker();
    const { run } = claim();
    finishRun(db, run.id, { outcome: 'succeeded' });
    await expect(cancelCommand(ctx, jobId)).rejects.toMatchObject({
      exitCode: EXIT.FAILURE,
      message: `job ${jobId} is already succeeded; only queued or running jobs can be canceled`,
    });
    await expect(cancelCommand(ctx, 'job_nope')).rejects.toThrow('job job_nope not found; "factory status" lists job ids.');
    await expect(cancelCommand(ctx, run.id)).rejects.toThrow(`${run.id} is a run, not a job; cancel its job with "factory cancel ${jobId}".`);

    const empty = fakeContext();
    homes.push(empty.paths.dataDir);
    await expect(cancelCommand(empty, jobId)).rejects.toThrow(/No state database at .*there are no jobs to cancel/);
  });
});
