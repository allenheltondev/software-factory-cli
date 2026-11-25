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

  it('keeps a late finish of an older job as history in every stage, filed under its own run', async () => {
    const s = setup();
    await s.recorder.started(job());
    await s.store.linkPullRequest(55, 99, 12, '99-i7');
    // B starts and finishes into a CI wait.
    const b = job({ jobId: 'job_pr000001', issue: undefined, pullRequest: 12, eventName: 'check_suite', deliveryId: 'd-2' });
    await s.recorder.started(b);
    await s.recorder.finished(b, 'succeeded', { prNumber: 12, loop: { rounds: 1, reviews: 2, stage: 'waiting-for-ci' } });
    // A's finish arrives late (or is replayed): nothing changes.
    await s.recorder.finished(job(), 'failed');
    expect(await s.wf()).toMatchObject({ status: 'waiting', stage: 'waiting-for-ci', lastJobId: 'job_pr000001' });
    expect((await s.events()).find((e) => e.id === 'job_issue0001:finished')).toMatchObject({ generation: 1, message: expect.stringMatching(/history/) });

    // A new run starts; a late finish of the first run's job is filed under run 1, not the new one.
    const c = job({ jobId: 'job_pr000002', issue: undefined, pullRequest: 12, eventName: 'check_suite', deliveryId: 'd-3' });
    await s.recorder.started(c);
    await s.recorder.finished(c, 'succeeded', { prNumber: 12, loop: { rounds: 1, reviews: 2, stage: 'merged' } });
    await s.recorder.started(job({ jobId: 'job_again001', deliveryId: 'd-9' }));
    expect(await s.wf()).toMatchObject({ generation: 2 });
    const late = job({ jobId: 'job_pr000009', issue: undefined, pullRequest: 12, eventName: 'check_suite', deliveryId: 'd-8' });
    await s.recorder.finished(late, 'failed');
    expect(await s.wf()).toMatchObject({ status: 'active', generation: 2, lastJobId: 'job_again001' });
  });

  it('never leaves an event of a change it did not make', async () => {
    const s = setup();
    await s.recorder.started(job());
    let first = true;
    await updateWorkflow(s.store, 55, '99-i7', (w) => {
      if (first) {
        first = false;
        void s.store.saveWorkflow({ ...w!, generation: 2, version: w!.version + 1 }, w);
        return { workflow: { ...w!, status: 'blocked' }, event: { id: 'phantom', at: new Date().toISOString(), kind: 'blocked', generation: 1 } };
      }
      // On the second read the change no longer applies.
      return null;
    });
    expect((await s.events()).some((e) => e.id === 'phantom')).toBe(false);
  });

  describe('replays and runs', () => {
    it('a replayed finish changes nothing, even after a person merged the pull request', async () => {
      const s = setup();
      await s.recorder.started(job());
      await s.recorder.finished(job(), 'succeeded', { prNumber: 12, loop: { rounds: 0, reviews: 1, stage: 'ready-to-merge' } });
      // The reconciler saw the merge.
      await updateWorkflow(s.store, 55, '99-i7', (w) => ({ workflow: { ...w!, status: 'finished', stage: 'merged' }, event: { id: 'pr-merged:12@x', at: new Date().toISOString(), kind: 'finished', generation: 1 } }));
      const before = await s.wf();
      await s.recorder.finished(job(), 'succeeded', { prNumber: 12, loop: { rounds: 0, reviews: 1, stage: 'ready-to-merge' } });
      expect(await s.wf()).toEqual(before);
      expect((await s.events()).filter((e) => e.kind === 'job_finished')).toHaveLength(1);
    });

    it('a first finish of the latest job after the merge was seen is history', async () => {
      const s = setup();
      await s.recorder.started(job());
      await updateWorkflow(s.store, 55, '99-i7', (w) => ({ workflow: { ...w!, pullRequest: 12, status: 'finished', stage: 'merged' } }));
      await s.recorder.finished(job(), 'succeeded', { prNumber: 12, loop: { rounds: 0, reviews: 1, stage: 'changes-requested' } });
      expect(await s.wf()).toMatchObject({ status: 'finished', stage: 'merged' });
      expect((await s.events()).at(-1)).toMatchObject({ kind: 'job_finished', message: expect.stringMatching(/already been merged/) });
    });

    it('a replayed start never makes an older job current again', async () => {
      const s = setup();
      await s.recorder.started(job());
      await s.store.linkPullRequest(55, 99, 12, '99-i7');
      await s.recorder.started(job({ jobId: 'job_newer001', issue: undefined, pullRequest: 12, eventName: 'pull_request_review', deliveryId: 'd-2' }));
      const before = await s.wf();
      await s.recorder.started(job());
      expect(await s.wf()).toEqual(before);
      expect(before).toMatchObject({ lastJobId: 'job_newer001' });
    });

    it('a finish whose start was lost makes that job the latest', async () => {
      const s = setup();
      await s.recorder.started(job({ createdAt: new Date(T0).toISOString() }));
      await s.recorder.finished(job(), 'succeeded', { prNumber: 12, loop: { rounds: 0, reviews: 1, stage: 'changes-requested' } });
      await s.store.linkPullRequest(55, 99, 12, '99-i7');
      const lost = job({ jobId: 'job_lost0001', issue: undefined, pullRequest: 12, eventName: 'pull_request_review', deliveryId: 'd-2', createdAt: new Date(T0 + 60_000).toISOString() });
      await s.recorder.finished(lost, 'succeeded', { prNumber: 12, loop: { rounds: 1, reviews: 2, stage: 'waiting-for-ci' } });
      expect(await s.wf()).toMatchObject({ lastJobId: 'job_lost0001', lastJobAt: new Date(T0 + 60_000).toISOString(), stage: 'waiting-for-ci' });
      expect((await s.wf())!.jobRuns!.at(-1)).toEqual({ jobId: 'job_lost0001', generation: 1 });
    });

    it('a new run starts without the last run\'s pull request, and that pull request\'s events are its history', async () => {
      const s = setup();
      await s.recorder.started(job());
      await s.recorder.finished(job(), 'succeeded', { prNumber: 12, prUrl: 'https://github.com/acme/web/pull/12', loop: { rounds: 0, reviews: 1, stage: 'merged', merged: true } });
      await s.recorder.started(job({ jobId: 'job_again001', deliveryId: 'd-9' }));
      const run2 = await s.wf();
      expect(run2).toMatchObject({ generation: 2, status: 'active', pastPullRequests: [{ number: 12, generation: 1 }] });
      expect(run2!.pullRequest).toBeUndefined();
      expect(run2!.prUrl).toBeUndefined();
      await s.recorder.finished(job({ jobId: 'job_again001', deliveryId: 'd-9' }), 'succeeded', { prNumber: 20, prUrl: 'https://github.com/acme/web/pull/20', loop: { rounds: 0, reviews: 1, stage: 'waiting-for-ci' } });
      expect(await s.wf()).toMatchObject({ pullRequest: 20, prUrl: 'https://github.com/acme/web/pull/20', stage: 'waiting-for-ci' });

      // A delivery for the old pull request #12 (still mapped to this workflow) is run 1's history.
      const old = job({ jobId: 'job_oldpr001', issue: undefined, pullRequest: 12, eventName: 'pull_request', deliveryId: 'd-10' });
      const waiting = await s.wf();
      await s.recorder.started(old);
      await s.recorder.finished(old, 'failed');
      expect(await s.wf()).toMatchObject({ status: 'waiting', stage: 'waiting-for-ci', pullRequest: 20, lastJobId: waiting!.lastJobId, generation: 2 });
      const history = (await s.events()).filter((e) => e.jobId === 'job_oldpr001');
      expect(history.map((e) => [e.kind, e.generation])).toEqual([['job_started', 1], ['job_finished', 1]]);
    });
  });
});
