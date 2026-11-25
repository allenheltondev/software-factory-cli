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
});
