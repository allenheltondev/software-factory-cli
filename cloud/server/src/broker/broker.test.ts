import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The CLI's own reader of the token file: what the broker hands out must be what the job reads.
import { loadTokenFile } from '../../../../src/github/token-file-auth.js';
import type { AppSettings } from '../github/settings.js';
import { createMemoryStore, type Job, type Tenant } from '../store/store.js';
import { createBroker, hashToken, JOB_PERMISSIONS, jobPaths, jobSessionPolicy, SESSION_SECONDS } from './broker.js';

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
    handle = createBroker({ store, loadSettings: async () => SETTINGS, github, assumeRole, terminateMicrovm, policy: POLICY, now: () => clock });
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

  it('mints an installation token for the job\'s repository only, as a token file the CLI reads', async () => {
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

describe('jobSessionPolicy', () => {
  it('lists the job\'s own config version and state, and nothing broader', () => {
    const policy = jobSessionPolicy({ installationId: 7, configVersion: 12, deliveryId: 'abc' }, POLICY);
    const list = policy.Statement.find((s) => s.Action === 's3:ListBucket') as { Condition: { StringLike: { 's3:prefix': string[] } } };
    expect(list.Condition.StringLike['s3:prefix']).toEqual(['tenants/7/config/12/*', 'tenants/7/state/*']);
    expect(jobPaths({ installationId: 7, configVersion: 12, deliveryId: 'abc' }).configPrefix).toBe('tenants/7/config/12/');
  });
});
