import { describe, expect, it } from 'vitest';
import { FlowError } from '../flows/github.js';
import { createWorkflowRecorder } from '../workflows/recorder.js';
import { createMemoryWorkflowStore } from '../workflows/store.js';
import { createWorkflowService } from './workflow-service.js';

const caller = { sub: 's' } as never;
const job = { jobId: 'job_issue0001', installationId: 55, repository: 'acme/web', repositoryId: 99, issue: 7, eventName: 'issues', deliveryId: 'd-1' };

describe('the workflow views', () => {
  it('lists workflows and shows one with its timeline, to members only', async () => {
    const store = createMemoryWorkflowStore();
    const recorder = createWorkflowRecorder({ store, log: () => {} });
    await recorder.started(job);
    await recorder.finished(job, 'failed');
    const members: number[] = [];
    const service = createWorkflowService({
      store,
      github: {
        member: async (_c, id) => {
          if (id !== 55) throw new FlowError('not_authorized', 403, 'not a member');
          members.push(id);
          return {} as never;
        },
      },
    });
    const { workflows } = await service.list(caller, 55);
    expect(workflows).toEqual([expect.objectContaining({ workflowId: '99-i7', status: 'blocked', reason: 'job_failed' })]);
    expect(workflows[0]).not.toHaveProperty('version');
    const one = await service.get(caller, 55, '99-i7');
    expect(one.events.map((e) => e.kind)).toEqual(['job_started', 'job_finished']);
    expect(await service.ofJob(caller, 55, 'job_issue0001')).toEqual({ workflowId: '99-i7' });
    await expect(service.get(caller, 55, '../x')).rejects.toMatchObject({ status: 404 });
    await expect(service.get(caller, 55, '99-i8')).rejects.toMatchObject({ status: 404 });
    await expect(service.list(caller, 66)).rejects.toMatchObject({ status: 403 });
    expect(members.every((m) => m === 55)).toBe(true);
  });

  it('filters the list, adds totals, and shows workflows rebuilt from older job records', async () => {
    const store = createMemoryWorkflowStore();
    const recorder = createWorkflowRecorder({ store, log: () => {} });
    await recorder.started(job);
    await recorder.started({ ...job, jobId: 'job_other001', repository: 'acme/api', repositoryId: 98, issue: 3 });
    const jobs = {
      listRecentJobs: async () => [
        { jobId: 'job_old00001', repository: 'acme/web', issue: 5, createdAt: '2026-11-01T00:00:00.000Z', finishedAt: '2026-11-01T00:10:00.000Z', status: 'finished', outcome: 'succeeded', deliveryId: 'd-0' },
        // The recorded workflow's own job: not rebuilt.
        { jobId: 'job_issue0001', repository: 'acme/web', issue: 7, createdAt: '2026-11-25T00:00:00.000Z', status: 'launched', deliveryId: 'd-1' },
      ] as never,
    };
    const service = createWorkflowService({ store, jobs, github: { member: async () => ({}) as never } });
    const all = (await service.list(caller, 55)).workflows;
    expect(all.map((w) => [w.repository, w.issue, w.reconstructed ?? false])).toEqual(expect.arrayContaining([
      ['acme/web', 7, false],
      ['acme/api', 3, false],
      ['acme/web', 5, true],
    ]));
    expect(all).toHaveLength(3);
    expect((await service.list(caller, 55, undefined, { repository: 'ACME/api' })).workflows.map((w) => w.issue)).toEqual([3]);
    expect((await service.list(caller, 55, undefined, { status: 'finished' })).workflows.map((w) => w.issue)).toEqual([5]);
    const legacy = all.find((w) => w.reconstructed)!;
    const one = await service.get(caller, 55, legacy.workflowId);
    expect(one.workflow).toMatchObject({ reconstructed: true, status: 'finished' });
    expect(one.totals).toMatchObject({ jobs: 1, activeSeconds: 600 });
    expect((await service.get(caller, 55, '99-i7')).totals).toMatchObject({ jobs: 1, running: true });
  });

  it('shows the pause holding the workflow, even with no job record left, and offers resume to owners only', async () => {
    const store = createMemoryWorkflowStore();
    const recorder = createWorkflowRecorder({ store, log: () => {} });
    await recorder.started(job);
    await recorder.finished(job, 'canceled', { prNumber: 12 });
    const pause = { jobId: 'job_issue0001', at: 1_000, by: 'pat', subjects: [7, 12], confirmedAt: 2_000 };
    const pauses = { getWorkflowPause: async (_i: number, _r: number, n: number) => (n === 12 ? pause : null) };
    const as = (role: string) => createWorkflowService({ store, pauses, github: { member: async () => ({ summary: { role } }) as never } });
    expect((await as('owner').get(caller, 55, '99-i7')).pause).toEqual({ ...pause, canResume: true });
    expect((await as('editor').get(caller, 55, '99-i7')).pause).toEqual({ ...pause, canResume: false });
    const none = createWorkflowService({ store, pauses: { getWorkflowPause: async () => null }, github: { member: async () => ({ summary: { role: 'owner' } }) as never } });
    expect(await none.get(caller, 55, '99-i7')).not.toHaveProperty('pause');
  });
});
