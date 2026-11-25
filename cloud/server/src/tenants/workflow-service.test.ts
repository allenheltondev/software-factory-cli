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
    const pauses = { getWorkflowPause: async (_i: number, _r: number, n: number) => (n === 12 ? pause : null), listWorkflowPauses: async () => [] };
    const as = (role: string) => createWorkflowService({ store, pauses, github: { member: async () => ({ summary: { role } }) as never } });
    expect((await as('owner').get(caller, 55, '99-i7')).pause).toEqual({ ...pause, subject: 12, canResume: true });
    expect((await as('editor').get(caller, 55, '99-i7')).pause).toEqual({ ...pause, subject: 12, canResume: false });
    const none = createWorkflowService({ store, pauses: { getWorkflowPause: async () => null, listWorkflowPauses: async () => [] }, github: { member: async () => ({ summary: { role: 'owner' } }) as never } });
    expect(await none.get(caller, 55, '99-i7')).not.toHaveProperty('pause');
  });

  it('says how much history is kept, and when the earliest events are past their retention', async () => {
    const store = createMemoryWorkflowStore();
    const created = Date.parse('2026-08-01T00:00:00.000Z');
    let clock = created;
    const recorder = createWorkflowRecorder({ store, now: () => clock, log: () => {} });
    await recorder.started(job);
    clock += 60_000;
    await recorder.finished(job, 'failed');
    const at = (now: number) => createWorkflowService({ store, github: { member: async () => ({}) as never }, now: () => now });
    expect((await at(clock).get(caller, 55, '99-i7')).history).toEqual({ shown: 2, omitted: 0, complete: true, workflowRetentionDays: 90, eventRetentionDays: 90, jobRetentionDays: 30, expiredEarlier: false });
    expect((await at(created + 100 * 86_400_000).get(caller, 55, '99-i7')).history).toMatchObject({ expiredEarlier: true });
  });

  it('marks paused workflows, filters by them, and finds a paused workflow past the list\'s limit by its own record', async () => {
    const store = createMemoryWorkflowStore();
    const recorder = createWorkflowRecorder({ store, log: () => {} });
    await recorder.started(job);
    await recorder.finished(job, 'canceled');
    const other = { ...job, jobId: 'job_other001', issue: 8 };
    await recorder.started(other);
    const held = [{ jobId: 'job_issue0001', at: 1_000, by: 'pat', repositoryId: 99, subject: 7 }];
    const pauses = { getWorkflowPause: async (_i: number, _r: number, n: number) => (n === 7 ? held[0]! : null), listWorkflowPauses: async () => held };
    const service = createWorkflowService({ store, pauses, github: { member: async () => ({ summary: { role: 'owner' } }) as never } });
    const { workflows } = await service.list(caller, 55);
    expect(workflows.find((w) => w.issue === 7)).toMatchObject({ paused: true });
    expect(workflows.find((w) => w.issue === 8)).not.toHaveProperty('paused');
    expect((await service.list(caller, 55, undefined, { status: 'paused' })).workflows.map((w) => w.issue)).toEqual([7]);
    expect((await service.get(caller, 55, '99-i7')).workflow).toMatchObject({ paused: true });

    // Older than the newest the list reads: still found, with its own record (not rebuilt from the pause).
    const limited = { ...store, listWorkflows: async () => (await store.listWorkflows(55, 10)).filter((w) => w.issue !== 7) };
    const past = createWorkflowService({ store: limited, pauses, github: { member: async () => ({ summary: { role: 'owner' } }) as never } });
    const found = (await past.list(caller, 55)).workflows.find((w) => w.issue === 7)!;
    expect(found).toMatchObject({ workflowId: '99-i7', paused: true, reason: 'job_canceled', createdAt: expect.any(String) });
    expect(found.gaps).toBeUndefined();
  });

  it('says what a workflow rebuilt from job records, or from its pause alone, cannot show', async () => {
    const store = createMemoryWorkflowStore();
    const jobs = { listRecentJobs: async () => [{ jobId: 'job_old00001', repository: 'acme/web', issue: 5, createdAt: '2026-11-01T00:00:00.000Z', status: 'launched', deliveryId: 'd-0' }] as never };
    const held = [{ jobId: 'job_gone0001', at: Date.parse('2026-01-01T00:00:00.000Z'), by: 'pat', repositoryId: 99, subject: 9, issue: 9, repository: 'acme/web' }];
    const service = createWorkflowService({ store, jobs, pauses: { getWorkflowPause: async () => null, listWorkflowPauses: async () => held }, github: { member: async () => ({ summary: { role: 'owner' } }) as never } });
    const legacy = (await service.list(caller, 55)).workflows.find((w) => w.reconstructed)!;
    expect((await service.get(caller, 55, legacy.workflowId)).history).toMatchObject({ complete: false });
    const gone = await service.get(caller, 55, '99-i9');
    expect(gone.workflow).toMatchObject({ paused: true, reason: 'workflow_paused' });
    expect(gone.history).toMatchObject({ shown: 0, complete: false, expiredEarlier: true });
  });
});
