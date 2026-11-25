import { describe, expect, it } from 'vitest';
import { createWorkflowRecorder, updateWorkflow } from './recorder.js';
import { createMemoryWorkflowStore } from './store.js';
import { CI_FIRST_CHECK_MS, STALL_CHECK_MS, workflowIdFor } from './workflow.js';

const T0 = Date.parse('2026-11-25T12:00:00.000Z');
const job = (over: Record<string, unknown> = {}) => ({
  jobId: 'job_issue0001',
  installationId: 55,
  repository: 'acme/web',
  repositoryId: 99,
  issue: 7,
  eventName: 'issues',
  deliveryId: 'd-1',
  ...over,
}) as Parameters<ReturnType<typeof createWorkflowRecorder>['started']>[0];

function setup() {
  const store = createMemoryWorkflowStore();
  let clock = T0;
  const recorder = createWorkflowRecorder({ store, now: () => clock, log: () => {} });
  const tick = (ms: number) => (clock += ms);
  const wf = () => store.getWorkflow(55, '99-i7');
  const events = () => store.listWorkflowEvents(55, '99-i7', 100);
  return { store, recorder, tick, wf, events };
}

describe('workflows', () => {
  it('follows an issue from its label through its pull request\'s review loop as one workflow', async () => {
    const s = setup();
    await s.recorder.started(job());
    expect(await s.wf()).toMatchObject({ workflowId: '99-i7', generation: 1, status: 'active', stage: 'implementing', lastJobId: 'job_issue0001' });

    s.tick(60_000);
    await s.recorder.finished(job(), 'succeeded', { prNumber: 12, prUrl: 'https://github.com/acme/web/pull/12', loop: { rounds: 0, reviews: 1, stage: 'changes-requested', verdict: 'changes-requested' } });
    expect(await s.wf()).toMatchObject({ status: 'waiting', stage: 'changes-requested', pullRequest: 12, reason: 'awaiting_event', nextCheckAt: new Date(T0 + 60_000 + STALL_CHECK_MS).toISOString() });

    // The pull request's next job (a review event) belongs to the issue's workflow.
    s.tick(60_000);
    const pr = job({ jobId: 'job_pr000001', issue: undefined, pullRequest: 12, eventName: 'pull_request_review', deliveryId: 'd-2' });
    await s.recorder.started(pr);
    expect(await s.wf()).toMatchObject({ status: 'active', stage: 'reviewing-loop', lastJobId: 'job_pr000001' });
    expect((await s.wf())!.nextCheckAt).toBeUndefined();
    s.tick(60_000);
    await s.recorder.finished(pr, 'succeeded', { prNumber: 12, loop: { rounds: 1, reviews: 2, stage: 'waiting-for-ci', verdict: 'ready-to-merge' } });
    expect(await s.wf()).toMatchObject({ status: 'waiting', stage: 'waiting-for-ci', reason: 'ci_pending', nextCheckAt: new Date(T0 + 180_000 + CI_FIRST_CHECK_MS).toISOString() });

    s.tick(60_000);
    const merge = job({ jobId: 'job_pr000002', issue: undefined, pullRequest: 12, eventName: 'check_suite', deliveryId: 'd-3' });
    await s.recorder.started(merge);
    await s.recorder.finished(merge, 'succeeded', { prNumber: 12, loop: { rounds: 1, reviews: 2, stage: 'merged', merged: true } });
    expect(await s.wf()).toMatchObject({ status: 'finished', stage: 'merged' });
    expect((await s.events()).map((e) => [e.kind, e.jobId, e.stage])).toEqual([
      ['job_started', 'job_issue0001', 'implementing'],
      ['job_finished', 'job_issue0001', 'changes-requested'],
      ['job_started', 'job_pr000001', 'reviewing-loop'],
      ['job_finished', 'job_pr000001', 'waiting-for-ci'],
      ['job_started', 'job_pr000002', 'fixing-ci'],
      ['job_finished', 'job_pr000002', 'merged'],
    ]);
  });

  it('blocks on a failed or lost job with what to do next, and a retry is the same generation', async () => {
    const s = setup();
    await s.recorder.started(job());
    await s.recorder.finished(job(), 'failed');
    expect(await s.wf()).toMatchObject({ status: 'blocked', stage: 'failed', reason: 'job_failed', nextAction: expect.stringMatching(/retry/) });
    await s.recorder.started(job({ jobId: 'job_retry001', deliveryId: 'retry-abc' }));
    expect(await s.wf()).toMatchObject({ generation: 1, status: 'active' });
    expect((await s.wf())!.reason).toBeUndefined();
    await s.recorder.finished(job({ jobId: 'job_retry001', deliveryId: 'retry-abc' }), 'microvm_gone');
    expect(await s.wf()).toMatchObject({ status: 'blocked', reason: 'job_lost' });
    expect((await s.events()).find((e) => e.jobId === 'job_retry001' && e.kind === 'job_started')!.retry).toBe(true);
  });

  it('starts a new generation when the issue is labeled again after it ended', async () => {
    const s = setup();
    await s.recorder.started(job());
    await s.recorder.finished(job(), 'succeeded', {});
    expect(await s.wf()).toMatchObject({ status: 'finished', stage: 'done', generation: 1 });
    await s.recorder.started(job({ jobId: 'job_again001', deliveryId: 'd-9' }));
    expect(await s.wf()).toMatchObject({ status: 'active', generation: 2 });
  });

  it('records each event once, and keeps a late finish of an older job as history only', async () => {
    const s = setup();
    await s.recorder.started(job());
    await s.recorder.started(job());
    expect(await s.events()).toHaveLength(1);
    await s.store.linkPullRequest(55, 99, 12, '99-i7');
    await s.recorder.started(job({ jobId: 'job_newer001', issue: undefined, pullRequest: 12, eventName: 'pull_request_review', deliveryId: 'd-2' }));
    await s.recorder.finished(job(), 'failed');
    expect(await s.wf()).toMatchObject({ status: 'active', lastJobId: 'job_newer001' });
    expect((await s.events()).at(-1)).toMatchObject({ kind: 'job_finished', jobId: 'job_issue0001', message: expect.stringMatching(/later job/) });
  });

  it('gives a pull request it never saw opened a workflow of its own', async () => {
    const s = setup();
    await s.recorder.started(job({ jobId: 'job_orphan01', issue: undefined, pullRequest: 40, eventName: 'pull_request', deliveryId: 'd-4' }));
    expect(await s.store.getWorkflow(55, workflowIdFor(99, { pullRequest: 40 })!)).toMatchObject({ pullRequest: 40, status: 'active' });
  });

  it('retries a save that lost a race, and never overwrites the other writer', async () => {
    const s = setup();
    await s.recorder.started(job());
    let raced = false;
    const out = await updateWorkflow(s.store, 55, '99-i7', (w) => {
      if (!raced) {
        raced = true;
        // Another writer saves in between.
        void s.store.saveWorkflow({ ...w!, message: 'theirs', version: w!.version + 1 }, w);
      }
      return { workflow: { ...w!, nextAction: 'mine' } };
    });
    expect(out).toMatchObject({ message: 'theirs', nextAction: 'mine' });
  });

  it('never fails the launch or the finish it records for', async () => {
    const store = createMemoryWorkflowStore();
    store.getWorkflow = async () => {
      throw new Error('boom');
    };
    const logs: unknown[] = [];
    const recorder = createWorkflowRecorder({ store, log: (e) => logs.push(e) });
    await expect(recorder.started(job())).resolves.toBeUndefined();
    expect(logs).toHaveLength(1);
  });
});
