import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { Caller } from '../caller.js';
import { FlowError } from '../flows/github.js';
import { createMemoryStore, type JobSummary, type Tenant } from '../store/store.js';
import { jobView } from './status-service.js';
import { checkHoneycombKey, createTelemetryService, traceUrl, type HoneycombChecker } from './telemetry-service.js';

const caller = { sub: 'u1' } as Caller;
const KEY = 'hcaik_01j1824es7n4evcmv81cn392jbSECRETSECRETSECRETSECRET';
const tenant: Tenant = { installationId: 55, accountId: 900, accountLogin: 'acme', accountType: 'Organization', status: 'active', createdAt: '', createdBy: 's' };

async function setup(check: HoneycombChecker = async () => ({ result: 'valid', auth: { type: 'ingest', canSend: true, team: { name: 'Acme', slug: 'acme' }, environment: { name: 'Production', slug: 'production' } } })) {
  const store = createMemoryStore();
  await store.putTenantWithMember(tenant, { installationId: 55, sub: 'u1', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
  const secrets = { put: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined) };
  const allow = async (_c: Caller, id: number) => {
    if (id !== 55) throw new FlowError('not_authorized', 403, 'You are not a member of that installation');
    return { githubLogin: 'pat' } as never;
  };
  const checker = vi.fn(check);
  const service = createTelemetryService({ store, github: { configContext: allow, member: allow }, secrets, check: checker, now: () => Date.UTC(2026, 10, 21) });
  return { store, secrets, service, checker };
}

describe('agent telemetry settings', () => {
  it('starts off, with no key', async () => {
    const { service } = await setup();
    expect(await service.view(caller, 55)).toEqual({ provider: 'honeycomb', enabled: false, region: 'us', serviceName: 'updraft', captureContent: false, keyConfigured: false });
  });

  it('checks a key with Honeycomb before saving it as a secret, and turns telemetry on with the first one', async () => {
    const { service, secrets, checker } = await setup();
    const v = await service.setKey(caller, 55, { value: ` ${KEY} `, region: 'eu' });
    expect(checker).toHaveBeenCalledWith('eu', KEY);
    expect(secrets.put).toHaveBeenCalledWith('updraft/tenants/55/agent-keys/HONEYCOMB_API_KEY', KEY, expect.objectContaining({ 'updraft:installation': '55' }));
    expect(v).toMatchObject({ enabled: true, region: 'eu', keyConfigured: true, key: { type: 'ingest', team: { slug: 'acme' }, environment: { slug: 'production' }, updatedBy: 'pat' } });
    expect(JSON.stringify(v)).not.toContain(KEY);
    // A rotation keeps what was chosen.
    await service.update(caller, 55, { enabled: false });
    expect((await service.setKey(caller, 55, { value: KEY })).enabled).toBe(false);
  });

  it('saves nothing for a key Honeycomb rejects, cannot reach, or one that cannot send events', async () => {
    for (const [check, message] of [
      [async () => ({ result: 'invalid' as const }), /rejected that key/],
      [async () => ({ result: 'unavailable' as const }), /Could not check/],
      [async () => ({ result: 'valid' as const, auth: { type: 'configuration', canSend: false } }), /cannot send events/],
    ] as const) {
      const { service, secrets, store } = await setup(check);
      await expect(service.setKey(caller, 55, { value: KEY })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(message) });
      expect(secrets.put).not.toHaveBeenCalled();
      expect(await store.getTelemetry(55)).toBeNull();
    }
    const { service } = await setup();
    await expect(service.setKey(caller, 55, { value: 'nope' })).rejects.toMatchObject({ status: 400 });
  });

  it('updates the settings it knows, refuses to turn on without a key, and removes the key', async () => {
    const { service, secrets } = await setup();
    await expect(service.update(caller, 55, { enabled: true })).rejects.toMatchObject({ status: 400, message: /Add a Honeycomb key/ });
    await service.setKey(caller, 55, { value: KEY });
    expect(await service.update(caller, 55, { serviceName: 'factory', captureContent: true })).toMatchObject({ serviceName: 'factory', captureContent: true, enabled: true });
    await expect(service.update(caller, 55, { serviceName: 'no spaces' })).rejects.toMatchObject({ status: 400 });
    await expect(service.update(caller, 55, { captureContent: 'yes' })).rejects.toMatchObject({ status: 400 });
    const off = await service.removeKey(caller, 55);
    expect(secrets.remove).toHaveBeenCalledWith('updraft/tenants/55/agent-keys/HONEYCOMB_API_KEY');
    expect(off).toMatchObject({ enabled: false, keyConfigured: false, serviceName: 'factory' });
  });

  it('is for members only, and served at /api/v1/installations/:id/telemetry', async () => {
    const { service } = await setup();
    await expect(service.view(caller, 56)).rejects.toMatchObject({ status: 403 });
    const app = createApp({ resolveCaller: () => caller, telemetry: service });
    const put = await app.request('/api/v1/installations/55/telemetry/key', { method: 'PUT', body: JSON.stringify({ value: KEY, region: 'us' }), headers: { 'content-type': 'application/json' } });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { keyConfigured: boolean }).keyConfigured).toBe(true);
    const upd = await app.request('/api/v1/installations/55/telemetry', { method: 'PUT', body: JSON.stringify({ captureContent: true }), headers: { 'content-type': 'application/json' } });
    expect(((await upd.json()) as { captureContent: boolean }).captureContent).toBe(true);
    expect((await app.request('/api/v1/installations/55/telemetry/key', { method: 'DELETE' })).status).toBe(200);
    expect((await app.request('/api/v1/installations/56/telemetry')).status).toBe(403);
  });
});

describe('checkHoneycombKey', () => {
  it('asks /1/auth in the region with the key in X-Honeycomb-Team, and reads the team and environment', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: 'hcxik_1', type: 'ingest', api_key_access: { createDatasets: true }, environment: { name: 'Production', slug: 'production' }, team: { name: 'Acme', slug: 'acme' } }), { status: 200 }),
    );
    const out = await checkHoneycombKey(fetch as never)('eu', KEY);
    expect(fetch.mock.calls[0]![0]).toBe('https://api.eu1.honeycomb.io/1/auth');
    expect((fetch.mock.calls[0]![1]!.headers as Record<string, string>)['X-Honeycomb-Team']).toBe(KEY);
    expect(out).toEqual({ result: 'valid', auth: { type: 'ingest', canSend: true, team: { name: 'Acme', slug: 'acme' }, environment: { name: 'Production', slug: 'production' } } });
    expect(await checkHoneycombKey((async () => new Response('', { status: 401 })) as never)('us', KEY)).toEqual({ result: 'invalid' });
    expect(await checkHoneycombKey((async () => new Response('', { status: 500 })) as never)('us', KEY)).toEqual({ result: 'unavailable' });
    const config = await checkHoneycombKey((async () => new Response(JSON.stringify({ type: 'configuration', api_key_access: { events: false }, team: { slug: 't' } }), { status: 200 })) as never)('us', KEY);
    expect(config).toMatchObject({ result: 'valid', auth: { canSend: false } });
  });
});

describe('links to a trace', () => {
  const settings = { region: 'us' as const, serviceName: 'updraft', key: { updatedAt: '', updatedBy: '', team: { name: 'Acme', slug: 'acme' }, environment: { name: 'Prod', slug: 'prod' } } };
  const traceId = 'ab'.repeat(16);

  it('builds the documented direct trace link, with the time range around the job', () => {
    expect(traceUrl(settings, traceId, '2026-11-21T10:00:00.000Z', '2026-11-21T10:20:00.000Z')).toBe(
      `https://ui.honeycomb.io/acme/environments/prod/trace?trace_id=${traceId}&trace_start_ts=1795255140&trace_end_ts=1795256700`,
    );
    expect(traceUrl({ ...settings, region: 'eu', key: { ...settings.key, environment: undefined } }, traceId, '2026-11-21T10:00:00.000Z')).toMatch(/^https:\/\/ui-eu1\.honeycomb\.io\/acme\/datasets\/updraft\/trace\?/);
    expect(traceUrl(null, traceId, '2026-11-21T10:00:00.000Z')).toBeNull();
    expect(traceUrl(settings, 'not-a-trace', '2026-11-21T10:00:00.000Z')).toBeNull();
  });

  it('puts the link and the conversation on a job', () => {
    const job: JobSummary = {
      jobId: 'job_x0000001',
      repository: 'acme/web',
      issue: 12,
      createdAt: '2026-11-21T10:00:00.000Z',
      finishedAt: '2026-11-21T10:20:00.000Z',
      status: 'finished',
      outcome: 'succeeded',
      detail: { telemetry: { traceId, spans: 9, exported: 9, failed: 0, startedAt: '2026-11-21T10:00:00.000Z' } },
    };
    expect(jobView(job, { provider: 'honeycomb', enabled: true, captureContent: false, updatedAt: '', updatedBy: '', ...settings }).telemetry).toEqual({
      traceId,
      traceUrl: expect.stringContaining(`trace_id=${traceId}`),
      conversationId: 'acme/web#12',
      spans: 9,
      exported: 9,
      failed: 0,
    });
    expect(jobView(job).telemetry?.traceUrl).toBeUndefined();
  });
});
