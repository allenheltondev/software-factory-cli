import { parse } from 'yaml';
import { AGENT_KEY_ENV, type CloudAgent } from './agents.js';

/**
 * Which agent keys a job can need (#70), from a compiled config (what `config.yaml` holds):
 * per repository and trigger label, every enabled agent of every pool the label's workflows
 * route to (the pool, its rules and default, the tier pools) and, with review on, the pool each
 * workflow's reviewer is routed to (as the worker's reviewPoolFor picks it). Computed when a
 * version is published and stored on its dispatch rules; for a version published before that,
 * from its bundle (keysFromBundle).
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

/** Per repository (lower-case) and trigger label (lower-case): the key names a job it starts can need, sorted. */
export function keysByTrigger(compiled: { agents?: unknown; pools?: unknown; repositories?: unknown }): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, Set<string>>> = {};
  for (const [fullName, repo] of Object.entries(isObject(compiled.repositories) ? compiled.repositories : {})) {
    if (!isObject(repo)) continue;
    const byLabel = (out[fullName.toLowerCase()] ??= {});
    for (const wf of Array.isArray(repo.workflows) ? repo.workflows : []) {
      if (!isObject(wf) || !isObject(wf.trigger) || typeof wf.trigger.label !== 'string' || wf.trigger.label === '') continue;
      // Workflows that share a label: a job for it can run any of them.
      const keys = (byLabel[wf.trigger.label.toLowerCase()] ??= new Set());
      for (const pool of workflowPools(repo, wf)) for (const k of poolAgentKeys(compiled, pool)) keys.add(k.key);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([repo, labels]) => [repo, Object.fromEntries(Object.entries(labels).map(([l, s]) => [l, [...s].sort()]))]));
}

/** keysByTrigger of a version's `config.yaml`; null when it cannot be read as one. */
export function keysFromBundle(configYaml: string): Record<string, Record<string, string[]>> | null {
  try {
    const compiled = parse(configYaml) as unknown;
    return isObject(compiled) ? keysByTrigger(compiled) : null;
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
  const cache = new Map<string, Promise<Record<string, Record<string, string[]>> | null>>();
  const load = (installationId: number, version: number) => {
    const id = `${installationId}/${version}`;
    let hit = cache.get(id);
    if (!hit) {
      hit = read(`${configPrefixOf(installationId, version)}config.yaml`).then((text) => (text === null ? null : keysFromBundle(text)));
      // A failed read is not remembered: the next delivery tries again.
      hit.catch(() => cache.delete(id));
      cache.set(id, hit);
    }
    return hit;
  };
  return {
    /** The keys a job for this repository and label can need; null when the bundle cannot tell. */
    async forTrigger(installationId: number, version: number, repository: string, label: string): Promise<string[] | null> {
      const all = await load(installationId, version);
      if (!all) return null;
      return all[repository.toLowerCase()]?.[label.toLowerCase()] ?? [];
    },
    /** Every key a job of an enabled repository can need; null when the bundle cannot tell. */
    async forVersion(installationId: number, version: number, paused: ReadonlySet<string> = new Set()): Promise<string[] | null> {
      const all = await load(installationId, version);
      if (!all) return null;
      const out = new Set<string>();
      for (const [repo, labels] of Object.entries(all)) if (!paused.has(repo)) for (const keys of Object.values(labels)) keys.forEach((k) => out.add(k));
      return [...out].sort();
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
