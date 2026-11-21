import { parse } from 'yaml';
import type { DispatchRules } from '../store/store.js';
import { AGENT_KEY_ENV, type CloudAgent } from './agents.js';
import { decideDispatch, dispatchRules } from './dispatch.js';

/**
 * Which agent keys a job can need (#70), from a compiled config (what `config.yaml` holds):
 * per workflow, every enabled agent of every pool the label's workflows
 * route to (the pool, its rules and default, the tier pools) and, with review on, the pool each
 * workflow's reviewer is routed to (as the worker's reviewPoolFor picks it). Kept per workflow
 * (each is its own trigger, with its own actors), never merged by label. Computed when a
 * version is published and stored on its dispatch rules; for a version published before that,
 * from its bundle (rulesFromBundle, createBundleKeys).
 */

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The pools one workflow of a repository can run agents from. */
export function workflowPools(repo: Obj, wf: Obj): string[] {
  const used = new Set<string>();
  const add = (name: unknown) => {
    if (typeof name === 'string' && name !== '') used.add(name);
  };
  if (isObject(wf.pool)) {
    add(wf.pool.default);
    for (const rule of Array.isArray(wf.pool.rules) ? wf.pool.rules : []) if (isObject(rule)) add(rule.use);
  } else add(wf.pool);
  if (isObject(wf.tiers)) {
    if (isObject(wf.tiers.pools)) for (const p of Object.values(wf.tiers.pools)) add(p);
    if (isObject(wf.tiers.highRisk)) add(wf.tiers.highRisk.pool);
  }
  // The workflow's reviewPool, else the repository's review.pool, else the pool the code was
  // written by (added above).
  if (repo.review === true || isObject(repo.review)) add(wf.reviewPool ?? (isObject(repo.review) ? repo.review.pool : undefined));
  return [...used];
}

/** The enabled agents of a pool that run with an agent key, each with the key's variable name. */
export function poolAgentKeys(compiled: { agents?: unknown; pools?: unknown }, poolName: string): { agent: string; key: string }[] {
  const pools = isObject(compiled.pools) ? compiled.pools : {};
  const agents = isObject(compiled.agents) ? compiled.agents : {};
  const pool = pools[poolName];
  const out: { agent: string; key: string }[] = [];
  for (const name of isObject(pool) && Array.isArray(pool.agents) ? pool.agents : []) {
    const agent = typeof name === 'string' ? agents[name] : undefined;
    if (!isObject(agent) || agent.enabled === false) continue;
    const adapter = (agent.adapter ?? name) as CloudAgent;
    if (adapter in AGENT_KEY_ENV) out.push({ agent: name as string, key: AGENT_KEY_ENV[adapter] });
  }
  return out;
}

/** The key names a job of this workflow can need, sorted: the agents of every pool it can run. */
export function workflowKeys(compiled: { agents?: unknown; pools?: unknown }, repo: Obj, wf: Obj): string[] {
  const keys = new Set<string>();
  for (const pool of workflowPools(repo, wf)) for (const k of poolAgentKeys(compiled, pool)) keys.add(k.key);
  return [...keys].sort();
}

/**
 * A version's dispatch rules with each workflow's keys, from its `config.yaml`: the rules the
 * version would have been stored with now. Matching against them (decideDispatch) applies the
 * same label and actor rules as for a current version. null when it cannot be read as a config.
 */
export function rulesFromBundle(configYaml: string, paused: ReadonlySet<string> = new Set()): DispatchRules | null {
  try {
    const compiled = parse(configYaml) as unknown;
    if (!isObject(compiled)) return null;
    return dispatchRules(compiled as Parameters<typeof dispatchRules>[0], { paused, keysFor: (repo, wf) => workflowKeys(compiled, repo, wf) });
  } catch {
    return null;
  }
}

/** Reads one object of the tenant bucket: its text, or null when there is none. */
export type ReadObject = (key: string) => Promise<string | null>;

/**
 * The keys of a version whose dispatch rules predate them (published before #70), from its
 * bundle. Versions are immutable, so each is read once per process. A read that fails throws
 * (the caller retries); a bundle that is missing or not a config gives null.
 */
export function createBundleKeys(read: ReadObject, configPrefixOf: (installationId: number, version: number) => string) {
  const cache = new Map<string, Promise<string | null>>();
  const load = (installationId: number, version: number) => {
    const id = `${installationId}/${version}`;
    let hit = cache.get(id);
    if (!hit) {
      hit = read(`${configPrefixOf(installationId, version)}config.yaml`);
      // A failed read is not remembered: the next delivery tries again.
      hit.catch(() => cache.delete(id));
      cache.set(id, hit);
    }
    return hit;
  };
  return {
    /** The keys a job for this event can need (the workflows its label and sender match); null when the bundle cannot tell. */
    async forEvent(installationId: number, version: number, event: Parameters<typeof decideDispatch>[1]): Promise<string[] | null> {
      const text = await load(installationId, version);
      const rules = text === null ? null : rulesFromBundle(text);
      if (!rules) return null;
      const decision = decideDispatch(rules, event);
      return decision.start ? decision.keys : null;
    },
    /** Every key a job of an enabled repository can need; null when the bundle cannot tell. */
    async forVersion(installationId: number, version: number, paused: ReadonlySet<string> = new Set()): Promise<string[] | null> {
      const text = await load(installationId, version);
      const rules = text === null ? null : rulesFromBundle(text, paused);
      return rules ? keysOfRules(rules) : null;
    },
  };
}

export type BundleKeys = ReturnType<typeof createBundleKeys>;

/** Every key a version's enabled repositories can need, from its dispatch rules; null when they predate keys. */
export function keysOfRules(rules: { repositories: Record<string, { paused?: boolean; keys?: string[]; triggers: { keys?: string[] }[] }> } | undefined): string[] | null {
  if (!rules) return [];
  const out = new Set<string>();
  for (const repo of Object.values(rules.repositories)) {
    for (const t of repo.triggers) {
      const keys = t.keys ?? repo.keys;
      if (!Array.isArray(keys)) return null;
      if (!repo.paused) keys.forEach((k) => out.add(k));
    }
  }
  return [...out].sort();
}
