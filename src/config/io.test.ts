import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { COMMENTED_CONFIG } from '../commands/fakes.js';
import { ConfigError, loadConfig, readRawConfig, saveConfig } from './io.js';
import type { FactoryConfigInput } from './schema.js';
import { updateYamlText } from './yaml-update.js';

function tempConfig(text?: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'factory-io-')), 'config.yaml');
  if (text !== undefined) writeFileSync(file, text);
  return file;
}

const edit = (text: string, fn: (c: FactoryConfigInput) => void): FactoryConfigInput => {
  const c = parse(text) as FactoryConfigInput;
  fn(c);
  return c;
};

describe('saveConfig', () => {
  it('writes a fresh config when no file exists', () => {
    const file = join(tempConfig(), '..', 'nested', 'config.yaml');
    const input = parse(COMMENTED_CONFIG) as FactoryConfigInput;
    saveConfig(file, input);
    expect(parse(readFileSync(file, 'utf8'))).toEqual(input);
    expect(loadConfig(file).config.repositories['o/app']!.id).toBe(1);
  });

  it('leaves the file byte-for-byte alone when nothing changed', () => {
    const file = tempConfig(COMMENTED_CONFIG);
    saveConfig(file, readRawConfig(file) as FactoryConfigInput);
    expect(readFileSync(file, 'utf8')).toBe(COMMENTED_CONFIG);
  });

  it('keeps comments, order and formatting of untouched nodes when adding a repo', () => {
    const file = tempConfig(COMMENTED_CONFIG);
    const next = edit(COMMENTED_CONFIG, (c) => {
      c.repositories!['o/new'] = {
        id: 2,
        workflows: [{ trigger: { event: 'issue.labeled', label: 'go' }, action: 'implement-issue', pool: 'art' }],
      };
    });
    saveConfig(file, next);
    const text = readFileSync(file, 'utf8');
    // Everything that was there is unchanged; the new repo is appended.
    expect(text.startsWith(COMMENTED_CONFIG)).toBe(true);
    expect(text.slice(COMMENTED_CONFIG.length)).toBe(
      ['  o/new:', '    id: 2', '    workflows:', '      - trigger:', '          event: issue.labeled', '          label: go', '        action: implement-issue', '        pool: art', ''].join('\n'),
    );
    expect(parse(text)).toEqual(next);
  });

  it('drops the comments of removed keys and items and edits changed scalars in place', () => {
    const file = tempConfig(COMMENTED_CONFIG);
    const next = edit(COMMENTED_CONFIG, (c) => {
      const repo = c.repositories!['o/app']!;
      delete repo.baseBranch;
      repo.workflows = [repo.workflows[0]!];
      c.pollIntervalSeconds = 300;
      delete c.agents.codex;
      c.pools.general!.agents = ['claude'];
    });
    saveConfig(file, next);
    const text = readFileSync(file, 'utf8');
    expect(parse(text)).toEqual(next);
    expect(text).not.toMatch(/release branch later|Old experiment|try-me|Codex is flaky/);
    expect(text).toContain('# Poll every two minutes; rate limits are tight.\npollIntervalSeconds: 300\n');
    expect(text).toContain('  claude: {} # defaults are fine\n');
    expect(text).toContain('    agents: [claude]\n');
    expect(text).toContain('  # The main app\n  o/app:\n    id: 1\n    workflows:\n');
    expect(text).toContain('        pool: general # default pool\n');
    expect(text).toContain('    - "bot-user"\n');
    expect(text.startsWith('# Factory config, edited by hand\nversion: 1\n\n')).toBe(true);
  });

  it('preserves CRLF line endings', () => {
    const crlf = COMMENTED_CONFIG.replace(/\n/g, '\r\n');
    const file = tempConfig(crlf);
    const next = edit(COMMENTED_CONFIG, (c) => {
      c.maxConcurrent = 4;
    });
    saveConfig(file, next);
    const text = readFileSync(file, 'utf8');
    expect(text).toBe(crlf.replace('maxConcurrent: 2\r\n', 'maxConcurrent: 4\r\n'));
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('refuses to write an invalid config and leaves the file alone', () => {
    const file = tempConfig(COMMENTED_CONFIG);
    const bad = edit(COMMENTED_CONFIG, (c) => {
      c.pools.general!.agents = ['ghost'];
    });
    expect(() => saveConfig(file, bad)).toThrow(ConfigError);
    expect(readFileSync(file, 'utf8')).toBe(COMMENTED_CONFIG);
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it('rewrites an existing file that cannot be parsed', () => {
    const file = tempConfig('version: [1\n');
    const input = parse(COMMENTED_CONFIG) as FactoryConfigInput;
    saveConfig(file, input);
    expect(parse(readFileSync(file, 'utf8'))).toEqual(input);
  });
});

describe('updateYamlText', () => {
  it('follows the source indentation style', () => {
    const four = 'a:\n    b: 1 # keep\n    list:\n        - x\n        - y\n';
    expect(updateYamlText(four, { a: { b: 2, list: ['x', 'y', 'z'] } })).toBe(
      'a:\n    b: 2 # keep\n    list:\n        - x\n        - y\n        - z\n',
    );
    const flushSeq = 'a:\n  b: 1 # keep\n  list:\n  - x\n  - y\n';
    expect(updateYamlText(flushSeq, { a: { b: 2, list: ['x', 'y', 'z'] } })).toBe(
      'a:\n  b: 2 # keep\n  list:\n  - x\n  - y\n  - z\n',
    );
  });

  it('turns an empty flow placeholder into a block when it gains entries', () => {
    expect(updateYamlText('repos: {} # none yet\n', { repos: { 'o/r': { id: 1 } } })).toBe(
      'repos: # none yet\n  o/r:\n    id: 1\n',
    );
  });

  it('keeps comments on sequence items that moved', () => {
    const out = updateYamlText('l:\n  - a # first\n  - b # second\n  - c\n', { l: ['b', 'c'] });
    expect(out).toBe('l:\n  - b # second\n  - c\n');
  });

  it('moves an entry to a new key by id only when the match is unambiguous', () => {
    const src = 'm:\n  # note\n  old:\n    id: 1\n    x: a # keep\n';
    expect(updateYamlText(src, { m: { new: { id: 1, x: 'a' } } })).toBe('m:\n  # note\n  new:\n    id: 1\n    x: a # keep\n');
    const two = 'm:\n  a:\n    id: 1 # a\n  b:\n    id: 1 # b\n';
    expect(updateYamlText(two, { m: { c: { id: 1 } } })).toBe('m:\n  c:\n    id: 1\n');
  });

  it('gives up (returns null) when the edit would not round-trip, e.g. through an alias', () => {
    const src = 'base: &b {x: 1}\nother: *b\n';
    const out = updateYamlText(src, { base: { x: 2 }, other: { x: 1 } });
    expect(out === null || parse(out).other.x === 1).toBe(true);
    expect(updateYamlText('- not a map\n', { a: 1 })).toBeNull();
    expect(updateYamlText('a: [1\n', { a: 1 })).toBeNull();
  });
});
