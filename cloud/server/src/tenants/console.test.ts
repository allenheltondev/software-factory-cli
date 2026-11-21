import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { compileTenantConfig } from './config.js';
import { defaultConsoleConfig, missingKeys, parseConsoleConfig, toConsolePath, toTenantSubmission, type ConsoleConfig } from './console.js';
import { DEFAULT_PROMPTS } from './default-prompts.js';

const repo = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  triggers: [{ label: 'updraft', workflow: 'implement' }],
  allowedActors: ['pat'],
  publish: 'draft-pr',
  commentOnFailure: true,
  review: false,
  revise: false,
  ...over,
});

const settings = (repos: Record<string, unknown> = { 'acme/web': repo() }, workflowOver: Record<string, unknown> = {}) => {
  const d = defaultConsoleConfig();
  return { ...d, workflows: { implement: { ...d.workflows.implement, ...workflowOver } }, repositories: repos };
};

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
  actions: Record<string, unknown>;
  repositories: Record<string, { workflows: Record<string, unknown>[]; [key: string]: unknown }>;
}
const yamlOf = (files: Record<string, string>) => parse(files['config.yaml']!) as Compiled;

const compile = (config: ConsoleConfig, ids = new Map([['acme/web', 99], ['acme/api', 100]])) => compileTenantConfig(toTenantSubmission(config), { appId: 4242 }, ids);

describe('defaults', () => {
  it('start from the prompts the package ships', () => {
    const d = defaultConsoleConfig();
    expect(DEFAULT_PROMPTS.implement.length).toBeGreaterThan(100);
    expect(d.workflows.implement).toMatchObject({ agent: { adapter: 'claude' }, reviewer: { adapter: 'codex', prompt: DEFAULT_PROMPTS.review }, prompt: DEFAULT_PROMPTS.implement, revisePrompt: DEFAULT_PROMPTS.revise });
  });
});

describe('parseConsoleConfig', () => {
  it('accepts the settings a new repository starts with, and compiles them to a draft PR with no auto-merge', () => {
    const r = compile(ok(settings()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const yaml = yamlOf(r.files);
    expect(yaml.repositories['acme/web']).toMatchObject({ id: 99, publish: 'draft-pr', checkoutPath: './clones/web' });
    expect(yaml.repositories['acme/web']?.autoMerge).toBeUndefined();
    expect(yaml.repositories['acme/web']?.workflows).toEqual([{ trigger: { event: 'issue.labeled', label: 'updraft' }, action: 'implement', pool: 'implement', allowedActors: ['pat'] }]);
    expect(yaml.agents.implement).toMatchObject({ adapter: 'claude', container: expect.any(Object) });
    expect(r.files['prompts/implement.md']).toBe(DEFAULT_PROMPTS.implement);
    // No reviewer agent or prompts when no repository reviews or revises.
    expect(Object.keys(r.files).sort()).toEqual(['config.yaml', 'prompts/implement.md']);
    expect(r.dispatch.repositories['acme/web']).toEqual({ id: 99, actors: ['pat'], keys: ['ANTHROPIC_API_KEY'], triggers: [{ label: 'updraft' }] });
    // What the agents it can start need: the workflow's agent; no reviewer without review.
    expect(r.keys).toEqual([{ path: 'agents.implement', key: 'ANTHROPIC_API_KEY' }]);
  });

  it('refuses an empty allowed-actor list', () => {
    expect(errorsOf(settings({ 'acme/web': repo({ allowedActors: [] }) }))).toEqual([
      expect.objectContaining({ path: 'repositories.acme/web.allowedActors', message: expect.stringMatching(/at least one/) }),
    ]);
  });

  it('refuses unknown fields, including the platform-enforced ones', () => {
    expect(errorsOf({ ...settings(), github: { app: { appId: 1 } } })).toEqual([expect.objectContaining({ path: 'github' })]);
    expect(errorsOf(settings({ 'acme/web': repo({ checkoutPath: '/etc' }) }))).toEqual([expect.objectContaining({ path: 'repositories.acme/web.checkoutPath' })]);
    expect(errorsOf(settings(undefined, { agent: { adapter: 'claude', container: { image: 'x' } } }))).toEqual([expect.objectContaining({ path: 'workflows.implement.agent.container' })]);
    expect(errorsOf(settings({ 'acme/web': repo({ publish: 'none' }) }))).toEqual([expect.objectContaining({ path: 'repositories.acme/web.publish' })]);
  });

  it('only lets agents the image ships run', () => {
    expect(errorsOf(settings(undefined, { agent: { adapter: 'kiro' } }))).toEqual([expect.objectContaining({ path: 'workflows.implement.agent.adapter' })]);
  });

  it('checks triggers: a known workflow, one label once', () => {
    expect(errorsOf(settings({ 'acme/web': repo({ triggers: [{ label: 'x', workflow: 'nope' }] }) }))).toEqual([expect.objectContaining({ path: 'repositories.acme/web.triggers.0.workflow' })]);
    expect(
      errorsOf(settings({ 'acme/web': repo({ triggers: [{ label: 'Go', workflow: 'implement' }, { label: 'go', workflow: 'implement' }] }) })),
    ).toEqual([expect.objectContaining({ path: 'repositories.acme/web.triggers.1.label' })]);
    expect(errorsOf(settings({ 'acme/web': repo({ triggers: [] }) }))).toEqual([expect.objectContaining({ path: 'repositories.acme/web.triggers' })]);
  });

  it('keeps timeouts within the platform ceilings', () => {
    expect(errorsOf(settings(undefined, { timeoutMinutes: 500, verifyTimeoutMinutes: 31 }))).toEqual([
      expect.objectContaining({ path: 'workflows.implement.timeoutMinutes' }),
      expect.objectContaining({ path: 'workflows.implement.verifyTimeoutMinutes' }),
    ]);
  });

  it('allows auto-merge only with review', () => {
    expect(errorsOf(settings({ 'acme/web': repo({ autoMerge: { method: 'squash' } }) }))).toEqual([
      expect.objectContaining({ path: 'repositories.acme/web.autoMerge', message: expect.stringMatching(/review/) }),
    ]);
  });

  it('refuses verify commands that are not one line', () => {
    expect(errorsOf(settings(undefined, { verify: ['npm test\nrm -rf /'] }))).toEqual([expect.objectContaining({ path: 'workflows.implement.verify.0' })]);
  });

  it('needs at least one repository and one workflow', () => {
    expect(errorsOf(settings({}))).toEqual([expect.objectContaining({ path: 'repositories' })]);
    expect(errorsOf({ version: 1, workflows: {}, repositories: { 'acme/web': repo() } })).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'workflows' })]),
    );
  });
});

describe('toTenantSubmission', () => {
  it('a paused repository stays configured, and its dispatch rules start nothing', () => {
    const r = compile(ok(settings({ 'acme/web': repo({ enabled: false }), 'acme/api': repo() })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const yaml = yamlOf(r.files);
    expect(yaml.repositories['acme/web']).toBeDefined();
    expect(yaml.repositories['acme/web']?.paused).toBeUndefined();
    expect(r.dispatch.repositories['acme/web']?.paused).toBe(true);
    expect(r.dispatch.repositories['acme/api']?.paused).toBeUndefined();
  });

  it('review, revision and auto-merge compile to a separate reviewer with its own prompts', () => {
    const config = ok(
      settings(
        { 'acme/web': repo({ review: true, revise: true, maxRevisions: 2, autoMerge: { method: 'squash', waitMinutes: 30, requiredChecks: ['ci'] } }) },
        { agent: { adapter: 'claude', model: 'claude-sonnet-5-5', effort: 'high' }, verify: ['npm test'], verifyTimeoutMinutes: 20 },
      ),
    );
    const r = compile(config);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const yaml = yamlOf(r.files);
    expect(yaml.agents.implement).toMatchObject({ adapter: 'claude', model: 'claude-sonnet-5-5', effort: 'high' });
    expect(yaml.agents['implement.review']).toMatchObject({ adapter: 'codex' });
    expect(yaml.actions.implement).toEqual({
      prompt: './prompts/implement.md',
      verify: ['npm test'],
      verifyTimeoutMinutes: 20,
      reviewPrompt: './prompts/implement.review.md',
      revisePrompt: './prompts/implement.revise.md',
    });
    expect(yaml.repositories['acme/web']).toMatchObject({ review: true, revise: true, maxRevisions: 2, autoMerge: 'squash', autoMergeWaitMinutes: 30, autoMergeRequiredChecks: ['ci'] });
    expect(yaml.repositories['acme/web']?.workflows[0]?.reviewPool).toBe('implement.review');
  });
});

describe('the version record (#83 review)', () => {
  // 50 distinct 30-character logins on 30 repositories with 10 triggers each: copied to every
  // trigger, the actors alone came to about 450 KB, over DynamoDB's 400 KB item limit.
  const actors = Array.from({ length: 50 }, (_, i) => `user-${String(i).padStart(2, '0')}-${'x'.repeat(22)}`);
  const triggers = Array.from({ length: 10 }, (_, i) => ({ label: `label-${i}`, workflow: 'implement' }));
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`acme/repo-${i}`, repo({ allowedActors: actors, triggers })]));
  const ids = new Map(Object.keys(many).map((name, i) => [name, 1000 + i]));

  it('stores a shared actor list once per repository, so the example from the review fits', () => {
    const r = compile(ok(settings(many)), ids);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Buffer.byteLength(JSON.stringify(r.dispatch))).toBeLessThan(60 * 1024);
  });

  it('refuses dispatch rules too large for one record, at preview as at publish', () => {
    const sub = toTenantSubmission(ok(settings(many)));
    // Different actors on every trigger (possible in a tenant-admin document): nothing to share.
    const repos = (sub.config as { repositories: Record<string, { workflows: { allowedActors: string[] }[] }> }).repositories;
    for (const r of Object.values(repos)) r.workflows.forEach((w, i) => (w.allowedActors = actors.map((a) => `${a.slice(0, 28)}${i}`)));
    const r = compileTenantConfig(sub, { appId: 4242 }, ids);
    expect(r).toEqual({ ok: false, errors: [expect.objectContaining({ path: 'repositories', message: expect.stringMatching(/too many/) })] });
  });
});

describe('toConsolePath', () => {
  const config = ok(settings({ 'acme/web.site': repo({ review: true }) }));
  it.each([
    ['agents.implement.review.model', 'workflows.implement.reviewer.model'],
    ['agents.implement.model', 'workflows.implement.agent.model'],
    ['actions.implement.reviewPrompt', 'workflows.implement.reviewer.prompt'],
    ['actions.implement.verify.0', 'workflows.implement.verify.0'],
    ['prompts/implement.revise.md', 'workflows.implement.revisePrompt'],
    ['repositories.acme/web.site.workflows.0.trigger.label', 'repositories.acme/web.site.triggers.0.label'],
    ['repositories.acme/web.site.workflows.0.allowedActors', 'repositories.acme/web.site.allowedActors'],
    ['repositories.acme/web.site.autoMergeWaitMinutes', 'repositories.acme/web.site.autoMerge.waitMinutes'],
    ['repositories.acme/web.site', 'repositories.acme/web.site'],
    ['something.else', 'something.else'],
  ])('%s -> %s', (from, to) => expect(toConsolePath(from, config)).toBe(to));
});

describe('missingKeys', () => {
  it('needs the key of every agent an enabled repository can start', () => {
    const config = ok(settings({ 'acme/web': repo({ review: true }) }));
    expect(missingKeys(config, new Set())).toEqual([
      expect.objectContaining({ path: 'workflows.implement.agent.adapter', message: expect.stringMatching(/ANTHROPIC_API_KEY/) }),
      expect.objectContaining({ path: 'workflows.implement.reviewer.adapter', message: expect.stringMatching(/CODEX_API_KEY/) }),
    ]);
    expect(missingKeys(config, new Set(['ANTHROPIC_API_KEY', 'CODEX_API_KEY']))).toEqual([]);
  });

  it('a paused repository needs no key, and a reviewer only where review is on', () => {
    expect(missingKeys(ok(settings({ 'acme/web': repo({ enabled: false }) })), new Set())).toEqual([]);
    expect(missingKeys(ok(settings()), new Set(['ANTHROPIC_API_KEY']))).toEqual([]);
  });
});
