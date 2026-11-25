import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { Caller } from '../caller.js';
import { FlowError } from '../flows/github.js';
import { createMemoryQueueStore, type QueueEntry } from '../jobs/queue-store.js';
import { createMemoryStore, type Job, type Tenant } from '../store/store.js';
import { createStatusService, type StatusServiceDeps } from './status-service.js';

const caller = { sub: 'u1' } as Caller;
const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const tenant: Tenant = { installationId: 55, accountId: 900, accountLogin: 'acme', accountType: 'Organization', status: 'active', createdAt: '2026-11-19T00:00:00.000Z', createdBy: 's' };
const entry = (jobId: string, over: Partial<QueueEntry> = {}): QueueEntry => ({
  jobId, installationId: 55, repository: 'acme/web', repositoryId: 9, issue: 2, deliveryId: `d-${jobId}`, eventName: 'issues', eventKey: `tenants/55/events/queue/${jobId}/d.json`,
  label: 'updraft', sender: 'pat', route: 'standard', configVersion: 3, reason: 'concurrent_jobs', state: 'queued', enqueuedAt: NOW - 120_000, expiresAt: NOW + 3_600_000,
  attempts: 0, nextAttemptAt: NOW, deliveries: 1, version: 0, ...over,
});

async function setup(role: 'owner' | 'editor' = 'owner', requestQueueCancel?: StatusServiceDeps['requestQueueCancel']) {
  const store = createMemoryStore();
  await store.putTenantWithMember(tenant, { installationId: 55, sub: 'u1', role, githubUserId: 1, githubLogin: 'pat', addedAt: '' });
  const queue = createMemoryQueueStore();
  const member = async (_c: Caller, id: number) => {
    if (id !== 55) throw new FlowError('not_authorized', 403, 'You are not a member of that installation');
    return { tenant, summary: { installationId: 55, accountLogin: 'acme', accountType: 'Organization', status: 'active' as const, role }, githubLogin: 'Pat' };
  };
  const service = createStatusService({
    store,
    queue,
    ...(requestQueueCancel ? { requestQueueCancel } : {}),
    now: () => NOW,
    github: { member, installation: async () => null, repositories: async () => ({ tenant: {} as never, repositories: [] }) },
    agentKeys: { list: async () => ({ keys: [], refusals: [] }) },
    log: () => {},
  });
  const app = createApp({ resolveCaller: () => caller, status: service, logError: () => {} });
  const call = async (path: string, method = 'GET') => {
    const res = await app.request(`/api/v1/installations/${path}`, { method });
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, cache: res.headers.get('cache-control') };
  };
  return { store, queue, call };
}

describe('queued jobs in the console', () => {
  it('lists waiting work first, as queued (never running), in the order it starts, with why it waits', async () => {
    const { store, queue, call } = await setup();
    await queue.enqueue(entry('job_queued00000002', { issue: 3, enqueuedAt: NOW - 60_000 }), 25);
    await queue.enqueue(entry('job_queued00000001'), 25);
    const running: Job = { jobId: 'job_running0000001', tokenHash: 'x', installationId: 55, repository: 'acme/web', repositoryId: 9, configVersion: 3, deliveryId: 'd-r', eventName: 'issues', status: 'launched', createdAt: new Date(NOW - 600_000).toISOString(), expiresAt: NOW + 3_600_000, issue: 1 };
    await store.putJob(running);
    const { status, body, cache } = await call('55/jobs');
    expect(status).toBe(200);
    expect(cache).toBe('no-store');
    const jobs = body.jobs as Record<string, unknown>[];
    expect(jobs.map((j) => [j.jobId, j.status, j.result])).toEqual([
      ['job_queued00000001', 'queued', 'queued'],
      ['job_queued00000002', 'queued', 'queued'],
      ['job_running0000001', 'launched', 'running'],
    ]);
    expect(jobs[0]).toMatchObject({
      issueUrl: 'https://github.com/acme/web/issues/2',
      canCancel: false, // no cancel wired
      queue: { state: 'queued', reason: 'concurrent_jobs', position: 1, waitedSeconds: 120, route: 'standard', waitMessage: "Your account's current execution slot is occupied." },
    });
    // Nothing internal leaves: no event key, no worker id.
    expect(JSON.stringify(body)).not.toContain('events/queue');
  });

  it('serves a queued job at its stable link before it starts, and how long it waited once it has', async () => {
    const { store, queue, call } = await setup();
    await queue.enqueue(entry('job_queued00000001'), 25);
    const before = await call('55/jobs/job_queued00000001');
    expect(before.status).toBe(200);
    expect(before.body.job).toMatchObject({ jobId: 'job_queued00000001', status: 'queued', result: 'queued', queue: { position: 1 } });
    // Admitted: the job's own record is shown, with its queue time beside it.
    const e = (await queue.get(55, 'job_queued00000001'))!;
    await queue.settle({ ...e, state: 'admitted', outcome: { at: NOW - 30_000, reason: 'admitted', message: 'Started.', jobId: e.jobId } }, e);
    await store.putJob({ jobId: 'job_queued00000001', tokenHash: 'x', installationId: 55, repository: 'acme/web', repositoryId: 9, configVersion: 3, deliveryId: e.deliveryId, eventName: 'issues', status: 'launched', createdAt: new Date(NOW - 30_000).toISOString(), expiresAt: NOW + 3_600_000, issue: 2 });
    const after = await call('55/jobs/job_queued00000001');
    expect(after.body.job).toMatchObject({ status: 'launched', result: 'running', queue: { state: 'admitted', waitedSeconds: 90 } });
    expect((after.body.job as { queue: { position?: number } }).queue.position).toBeUndefined();
  });

  it('shows work that ended without starting as canceled or not run, with what to do', async () => {
    const { queue, call } = await setup();
    await queue.enqueue(entry('job_queued00000001'), 25);
    const e = (await queue.get(55, 'job_queued00000001'))!;
    await queue.settle({ ...e, state: 'refused', outcome: { at: NOW, reason: 'jobs_per_day', message: "the account's jobs for today (UTC) are used.", nextAction: 'Apply the label again tomorrow (UTC).' } }, e);
    const { body } = await call('55/queue');
    expect((body.queue as Record<string, unknown>[])[0]).toMatchObject({ status: 'finished', result: 'not_run', outcome: 'queue_refused', queue: { state: 'refused', outcome: { reason: 'jobs_per_day', nextAction: 'Apply the label again tomorrow (UTC).' } } });
    // The jobs list shows only what still waits.
    expect((await call('55/jobs')).body.jobs).toEqual([]);
  });

  it('lets an owner cancel waiting work through the webhook function, and nobody else', async () => {
    const cancel = vi.fn(async () => ({ ok: true as const, state: 'canceled' as const }));
    const owner = await setup('owner', cancel);
    await owner.queue.enqueue(entry('job_queued00000001'), 25);
    expect((await owner.call('55/jobs')).body.jobs).toMatchObject([{ canCancel: true }]);
    expect(await owner.call('55/jobs/job_queued00000001/cancel', 'POST')).toMatchObject({ status: 200, body: { jobId: 'job_queued00000001', state: 'canceled' } });
    expect(cancel).toHaveBeenCalledWith(55, 'job_queued00000001', 'Pat');
    // Another tenant's, or an unknown id: never sent on.
    expect((await owner.call('66/jobs/job_queued00000001/cancel', 'POST')).status).toBe(403);
    expect((await owner.call('55/jobs/job_unknown000000001/cancel', 'POST')).status).toBe(404);
    expect(cancel).toHaveBeenCalledTimes(1);

    const editor = await setup('editor', cancel);
    await editor.queue.enqueue(entry('job_queued00000001'), 25);
    expect((await editor.call('55/jobs')).body.jobs).toMatchObject([{ canCancel: false }]);
    expect((await editor.call('55/jobs/job_queued00000001/cancel', 'POST')).status).toBe(403);
  });

  it("passes on the dispatcher's refusal for work being admitted", async () => {
    const { queue, call } = await setup('owner', async () => ({ ok: false, status: 409, code: 'admitting', message: 'This job is starting now; stop it from its page once it has started' }));
    await queue.enqueue(entry('job_queued00000001'), 25);
    expect(await call('55/jobs/job_queued00000001/cancel', 'POST')).toMatchObject({ status: 409, body: { error: 'admitting' } });
  });
});
