import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBroker, hashToken } from '../broker/broker.js';
import { createMemoryStore, type Tenant } from '../store/store.js';
import { dispatchRules } from '../tenants/dispatch.js';
import { createLauncher, type LaunchDeps, type LaunchRequest, type RunMicrovmInput } from './launch.js';

// Relative to the real clock: the memory store judges a delivery claim's expiry by it.
const NOW = Date.now();
const SETTINGS: LaunchDeps['settings'] = {
  region: 'us-east-1',
  bucket: 'tenant-bucket',
  imageArn: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:updraft-cloud-job',
  executionRoleArn: 'arn:aws:iam::123456789012:role/exec',
  ingressConnectorArn: 'arn:in',
  egressConnectorArn: 'arn:out',
  logGroup: '/aws/lambda-microvms/updraft-cloud-job',
  brokerFunctionName: 'updraft-cloud-broker',
  maximumDurationSeconds: 10800,
  watchdogReserveSeconds: 600,
};
const tenant = (status: Tenant['status'] = 'active'): Tenant => ({
  installationId: 55,
  accountId: 900,
  accountLogin: 'acme',
  accountType: 'Organization',
  status,
  createdAt: '2026-11-19T00:00:00.000Z',
  createdBy: 's',
});
const rules = dispatchRules({
  dispatch: { allowedActors: ['pat'] },
  repositories: { 'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }] } },
});

describe('the launcher', () => {
  let store: ReturnType<typeof createMemoryStore>;
  let events: Record<string, string>;
  let runs: RunMicrovmInput[];
  let runMicrovm: LaunchDeps['runMicrovm'];
  let imageVersion: string | null;
  let deps: LaunchDeps;

  const request = (overrides: Partial<LaunchRequest['payload']> = {}, deliveryId = 'delivery-1'): LaunchRequest => {
    const payload = { action: 'labeled', issue: { number: 12 }, label: { name: 'updraft' }, sender: { login: 'pat' }, repository: { id: 9, full_name: 'acme/web' }, ...overrides };
    return { installationId: 55, deliveryId, body: JSON.stringify(payload), payload };
  };

  beforeEach(async () => {
    store = createMemoryStore();
    await store.putTenantWithMember(tenant(), { installationId: 55, sub: 's', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
    const version = await store.createConfigVersion(55, { sha256: 'x', files: ['config.yaml'], publishedBy: 's', publishedAt: '', dispatch: rules });
    await store.markConfigReady(55, version as number);
    await store.activateConfig(55, version as number);
    events = {};
    runs = [];
    imageVersion = '3';
    runMicrovm = async (input) => {
      runs.push(input);
      return { microvmId: 'mvm-0001' };
    };
    deps = {
      store,
      settings: SETTINGS,
      imageVersion: async () => imageVersion,
      putEvent: async (key, body) => {
        events[key] = body;
      },
      runMicrovm: (input) => runMicrovm(input),
      now: () => NOW,
      log: () => {},
      retryDelayMs: 1,
    };
  });

  it('starts a job: the event under its tenant, a pinned job record, a version 2 run hook, and its microVM recorded', async () => {
    const result = await createLauncher(deps)(request());
    expect(result).toMatchObject({ status: 202, disposition: 'launched', jobId: expect.stringMatching(/^job_[A-Za-z0-9_-]{16}$/) });

    expect(Object.keys(events)).toEqual(['tenants/55/events/delivery-1/event.json']);
    expect(JSON.parse(events['tenants/55/events/delivery-1/event.json']!)).toMatchObject({ label: { name: 'updraft' } });

    const job = await store.getJob(result.jobId!);
    expect(job).toMatchObject({
      installationId: 55,
      repository: 'acme/web',
      repositoryId: 9,
      configVersion: 1,
      deliveryId: 'delivery-1',
      eventName: 'issues',
      status: 'launched',
      label: 'updraft',
      sender: 'pat',
      imageVersion: '3',
      microvmId: 'mvm-0001',
      expiresAt: NOW + 10800 * 1000,
    });

    expect(runs).toHaveLength(1);
    const input = runs[0]!;
    expect(input).toMatchObject({
      imageIdentifier: SETTINGS.imageArn,
      imageVersion: '3',
      executionRoleArn: SETTINGS.executionRoleArn,
      ingressNetworkConnectors: ['arn:in'],
      egressNetworkConnectors: ['arn:out'],
      maximumDurationInSeconds: 10800,
      logging: { cloudWatch: { logGroup: SETTINGS.logGroup } },
      idlePolicy: { maxIdleDurationSeconds: 10800, suspendedDurationSeconds: 0, autoResumeEnabled: false },
    });
    const hook = JSON.parse(input.runHookPayload) as Record<string, unknown> & { broker: { jobToken: string; jobId: string } };
    expect(hook).toEqual({
      version: 2,
      deliveryId: 'delivery-1',
      eventName: 'issues',
      region: 'us-east-1',
      broker: { functionName: 'updraft-cloud-broker', jobId: result.jobId, jobToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) },
      maximumDurationSeconds: 10800,
      watchdogReserveSeconds: 600,
      launchedAt: new Date(NOW).toISOString(),
      agentIsolation: 'enforced',
    });
    // Only the token's hash is stored, and it is the one the broker will check.
    expect(job!.tokenHash).toBe(hashToken(hook.broker.jobToken));
    expect(JSON.stringify(job)).not.toContain(hook.broker.jobToken);
  });

  it('gives the job to the broker: the token from the run hook starts it and stops its own microVM', async () => {
    const result = await createLauncher(deps)(request());
    const { jobToken } = (JSON.parse(runs[0]!.runHookPayload) as { broker: { jobToken: string } }).broker;
    const terminateMicrovm = vi.fn(async () => {});
    const broker = createBroker({
      store,
      loadSettings: async () => null,
      github: { createInstallationToken: vi.fn(), getBotUser: vi.fn() },
      assumeRole: async () => ({ accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't', expiration: new Date(NOW + 3_600_000).toISOString() }),
      terminateMicrovm,
      policy: { bucket: 'tenant-bucket', partition: 'aws', region: 'us-east-1', accountId: '123456789012' },
      now: () => NOW,
    });
    expect(await broker({ action: 'start', jobId: result.jobId, token: jobToken })).toMatchObject({
      ok: true,
      descriptor: { eventKey: 'tenants/55/events/delivery-1/event.json', configPrefix: 'tenants/55/config/1/' },
    });
    expect(await broker({ action: 'terminate', jobId: result.jobId, token: jobToken })).toEqual({ ok: true, terminated: true });
    expect(terminateMicrovm).toHaveBeenCalledWith('mvm-0001');
  });

  it.each([
    ['a tenant that is suspended', async () => store.setSuspended(55, true), 'tenant_inactive'],
    ['no tenant', async () => store.markUninstalled(55, NOW).then(() => store.purgeTenantPartition(55)), 'no_tenant'],
  ])('starts nothing for %s', async (_what, arrange, disposition) => {
    await arrange();
    expect(await createLauncher(deps)(request())).toEqual({ status: 200, disposition });
    expect(runs).toEqual([]);
    expect(events).toEqual({});
  });

  it('starts nothing for a tenant without a config, an event its config does not dispatch, or while jobs are off', async () => {
    const launch = createLauncher(deps);
    expect(await launch(request({ label: { name: 'bug' } }))).toEqual({ status: 200, disposition: 'not_dispatched' });
    expect(await launch(request({ sender: { login: 'mallory' } }))).toEqual({ status: 200, disposition: 'not_dispatched' });
    expect(await launch(request({ issue: undefined }))).toEqual({ status: 200, disposition: 'ignored' });
    imageVersion = null;
    expect(await launch(request())).toEqual({ status: 200, disposition: 'jobs_off' });

    const bare = createMemoryStore();
    await bare.putTenantWithMember({ ...tenant(), installationId: 56 }, { installationId: 56, sub: 's', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' });
    expect(await createLauncher({ ...deps, store: bare })({ ...request(), installationId: 56 })).toEqual({ status: 200, disposition: 'no_config' });
    expect(runs).toEqual([]);
  });

  it('starts one job per delivery: a redelivery while it may run is a duplicate', async () => {
    const launch = createLauncher(deps);
    expect((await launch(request())).disposition).toBe('launched');
    expect(await launch(request())).toEqual({ status: 200, disposition: 'duplicate' });
    // Another delivery (another label event) is its own job.
    expect((await launch(request({}, 'delivery-2'))).disposition).toBe('launched');
    expect(runs).toHaveLength(2);
  });

  it('answers 500 when RunMicrovm fails, gives up the claim so the redelivery starts it, and retires the job record', async () => {
    runMicrovm = async () => {
      throw Object.assign(new Error('quota'), { name: 'ServiceQuotaExceededException' });
    };
    const failed = await createLauncher(deps)(request());
    expect(failed).toMatchObject({ status: 500, disposition: 'launch_failed' });
    expect((await store.getJob(failed.jobId!))?.status).toBe('finished');

    runMicrovm = async (input) => {
      runs.push(input);
      return { microvmId: 'mvm-0002' };
    };
    expect((await createLauncher(deps)(request())).disposition).toBe('launched');
  });

  it('keeps trying to record the microVM on the job, and still reports the launch if it cannot', async () => {
    const attach = vi.spyOn(store, 'attachMicrovm').mockRejectedValueOnce(new Error('throttled'));
    const ok = await createLauncher(deps)(request());
    expect(ok.disposition).toBe('launched');
    expect(attach).toHaveBeenCalledTimes(2);
    expect((await store.getJob(ok.jobId!))?.microvmId).toBe('mvm-0001');

    attach.mockRejectedValue(new Error('down'));
    const logged: Record<string, unknown>[] = [];
    const second = await createLauncher({ ...deps, log: (e) => logged.push(e) })(request({}, 'delivery-3'));
    expect(second.disposition).toBe('launched');
    expect(logged.some((e) => String(e.warning).includes('could not record the microVM'))).toBe(true);
  });

  it("reads the tenant and its active config strongly consistently, and the claim is held by the job's id", async () => {
    const getTenant = vi.spyOn(store, 'getTenant');
    const getConfigVersion = vi.spyOn(store, 'getConfigVersion');
    const claim = vi.spyOn(store, 'claimDelivery');
    const ok = await createLauncher(deps)(request());
    expect(getTenant).toHaveBeenCalledWith(55, { consistent: true });
    expect(getConfigVersion).toHaveBeenCalledWith(55, 1, { consistent: true });
    expect(claim).toHaveBeenCalledWith(55, 'delivery-1', NOW + 10800 * 1000, ok.jobId);
  });

  it('refuses a delivery id that cannot be part of an S3 key', async () => {
    expect(await createLauncher(deps)(request({}, '../../x'))).toEqual({ status: 400, disposition: 'bad_delivery_id' });
  });
});
