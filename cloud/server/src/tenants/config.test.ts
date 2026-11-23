import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { bundleHash, compileTenantConfig, SANDBOX_CONTAINER, TOKEN_FILE, type TenantSubmission } from './config.js';

const PLATFORM = { appId: 4242 };
const REPOS = new Map([['acme/web', 99]]);

function submission(over: Record<string, unknown> = {}, prompts: Record<string, string> = { 'implement-issue.md': '# Implement' }): TenantSubmission {
  return {
    config: {
      dispatch: { allowedActors: ['pat'] },
      agents: { claude: { model: 'sonnet' } },
      pools: { general: { agents: ['claude'] } },
      actions: { 'implement-issue': { prompt: './prompts/implement-issue.md', verify: ['npm test'] } },
      repositories: {
        'acme/web': { workflows: [{ id: 'implement', trigger: { event: 'issue.labeled', label: 'ready' }, action: 'implement-issue', pool: 'general' }] },
      },
      ...over,
    },
    prompts,
  };
}

const errorsOf = (s: TenantSubmission, repos = REPOS) => {
  const r = compileTenantConfig(s, PLATFORM, repos);
  return r.ok ? [] : r.errors;
};

describe('compileTenantConfig', () => {
  it('injects what the platform enforces and passes the worker\'s own validation', () => {
    const r = compileTenantConfig(submission(), PLATFORM, REPOS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const config = parse(r.files['config.yaml']!) as { github: { app: Record<string, unknown> } } & Record<string, unknown>;
    expect(config).toMatchObject({
      version: 1,
      execution: { mode: 'live' },
      maxConcurrent: 1,
      github: { app: { appId: 4242, tokenFile: TOKEN_FILE, commitAsApp: true } },
      agents: { claude: { model: 'sonnet', maxConcurrent: 1, container: { ...SANDBOX_CONTAINER, env: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] } } },
      repositories: { 'acme/web': { id: 99, checkoutPath: './clones/web', publish: 'draft-pr' } },
    });
    expect(config.github.app.privateKeyPath).toBeUndefined();
    expect(r.files['prompts/implement-issue.md']).toBe('# Implement');
    expect(r.sha256).toBe(bundleHash(r.files));
  });

  it('gives each agent only its own key (for Claude: its API key or a subscription token)', () => {
    const r = compileTenantConfig(
      submission({ agents: { claude: {}, codex: {} }, pools: { general: { agents: ['claude'] }, reviewers: { agents: ['codex'] } } }),
      PLATFORM,
      REPOS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const agents = (parse(r.files['config.yaml']!) as { agents: Record<string, { container: { env: string[] } }> }).agents;
    expect(agents.claude!.container.env).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
    expect(agents.codex!.container.env).toEqual(['CODEX_API_KEY']);
  });

  it.each([
    ['github', { github: { app: { appId: 1, privateKeyPath: 'k.pem' } } }, 'github', /platform GitHub App/],
    ['execution', { execution: { mode: 'log-only' } }, 'execution', /run live/],
    ['maxConcurrent', { maxConcurrent: 8 }, 'maxConcurrent', /one job/],
    ['capacity', { capacity: {} }, 'capacity', /local subscriptions/],
    ['an unknown key', { surprise: true }, 'surprise', /not a setting/],
  ])('rejects tenant input for %s', (_what, over, path, message) => {
    expect(errorsOf(submission(over))).toEqual(expect.arrayContaining([expect.objectContaining({ path, message: expect.stringMatching(message) })]));
  });

  it.each([
    ['command', { command: '/bin/sh' }],
    ['args', { args: ['--dangerously'] }],
    ['env', { env: { ANTHROPIC_API_KEY: 'sk-ant-xxx' } }],
    ['container', { container: { image: 'evil' } }],
    ['capacityGroup', { capacityGroup: 'g' }],
  ])('rejects an agent\'s %s', (key, agent) => {
    expect(errorsOf(submission({ agents: { claude: agent } }))).toEqual([expect.objectContaining({ path: `agents.claude.${key}` })]);
  });

  it('rejects agents the image does not ship', () => {
    expect(errorsOf(submission({ agents: { gemini: {} } }))).toEqual([expect.objectContaining({ path: 'agents.gemini', message: expect.stringMatching(/claude, codex, kiro/) })]);
    expect(errorsOf(submission({ agents: { mine: { adapter: 'gemini' } } }))).toEqual([expect.objectContaining({ path: 'agents.mine.adapter' })]);
    // Kiro runs, in the sandbox, with its key the only one in its environment.
    const kiro = compileTenantConfig(submission({ agents: { kiro: {} }, pools: { general: { agents: ['kiro'] } } }), PLATFORM, REPOS);
    expect(kiro.ok ? null : kiro.errors).toBeNull();
    expect(kiro).toMatchObject({ dispatch: { repositories: { 'acme/web': { keys: ['KIRO_API_KEY'] } } }, keys: [{ path: 'agents.kiro', key: 'KIRO_API_KEY' }] });
    expect(kiro.ok && kiro.files['config.yaml']).toMatch(/env:\n\s+- KIRO_API_KEY/);
  });

  it('rejects repositories the installation cannot reach, and repository settings the platform owns', () => {
    expect(errorsOf(submission(), new Map())).toEqual([expect.objectContaining({ path: 'repositories.acme/web', message: expect.stringMatching(/cannot access/) })]);
    const repo = (extra: Record<string, unknown>) =>
      submission({
        repositories: { 'acme/web': { ...extra, workflows: [{ trigger: { event: 'issue.labeled', label: 'ready' }, action: 'implement-issue', pool: 'general' }] } },
      });
    for (const [key, value] of [['checkoutPath', '/etc'], ['id', 1], ['remote', 'evil'], ['dependencies', { repositories: ['acme/lib'] }]] as const) {
      expect(errorsOf(repo({ [key]: value }))).toEqual([expect.objectContaining({ path: `repositories.acme/web.${key}` })]);
    }
    expect(errorsOf(repo({ publish: 'none' }))).toEqual([expect.objectContaining({ path: 'repositories.acme/web.publish' })]);
    expect(errorsOf(repo({ maxRevisions: 9 }))).toEqual([expect.objectContaining({ path: 'repositories.acme/web.maxRevisions' })]);
  });

  it('rejects triage, which runs outside the sandbox', () => {
    const s = submission({
      repositories: {
        'acme/web': {
          workflows: [
            {
              trigger: { event: 'issue.labeled', label: 'ready' },
              action: 'implement-issue',
              pool: { tiers: true },
              tiers: { pools: { routine: 'general', standard: 'general', complex: 'general' }, triage: { pool: 'general' } },
            },
          ],
        },
      },
    });
    expect(errorsOf(s)).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'repositories.acme/web.workflows.0.tiers.triage' })]));
  });

  it('takes prompts only from the submitted files, and holds timeouts to the ceilings', () => {
    expect(errorsOf(submission({ actions: { 'implement-issue': { prompt: '../../etc/passwd' } } }))).toEqual([
      expect.objectContaining({ path: 'actions.implement-issue.prompt', message: expect.stringMatching(/\.\/prompts\//) }),
    ]);
    expect(errorsOf(submission({ actions: { 'implement-issue': { prompt: './prompts/other.md' } } }))).toEqual([
      expect.objectContaining({ path: 'actions.implement-issue.prompt', message: expect.stringMatching(/not among/) }),
    ]);
    expect(errorsOf(submission({}, { '../x.md': 'no' }))).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'prompts.../x.md' })]));
    expect(errorsOf(submission({ actions: { 'implement-issue': { prompt: './prompts/implement-issue.md', timeoutMinutes: 500, verifyTimeoutMinutes: 90 } } }))).toEqual([
      expect.objectContaining({ path: 'actions.implement-issue.timeoutMinutes' }),
      expect.objectContaining({ path: 'actions.implement-issue.verifyTimeoutMinutes' }),
    ]);
  });

  it('requires someone allowed to dispatch', () => {
    expect(errorsOf(submission({ dispatch: { allowedActors: [] } }))).toEqual([expect.objectContaining({ path: 'dispatch.allowedActors' })]);
  });

  it('reports what the worker\'s validation refuses after compiling', () => {
    const r = compileTenantConfig(submission({ pools: { general: { agents: ['nobody'] } } }), PLATFORM, REPOS);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.map((e) => e.message).join('\n')).toMatch(/nobody/);
  });

  it('hashes the bundle stably, by content and path', () => {
    expect(bundleHash({ b: '2', a: '1' })).toBe(bundleHash({ a: '1', b: '2' }));
    expect(bundleHash({ a: '1' })).not.toBe(bundleHash({ a: '2' }));
  });
});

describe('the agent keys a config needs', () => {
  const keysOf = (repo: Record<string, unknown>) => {
    const r = compileTenantConfig(
      {
        config: {
          dispatch: { allowedActors: ['pat'] },
          agents: { coder: { adapter: 'codex' }, reviewer: { adapter: 'codex' }, claude: {} },
          pools: { code: { agents: ['coder'] }, review: { agents: ['reviewer'] }, fallback: { agents: ['claude'] } },
          actions: { go: { prompt: './prompts/go.md', reviewPrompt: './prompts/review.md' } },
          repositories: { 'acme/web': { publish: 'draft-pr', ...repo } },
        },
        prompts: { 'go.md': '# Go', 'review.md': '# Review' },
      },
      PLATFORM,
      REPOS,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r.keys.map((k) => `${k.path}=${k.key}`);
  };
  const wf = (over: Record<string, unknown> = {}) => ({ trigger: { event: 'issue.labeled', label: 'go' }, action: 'go', pool: 'code', ...over });

  it("a repository's review pool that every workflow overrides needs no key (#83 review)", () => {
    // Codex writes and reviews; the unused Claude default must not demand an Anthropic key.
    expect(keysOf({ review: { pool: 'fallback' }, workflows: [wf({ reviewPool: 'review' })] })).toEqual(['agents.coder=CODEX_API_KEY', 'agents.reviewer=CODEX_API_KEY']);
  });

  it("a workflow without its own reviewPool uses the repository's", () => {
    expect(keysOf({ review: { pool: 'fallback' }, workflows: [wf()] })).toEqual(['agents.claude=ANTHROPIC_API_KEY', 'agents.coder=CODEX_API_KEY']);
  });

  it('with neither, the reviewer comes from the coding pool, and review off needs no reviewer at all', () => {
    expect(keysOf({ review: { allowSameAgent: true }, workflows: [wf()] })).toEqual(['agents.coder=CODEX_API_KEY']);
    expect(keysOf({ workflows: [wf({ reviewPool: 'fallback' })] })).toEqual(['agents.coder=CODEX_API_KEY']);
  });
});
