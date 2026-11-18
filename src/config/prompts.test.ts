import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeStarterPrompts } from './prompts.js';

describe('writeStarterPrompts', () => {
  const cfg = { version: 1 as const, agents: {}, pools: {}, actions: { 'implement-issue': { prompt: './prompts/implement-issue.md' } } };

  it('copies the packaged prompt when missing and never overwrites', () => {
    const dir = mkdtempSync(join(tmpdir(), 'updraft prompts '));
    const configFile = join(dir, 'config.yaml');
    const written = writeStarterPrompts(configFile, cfg);
    expect(written).toEqual([join(dir, 'prompts', 'implement-issue.md')]);
    expect(readFileSync(written[0]!, 'utf8').length).toBeGreaterThan(0);

    writeFileSync(written[0]!, 'mine');
    expect(writeStarterPrompts(configFile, cfg)).toEqual([]);
    expect(readFileSync(written[0]!, 'utf8')).toBe('mine');
  });

  it('skips prompts with no packaged counterpart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'updraft prompts '));
    mkdirSync(join(dir, 'x'));
    expect(writeStarterPrompts(join(dir, 'config.yaml'), { ...cfg, actions: { a: { prompt: './x/custom.md' } } })).toEqual([]);
  });

  it('also copies the packaged revise prompt of an action that names one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'updraft prompts '));
    const actions = { 'implement-issue': { prompt: './prompts/implement-issue.md', revisePrompt: './prompts/revise-pr.md' } };
    const written = writeStarterPrompts(join(dir, 'config.yaml'), { ...cfg, actions });
    expect(written).toEqual([join(dir, 'prompts', 'implement-issue.md'), join(dir, 'prompts', 'revise-pr.md')]);
    expect(readFileSync(written[1]!, 'utf8')).toContain('Do not amend, rebase, squash');
  });
});
