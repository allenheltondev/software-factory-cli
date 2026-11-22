import { describe, expect, it, vi } from 'vitest';
import { jobPaths } from '../broker/broker.js';
import { createMemoryStore, type Job } from '../store/store.js';
import type { Launcher, LaunchResult } from './launch.js';
import { createRetryHandler, isRetryRequest, retryDeliveryId } from './retry.js';
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

async function setup({ outcome = 'failed', launched = { status: 202, disposition: 'launched', jobId: 'job_new000001' } as LaunchResult, event = EVENT as string | null } = {}) {
  const store = createMemoryStore();
  const j = job();
  await store.putJob(j);
  if (outcome) await store.finishJob(j.jobId, outcome);
  const launch = vi.fn<Launcher>(async () => launched);
  const readEvent = vi.fn(async () => event);
  const retry = createRetryHandler({ store, launch, readEvent, appBot: async () => 'updraft[bot]', log: () => {} });
  return { store, launch, readEvent, retry, j };
}
const ask = (jobId = 'job_retry00001', installationId = 55) => ({ updraftRetry: { installationId, jobId } });

describe('retrying a job (jobs/retry.ts)', () => {
  it("runs the job's own event again under a delivery of its own", async () => {
    const { retry, launch, readEvent, j } = await setup();
    expect(await retry(ask())).toEqual({ ok: true, jobId: 'job_new000001' });
    expect(readEvent).toHaveBeenCalledWith(jobPaths(j).eventKey);
    expect(launch).toHaveBeenCalledWith({
      installationId: 55,
      deliveryId: retryDeliveryId('job_retry00001'),
      eventName: 'issues',
      appBot: 'updraft[bot]',
      body: EVENT,
      payload: JSON.parse(EVENT),
    });
    // A delivery id is letters, digits and hyphens, at most 64.
    expect(retryDeliveryId('job_a-b_c')).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/);
    expect(retryDeliveryId('job_a')).not.toBe(retryDeliveryId('job_b'));
  });

  it('answers a second retry of the same job with the launcher’s duplicate', async () => {
    const { retry } = await setup({ launched: { status: 200, disposition: 'duplicate' } });
    expect(await retry(ask())).toMatchObject({ ok: false, status: 409, code: 'already_retried' });
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
    expect(retryable(finished('failed', { verificationPassed: false }))).toBe(true);
    expect(retryable(finished('failed', { updraftOutcome: 'publish-failed' }))).toBe(true);
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
  });
});
