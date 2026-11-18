import { describe, expect, it } from 'vitest';
import { claudeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import { kiroAdapter } from './adapters/kiro.js';
import { agentProfile, describeProfile, effectiveArgs } from './profile.js';
import { validateConfig } from '../config/validate.js';

const launch = { file: 'cli', args: [] as string[] };
const inv = (adapter: typeof claudeAdapter, extraArgs: string[]) =>
  adapter.buildInvocation({ launch, promptFile: 'p.md', worktree: 'w', runDir: 'r', extraArgs, platform: 'linux' }).args;

describe('agentProfile', () => {
  it('reads model and effort from legacy args', () => {
    expect(agentProfile('claude', { args: ['--model', 'opus', '--effort=high'] })).toMatchObject({
      model: { value: 'opus', source: 'args' },
      effort: { value: 'high', source: 'args' },
      problems: [],
    });
    const codex = agentProfile('codex', { args: ['-m', 'gpt-x', '-c', 'model_reasoning_effort="low"'] });
    expect(codex.model.value).toBe('gpt-x');
    expect(codex.effort.value).toBe('low');
  });

  it('reports the CLI default when nothing is set', () => {
    const p = agentProfile('kiro', {});
    expect(p.model).toEqual({ value: null, source: 'cli default' });
    expect(describeProfile('kiro', 'kiro', p)).toContain('CLI default');
  });

  it('flags duplicate and contradictory settings', () => {
    expect(agentProfile('claude', { model: 'a', args: ['--model', 'a'] }).problems[0]).toMatch(/both/);
    expect(agentProfile('claude', { model: 'a', args: ['--model', 'b'] }).problems[0]).toMatch(/contradicts/);
    expect(agentProfile('codex', { args: ['--model', 'a', '-m', 'b'] }).problems[0]).toMatch(/more than once/);
  });

  it('rejects flag-like, empty and multi-line values', () => {
    expect(agentProfile('claude', { model: '--evil' }).problems).toHaveLength(1);
    expect(agentProfile('claude', { effort: ' ' }).problems).toHaveLength(1);
    expect(agentProfile('claude', { model: 'a\nb' }).problems).toHaveLength(1);
  });
});

describe('effectiveArgs and adapter invocations', () => {
  it('leaves legacy args unchanged', () => {
    expect(effectiveArgs('claude', { args: ['--max-turns', '3'] })).toEqual(['--max-turns', '3']);
    expect(effectiveArgs('claude', {})).toEqual([]);
  });

  it('passes a model with spaces as one argument for each adapter', () => {
    const agent = { model: 'my vendor/model 1', effort: 'high' };
    const claude = inv(claudeAdapter, effectiveArgs('claude', agent));
    expect(claude.slice(-4)).toEqual(['--model', 'my vendor/model 1', '--effort', 'high']);
    const codex = inv(codexAdapter, effectiveArgs('codex', agent));
    expect(codex).toContain('my vendor/model 1');
    expect(codex).toContain('model_reasoning_effort="high"');
    const kiro = inv(kiroAdapter, effectiveArgs('kiro', agent));
    expect(kiro.slice(-4)).toEqual(['--model', 'my vendor/model 1', '--effort', 'high']);
  });
});

describe('config validation', () => {
  const base = (agents: unknown) => ({
    version: 1,
    dispatch: { allowedActors: ['a'] },
    agents,
    pools: { p: { agents: ['claude-fast', 'claude-deep'] } },
    actions: {},
  });

  it('accepts several profiles on one adapter, and legacy args-only entries', () => {
    const r = validateConfig(base({ 'claude-fast': { adapter: 'claude', model: 'haiku' }, 'claude-deep': { adapter: 'claude', args: ['--model', 'opus'] } }));
    expect(r.ok).toBe(true);
  });

  it('rejects a model set twice', () => {
    const r = validateConfig(base({ 'claude-fast': { adapter: 'claude', model: 'haiku', args: ['--model', 'opus'] }, 'claude-deep': { adapter: 'claude' } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.path).toBe('agents.claude-fast');
  });
});
