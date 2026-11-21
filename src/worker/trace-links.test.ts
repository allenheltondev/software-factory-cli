import { describe, expect, it } from 'vitest';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { configSchema } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { pruneJob } from '../db/prune.js';
import { claimNextJob, finishRun, getJob, retryJob } from '../db/queue.js';
import type { Job } from '../types.js';
import { followedRuns, followsLines, recordRunTrace, traceIdFrom, traceOfRun } from './trace-links.js';

const config = configSchema.parse({
  version: 1,
  maxConcurrent: 5,
  agents: { claude: { maxConcurrent: 5 } },
  pools: { general: { agents: ['claude'] } },
  actions: { 'implement-issue': {} },
  dispatch: { allowedActors: ['allen'] },
});
const T = 'a'.repeat(32);
const U = 'b'.repeat(32);
const now = () => Date.parse('2026-11-21T10:00:00.000Z');

function run(db: Db, issue: number) {
  const jobId = insertQueuedJob(db, { repoId: 1, fullName: 'o/r', issue });
  const c = claimNextJob(db, config, { workerId: 'w', hostname: 'h', leaseSeconds: 60, runsDir: '/runs', now })!;
  return { jobId, runId: c.run.id, job: c.job };
}

describe('run traces', () => {
  it('reads a trace id only when it is one', () => {
    expect(traceIdFrom({ UPDRAFT_TRACE_ID: T })).toBe(T);
    expect(traceIdFrom({ UPDRAFT_TRACE_ID: 'nope' })).toBeNull();
    expect(traceIdFrom({})).toBeNull();
  });

  it('records and reads the trace of a run', () => {
    const db = openDatabase(':memory:');
    recordRunTrace(db, 'run_1', T);
    recordRunTrace(db, 'run_2', 'not-a-trace');
    expect(traceOfRun(db, 'run_1')).toBe(T);
    expect(traceOfRun(db, 'run_2')).toBeNull();
  });

  it("links a retry to the job's earlier attempt, when that was traced", () => {
    const db = openDatabase(':memory:');
    const first = run(db, 1);
    recordRunTrace(db, first.runId, T);
    finishRun(db, first.runId, { outcome: 'failed', now });
    retryJob(db, first.jobId, now);
    const second = claimNextJob(db, config, { workerId: 'w', hostname: 'h', leaseSeconds: 60, runsDir: '/runs', now })!;
    expect(followedRuns(db, second.job, second.run.id)).toEqual([{ runId: first.runId, relation: 'retry', traceId: T }]);
    expect(followedRuns(db, first.job, first.runId)).toEqual([]);
  });

  it('links a revision to the review that queued it and the run that opened the pull request', () => {
    const db = openDatabase(':memory:');
    const source = run(db, 1);
    const reviewer = run(db, 2);
    recordRunTrace(db, source.runId, T);
    recordRunTrace(db, reviewer.runId, U);
    const at = new Date(now()).toISOString();
    db.prepare(
      `INSERT INTO pr_reviews (run_id, job_id, repo_id, repo_full_name, issue_number, pr_number, head_sha, agent, verdict, findings, state, revision_job_id, created_at, updated_at)
       VALUES (?, ?, 1, 'o/r', 1, 100, 'abc', 'claude', 'changes-requested', 'x', 'published', 'job_revision', ?, ?)`,
    ).run(reviewer.runId, reviewer.jobId, at, at);
    const base = getJob(db, source.jobId)!;
    const revisionJob = {
      ...base,
      id: 'job_revision',
      envelope: { ...base.envelope, type: 'pull_request.changes_requested', revision: { sourceRunId: source.runId } },
    } as unknown as Job;
    const follows = followedRuns(db, revisionJob, 'run_new');
    expect(follows).toEqual([
      { runId: reviewer.runId, relation: 'review', traceId: U },
      { runId: source.runId, relation: 'source', traceId: T },
    ]);
    expect(followsLines(follows)).toEqual([`follows: run ${reviewer.runId} (review, trace ${U})`, `follows: run ${source.runId} (source, trace ${T})`]);
  });

  it('is pruned with its run', () => {
    const db = openDatabase(':memory:');
    const longAgo = () => now() - 40 * 86_400_000;
    const jobId = insertQueuedJob(db, { repoId: 1, fullName: 'o/r', issue: 9 });
    const c = claimNextJob(db, config, { workerId: 'w', hostname: 'h', leaseSeconds: 60, runsDir: '/runs', now: longAgo })!;
    recordRunTrace(db, c.run.id, T);
    finishRun(db, c.run.id, { outcome: 'failed', now: longAgo });
    expect(pruneJob(db, jobId, new Date(now() - 30 * 86_400_000).toISOString())).toMatchObject({ pruned: true });
    expect(traceOfRun(db, c.run.id)).toBeNull();
  });
});
