import { describe, expect, it } from 'vitest';
import { validateConfig } from '../config/validate.js';
import {
  applyRepoSelections,
  buildWorkflow,
  diffConfigs,
  formatDiff,
  isEmptyDiff,
  normalizeBackfillSince,
  parseRoute,
  seedConfig,
  setEnabledAgents,
  upsertRepoWorkflow,
} from './config-edit.js';

const wf = buildWorkflow({ label: 'updraft:ready', action: 'implement-issue', pool: 'general' });

describe('seedConfig', () => {
  it('has the documented defaults and validates once a repo is added', () => {
    const seed = seedConfig('octocat');
    expect(seed.dispatch?.allowedActors).toEqual(['octocat']);
    expect(Object.keys(seed.agents)).toEqual(['codex', 'claude', 'kiro']);
    expect(seed.pools.general).toEqual({ agents: ['claude', 'kiro'], strategy: 'round-robin' });
    expect(seed.actions['implement-issue']?.prompt).toBe('./prompts/implement-issue.md');
    const { config } = upsertRepoWorkflow(seed, { id: 42, fullName: 'o/r' }, wf);
    expect(validateConfig(config).ok).toBe(true);
  });
});

describe('buildWorkflow / parseRoute', () => {
  it('uses a plain pool name without rules and an object with rules', () => {
    expect(wf.pool).toBe('general');
    const routed = buildWorkflow({ label: 'x', action: 'a', pool: 'general', routes: [{ hasLabel: 'art', use: 'art' }] });
    expect(routed.pool).toEqual({ rules: [{ hasLabel: 'art', use: 'art' }], default: 'general' });
    expect(buildWorkflow({ label: 'x', action: 'a', pool: 'p', id: 'impl' }).id).toBe('impl');
  });

  it('parses LABEL=POOL, splitting on the last "="', () => {
    expect(parseRoute('art=art')).toEqual({ hasLabel: 'art', use: 'art' });
    expect(parseRoute('kind=ui=design')).toEqual({ hasLabel: 'kind=ui', use: 'design' });
    expect(() => parseRoute('art')).toThrow(/LABEL=POOL/);
    expect(() => parseRoute('=art')).toThrow();
  });
});

describe('normalizeBackfillSince', () => {
  it('accepts dates and ISO timestamps', () => {
    expect(normalizeBackfillSince('2025-01-31')).toBe('2025-01-31T00:00:00.000Z');
    expect(normalizeBackfillSince('2025-01-31T10:00:00+02:00')).toBe('2025-01-31T08:00:00.000Z');
    expect(normalizeBackfillSince('yesterday')).toBeNull();
    expect(normalizeBackfillSince('2025-13-45')).toBeNull();
  });
});

describe('upsertRepoWorkflow', () => {
  const base = seedConfig('me');

  it('adds a new repo with its ID and optional backfill', () => {
    const r = upsertRepoWorkflow(base, { id: 7, fullName: 'o/r' }, wf, { backfillSince: '2025-01-01T00:00:00.000Z' });
    expect(r.replaced).toBe(false);
    expect(r.config.repositories?.['o/r']).toEqual({ id: 7, workflows: [wf], backfillSince: '2025-01-01T00:00:00.000Z' });
    expect(base.repositories).toEqual({}); // input untouched
  });

  it('replaces a workflow with the same id and appends a different one', () => {
    const one = upsertRepoWorkflow(base, { id: 7, fullName: 'o/r' }, wf).config;
    const changed = buildWorkflow({ label: 'updraft:ready', action: 'implement-issue', pool: 'other' });
    const two = upsertRepoWorkflow(one, { id: 7, fullName: 'o/r' }, changed);
    expect(two.replaced).toBe(true);
    expect(two.config.repositories?.['o/r']?.workflows).toEqual([changed]);
    const three = upsertRepoWorkflow(two.config, { id: 7, fullName: 'o/r' }, buildWorkflow({ label: 'bug', action: 'implement-issue', pool: 'general' }));
    expect(three.config.repositories?.['o/r']?.workflows).toHaveLength(2);
  });

  it('follows a rename by repo ID and keeps other settings', () => {
    const one = upsertRepoWorkflow(base, { id: 7, fullName: 'old/name' }, wf).config;
    one.repositories!['old/name']!.checkoutPath = '/src/r';
    const r = upsertRepoWorkflow(one, { id: 7, fullName: 'new/name' }, wf);
    expect(r.renamedFrom).toBe('old/name');
    expect(Object.keys(r.config.repositories!)).toEqual(['new/name']);
    expect(r.config.repositories!['new/name']!.checkoutPath).toBe('/src/r');
  });
});

describe('applyRepoSelections', () => {
  it('keeps selected repos by ID, drops unselected, applies backfill only to new repos', () => {
    let base = upsertRepoWorkflow(seedConfig('me'), { id: 1, fullName: 'o/a' }, wf).config;
    base = upsertRepoWorkflow(base, { id: 2, fullName: 'o/b' }, wf).config;
    base.repositories!['o/a']!.baseBranch = 'dev';
    const next = applyRepoSelections(base, [
      { id: 1, fullName: 'o/a-renamed', workflows: [wf], backfillSince: '2025-01-01T00:00:00.000Z' },
      { id: 3, fullName: 'o/c', workflows: [wf], backfillSince: '2025-01-01T00:00:00.000Z' },
    ]);
    expect(Object.keys(next.repositories!)).toEqual(['o/a-renamed', 'o/c']);
    expect(next.repositories!['o/a-renamed']).toEqual({ id: 1, baseBranch: 'dev', workflows: [wf] });
    expect(next.repositories!['o/c']!.backfillSince).toBe('2025-01-01T00:00:00.000Z');

    const diff = diffConfigs(base, next);
    expect(diff.reposAdded).toEqual([{ id: 3, fullName: 'o/c' }]);
    expect(diff.reposRemoved).toEqual([{ id: 2, fullName: 'o/b' }]);
    expect(diff.reposRenamed).toEqual([{ id: 1, from: 'o/a', to: 'o/a-renamed' }]);
    expect(diff.workflowsAdded.map((w) => w.repo)).toEqual(['o/c']);
    expect(diff.workflowsRemoved.map((w) => w.repo)).toEqual(['o/b']);
    const lines = formatDiff(diff);
    expect(lines).toContain('+ repo o/c (id 3)');
    expect(lines).toContain('- repo o/b (id 2)');
    expect(lines).toContain('~ repo o/a → o/a-renamed (id 1)');
    expect(lines.some((l) => l.startsWith('+ workflow o/c [implement-issue:updraft:ready]'))).toBe(true);
  });
});

describe('diffConfigs', () => {
  it('reports no changes for identical configs', () => {
    const c = upsertRepoWorkflow(seedConfig('me'), { id: 1, fullName: 'o/a' }, wf).config;
    const d = diffConfigs(c, structuredClone(c));
    expect(isEmptyDiff(d)).toBe(true);
    expect(formatDiff(d)).toEqual(['No changes.']);
  });

  it('notes a brand-new config, changed workflows and agent toggles', () => {
    const c = upsertRepoWorkflow(seedConfig('me'), { id: 1, fullName: 'o/a' }, wf).config;
    expect(diffConfigs(null, c).other[0]).toMatch(/new config/);

    const changed = upsertRepoWorkflow(setEnabledAgents(c, ['claude']), { id: 1, fullName: 'o/a' }, buildWorkflow({
      label: 'updraft:ready',
      action: 'implement-issue',
      pool: 'general',
      routes: [{ hasLabel: 'art', use: 'general' }],
    })).config;
    const d = diffConfigs(c, changed);
    expect(d.workflowsChanged).toHaveLength(1);
    expect(d.other).toEqual(expect.arrayContaining(['agent codex disabled', 'agent kiro disabled']));
  });
});

describe('setEnabledAgents', () => {
  it('disables unlisted agents and clears the flag for enabled ones', () => {
    const c = setEnabledAgents(seedConfig('me'), ['claude']);
    expect(c.agents.claude?.enabled).toBeUndefined();
    expect(c.agents.codex?.enabled).toBe(false);
    expect(setEnabledAgents(c, ['codex', 'claude']).agents.codex?.enabled).toBeUndefined();
  });
});
