import { describe, expect, it, vi } from 'vitest';

// A deployment that runs Claude alone (CloudAgents=claude), as after Kiro and Codex were taken
// out of service. Read when the modules load, so it is set before they are imported.
vi.hoisted(() => {
  process.env.CLOUD_AGENTS = 'claude';
});

const { generateKeyPairSync, randomBytes } = await import('node:crypto');
const { compileTenantConfig } = await import('./config.js');
const { dispatchRules } = await import('./dispatch.js');
const { createMemoryStore } = await import('../store/store.js');
const { createLauncher } = await import('../jobs/launch.js');
const { createBroker, hashToken } = await import('../broker/broker.js');
const { CONSOLE_AGENTS, defaultConsoleConfig, parseConsoleConfig, toConsolePath, toTenantSubmission } = await import('./console.js');

const repo = (over: Record<string, unknown> = {}) => ({ enabled: true, triggers: [{ label: 'updraft', workflow: 'implement' }], allowedActors: ['pat'], publish: 'draft-pr', commentOnFailure: true, review: false, revise: false, ...over });
const REPOS = new Map([['acme/web', 9]]);
const withAgents = (agent: string, reviewer: string, review = false) => {
  const d = defaultConsoleConfig();
  const w = d.workflows.implement!;
  return { ...d, workflows: { implement: { ...w, agent: { adapter: agent }, reviewer: { ...w.reviewer, adapter: reviewer } } }, repositories: { 'acme/web': repo({ review }) } };
};
const compileErrors = (raw: unknown) => {
  const parsed = parseConsoleConfig(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const out = compileTenantConfig(toTenantSubmission(parsed.config), { appId: 1 }, REPOS);
  return out.ok ? [] : out.errors.map((e) => ({ ...e, path: toConsolePath(e.path, parsed.config) }));
};

describe('agents this deployment does not run', () => {
  it('starts a new workflow with the agents it runs: Claude writes and reviews', () => {
    expect(CONSOLE_AGENTS).toEqual(['claude']);
    const w = defaultConsoleConfig().workflows.implement!;
    expect([w.agent.adapter, w.reviewer.adapter]).toEqual(['claude', 'claude']);
    expect(compileErrors(withAgents('claude', 'claude', true))).toEqual([]);
  });

  it('still loads a saved config that names an agent it no longer runs, and refuses to publish one that would run it', () => {
    const saved = withAgents('kiro', 'codex');
    expect(parseConsoleConfig(saved).ok).toBe(true);
    expect(compileErrors(saved)).toEqual([expect.objectContaining({ path: 'workflows.implement.agent.adapter', message: expect.stringMatching(/not an agent Updraft Cloud runs \(claude\)/) })]);
  });

  it('ignores a reviewer no repository uses', () => {
    expect(compileErrors(withAgents('claude', 'codex', false))).toEqual([]);
    expect(compileErrors(withAgents('claude', 'codex', true))).toEqual([expect.objectContaining({ path: 'workflows.implement.reviewer.adapter' })]);
  });
});

describe('a published version that runs an agent taken out of service', () => {
  const tenant = { installationId: 55, accountId: 900, accountLogin: 'acme', accountType: 'Organization', status: 'active' as const, createdAt: '', createdBy: 's' };
  const member = { installationId: 55, sub: 's', role: 'owner' as const, githubUserId: 1, githubLogin: 'pat', addedAt: '' };
  const publish = async (store: ReturnType<typeof createMemoryStore>, keys: string[]) => {
    const rules = dispatchRules({ dispatch: { allowedActors: ['pat'] }, repositories: { 'acme/web': { id: 9, workflows: [{ trigger: { label: 'updraft' } }] } } }, { keysFor: () => keys });
    const v = (await store.createConfigVersion(55, { sha256: 'x', files: ['config.yaml'], publishedBy: 's', publishedAt: '', dispatch: rules })) as number;
    await store.markConfigReady(55, v);
    await store.activateConfig(55, v);
  };

  it('starts no job, and says what to change', async () => {
    const store = createMemoryStore();
    await store.putTenantWithMember(tenant, member);
    await publish(store, ['KIRO_API_KEY']);
    await store.putAgentKeyMeta(55, { name: 'KIRO_API_KEY', updatedAt: 't', updatedBy: 'pat' });
    const runMicrovm = vi.fn();
    const launch = createLauncher({
      store,
      settings: { region: 'us-east-1', bucket: 'b', imageArn: 'arn:image', executionRoleArn: 'arn:role', ingressConnectorArn: 'arn:in', egressConnectorArn: 'arn:out', logGroup: '/g', brokerFunctionName: 'broker', maximumDurationSeconds: 3600, watchdogReserveSeconds: 60 },
      imageVersion: async () => '1',
      putEvent: async () => {},
      runMicrovm,
      quotas: { concurrentJobs: 10, jobsPerDay: 100, microvmMinutesPerMonth: 100_000, platformConcurrentJobs: 10 },
      log: () => {},
      retryDelayMs: 1,
    });
    const payload = { action: 'labeled', issue: { number: 12 }, label: { name: 'updraft' }, sender: { login: 'pat' }, repository: { id: 9, full_name: 'acme/web' } };
    expect(await launch({ installationId: 55, deliveryId: 'd-1', body: JSON.stringify(payload), payload })).toMatchObject({ status: 200, disposition: 'missing_key' });
    expect(runMicrovm).not.toHaveBeenCalled();
    expect((await store.listRefusals(55, 5))[0]?.reason).toMatch(/runs kiro, which Updraft Cloud no longer runs here: choose another agent/);
  });

  it("hands a job only the keys of the agents the deployment runs", async () => {
    const store = createMemoryStore();
    await store.putTenantWithMember(tenant, member);
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    await store.putJob({ jobId: 'job_abc12345', tokenHash: hashToken(token), installationId: 55, repository: 'acme/web', repositoryId: 9, configVersion: 1, deliveryId: 'd-1', eventName: 'issues', status: 'launched', createdAt: new Date(now).toISOString(), expiresAt: now + 3_600_000 });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const broker = createBroker({
      store,
      loadSettings: async () => ({ appId: '1', clientId: 'c', slug: 's', appUrl: 'https://x', privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(), clientSecret: 'x', webhookSecret: 'y' }),
      github: { createInstallationToken: vi.fn().mockResolvedValue({ token: 'ghs_x', expiresAt: now + 3_600_000, permissions: {} }), getBotUser: vi.fn().mockResolvedValue({ id: 1, login: 'b[bot]' }) },
      assumeRole: vi.fn().mockResolvedValue({ accessKeyId: 'A', secretAccessKey: 's', sessionToken: 't', expiration: new Date(now + 3_600_000).toISOString() }),
      terminateMicrovm: vi.fn(),
      microvmState: vi.fn(),
      policy: { bucket: 'b', partition: 'aws', region: 'us-east-1', accountId: '123456789012' },
    } as never);
    const out = (await broker({ action: 'start', jobId: 'job_abc12345', token })) as { descriptor?: { agentKeySecrets?: Record<string, string> } };
    expect(Object.keys(out.descriptor?.agentKeySecrets ?? {})).toEqual(['ANTHROPIC_API_KEY']);
  });
});
