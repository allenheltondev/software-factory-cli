import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { validateConfig } from './validate.js';
import { selectPool } from '../routing.js';
import { registerAdapter } from '../agents/adapters/registry.js';
import { fakeAdapter } from '../../test/fake-adapter.js';

const example = () => parse(readFileSync(new URL('../../examples/config.yaml', import.meta.url), 'utf8'));

describe('validateConfig', () => {
  it('accepts the shipped example and applies defaults', () => {
    const r = validateConfig(example());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.execution.mode).toBe('log-only');
    expect(r.config.pools.art?.strategy).toBe('round-robin');
    expect(r.config.agents.codex?.enabled).toBe(true);
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

  it('rejects live mode while an enabled agent has no implemented adapter (only claude ships)', () => {
    const cfg = example();
    cfg.execution = { mode: 'live' };
    cfg.repositories['allenheltondev/kids-and-dragons'].checkoutPath = '../clones/kids-and-dragons';
    const r = validateConfig(cfg);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      { path: 'agents.codex', message: expect.stringMatching(/live execution is not implemented for adapter "codex" in this release/) },
      { path: 'agents.kiro', message: expect.stringMatching(/live execution is not implemented for adapter "kiro" in this release/) },
    ]);

    cfg.agents.codex.enabled = false;
    const kiroOnly = validateConfig(cfg);
    expect(kiroOnly.ok).toBe(false);
    if (!kiroOnly.ok) expect(kiroOnly.errors.map((e) => e.path)).toEqual(['agents.kiro']);
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

describe('selectPool', () => {
  const selector = { rules: [{ hasLabel: 'art', use: 'art' }], default: 'general' };
  it('first matching rule wins, case-insensitively', () => {
    expect(selectPool(selector, ['factory:ready', 'Art'])).toBe('art');
    expect(selectPool(selector, ['factory:ready'])).toBe('general');
    expect(selectPool('general', ['art'])).toBe('general');
  });
});
