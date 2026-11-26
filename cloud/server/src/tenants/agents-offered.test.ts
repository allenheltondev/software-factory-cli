import { describe, expect, it, vi } from 'vitest';

// Every supported agent is always offered: there is no deployment setting that turns one off.

const { generateKeyPairSync, randomBytes } = await import('node:crypto');
const { SUPPORTED_AGENT_KEY_ENV, AGENT_KEY_ENV } = await import('./agents.js');
const { compileTenantConfig } = await import('./config.js');
const { dispatchRules } = await import('./dispatch.js');
const { createMemoryStore } = await import('../store/store.js');
const { createLauncher } = await import('../jobs/launch.js');
const { createBroker, hashToken } = await import('../broker/broker.js');
const { CONSOLE_AGENTS, defaultConsoleConfig, missingKeys, parseConsoleConfig, toConsolePath, toTenantSubmission } = await import('./console.js');

const REPOS = new Map([['acme/web', 9]]);
/** One builder and one reviewer agent, each in a pool of its own. */
const withAgents = (agent: string, reviewer: string, review = false) => {
  const d = defaultConsoleConfig({ login: 'pat' });
  const w = d.workflows.implement!;
  return {
    ...d,
    agents: { writer: { adapter: agent, enabled: true }, checker: { adapter: reviewer, enabled: true } },
    pools: { builders: { agents: ['writer'] }, reviewers: { agents: ['checker'] } },
    workflows: { implement: { ...w, review: { ...w.review, enabled: review, allowSameAgent: true }, revise: { ...w.revise, enabled: false } } },
    repositories: { 'acme/web': { enabled: true, workflows: ['implement'], publish: 'draft-pr', commentOnFailure: true, verify: [] } },
  };
};
const compileErrors = (raw: unknown) => {
  const parsed = parseConsoleConfig(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const out = compileTenantConfig(toTenantSubmission(parsed.config), { appId: 1 }, REPOS);
  return out.ok ? [] : out.errors.map((e) => ({ ...e, path: toConsolePath(e.path, parsed.config) }));
};

describe('the agents Updraft Cloud offers', () => {
  it('are every supported agent', () => {
    expect(AGENT_KEY_ENV).toEqual(SUPPORTED_AGENT_KEY_ENV);
    expect(CONSOLE_AGENTS).toEqual(['claude', 'codex', 'kiro', 'vibe']);
  });

  it('start every pool with every agent, and compile a config that runs any one of them', () => {
    const d = defaultConsoleConfig({ login: 'pat' });
    expect(d.pools).toEqual({ builders: { agents: [...CONSOLE_AGENTS] }, reviewers: { agents: [...CONSOLE_AGENTS] } });
    for (const a of CONSOLE_AGENTS) expect(compileErrors(withAgents(a, a))).toEqual([]);
  });

  it('refuse an agent name that is not supported', () => {
    const parsed = parseConsoleConfig(withAgents('gemini', 'claude'));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors).toEqual([expect.objectContaining({ path: 'agents.writer.adapter' })]);
  });

  it('ask for the key of every agent that is on', () => {
    for (const a of CONSOLE_AGENTS) {
      const parsed = parseConsoleConfig(withAgents(a, a));
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
      expect(missingKeys(parsed.config, new Set()).map((m) => m.message).join(" ")).toContain(SUPPORTED_AGENT_KEY_ENV[a]);
    }
  });
});

describe('a published version that needs a key no supported agent uses', () => {
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
    await publish(store, ['GEMINI_API_KEY']);
    await store.putAgentKeyMeta(55, { name: 'GEMINI_API_KEY', updatedAt: 't', updatedBy: 'pat' });
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
    expect((await store.listRefusals(55, 5))[0]?.reason).toMatch(/needs GEMINI_API_KEY, which no agent Updraft Cloud runs uses: choose another agent/);
  });

  it("hands a job the key of every supported agent", async () => {
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
    expect(Object.keys(out.descriptor?.agentKeySecrets ?? {})).toEqual(Object.values(SUPPORTED_AGENT_KEY_ENV));
  });
});
