import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBroker, hashToken } from '../broker/broker.js';
import { createMemoryStore, type DispatchRules, type Tenant } from '../store/store.js';
import { createBundleKeys } from '../tenants/key-needs.js';
import { configPrefix } from '../tenants/paths.js';
import { dispatchRules } from '../tenants/dispatch.js';
import { createAdminService } from '../admin/admin.js';
import { createReconciler } from './reconcile.js';
import { createLauncher, PRELAUNCH_CLAIM_MS, type LaunchDeps, type LaunchRequest, type RunMicrovmInput, type ThrottleNotice } from './launch.js';

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
}, { keys: {} });

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
      // Generous, so the tests of everything else are never throttled.
      quotas: { concurrentJobs: 10, jobsPerDay: 100, microvmMinutesPerMonth: 100_000, platformConcurrentJobs: 10 },
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
      clientToken: result.jobId,
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
      microvmState: async () => 'TERMINATING',
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

  describe('bring your own key (#70)', () => {
    const activate = async (dispatch: DispatchRules) => {
      const v = await store.createConfigVersion(55, { sha256: 'y', files: ['config.yaml'], publishedBy: 's', publishedAt: '', dispatch });
      await store.markConfigReady(55, v as number);
      await store.activateConfig(55, v as number);
      return v as number;
    };
    // Two workflows: Claude on `updraft`, Codex on `codex` (as dispatchRules stores them now).
    const twoAgents = (): DispatchRules =>
      dispatchRules(
        {
          dispatch: { allowedActors: ['pat'] },
          repositories: { 'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }, { trigger: { label: 'codex' } }] } },
        },
        { keys: { 'acme/web': { updraft: ['ANTHROPIC_API_KEY'], codex: ['CODEX_API_KEY'] } } },
      );
    const withKeys = async (keys: string[]) => activate(dispatchRules(
      { dispatch: { allowedActors: ['pat'] }, repositories: { 'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }] } } },
      { keys: { 'acme/web': { updraft: keys } } },
    ));
    const setKey = (name: string) => store.putAgentKeyMeta(55, { name, updatedAt: '2000-01-01T00:00:00.000Z', updatedBy: 'pat' });
    const finishWith = async (jobId: string, token: string, outcome: string) => {
      const broker = createBroker({
        store,
        loadSettings: async () => null,
        github: { createInstallationToken: vi.fn(), getBotUser: vi.fn() },
        assumeRole: async () => ({ accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't', expiration: new Date(NOW + 3_600_000).toISOString() }),
        terminateMicrovm: async () => {},
        microvmState: async () => 'RUNNING',
        policy: { bucket: 'tenant-bucket', partition: 'aws', region: 'us-east-1', accountId: '123456789012' },
        now: () => NOW,
      });
      await broker({ action: 'start', jobId, token });
      await broker({ action: 'finish', jobId, token, outcome });
    };

    it('refuses to dispatch when the workflow\'s agent has no key, and records why', async () => {
      await withKeys(['ANTHROPIC_API_KEY']);
      const log = vi.fn();
      expect(await createLauncher({ ...deps, log })(request())).toEqual({ status: 200, disposition: 'missing_key' });
      expect(runs).toEqual([]);
      expect(events).toEqual({});
      const [refusal] = await store.listRefusals(55, 5);
      expect(refusal).toMatchObject({ repository: 'acme/web', issue: 12, deliveryId: 'delivery-1', reason: 'ANTHROPIC_API_KEY is not set: add it under Agent keys' });
      // Nothing was claimed, so setting the key and redelivering starts the job.
      await store.putAgentKeyMeta(55, { name: 'ANTHROPIC_API_KEY', updatedAt: 't', updatedBy: 'pat' });
      expect(await createLauncher(deps)(request())).toMatchObject({ status: 202, disposition: 'launched' });
    });

    it("checks only the matched trigger's keys, and pins only those on the job", async () => {
      await activate(twoAgents());
      await setKey('ANTHROPIC_API_KEY');
      // Codex is not set: its label is refused, Claude's label is not held up by it.
      expect(await createLauncher(deps)(request({ label: { name: 'codex' } }, 'delivery-codex'))).toEqual({ status: 200, disposition: 'missing_key' });
      const result = await createLauncher(deps)(request());
      expect(result).toMatchObject({ status: 202, disposition: 'launched' });
      expect((await store.getJob(result.jobId!))?.agentKeys).toEqual(['ANTHROPIC_API_KEY']);
    });

    describe('a version published before key needs were recorded', () => {
      // Its dispatch rules: no `keys` on any trigger.
      const legacy = () => dispatchRules({ dispatch: { allowedActors: ['pat'] }, repositories: { 'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }] } } });
      const bundle = (version: number) => ({
        [`tenants/55/config/${version}/config.yaml`]: [
          'agents:',
          '  claude: { adapter: claude }',
          'pools:',
          '  default: { agents: [claude] }',
          'repositories:',
          '  acme/web:',
          '    id: 9',
          '    workflows:',
          '      - { trigger: { label: updraft }, pool: default }',
        ].join('\n'),
      });
      const reader = (objects: Record<string, string>) => {
        const reads: string[] = [];
        return { reads, bundleKeys: createBundleKeys(async (key) => (reads.push(key), objects[key] ?? null), configPrefix) };
      };

      it('reads them from its bundle: refused without the key, started (and pinned) with it, read once', async () => {
        const v = await activate(legacy());
        const { reads, bundleKeys } = reader(bundle(v));
        const launch = createLauncher({ ...deps, bundleKeys });
        expect(await launch(request())).toEqual({ status: 200, disposition: 'missing_key' });
        expect((await store.listRefusals(55, 1))[0]?.reason).toBe('ANTHROPIC_API_KEY is not set: add it under Agent keys');
        await setKey('ANTHROPIC_API_KEY');
        const result = await launch(request({}, 'delivery-2'));
        expect(result).toMatchObject({ status: 202, disposition: 'launched' });
        expect((await store.getJob(result.jobId!))?.agentKeys).toEqual(['ANTHROPIC_API_KEY']);
        expect(reads).toEqual([`tenants/55/config/${v}/config.yaml`]);
      });

      it('is refused, with the reason, when its bundle cannot tell (never run unchecked)', async () => {
        await activate(legacy());
        await setKey('ANTHROPIC_API_KEY');
        expect(await createLauncher({ ...deps, bundleKeys: reader({}).bundleKeys })(request())).toEqual({ status: 200, disposition: 'missing_key' });
        expect(await createLauncher(deps)(request({}, 'delivery-2'))).toEqual({ status: 200, disposition: 'missing_key' });
        expect((await store.listRefusals(55, 1))[0]?.reason).toContain('publish the configuration again');
        expect(runs).toEqual([]);
      });
    });

    it('marks each key the job used as OK or failed when it finishes, and never stores a value', async () => {
      await withKeys(['ANTHROPIC_API_KEY']);
      await setKey('ANTHROPIC_API_KEY');
      const result = await createLauncher(deps)(request());
      expect((await store.getJob(result.jobId!))?.agentKeys).toEqual(['ANTHROPIC_API_KEY']);
      const { jobToken } = (JSON.parse(runs[0]!.runHookPayload) as { broker: { jobToken: string } }).broker;
      await finishWith(result.jobId!, jobToken, 'failed');
      expect(await store.listAgentKeyMeta(55)).toEqual([{ name: 'ANTHROPIC_API_KEY', updatedAt: '2000-01-01T00:00:00.000Z', updatedBy: 'pat', lastUsedAt: new Date(NOW).toISOString(), lastUsedOk: false }]);
    });
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
    expect(claim).toHaveBeenCalledWith(55, 'delivery-1', NOW + PRELAUNCH_CLAIM_MS, ok.jobId);
  });

  describe('a launch that stops partway (review fix on #80)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const brokerFor = () =>
      createBroker({
        store,
        loadSettings: async () => null,
        github: { createInstallationToken: vi.fn(), getBotUser: vi.fn() },
        assumeRole: async () => ({ accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't', expiration: new Date(Date.now() + 3_600_000).toISOString() }),
        terminateMicrovm: vi.fn(async () => {}),
        microvmState: async () => 'TERMINATING',
        policy: { bucket: 'tenant-bucket', partition: 'aws', region: 'us-east-1', accountId: '123456789012' },
        now: () => Date.now(),
      });

    it('blocks a redelivery only until its short claim runs out, when no job got started', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      // The Lambda's deadline hits during RunMicrovm: nothing after it runs, not even the catch.
      const stuck = createLauncher({ ...deps, now: () => Date.now(), runMicrovm: () => new Promise(() => {}) });
      void stuck(request());
      await vi.waitFor(() => expect(Object.keys(events)).toHaveLength(1));
      expect(await createLauncher({ ...deps, now: () => Date.now() })(request())).toEqual({ status: 200, disposition: 'duplicate' });

      vi.setSystemTime(NOW + PRELAUNCH_CLAIM_MS + 1_000);
      expect((await createLauncher({ ...deps, now: () => Date.now() })(request())).disposition).toBe('launched');
    });

    it('a job that started holds the claim for its lifetime; one that starts after a redelivery took it does not run', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      const launch = createLauncher({ ...deps, now: () => Date.now() });
      const broker = brokerFor();
      const tokenOf = (i: number) => (JSON.parse(runs[i]!.runHookPayload) as { broker: { jobToken: string } }).broker.jobToken;

      const first = await launch(request());
      expect((await broker({ action: 'start', jobId: first.jobId, token: tokenOf(0) })).ok).toBe(true);
      vi.setSystemTime(NOW + PRELAUNCH_CLAIM_MS + 60_000);
      expect(await launch(request())).toEqual({ status: 200, disposition: 'duplicate' });

      // A slow job: its claim ran out before it started, and the redelivery's job took it.
      const slow = await launch(request({}, 'delivery-2'));
      vi.setSystemTime(NOW + 2 * PRELAUNCH_CLAIM_MS + 120_000);
      const redelivered = await launch(request({}, 'delivery-2'));
      expect(redelivered.disposition).toBe('launched');
      expect(await broker({ action: 'start', jobId: slow.jobId, token: tokenOf(1) })).toEqual({ ok: false, error: 'refused' });
      expect((await broker({ action: 'start', jobId: redelivered.jobId, token: tokenOf(2) })).ok).toBe(true);
    });
  });

  describe('quotas and the kill switch', () => {
    const day = new Date(NOW).toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const ONE_AT_A_TIME = { concurrentJobs: 1, jobsPerDay: 100, microvmMinutesPerMonth: 100_000, platformConcurrentJobs: 10 };

    it('starts nothing while the kill switch is on, and claims nothing', async () => {
      let engaged = true;
      const launch = createLauncher({ ...deps, killSwitch: { engaged: async () => engaged } });
      expect(await launch(request())).toEqual({ status: 200, disposition: 'kill_switch' });
      expect(runs).toEqual([]);
      engaged = false;
      expect((await launch(request())).disposition).toBe('launched');
    });

    it('records the job\'s slots and the microVM time it reserves', async () => {
      const result = await createLauncher(deps)(request());
      expect(await store.getJob(result.jobId!)).toMatchObject({ tenantSlot: 0, platformSlot: expect.any(Number), reservedSeconds: 10800 });
      expect(await store.getUsage(55, day, month)).toMatchObject({ jobsToday: 1, jobsThisMonth: 1 });
    });

    it('throttles a delivery over a quota: nothing started, the claim given up, one comment a day on the issue', async () => {
      const notices: ThrottleNotice[] = [];
      const launch = createLauncher({ ...deps, quotas: ONE_AT_A_TIME, notifyThrottled: async (n) => void notices.push(n) });
      const first = await launch(request());
      expect(first.disposition).toBe('launched');

      expect(await launch(request({}, 'delivery-2'))).toEqual({ status: 200, disposition: 'throttled' });
      expect(await launch(request({}, 'delivery-3'))).toEqual({ status: 200, disposition: 'throttled' });
      expect(runs).toHaveLength(1);
      expect(notices).toEqual([{ installationId: 55, repository: 'acme/web', repositoryId: 9, issue: 12, limit: 'concurrent_jobs', quotas: ONE_AT_A_TIME }]);
      // Another issue gets its own comment.
      await launch(request({ issue: { number: 13 } }, 'delivery-4'));
      expect(notices.map((n) => n.issue)).toEqual([12, 13]);
      expect((await store.getUsage(55, day, month)).throttledThisMonth).toBe(3);

      // Once the first job is done, redelivering a throttled delivery starts it.
      const job = (await store.getJob(first.jobId!))!;
      await store.releaseJobSlots(job);
      expect((await launch(request({}, 'delivery-2'))).disposition).toBe('launched');
    });

    it("applies the tenant's overrides over the stack's defaults", async () => {
      await store.setTenantLimits(55, { jobsPerDay: 1 });
      const notices: ThrottleNotice[] = [];
      const launch = createLauncher({ ...deps, notifyThrottled: async (n) => void notices.push(n) });
      expect((await launch(request())).disposition).toBe('launched');
      expect(await launch(request({}, 'delivery-2'))).toEqual({ status: 200, disposition: 'throttled' });
      expect(notices[0]).toMatchObject({ limit: 'jobs_per_day', quotas: { jobsPerDay: 1, concurrentJobs: 10 } });
    });

    it('a comment that fails is only logged', async () => {
      const logged: Record<string, unknown>[] = [];
      const launch = createLauncher({
        ...deps,
        quotas: ONE_AT_A_TIME,
        log: (e) => logged.push(e),
        notifyThrottled: async () => {
          throw new Error('GitHub is down');
        },
      });
      await launch(request());
      expect(await launch(request({}, 'delivery-2'))).toEqual({ status: 200, disposition: 'throttled' });
      expect(logged.some((e) => String(e.warning).includes('could not comment on the issue: GitHub is down'))).toBe(true);
    });

    it("holds a confirmed launch's capacity until Lambda shows its microVM terminated, even if its start never commits", async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      try {
        const launch = createLauncher({ ...deps, quotas: ONE_AT_A_TIME, now: () => Date.now() });
        const first = await launch(request());
        expect(first.disposition).toBe('launched');
        const { jobToken } = (JSON.parse(runs[0]!.runHookPayload) as { broker: { jobToken: string } }).broker;
        let engaged = true;
        let state: string | null = 'RUNNING';
        const broker = createBroker({
          store,
          loadSettings: async () => null,
          github: { createInstallationToken: vi.fn(), getBotUser: vi.fn() },
          assumeRole: async () => ({ accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't', expiration: new Date(Date.now() + 3_600_000).toISOString() }),
          terminateMicrovm: vi.fn(async () => {
            throw new Error('throttled');
          }),
          microvmState: async () => state,
          policy: { bucket: 'tenant-bucket', partition: 'aws', region: 'us-east-1', accountId: '123456789012' },
          killSwitch: { engaged: async () => engaged },
          now: () => Date.now(),
        });
        // Refused by the kill switch, and its terminate fails: the microVM runs on.
        expect(await broker({ action: 'start', jobId: first.jobId, token: jobToken })).toEqual({ ok: false, error: 'refused' });
        await expect(broker({ action: 'terminate', jobId: first.jobId, token: jobToken })).rejects.toThrow('throttled');

        // Well past the launcher's five minutes, its slot is still held, and reconciliation sees it.
        vi.setSystemTime(NOW + 4 * PRELAUNCH_CLAIM_MS);
        expect(await launch(request({}, 'delivery-2'))).toEqual({ status: 200, disposition: 'throttled' });
        const reconcile = createReconciler({ store, microvmState: async () => state, log: () => {} });
        expect(await reconcile()).toMatchObject({ released: [], held: 1 });

        // Terminated: released, and retired, so a delayed start (the kill switch off by now) gets nothing.
        state = 'TERMINATED';
        expect((await reconcile()).released).toEqual([first.jobId]);
        engaged = false;
        expect(await broker({ action: 'start', jobId: first.jobId, token: jobToken })).toEqual({ ok: false, error: 'refused' });
        expect(await broker({ action: 'credentials', jobId: first.jobId, token: jobToken })).toEqual({ ok: false, error: 'refused' });
        expect((await launch(request({}, 'delivery-3'))).disposition).toBe('launched');
      } finally {
        vi.useRealTimers();
      }
    });

    it('reserves the slots for the job\'s lifetime before its microVM exists, so no later write can lose them', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      try {
        // RunMicrovm never answers (the Lambda's deadline): nothing after it runs.
        const stuck = createLauncher({ ...deps, quotas: ONE_AT_A_TIME, now: () => Date.now(), runMicrovm: () => new Promise(() => {}) });
        void stuck(request());
        await vi.waitFor(async () => expect(await store.listPlatformSlots()).toHaveLength(1));
        // Held to the job's own end (vi.waitFor moves the fake clock a little while it waits).
        const [entry] = await store.listActiveJobs();
        expect(entry).toMatchObject({ phase: 'launching' });
        expect((await store.listPlatformSlots())[0]!.expiresAt).toBe((await store.getJob(entry!.jobId))!.expiresAt);

        // Well past the launcher's five minutes: still taken, and the job still reconciled.
        vi.setSystemTime(NOW + 4 * PRELAUNCH_CLAIM_MS);
        const launch = createLauncher({ ...deps, quotas: ONE_AT_A_TIME, now: () => Date.now() });
        expect(await launch(request({}, 'delivery-2'))).toEqual({ status: 200, disposition: 'throttled' });
        expect(await store.listActiveJobs()).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("reconciliation holds a running job's slots again, but never a job released while it looked", async () => {
      const launch = createLauncher({ ...deps, quotas: ONE_AT_A_TIME });
      const first = await launch(request());
      const job = (await store.getJob(first.jobId!))!;
      // Its slots went missing (say, a delete that should not have happened): held again.
      await store.releaseJobSlots(job);
      expect(await createReconciler({ store, microvmState: async () => 'RUNNING', log: () => {} })()).toMatchObject({ held: 1 });
      expect((await store.listPlatformSlots()).map((s) => s.jobId)).toEqual([first.jobId]);

      // Released (by the broker's terminate, say) while reconciliation waits on Lambda: its stale
      // hold must not bring the slots back.
      const reconcile = createReconciler({
        store,
        microvmState: async () => {
          await store.releaseJob(job);
          return 'RUNNING';
        },
        log: () => {},
      });
      await reconcile();
      expect(await store.listPlatformSlots()).toEqual([]);
      expect(await store.listActiveJobs()).toEqual([]);
      expect((await launch(request({}, 'delivery-2'))).disposition).toBe('launched');
    });

    it('reclaims a reservation whose launch stopped before it asked for a microVM', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      try {
        const reconcile = () => createReconciler({ store, microvmState: vi.fn(), now: () => Date.now(), log: () => {} })();
        // The Lambda's deadline hits while it writes the event: nothing after the reservation is written.
        const stuck = createLauncher({ ...deps, quotas: ONE_AT_A_TIME, now: () => Date.now(), putEvent: () => new Promise(() => {}) });
        void stuck(request());
        await vi.waitFor(async () => expect(await store.listActiveJobs()).toHaveLength(1));
        expect((await store.listActiveJobs())[0]).toMatchObject({ phase: 'reserved' });

        // Too soon to tell from a launch still under way: left alone.
        vi.setSystemTime(NOW + 60_000);
        expect((await reconcile()).released).toEqual([]);
        expect(await store.listPlatformSlots()).toHaveLength(1);

        // Past five minutes: reclaimed, the slots and the day's count given back.
        vi.setSystemTime(NOW + 6 * 60_000);
        expect((await reconcile()).released).toHaveLength(1);
        expect(await store.listPlatformSlots()).toEqual([]);
        expect(await store.listActiveJobs()).toEqual([]);
        expect(await store.getUsage(55, new Date(NOW).toISOString().slice(0, 10), new Date(NOW).toISOString().slice(0, 7))).toMatchObject({ jobsToday: 0, jobsThisMonth: 0 });
        expect((await createLauncher({ ...deps, quotas: ONE_AT_A_TIME, now: () => Date.now() })(request({}, 'delivery-2'))).disposition).toBe('launched');
      } finally {
        vi.useRealTimers();
      }
    });

    it('a reclaimed reservation retires the job it recorded, which can then never start', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      try {
        // The job is recorded, then the Lambda stops before it marks the launch (no RunMicrovm).
        const markLaunching = store.markLaunching.bind(store);
        store.markLaunching = () => new Promise(() => {});
        const stuck = createLauncher({ ...deps, now: () => Date.now() });
        void stuck(request());
        await vi.waitFor(async () => expect(Object.keys(events)).toHaveLength(1));
        const [entry] = await store.listActiveJobs();
        await vi.waitFor(async () => expect(await store.getJob(entry!.jobId)).not.toBeNull());
        store.markLaunching = markLaunching;

        vi.setSystemTime(NOW + 6 * 60_000);
        expect((await createReconciler({ store, microvmState: vi.fn(), now: () => Date.now(), log: () => {} })()).released).toEqual([entry!.jobId]);
        const job = (await store.getJob(entry!.jobId))!;
        expect(job).toMatchObject({ status: 'finished', outcome: 'launch_failed' });
        expect(typeof job.stopRequestedAt).toBe('number');
        expect(await store.startJob(job, job.expiresAt)).toEqual({ result: 'retired' });
        // Too late to launch: marking it fails, so a launch that woke up now starts nothing.
        await expect(store.markLaunching(job.jobId)).rejects.toThrow('no reservation to launch');
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports an admin's release of a launch it beat as cancelled, not as a failure", async () => {
      // The webhook pauses just before it marks its launch; an admin releases the job meanwhile.
      let resume!: () => void;
      const paused = new Promise<void>((r) => (resume = r));
      const markLaunching = store.markLaunching.bind(store);
      store.markLaunching = async (jobId) => {
        await paused;
        return markLaunching(jobId);
      };
      const pending = createLauncher(deps)(request());
      await vi.waitFor(async () => expect(await store.listActiveJobs()).toHaveLength(1));
      const [entry] = await store.listActiveJobs();
      await vi.waitFor(async () => expect(await store.getJob(entry!.jobId)).not.toBeNull());
      await createAdminService({ store, quotas: deps.quotas, log: () => {} }).releaseJob(entry!.jobId, 'admin:x');

      resume();
      expect(await pending).toEqual({ status: 200, disposition: 'cancelled', jobId: entry!.jobId });
      expect(runs).toEqual([]);
      expect(await store.getJob(entry!.jobId)).toMatchObject({ status: 'finished', outcome: 'released_by_admin' });
      const day = new Date(NOW).toISOString().slice(0, 10);
      expect((await store.getUsage(55, day, day.slice(0, 7))).failedThisMonth).toBe(0);
      expect((await store.listRecentJobs(55, 5))[0]).toMatchObject({ status: 'finished', outcome: 'released_by_admin' });
    });

    it('gives the reservation back when the launch fails', async () => {
      runMicrovm = async () => {
        throw new Error('throttled by Lambda');
      };
      const launch = createLauncher({ ...deps, quotas: ONE_AT_A_TIME });
      expect((await launch(request())).disposition).toBe('launch_failed');
      expect(await store.getUsage(55, day, month)).toMatchObject({ jobsToday: 0, jobsThisMonth: 0 });
      runMicrovm = async (input) => {
        runs.push(input);
        return { microvmId: 'mvm-0002' };
      };
      expect((await launch(request())).disposition).toBe('launched');
    });
  });

  it('refuses a delivery id that cannot be part of an S3 key', async () => {
    expect(await createLauncher(deps)(request({}, '../../x'))).toEqual({ status: 400, disposition: 'bad_delivery_id' });
  });
});
