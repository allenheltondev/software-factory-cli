import { describe, expect, it, vi } from 'vitest';
import { jobPaths } from '../broker/broker.js';
import { createMemoryStore, type Job } from '../store/store.js';
import type { Launcher, LaunchResult } from './launch.js';
import { createRetryHandler, isRetryRequest, RESERVATION_MS, retryDeliveryId } from './retry.js';
import { retryable } from './status.js';

const EVENT = JSON.stringify({ action: 'labeled', label: { name: 'updraft' }, issue: { number: 12 }, repository: { id: 9, full_name: 'acme/web' }, sender: { login: 'pat' } });
const job = (over: Partial<Job> = {}): Job => ({
  jobId: 'job_retry00001',
  tokenHash: 'ab',
  installationId: 55,
  repository: 'acme/web',
  repositoryId: 9,
  configVersion: 2,
  deliveryId: 'd-1',
  eventName: 'issues',
  status: 'launched',
  createdAt: '2026-11-20T12:00:00.000Z',
  expiresAt: Date.now() + 3_600_000,
  issue: 12,
  ...over,
});

async function setup({ outcome = 'failed', launched = { status: 202, disposition: 'launched', jobId: 'job_new000001' } as LaunchResult, event = EVENT as string | null, jobOver = {} as Partial<Job> } = {}) {
  const store = createMemoryStore();
  const j = job(jobOver);
  await store.putJob(j);
  if (outcome) await store.finishJob(j.jobId, outcome);
  const launch = vi.fn<Launcher>(async () => launched);
  const readEvent = vi.fn(async () => event);
  const clock = { now: 1_000_000 };
  const retry = createRetryHandler({ store, launch, readEvent, appBot: async () => 'updraft[bot]', now: () => clock.now, log: () => {} });
  return { store, launch, readEvent, retry, j, clock };
}
/** A child job as a launch leaves it: its record, its reservation, and (when asked) the mark that RunMicrovm is next. */
async function child(store: Awaited<ReturnType<typeof setup>>['store'], id: string, deliveryId: string, { launching = true } = {}) {
  await store.putJob(job({ jobId: id, deliveryId }));
  const r = await store.reserveJob({ installationId: 55, jobId: id, holdUntil: Date.now() + 1e7, day: '2026-11-22', month: '2026-11', quotas: { concurrentJobs: 50, jobsPerDay: 500, microvmMinutesPerMonth: 6000, platformConcurrentJobs: 50 } });
  if (!r.ok) throw new Error(r.limit);
  if (launching) await store.markLaunching(id);
  return r;
}
const ask = (jobId = 'job_retry00001', installationId = 55) => ({ updraftRetry: { installationId, jobId } });

describe('retrying a job (jobs/retry.ts)', () => {
  it("runs the job's own event again under a delivery of its own", async () => {
    const { retry, launch, readEvent, j, store } = await setup();
    expect(await retry(ask())).toEqual({ ok: true, jobId: 'job_new000001' });
    expect(readEvent).toHaveBeenCalledWith(jobPaths(j).eventKey);
    expect(launch).toHaveBeenCalledWith({
      installationId: 55,
      deliveryId: retryDeliveryId('job_retry00001'),
      eventName: 'issues',
      appBot: 'updraft[bot]',
      body: EVENT,
      payload: JSON.parse(EVENT),
      // The id it was recorded under before the launch.
      jobId: expect.stringMatching(/^job_[A-Za-z0-9_-]{16}$/),
      // The job requeues the event's failed job in the shared state before it runs.
      retry: true,
      retryRuntime: {},
    });
    // The retry is on the original job: it is not offered again.
    expect((await store.getJobSummary(55, j.jobId))?.retriedAs).toBe('job_new000001');
    // A delivery id is letters, digits and hyphens, at most 64.
    expect(retryDeliveryId('job_a-b_c')).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/);
    expect(retryDeliveryId('job_a')).not.toBe(retryDeliveryId('job_b'));
  });

  it('answers a second retry of the same job from its record, with no launch, however long ago the first one’s claim ended', async () => {
    const { retry, launch } = await setup();
    expect(await retry(ask())).toMatchObject({ ok: true });
    // The launcher's claim is gone by now (a failed retry gives it up; a finished one's lapses): only the record stops it.
    expect(await retry(ask())).toMatchObject({ ok: false, status: 409, code: 'already_retried' });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('lets only one of two overlapping requests launch, and the other is told it is being retried', async () => {
    const { retry, launch, store, j } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    launch.mockImplementationOnce(async () => {
      await gate;
      return { status: 202, disposition: 'launched', jobId: 'job_new000001' };
    });
    const first = retry(ask());
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    // Both read the summary before either recorded anything; the claim is what stops the second.
    expect(await retry(ask())).toMatchObject({ ok: false, status: 409, code: 'already_retried' });
    expect(launch).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toEqual({ ok: true, jobId: 'job_new000001' });
    expect((await store.getJobSummary(55, j.jobId))?.retriedAs).toBe('job_new000001');
  });

  it('gives the claim back when the launch throws, so it can be asked for again', async () => {
    const { retry, launch } = await setup();
    launch.mockRejectedValueOnce(new Error('boom'));
    expect(await retry(ask())).toMatchObject({ ok: false, status: 500 });
    expect(await retry(ask())).toMatchObject({ ok: true });
  });

  it('takes the claim over once a request that died holding it has run out its time, and not before', async () => {
    const { retry, launch, store, j, clock } = await setup();
    // A Lambda that reserved the retry and never finished.
    expect(await store.reserveJobRetry(j, 'dead-request', clock.now, clock.now + RESERVATION_MS, 'job_never0000000001')).toBe(true);
    clock.now += RESERVATION_MS - 1;
    expect(await retry(ask())).toMatchObject({ ok: false, status: 409, code: 'already_retried' });
    expect(launch).not.toHaveBeenCalled();
    clock.now += 2;
    expect(await retry(ask())).toMatchObject({ ok: true });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('still answers ok when a job started but the record of it could not be written, and says so in the log', async () => {
    const { store, launch, j } = await setup();
    const log = vi.fn();
    const flaky = { ...store, markJobRetried: vi.fn(async () => { throw new Error('throttled'); }) } as typeof store;
    const retry = createRetryHandler({ store: flaky, launch, readEvent: async () => EVENT, log });
    expect(await retry(ask())).toEqual({ ok: true, jobId: 'job_new000001' });
    expect(flaky.markJobRetried).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ jobId: j.jobId, warning: expect.stringContaining('not on record') }));
  });

  it('refuses a job that failed in publishing, with what to do instead', async () => {
    const { store, launch } = await setup({ outcome: '' });
    const failed = job({ jobId: 'job_publish0001', deliveryId: 'd-pub' });
    await store.putJob(failed);
    await store.finishJob(failed.jobId, 'failed', { at: Date.now(), detail: { updraftOutcome: 'publish-failed' } });
    const retry = createRetryHandler({ store, launch, readEvent: async () => EVENT, log: () => {} });
    expect(await retry(ask('job_publish0001'))).toMatchObject({ ok: false, status: 409, code: 'not_retryable', message: expect.stringContaining('only publishing it failed') });
    expect(launch).not.toHaveBeenCalled();
  });

  describe('when a request never said how its launch ended', () => {
    /** A retry whose job started but whose record failed to be written, and the clock past its claim. */
    async function unrecorded() {
      const { store, launch, j, clock } = await setup();
      const flaky = { ...store, markJobRetried: vi.fn(async () => { throw new Error('throttled'); }) } as typeof store;
      const first = createRetryHandler({ store: flaky, launch, readEvent: async () => EVENT, now: () => clock.now, log: () => {} });
      const out = await first(ask());
      expect(out).toMatchObject({ ok: true });
      // The microVM was accepted: its job is on record under the id the claim kept.
      const id = (launch.mock.calls[0]![0] as { jobId: string }).jobId;
      await child(store, id, retryDeliveryId(j.jobId));
      const next = createRetryHandler({ store, launch, readEvent: async () => EVENT, now: () => clock.now, log: () => {} });
      return { store, launch, j, clock, child: id, next };
    }

    it('records the job it started instead of launching another, once the claim has run out', async () => {
      const { store, launch, j, clock, child, next } = await unrecorded();
      // Still held: nobody takes it.
      expect(await next(ask())).toMatchObject({ ok: false, status: 409, code: 'already_retried' });
      clock.now += RESERVATION_MS + 1;
      expect(await next(ask())).toEqual({ ok: true, jobId: child });
      expect(launch).toHaveBeenCalledTimes(1);
      expect((await store.getJobSummary(55, j.jobId))?.retriedAs).toBe(child);
      // And now it is on record: a further request is refused.
      expect(await next(ask())).toMatchObject({ ok: false, status: 409, code: 'already_retried' });
    });

    it('waits while the earlier attempt’s job may not have reached launch, and records it once it did', async () => {
      const { store, launch, j, clock } = await setup();
      const id = 'job_prelaunch0000001';
      // The record is written, and the reservation is not yet marked launching: the launch may have died here.
      await child(store, id, retryDeliveryId(j.jobId), { launching: false });
      expect(await store.reserveJobRetry(j, 'dead', clock.now, clock.now + RESERVATION_MS, id)).toBe(true);
      clock.now += RESERVATION_MS + 1;
      const next = createRetryHandler({ store, launch, readEvent: async () => EVENT, now: () => clock.now, log: () => {} });
      expect(await next(ask())).toMatchObject({ ok: false, status: 409, code: 'retry_pending' });
      expect((await store.getJobSummary(55, j.jobId))?.retriedAs).toBeUndefined();
      expect(launch).not.toHaveBeenCalled();
      // The launch got as far as RunMicrovm after all.
      await store.markLaunching(id);
      expect(await next(ask())).toEqual({ ok: true, jobId: id });
      expect(launch).not.toHaveBeenCalled();
    });

    it('launches afresh when the reconciler has taken the reservation but not yet failed the child (nothing was asked for)', async () => {
      const { store, launch, j, clock } = await setup();
      const id = 'job_reclaimed0000001';
      const r = await child(store, id, retryDeliveryId(j.jobId), { launching: false });
      // Reconciliation deletes the reservation first, and writes launch_failed to the job after.
      expect(await store.cancelReservation({ installationId: 55, jobId: id, tenantSlot: r.tenantSlot, platformSlot: r.platformSlot, day: '2026-11-22', month: '2026-11' }, 'reserved')).toBe('cancelled');
      expect((await store.getJob(id))?.status).toBe('launched');
      expect(await store.reserveJobRetry(j, 'dead', clock.now, clock.now + RESERVATION_MS, id)).toBe(true);
      clock.now += RESERVATION_MS + 1;
      expect(await createRetryHandler({ store, launch, readEvent: async () => EVENT, now: () => clock.now, log: () => {} })(ask())).toMatchObject({ ok: true });
      expect(launch).toHaveBeenCalledTimes(1);
    });

    it('records a child whose launch was marked even after its reservation is gone', async () => {
      const { store, launch, j, clock } = await setup();
      const id = 'job_launchedgone0001';
      await child(store, id, retryDeliveryId(j.jobId));
      await store.forgetActiveJob((await store.listActiveJobs()).find((a) => a.jobId === id)!);
      expect(await store.reserveJobRetry(j, 'dead', clock.now, clock.now + RESERVATION_MS, id)).toBe(true);
      clock.now += RESERVATION_MS + 1;
      expect(await createRetryHandler({ store, launch, readEvent: async () => EVENT, now: () => clock.now, log: () => {} })(ask())).toEqual({ ok: true, jobId: id });
      expect(launch).not.toHaveBeenCalled();
    });

    it('launches afresh once the reconciler has failed a child that never launched', async () => {
      const { store, launch, j, clock } = await setup();
      const child = 'job_prelaunch0000002';
      await store.putJob(job({ jobId: child, deliveryId: retryDeliveryId(j.jobId) }));
      await store.finishJob(child, 'launch_failed');
      expect(await store.reserveJobRetry(j, 'dead', clock.now, clock.now + RESERVATION_MS, child)).toBe(true);
      clock.now += RESERVATION_MS + 1;
      expect(await createRetryHandler({ store, launch, readEvent: async () => EVENT, now: () => clock.now, log: () => {} })(ask())).toMatchObject({ ok: true });
      expect(launch).toHaveBeenCalledTimes(1);
    });

    it('cannot take a claim over that runs out only after it was seen live, which would lose the child it kept', async () => {
      const { store, launch, j, clock } = await setup();
      const id = 'job_startedchild0001';
      await child(store, id, retryDeliveryId(j.jobId));
      expect(await store.reserveJobRetry(j, 'slow', clock.now, clock.now + 1000, id)).toBe(true);
      // The claim reads as live at this request's time, and runs out just after: the clock moves during the request.
      let calls = 0;
      const ticking = () => (calls++ === 0 ? clock.now + 999 : clock.now + 1001);
      const racing = createRetryHandler({ store, launch, readEvent: async () => EVENT, now: ticking, log: () => {} });
      expect(await racing(ask())).toMatchObject({ ok: false, status: 409, code: 'already_retried' });
      expect(launch).not.toHaveBeenCalled();
      // Nothing was overwritten: the next request settles it from the child the claim kept.
      clock.now += 1001;
      expect(await createRetryHandler({ store, launch, readEvent: async () => EVENT, now: () => clock.now, log: () => {} })(ask())).toEqual({ ok: true, jobId: id });
    });

    it('does not settle a claim another request has taken over since it was seen', async () => {
      const { store, j, clock } = await setup();
      expect(await store.reserveJobRetry(j, 'a', clock.now, clock.now + 1000, 'job_childone00000001')).toBe(true);
      clock.now += 2000;
      // Another request takes it over with a child of its own before this one's settle.
      expect(await store.reserveJobRetry(j, 'b', clock.now, clock.now + 1000, 'job_childtwo00000001')).toBe(true);
      expect(await store.settleJobRetry(j, 'job_childone00000001', clock.now)).toBe(false);
      expect((await store.getJobSummary(55, j.jobId))?.retriedAs).toBeUndefined();
    });

    it('launches again when the earlier attempt never created a job', async () => {
      const { store, launch, j, clock } = await setup();
      // A Lambda that claimed the retry, and died before anything was written for its job.
      expect(await store.reserveJobRetry(j, 'dead', clock.now, clock.now + RESERVATION_MS, 'job_neverwrote00001')).toBe(true);
      clock.now += RESERVATION_MS + 1;
      expect(await createRetryHandler({ store, launch, readEvent: async () => EVENT, now: () => clock.now, log: () => {} })(ask())).toMatchObject({ ok: true });
      expect(launch).toHaveBeenCalledTimes(1);
    });

    it('launches again when the earlier attempt’s job failed to launch', async () => {
      const { store, launch, j, clock } = await setup();
      await store.putJob(job({ jobId: 'job_failedlaunch001', deliveryId: 'd-x' }));
      await store.finishJob('job_failedlaunch001', 'launch_failed');
      expect(await store.reserveJobRetry(j, 'dead', clock.now, clock.now + RESERVATION_MS, 'job_failedlaunch001')).toBe(true);
      clock.now += RESERVATION_MS + 1;
      expect(await createRetryHandler({ store, launch, readEvent: async () => EVENT, now: () => clock.now, log: () => {} })(ask())).toMatchObject({ ok: true });
      expect(launch).toHaveBeenCalledTimes(1);
    });
  });

  it('does not retry a job of a pull request’s review loop, which it would find nothing new for', async () => {
    const { retry, launch, store, j } = await setup({ jobOver: { issue: undefined, pullRequest: 40, eventName: 'pull_request_review' } });
    expect(await retry(ask())).toMatchObject({ ok: false, status: 409, code: 'not_retryable', message: expect.stringContaining('review loop') });
    expect(launch).not.toHaveBeenCalled();
    expect((await store.getJobSummary(55, j.jobId))?.retriedAs).toBeUndefined();
  });

  it('answers the launcher’s duplicate (two requests at once) as already retried', async () => {
    const { retry, store, j } = await setup({ launched: { status: 200, disposition: 'duplicate' } });
    expect(await retry(ask())).toMatchObject({ ok: false, status: 409, code: 'already_retried' });
    // Nothing started, so nothing is recorded.
    expect((await store.getJobSummary(55, j.jobId))?.retriedAs).toBeUndefined();
  });

  it('lets a retry that did not start be tried again', async () => {
    const { retry, launch, store, j } = await setup({ launched: { status: 200, disposition: 'throttled', reason: 'jobs_per_day' } });
    expect(await retry(ask())).toMatchObject({ ok: false, status: 429 });
    expect((await store.getJobSummary(55, j.jobId))?.retriedAs).toBeUndefined();
    launch.mockResolvedValueOnce({ status: 202, disposition: 'launched', jobId: 'job_new000002' });
    expect(await retry(ask())).toEqual({ ok: true, jobId: 'job_new000002' });
    expect((await store.getJobSummary(55, j.jobId))?.retriedAs).toBe('job_new000002');
  });

  it('says the event is gone when the job’s own record has expired (the summary outlives it)', async () => {
    const { store, launch } = await setup();
    const retry = createRetryHandler({ store: { ...store, getJob: async () => null } as typeof store, launch, readEvent: async () => EVENT, log: () => {} });
    expect(await retry(ask())).toMatchObject({ ok: false, status: 410, code: 'event_gone' });
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([
    ['a running job', ''],
    ['a job that succeeded', 'succeeded'],
    ['a run another one beat', 'superseded'],
  ])('does not retry %s', async (_name, outcome) => {
    const { retry, launch } = await setup({ outcome });
    expect(await retry(ask())).toMatchObject({ ok: false, status: 409, code: 'not_retryable' });
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not find another tenant's job, or an unknown one", async () => {
    const { retry, launch } = await setup();
    expect(await retry(ask('job_retry00001', 56))).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    expect(await retry(ask('job_nothere01'))).toMatchObject({ ok: false, status: 404 });
    expect(launch).not.toHaveBeenCalled();
  });

  it('says so when the event is no longer kept, or cannot be read', async () => {
    expect(await (await setup({ event: null })).retry(ask())).toMatchObject({ ok: false, status: 410, code: 'event_gone' });
    expect(await (await setup({ event: 'not json' })).retry(ask())).toMatchObject({ ok: false, status: 410, code: 'event_gone' });
    const { store, launch } = await setup();
    const retry = createRetryHandler({
      store,
      launch,
      readEvent: async () => {
        throw new Error('throttled');
      },
      log: () => {},
    });
    expect(await retry(ask())).toMatchObject({ ok: false, status: 502, code: 'event_unavailable' });
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 200, disposition: 'throttled', reason: 'jobs_per_day' }, 429, 'throttled'],
    [{ status: 200, disposition: 'not_dispatched', message: 'the label no longer starts a job' }, 409, 'not_dispatched'],
    [{ status: 200, disposition: 'missing_key', message: 'ANTHROPIC_API_KEY is not set' }, 409, 'missing_key'],
    [{ status: 200, disposition: 'tenant_inactive' }, 409, 'tenant_inactive'],
    [{ status: 200, disposition: 'kill_switch' }, 503, 'jobs_off'],
    [{ status: 500, disposition: 'launch_failed', errorClass: 'ThrottlingException' }, 500, 'launch_failed'],
  ] as [LaunchResult, number, string][])('reports what the launcher refused (%j)', async (launched, status, code) => {
    const { retry } = await setup({ launched });
    expect(await retry(ask())).toMatchObject({ ok: false, status, code });
  });

  it('answers a launcher that throws without leaking the error', async () => {
    const { retry, launch } = await setup();
    launch.mockRejectedValueOnce(new Error('secret arn:aws:...'));
    const out = await retry(ask());
    expect(out).toMatchObject({ ok: false, status: 500, code: 'launch_failed' });
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('knows a retry request from an API Gateway event', () => {
    expect(isRetryRequest(ask())).toBe(true);
    expect(isRetryRequest({ httpMethod: 'POST', body: '{}' })).toBe(false);
    expect(isRetryRequest({ updraftRetry: { installationId: 'x', jobId: 'j' } })).toBe(false);
    expect(isRetryRequest(null)).toBe(false);
  });
});

describe('which jobs can be retried', () => {
  const finished = (outcome: string, detail: object = {}) => ({ status: 'finished' as const, outcome, detail });
  it('offers it for work that did not finish, and not for the rest', () => {
    expect(retryable(finished('failed'))).toBe(true);
    // Not a pull request's job.
    expect(retryable({ ...finished('failed'), pullRequest: 40 })).toBe(false);
    expect(retryable(finished('failed', { verificationPassed: false }))).toBe(true);
    // Not a publication that failed after the agent succeeded: the CLI's job is succeeded, which --retry skips.
    expect(retryable(finished('failed', { updraftOutcome: 'publish-failed' }))).toBe(false);
    expect(retryable(finished('timed_out'))).toBe(true);
    expect(retryable(finished('microvm_gone'))).toBe(true);
    expect(retryable(finished('runner_error'))).toBe(true);
    expect(retryable(finished('launch_failed'))).toBe(true);
    expect(retryable(finished('throttled'))).toBe(true);
    expect(retryable(finished('succeeded', { updraftOutcome: 'canceled' }))).toBe(true);

    expect(retryable({ status: 'launched' })).toBe(false);
    expect(retryable(finished('succeeded'))).toBe(false);
    expect(retryable(finished('succeeded', { updraftOutcome: 'nothing-to-do' }))).toBe(false);
    expect(retryable(finished('succeeded', { updraftOutcome: 'superseded' }))).toBe(false);
    expect(retryable(finished('superseded'))).toBe(false);
    expect(retryable(finished('failed', { updraftOutcome: 'deferred' }))).toBe(false);
    // One a retry started a job for.
    expect(retryable({ ...finished('failed'), retriedAs: 'job_new000001' })).toBe(false);
  });
});
