import { describe, expect, it, vi } from 'vitest';
import type { FailureComment } from '../db/failure-comments.js';
import type { StatusSnapshot } from '../db/queue.js';
import type { Job, Publication, Revision } from '../types.js';
import { buildWorkflow, seedConfig, upsertRepoWorkflow } from './config-edit.js';
import { configSchema } from '../config/schema.js';
import { fakeContext } from './fakes.js';
import { buildStatusView, emptyConfig, renderFailureComment, renderPublication, renderRevision, renderStatus, statusCommand } from './status.js';

const emptySnapshot = (): StatusSnapshot => ({
  worker: null,
  counts: { queued: 0, running: 0, succeeded: 0, failed: 0, interrupted: 0, canceled: 0 },
  agents: [],
  activeRuns: [],
  recentJobs: [],
  recentAgentRuns: [],
  recentErrors: [],
  checkpoints: [],
});

const snapshotMock = vi.hoisted(() => ({ current: null as StatusSnapshot | null, configs: [] as unknown[] }));
vi.mock('../db/queue.js', () => ({
  getStatusSnapshot: (_db: unknown, config: unknown) => {
    snapshotMock.configs.push(config);
    return snapshotMock.current;
  },
}));

const job = (over: Partial<Job> = {}): Job =>
  ({
    id: 'job_1',
    repoId: 1,
    repoFullName: 'o/a',
    workflowId: 'implement-issue:updraft:ready',
    eventId: '100',
    issueNumber: 12,
    action: 'implement-issue',
    pool: 'general',
    status: 'failed',
    statusReason: 'agent exited 1',
    attempts: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:05:00Z',
    ...over,
  }) as Job;

describe('renderStatus', () => {
  it('renders a populated snapshot', () => {
    const input = upsertRepoWorkflow(seedConfig('me'), { id: 1, fullName: 'o/a' }, buildWorkflow({ label: 'go', action: 'implement-issue', pool: 'general' }));
    const config = configSchema.parse(upsertRepoWorkflow(input.config, { id: 2, fullName: 'o/b' }, buildWorkflow({ label: 'go', action: 'implement-issue', pool: 'general' })).config);
    const snapshot: StatusSnapshot = {
      ...emptySnapshot(),
      worker: { workerId: 'wrk_1', pid: 4242, hostname: 'box', startedAt: 't0', heartbeatAt: 't1', stale: false },
      counts: { queued: 2, running: 1, succeeded: 3, failed: 1, interrupted: 0, canceled: 0 },
      agents: [
        { agent: 'claude', enabled: true, running: 1, maxConcurrent: 1 },
        { agent: 'codex', enabled: false, running: 0, maxConcurrent: 1 },
      ],
      activeRuns: [
        {
          run: { id: 'run_1', agent: 'claude', pool: 'general', startedAt: 't2', executionStartedAt: 't2b', cancelRequestedAt: 't2c' } as never,
          job: job({ id: 'job_2', status: 'running', issueNumber: 7 }),
        },
        {
          run: { id: 'run_2', agent: 'kiro', pool: 'general', startedAt: 't6', executionStartedAt: null } as never,
          job: job({ id: 'job_3', status: 'running', issueNumber: 8 }),
        },
      ],
      recentJobs: [job()],
      recentErrors: [{ at: 't3', scope: 'poll', repoFullName: 'o/b', jobId: null, message: 'GitHub 502\nbad gateway' }],
      checkpoints: [
        { repoId: 1, fullName: 'o/a', lastEventId: 555, updatedAt: 't4' },
        { repoId: 9, fullName: 'gone/repo', lastEventId: 1, updatedAt: 't5' },
      ],
    };
    const view = buildStatusView({
      configPath: '/c/config.yaml',
      configState: 'ok',
      configMessage: null,
      config,
      dbFile: '/d/state.db',
      dbExists: true,
      snapshot,
    });
    expect(view.orphanCheckpoints.map((c) => c.repoId)).toEqual([9]);
    const text = renderStatus(view);
    expect(text).toContain('Worker: running — pid 4242 on box');
    expect(text).toContain('o/a (id 1) — 1 workflow(s); checkpoint event 555, updated t4');
    expect(text).toContain('o/b (id 2) — 1 workflow(s); not polled yet');
    expect(text).toContain('gone/repo (id 9) — no longer configured');
    expect(text).toMatch(/claude\s+enabled\s+1\/1 running/);
    expect(text).toMatch(/codex\s+disabled\s+0\/1 running/);
    expect(text).toContain('Queue: queued 2, running 1, succeeded 3, failed 1, interrupted 0, canceled 0');
    expect(text).toContain('run_1  o/a#7');
    expect(text).toMatch(/run_1 .*agent claude \(pool general\)  running since t2b, cancel requested$/m);
    expect(text).toMatch(/run_2 .*agent kiro \(pool general\)  claimed t6, not started yet/);
    expect(text).toContain('job_1  failed       o/a#12');
    expect(text).toContain('— agent exited 1');
    expect(text).toContain('t3  [poll] o/b: GitHub 502 bad gateway');
  });

  it('shows each publication: the PR, or the error and how to retry', () => {
    const base = {
      jobId: 'job_1',
      repoId: 1,
      repoFullName: 'o/a',
      issueNumber: 12,
      mode: 'draft-pr' as const,
      branch: 'updraft/issue-12-job_1',
      baseBranch: 'main',
      headSha: 'abc',
      pushedAt: 't',
      commentId: null,
      commentUrl: null,
      retryable: false,
      attempts: 1,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      createdAt: 't',
      updatedAt: 't9',
      publishedAt: null,
    };
    const publications: Publication[] = [
      { ...base, runId: 'run_ok', state: 'published', prNumber: 4, prUrl: 'https://github.com/o/a/pull/4', error: null },
      {
        ...base,
        runId: 'run_bad',
        state: 'failed',
        prNumber: null,
        prUrl: null,
        error: 'GitHub is unavailable for now: 502',
        retryable: true,
        nextAttemptAt: 't10',
      },
    ];
    const snapshot: StatusSnapshot = {
      ...emptySnapshot(),
      recentAgentRuns: [
        {
          run: {
            id: 'run_ok',
            outcome: 'succeeded',
            agent: 'claude',
            endedAt: 't8',
            summary: { commitCount: 1, filesChanged: 1, diffStat: '1 file changed', untracked: 0, worktree: '/w', branch: 'b', lastOutput: [] },
          } as never,
          job: job({ status: 'succeeded' }),
        },
      ],
      publications,
    };
    const text = renderStatus(
      buildStatusView({ configPath: '/c', configState: 'ok', configMessage: null, config: null, dbFile: '/d', dbExists: true, snapshot }),
    );
    expect(text).toContain('    draft PR #4: https://github.com/o/a/pull/4');
    expect(text).toContain('Publications:');
    expect(text).toMatch(/run_bad  failed .*o\/a#12/);
    expect(text).toContain(
      'publication failed (attempt 1; branch pushed): GitHub is unavailable for now: 502 — worker retries at t10, or run "updraft publish run_bad"',
    );
    expect(renderPublication({ ...publications[1]!, state: 'skipped', error: 'no commits' })).toBe('not published: no commits');
  });

  it('shows each failure comment: where it was posted, or why it was not', () => {
    const base: FailureComment = {
      runId: 'run_f1',
      jobId: 'job_1',
      repoId: 1,
      repoFullName: 'o/a',
      issueNumber: 12,
      state: 'posted',
      commentId: 9,
      commentUrl: 'https://github.com/o/a/issues/12#issuecomment-9',
      error: null,
      retryable: false,
      attempts: 1,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      createdAt: 't',
      updatedAt: 't9',
      postedAt: 't9',
    };
    const waiting: FailureComment = {
      ...base,
      runId: 'run_f2',
      state: 'failed',
      commentId: null,
      commentUrl: null,
      error: 'GitHub is unavailable for now: 502',
      retryable: true,
      nextAttemptAt: 't10',
      postedAt: null,
    };
    const snapshot: StatusSnapshot = {
      ...emptySnapshot(),
      recentAgentRuns: [
        {
          run: {
            id: 'run_f1',
            outcome: 'failed',
            agent: 'claude',
            endedAt: 't8',
            summary: { commitCount: 0, filesChanged: 0, diffStat: 'no changes', untracked: 0, worktree: '/w', branch: 'b', lastOutput: [] },
          } as never,
          job: job({ status: 'failed' }),
        },
      ],
      failureComments: [base, waiting],
    };
    const text = renderStatus(
      buildStatusView({ configPath: '/c', configState: 'ok', configMessage: null, config: null, dbFile: '/d', dbExists: true, snapshot }),
    );
    // Under the run, and in a section of its own (a run that failed before its agent started has no summary).
    expect(text).toContain('    worktree /w (branch b)\n    failure comment posted: https://github.com/o/a/issues/12#issuecomment-9');
    expect(text).toContain('Failure comments:');
    expect(text).toMatch(/run_f2  failed  +o\/a#12  updated t9/);
    expect(text).toContain('failure comment not posted (attempt 1): GitHub is unavailable for now: 502 — worker retries at t10');
    expect(renderFailureComment({ ...waiting, retryable: false, nextAttemptAt: null, error: 'cannot comment' })).toBe(
      'failure comment not posted (attempt 1): cannot comment — the worker will not retry it',
    );
    expect(renderFailureComment({ ...waiting, state: 'skipped', error: 'job job_1 is queued now, not failed' })).toBe(
      'failure comment not posted: job job_1 is queued now, not failed',
    );
    expect(renderFailureComment({ ...waiting, state: 'posting', attempts: 2 })).toBe('posting the failure comment (attempt 2)');
    expect(renderStatus(buildStatusView({ configPath: '/c', configState: 'ok', configMessage: null, config: null, dbFile: '/d', dbExists: true, snapshot: emptySnapshot() }))).not.toContain(
      'Failure comments',
    );
  });

  it('renders an empty state with a missing config', () => {
    const text = renderStatus(
      buildStatusView({
        configPath: '/c/config.yaml',
        configState: 'missing',
        configMessage: null,
        config: null,
        dbFile: '/d/state.db',
        dbExists: false,
        snapshot: emptySnapshot(),
      }),
    );
    expect(text).toContain('Config: /c/config.yaml (not found;');
    expect(text).toContain('State:  /d/state.db (not created yet)');
    expect(text).toContain('Worker: not running');
    expect(text).toContain('Repositories (0):\n  (none)');
  });
});

describe('updraft status', () => {
  it('works with no config and no state DB, without creating the DB', async () => {
    snapshotMock.current = emptySnapshot();
    const ctx = fakeContext();
    const opened: string[] = [];
    ctx.openDb = (file) => {
      opened.push(file);
      return { close() {} } as never;
    };
    expect(await statusCommand(ctx, {})).toBe(0);
    expect(opened).toEqual([':memory:']);
    expect(snapshotMock.configs.at(-1)).toEqual(emptyConfig());
    expect(ctx.out.text).toContain('not found');

    const jctx = fakeContext();
    jctx.openDb = () => ({ close() {} }) as never;
    expect(await statusCommand(jctx, { json: true })).toBe(0);
    const json = JSON.parse(jctx.out.text);
    expect(json.configState).toBe('missing');
    expect(json.snapshot.counts.queued).toBe(0);
  });
});

describe('renderStatus: the revision loop', () => {
  const revision = (over: Partial<Revision> = {}): Revision => ({
    runId: 'run_r1',
    jobId: 'job_r1',
    repoId: 1,
    repoFullName: 'o/a',
    issueNumber: 12,
    prNumber: 40,
    reviewId: 'PRR_1',
    trigger: 'changes_requested',
    state: 'published',
    branch: 'updraft/issue-12-job_1',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    pushedAt: 't1',
    moved: false,
    commentId: 5,
    commentUrl: 'https://github.com/o/a/pull/40#issuecomment-5',
    error: null,
    retryable: false,
    attempts: 1,
    leaseExpiresAt: null,
    nextAttemptAt: null,
    createdAt: 't0',
    updatedAt: 't1',
    publishedAt: 't1',
    ...over,
  });

  it('says what each revision run pushed, or why it did not, and how to go on', () => {
    expect(renderRevision(revision())).toBe(`pushed ${'a'.repeat(12)}..${'b'.repeat(12)} to updraft/issue-12-job_1; reply https://github.com/o/a/pull/40#issuecomment-5`);
    expect(renderRevision(revision({ state: 'failed', moved: true, headSha: null, error: 'refs/heads/x is at 123, not at abc' }))).toMatch(
      /^not pushed, the branch moved: refs\/heads\/x is at 123, not at abc — not retried; request changes again/,
    );
    expect(renderRevision(revision({ state: 'failed', retryable: true, nextAttemptAt: 't9', error: 'GitHub is unavailable' }))).toBe(
      'revision push failed (attempt 1; branch pushed): GitHub is unavailable — worker retries at t9, or run "updraft publish run_r1"',
    );
    expect(renderRevision(revision({ state: 'skipped', error: 'the agent made no commits' }))).toBe('not pushed: the agent made no commits');
  });

  it('lists revisions, change requests that were not acted on, and PRs at their limit; marks revision jobs', () => {
    const revisionJob = {
      ...job({ id: 'job_r1', status: 'succeeded', statusReason: null }),
      envelope: { type: 'pull_request.changes_requested', revision: { pullRequest: { number: 40 } } },
    } as unknown as Job;
    const snapshot: StatusSnapshot = {
      ...emptySnapshot(),
      recentJobs: [revisionJob, job()],
      revisions: [revision()],
      reviewRequests: [
        { repoId: 1, reviewId: 'PRR_1', prNumber: 40, reviewer: 'allen', trigger: 'changes_requested', reviewUrl: 'https://github.com/o/a/pull/40#pullrequestreview-1', submittedAt: 't0', state: 'queued', reason: null, jobId: 'job_r1', createdAt: 't0' },
        { repoId: 1, reviewId: 'PRR_2', prNumber: 40, reviewer: 'allen', trigger: 'changes_requested', reviewUrl: null, submittedAt: null, state: 'over-limit', reason: 'pull request #40 already has 3 revision(s)', jobId: null, createdAt: 't2' },
      ],
      limitedPullRequests: [{ repoId: 1, prNumber: 40, limitReachedAt: 't2', limitCommentUrl: null, limitCommentError: 'GitHub 502' } as never],
    };
    const config = configSchema.parse(upsertRepoWorkflow(seedConfig('me'), { id: 1, fullName: 'o/a' }, buildWorkflow({ label: 'go', action: 'implement-issue', pool: 'general' })).config);
    const text = renderStatus(buildStatusView({ configPath: '/c', configState: 'ok', configMessage: null, config, dbFile: '/d', dbExists: true, snapshot }));
    expect(text).toContain('job_r1  succeeded    o/a#12 (revision of PR #40)');
    expect(text).toContain('job_1  failed       o/a#12  implement-issue');
    expect(text).toContain('Revisions:\n  run_r1  published   o/a PR #40  updraft/issue-12-job_1  updated t1\n    pushed ');
    expect(text).toContain('Change requests:\n  o/a PR #40  queued      https://github.com/o/a/pull/40#pullrequestreview-1\n    by allen at t0: revision job job_r1');
    expect(text).toContain('  o/a PR #40  over-limit  PRR_2\n    by allen: not acted on — pull request #40 already has 3 revision(s)');
    expect(text).toContain('o/a PR #40 reached maxRevisions at t2; comment: not posted yet: GitHub 502');
  });
});
