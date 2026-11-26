import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { compileTenantConfig } from './config.js';
import { defaultConsoleConfig, parseConsoleConfig, toTenantSubmission, type ConsoleConfig } from './console.js';

/**
 * Characterization of what the role-oriented configuration page (#193) writes: label overrides
 * are a workflow's own pool, a repository's exception is a workflow of its own on the same label.
 * They are ordinary console settings: the server validates and compiles them like any other, and
 * workflows that inherit the default team keep their names and ids (so work in flight resolves).
 */

const ok = (raw: unknown): ConsoleConfig => {
  const r = parseConsoleConfig(raw);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.config;
};
const repo = (workflows: string[]) => ({ enabled: true, workflows, publish: 'draft-pr', commentOnFailure: true, verify: [] });
const compile = (config: ConsoleConfig) => compileTenantConfig(toTenantSubmission(config), { appId: 4242 }, new Map([['acme/web', 99], ['acme/api', 100]]));
interface Compiled {
  pools: Record<string, { agents: string[] }>;
  repositories: Record<string, { workflows: { id: string; trigger: { label: string }; action: string; pool: string; reviewPool?: string }[]; review: boolean }>;
}

/** Default team: Claude and Codex code, Codex reviews. "art" codes with Codex only; acme/api's "ready" codes with Claude only. */
function withOverrides(): ConsoleConfig {
  const d = defaultConsoleConfig({ offered: ['claude', 'codex'], login: 'pat' });
  // Codex codes and reviews: the person consented to self-review where no other reviewer is chosen.
  const implement = { ...d.workflows.implement!, label: 'ready', review: { ...d.workflows.implement!.review, pool: 'reviewers', allowSameAgent: true } };
  return ok({
    ...d,
    pools: { builders: { agents: ['claude', 'codex'] }, reviewers: { agents: ['codex'] }, 'art-coding': { agents: ['codex'] }, 'implement-api-coding': { agents: ['claude'] } },
    workflows: {
      implement,
      art: { ...implement, label: 'art', pool: 'art-coding' },
      'implement-api': { ...implement, pool: 'implement-api-coding' },
    },
    repositories: { 'acme/web': repo(['implement', 'art']), 'acme/api': repo(['implement-api', 'art']) },
  });
}

describe('label overrides and repository exceptions (#193)', () => {
  it('validate and compile as ordinary settings: each label and repository runs its own team', () => {
    const config = withOverrides();
    // An agent may not review its own work unless allowed: Codex codes and reviews here.
    expect(parseConsoleConfig({ ...config, workflows: Object.fromEntries(Object.entries(config.workflows).map(([n, w]) => [n, { ...w, review: { ...w.review, allowSameAgent: false } }])) })).toMatchObject({ ok: false });
    const r = compile(config);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const yaml = parse(r.files['config.yaml']!) as Compiled;
    expect(yaml.pools).toEqual({ builders: { agents: ['claude', 'codex'] }, reviewers: { agents: ['codex'] }, 'art-coding': { agents: ['codex'] }, 'implement-api-coding': { agents: ['claude'] } });
    const route = (name: string) => yaml.repositories[name]!.workflows.map((w) => [w.trigger.label, w.id, w.pool, w.reviewPool]);
    expect(route('acme/web')).toEqual([
      ['ready', 'implement', 'builders', 'reviewers'],
      ['art', 'art', 'art-coding', 'reviewers'],
    ]);
    expect(route('acme/api')).toEqual([
      ['ready', 'implement-api', 'implement-api-coding', 'reviewers'],
      ['art', 'art', 'art-coding', 'reviewers'],
    ]);
    expect(r.dispatch.repositories['acme/api']).toMatchObject({ review: true, revise: true, triggers: [{ label: 'ready' }, { label: 'art' }] });
  });

  it('an inheriting workflow compiles the same before and after another label is customized and reset', () => {
    const base = withOverrides();
    const plain = ok({ ...base, pools: { builders: base.pools.builders, reviewers: base.pools.reviewers }, workflows: { implement: base.workflows.implement, art: { ...base.workflows.art!, pool: 'builders' } }, repositories: { 'acme/web': repo(['implement', 'art']) } });
    const before = compile(plain);
    const customized = compile(ok({ ...plain, pools: { ...plain.pools, 'art-coding': { agents: ['codex'] } }, workflows: { ...plain.workflows, art: { ...plain.workflows.art!, pool: 'art-coding' } } }));
    expect(before.ok && customized.ok).toBe(true);
    if (!before.ok || !customized.ok) return;
    const ready = (files: Record<string, string>) => (parse(files['config.yaml']!) as Compiled).repositories['acme/web']!.workflows.find((w) => w.trigger.label === 'ready');
    expect(ready(customized.files)).toEqual(ready(before.files));
    // Reset is the settings as they were, so the compiled bundle is byte for byte the same.
    expect(compile(plain)).toEqual(before);
  });
});
