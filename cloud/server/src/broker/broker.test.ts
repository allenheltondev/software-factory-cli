import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The CLI's own reader of the token file: what the broker hands out must be what the job reads.
import { loadTokenFile } from '../../../../src/github/token-file-auth.js';
import type { AppSettings } from '../github/settings.js';
import { createMemoryStore, type Job, type Tenant } from '../store/store.js';
import { createReconciler } from '../jobs/reconcile.js';
import { createWorkflowRecorder } from '../workflows/recorder.js';
import { createMemoryWorkflowStore } from '../workflows/store.js';
import { createBroker, hashToken, JOB_PERMISSIONS, jobAgentKeys, jobPaths, jobSessionPolicy, OPTIONAL_JOB_PERMISSIONS, SESSION_SECONDS } from './broker.js';
import { GitHubError } from '../github/client.js';
import { telemetryView } from '../tenants/telemetry-service.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SETTINGS: AppSettings = {
  appId: '4242',
  clientId: 'Iv1.x',
  slug: 'updraft',
  appUrl: 'https://updraft.example',
  privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  clientSecret: 'x',
  webhookSecret: 'y',
};
const NOW = Date.UTC(2026, 10, 20, 12);
const POLICY = { bucket: 'tenant-bucket', partition: 'aws', region: 'us-east-1', accountId: '123456789012' };

const tenant = (installationId: number): Tenant => ({
  installationId,
  accountId: 900,
  accountLogin: 'acme',
  accountType: 'Organization',
  status: 'active',
  createdAt: '2026-11-19T00:00:00.000Z',
  createdBy: 's',
});

describe('the job broker', () => {
  let store: ReturnType<typeof createMemoryStore>;
  let token: string;
  let job: Job;
  let clock: number;
  const assumeRole = vi.fn();
  const terminateMicrovm = vi.fn();
  const microvmState = vi.fn();
  const github = { createInstallationToken: vi.fn(), getBotUser: vi.fn() };
  let handle: ReturnType<typeof createBroker>;

  beforeEach(async () => {
    store = createMemoryStore();
    clock = NOW;
    await store.putTenantWithMember(tenant(55), { installationId: 55, sub: 's', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
    await store.putTenantWithMember(tenant(66), { installationId: 66, sub: 's', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
    token = randomBytes(32).toString('base64url');
    job = {
      jobId: 'job_abc12345',
      tokenHash: hashToken(token),
      installationId: 55,
      repository: 'acme/web',
      repositoryId: 99,
      configVersion: 3,
      deliveryId: 'd-1',
      eventName: 'issues',
      status: 'launched',
      createdAt: new Date(NOW).toISOString(),
      expiresAt: NOW + 3_600_000,
    };
    await store.putJob(job);
    assumeRole.mockReset().mockResolvedValue({ accessKeyId: 'ASIA', secretAccessKey: 'secret', sessionToken: 'session', expiration: new Date(NOW + 3_600_000).toISOString() });
    github.createInstallationToken.mockReset().mockResolvedValue({ token: 'ghs_4242_scoped', expiresAt: NOW + 3_600_000, permissions: JOB_PERMISSIONS });
    github.getBotUser.mockReset().mockResolvedValue({ id: 777, login: 'updraft[bot]' });
    terminateMicrovm.mockReset().mockResolvedValue(undefined);
    microvmState.mockReset().mockResolvedValue('TERMINATED');
    handle = createBroker({ store, loadSettings: async () => SETTINGS, github, assumeRole, terminateMicrovm, microvmState, stopCheckDelayMs: 1, policy: POLICY, now: () => clock });
  });

  it('starts a job: its descriptor and credentials limited to its own tenant, event, config version and results', async () => {
    const r = await handle({ action: 'start', jobId: job.jobId, token });
    expect(r).toMatchObject({
      ok: true,
      descriptor: {
        bucket: 'tenant-bucket',
        region: 'us-east-1',
        eventKey: 'tenants/55/events/d-1/event.json',
        configPrefix: 'tenants/55/config/3/',
        resultKeyPrefix: 'tenants/55/results/d-1/',
        stateKey: 'tenants/55/state/state.db',
        agentKeySecrets: {
          ANTHROPIC_API_KEY: 'updraft/tenants/55/agent-keys/ANTHROPIC_API_KEY',
          CODEX_API_KEY: 'updraft/tenants/55/agent-keys/CODEX_API_KEY',
        },
      },
      credentials: { accessKeyId: 'ASIA' },
    });
    expect(assumeRole).toHaveBeenCalledWith({ sessionName: 'job-job_abc12345', policy: expect.any(String), durationSeconds: SESSION_SECONDS });
    const policy = JSON.parse(assumeRole.mock.calls[0]![0].policy) as { Statement: { Resource: string | string[]; Condition?: unknown }[] };
    const resources = policy.Statement.flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]));
    // Everything in S3 is this tenant's, and the secrets are this tenant's keys.
    for (const r2 of resources.filter((x) => x.startsWith('arn:aws:s3:::tenant-bucket/'))) expect(r2.startsWith('arn:aws:s3:::tenant-bucket/tenants/55/')).toBe(true);
    expect(resources).toContain('arn:aws:secretsmanager:us-east-1:123456789012:secret:updraft/tenants/55/agent-keys/*');
    expect(JSON.stringify(policy)).not.toMatch(/tenants\/66|tenants\/\*|config\/\*"|updraft\/app/);
    // The config version is pinned: another version of the same tenant is out of reach.
    expect(JSON.stringify(policy)).toContain('tenants/55/config/3/*');
    expect(JSON.stringify(policy)).not.toContain('tenants/55/config/2/');
  });

  describe("the agent keys: the job's own, in the descriptor and the session policy alike", () => {
    const arn = (name: string) => `arn:aws:secretsmanager:us-east-1:123456789012:secret:updraft/tenants/55/agent-keys/${name}`;
    const startedWith = async (agentKeys: string[] | undefined, over: Partial<Job> = {}) => {
      const { agentKeys: _, ...rest } = job;
      const keyed = { ...rest, jobId: 'job_keys00001', deliveryId: 'd-keys', ...(agentKeys ? { agentKeys } : {}), ...over };
      await store.putJob(keyed);
      const r = await handle({ action: 'start', jobId: keyed.jobId, token });
      if (!r.ok || !('descriptor' in r)) throw new Error('not started');
      const policy = JSON.parse(assumeRole.mock.calls.at(-1)![0].policy) as { Statement: { Action: string | string[]; Resource: string | string[] }[] };
      const secrets = policy.Statement.filter((st) => st.Action === 'secretsmanager:GetSecretValue').flatMap((st) => (Array.isArray(st.Resource) ? st.Resource : [st.Resource]));
      return { handed: Object.keys(r.descriptor.agentKeySecrets).sort(), secrets: secrets.sort() };
    };

    it('an ordinary job: exactly its recorded keys, each one secret', async () => {
      expect(await startedWith(['ANTHROPIC_API_KEY', 'CODEX_API_KEY'])).toEqual({ handed: ['ANTHROPIC_API_KEY', 'CODEX_API_KEY'], secrets: [arn('ANTHROPIC_API_KEY-??????'), arn('CODEX_API_KEY-??????')] });
    });

    it('a job whose workflow needs no key: none, and no secret at all', async () => {
      expect(await startedWith([])).toEqual({ handed: [], secrets: [] });
    });

    it('a job recorded before its keys were (none on its record): every supported key, and the whole key prefix', async () => {
      expect(await startedWith(undefined)).toEqual({ handed: ['ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'KIRO_API_KEY', 'MISTRAL_API_KEY'], secrets: [arn('*')] });
    });

    it('the telemetry key too when the job sends telemetry, never as an agent key', async () => {
      const base = { provider: 'honeycomb' as const, region: 'eu' as const, serviceName: 'factory', captureContent: true, updatedAt: '', updatedBy: 'pat' };
      await store.putTelemetry(55, { ...base, enabled: true, key: { updatedAt: '', updatedBy: 'pat', secretVersion: 'a1b2c3d4-0000-4000-8000-000000000001' } }, 0);
      expect(await startedWith(['ANTHROPIC_API_KEY'])).toEqual({ handed: ['ANTHROPIC_API_KEY'], secrets: [arn('ANTHROPIC_API_KEY-??????'), arn('HONEYCOMB_API_KEY-??????')] });
      expect(await startedWith([], { jobId: 'job_keys00002', deliveryId: 'd-keys-2' })).toEqual({ handed: [], secrets: [arn('HONEYCOMB_API_KEY-??????')] });
    });
  });

  it('refuses starts, credentials and publication tokens after an owner stop fence', async () => {
    await handle({ action: 'start', jobId: job.jobId, token });
    await store.requestJobStop(job, { requestedAt: clock, by: 'pat', reason: 'stop' }, []);
    assumeRole.mockClear(); github.createInstallationToken.mockClear();
    for (const action of ['start', 'credentials', 'github-token']) expect(await handle({ action, jobId: job.jobId, token })).toEqual({ ok: false, error: 'refused' });
    expect(assumeRole).not.toHaveBeenCalled(); expect(github.createInstallationToken).not.toHaveBeenCalled();
  });
  it('refuses atomic start if a source-issue pause lands after the broker servable read', async () => {
    job = { ...job, issue: 12 }; await store.putJob(job);
    const owner = { ...job, jobId: 'job_owner0001' }; await store.putJob(owner);
    const start = store.startJob;
    vi.spyOn(store, 'startJob').mockImplementationOnce(async (...args) => {
      await store.requestJobStop(owner, { requestedAt: clock, by: 'pat', reason: 'pause source' }, [12]);
      return start(...args);
    });
    expect(await handle({ action: 'start', jobId: job.jobId, token })).toEqual({ ok: false, error: 'refused' });
    expect((await store.getJob(job.jobId))?.startedAt).toBeUndefined();
    expect(assumeRole).not.toHaveBeenCalled(); expect(github.createInstallationToken).not.toHaveBeenCalled();
  });

  it("marks the tenant's first job when a job starts, once", async () => {
    expect((await store.getTenant(55))?.firstJobAt).toBeUndefined();
    await handle({ action: 'start', jobId: job.jobId, token });
    const at = (await store.getTenant(55))?.firstJobAt;
    expect(at).toBe(new Date(NOW).toISOString());
    clock = NOW + 60_000;
    await handle({ action: 'start', jobId: job.jobId, token });
    expect((await store.getTenant(55))?.firstJobAt).toBe(at);
    expect((await store.getTenant(66))?.firstJobAt).toBeUndefined();
  });

  it('hands the job its telemetry settings at start, never as an agent key, and the same in every later answer', async () => {
    const base = { provider: 'honeycomb' as const, region: 'eu' as const, serviceName: 'factory', captureContent: true, updatedAt: '', updatedBy: 'pat' };
    await store.putTelemetry(55, { ...base, enabled: true, key: { updatedAt: '', updatedBy: 'pat', secretVersion: 'a1b2c3d4-0000-4000-8000-000000000001' } }, 0);
    const on = await handle({ action: 'start', jobId: job.jobId, token });
    expect(on).toMatchObject({
      ok: true,
      descriptor: { telemetry: { region: 'eu', secret: 'updraft/tenants/55/agent-keys/HONEYCOMB_API_KEY', secretVersion: 'a1b2c3d4-0000-4000-8000-000000000001', serviceName: 'factory', captureContent: true } },
    });
    if (on.ok && 'descriptor' in on) expect(Object.keys(on.descriptor.agentKeySecrets)).not.toContain('HONEYCOMB_API_KEY');
    // Turned off while the job runs: the job's answers stay what its start decided.
    await store.putTelemetry(55, { ...base, enabled: false, key: { updatedAt: '', updatedBy: 'pat' } }, 1);
    const later = await handle({ action: 'credentials', jobId: job.jobId, token });
    expect(later).toMatchObject({ descriptor: { telemetry: { secretVersion: 'a1b2c3d4-0000-4000-8000-000000000001' } } });
  });

  it('hands no telemetry to a job that started without it, whatever is set up after', async () => {
    const base = { provider: 'honeycomb' as const, region: 'eu' as const, serviceName: 'factory', captureContent: true, updatedAt: '', updatedBy: 'pat' };
    await store.putTelemetry(55, { ...base, enabled: true }, 0);
    const noKey = await handle({ action: 'start', jobId: job.jobId, token });
    expect(noKey.ok && 'descriptor' in noKey && noKey.descriptor.telemetry).toBeFalsy();
    await store.putTelemetry(55, { ...base, enabled: true, key: { updatedAt: '', updatedBy: 'pat', secretVersion: 'a1b2c3d4-0000-4000-8000-000000000001' } }, 1);
    for (const action of ['start', 'credentials'] as const) {
      const again = await handle({ action, jobId: job.jobId, token });
      expect(again.ok && 'descriptor' in again && again.descriptor.telemetry, action).toBeFalsy();
    }
  });

  it('sends no telemetry when the job\'s record of it cannot be saved, and links nothing from later settings', async () => {
    const teamA = { provider: 'honeycomb' as const, region: 'us' as const, serviceName: 'updraft', captureContent: false, enabled: true, updatedAt: '', updatedBy: 'pat', key: { updatedAt: '', updatedBy: 'pat', secretVersion: 'a1b2c3d4-0000-4000-8000-00000000000a', team: { name: 'A', slug: 'team-a' } } };
    await store.putTelemetry(55, teamA, 0);
    const failing = vi.spyOn(store, 'setJobTelemetrySnapshot').mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
    const out = await handle({ action: 'start', jobId: job.jobId, token });
    expect(out.ok && 'descriptor' in out && out.descriptor.telemetry).toBeFalsy();
    failing.mockRestore();
    await store.putTelemetry(55, { ...teamA, key: { ...teamA.key, secretVersion: 'a1b2c3d4-0000-4000-8000-00000000000b', team: { name: 'B', slug: 'team-b' } } }, 1);
    // The runner had no destination: a local reading, no export to record, nothing linked.
    await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'succeeded', detail: { telemetry: { traceId: 'ab'.repeat(16), spans: 3, exported: 0, failed: 0, local: true } } });
    expect((await store.getJobSummary(55, job.jobId))?.detail?.telemetry?.destination).toBeUndefined();
    expect((await store.getTelemetry(55))?.lastExport).toBeUndefined();
  });

  it('sends no telemetry when another start recorded it first and that record cannot be read back', async () => {
    await store.putTelemetry(55, { provider: 'honeycomb', region: 'us', serviceName: 'updraft', captureContent: false, enabled: true, updatedAt: '', updatedBy: 'pat', key: { updatedAt: '', updatedBy: 'pat', team: { name: 'A', slug: 'team-a' } } }, 0);
    const lost = vi.spyOn(store, 'setJobTelemetrySnapshot').mockResolvedValue(false);
    const out = await handle({ action: 'start', jobId: job.jobId, token });
    expect(out.ok && 'descriptor' in out && out.descriptor.telemetry).toBeFalsy();
    lost.mockRestore();
  });

  it('answers a replayed start with the descriptor and links of the first: the key version the runner reads is the one its trace is linked from', async () => {
    const teamA = { provider: 'honeycomb' as const, region: 'us' as const, serviceName: 'updraft', captureContent: false, enabled: true, updatedAt: '', updatedBy: 'pat', key: { updatedAt: '', updatedBy: 'pat', secretVersion: 'a1b2c3d4-0000-4000-8000-00000000000a', team: { name: 'A', slug: 'team-a' } } };
    await store.putTelemetry(55, teamA, 0);
    // The first answer is lost; the key is rotated to team B in the same region; start is asked again.
    await handle({ action: 'start', jobId: job.jobId, token });
    await store.putTelemetry(55, { ...teamA, key: { ...teamA.key, secretVersion: 'a1b2c3d4-0000-4000-8000-00000000000b', team: { name: 'B', slug: 'team-b' } } }, 1);
    const replay = await handle({ action: 'start', jobId: job.jobId, token });
    expect(replay).toMatchObject({ descriptor: { telemetry: { secretVersion: 'a1b2c3d4-0000-4000-8000-00000000000a' } } });
    await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'succeeded', detail: { telemetry: { traceId: 'ab'.repeat(16), spans: 3, exported: 3, failed: 0, sentTo: { provider: 'honeycomb', host: 'api.honeycomb.io' } } } });
    expect((await store.getJobSummary(55, job.jobId))?.detail?.telemetry?.destination).toMatchObject({ team: { slug: 'team-a' } });
  });

  it('hands a custom destination to the job as saved with its key: endpoint and header, the same secret', async () => {
    await store.putTelemetry(
      55,
      { provider: 'otlp', region: 'us', serviceName: 'updraft', captureContent: false, enabled: true, updatedAt: '', updatedBy: 'pat', otlp: { endpoint: 'https://otlp.example.com', header: 'authorization' }, key: { updatedAt: '', updatedBy: 'pat', secretVersion: 'a1b2c3d4-0000-4000-8000-000000000001' } },
      0,
    );
    const out = await handle({ action: 'start', jobId: job.jobId, token });
    expect(out).toMatchObject({
      descriptor: { telemetry: { provider: 'otlp', endpoint: 'https://otlp.example.com', header: 'authorization', secret: 'updraft/tenants/55/agent-keys/HONEYCOMB_API_KEY', secretVersion: 'a1b2c3d4-0000-4000-8000-000000000001' } },
    });
    expect(out.ok && 'descriptor' in out && Object.values(out.descriptor.agentKeySecrets)).not.toContain('updraft/tenants/55/agent-keys/HONEYCOMB_API_KEY');
  });

  it('hands CloudWatch to the job as its endpoint and header, like a custom destination', async () => {
    await store.putTelemetry(
      55,
      { provider: 'cloudwatch', region: 'us', serviceName: 'updraft', captureContent: false, enabled: true, updatedAt: '', updatedBy: 'pat', aws: { region: 'us-west-2' }, otlp: { endpoint: 'https://xray.us-west-2.amazonaws.com', header: 'authorization' }, key: { updatedAt: '', updatedBy: 'pat' } },
      0,
    );
    expect(await handle({ action: 'start', jobId: job.jobId, token })).toMatchObject({
      descriptor: { telemetry: { provider: 'cloudwatch', endpoint: 'https://xray.us-west-2.amazonaws.com', header: 'authorization', secret: 'updraft/tenants/55/agent-keys/HONEYCOMB_API_KEY' } },
    });
  });

  it("records a key's use only for the agents that ran, and every key when the runner does not say", async () => {
    const both = { ...job, agentKeys: ['ANTHROPIC_API_KEY', 'CODEX_API_KEY'] };
    await store.putJob(both);
    for (const name of ['ANTHROPIC_API_KEY', 'CODEX_API_KEY']) await store.putAgentKeyMeta(55, { name, updatedAt: new Date(NOW - 60_000).toISOString(), updatedBy: 'pat' });
    await handle({ action: 'start', jobId: job.jobId, token });
    await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'failed', detail: { adapters: ['claude', 'gemini'] } });
    const used = async () => Object.fromEntries((await store.listAgentKeyMeta(55)).map((k) => [k.name, k.lastUsedAt !== undefined]));
    expect(await used()).toEqual({ ANTHROPIC_API_KEY: true, CODEX_API_KEY: false });
    expect((await store.getJobSummary(55, job.jobId))?.detail?.adapters).toEqual(['claude']);
    // A runner from before the report: every key the job was handed counts, but an unchecked one.
    await store.putAgentKeyMeta(55, { name: 'KIRO_API_KEY', updatedAt: new Date(NOW - 60_000).toISOString(), updatedBy: 'pat' });
    const older = { ...both, jobId: 'job_abc12346', deliveryId: 'd-2', agentKeys: ['ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'KIRO_API_KEY'] };
    await store.putJob(older);
    await handle({ action: 'start', jobId: older.jobId, token });
    await handle({ action: 'finish', jobId: older.jobId, token, outcome: 'succeeded' });
    expect(await used()).toEqual({ ANTHROPIC_API_KEY: true, CODEX_API_KEY: true, KIRO_API_KEY: false });
    // A job that ran no agent: none of its keys.
    const noop = { ...older, jobId: 'job_abc12347', deliveryId: 'd-3' };
    await store.putJob(noop);
    await handle({ action: 'start', jobId: noop.jobId, token });
    await handle({ action: 'finish', jobId: noop.jobId, token, outcome: 'succeeded', detail: { updraftOutcome: 'nothing-to-do', adapters: [] } });
    expect(await used()).toEqual({ ANTHROPIC_API_KEY: true, CODEX_API_KEY: true, KIRO_API_KEY: false });
  });

  it('keeps the trace a finish reports, and records how the export went', async () => {
    await store.putTelemetry(55, { provider: 'honeycomb', region: 'us', serviceName: 'updraft', captureContent: false, enabled: true, updatedAt: '', updatedBy: 'pat', key: { updatedAt: '', updatedBy: 'pat' } }, 0);
    await handle({ action: 'start', jobId: job.jobId, token });
    const traceId = 'ab'.repeat(16);
    await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'succeeded', detail: { telemetry: { traceId, spans: 40, exported: 38, failed: 2, lastError: 'HTTP 503', startedAt: '2026-11-20T12:00:00.000Z' } } });
    expect((await store.getJobSummary(55, job.jobId))?.detail?.telemetry).toEqual({ traceId, spans: 40, exported: 38, failed: 2, lastError: 'HTTP 503', startedAt: '2026-11-20T12:00:00.000Z' });
    expect((await store.getTelemetry(55))?.lastExport).toMatchObject({ jobId: job.jobId, traceId, exported: 38, failed: 2, lastError: 'HTTP 503' });
  });

  it("keeps the links of the destination the job sent to, never the runner's own, and the settings page's too", async () => {
    const honeycomb = { provider: 'honeycomb' as const, region: 'us' as const, serviceName: 'updraft', captureContent: false, enabled: true, updatedAt: '', updatedBy: 'pat', key: { updatedAt: '', updatedBy: 'pat', team: { name: 'Acme', slug: 'acme' }, environment: { name: 'Prod', slug: 'prod' } } };
    await store.putTelemetry(55, honeycomb, 0);
    await handle({ action: 'start', jobId: job.jobId, token });
    const traceId = 'ab'.repeat(16);
    const planted = { provider: 'otlp', region: 'us', serviceName: 'updraft', links: { trace: 'https://evil.example.com/{trace_id}' } };
    await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'succeeded', detail: { telemetry: { traceId, spans: 3, exported: 3, failed: 0, sentTo: { provider: 'honeycomb', host: 'api.honeycomb.io' }, destination: planted } } });
    const kept = (await store.getJobSummary(55, job.jobId))?.detail?.telemetry;
    expect(kept?.destination).toEqual({ provider: 'honeycomb', region: 'us', serviceName: 'updraft', team: { name: 'Acme', slug: 'acme' }, environment: { name: 'Prod', slug: 'prod' } });
    expect((await store.getTelemetry(55))?.lastExport?.destination).toMatchObject({ provider: 'honeycomb', team: { slug: 'acme' } });
    // The settings move to CloudWatch: the last export is still Honeycomb's trace, linked there.
    const latest = (await store.getTelemetry(55))!;
    expect(await store.putTelemetry(55, { ...latest, provider: 'cloudwatch', aws: { region: 'us-east-1' }, otlp: { endpoint: 'https://xray.us-east-1.amazonaws.com', header: 'authorization' } }, latest.version ?? 0)).toBe('stored');
    expect(telemetryView(await store.getTelemetry(55)).lastExport?.traceUrl).toMatch(/^https:\/\/ui\.honeycomb\.io\/acme\//);
  });

  it('links the trace from the destination its descriptor named, whatever changed during the job', async () => {
    const teamA = { provider: 'honeycomb' as const, region: 'us' as const, serviceName: 'updraft', captureContent: false, enabled: true, updatedAt: '', updatedBy: 'pat', key: { updatedAt: '', updatedBy: 'pat', secretVersion: 'a1b2c3d4-0000-4000-8000-00000000000a', team: { name: 'A', slug: 'team-a' }, environment: { name: 'Prod', slug: 'prod' } } };
    await store.putTelemetry(55, teamA, 0);
    await handle({ action: 'start', jobId: job.jobId, token });
    expect((await store.getJob(job.jobId))?.telemetrySnapshot?.links).toMatchObject({ provider: 'honeycomb', team: { slug: 'team-a' } });
    // A same-region key of another team, saved while the job runs: the same API host.
    await store.putTelemetry(55, { ...teamA, key: { ...teamA.key, secretVersion: 'a1b2c3d4-0000-4000-8000-00000000000b', team: { name: 'B', slug: 'team-b' }, environment: { name: 'Dev', slug: 'dev' } } }, 1);
    await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'succeeded', detail: { telemetry: { traceId: 'ab'.repeat(16), spans: 3, exported: 3, failed: 0, sentTo: { provider: 'honeycomb', host: 'api.honeycomb.io' } } } });
    expect((await store.getJobSummary(55, job.jobId))?.detail?.telemetry?.destination).toMatchObject({ team: { slug: 'team-a' }, environment: { slug: 'prod' } });
  });

  it('keeps the links of a trace whose destination was replaced by another kind during the job', async () => {
    await store.putTelemetry(55, { provider: 'honeycomb', region: 'us', serviceName: 'updraft', captureContent: false, enabled: true, updatedAt: '', updatedBy: 'pat', key: { updatedAt: '', updatedBy: 'pat', team: { name: 'A', slug: 'team-a' } } }, 0);
    await handle({ action: 'start', jobId: job.jobId, token });
    const latest = (await store.getTelemetry(55))!;
    await store.putTelemetry(55, { ...latest, provider: 'cloudwatch', aws: { region: 'us-east-1' }, otlp: { endpoint: 'https://xray.us-east-1.amazonaws.com', header: 'authorization' } }, latest.version ?? 0);
    await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'succeeded', detail: { telemetry: { traceId: 'ab'.repeat(16), spans: 3, exported: 3, failed: 0, sentTo: { provider: 'honeycomb', host: 'api.honeycomb.io' } } } });
    expect((await store.getJobSummary(55, job.jobId))?.detail?.telemetry?.destination).toMatchObject({ provider: 'honeycomb', team: { slug: 'team-a' } });
  });

  it('keeps no links when the runner sent somewhere the settings do not say', async () => {
    await store.putTelemetry(55, { provider: 'honeycomb', region: 'us', serviceName: 'updraft', captureContent: false, enabled: true, updatedAt: '', updatedBy: 'pat', key: { updatedAt: '', updatedBy: 'pat', team: { name: 'Acme', slug: 'acme' } } }, 0);
    await handle({ action: 'start', jobId: job.jobId, token });
    await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'succeeded', detail: { telemetry: { traceId: 'cd'.repeat(16), spans: 3, exported: 3, failed: 0, sentTo: { provider: 'cloudwatch', host: 'xray.us-east-1.amazonaws.com' } } } });
    expect((await store.getJobSummary(55, job.jobId))?.detail?.telemetry?.destination).toBeUndefined();
  });

  it('keeps a local reading of the job for the console, and records no export for it', async () => {
    await store.putTelemetry(55, { provider: 'honeycomb', region: 'us', serviceName: 'updraft', captureContent: false, enabled: false, updatedAt: '', updatedBy: 'pat' }, 0);
    await handle({ action: 'start', jobId: job.jobId, token });
    const traceId = 'cd'.repeat(16);
    const totals = { runs: 1, inputTokens: 10, outputTokens: 5, toolCalls: 2, toolErrors: 0, thrashing: false, durationMs: 9000 };
    await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'succeeded', detail: { telemetry: { traceId, spans: 12, exported: 0, failed: 0, local: true, totals } } });
    expect((await store.getJobSummary(55, job.jobId))?.detail?.telemetry).toMatchObject({ traceId, local: true, totals });
    expect((await store.getTelemetry(55))?.lastExport).toBeUndefined();
  });

  it('refuses a wrong token, an unknown job and malformed input with the same answer', async () => {
    const wrong = await handle({ action: 'start', jobId: job.jobId, token: randomBytes(32).toString('base64url') });
    const unknown = await handle({ action: 'start', jobId: 'job_nobody00', token });
    const short = await handle({ action: 'start', jobId: job.jobId, token: 'short' });
    expect([wrong, unknown, short]).toEqual([{ ok: false, error: 'refused' }, { ok: false, error: 'refused' }, { ok: false, error: 'refused' }]);
    expect(await handle({ action: 'delete-everything', jobId: job.jobId, token })).toEqual({ ok: false, error: 'bad_request' });
    expect(await handle(null)).toEqual({ ok: false, error: 'bad_request' });
    expect(assumeRole).not.toHaveBeenCalled();
  });

  it('serves nothing once the job is finished or past its maximum duration', async () => {
    clock = job.expiresAt + 1;
    expect(await handle({ action: 'credentials', jobId: job.jobId, token })).toEqual({ ok: false, error: 'refused' });
    clock = NOW;
    expect(await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'succeeded' })).toEqual({ ok: true, finished: true });
    expect((await store.getJob(job.jobId))?.outcome).toBe('succeeded');
    expect(await handle({ action: 'github-token', jobId: job.jobId, token })).toEqual({ ok: false, error: 'refused' });
    // A repeated finish is answered (it may be a retry) but changes nothing: the first outcome stands.
    expect(await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'failed' })).toEqual({ ok: true, finished: true });
    expect((await store.getJob(job.jobId))?.outcome).toBe('succeeded');
  });

  it('serves nothing for a tenant that is suspended or uninstalled', async () => {
    await store.setSuspended(55, true);
    expect(await handle({ action: 'start', jobId: job.jobId, token })).toEqual({ ok: false, error: 'refused' });
    await store.setSuspended(55, false);
    await store.markUninstalled(55, NOW + 1000);
    expect(await handle({ action: 'github-token', jobId: job.jobId, token })).toEqual({ ok: false, error: 'refused' });
  });

  it('records the finish that stuck on the job\'s workflow, once', async () => {
    const workflows = createMemoryWorkflowStore();
    const recorder = createWorkflowRecorder({ store: workflows, now: () => clock, log: () => {} });
    job = { ...job, issue: 7 };
    await store.putJob(job);
    handle = createBroker({ store, loadSettings: async () => SETTINGS, github, assumeRole, terminateMicrovm, microvmState, stopCheckDelayMs: 1, policy: POLICY, now: () => clock, workflows: recorder });
    await handle({ action: 'start', jobId: job.jobId, token });
    await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'succeeded', detail: { prUrl: 'https://github.com/acme/web/pull/12', prNumber: 12, loop: { rounds: 0, reviews: 1, stage: 'waiting-for-ci' } } });
    expect(await workflows.getWorkflow(55, '99-i7')).toMatchObject({ status: 'waiting', stage: 'waiting-for-ci', pullRequest: 12 });
    expect(await workflows.workflowOfPullRequest(55, 99, 12)).toBe('99-i7');
    // A repeated finish with another outcome does not change what was recorded.
    await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'failed' });
    expect(await workflows.getWorkflow(55, '99-i7')).toMatchObject({ status: 'waiting', stage: 'waiting-for-ci' });
  });

  it('mints an installation token for the job\'s repository only, as a token file the CLI reads', async () => {
    await handle({ action: 'start', jobId: job.jobId, token });
    const r = await handle({ action: 'github-token', jobId: job.jobId, token });
    expect(github.createInstallationToken).toHaveBeenCalledWith(expect.any(String), 55, { repositoryIds: [99], permissions: JOB_PERMISSIONS });
    expect(r.ok && 'tokenFile' in r).toBe(true);
    if (!r.ok || !('tokenFile' in r)) return;
    const path = join(mkdtempSync(join(tmpdir(), 'broker-token-')), 'app-token.json');
    writeFileSync(path, JSON.stringify(r.tokenFile));
    expect(loadTokenFile(path)).toEqual({
      app: { id: 4242, slug: 'updraft' },
      installationId: 55,
      token: 'ghs_4242_scoped',
      expiresAt: NOW + 3_600_000,
      permissions: JOB_PERMISSIONS,
      repositories: ['acme/web'],
      bot: { id: 777, login: 'updraft[bot]' },
    });
    // The bot user is looked up once.
    await handle({ action: 'github-token', jobId: job.jobId, token });
    expect(github.getBotUser).toHaveBeenCalledOnce();
  });

  it('gives a CI fix Actions read for its logs, where the installation grants it, and no other job', async () => {
    expect(OPTIONAL_JOB_PERMISSIONS).toEqual({ actions: 'read' });
    job = { ...job, jobId: 'job_ci123456', eventName: 'check_suite' };
    await store.putJob(job);
    await handle({ action: 'start', jobId: job.jobId, token });
    await handle({ action: 'github-token', jobId: job.jobId, token });
    expect(github.createInstallationToken).toHaveBeenLastCalledWith(expect.any(String), 55, { repositoryIds: [99], permissions: { ...JOB_PERMISSIONS, actions: 'read' } });

    // An installation that has not accepted Actions read: GitHub refuses the request (422), and
    // the job gets the ordinary permissions; the fix reads annotations and summaries.
    github.createInstallationToken.mockReset()
      .mockRejectedValueOnce(new GitHubError(422, 'POST /app/installations/access_tokens failed (422)'))
      .mockResolvedValueOnce({ token: 'ghs_plain', expiresAt: NOW + 3_600_000, permissions: JOB_PERMISSIONS });
    const r = await handle({ action: 'github-token', jobId: job.jobId, token });
    expect(r.ok && 'tokenFile' in r && r.tokenFile.token).toBe('ghs_plain');
    expect(github.createInstallationToken).toHaveBeenLastCalledWith(expect.any(String), 55, { repositoryIds: [99], permissions: JOB_PERMISSIONS });

    // Any other failure is not retried with less.
    github.createInstallationToken.mockReset().mockRejectedValueOnce(new GitHubError(500, 'boom'));
    await expect(handle({ action: 'github-token', jobId: job.jobId, token })).rejects.toThrow('boom');
    expect(github.createInstallationToken).toHaveBeenCalledOnce();
  });

  it('reads the tenant strongly consistently, so a suspend that has committed stops the next request', async () => {
    const getTenant = vi.spyOn(store, 'getTenant');
    await handle({ action: 'credentials', jobId: job.jobId, token });
    expect(getTenant).toHaveBeenCalledWith(55, { consistent: true });
  });

  it("stops only the job's own recorded microVM, for its token, whatever the job's state", async () => {
    // Not recorded yet: nothing to stop.
    expect(await handle({ action: 'terminate', jobId: job.jobId, token })).toEqual({ ok: false, error: 'unavailable' });
    expect(await store.attachMicrovm(job.jobId, 'mvm-own')).toBe(true);
    // Recorded once: a second launch record cannot point the job at another microVM.
    expect(await store.attachMicrovm(job.jobId, 'mvm-other')).toBe(false);
    expect(await store.attachMicrovm('job_nobody00', 'mvm-other')).toBe(false);

    const wrong = await handle({ action: 'terminate', jobId: job.jobId, token: randomBytes(32).toString('base64url') });
    expect(wrong).toEqual({ ok: false, error: 'refused' });
    expect(terminateMicrovm).not.toHaveBeenCalled();

    // After finish, and with the tenant suspended, the job can still stop its own microVM.
    await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'succeeded' });
    await store.setSuspended(55, true);
    expect(await handle({ action: 'terminate', jobId: job.jobId, token, microvmId: 'mvm-other' })).toEqual({ ok: true, terminated: true });
    expect(terminateMicrovm).toHaveBeenCalledExactlyOnceWith('mvm-own');
  });

  it("gives up the delivery's claim unless the job succeeded, so a redelivery retries a failed job", async () => {
    const later = Date.now() + 3_600_000;
    await store.claimDelivery(55, 'd-1', later, job.jobId);
    await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'succeeded' });
    expect(await store.claimDelivery(55, 'd-1', later, 'job_next0001')).toBe(false);

    const other = { ...job, jobId: 'job_def67890', deliveryId: 'd-2' };
    await store.putJob(other);
    await store.claimDelivery(55, 'd-2', later, other.jobId);
    await handle({ action: 'finish', jobId: other.jobId, token, outcome: 'unconfirmed' });
    expect(await store.claimDelivery(55, 'd-2', later, 'job_next0001')).toBe(true);
  });

  it('a finish retried after the claim release failed releases it then', async () => {
    const later = Date.now() + 3_600_000;
    await store.claimDelivery(55, 'd-1', later, job.jobId);
    const release = store.releaseDelivery.bind(store);
    store.releaseDelivery = vi.fn().mockRejectedValueOnce(new Error('throttled')).mockImplementation(release);
    await expect(handle({ action: 'finish', jobId: job.jobId, token, outcome: 'failed' })).rejects.toThrow('throttled');
    // The outcome is recorded, the claim is still held: the runner retries finish.
    expect((await store.getJob(job.jobId))?.status).toBe('finished');
    expect(await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'failed' })).toEqual({ ok: true, finished: true });
    expect(await store.claimDelivery(55, 'd-1', later, 'job_next0001')).toBe(true);
  });

  it("a late finish from an earlier job never releases the redelivery's claim", async () => {
    const later = Date.now() + 3_600_000;
    await store.claimDelivery(55, 'd-1', later, job.jobId);
    await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'failed' });
    // The redelivery started a new job, which holds the claim now.
    expect(await store.claimDelivery(55, 'd-1', later, 'job_next0001')).toBe(true);
    // The first job's finish, retried late (or concurrently), leaves that claim alone.
    expect(await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'failed' })).toEqual({ ok: true, finished: true });
    expect(await store.claimDelivery(55, 'd-1', later, 'job_third001')).toBe(false);
  });

  it('records the finish of a job whose tenant was suspended, and releases its claim', async () => {
    const later = Date.now() + 3_600_000;
    await store.claimDelivery(55, 'd-1', later, job.jobId);
    await store.setSuspended(55, true);
    expect(await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'start_failed' })).toEqual({ ok: true, finished: true });
    expect((await store.getJob(job.jobId))?.outcome).toBe('start_failed');
    expect(await store.claimDelivery(55, 'd-1', later, 'job_next0001')).toBe(true);
  });

  describe("start holds the delivery's claim (the launcher's is short)", () => {
    // The memory store's claims expire by the real clock: run these on it.
    beforeEach(async () => {
      clock = Date.now();
      job = { ...job, expiresAt: clock + 3_600_000 };
      await store.putJob(job);
    });

    it('extends the claim to the job\'s lifetime, so a redelivery is still a duplicate', async () => {
      await store.claimDelivery(55, 'd-1', clock + 60_000, job.jobId);
      expect((await handle({ action: 'start', jobId: job.jobId, token })).ok).toBe(true);
      clock += 120_000;
      expect(await store.claimDelivery(55, 'd-1', Date.now() + 120_000, 'job_next0001')).toBe(false);
      await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'failed' });
      expect(await store.claimDelivery(55, 'd-1', Date.now() + 120_000, 'job_next0001')).toBe(true);
    });

    it('takes the claim back when it ran out and nobody else took it', async () => {
      await store.claimDelivery(55, 'd-1', clock - 1_000, job.jobId);
      expect((await handle({ action: 'start', jobId: job.jobId, token })).ok).toBe(true);
      expect(await store.claimDelivery(55, 'd-1', Date.now() + 120_000, 'job_next0001')).toBe(false);
    });

    it("refuses to start once a redelivery's job holds the claim, and finishes this one as superseded", async () => {
      await store.claimDelivery(55, 'd-1', clock - 1_000, job.jobId);
      expect(await store.claimDelivery(55, 'd-1', Date.now() + 120_000, 'job_next0001')).toBe(true);
      expect(await handle({ action: 'start', jobId: job.jobId, token })).toEqual({ ok: false, error: 'refused' });
      expect(assumeRole).not.toHaveBeenCalled();
      expect((await store.getJob(job.jobId))?.outcome).toBe('superseded');
      // The runner's own finish then changes nothing, and leaves the redelivery's claim alone.
      await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'start_failed' });
      expect((await store.getJob(job.jobId))?.outcome).toBe('superseded');
      expect(await store.claimDelivery(55, 'd-1', Date.now() + 120_000, 'job_third001')).toBe(false);
    });
  });

  describe('quotas and the kill switch', () => {
    const QUOTAS = { concurrentJobs: 1, jobsPerDay: 100, microvmMinutesPerMonth: 100_000, platformConcurrentJobs: 10 };
    const month = () => job.createdAt.slice(0, 7);

    // The memory store's slots and claims expire by the real clock: run these on it.
    beforeEach(async () => {
      clock = Date.now();
      const reserved = await store.reserveJob({ installationId: 55, jobId: job.jobId, holdUntil: clock + 60_000, day: '2026-11-20', month: month(), quotas: QUOTAS });
      if (!reserved.ok) throw new Error('not reserved');
      job = { ...job, createdAt: new Date(clock).toISOString(), expiresAt: clock + 3_600_000, tenantSlot: reserved.tenantSlot, platformSlot: reserved.platformSlot, reservedSeconds: 3600 };
      await store.putJob(job);
      await store.markLaunching(job.jobId);
      await store.claimDelivery(55, 'd-1', clock + 60_000, job.jobId);
    });

    it('serves nothing but finish and terminate while the kill switch is on', async () => {
      let engaged = true;
      handle = createBroker({ store, loadSettings: async () => SETTINGS, github, assumeRole, terminateMicrovm, microvmState, stopCheckDelayMs: 1, policy: POLICY, now: () => clock, killSwitch: { engaged: async () => engaged } });
      await store.attachMicrovm(job.jobId, 'mvm-0001');
      for (const action of ['start', 'credentials', 'github-token']) {
        expect(await handle({ action, jobId: job.jobId, token })).toEqual({ ok: false, error: 'refused' });
      }
      expect(assumeRole).not.toHaveBeenCalled();
      engaged = false;
      expect((await handle({ action: 'start', jobId: job.jobId, token })).ok).toBe(true);
      engaged = true;
      expect(await handle({ action: 'credentials', jobId: job.jobId, token })).toEqual({ ok: false, error: 'refused' });
      expect(await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'cancelled' })).toEqual({ ok: true, finished: true });
      expect(await handle({ action: 'terminate', jobId: job.jobId, token })).toEqual({ ok: true, terminated: true });
    });

    it('charges the maximum duration at start; only a microVM Lambda shows terminated frees the slot and refunds the rest', async () => {
      await store.attachMicrovm(job.jobId, 'mvm-0001');
      expect((await handle({ action: 'start', jobId: job.jobId, token })).ok).toBe(true);
      expect((await store.getUsage(55, '2026-11-20', month())).microvmSecondsThisMonth).toBe(3600);
      // The slot is held for the job's lifetime: another job of the tenant cannot have it.
      const other = { installationId: 55, jobId: 'job_other001', holdUntil: Date.now() + 60_000, day: '2026-11-20', month: month(), quotas: QUOTAS };
      expect(await store.reserveJob(other)).toEqual({ ok: false, limit: 'concurrent_jobs' });

      // Finishing records the outcome only: the microVM may still be running.
      clock += 600_000;
      await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'succeeded' });
      expect((await store.getUsage(55, '2026-11-20', month())).microvmSecondsThisMonth).toBe(3600);
      expect(await store.reserveJob(other)).toEqual({ ok: false, limit: 'concurrent_jobs' });

      // TERMINATING is not enough (Lambda runs the /terminate hook first), nor is a failed terminate.
      microvmState.mockResolvedValue('TERMINATING');
      expect(await handle({ action: 'terminate', jobId: job.jobId, token })).toEqual({ ok: true, terminated: true });
      expect(microvmState).toHaveBeenCalledTimes(4);
      terminateMicrovm.mockRejectedValueOnce(new Error('throttled'));
      await expect(handle({ action: 'terminate', jobId: job.jobId, token })).rejects.toThrow('throttled');
      expect(await store.reserveJob(other)).toEqual({ ok: false, limit: 'concurrent_jobs' });
      expect((await store.getUsage(55, '2026-11-20', month())).microvmSecondsThisMonth).toBe(3600);

      // Reconciliation, later: TERMINATED releases it once, and refunds what it did not use.
      const reconcile = createReconciler({ store, microvmState, now: () => clock, log: () => {} });
      expect(await reconcile()).toEqual({ released: [], held: 1, failed: 0 });
      microvmState.mockResolvedValue('TERMINATED');
      expect(await reconcile()).toEqual({ released: [job.jobId], held: 0, failed: 0 });
      const used = (await store.getUsage(55, '2026-11-20', month())).microvmSecondsThisMonth;
      // Ten minutes by the broker's clock (the store marks the start by the real one).
      expect(used).toBeGreaterThanOrEqual(600);
      expect(used).toBeLessThan(610);
      expect(await store.reserveJob(other)).toMatchObject({ ok: true });

      // Nothing is refunded twice: not by another terminate, not by another run.
      microvmState.mockResolvedValue(null);
      await handle({ action: 'terminate', jobId: job.jobId, token });
      await reconcile();
      expect((await store.getUsage(55, '2026-11-20', month())).microvmSecondsThisMonth).toBe(used);
    });

    it('a terminate retires the job whatever its outcome: a delayed start or a credentials request gets nothing', async () => {
      await store.attachMicrovm(job.jobId, 'mvm-0001');
      microvmState.mockResolvedValue('RUNNING');
      // A runner whose finish never landed: terminate alone retires the job.
      await handle({ action: 'terminate', jobId: job.jobId, token });
      expect(await handle({ action: 'start', jobId: job.jobId, token })).toEqual({ ok: false, error: 'refused' });
      expect((await store.getUsage(55, '2026-11-20', month())).microvmSecondsThisMonth).toBe(0);

      // One that started: no credentials or token after the terminate.
      const started = { ...job, jobId: 'job_started01', tokenHash: hashToken('y'.repeat(43)), deliveryId: 'd-2', tenantSlot: undefined, platformSlot: undefined };
      await store.putJob(started);
      expect((await handle({ action: 'start', jobId: started.jobId, token: 'y'.repeat(43) })).ok).toBe(true);
      await store.attachMicrovm(started.jobId, 'mvm-0002');
      await handle({ action: 'terminate', jobId: started.jobId, token: 'y'.repeat(43) });
      for (const action of ['credentials', 'github-token']) {
        expect(await handle({ action, jobId: started.jobId, token: 'y'.repeat(43) })).toEqual({ ok: false, error: 'refused' });
      }
    });

    it('serves credentials and tokens only to a job whose start committed', async () => {
      for (const action of ['credentials', 'github-token']) {
        expect(await handle({ action, jobId: job.jobId, token })).toEqual({ ok: false, error: 'refused' });
      }
      expect(assumeRole).not.toHaveBeenCalled();
      expect(github.createInstallationToken).not.toHaveBeenCalled();
      expect((await handle({ action: 'start', jobId: job.jobId, token })).ok).toBe(true);
      expect((await handle({ action: 'credentials', jobId: job.jobId, token })).ok).toBe(true);
      expect((await handle({ action: 'github-token', jobId: job.jobId, token })).ok).toBe(true);
    });

    it('refuses a start whose month was spent by another launch, and says so on the issue once', async () => {
      const notices: unknown[] = [];
      handle = createBroker({
        store,
        loadSettings: async () => SETTINGS,
        github,
        assumeRole,
        terminateMicrovm,
        microvmState,
        policy: POLICY,
        now: () => clock,
        notifyThrottled: async (n) => void notices.push(n),
      });
      job = { ...job, issue: 12, quotas: { ...QUOTAS, microvmMinutesPerMonth: 60 } };
      await store.putJob(job);
      // Another job of the tenant started first and was charged its hour: the month is spent.
      const spent = { ...job, jobId: 'job_first0001', tokenHash: hashToken('x'.repeat(43)), deliveryId: 'd-0', tenantSlot: undefined, platformSlot: undefined };
      await store.putJob(spent);
      expect((await store.startJob(spent, clock + 3_600_000)).result).toBe('started');

      await store.attachMicrovm(job.jobId, 'mvm-0001');
      microvmState.mockResolvedValue('RUNNING');
      expect(await handle({ action: 'start', jobId: job.jobId, token })).toEqual({ ok: false, error: 'refused' });
      expect((await store.getJob(job.jobId))?.outcome).toBe('throttled');
      // Its microVM is asked to stop, and keeps its slot until Lambda shows it terminated.
      expect(terminateMicrovm).toHaveBeenCalledWith('mvm-0001');
      const next = { installationId: 55, jobId: 'job_next0002', holdUntil: Date.now() + 60_000, day: '2026-11-20', month: month(), quotas: QUOTAS };
      expect(await store.reserveJob(next)).toEqual({ ok: false, limit: 'concurrent_jobs' });
      const reconcile = createReconciler({ store, microvmState, now: () => clock, log: () => {} });
      await reconcile();
      expect(await store.reserveJob(next)).toEqual({ ok: false, limit: 'concurrent_jobs' });
      microvmState.mockResolvedValue('TERMINATED');
      await reconcile();
      expect(await store.reserveJob(next)).toMatchObject({ ok: true });
      expect(notices).toEqual([{ installationId: 55, repository: 'acme/web', repositoryId: 99, issue: 12, limit: 'microvm_minutes', quotas: job.quotas }]);
      expect((await store.getUsage(55, '2026-11-20', month())).throttledThisMonth).toBe(1);
      // It was charged nothing, and its claim is free for a redelivery.
      expect((await store.getUsage(55, '2026-11-20', month())).microvmSecondsThisMonth).toBe(3600);
      expect(await store.claimDelivery(55, 'd-1', Date.now() + 60_000, 'job_next0001')).toBe(true);
    });

    it("refuses to start a job whose slot another job took after its own ran out, and gives up its claim", async () => {
      await store.releaseJobSlots(job);
      const other = await store.reserveJob({ installationId: 55, jobId: 'job_other001', holdUntil: Date.now() + 60_000, day: '2026-11-20', month: month(), quotas: QUOTAS });
      expect(other).toMatchObject({ ok: true, tenantSlot: job.tenantSlot });
      expect(await handle({ action: 'start', jobId: job.jobId, token })).toEqual({ ok: false, error: 'refused' });
      expect((await store.getJob(job.jobId))?.outcome).toBe('throttled');
      expect((await store.getUsage(55, '2026-11-20', month())).microvmSecondsThisMonth).toBe(0);
      // Re-applying the label, or redelivering this one, can start it again.
      expect(await store.claimDelivery(55, 'd-1', Date.now() + 60_000, 'job_next0001')).toBe(true);
    });
  });

  it('refuses a finish with the wrong token', async () => {
    const r = await handle({ action: 'finish', jobId: job.jobId, token: randomBytes(32).toString('base64url'), outcome: 'failed' });
    expect(r).toEqual({ ok: false, error: 'refused' });
    expect((await store.getJob(job.jobId))?.status).toBe('launched');
  });

  it('keeps an unexpected outcome out of the record', async () => {
    await handle({ action: 'finish', jobId: job.jobId, token, outcome: 'DROP TABLE; --' });
    expect((await store.getJob(job.jobId))?.outcome).toBe('unknown');
  });
});

describe('jobAgentKeys', () => {
  it("is the job's recorded keys; a native job's never the Anthropic key; null for an ordinary job recorded without them", () => {
    expect(jobAgentKeys({ agentKeys: ['ANTHROPIC_API_KEY', 'CODEX_API_KEY'] })).toEqual(['ANTHROPIC_API_KEY', 'CODEX_API_KEY']);
    expect(jobAgentKeys({ agentKeys: [] })).toEqual([]);
    expect(jobAgentKeys({})).toBeNull();
    expect(jobAgentKeys({ native: { workerId: 'w' }, agentKeys: ['ANTHROPIC_API_KEY', 'CODEX_API_KEY'] })).toEqual(['CODEX_API_KEY']);
    expect(jobAgentKeys({ native: { workerId: 'w' } })).toEqual([]);
    expect(jobAgentKeys({ benchmark: {} as NonNullable<Job['benchmark']> })).toEqual([]);
  });
});

describe('jobSessionPolicy', () => {
  it('lists the job\'s own config version and state, and nothing broader', () => {
    const policy = jobSessionPolicy({ installationId: 7, configVersion: 12, deliveryId: 'abc' }, POLICY);
    const list = policy.Statement.find((s) => s.Action === 's3:ListBucket') as { Condition: { StringLike: { 's3:prefix': string[] } } };
    expect(list.Condition.StringLike['s3:prefix']).toEqual(['tenants/7/config/12/*', 'tenants/7/state/*']);
    expect(jobPaths({ installationId: 7, configVersion: 12, deliveryId: 'abc' }).configPrefix).toBe('tenants/7/config/12/');
  });
});
