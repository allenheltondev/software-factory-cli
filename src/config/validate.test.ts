import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { validateConfig } from './validate.js';
import { selectPool } from '../routing.js';

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
