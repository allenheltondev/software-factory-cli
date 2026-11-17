import { describe, expect, it, vi } from 'vitest';
import type { StatusSnapshot } from '../db/queue.js';
import type { Job } from '../types.js';
import { buildWorkflow, seedConfig, upsertRepoWorkflow } from './config-edit.js';
import { configSchema } from '../config/schema.js';
import { fakeContext } from './fakes.js';
import { buildStatusView, emptyConfig, renderStatus, statusCommand } from './status.js';

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
    workflowId: 'implement-issue:factory:ready',
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
          run: { id: 'run_1', agent: 'claude', pool: 'general', startedAt: 't2', executionStartedAt: 't2b' } as never,
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
    expect(text).toMatch(/run_1 .*agent claude \(pool general\)  running since t2b/);
    expect(text).toMatch(/run_2 .*agent kiro \(pool general\)  claimed t6, not started yet/);
    expect(text).toContain('job_1  failed       o/a#12');
    expect(text).toContain('— agent exited 1');
    expect(text).toContain('t3  [poll] o/b: GitHub 502 bad gateway');
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

describe('factory status', () => {
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
