import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { Caller } from '../caller.js';
import { FlowError } from '../flows/github.js';
import { createMemoryStore, type JobSummary, type Tenant } from '../store/store.js';
import { jobView } from './status-service.js';
import { telemetryOf } from '../jobs/lifecycle.js';
import type { OtlpChecker } from './otlp-destination.js';
import { checkHoneycombKey, conversationUrl, createTelemetryService, linkDestinationFor, parseTimelineTemplate, timelineUrl, traceUrl, type HoneycombChecker } from './telemetry-service.js';
import type { TelemetrySettings } from '../store/store.js';

/** A job as the broker records it: with the snapshot of the destination it was sent to. */
function sentWith(job: JobSummary, settings: TelemetrySettings | null, sentTo: { provider: 'honeycomb' | 'cloudwatch' | 'otlp'; host: string }): JobSummary {
  const destination = linkDestinationFor(settings, sentTo);
  return { ...job, detail: { ...job.detail, telemetry: { ...job.detail!.telemetry!, sentTo, ...(destination ? { destination } : {}) } } };
}

const caller = { sub: 'u1' } as Caller;
const KEY = 'hcaik_01j1824es7n4evcmv81cn392jbSECRETSECRETSECRETSECRET';
const tenant: Tenant = { installationId: 55, accountId: 900, accountLogin: 'acme', accountType: 'Organization', status: 'active', createdAt: '', createdBy: 's' };

async function setup(
  check: HoneycombChecker = async () => ({ result: 'valid', auth: { type: 'ingest', canSend: true, team: { name: 'Acme', slug: 'acme' }, environment: { name: 'Production', slug: 'production' } } }),
  otlpCheck: OtlpChecker = async () => ({ result: 'valid' }),
) {
  const store = createMemoryStore();
  await store.putTenantWithMember(tenant, { installationId: 55, sub: 'u1', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
  const secrets = { put: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined) };
  const allow = async (_c: Caller, id: number) => {
    if (id !== 55) throw new FlowError('not_authorized', 403, 'You are not a member of that installation');
    return { githubLogin: 'pat' } as never;
  };
  const checker = vi.fn(check);
  const checkOtlp = vi.fn(otlpCheck);
  const service = createTelemetryService({ store, github: { configContext: allow, member: allow }, secrets, check: checker, checkOtlp, now: () => Date.UTC(2026, 10, 21) });
  return { store, secrets, service, checker, checkOtlp };
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

  it('finds the region itself: the US first, then the EU', async () => {
    const regions: string[] = [];
    const { service } = await setup(async (region) => {
      regions.push(region);
      return region === 'eu' ? { result: 'valid', auth: { type: 'ingest', canSend: true, team: { name: 'Acme', slug: 'acme' } } } : { result: 'invalid' };
    });
    expect(await service.setKey(caller, 55, { value: KEY, region: 'auto' })).toMatchObject({ region: 'eu', keyConfigured: true });
    expect(regions).toEqual(['us', 'eu']);
    const { service: nowhere } = await setup(async () => ({ result: 'invalid' }));
    await expect(nowhere.setKey(caller, 55, { value: KEY, region: 'auto' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/both the US and the EU/) });
    // The US could not be asked: the EU still is, and a valid EU key is saved.
    const { service: usDown } = await setup(async (region) => (region === 'eu' ? { result: 'valid', auth: { type: 'ingest', canSend: true } } : { result: 'unavailable' }));
    expect(await usDown.setKey(caller, 55, { value: KEY, region: 'auto' })).toMatchObject({ region: 'eu', keyConfigured: true });
    // Rejected in one, unreachable in the other: not known to be wrong, so try again.
    for (const unreachable of ['us', 'eu']) {
      const { service: half, store } = await setup(async (region) => ({ result: region === unreachable ? 'unavailable' : 'invalid' }));
      await expect(half.setKey(caller, 55, { value: KEY, region: 'auto' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Could not check the key/) });
      expect((await store.getTelemetry(55))?.key).toBeUndefined();
    }
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
      // The lease was taken and given back: no key, and nothing holding the settings.
      const after = await store.getTelemetry(55);
      expect(after?.key).toBeUndefined();
      expect(after?.keyChange).toBeUndefined();
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

  it('keeps an opt-out made while a key rotation was being checked', async () => {
    let release: () => void = () => {};
    const paused = new Promise<void>((r) => (release = r));
    let calls = 0;
    const { service, store } = await setup(async () => {
      calls += 1;
      if (calls === 2) await paused;
      return { result: 'valid', auth: { type: 'ingest', canSend: true, team: { name: 'Acme', slug: 'acme' } } };
    });
    await service.setKey(caller, 55, { value: KEY });
    await service.update(caller, 55, { captureContent: true });
    // A rotation starts and waits on Honeycomb; meanwhile another member opts out of both.
    const rotation = service.setKey(caller, 55, { value: KEY });
    await new Promise((r) => setTimeout(r, 5));
    await service.update(caller, 55, { enabled: false, captureContent: false });
    release();
    const after = await rotation;
    expect(after).toMatchObject({ enabled: false, captureContent: false, keyConfigured: true });
    expect(await store.getTelemetry(55)).toMatchObject({ enabled: false, captureContent: false });
  });

  it('pins the key to the secret version it was written as, so its region and team always match it', async () => {
    const { service, store, secrets } = await setup();
    let n = 0;
    secrets.put.mockImplementation(async () => ({ versionId: `v-${++n}-0000000000` }));
    await service.setKey(caller, 55, { value: KEY, region: 'us' });
    expect((await store.getTelemetry(55))?.key?.secretVersion).toBe('v-1-0000000000');
    const view = await service.setKey(caller, 55, { value: KEY, region: 'eu' });
    expect(await store.getTelemetry(55)).toMatchObject({ region: 'eu', key: { secretVersion: 'v-2-0000000000' } });
    // Not shown to members: it is how jobs find the key, nothing more.
    expect(JSON.stringify(view)).not.toContain('secretVersion');
  });

  it('lets one key change run at a time: a second rotation or a removal meanwhile is refused, and nothing is split', async () => {
    let release: () => void = () => {};
    const paused = new Promise<void>((r) => (release = r));
    let calls = 0;
    const { service, store, secrets } = await setup(async (region) => {
      calls += 1;
      if (calls === 1) await paused;
      return { result: 'valid', auth: { type: 'ingest', canSend: true, team: { name: region === 'eu' ? 'EU team' : 'US team', slug: region } } };
    });
    let n = 0;
    secrets.put.mockImplementation(async () => ({ versionId: `v-${++n}-0000000000` }));
    // Rotation A (US) waits on Honeycomb; B (EU) and a removal come in meanwhile.
    const a = service.setKey(caller, 55, { value: KEY, region: 'us' });
    await new Promise((r) => setTimeout(r, 5));
    await expect(service.setKey(caller, 55, { value: KEY, region: 'eu' })).rejects.toMatchObject({ status: 409, message: /under way/ });
    await expect(service.removeKey(caller, 55)).rejects.toMatchObject({ status: 409 });
    expect(secrets.put).not.toHaveBeenCalled();
    expect(secrets.remove).not.toHaveBeenCalled();
    release();
    await a;
    // The row names A's region and team, and the version A wrote: the key a job reads matches.
    expect(await store.getTelemetry(55)).toMatchObject({ region: 'us', key: { team: { slug: 'us' }, secretVersion: 'v-1-0000000000' } });
    expect((await store.getTelemetry(55))?.keyChange).toBeUndefined();
    // Now the next change goes through.
    expect(await service.setKey(caller, 55, { value: KEY, region: 'eu' })).toMatchObject({ region: 'eu' });
  });

  it('takes over a lease that ran out, and refuses to finish a change whose lease was taken', async () => {
    const { store, secrets } = await setup();
    const clock = { t: Date.UTC(2026, 10, 21) };
    const allow = async () => ({ githubLogin: 'pat' }) as never;
    let resume: () => void = () => {};
    const paused = new Promise<void>((r) => (resume = r));
    let calls = 0;
    const service = createTelemetryService({
      store,
      github: { configContext: allow, member: allow },
      secrets,
      check: async () => {
        calls += 1;
        if (calls === 1) await paused;
        return { result: 'valid', auth: { type: 'ingest', canSend: true, team: { name: 'T', slug: 't' } } };
      },
      now: () => clock.t,
    });
    secrets.put.mockResolvedValue({ versionId: 'v-0000000000' });
    const slow = service.setKey(caller, 55, { value: KEY, region: 'us' });
    await new Promise((r) => setTimeout(r, 5));
    clock.t += 3 * 60 * 1000;
    await service.setKey(caller, 55, { value: KEY, region: 'eu' });
    resume();
    await expect(slow).rejects.toMatchObject({ status: 409, message: /took too long/ });
    expect(await store.getTelemetry(55)).toMatchObject({ region: 'eu' });
  });

  it('removes the key from the row before the secret, so no job is ever pointed at a deleted key', async () => {
    const { service, store, secrets } = await setup();
    await service.setKey(caller, 55, { value: KEY });
    const order: string[] = [];
    const put = store.putTelemetry.bind(store);
    store.putTelemetry = async (id, settings, expected) => {
      if (!settings.key) order.push('row');
      return put(id, settings, expected);
    };
    secrets.remove.mockImplementation(async () => {
      order.push('secret');
    });
    await service.removeKey(caller, 55);
    // The key off the row, the secret deleted, then the lease given back.
    expect(order).toEqual(['row', 'secret', 'row']);
  });

  it('holds the lease until the secret is deleted: a save while the delete is under way is refused, not deleted with it', async () => {
    const { service, store, secrets } = await setup();
    let n = 0;
    secrets.put.mockImplementation(async () => ({ versionId: `v-${++n}-0000000000` }));
    await service.setKey(caller, 55, { value: KEY });
    let finishDelete: () => void = () => {};
    const deleting = new Promise<void>((r) => (finishDelete = r));
    secrets.remove.mockImplementation(async () => {
      await deleting;
    });
    const removal = service.removeKey(caller, 55);
    await new Promise((r) => setTimeout(r, 5));
    // The row already says no key and not sending, and the lease is still held.
    expect(await store.getTelemetry(55)).toMatchObject({ enabled: false, keyChange: expect.objectContaining({ id: expect.any(String) }) });
    expect((await store.getTelemetry(55))?.key).toBeUndefined();
    await expect(service.setKey(caller, 55, { value: KEY })).rejects.toMatchObject({ status: 409, message: /under way/ });
    expect(secrets.put).toHaveBeenCalledTimes(1);
    finishDelete();
    await removal;
    expect((await store.getTelemetry(55))?.keyChange).toBeUndefined();
    // Once the delete is done, a new key is saved and stays: nothing outstanding can delete it.
    expect(await service.setKey(caller, 55, { value: KEY })).toMatchObject({ keyConfigured: true, enabled: true });
    expect(await store.getTelemetry(55)).toMatchObject({ key: { secretVersion: 'v-2-0000000000' } });
    expect(secrets.remove).toHaveBeenCalledTimes(1);
  });

  it('gives the lease back when the delete fails, with the key already off the row', async () => {
    const { service, store, secrets } = await setup();
    await service.setKey(caller, 55, { value: KEY });
    secrets.remove.mockRejectedValueOnce(new Error('throttled'));
    await expect(service.removeKey(caller, 55)).rejects.toThrow('throttled');
    const after = await store.getTelemetry(55);
    expect(after?.key).toBeUndefined();
    expect(after?.enabled).toBe(false);
    expect(after?.keyChange).toBeUndefined();
  });

  it('writes only over the version it read, and retries on a conflict', async () => {
    const { service, store } = await setup();
    await service.setKey(caller, 55, { value: KEY });
    const v = (await store.getTelemetry(55))!.version!;
    expect(await store.putTelemetry(55, (await store.getTelemetry(55))!, v - 1)).toBe('conflict');
    // Another write lands between this update's read and its write: it is reapplied on top.
    const put = store.putTelemetry.bind(store);
    let once = true;
    store.putTelemetry = async (id, settings, expected) => {
      if (once) {
        once = false;
        await put(id, { ...(await store.getTelemetry(id))!, serviceName: 'theirs' }, expected);
      }
      return put(id, settings, expected);
    };
    expect(await service.update(caller, 55, { captureContent: true })).toMatchObject({ captureContent: true, serviceName: 'theirs' });
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

describe('a custom OTLP destination', () => {
  const TOKEN = 'Bearer otlp-secret-token-value-123';
  const otlp = { provider: 'otlp', endpoint: 'https://otlp.example.com/otlp/', header: 'Authorization', value: ` ${TOKEN} ` };

  it('checks the endpoint with the header before saving the key, and saves the destination with it', async () => {
    const { service, secrets, checkOtlp, checker } = await setup();
    const v = await service.setKey(caller, 55, otlp);
    expect(checker).not.toHaveBeenCalled();
    expect(checkOtlp).toHaveBeenCalledWith({ tracesUrl: 'https://otlp.example.com/otlp/v1/traces', host: 'otlp.example.com', header: 'authorization' }, TOKEN);
    expect(secrets.put).toHaveBeenCalledWith('updraft/tenants/55/agent-keys/HONEYCOMB_API_KEY', TOKEN, expect.anything());
    expect(v).toMatchObject({ provider: 'otlp', enabled: true, keyConfigured: true, otlp: { endpoint: 'https://otlp.example.com/otlp', header: 'authorization', host: 'otlp.example.com' }, key: { type: 'otlp' } });
    expect(v).not.toHaveProperty('environmentUrl');
    expect(JSON.stringify(v)).not.toContain('otlp-secret-token-value-123');
    // Back to Honeycomb: the custom destination is gone with its key.
    const back = await service.setKey(caller, 55, { value: KEY, region: 'us' });
    expect(back.provider).toBe('honeycomb');
    expect(back).not.toHaveProperty('otlp');
  });

  it('saves nothing for an endpoint, header or value it cannot send to, or one the endpoint refuses', async () => {
    for (const [input, message] of [
      [{ ...otlp, endpoint: 'http://otlp.example.com' }, /https/],
      [{ ...otlp, endpoint: 'https://169.254.169.254' }, /not an IP address/],
      [{ ...otlp, endpoint: 'https://collector.internal' }, /public DNS name/],
      [{ ...otlp, endpoint: 'https://otlp.example.com?key=1' }, /query string/],
      [{ ...otlp, header: 'host' }, /cannot carry the key/],
      [{ ...otlp, header: 'x y' }, /header name/],
      [{ ...otlp, value: 'short' }, /header value/],
      [{ ...otlp, value: 'Bearer a\nb-injected-header' }, /header value/],
      [{ ...otlp, provider: 'datadog' }, /honeycomb, cloudwatch or otlp/],
    ] as const) {
      const { service, secrets, checkOtlp } = await setup();
      await expect(service.setKey(caller, 55, input), JSON.stringify(input)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(message) });
      expect(checkOtlp).not.toHaveBeenCalled();
      expect(secrets.put).not.toHaveBeenCalled();
    }
    for (const [verdict, message] of [
      [{ result: 'invalid' as const }, /refused that key/],
      [{ result: 'not_otlp' as const, status: 415 }, /HTTP 415.*JSON/],
      [{ result: 'unreachable' as const, reason: 'its name does not resolve to a public address' }, /public address/],
    ] as const) {
      const { service, secrets, store } = await setup(undefined, async () => verdict);
      await expect(service.setKey(caller, 55, otlp)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(message) });
      expect(secrets.put).not.toHaveBeenCalled();
      expect((await store.getTelemetry(55))?.keyChange).toBeUndefined();
    }
  });

  it("links with the destination's own templates: the trace at a span or its root, and the conversation", async () => {
    const { service, store } = await setup();
    await service.setKey(caller, 55, otlp);
    await expect(service.update(caller, 55, { links: { trace: 'https://ui.example.com/t/{trace}' } })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/not a placeholder/) });
    await expect(service.update(caller, 55, { links: { trace: 'javascript:alert(1)//{trace_id}' } })).rejects.toMatchObject({ status: 400 });
    await expect(service.update(caller, 55, { links: { trace: 'https://{service}.example.com/{trace_id}' } })).rejects.toMatchObject({ status: 400 });
    await expect(service.update(caller, 55, { links: { conversation: 'https://ui.example.com/c' } })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/\{conversation\}/) });
    const v = await service.update(caller, 55, { links: { trace: 'https://ui.example.com/trace/{trace_id}?span={span_id}&from={start_ms}&to={end_ms}', conversation: 'https://ui.example.com/search?q=gen_ai.conversation.id%3D{conversation}&svc={service}' } });
    expect(v.links).toEqual({ trace: expect.stringContaining('{trace_id}'), conversation: expect.stringContaining('{conversation}') });
    const settings = (await store.getTelemetry(55))!;
    const traceId = 'ab'.repeat(16);
    const span = 'cd'.repeat(8);
    const root = 'ef'.repeat(8);
    const job: JobSummary = {
      jobId: 'job_x0000001',
      repository: 'acme/web',
      issue: 12,
      createdAt: '2026-11-21T10:00:00.000Z',
      finishedAt: '2026-11-21T10:20:00.000Z',
      status: 'finished',
      outcome: 'succeeded',
      detail: { telemetry: { traceId, rootSpanId: root, spans: 9, exported: 9, failed: 0, startedAt: '2026-11-21T10:00:00.000Z', marks: [{ kind: 'agent', spanId: span }] } },
    };
    const sentTo = { provider: 'otlp' as const, host: 'otlp.example.com' };
    const t = jobView(sentWith(job, settings, sentTo), settings, { now: Date.parse('2026-11-22T10:00:00.000Z'), timelineTemplate: '{ui}/{team}/x?c={conversation}' }).telemetry!;
    expect(t.destination).toBe('otlp.example.com');
    expect(t.traceUrl).toBe(`https://ui.example.com/trace/${traceId}?span=${root}&from=1795255140000&to=1795256700000`);
    expect(t.timeline?.[0]?.url).toBe(`https://ui.example.com/trace/${traceId}?span=${span}&from=1795255140000&to=1795256700000`);
    expect(t.conversationUrl).toBe('https://ui.example.com/search?q=gen_ai.conversation.id%3Dacme%2Fweb%2312&svc=updraft');
    // The Honeycomb-only parts: no hint, no Agent Timeline template.
    expect(t).not.toHaveProperty('conversationHint');
    expect(t).not.toHaveProperty('timelineUrl');
    // A trace template without {span_id}: the trace, and no span links.
    await service.update(caller, 55, { links: { trace: 'https://ui.example.com/trace/{trace_id}', conversation: '' } });
    const plain = jobView(sentWith(job, await store.getTelemetry(55), sentTo), null).telemetry!;
    expect(plain.traceUrl).toBe(`https://ui.example.com/trace/${traceId}`);
    expect(plain.timeline?.[0]).not.toHaveProperty('url');
    expect(plain).not.toHaveProperty('conversationUrl');
    // No templates: nothing to link to.
    await service.update(caller, 55, { links: {} });
    expect(jobView(sentWith(job, await store.getTelemetry(55), sentTo), null).telemetry).not.toHaveProperty('traceUrl');
  });

  it('hands the job the endpoint and the header with the key, never one without the other', async () => {
    const { service, store } = await setup();
    await service.setKey(caller, 55, otlp);
    const t = (await store.getTelemetry(55))!;
    expect(t).toMatchObject({ provider: 'otlp', otlp: { endpoint: 'https://otlp.example.com/otlp', header: 'authorization' } });
    // `update` cannot change where the key goes.
    await service.update(caller, 55, { otlp: { endpoint: 'https://evil.example.com' } } as never);
    expect((await store.getTelemetry(55))!.otlp?.endpoint).toBe('https://otlp.example.com/otlp');
  });
});

describe('the CloudWatch destination', () => {
  const XRAY_KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/=';

  it("checks the region's X-Ray endpoint with the key as a bearer token, and saves the destination with it", async () => {
    const { service, secrets, checkOtlp, store } = await setup();
    const v = await service.setKey(caller, 55, { provider: 'cloudwatch', awsRegion: ' US-West-2 ', value: `Bearer ${XRAY_KEY}` });
    expect(checkOtlp).toHaveBeenCalledWith({ tracesUrl: 'https://xray.us-west-2.amazonaws.com/v1/traces', host: 'xray.us-west-2.amazonaws.com', header: 'authorization' }, `Bearer ${XRAY_KEY}`);
    expect(secrets.put).toHaveBeenCalledWith('updraft/tenants/55/agent-keys/HONEYCOMB_API_KEY', `Bearer ${XRAY_KEY}`, expect.anything());
    expect(v).toMatchObject({ provider: 'cloudwatch', enabled: true, aws: { region: 'us-west-2' }, otlp: { endpoint: 'https://xray.us-west-2.amazonaws.com', header: 'authorization' }, key: { type: 'cloudwatch' } });
    expect(JSON.stringify(v)).not.toContain(XRAY_KEY);
    expect((await store.getTelemetry(55))).toMatchObject({ provider: 'cloudwatch', aws: { region: 'us-west-2' } });
    // To another destination: the region goes with it.
    const back = await service.setKey(caller, 55, { value: KEY, region: 'us' });
    expect(back).not.toHaveProperty('aws');
    expect(back).not.toHaveProperty('otlp');
  });

  it('reads the answer to the empty export the way AWS gives it', async () => {
    for (const [verdict, outcome] of [
      [{ result: 'valid' as const }, null],
      // The key got through; the empty body did not.
      [{ result: 'not_otlp' as const, status: 400, detail: 'Invalid request: no spans' }, null],
      [{ result: 'not_otlp' as const, status: 400, detail: 'Transaction Search is not enabled for this account' }, /Transaction Search/],
      [{ result: 'invalid' as const }, /ServiceCredentialSecret/],
      [{ result: 'not_otlp' as const, status: 404 }, /available in this region/],
      [{ result: 'unreachable' as const, reason: 'it did not answer in time' }, /did not answer/],
    ] as const) {
      const { service, secrets } = await setup(undefined, async () => verdict);
      const out = service.setKey(caller, 55, { provider: 'cloudwatch', awsRegion: 'eu-west-1', value: XRAY_KEY });
      if (outcome === null) await expect(out).resolves.toMatchObject({ provider: 'cloudwatch' });
      else {
        await expect(out).rejects.toMatchObject({ status: 400, message: expect.stringMatching(outcome) });
        expect(secrets.put).not.toHaveBeenCalled();
      }
    }
    for (const input of [
      { provider: 'cloudwatch', awsRegion: 'oregon', value: XRAY_KEY },
      { provider: 'cloudwatch', awsRegion: 'us-west-2', value: 'short' },
      { provider: 'cloudwatch', awsRegion: 'us-west-2', value: 'has spaces in it ok' },
    ]) {
      const { service, checkOtlp } = await setup();
      await expect(service.setKey(caller, 55, input)).rejects.toMatchObject({ status: 400 });
      expect(checkOtlp).not.toHaveBeenCalled();
    }
  });

  it('links a job to its trace in the CloudWatch console, and to no span or search', async () => {
    const { service, store } = await setup();
    await service.setKey(caller, 55, { provider: 'cloudwatch', awsRegion: 'us-east-1', value: XRAY_KEY });
    const traceId = '6a1b2c3d' + 'ef'.repeat(12);
    const job: JobSummary = {
      jobId: 'job_x0000001',
      repository: 'acme/web',
      issue: 12,
      createdAt: '2026-11-21T10:00:00.000Z',
      finishedAt: '2026-11-21T10:20:00.000Z',
      status: 'finished',
      outcome: 'succeeded',
      detail: { telemetry: { traceId, rootSpanId: 'ab'.repeat(8), spans: 9, exported: 9, failed: 0, startedAt: '2026-11-21T10:00:00.000Z', marks: [{ kind: 'agent', spanId: 'cd'.repeat(8) }] } },
    };
    const settings = (await store.getTelemetry(55))!;
    const t = jobView(sentWith(job, settings, { provider: 'cloudwatch', host: 'xray.us-east-1.amazonaws.com' }), settings, { now: Date.parse('2026-11-22T10:00:00.000Z'), timelineTemplate: '{ui}/{team}/x?c={conversation}' }).telemetry!;
    expect(t.destination).toBe('CloudWatch');
    expect(t.traceUrl).toBe(`https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#xray:traces/1-6a1b2c3d-${'ef'.repeat(12)}`);
    expect(t.timeline?.[0]).not.toHaveProperty('url');
    expect(t).not.toHaveProperty('conversationUrl');
    expect(t).not.toHaveProperty('timelineUrl');
  });
});

describe("a job's links stay with the destination that got its trace", () => {
  const traceId = 'ab'.repeat(16);
  const job: JobSummary = {
    jobId: 'job_x0000001',
    repository: 'acme/web',
    issue: 12,
    createdAt: '2026-11-21T10:00:00.000Z',
    finishedAt: '2026-11-21T10:20:00.000Z',
    status: 'finished',
    outcome: 'succeeded',
    detail: { telemetry: { traceId, spans: 9, exported: 9, failed: 0, startedAt: '2026-11-21T10:00:00.000Z', marks: [{ kind: 'agent', spanId: 'cd'.repeat(8) }, { kind: 'step_failed', spanId: 'ef'.repeat(8), sent: false }] } },
  };

  it('reports the installation telemetry status apart from the job export', async () => {
    const { service, store } = await setup();
    expect(jobView(job, await store.getTelemetry(55)).telemetryStatus).toBe('not_configured');
    await service.setKey(caller, 55, { value: KEY, region: 'us' });
    const settings = await store.getTelemetry(55);
    expect(jobView(job, settings).telemetryStatus).toBe('enabled');
    expect(jobView(job, settings).telemetry).toBeUndefined();
    expect(jobView(job, null, { settingsUnavailable: true }).telemetryStatus).toBe('unknown');
    expect(JSON.stringify(jobView(job, settings).telemetryStatus)).not.toMatch(/secret|key/i);
  });

  it('keeps historical links under the current status after the destination changes or is paused', async () => {
    const { service, store } = await setup();
    await service.setKey(caller, 55, { value: KEY, region: 'us' });
    const sent = sentWith(job, await store.getTelemetry(55), { provider: 'honeycomb', host: 'api.honeycomb.io' });
    await service.setKey(caller, 55, { provider: 'cloudwatch', awsRegion: 'us-east-1', value: 'AbCdEfGhIjKlMnOpQrStUv0123' });
    const changed = jobView(sent, await store.getTelemetry(55));
    expect(changed.telemetryStatus).toBe('enabled');
    expect(changed.telemetry?.traceUrl).toMatch(/ui\.honeycomb\.io/);
    await service.update(caller, 55, { enabled: false });
    const paused = jobView(sent, await store.getTelemetry(55));
    expect(paused.telemetryStatus).toBe('paused');
    expect(paused.telemetry?.traceUrl).toMatch(/ui\.honeycomb\.io/);
    // Settings unavailable: unknown, and a link to the snapshotted destination survives.
    const unknown = jobView(sent, null, { settingsUnavailable: true });
    expect(unknown.telemetryStatus).toBe('unknown');
    expect(unknown.telemetry?.destination).toBe('Honeycomb');
  });

  it('never lets a job record override the computed telemetry status', () => {
    expect(jobView({ ...job, telemetryStatus: 'enabled' } as never, null).telemetryStatus).toBe('not_configured');
  });

  it('keeps a Honeycomb job linked to Honeycomb after the destination became CloudWatch, then a custom one', async () => {
    const { service, store } = await setup();
    await service.setKey(caller, 55, { value: KEY, region: 'us' });
    const honeycombJob = sentWith(job, await store.getTelemetry(55), { provider: 'honeycomb', host: 'api.honeycomb.io' });
    expect(honeycombJob.detail?.telemetry?.destination).toMatchObject({ provider: 'honeycomb', team: { slug: 'acme' } });
    await service.setKey(caller, 55, { provider: 'cloudwatch', awsRegion: 'us-east-1', value: 'AbCdEfGhIjKlMnOpQrStUv0123' });
    const now = await store.getTelemetry(55);
    const t = jobView(honeycombJob, now, { now: Date.parse('2026-11-22T10:00:00.000Z') }).telemetry!;
    expect(t.destination).toBe('Honeycomb');
    expect(t.traceUrl).toMatch(/^https:\/\/ui\.honeycomb\.io\/acme\/environments\/production\/trace\?trace_id=/);
    expect(t.conversationUrl).toMatch(/^https:\/\/ui\.honeycomb\.io\//);
    // A moment whose span the destination did not accept: still on the timeline, never linked.
    expect(t.timeline?.map((e) => [e.kind, Boolean(e.url)])).toEqual([
      ['agent', true],
      ['step_failed', false],
    ]);
    await service.setKey(caller, 55, { provider: 'otlp', endpoint: 'https://otlp.example.com', header: 'authorization', value: 'Bearer otlp-secret-token-value' });
    await service.update(caller, 55, { links: { trace: 'https://ui.example.com/{trace_id}', conversation: 'https://ui.example.com/c?q={conversation}' } });
    expect(jobView(honeycombJob, await store.getTelemetry(55)).telemetry!.traceUrl).toMatch(/ui\.honeycomb\.io/);
  });

  it('links nothing from settings that are not where the job sent, and old jobs from Honeycomb settings only', async () => {
    const { service, store } = await setup();
    await service.setKey(caller, 55, { value: KEY, region: 'us' });
    const honeycomb = await store.getTelemetry(55);
    // The runner sent to the EU while the settings say US: no snapshot, no links.
    const elsewhere = sentWith(job, honeycomb, { provider: 'honeycomb', host: 'api.eu1.honeycomb.io' });
    expect(elsewhere.detail?.telemetry?.destination).toBeUndefined();
    expect(jobView(elsewhere, honeycomb).telemetry).not.toHaveProperty('traceUrl');
    // A job from before snapshots: linked while the settings are Honeycomb's, and not after.
    expect(jobView(job, honeycomb).telemetry?.traceUrl).toMatch(/ui\.honeycomb\.io/);
    await service.setKey(caller, 55, { provider: 'cloudwatch', awsRegion: 'us-east-1', value: 'AbCdEfGhIjKlMnOpQrStUv0123' });
    expect(jobView(job, await store.getTelemetry(55)).telemetry).not.toHaveProperty('traceUrl');
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

  it('opens the trace at a span, when given one', () => {
    expect(traceUrl(settings, traceId, '2026-11-21T10:00:00.000Z', '2026-11-21T10:20:00.000Z', 'cd'.repeat(8))).toBe(
      `https://ui.honeycomb.io/acme/environments/prod/trace?trace_id=${traceId}&span=${'cd'.repeat(8)}&trace_start_ts=1795255140&trace_end_ts=1795256700`,
    );
    expect(traceUrl(settings, traceId, '2026-11-21T10:00:00.000Z', undefined, 'not-a-span')).not.toContain('span=');
  });

  it("links to the conversation's spans in the query builder, a week around the job, no later than now", () => {
    const now = Date.parse('2026-11-22T10:00:00.000Z');
    const url = conversationUrl(settings, 'acme/web#12', '2026-11-21T10:00:00.000Z', now)!;
    const [base, query] = url.split('?query=');
    expect(base).toBe('https://ui.honeycomb.io/acme/environments/prod/datasets/updraft/');
    expect(JSON.parse(decodeURIComponent(query!))).toEqual({
      start_time: 1795255200 - 7 * 24 * 3600,
      end_time: now / 1000,
      breakdowns: ['gen_ai.conversation.id', 'gen_ai.agent.name'],
      calculations: [{ op: 'COUNT' }, { op: 'COUNT_DISTINCT', column: 'trace.trace_id' }],
      filters: [{ column: 'gen_ai.conversation.id', op: '=', value: 'acme/web#12' }],
    });
    // Long after: the week after the job.
    const later = conversationUrl(settings, 'acme/web#12', '2026-11-21T10:00:00.000Z', now + 30 * 24 * 3600 * 1000)!;
    expect(JSON.parse(decodeURIComponent(later.split('?query=')[1]!)).end_time).toBe(1795255200 + 7 * 24 * 3600);
    // Classic: the dataset is the place.
    expect(conversationUrl({ ...settings, region: 'eu', key: { ...settings.key, environment: undefined } }, 'acme/web#12', '2026-11-21T10:00:00.000Z', now)).toMatch(/^https:\/\/ui-eu1\.honeycomb\.io\/acme\/datasets\/updraft\/\?query=/);
    expect(conversationUrl(null, 'acme/web#12', '2026-11-21T10:00:00.000Z', now)).toBeNull();
  });

  it('takes an Agent Timeline template only when it stays in the tenant team and names the conversation', () => {
    const good = '{ui}/{team}/environments/{environment}/agent-timeline?conversation={conversation}&start={start}&end={end}';
    expect(parseTimelineTemplate(` ${good} `)).toBe(good);
    expect(parseTimelineTemplate(undefined)).toBeNull();
    expect(parseTimelineTemplate('https://evil.example/{conversation}')).toBeNull();
    expect(parseTimelineTemplate('{ui}/{team}/x?c={conversation}&q={query}')).toBeNull();
    expect(parseTimelineTemplate('{ui}/{team}/x')).toBeNull();
    expect(parseTimelineTemplate('{ui}/{team}/x?c={conversation}{')).toBeNull();
    expect(parseTimelineTemplate('{ui}/{team}/x?c={conversation}"><script>')).toBeNull();
    const now = Date.parse('2026-11-22T10:00:00.000Z');
    expect(timelineUrl(good, settings, 'acme/web#12', '2026-11-21T10:00:00.000Z', now)).toBe(
      `https://ui.honeycomb.io/acme/environments/prod/agent-timeline?conversation=acme%2Fweb%2312&start=${1795255200 - 7 * 24 * 3600}&end=${now / 1000}`,
    );
    // It needs an environment the key did not give: no link.
    expect(timelineUrl(good, { ...settings, key: { ...settings.key, environment: undefined } }, 'acme/web#12', '2026-11-21T10:00:00.000Z', now)).toBeNull();
    expect(timelineUrl(null, settings, 'acme/web#12', '2026-11-21T10:00:00.000Z', now)).toBeNull();
  });

  it("keeps only the runner's marks it can trust, and its conversation id when it has the right shape", () => {
    const span = 'cd'.repeat(8);
    const t = telemetryOf({
      traceId,
      spans: 3,
      conversationId: 'acme/web#12',
      marks: [
        { kind: 'agent', spanId: span, run: 'review', agent: 'claude-opus', verdict: 'changes-requested', failed: true, thrashing: 'yes', extra: 1 },
        { kind: 'test_failed', spanId: span, run: 'Implement!' },
        { kind: 'nope', spanId: span },
        { kind: 'verify_failed', spanId: 'short' },
        { kind: 'step_failed', spanId: span, step: 'runner_restore_state' },
      ],
    })!;
    expect(t.conversationId).toBe('acme/web#12');
    expect(t.marks).toEqual([
      { kind: 'agent', spanId: span, run: 'review', agent: 'claude-opus', verdict: 'changes-requested', failed: true },
      { kind: 'test_failed', spanId: span },
      { kind: 'step_failed', spanId: span, step: 'runner_restore_state' },
    ]);
    expect(telemetryOf({ traceId, conversationId: 'acme/web#12"><' })!.conversationId).toBeUndefined();
    expect(telemetryOf({ traceId, conversationId: 'delivery/d-1' })!.conversationId).toBe('delivery/d-1');
    // A run of no issue is its own conversation, named by its job.
    expect(telemetryOf({ traceId, conversationId: 'job_ev9001' })!.conversationId).toBe('job_ev9001');
    expect(telemetryOf({ traceId, marks: Array.from({ length: 50 }, () => ({ kind: 'agent', spanId: span })) })!.marks).toHaveLength(32);
    // Timing and totals: counts only, anything else dropped.
    expect(telemetryOf({ traceId, marks: [{ kind: 'agent', spanId: span, offsetMs: 5, durationMs: -1 }] })!.marks).toEqual([{ kind: 'agent', spanId: span, offsetMs: 5 }]);
    expect(telemetryOf({ traceId, local: 'yes', totals: { runs: 2, inputTokens: 'lots', costUsd: -3, thrashing: 1 } })).toEqual({
      traceId,
      spans: 0,
      exported: 0,
      failed: 0,
      totals: { runs: 2, inputTokens: 0, outputTokens: 0, toolCalls: 0, toolErrors: 0, thrashing: false, durationMs: 0 },
    });
    expect(telemetryOf({ traceId, local: true })!.local).toBe(true);
  });

  it('puts the links and the conversation on a job', () => {
    const span = 'cd'.repeat(8);
    const job: JobSummary = {
      jobId: 'job_x0000001',
      repository: 'acme/web',
      issue: 12,
      createdAt: '2026-11-21T10:00:00.000Z',
      finishedAt: '2026-11-21T10:20:00.000Z',
      status: 'finished',
      outcome: 'succeeded',
      detail: { telemetry: { traceId, spans: 9, exported: 9, failed: 0, startedAt: '2026-11-21T10:00:00.000Z', marks: [{ kind: 'agent', spanId: span, run: 'implement', agent: 'claude-opus' }] } },
    };
    const full = { provider: 'honeycomb' as const, enabled: true, captureContent: false, updatedAt: '', updatedBy: '', ...settings };
    const now = Date.parse('2026-11-22T10:00:00.000Z');
    const template = '{ui}/{team}/environments/{environment}/agent-timeline?conversation={conversation}';
    expect(jobView(job, full, { now, timelineTemplate: template }).telemetry).toEqual({
      traceId,
      traceUrl: expect.stringContaining(`trace_id=${traceId}&trace_start_ts`),
      conversationId: 'acme/web#12',
      destination: 'Honeycomb',
      conversationUrl: conversationUrl(full, 'acme/web#12', '2026-11-21T10:00:00.000Z', now),
      conversationHint: expect.stringContaining('Agent Timeline'),
      timelineUrl: 'https://ui.honeycomb.io/acme/environments/prod/agent-timeline?conversation=acme%2Fweb%2312',
      timelineLabel: 'Open in Agent Timeline',
      timeline: [{ kind: 'agent', run: 'implement', agent: 'claude-opus', url: expect.stringContaining(`trace_id=${traceId}&span=${span}&`) }],
      spans: 9,
      exported: 9,
      failed: 0,
    });
    // No template: no Agent Timeline link, the query's still there.
    expect(jobView(job, full, { now }).telemetry).not.toHaveProperty('timelineUrl');
    // The runner's conversation wins: a pull request's review job has no issue of its own.
    const review: JobSummary = { ...job, issue: undefined, detail: { telemetry: { ...job.detail!.telemetry!, conversationId: 'acme/web#3' } } };
    expect(jobView(review, full, { now }).telemetry?.conversationId).toBe('acme/web#3');
    // A job of an issue that ran no agent sent its spans in the delivery's conversation: that is the one to link.
    const early: JobSummary = { ...job, detail: { telemetry: { ...job.detail!.telemetry!, conversationId: 'delivery/d-1' } } };
    expect(jobView(early, full, { now }).telemetry?.conversationUrl).toContain(encodeURIComponent('"value":"delivery/d-1"'));
    // Without settings (or the team's slug), nothing to link to, but the conversation id and the timeline.
    expect(jobView(job).telemetry).toEqual({ traceId, conversationId: 'acme/web#12', timeline: [{ kind: 'agent', run: 'implement', agent: 'claude-opus' }], spans: 9, exported: 9, failed: 0 });
    // Sent nowhere (no destination) or nothing got there: the timeline and totals, never a link.
    const totals = { runs: 1, inputTokens: 1200, outputTokens: 300, costUsd: 0.42, toolCalls: 7, toolErrors: 1, thrashing: false, durationMs: 60_000 };
    for (const t of [{ local: true as const, exported: 0 }, { exported: 0 }]) {
      const local: JobSummary = { ...job, detail: { telemetry: { ...job.detail!.telemetry!, ...t, totals, marks: [{ kind: 'agent', spanId: span, offsetMs: 1000, durationMs: 50_000 }] } } };
      const v = jobView(local, full, { now, timelineTemplate: template }).telemetry!;
      expect(v).not.toHaveProperty('traceUrl');
      expect(v).not.toHaveProperty('conversationUrl');
      expect(v).not.toHaveProperty('timelineUrl');
      expect(v).not.toHaveProperty('destination');
      expect(v.timeline).toEqual([{ kind: 'agent', offsetMs: 1000, durationMs: 50_000 }]);
      expect(v.totals).toEqual(totals);
    }
  });
});
