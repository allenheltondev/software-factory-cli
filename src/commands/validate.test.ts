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
