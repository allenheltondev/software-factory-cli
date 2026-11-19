import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { seedConfig, upsertRepoWorkflow, buildWorkflow } from './config-edit.js';
import { EXIT } from './errors.js';
import { fakeContext } from './fakes.js';
import { validateCommand } from './validate.js';

function validConfig() {
  return upsertRepoWorkflow(seedConfig('me'), { id: 5, fullName: 'o/r' }, buildWorkflow({ label: 'go', action: 'implement-issue', pool: 'general' })).config;
}

describe('updraft validate', () => {
  it('exits 1 when the config is missing', async () => {
    const ctx = fakeContext();
    expect(await validateCommand(ctx)).toBe(EXIT.FAILURE);
    expect(ctx.err.text).toMatch(/No config at/);
  });

  it('exits 1 with the errors for an invalid config', async () => {
    const ctx = fakeContext();
    const cfg = validConfig();
    cfg.repositories!['o/r']!.workflows[0]!.pool = 'missing-pool';
    writeFileSync(ctx.paths.configFile, stringify(cfg));
    expect(await validateCommand(ctx)).toBe(EXIT.FAILURE);
    expect(ctx.err.text).toMatch(/Invalid config/);
    expect(ctx.err.text).toMatch(/unknown pool "missing-pool"/);
  });

  it('exits 1 for unparseable YAML', async () => {
    const ctx = fakeContext();
    writeFileSync(ctx.paths.configFile, 'version: [1\n');
    expect(await validateCommand(ctx)).toBe(EXIT.FAILURE);
    expect(ctx.err.text).toMatch(/Could not parse/);
  });

  it('exits 0 for a valid config and warns about a missing prompt file', async () => {
    const ctx = fakeContext();
    writeFileSync(ctx.paths.configFile, stringify(validConfig()));
    expect(await validateCommand(ctx)).toBe(EXIT.OK);
    expect(ctx.out.text).toMatch(/Config is valid/);
    expect(ctx.out.text).toMatch(/1 repo\(s\), 1 workflow\(s\)/);
    expect(ctx.out.text).toMatch(/actions\.implement-issue\.prompt: prompt file not found/);

    mkdirSync(join(ctx.paths.configDir, 'prompts'), { recursive: true });
    writeFileSync(join(ctx.paths.configDir, 'prompts', 'implement-issue.md'), 'do it');
    const ctx2 = fakeContext({ home: ctx.paths.configDir });
    expect(await validateCommand(ctx2)).toBe(EXIT.OK);
    expect(ctx2.out.text).not.toMatch(/prompt file not found/);
  });
});

describe('updraft validate --json', () => {
  it('prints the validated config with its defaults, and no value of agents.<name>.env', async () => {
    const ctx = fakeContext();
    const cfg = validConfig();
    cfg.agents = {
      ...cfg.agents,
      claude: { env: { GIT_AUTHOR_NAME: 'Agent', SOME_TOKEN: 'not-for-stdout' }, container: { image: 'microvm', runtime: '/opt/updraft/bin/updraft-sandbox', env: ['ANTHROPIC_API_KEY'] } },
    } as typeof cfg.agents;
    writeFileSync(ctx.paths.configFile, stringify(cfg));
    expect(await validateCommand(ctx, { json: true })).toBe(EXIT.OK);
    expect(ctx.out.text.trim().split('\n')).toHaveLength(1);
    expect(ctx.out.text).not.toContain('not-for-stdout');
    const report = JSON.parse(ctx.out.text) as { ok: boolean; state: string; path: string; errors: unknown[]; warnings: Array<{ path: string }>; config: { agents: Record<string, { env?: unknown }>; execution: { mode?: unknown }; repositories: Record<string, unknown> } };
    expect(report).toMatchObject({ ok: true, state: 'ok', path: ctx.paths.configFile, errors: [] });
    expect(report.warnings.map((w) => w.path)).toContain('actions.implement-issue.prompt');
    const claude = report.config.agents.claude;
    // Defaults are filled in: what the worker will use, not what the file says.
    expect(claude).toMatchObject({ enabled: true, maxConcurrent: 1, container: { image: 'microvm', runtime: '/opt/updraft/bin/updraft-sandbox', env: ['ANTHROPIC_API_KEY'] } });
    expect(claude?.env).toEqual({ GIT_AUTHOR_NAME: '(set)', SOME_TOKEN: '(set)' });
    expect(report.config.execution.mode).toBeDefined();
    expect(Object.keys(report.config.repositories)).toEqual(['o/r']);
  });

  it('reports a missing, an unparseable and an invalid config as JSON, exit 1', async () => {
    const missing = fakeContext();
    expect(await validateCommand(missing, { json: true })).toBe(EXIT.FAILURE);
    expect(JSON.parse(missing.out.text)).toMatchObject({ ok: false, state: 'missing', config: null });

    const broken = fakeContext();
    writeFileSync(broken.paths.configFile, 'version: [1\n');
    expect(await validateCommand(broken, { json: true })).toBe(EXIT.FAILURE);
    expect(JSON.parse(broken.out.text)).toMatchObject({ ok: false, state: 'unreadable', config: null });

    const invalid = fakeContext();
    const cfg = validConfig();
    cfg.repositories!['o/r']!.workflows[0]!.pool = 'missing-pool';
    writeFileSync(invalid.paths.configFile, stringify(cfg));
    expect(await validateCommand(invalid, { json: true })).toBe(EXIT.FAILURE);
    const report = JSON.parse(invalid.out.text) as { ok: boolean; errors: Array<{ message: string }>; config: unknown };
    expect(report.ok).toBe(false);
    expect(report.config).toBeNull();
    expect(report.errors.map((e) => e.message).join('\n')).toMatch(/unknown pool "missing-pool"/);
    expect(invalid.err.text).toBe('');
  });

  it('reports an unusable github.app key as an error', async () => {
    const ctx = fakeContext();
    const cfg = { ...validConfig(), github: { app: { appId: 1, privateKeyPath: './missing.pem' } } };
    writeFileSync(ctx.paths.configFile, stringify(cfg));
    expect(await validateCommand(ctx, { json: true })).toBe(EXIT.FAILURE);
    const report = JSON.parse(ctx.out.text) as { ok: boolean; errors: Array<{ path: string }> };
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.path)).toContain('github.app.privateKeyPath');
  });
});
