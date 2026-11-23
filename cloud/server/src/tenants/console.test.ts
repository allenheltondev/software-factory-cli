import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { compileTenantConfig } from './config.js';
import { workflowId } from '../../../../src/config/schema.js';
import { defaultConsoleConfig, missingKeys, parseConsoleConfig, toConsolePath, toTenantSubmission, upgradeNotes, type ConsoleConfig } from './console.js';
import * as v1 from './console-v1.js';
import { DEFAULT_PROMPTS } from './default-prompts.js';

const repo = (over: Record<string, unknown> = {}) => ({ enabled: true, workflows: ['implement'], publish: 'draft-pr', commentOnFailure: true, verify: [], ...over });

/** A new installation's defaults on a deployment that runs Claude and Codex, with these repositories. */
const settings = (repos: Record<string, unknown> = { 'acme/web': repo() }, workflowOver: Record<string, unknown> = {}) => {
  const d = defaultConsoleConfig({ offered: ['claude', 'codex'], login: 'pat' });
  return { ...d, workflows: { implement: { ...d.workflows.implement!, ...workflowOver } }, repositories: repos } as ConsoleConfig & Record<string, unknown>;
};
const reviewOff = { review: { enabled: false, pool: 'reviewers', prompt: DEFAULT_PROMPTS.review, allowSameAgent: false }, revise: { enabled: false, prompt: DEFAULT_PROMPTS.revise } };

const ok = (raw: unknown): ConsoleConfig => {
  const r = parseConsoleConfig(raw);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.config;
};
const errorsOf = (raw: unknown) => {
  const r = parseConsoleConfig(raw);
  return r.ok ? [] : r.errors;
};
/** A compiled config.yaml, as far as the assertions read it. */
interface Compiled {
  agents: Record<string, unknown>;
  pools: Record<string, unknown>;
  actions: Record<string, unknown>;
  repositories: Record<string, { workflows: Record<string, unknown>[]; [key: string]: unknown }>;
}
const yamlOf = (files: Record<string, string>) => parse(files['config.yaml']!) as Compiled;

const compile = (config: ConsoleConfig, ids = new Map([['acme/web', 99], ['acme/api', 100]])) => compileTenantConfig(toTenantSubmission(config), { appId: 4242 }, ids);

describe('defaults', () => {
  it('put every agent offered in a builders and a reviewers pool, and review and revise every pull request', () => {
    const d = defaultConsoleConfig({ offered: ['claude', 'codex', 'kiro'], login: 'pat' });
    expect(d.agents).toEqual({ claude: { adapter: 'claude', enabled: true }, codex: { adapter: 'codex', enabled: true }, kiro: { adapter: 'kiro', enabled: true } });
    expect(d.pools).toEqual({ builders: { agents: ['claude', 'codex', 'kiro'] }, reviewers: { agents: ['claude', 'codex', 'kiro'] } });
    expect(d.allowedActors).toEqual(['pat']);
    expect(d.workflows.implement).toEqual({
      label: 'updraft',
      pool: 'builders',
      prompt: DEFAULT_PROMPTS.implement,
      review: { enabled: true, pool: 'reviewers', prompt: DEFAULT_PROMPTS.review, allowSameAgent: false },
      revise: { enabled: true, prompt: DEFAULT_PROMPTS.revise },
    });
  });

  it('with one agent, it may review its own work: there is no other', () => {
    expect(defaultConsoleConfig({ offered: ['claude'] }).workflows.implement!.review.allowSameAgent).toBe(true);
  });
});

describe('compiling', () => {
  it('routes the work to the builders pool and the review to the reviewers pool, with the packaged prompts', () => {
    const r = compile(ok(settings()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const yaml = yamlOf(r.files);
    expect(yaml.pools).toEqual({ builders: { agents: ['claude', 'codex'] }, reviewers: { agents: ['claude', 'codex'] } });
    expect(yaml.agents.claude).toMatchObject({ adapter: 'claude', container: expect.any(Object) });
    expect(yaml.agents.codex).toMatchObject({ adapter: 'codex' });
    expect(yaml.repositories['acme/web']).toMatchObject({ id: 99, publish: 'draft-pr', checkoutPath: './clones/web', review: true, revise: true });
    expect(yaml.repositories['acme/web']?.autoMerge).toBeUndefined();
    expect(yaml.repositories['acme/web']?.workflows).toEqual([
      { id: 'implement', trigger: { event: 'issue.labeled', label: 'updraft' }, action: 'implement', pool: 'builders', allowedActors: ['pat'], reviewPool: 'reviewers' },
    ]);
    expect(yaml.actions.implement).toEqual({ prompt: './prompts/implement.md', reviewPrompt: './prompts/implement.review.md', revisePrompt: './prompts/implement.revise.md' });
    expect(r.files['prompts/implement.md']).toBe(DEFAULT_PROMPTS.implement);
    expect(r.files['prompts/implement.review.md']).toBe(DEFAULT_PROMPTS.review);
    expect(r.dispatch.repositories['acme/web']).toEqual({ id: 99, actors: ['pat'], keys: ['ANTHROPIC_API_KEY', 'CODEX_API_KEY'], review: true, revise: true, triggers: [{ label: 'updraft' }] });
    expect(r.keys).toEqual([
      { path: 'agents.claude', key: 'ANTHROPIC_API_KEY' },
      { path: 'agents.codex', key: 'CODEX_API_KEY' },
    ]);
  });

  it('without review or revision, no reviewer pool, prompts or keys', () => {
    const r = compile(ok({ ...settings(undefined, reviewOff), pools: { builders: { agents: ['claude'] }, reviewers: { agents: ['codex'] } } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.files).sort()).toEqual(['config.yaml', 'prompts/implement.md']);
    expect(Object.keys(yamlOf(r.files).pools)).toEqual(['builders']);
    expect(r.keys).toEqual([{ path: 'agents.claude', key: 'ANTHROPIC_API_KEY' }]);
  });

  it('an agent that is off is compiled off, and needs no key', () => {
    const base = settings();
    const config = ok({ ...base, agents: { ...base.agents, codex: { adapter: 'codex', enabled: false } }, workflows: { implement: { ...base.workflows.implement, review: { ...base.workflows.implement!.review, allowSameAgent: true } } } });
    const r = compile(config);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(yamlOf(r.files).agents.codex).toMatchObject({ enabled: false });
    expect(r.keys).toEqual([{ path: 'agents.claude', key: 'ANTHROPIC_API_KEY' }]);
  });

  it('gives each set of verify commands an action of its own, the first in the workflow\'s own, with one workflow id', () => {
    const config = ok(settings({ 'acme/web': repo({ verify: ['npm test'], verifyTimeoutMinutes: 20 }), 'acme/api': repo(), 'acme/docs': repo({ verify: ['npm test'], verifyTimeoutMinutes: 20 }) }));
    const r = compile(config, new Map([['acme/web', 99], ['acme/api', 100], ['acme/docs', 101]]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const yaml = yamlOf(r.files);
    expect(yaml.actions.implement).toMatchObject({ prompt: './prompts/implement.md', verify: ['npm test'], verifyTimeoutMinutes: 20 });
    expect(yaml.actions['implement.2']).not.toHaveProperty('verify');
    expect(yaml.repositories['acme/web']?.workflows[0]).toMatchObject({ id: 'implement', action: 'implement' });
    expect(yaml.repositories['acme/api']?.workflows[0]).toMatchObject({ id: 'implement', action: 'implement.2' });
    expect(yaml.repositories['acme/docs']?.workflows[0]).toMatchObject({ id: 'implement', action: 'implement' });
  });

  it('uses the installation\'s allowed actors unless a repository names its own', () => {
    const r = compile(ok(settings({ 'acme/web': repo({ allowedActors: ['sam'] }), 'acme/api': repo() })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const yaml = yamlOf(r.files);
    expect(yaml.repositories['acme/web']?.workflows[0]?.allowedActors).toEqual(['sam']);
    expect(yaml.repositories['acme/api']?.workflows[0]?.allowedActors).toEqual(['pat']);
  });

  it('a paused repository stays configured, and its dispatch rules start nothing', () => {
    const r = compile(ok(settings({ 'acme/web': repo({ enabled: false }), 'acme/api': repo() })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(yamlOf(r.files).repositories['acme/web']).toBeDefined();
    expect(r.dispatch.repositories['acme/web']?.paused).toBe(true);
    expect(r.dispatch.repositories['acme/api']?.paused).toBeUndefined();
  });

  it('compiles models, revision rounds, self-review and auto-merge', () => {
    const base = settings({ 'acme/web': repo({ autoMerge: { method: 'squash', waitMinutes: 30, requiredChecks: ['ci'] } }) }, {
      revise: { enabled: true, prompt: '# Fix', maxRevisions: 2 },
      review: { enabled: true, pool: 'reviewers', prompt: '# Look', allowSameAgent: true },
    });
    const r = compile(ok({ ...base, agents: { ...base.agents, claude: { adapter: 'claude', model: 'claude-sonnet-5-5', effort: 'high', enabled: true } } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const yaml = yamlOf(r.files);
    expect(yaml.agents.claude).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
    expect(yaml.repositories['acme/web']).toMatchObject({ review: { allowSameAgent: true }, revise: true, maxRevisions: 2, autoMerge: 'squash', autoMergeWaitMinutes: 30, autoMergeRequiredChecks: ['ci'] });
    expect(r.files['prompts/implement.revise.md']).toBe('# Fix');
  });
});

describe('parseConsoleConfig', () => {
  it('refuses unknown fields, including the platform-enforced ones', () => {
    expect(errorsOf({ ...settings(), github: { app: { appId: 1 } } })).toEqual([expect.objectContaining({ path: 'github' })]);
    expect(errorsOf(settings({ 'acme/web': repo({ checkoutPath: '/etc' }) }))).toEqual([expect.objectContaining({ path: 'repositories.acme/web.checkoutPath' })]);
    expect(errorsOf({ ...settings(), agents: { claude: { adapter: 'claude', container: { image: 'x' } } } })).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'agents.claude.container' })]),
    );
    expect(errorsOf(settings({ 'acme/web': repo({ publish: 'none' }) }))).toEqual([expect.objectContaining({ path: 'repositories.acme/web.publish' })]);
  });

  it('knows only the agents Updraft Cloud runs, and pools of agents on the roster', () => {
    expect(errorsOf({ ...settings(), agents: { ...settings().agents, gem: { adapter: 'gemini' } } })).toEqual([expect.objectContaining({ path: 'agents.gem.adapter' })]);
    expect(errorsOf({ ...settings(), pools: { ...settings().pools, builders: { agents: ['claude', 'ghost'] } } })).toEqual([expect.objectContaining({ path: 'pools.builders.agents.1' })]);
    expect(errorsOf(settings(undefined, { pool: 'nope' }))).toEqual([expect.objectContaining({ path: 'workflows.implement.pool' })]);
  });

  it('refuses a pool a job routes to when every agent in it is off', () => {
    const base = settings();
    const off = { ...base, agents: { claude: { adapter: 'claude', enabled: false }, codex: { adapter: 'codex', enabled: false } } };
    expect(errorsOf(off)).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'pools.builders', message: expect.stringMatching(/every agent in this pool is off/) })]));
  });

  it('refuses a reviewer that could only review its own work, unless that is allowed', () => {
    const base = settings();
    const solo = { ...base, pools: { builders: { agents: ['claude'] }, reviewers: { agents: ['claude'] } } };
    expect(errorsOf(solo)).toEqual([expect.objectContaining({ path: 'workflows.implement.review.pool', message: expect.stringMatching(/claude would review its own work/) })]);
    expect(errorsOf({ ...solo, workflows: { implement: { ...base.workflows.implement, review: { ...base.workflows.implement!.review, allowSameAgent: true } } } })).toEqual([]);
    // Both agents build and both review: each is reviewed by the other.
    expect(errorsOf(base)).toEqual([]);
  });

  it('needs someone who may start work', () => {
    expect(errorsOf({ ...settings(), allowedActors: [] })).toEqual([expect.objectContaining({ path: 'allowedActors', message: expect.stringMatching(/at least one/) })]);
    expect(errorsOf({ ...settings({ 'acme/web': repo({ allowedActors: ['sam'] }) }), allowedActors: [] })).toEqual([]);
    expect(errorsOf(settings({ 'acme/web': repo({ allowedActors: [] }) }))).toEqual([expect.objectContaining({ path: 'repositories.acme/web.allowedActors' })]);
  });

  it('checks the workflows a repository runs: known ones, labels of their own, the same pull-request handling', () => {
    expect(errorsOf(settings({ 'acme/web': repo({ workflows: ['nope'] }) }))).toEqual([expect.objectContaining({ path: 'repositories.acme/web.workflows.0' })]);
    expect(errorsOf(settings({ 'acme/web': repo({ workflows: [] }) }))).toEqual([expect.objectContaining({ path: 'repositories.acme/web.workflows' })]);
    const base = settings({ 'acme/web': repo({ workflows: ['implement', 'docs'] }) });
    const docs = { ...base.workflows.implement!, label: 'UPDRAFT' };
    expect(errorsOf({ ...base, workflows: { ...base.workflows, docs } })).toEqual([expect.objectContaining({ path: 'repositories.acme/web.workflows', message: expect.stringMatching(/both start on the label/) })]);
    expect(errorsOf({ ...base, workflows: { ...base.workflows, docs: { ...docs, label: 'docs', ...reviewOff } } })).toEqual([
      expect.objectContaining({ path: 'repositories.acme/web.workflows', message: expect.stringMatching(/handle pull requests differently/) }),
    ]);
    expect(errorsOf({ ...base, workflows: { ...base.workflows, docs: { ...docs, label: 'docs' } } })).toEqual([]);
  });

  it('keeps timeouts and revision rounds within the platform ceilings', () => {
    expect(errorsOf(settings({ 'acme/web': repo({ verify: ['x'], verifyTimeoutMinutes: 31 }) }, { timeoutMinutes: 500 }))).toEqual([
      expect.objectContaining({ path: 'workflows.implement.timeoutMinutes' }),
      expect.objectContaining({ path: 'repositories.acme/web.verifyTimeoutMinutes' }),
    ]);
    expect(errorsOf(settings(undefined, { revise: { enabled: true, prompt: 'x', maxRevisions: 9 } }))).toEqual([expect.objectContaining({ path: 'workflows.implement.revise.maxRevisions' })]);
  });

  it('allows auto-merge only where a workflow reviews', () => {
    expect(errorsOf(settings({ 'acme/web': repo({ autoMerge: { method: 'squash' } }) }, reviewOff))).toEqual([
      expect.objectContaining({ path: 'repositories.acme/web.autoMerge', message: expect.stringMatching(/review/) }),
    ]);
  });

  it('refuses verify commands that are not one line', () => {
    expect(errorsOf(settings({ 'acme/web': repo({ verify: ['npm test\nrm -rf /'] }) }))).toEqual([expect.objectContaining({ path: 'repositories.acme/web.verify.0' })]);
  });

  it('needs at least one repository, workflow, agent and pool', () => {
    expect(errorsOf(settings({}))).toEqual([expect.objectContaining({ path: 'repositories' })]);
    expect(errorsOf({ ...settings(), workflows: {}, agents: {}, pools: {} })).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'workflows' }), expect.objectContaining({ path: 'agents' }), expect.objectContaining({ path: 'pools' })]),
    );
  });
});

describe('settings from the first console (version 1)', () => {
  const v1 = (repos: Record<string, unknown>, workflows: Record<string, unknown> = {}) => ({
    version: 1,
    workflows: {
      implement: { agent: { adapter: 'claude' }, prompt: '# Build', reviewer: { adapter: 'codex', prompt: '# Review' }, revisePrompt: '# Revise', verify: ['npm test'], timeoutMinutes: 30 },
      ...workflows,
    },
    repositories: repos,
  });
  const v1Repo = (over: Record<string, unknown> = {}) => ({ enabled: true, triggers: [{ label: 'updraft', workflow: 'implement' }], allowedActors: ['pat'], publish: 'draft-pr', commentOnFailure: true, review: false, revise: false, ...over });

  it('become pools of the agent and the reviewer, with the repository keeping its verify commands', () => {
    const config = ok(v1({ 'acme/web': v1Repo({ review: true, revise: true, maxRevisions: 2, autoMerge: { method: 'squash' } }) }));
    expect(config).toEqual({
      version: 2,
      agents: { claude: { adapter: 'claude', enabled: true }, codex: { adapter: 'codex', enabled: true } },
      pools: { builders: { agents: ['claude'] }, reviewers: { agents: ['codex'] } },
      allowedActors: ['pat'],
      workflows: {
        implement: {
          label: 'updraft',
          pool: 'builders',
          prompt: '# Build',
          timeoutMinutes: 30,
          review: { enabled: true, pool: 'reviewers', prompt: '# Review', allowSameAgent: false },
          revise: { enabled: true, prompt: '# Revise', maxRevisions: 2 },
        },
      },
      repositories: { 'acme/web': { enabled: true, workflows: ['implement'], publish: 'draft-pr', commentOnFailure: true, verify: ['npm test'], autoMerge: { method: 'squash' } } },
      legacy: { pools: { implement: 'builders', 'implement.review': 'reviewers' }, workflows: { implement: 'implement' } },
    });
    expect(compile(config).ok).toBe(true);
  });

  it('split a workflow that repositories ran on different labels or with different review, and keep differing actors', () => {
    const config = ok(
      v1({
        'acme/web': v1Repo({ review: true }),
        'acme/api': v1Repo({ triggers: [{ label: 'go', workflow: 'implement' }], allowedActors: ['sam'] }),
      }),
    );
    expect(Object.keys(config.workflows)).toEqual(['implement', 'implement-2']);
    expect(config.workflows['implement-2']).toMatchObject({ label: 'go', review: { enabled: false } });
    expect(config.repositories['acme/api']).toMatchObject({ workflows: ['implement-2'], allowedActors: ['sam'] });
    expect(config.repositories['acme/web']).not.toHaveProperty('allowedActors');
    expect(compile(config).ok).toBe(true);
  });

  it('a reviewer with the builder\'s very profile stays another agent, as in version 1, so no new self-review is allowed', () => {
    const config = ok(v1({ 'acme/web': v1Repo({ review: true }) }, { implement: { agent: { adapter: 'claude' }, prompt: '# B', reviewer: { adapter: 'claude', prompt: '# R' }, revisePrompt: '# V', verify: [] } }));
    expect(config.agents).toEqual({ claude: { adapter: 'claude', enabled: true }, 'claude-2': { adapter: 'claude', enabled: true } });
    expect(config.pools).toEqual({ builders: { agents: ['claude'] }, reviewers: { agents: ['claude-2'] } });
    expect(config.workflows.implement!.review).toMatchObject({ pool: 'reviewers', allowSameAgent: false });
    expect(compile(config).ok).toBe(true);
  });

  it('loads a repository that reviewed one workflow with the builder\'s profile and another with a different one', () => {
    const config = ok(
      v1(
        { 'acme/web': v1Repo({ review: true, triggers: [{ label: 'a', workflow: 'implement' }, { label: 'b', workflow: 'docs' }] }) },
        {
          implement: { agent: { adapter: 'claude' }, prompt: '# B', reviewer: { adapter: 'claude', prompt: '# R' }, revisePrompt: '# V', verify: [] },
          docs: { agent: { adapter: 'claude' }, prompt: '# D', reviewer: { adapter: 'codex', prompt: '# R' }, revisePrompt: '# V', verify: [] },
        },
      ),
    );
    expect(Object.values(config.workflows).map((w) => w.review.allowSameAgent)).toEqual([false, false]);
    expect(compile(config).ok).toBe(true);
  });

  it('loads seven reviewed workflows with fourteen distinct models', () => {
    const workflows = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [`w${i}`, { agent: { adapter: 'claude', model: `build-${i}` }, prompt: '# B', reviewer: { adapter: 'codex', model: `review-${i}` }, revisePrompt: '# V', verify: [] }]),
    );
    for (const w of Object.values(workflows)) (w.reviewer as Record<string, unknown>).prompt = '# R';
    const config = ok({ version: 1, workflows, repositories: { 'acme/web': v1Repo({ review: true, triggers: Object.keys(workflows).map((w) => ({ label: w, workflow: w })) }) } });
    expect(Object.keys(config.agents)).toHaveLength(14);
    expect(compile(config).ok).toBe(true);
  });

  it('a workflow split over 21 labels with review and revision publishes its three prompt files once', () => {
    const repos = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`acme/r${i}`, v1Repo({ review: true, revise: true, triggers: [{ label: `l${i}`, workflow: 'implement' }] })]));
    const config = ok(v1(repos));
    const r = compileTenantConfig(toTenantSubmission(config), { appId: 4242 }, new Map(Object.keys(repos).map((n, i) => [n, 700 + i])));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.files).filter((f) => f.startsWith('prompts/')).sort()).toEqual(['prompts/implement.md', 'prompts/implement.review.md', 'prompts/implement.revise.md']);
  });
});

describe('work in flight across the upgrade from version 1 (#98 review)', () => {
  const v1Doc = (repos: Record<string, unknown>, docsVerify: string[] = []) => ({
    version: 1,
    workflows: {
      implement: { agent: { adapter: 'claude' }, prompt: '# Build', reviewer: { adapter: 'codex', prompt: '# Review' }, revisePrompt: '# Revise', verify: ['npm test'] },
      docs: { agent: { adapter: 'codex' }, prompt: '# Docs', reviewer: { adapter: 'claude', prompt: '# Review docs' }, revisePrompt: '# Revise docs', verify: docsVerify },
    },
    repositories: repos,
  });
  const v1Repo = (triggers: { label: string; workflow: string }[], over: Record<string, unknown> = {}) => ({ enabled: true, triggers, allowedActors: ['pat'], publish: 'draft-pr', commentOnFailure: true, review: false, revise: false, ...over });
  const ids = new Map([['acme/web', 99], ['acme/api', 100], ['acme/new', 101]]);
  const compiled = (sub: ReturnType<typeof toTenantSubmission>) => {
    const r = compileTenantConfig(sub, { appId: 4242 }, ids);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return yamlOf(r.files) as Compiled & { pools: Record<string, { agents: string[] }>; agents: Record<string, { adapter?: string }> };
  };
  /** What a job or pull request opened under a config stored: per repository, workflow id, action and pools. */
  const stored = (yaml: ReturnType<typeof compiled>) =>
    Object.entries(yaml.repositories).flatMap(([repo, r]) =>
      r.workflows.map((wf) => ({ repo, id: workflowId(wf as Parameters<typeof workflowId>[0]), action: wf.action as string, pool: wf.pool as string, reviewPool: wf.reviewPool as string | undefined })),
    );
  const adapters = (yaml: ReturnType<typeof compiled>, pool: string) => yaml.pools[pool]!.agents.map((a) => yaml.agents[a]!.adapter ?? a).sort();

  it('a job or pull request opened under version 1 finds its workflow, action and pools once the upgraded settings are published, and after an unrelated edit', () => {
    const doc = v1Doc({
      'acme/web': v1Repo([{ label: 'updraft', workflow: 'implement' }], { review: true, revise: true }),
      'acme/api': v1Repo([{ label: 'go', workflow: 'implement' }, { label: 'docs', workflow: 'docs' }]),
      // Two workflows in one repository with the same checks: one list holds them (the case with
      // different checks is the next-but-one test's).
    }, ['npm test']);
    const parsedV1 = v1.parseConsoleConfig(doc);
    if (!parsedV1.ok) throw new Error('v1 did not parse');
    const before = compiled(v1.toTenantSubmission(parsedV1.config));
    const upgraded = ok(doc);
    // An unrelated edit: another repository, with checks of its own, and a paused one.
    const edited = ok({ ...upgraded, repositories: { ...upgraded.repositories, 'acme/api': { ...upgraded.repositories['acme/api']!, enabled: false }, 'acme/new': repo({ workflows: ['implement'], verify: ['make check'] }) } });

    for (const config of [upgraded, edited]) {
      const after = compiled(toTenantSubmission(config));
      for (const ref of stored(before)) {
        // As the poller looks up a pull request's workflow (reviews.ts), and a job its action and pool.
        const wf = after.repositories[ref.repo]!.workflows.find((x) => workflowId(x as Parameters<typeof workflowId>[0]) === ref.id);
        expect(wf, `${ref.repo} ${ref.id}`).toBeDefined();
        expect(after.actions[ref.action], ref.action).toEqual(expect.objectContaining({ verify: (before.actions[ref.action] as { verify?: string[] }).verify ?? undefined }));
        expect(adapters(after, ref.pool), ref.pool).toEqual(adapters(before, ref.pool));
        if (ref.reviewPool) expect(adapters(after, ref.reviewPool), ref.reviewPool).toEqual(adapters(before, ref.reviewPool));
      }
    }
    expect(stored(before).map((r) => r.id).sort()).toEqual(['docs:docs', 'implement:go', 'implement:updraft']);
  });

  it('keeps version 1 settings that split into more workflows than the editor allows loadable and publishable', () => {
    const repos = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`acme/r${i}`, v1Repo([{ label: `label-${i}`, workflow: 'implement' }])]));
    const config = ok(v1Doc(repos));
    expect(Object.keys(config.workflows)).toHaveLength(22);
    const r = compileTenantConfig(toTenantSubmission(config), { appId: 4242 }, new Map(Object.keys(repos).map((n, i) => [n, 500 + i])));
    expect(r.ok).toBe(true);
    // A new workflow of the tenant's own still counts against the limit.
    const more = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`new-${i}`, { ...config.workflows.implement!, label: `n${i}` }]));
    expect(errorsOf({ ...config, workflows: { ...config.workflows, ...more } })).toEqual([expect.objectContaining({ path: 'workflows', message: expect.stringMatching(/at most 20/) })]);
  });

  it('says when a repository ran workflows with different checks, which the upgrade folds into one list', () => {
    const doc = v1Doc({ 'acme/api': v1Repo([{ label: 'docs', workflow: 'docs' }, { label: 'go', workflow: 'implement' }]), 'acme/web': v1Repo([{ label: 'go', workflow: 'implement' }]) });
    expect(upgradeNotes(doc)).toEqual([expect.stringMatching(/^acme\/api ran docs and implement with different checks. It now has one list, docs's/)]);
    expect(upgradeNotes(settings())).toEqual([]);
  });
});

describe('the version record (#83 review)', () => {
  // 50 distinct 30-character logins on 30 repositories with 10 workflows each: copied to every
  // trigger, the actors alone came to about 450 KB, over DynamoDB's 400 KB item limit.
  const actors = Array.from({ length: 50 }, (_, i) => `user-${String(i).padStart(2, '0')}-${'x'.repeat(22)}`);
  const base = settings();
  const workflows = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`w${i}`, { ...base.workflows.implement!, label: `label-${i}` }]));
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`acme/repo-${i}`, repo({ allowedActors: actors, workflows: Object.keys(workflows) })]));
  const ids = new Map(Object.keys(many).map((name, i) => [name, 1000 + i]));
  const big = () => ok({ ...base, workflows, repositories: many });

  it('stores a shared actor list once per repository, so the example from the review fits', () => {
    const r = compile(big(), ids);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Buffer.byteLength(JSON.stringify(r.dispatch))).toBeLessThan(60 * 1024);
  });

  it('refuses dispatch rules too large for one record, at preview as at publish', () => {
    const sub = toTenantSubmission(big());
    // Different actors on every trigger (possible in a tenant-admin document): nothing to share.
    const repos = (sub.config as { repositories: Record<string, { workflows: { allowedActors: string[] }[] }> }).repositories;
    for (const r of Object.values(repos)) r.workflows.forEach((w, i) => (w.allowedActors = actors.map((a) => `${a.slice(0, 28)}${i}`)));
    const r = compileTenantConfig(sub, { appId: 4242 }, ids);
    expect(r).toEqual({ ok: false, errors: [expect.objectContaining({ path: 'repositories', message: expect.stringMatching(/too many/) })] });
  });
});

describe('toConsolePath', () => {
  const config = ok(settings({ 'acme/web.site': repo({ verify: ['npm test'] }), 'acme/api': repo({ allowedActors: ['sam'] }) }));
  it.each([
    ['agents.claude.model', 'agents.claude.model'],
    ['pools.reviewers.agents.0', 'pools.reviewers.agents.0'],
    ['actions.implement.reviewPrompt', 'workflows.implement.review.prompt'],
    ['actions.implement.revisePrompt', 'workflows.implement.revise.prompt'],
    ['actions.implement.timeoutMinutes', 'workflows.implement.timeoutMinutes'],
    ['actions.implement.verify.0', 'repositories.acme/web.site.verify.0'],
    ['actions.implement.2.timeoutMinutes', 'workflows.implement.timeoutMinutes'],
    ['prompts/implement.revise.md', 'workflows.implement.revise.prompt'],
    ['repositories.acme/web.site.workflows.0.trigger.label', 'workflows.implement.label'],
    ['repositories.acme/web.site.workflows.0.reviewPool', 'workflows.implement.review.pool'],
    ['repositories.acme/web.site.workflows.0.allowedActors.1', 'allowedActors.1'],
    ['repositories.acme/api.workflows.0.allowedActors', 'repositories.acme/api.allowedActors'],
    ['repositories.acme/web.site.review', 'repositories.acme/web.site.workflows'],
    ['repositories.acme/web.site.autoMergeWaitMinutes', 'repositories.acme/web.site.autoMerge.waitMinutes'],
    ['repositories.acme/web.site', 'repositories.acme/web.site'],
    ['dispatch.allowedActors', 'allowedActors'],
    ['something.else', 'something.else'],
  ])('%s -> %s', (from, to) => expect(toConsolePath(from, config)).toBe(to));
});

describe('missingKeys', () => {
  it('needs the key of every agent that is on in a pool an enabled repository can start', () => {
    const config = ok(settings());
    expect(missingKeys(config, new Set())).toEqual([
      expect.objectContaining({ path: 'agents.claude', message: expect.stringMatching(/ANTHROPIC_API_KEY, or turn this agent off/) }),
      expect.objectContaining({ path: 'agents.codex', message: expect.stringMatching(/CODEX_API_KEY/) }),
    ]);
    expect(missingKeys(config, new Set(['ANTHROPIC_API_KEY', 'CODEX_API_KEY']))).toEqual([]);
  });

  it('a paused repository needs no key, nor an agent that is off', () => {
    expect(missingKeys(ok(settings({ 'acme/web': repo({ enabled: false }) })), new Set())).toEqual([]);
    const base = settings(undefined, { review: { ...settings().workflows.implement!.review, allowSameAgent: true } });
    expect(missingKeys(ok({ ...base, agents: { ...base.agents, codex: { adapter: 'codex', enabled: false } } }), new Set(['ANTHROPIC_API_KEY']))).toEqual([]);
  });
});
