import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { GitHubError } from '../github/api.js';
import { addCommand } from './add.js';
import { CliError, EXIT } from './errors.js';
import { fakeApi, fakeContext, fakeRepo } from './fakes.js';

const readYaml = (p: string) => parse(readFileSync(p, 'utf8'));

describe('factory add', () => {
  it('creates a config with defaults when none exists', async () => {
    const api = fakeApi({ login: 'allen', repos: [fakeRepo('o/r', 99)], labels: { 'o/r': ['factory:ready'] } });
    const ctx = fakeContext({ api });
    const code = await addCommand(ctx, 'o/r', {});
    expect(code).toBe(EXIT.OK);
    const cfg = readYaml(ctx.paths.configFile);
    expect(cfg.dispatch.allowedActors).toEqual(['allen']);
    expect(cfg.pools.general.agents).toEqual(['claude', 'kiro']);
    expect(cfg.repositories['o/r']).toEqual({
      id: 99,
      workflows: [{ trigger: { event: 'issue.labeled', label: 'factory:ready' }, action: 'implement-issue', pool: 'general' }],
    });
    expect(ctx.out.text).toContain('Created');
    expect(ctx.out.text).toContain('+ repo o/r (id 99)');
    expect(ctx.out.text).toMatch(/worker restarts/);
    expect(ctx.err.text).toBe('');
  });

  it('adds to an existing config, uses the canonical name, routes and backfill, and warns on a missing label', async () => {
    const api = fakeApi({ repos: [fakeRepo('o/a', 1)], publicRepos: [fakeRepo('Other/Pub', 2)] });
    const ctx = fakeContext({ api });
    await addCommand(ctx, 'o/a', {});
    const before = readYaml(ctx.paths.configFile);
    before.pools.art = { agents: ['codex'] };
    writeFileSync(ctx.paths.configFile, JSON.stringify(before));

    const code = await addCommand(ctx, 'other/pub', {
      label: 'go',
      route: ['art=art'],
      backfillSince: '2025-02-01',
      workflowId: 'impl',
    });
    expect(code).toBe(EXIT.OK);
    const cfg = readYaml(ctx.paths.configFile);
    expect(Object.keys(cfg.repositories)).toEqual(['o/a', 'Other/Pub']);
    expect(cfg.repositories['Other/Pub']).toEqual({
      id: 2,
      backfillSince: '2025-02-01T00:00:00.000Z',
      workflows: [
        {
          id: 'impl',
          trigger: { event: 'issue.labeled', label: 'go' },
          action: 'implement-issue',
          pool: { rules: [{ hasLabel: 'art', use: 'art' }], default: 'general' },
        },
      ],
    });
    expect(api.calls.filter((c) => c === 'getViewer')).toHaveLength(1); // only for the first, new config
    expect(ctx.out.text).toContain('Updated');
    expect(ctx.err.text).toMatch(/Label "go" does not exist on Other\/Pub/);
  });

  it('fails without writing when the repo is inaccessible', async () => {
    const ctx = fakeContext({ api: fakeApi() });
    await expect(addCommand(ctx, 'o/private', {})).rejects.toBeInstanceOf(GitHubError);
    expect(existsSync(ctx.paths.configFile)).toBe(false);
  });

  it('rejects bad arguments before touching GitHub', async () => {
    const api = fakeApi({ repos: [fakeRepo('o/r', 1)] });
    const ctx = fakeContext({ api });
    await expect(addCommand(ctx, 'not-a-repo', {})).rejects.toMatchObject({ exitCode: EXIT.USAGE });
    await expect(addCommand(ctx, 'o/r', { route: ['nopool'] })).rejects.toBeInstanceOf(CliError);
    await expect(addCommand(ctx, 'o/r', { backfillSince: 'soon' })).rejects.toThrow(/not a date/);
    expect(api.calls).toEqual([]);
  });

  it('rejects unknown pools and actions', async () => {
    const ctx = fakeContext({ api: fakeApi({ repos: [fakeRepo('o/r', 1)] }) });
    await expect(addCommand(ctx, 'o/r', { pool: 'nope' })).rejects.toThrow(/Unknown pool "nope"/);
    await expect(addCommand(ctx, 'o/r', { action: 'nope' })).rejects.toThrow(/Unknown action "nope"/);
    expect(existsSync(ctx.paths.configFile)).toBe(false);
  });

  it('refuses to edit an invalid existing config', async () => {
    const ctx = fakeContext({ api: fakeApi({ repos: [fakeRepo('o/r', 1)] }) });
    await addCommand(ctx, 'o/r', {});
    writeFileSync(ctx.paths.configFile, 'version: 2\n');
    await expect(addCommand(ctx, 'o/r', {})).rejects.toThrow(/invalid/);
  });
});
