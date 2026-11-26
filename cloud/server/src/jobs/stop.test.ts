import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore, type Job } from '../store/store.js';
import { createJobStopper, resumeJobPause, workflowIsPaused } from './stop.js';
import { createReconciler } from './reconcile.js';
import { createWorkflowRecorder } from '../workflows/recorder.js';
import { createMemoryWorkflowStore } from '../workflows/store.js';

describe('durable job cancellation', () => {
  let store: ReturnType<typeof createMemoryStore>;
  let job: Job;
  let clock: number;
  let state: string | null;
  const terminate = vi.fn();
  let stop: ReturnType<typeof createJobStopper>;
  beforeEach(async () => {
    clock = Date.now(); state = 'RUNNING'; terminate.mockReset().mockResolvedValue(undefined);
    store = createMemoryStore();
    const reservation = await store.reserveJob({ installationId: 55, jobId: 'job_stop0001', holdUntil: clock + 3600000,
      day: '2026-11-25', month: '2026-11', quotas: { concurrentJobs: 10, jobsPerDay: 100, microvmMinutesPerMonth: 100000, platformConcurrentJobs: 10 } });
    if (!reservation.ok) throw new Error('fixture reservation failed');
    job = { jobId: 'job_stop0001', installationId: 55, repositoryId: 9, repository: 'acme/web', issue: 12,
      tokenHash: 'hash', configVersion: 1, eventName: 'issues', deliveryId: 'delivery-1', status: 'launched',
      createdAt: new Date(clock).toISOString(), expiresAt: clock + 3600000,
      tenantSlot: reservation.tenantSlot, platformSlot: reservation.platformSlot, reservedSeconds: 3600 };
    await store.putJob(job);
    stop = createJobStopper({ store, terminateMicrovm: terminate, microvmState: async () => state, now: () => clock, log: () => {} });
  });
  async function running() { await store.markLaunching(job.jobId); await store.attachMicrovm(job.jobId, 'mvm-exact'); }
  const request = () => stop.request(55, job.jobId, 'pat', 'Agent is off course');

  it('fences first, targets the recorded VM, and holds capacity until confirmed terminated', async () => {
    await running();
    terminate.mockImplementation(async (id) => {
      expect(id).toBe('mvm-exact');
      expect((await store.getJob(job.jobId))?.stopRequestedAt).toBe(clock);
      expect(await store.getWorkflowPause(55, 9, 12)).toMatchObject({ jobId: job.jobId });
      expect(await store.startJob(job, job.expiresAt)).toEqual({ result: 'retired' });
    });
    expect(await request()).toMatchObject({ state: 'stopping' });
    expect(await store.listActiveJobs()).toHaveLength(1);
    expect((await store.getJobSummary(55, job.jobId))?.status).toBe('launched');
    state = 'TERMINATING'; expect(await request()).toMatchObject({ state: 'stopping' });
    state = 'TERMINATED'; clock += 2000;
    expect(await request()).toMatchObject({ state: 'canceled', stop: { requestedAt: clock - 2000, confirmedAt: clock, by: 'pat' } });
    expect(await store.listActiveJobs()).toHaveLength(0);
    expect((await store.getJobSummary(55, job.jobId))?.stop?.confirmedAt).toBe(clock);
  });
  it('shows the stop on the job\'s workflow at once, and keeps it paused through the confirmed cancel', async () => {
    const workflowStore = createMemoryWorkflowStore();
    const workflows = createWorkflowRecorder({ store: workflowStore, now: () => clock, log: () => {} });
    await workflows.started(job);
    const stopper = createJobStopper({ store, workflows, terminateMicrovm: terminate, microvmState: async () => state, now: () => clock, log: () => {} });
    await running();
    state = 'TERMINATED';
    expect(await stopper.request(55, job.jobId, 'pat', 'Agent is off course')).toMatchObject({ state: 'canceled' });
    const events = await workflowStore.listWorkflowEvents(55, '9-i12', 10);
    expect(events.map((e) => e.kind)).toEqual(['job_started', 'control', 'job_finished']);
    expect(events[1]).toMatchObject({ control: { action: 'stop_requested', by: 'pat', reason: 'Agent is off course' } });
    expect(await workflowStore.getWorkflow(55, '9-i12')).toMatchObject({ reason: 'workflow_paused', controlPause: { jobId: job.jobId, at: clock, previous: { reason: 'job_canceled' } } });
  });
  it('cancels a reserved job without launching, and fences a late markLaunching', async () => {
    expect(await request()).toMatchObject({ state: 'canceled' });
    expect(terminate).not.toHaveBeenCalled();
    await expect(store.markLaunching(job.jobId)).rejects.toThrow();
    expect(await store.listActiveJobs()).toHaveLength(0);
  });
  it('waits for an in-flight VM registration, then terminates that exact VM', async () => {
    await store.markLaunching(job.jobId);
    expect(await request()).toMatchObject({ state: 'stopping' });
    expect(terminate).not.toHaveBeenCalled(); expect(await store.listActiveJobs()).toHaveLength(1);
    await store.attachMicrovm(job.jobId, 'mvm-exact');
    await stop.advance(job); expect(terminate).toHaveBeenCalledWith('mvm-exact');
    state = null; expect(await stop.advance(job)).toMatchObject({ state: 'canceled' });
  });
  it('retains an ambiguous launch until its maximum lifetime, without refunding early', async () => {
    await store.markLaunching(job.jobId); await request(); clock = job.expiresAt;
    expect(await stop.advance(job)).toMatchObject({ state: 'stopping' });
    clock++; expect(await stop.advance(job)).toMatchObject({ state: 'canceled' });
    expect(terminate).not.toHaveBeenCalled(); expect(await store.listActiveJobs()).toHaveLength(0);
  });
  it('keeps the first actor/reason through duplicate requests and confirms only once', async () => {
    await running();
    await Promise.all([request(), stop.request(55, job.jobId, 'other-owner', 'duplicate')]);
    state = 'TERMINATED'; await request(); const first = await store.getJobSummary(55, job.jobId);
    clock++; await request(); expect(await store.getJobSummary(55, job.jobId)).toEqual(first);
    expect(first?.stop).toMatchObject({ by: 'pat', reason: 'Agent is off course' });
  });
  it('does not terminate an execution already confirmed retired', async () => {
    await running(); await store.finishJob(job.jobId, 'succeeded'); await store.releaseJob((await store.getJob(job.jobId))!);
    expect(await request()).toMatchObject({ state: 'finished' }); expect(terminate).not.toHaveBeenCalled();
    expect(await store.getWorkflowPause(55, 9, 12)).toBeNull();
  });
  it('terminates a finished but still-running VM without rewriting the successful outcome', async () => {
    await running(); await store.finishJob(job.jobId, 'succeeded');
    expect(await request()).toMatchObject({ state: 'stopping', accountingComplete: false });
    expect(terminate).toHaveBeenCalledWith('mvm-exact');
    expect((await store.getJob(job.jobId))?.outcome).toBe('succeeded');
    state = 'TERMINATED';
    expect(await stop.advance(job)).toMatchObject({ state: 'finished', accountingComplete: true });
    expect((await store.getJob(job.jobId))?.outcome).toBe('succeeded');
    expect(await store.listActiveJobs()).toHaveLength(0);
  });
  it('preserves a natural finish while still retiring the stopped execution', async () => {
    await running(); await request(); await store.finishJob(job.jobId, 'succeeded'); state = 'TERMINATED';
    expect(await stop.advance(job)).toMatchObject({ state: 'finished', stop: { confirmedAt: clock } });
    expect((await store.getJob(job.jobId))?.outcome).toBe('succeeded');
  });
  it('retries failed termination in background and exposes a durable error', async () => {
    await running(); terminate.mockRejectedValueOnce(new Error('AWS failure'));
    expect(await request()).toMatchObject({ state: 'stopping', stop: { error: expect.stringContaining('retry is safe') } });
    expect(await store.listActiveJobs()).toHaveLength(1);
    state = 'TERMINATED';
    const reconcile = createReconciler({ store, stop, microvmState: async () => state, now: () => clock, log: () => {} });
    expect(await reconcile()).toMatchObject({ released: [job.jobId], failed: 0 });
    expect((await store.getJob(job.jobId))?.stop?.error).toBe('');
  });
  it('retains recovery work if writing confirmation or releasing accounting fails', async () => {
    await running(); state = 'TERMINATED';
    const record = store.recordJobStop;
    store.recordJobStop = vi.fn().mockRejectedValueOnce(new Error('table unavailable')).mockImplementation(record);
    expect(await request()).toMatchObject({ state: 'stopping' });
    expect(await store.listActiveJobs()).toHaveLength(1);
    const release = store.releaseJob;
    store.releaseJob = vi.fn().mockRejectedValueOnce(new Error('release unavailable')).mockImplementation(release);
    expect(await stop.advance(job)).toMatchObject({ state: 'canceled' });
    expect(await store.listActiveJobs()).toHaveLength(1);
    await stop.advance(job); expect(await store.listActiveJobs()).toHaveLength(0);
  });
  it('reports cleanup failure separately from confirmed cancellation and retries it in background', async () => {
    await running(); state = 'TERMINATED';
    const release = store.releaseJob;
    store.releaseJob = vi.fn().mockRejectedValueOnce(new Error('accounting unavailable')).mockImplementation(release);
    await store.requestJobStop(job, { requestedAt: clock, by: 'pat', reason: 'stop' }, [12]);
    const reconcile = createReconciler({ store, stop, microvmState: async () => state, now: () => clock, log: () => {} });
    expect(await reconcile()).toEqual({ released: [], held: 1, failed: 1 });
    expect((await store.getJob(job.jobId))?.stop).toMatchObject({ confirmedAt: clock, error: expect.stringContaining('capacity cleanup failed') });
    expect(await store.listActiveJobs()).toHaveLength(1);
    expect(await reconcile()).toEqual({ released: [job.jobId], held: 0, failed: 0 });
    expect((await store.getJob(job.jobId))?.stop?.error).toBe('');
    expect(await store.listActiveJobs()).toHaveLength(0);
  });
  it('retains the returned VM identity when registration and its first termination fail', async () => {
    await store.markLaunching(job.jobId);
    terminate.mockRejectedValueOnce(new Error('AWS transient failure'));
    expect(await stop.advance(job, 'mvm-returned')).toMatchObject({ state: 'stopping', accountingComplete: false });
    expect((await store.getJob(job.jobId))?.stop?.executionMicrovmId).toBe('mvm-returned');
    expect((await store.getJob(job.jobId))?.microvmId).toBeUndefined();
    state = 'TERMINATED';
    expect(await stop.advance(job)).toMatchObject({ state: 'canceled', accountingComplete: true });
    expect(await store.listActiveJobs()).toHaveLength(0);
  });
  it('terminates the trusted returned VM even while both retirement metadata writes are unavailable', async () => {
    await store.markLaunching(job.jobId);
    store.requestJobStop = vi.fn().mockRejectedValue(new Error('table unavailable'));
    await expect(stop.advance(job, 'mvm-returned')).rejects.toThrow('table unavailable');
    expect(terminate).toHaveBeenCalledWith('mvm-returned');
    expect(await store.listActiveJobs()).toHaveLength(1);
  });
  it('never touches another installation and keeps automatic continuation paused', async () => {
    await running(); expect(await stop.request(66, job.jobId, 'outsider', '')).toBeNull(); expect(terminate).not.toHaveBeenCalled();
    await request();
    expect(await workflowIsPaused(store, job)).toBe(true);
    expect(await workflowIsPaused(store, { ...job, resumeOf: job.jobId })).toBe(false);
    expect(await workflowIsPaused(store, { ...job, issue: 99 })).toBe(false);
    state = 'TERMINATED'; await stop.advance(job);
    // The pause itself now says its execution ended, so it can be resumed after the job's records go.
    expect((await store.getWorkflowPause(55, 9, 12))?.confirmedAt).toEqual(expect.any(Number));
    expect(await resumeJobPause(store, (await store.getJob(job.jobId)) as never, [12], 'pat', clock)).toBe('resumed');
    expect(await workflowIsPaused(store, job)).toBe(false);
  });
  it('cannot resume through a newer stop on another attempt of the workflow', async () => {
    await request();
    const newer = { ...job, jobId: 'job_newer0001' }; await store.putJob(newer);
    await store.requestJobStop(newer, { requestedAt: ++clock, by: 'other-owner', reason: 'new stop' }, [12]);
    expect(await resumeJobPause(store, (await store.getJob(job.jobId)) as never, [12], 'pat', clock)).toBe('changed');
    expect(await store.getWorkflowPause(55, 9, 12)).toMatchObject({ jobId: newer.jobId });
    expect((await store.getJob(job.jobId))?.stop?.resumedAt).toBeUndefined();
  });
});
