import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { validateConfig } from './validate.js';
import { selectPool } from '../routing.js';
import { getAdapter, registerAdapter } from '../agents/adapters/registry.js';
import { fakeAdapter } from '../../test/fake-adapter.js';

const example = () => parse(readFileSync(new URL('../../examples/config.yaml', import.meta.url), 'utf8'));

describe('validateConfig', () => {
  it('native subscription auth requires a host-native Claude adapter', () => {
    const cfg = example();
    cfg.agents.claude = { enabled: true, authentication: 'native-claude' };
    expect(validateConfig(cfg).ok).toBe(true);
    cfg.agents.claude.container = { image: 'example/claude:latest' };
    const contained = validateConfig(cfg);
    expect(contained.ok).toBe(false);
    if (!contained.ok) expect(contained.errors).toContainEqual({ path: 'agents.claude.authentication', message: expect.stringMatching(/credential isolation/) });
    delete cfg.agents.claude.container;
    cfg.agents.claude.adapter = 'kiro';
    const wrong = validateConfig(cfg);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.errors).toContainEqual({ path: 'agents.claude.authentication', message: expect.stringMatching(/Claude adapter/) });
  });

  it('accepts the shipped example and applies defaults', () => {
    const r = validateConfig(example());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.execution.mode).toBe('log-only');
    expect(r.config.pools.art?.strategy).toBe('round-robin');
    expect(r.config.agents.codex?.enabled).toBe(true);
  });

  it('accepts ciFix as true or with options, and warns where it cannot act', () => {
    const repo = 'allenheltondev/kids-and-dragons';
    const cfg = example();
    cfg.repositories[repo].publish = 'draft-pr';
    cfg.repositories[repo].ciFix = { checks: ['test'], ignore: ['preview'], waitMinutes: 30 };
    const noReview = validateConfig(cfg);
    expect(noReview.ok).toBe(true);
    expect(noReview.warnings).toContainEqual({ path: `repositories.${repo}.ciFix`, message: expect.stringMatching(/no effect without review/) });

    cfg.repositories[repo].review = true;
    const noRevise = validateConfig(cfg);
    expect(noRevise.warnings).toContainEqual({ path: `repositories.${repo}.ciFix`, message: expect.stringMatching(/revise is off, so a failing check is only reported/) });

    // autoMergeRequiredChecks names the deciding checks for ciFix too, so it is not "no effect" there.
    cfg.repositories[repo].revise = true;
    cfg.repositories[repo].ciFix = true;
    cfg.repositories[repo].autoMergeRequiredChecks = ['test'];
    expect(validateConfig(cfg).warnings.filter((w) => w.path.endsWith('.ciFix') || w.path.endsWith('.autoMergeRequiredChecks'))).toEqual([]);

    cfg.repositories[repo].ciFix = { waitMinutes: 0 };
    expect(validateConfig(cfg).ok).toBe(false);
    cfg.repositories[repo].ciFix = { unknown: true };
    expect(validateConfig(cfg).ok).toBe(false);
  });

  it('defaults publish to none and warns when it is set outside live mode', () => {
    const repo = 'allenheltondev/kids-and-dragons';
    const plain = validateConfig(example());
    expect(plain.ok && plain.warnings.some((w) => w.path.endsWith('.publish'))).toBe(false);

    const cfg = example();
    cfg.repositories[repo].publish = 'draft-pr';
    const r = validateConfig(cfg);
    expect(r.ok).toBe(true);
    expect(r.warnings).toContainEqual({ path: `repositories.${repo}.publish`, message: expect.stringMatching(/only applies in live mode/) });

    cfg.repositories[repo].publish = 'always';
    expect(validateConfig(cfg).ok).toBe(false);
  });

  it('accepts verify commands as strings or argv arrays and rejects malformed ones', () => {
    const live = () => {
      const cfg = example();
      cfg.execution = { mode: 'live' };
      for (const repo of Object.values(cfg.repositories) as Array<{ checkoutPath?: string }>) repo.checkoutPath ??= './clone';
      return cfg;
    };
    const restore = [registerAdapter(fakeAdapter({ name: 'claude' })), registerAdapter(fakeAdapter({ name: 'kiro' })), registerAdapter(fakeAdapter({ name: 'codex' }))];
    try {
      const cfg = live();
      const action = Object.keys(cfg.actions).find((a) => (cfg.actions[a].output ?? 'local-branch') === 'local-branch')!;
      cfg.actions[action].verify = ['npm ci', ['node', '--test', 'a file.js']];
      cfg.actions[action].verifyTimeoutMinutes = 20;
      const ok = validateConfig(cfg);
      expect(ok.ok).toBe(true);
      expect(ok.warnings.filter((w) => w.path.includes('verify'))).toEqual([]);

      for (const bad of ['npm test', [], [''], ['   '], ['npm ci\nnpm test'], [[]], [['', 'x']], [42], [['node', 1]]]) {
        const c = live();
        c.actions[action].verify = bad;
        const r = validateConfig(c);
        expect(r.ok, JSON.stringify(bad)).toBe(false);
        if (!r.ok) expect(r.errors.every((e) => e.path.startsWith(`actions.${action}.verify`)), JSON.stringify(r.errors)).toBe(true);
      }
      const c = live();
      c.actions[action].verify = ['npm test'];
      c.actions[action].verifyTimeoutMinutes = 0;
      expect(validateConfig(c).ok).toBe(false);
    } finally {
      for (const r of restore.reverse()) r();
    }
  });

  it('warns when verify is set where it does nothing', () => {
    const cfg = example();
    const action = Object.keys(cfg.actions)[0]!;
    cfg.actions[action].verify = ['npm test'];
    const logOnly = validateConfig(cfg);
    expect(logOnly.ok).toBe(true);
    expect(logOnly.warnings).toContainEqual({ path: `actions.${action}.verify`, message: expect.stringMatching(/only applies in live mode; in log-only mode/) });

    const restore = [registerAdapter(fakeAdapter({ name: 'claude' })), registerAdapter(fakeAdapter({ name: 'kiro' })), registerAdapter(fakeAdapter({ name: 'codex' }))];
    try {
      cfg.execution = { mode: 'live' };
      for (const repo of Object.values(cfg.repositories) as Array<{ checkoutPath?: string }>) repo.checkoutPath ??= './clone';
      cfg.actions[action].output = 'log';
      const live = validateConfig(cfg);
      expect(live.warnings).toContainEqual({ path: `actions.${action}.verify`, message: expect.stringMatching(/only applies to actions with output local-branch/) });

      delete cfg.actions[action].verify;
      cfg.actions[action].verifyTimeoutMinutes = 5;
      expect(validateConfig(cfg).warnings).toContainEqual({ path: `actions.${action}.verifyTimeoutMinutes`, message: 'has no effect without verify' });
    } finally {
      for (const r of restore.reverse()) r();
    }
  });

  it('defaults commentOnFailure to off and warns when it is set outside live mode', () => {
    const repo = 'allenheltondev/kids-and-dragons';
    const plain = validateConfig(example());
    expect(plain.ok && plain.config.repositories[repo]?.commentOnFailure).toBeUndefined();

    const cfg = example();
    cfg.repositories[repo].commentOnFailure = true;
    const r = validateConfig(cfg);
    expect(r.ok).toBe(true);
    expect(r.warnings).toContainEqual({
      path: `repositories.${repo}.commentOnFailure`,
      message: 'only applies in live mode; in log-only mode no comment is posted when a run fails',
    });

    cfg.repositories[repo].commentOnFailure = false;
    expect(validateConfig(cfg).warnings.some((w) => w.path.endsWith('.commentOnFailure'))).toBe(false);

    cfg.repositories[repo].commentOnFailure = 'yes';
    expect(validateConfig(cfg).ok).toBe(false);
  });

  it('rejects dangling references', () => {
    const cfg = example();
    cfg.pools.general.agents.push('nobody');
    cfg.repositories['allenheltondev/kids-and-dragons'].workflows[0].action = 'missing';
    const r = validateConfig(cfg);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.message)).toEqual(
      expect.arrayContaining(['unknown agent "nobody"', 'unknown action "missing"']),
    );
  });

  it('requires checkoutPath in prepare-only mode only for repos that produce a local branch', () => {
    const repo = 'allenheltondev/kids-and-dragons';
    const cfg = example();
    cfg.execution = { mode: 'prepare-only' };
    delete cfg.repositories[repo].checkoutPath;
    const r = validateConfig(cfg);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      { path: `repositories.${repo}.checkoutPath`, message: expect.stringMatching(/required in prepare-only mode/) },
    ]);

    cfg.repositories[repo].checkoutPath = '../clones/kids and dragons';
    expect(validateConfig(cfg).ok).toBe(true);
    cfg.repositories[repo].remote = 'github-work';
    expect(validateConfig(cfg).ok).toBe(true);
    cfg.repositories[repo].remote = '--upload-pack=x';
    expect(validateConfig(cfg).ok).toBe(false);
    delete cfg.repositories[repo].remote;

    delete cfg.repositories[repo].checkoutPath;
    cfg.actions['implement-issue'].output = 'log';
    expect(validateConfig(cfg).ok).toBe(true);

    cfg.actions['implement-issue'].output = 'local-branch';
    cfg.execution = { mode: 'log-only' };
    expect(validateConfig(cfg).ok).toBe(true);
  });

  it('rejects live mode while an enabled agent has no implemented adapter', () => {
    const cfg = example();
    cfg.execution = { mode: 'live' };
    cfg.repositories['allenheltondev/kids-and-dragons'].checkoutPath = '../clones/kids-and-dragons';
    // Independent of which adapters ship: every enabled agent without one is reported.
    const missing = ['codex', 'claude', 'kiro'].filter((a) => !getAdapter(a));
    const r = validateConfig(cfg);
    expect(r.ok).toBe(missing.length === 0);
    if (r.ok) return;
    expect(r.errors).toEqual(
      missing.map((a) => ({ path: `agents.${a}`, message: expect.stringMatching(new RegExp(`live execution is not implemented for adapter "${a}"`)) })),
    );
  });

  it('accepts live mode with the built-in Codex adapter when codex is the only enabled agent', () => {
    const cfg = example();
    cfg.execution = { mode: 'live' };
    cfg.repositories['allenheltondev/kids-and-dragons'].checkoutPath = '../clones/kids-and-dragons';
    cfg.agents.claude.enabled = false;
    cfg.agents.kiro.enabled = false;
    cfg.agents.codex.args = ['--sandbox', 'workspace-write'];
    const r = validateConfig(cfg);
    expect(r.ok).toBe(true);
  });

  it('accepts live mode with the built-in Kiro adapter, alone or alongside claude', () => {
    const cfg = example();
    cfg.execution = { mode: 'live' };
    cfg.repositories['allenheltondev/kids-and-dragons'].checkoutPath = '../clones/kids-and-dragons';
    cfg.agents.codex.enabled = false;
    cfg.agents.kiro.args = ['--trust-tools=read_file,grep_search'];
    expect(validateConfig(cfg).ok).toBe(true);
    cfg.agents.claude.enabled = false;
    expect(validateConfig(cfg).ok).toBe(true);
  });

  it('accepts live mode with the built-in Claude Code adapter when claude is the only enabled agent', () => {
    const cfg = example();
    cfg.execution = { mode: 'live' };
    cfg.repositories['allenheltondev/kids-and-dragons'].checkoutPath = '../clones/kids-and-dragons';
    cfg.agents.codex.enabled = false;
    cfg.agents.kiro.enabled = false;
    cfg.agents.claude.args = ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(npm test *)'];
    // The art pool only has codex, so art jobs wait; that's a warning, not an error.
    expect(validateConfig(cfg)).toMatchObject({ ok: true, warnings: [{ path: 'pools.art', message: expect.stringMatching(/disabled/) }] });

    // An agent with another name that uses the claude adapter counts too.
    cfg.agents['claude-opus'] = { adapter: 'claude', args: ['--model', 'opus'] };
    expect(validateConfig(cfg).ok).toBe(true);
  });

  it('accepts live mode once every enabled agent has an adapter, a checkout and a prompt', () => {
    const repo = 'allenheltondev/kids-and-dragons';
    const restore = ['codex', 'claude', 'kiro'].map((name) => registerAdapter(fakeAdapter({ name })));
    try {
      const cfg = example();
      cfg.execution = { mode: 'live' };
      cfg.repositories[repo].checkoutPath = '../clones/kids and dragons';
      cfg.agents.claude.command = '/opt/agents/claude';
      cfg.agents.claude.args = ['--model', 'x'];
      cfg.agents.claude.env = { ANTHROPIC_LOG: 'debug' };
      cfg.actions['implement-issue'].timeoutMinutes = 45;
      expect(validateConfig(cfg)).toMatchObject({ ok: true, warnings: [] });

      cfg.agents.kiro.enabled = false;
      restore.pop()!(); // kiro no longer has an adapter, but it's disabled
      expect(validateConfig(cfg).ok).toBe(true);

      cfg.agents.claude.env = { 'NOT A NAME': 'x' };
      expect(validateConfig(cfg).ok).toBe(false);
      delete cfg.agents.claude.env;

      delete cfg.repositories[repo].checkoutPath;
      const prompt = cfg.actions['implement-issue'].prompt;
      delete cfg.actions['implement-issue'].prompt;
      const r = validateConfig(cfg);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors).toEqual([
        { path: `repositories.${repo}.checkoutPath`, message: expect.stringMatching(/required in live mode/) },
        { path: 'actions.implement-issue.prompt', message: expect.stringMatching(/required in live mode/) },
      ]);

      cfg.actions['implement-issue'] = { prompt, output: 'log' };
      const logOnly = validateConfig(cfg);
      expect(logOnly).toMatchObject({
        ok: true,
        warnings: [{ path: 'actions.implement-issue.output', message: expect.stringMatching(/only starts agents for actions with output local-branch/) }],
      });

      for (const a of Object.values(cfg.agents) as { enabled?: boolean }[]) a.enabled = false;
      const none = validateConfig(cfg);
      expect(none.ok).toBe(false);
      if (!none.ok) expect(none.errors).toContainEqual({ path: 'agents', message: 'live mode needs at least one enabled agent' });
    } finally {
      for (const r of restore) r();
    }
  });

  it('requires an actor allowlist', () => {
    const cfg = example();
    cfg.dispatch.allowedActors = [];
    const r = validateConfig(cfg);
    expect(r.ok).toBe(false);
  });
});

describe('validateConfig: tiers.triage', () => {
  const base = (triage: unknown, agents: Record<string, unknown> = { worker: { adapter: 'claude' }, 'claude-triage': { adapter: 'claude', model: 'haiku' } }) => ({
    version: 1,
    dispatch: { allowedActors: ['allen'] },
    agents,
    pools: { p: { agents: ['worker'] } },
    actions: { a: { output: 'log' } },
    repositories: {
      'o/r': {
        id: 1,
        workflows: [{ trigger: { event: 'issue.labeled', label: 'go' }, action: 'a', pool: 'p', tiers: { pools: { routine: 'p', standard: 'p', complex: 'p' }, triage } }],
      },
    },
  });

  it('is off unless configured, and accepts a named triage profile', () => {
    const r = validateConfig(base({ agent: 'claude-triage' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.repositories['o/r']!.workflows[0]!.tiers!.triage).toMatchObject({ agent: 'claude-triage', enabled: true, onLowConfidence: true, timeoutSeconds: 120, maxRetries: 1 });
    const none = validateConfig(base(undefined));
    expect(none.ok && none.config.repositories['o/r']!.workflows[0]!.tiers!.triage).toBeUndefined();
  });

  it('rejects an unknown agent, a container agent and unsafe args, and an opt-out skips the checks', () => {
    expect(validateConfig(base({ agent: 'missing' }))).toMatchObject({ ok: false, errors: [{ message: expect.stringMatching(/unknown agent/) }] });
    expect(validateConfig(base({ agent: 'c' }, { worker: { adapter: 'claude' }, c: { adapter: 'claude', container: { image: 'img' } } }))).toMatchObject({ ok: false });
    expect(validateConfig(base({ agent: 'c' }, { worker: { adapter: 'claude' }, c: { adapter: 'claude', args: ['--permission-mode', 'bypassPermissions'] } }))).toMatchObject({
      ok: false,
      errors: [{ message: expect.stringMatching(/permission-mode/) }],
    });
    expect(validateConfig(base({ agent: 'missing', enabled: false })).ok).toBe(true);
  });

  it('rejects unknown keys (no api key setting exists) and warns that kiro cannot guarantee no tools', () => {
    expect(validateConfig(base({ agent: 'claude-triage', apiKey: 'x' })).ok).toBe(false);
    const kiro = validateConfig(base({ agent: 'k' }, { worker: { adapter: 'claude' }, k: { adapter: 'kiro' } }));
    expect(kiro.ok && kiro.warnings.some((w) => /cannot guarantee/.test(w.message))).toBe(true);
    const claude = validateConfig(base({ agent: 'claude-triage' }));
    expect(claude.ok && claude.warnings.some((w) => /cannot guarantee/.test(w.message))).toBe(false);
  });
});

describe('selectPool', () => {
  const selector = { rules: [{ hasLabel: 'art', use: 'art' }], default: 'general' };
  it('first matching rule wins, case-insensitively', () => {
    expect(selectPool(selector, ['updraft:ready', 'Art'])).toBe('art');
    expect(selectPool(selector, ['updraft:ready'])).toBe('general');
    expect(selectPool('general', ['art'])).toBe('general');
  });
});

describe('capacity and escalation config', () => {
  it('rejects an agent naming an undeclared capacity group', () => {
    const cfg = example();
    cfg.agents.codex.capacityGroup = 'nope';
    const r = validateConfig(cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContainEqual({ path: 'agents.codex.capacityGroup', message: expect.stringMatching(/unknown capacity group "nope"/) });
  });

  it('accepts a declared group', () => {
    const cfg = example();
    cfg.capacity = { groups: { acct: { maxConcurrent: 2 } } };
    cfg.agents.codex.capacityGroup = 'acct';
    expect(validateConfig(cfg).ok).toBe(true);
  });
});
