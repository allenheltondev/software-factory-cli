import { describe, expect, it } from 'vitest';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { configSchema } from '../config/schema.js';
import { openDatabase, type Db } from './database.js';
import { commitPollBatch } from './ingest.js';
import { listPrunableJobs, pruneJob } from './prune.js';
import { beginPublication, finishPublication } from './publications.js';
import { claimNextJob, finishRun, getJob, retryJob } from './queue.js';

const T0 = Date.parse('2026-11-17T10:00:00.000Z');
const DAY = 86_400_000;
const old = () => T0 - 40 * DAY;
const cutoff = new Date(T0 - 30 * DAY).toISOString();

const config = configSchema.parse({
  version: 1,
  maxConcurrent: 5,
  agents: { claude: { maxConcurrent: 5 } },
  pools: { general: { agents: ['claude'] } },
  actions: { 'implement-issue': {} },
  dispatch: { allowedActors: ['allen'] },
});

/** A job that ran once and ended `outcome` 40 days before T0. */
function finishedJob(db: Db, issue: number, outcome: 'succeeded' | 'failed' = 'failed') {
  const jobId = insertQueuedJob(db, { repoId: 1, fullName: 'o/r', issue });
  const c = claimNextJob(db, config, { workerId: 'w', hostname: 'h', leaseSeconds: 60, runsDir: '/runs', now: old })!;
  finishRun(db, c.run.id, { outcome, now: old });
  return { jobId, runId: c.run.id };
}

describe('pruneJob', () => {
  it('re-checks the job inside its transaction, so one retried after it was listed is left alone', () => {
    const db = openDatabase(':memory:');
    const { jobId } = finishedJob(db, 1);
    expect(listPrunableJobs(db, cutoff)).toMatchObject([{ id: jobId, keep: null, runs: [{ logPath: expect.any(String) }] }]);

    retryJob(db, jobId, () => T0);
    expect(pruneJob(db, jobId, cutoff)).toEqual({ pruned: false, why: 'it is queued' });
    expect(getJob(db, jobId)?.status).toBe('queued');
    expect(db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM pruned_events').get()).toEqual({ n: 0 });
    expect(listPrunableJobs(db, cutoff)).toEqual([]);

    // Running, then failed again just now: terminal, but not old.
    const c = claimNextJob(db, config, { workerId: 'w', hostname: 'h', leaseSeconds: 60, runsDir: '/runs', now: () => T0 })!;
    expect(pruneJob(db, jobId, cutoff)).toEqual({ pruned: false, why: 'it is running' });
    finishRun(db, c.run.id, { outcome: 'failed', now: () => T0 });
    expect(pruneJob(db, jobId, cutoff)).toEqual({ pruned: false, why: 'it changed after the cutoff' });
    expect(pruneJob(db, 'job_missing', cutoff)).toEqual({ pruned: false, why: 'it no longer exists' });
  });

  it('keeps a job whose publication is unfinished or was touched after the cutoff', () => {
    const db = openDatabase(':memory:');
    const a = finishedJob(db, 1, 'succeeded');
    const b = finishedJob(db, 2, 'succeeded');
    const c = finishedJob(db, 3, 'succeeded');
    const pub = { repoId: 1, repoFullName: 'o/r', mode: 'pr' as const, branch: 'b', leaseSeconds: 60 };
    // a: its worker died mid-publication long ago; the lease expired but it can still be finished.
    beginPublication(db, { ...pub, runId: a.runId, jobId: a.jobId, issueNumber: 1, now: old });
    // b: published long ago. c: an old run the user published by hand yesterday.
    beginPublication(db, { ...pub, runId: b.runId, jobId: b.jobId, issueNumber: 2, now: old });
    finishPublication(db, b.runId, 1, { state: 'published', now: old });
    beginPublication(db, { ...pub, runId: c.runId, jobId: c.jobId, issueNumber: 3, now: () => T0 - DAY });
    finishPublication(db, c.runId, 1, { state: 'published', now: () => T0 - DAY });

    expect(listPrunableJobs(db, cutoff).map((j) => [j.id, j.keep])).toEqual([
      [a.jobId, `the publication of run ${a.runId} is in progress or awaiting retry`],
      [b.jobId, null],
      [c.jobId, `the publication of run ${c.runId} changed after the cutoff`],
    ]);
    expect(pruneJob(db, a.jobId, cutoff).pruned).toBe(false);
    expect(pruneJob(db, c.jobId, cutoff).pruned).toBe(false);
    expect(pruneJob(db, b.jobId, cutoff)).toMatchObject({ pruned: true, runs: [{ id: b.runId }] });
    expect(db.prepare('SELECT run_id FROM publications ORDER BY rowid').all()).toEqual([{ run_id: a.runId }, { run_id: c.runId }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('leaves the dedupe key behind, so the same event cannot become a job again', () => {
    const db = openDatabase(':memory:');
    const { jobId } = finishedJob(db, 1);
    const job = getJob(db, jobId)!;
    const again = () =>
      commitPollBatch(db, {
        repoId: job.repoId,
        fullName: job.repoFullName,
        lastEventId: Number(job.eventId),
        etag: null,
        jobs: [
          { ...job, repoFullName: job.repoFullName },
          { ...job, workflowId: 'another-workflow' },
        ],
      });
    expect(pruneJob(db, jobId, cutoff)).toMatchObject({ pruned: true, errors: 1 });
    // The pruned (repo, workflow, event) is refused; the same event for another workflow is new.
    expect(again().map((j) => j.workflowId)).toEqual(['another-workflow']);
    expect(again()).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 1 });
  });
});
