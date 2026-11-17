/**
 * Pure config editing used by `factory configure` and `factory add`: seeding
 * defaults, merging repo selections, and describing what changed. Works on the
 * config *input* shape so saved files don't freeze schema defaults.
 */
import type { z } from 'zod';
import {
  CONFIG_VERSION,
  workflowId,
  type FactoryConfigInput,
  type repositorySchema,
  type workflowSchema,
} from '../config/schema.js';

export type WorkflowInput = z.input<typeof workflowSchema>;
export type RepositoryInput = z.input<typeof repositorySchema>;
export type PoolSelectorInput = WorkflowInput['pool'];
export interface RouteRule {
  hasLabel: string;
  use: string;
}

export const DEFAULT_LABEL = 'ready';
export const DEFAULT_ACTION = 'implement-issue';
export const DEFAULT_POOL = 'general';
export const DEFAULT_AGENTS = ['codex', 'claude', 'kiro'] as const;

/** Defaults for a first run. */
export function seedConfig(viewerLogin: string): FactoryConfigInput {
  return {
    version: CONFIG_VERSION,
    pollIntervalSeconds: 60,
    maxConcurrent: 2,
    execution: { mode: 'log-only' },
    dispatch: { allowedActors: [viewerLogin] },
    agents: {
      codex: { maxConcurrent: 1 },
      claude: { maxConcurrent: 1 },
      kiro: { maxConcurrent: 1 },
    },
    pools: {
      [DEFAULT_POOL]: { agents: ['claude', 'kiro'], strategy: 'round-robin' },
    },
    actions: {
      [DEFAULT_ACTION]: { prompt: `./prompts/${DEFAULT_ACTION}.md`, output: 'local-branch' },
    },
    repositories: {},
  };
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

export function buildPoolSelector(rules: RouteRule[], defaultPool: string): PoolSelectorInput {
  return rules.length ? { rules: rules.map((r) => ({ ...r })), default: defaultPool } : defaultPool;
}

export function buildWorkflow(o: {
  label: string;
  action: string;
  pool: string;
  routes?: RouteRule[];
  id?: string;
}): WorkflowInput {
  const wf: WorkflowInput = {
    trigger: { event: 'issue.labeled', label: o.label },
    action: o.action,
    pool: buildPoolSelector(o.routes ?? [], o.pool),
  };
  return o.id ? { id: o.id, ...wf } : wf;
}

/** Parse `LABEL=POOL` (labels may contain "="; pool names cannot). */
export function parseRoute(spec: string): RouteRule {
  const i = spec.lastIndexOf('=');
  const hasLabel = i > 0 ? spec.slice(0, i).trim() : '';
  const use = i > 0 ? spec.slice(i + 1).trim() : '';
  if (!hasLabel || !use) throw new Error(`invalid route "${spec}"; expected LABEL=POOL`);
  return { hasLabel, use };
}

/** Accept YYYY-MM-DD or an ISO date-time; return a normalized UTC timestamp, or null if unparseable. */
export function normalizeBackfillSince(input: string): string | null {
  const s = input.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/i.test(s)) return null;
  const d = new Date(s.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function findRepoKeyById(config: FactoryConfigInput, id: number): string | undefined {
  return Object.entries(config.repositories ?? {}).find(([, r]) => r.id === id)?.[0];
}

function findRepoKey(config: FactoryConfigInput, id: number, fullName: string): string | undefined {
  return (
    findRepoKeyById(config, id) ??
    Object.keys(config.repositories ?? {}).find((k) => k.toLowerCase() === fullName.toLowerCase())
  );
}

export interface UpsertResult {
  config: FactoryConfigInput;
  /** True when a workflow with the same ID was replaced (vs. appended). */
  replaced: boolean;
  /** Previous config key when the repo was renamed/transferred on GitHub. */
  renamedFrom?: string;
}

/**
 * Add or replace one workflow on a repo (matched by GitHub ID, then name),
 * creating the repo entry if needed. The repo is keyed by its current full name.
 */
export function upsertRepoWorkflow(
  base: FactoryConfigInput,
  repo: { id: number; fullName: string },
  workflow: WorkflowInput,
  opts: { backfillSince?: string } = {},
): UpsertResult {
  const config = clone(base);
  const repos: Record<string, RepositoryInput> = { ...(config.repositories ?? {}) };
  const existingKey = findRepoKey(config, repo.id, repo.fullName);
  const entry: RepositoryInput = existingKey
    ? { ...repos[existingKey]!, id: repo.id, workflows: [...repos[existingKey]!.workflows] }
    : { id: repo.id, workflows: [] };

  const wfId = workflowId(workflow);
  const idx = entry.workflows.findIndex((w) => workflowId(w) === wfId);
  if (idx >= 0) entry.workflows[idx] = clone(workflow);
  else entry.workflows.push(clone(workflow));
  if (opts.backfillSince) entry.backfillSince = opts.backfillSince;

  if (existingKey) delete repos[existingKey];
  repos[repo.fullName] = entry;
  config.repositories = repos;
  const result: UpsertResult = { config, replaced: idx >= 0 };
  if (existingKey && existingKey !== repo.fullName) result.renamedFrom = existingKey;
  return result;
}

export interface RepoSelection {
  id: number;
  fullName: string;
  workflows: WorkflowInput[];
  /** Only applied to repos not already in the config. */
  backfillSince?: string;
}

/**
 * Replace the watched-repo set with `selections` (configure's picker result).
 * Repos are matched by GitHub ID so renames keep their settings; repos not
 * selected are removed. Other repo settings (baseBranch, checkoutPath) are kept.
 */
export function applyRepoSelections(base: FactoryConfigInput, selections: RepoSelection[]): FactoryConfigInput {
  const config = clone(base);
  const repos: Record<string, RepositoryInput> = {};
  for (const sel of selections) {
    const key = findRepoKey(base, sel.id, sel.fullName);
    const existing = key ? base.repositories?.[key] : undefined;
    const entry: RepositoryInput = existing
      ? { ...clone(existing), id: sel.id, workflows: clone(sel.workflows) }
      : { id: sel.id, workflows: clone(sel.workflows) };
    if (!existing && sel.backfillSince) entry.backfillSince = sel.backfillSince;
    repos[sel.fullName] = entry;
  }
  config.repositories = repos;
  return config;
}

/** Enable exactly the named agents (others stay configured but disabled). */
export function setEnabledAgents(base: FactoryConfigInput, enabled: readonly string[]): FactoryConfigInput {
  const config = clone(base);
  for (const [name, agent] of Object.entries(config.agents)) {
    if (enabled.includes(name)) delete agent.enabled;
    else agent.enabled = false;
  }
  return config;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export interface RepoRefLite {
  id: number;
  fullName: string;
}

export interface WorkflowChange {
  repo: string;
  id: string;
  summary: string;
}

export interface ConfigDiff {
  reposAdded: RepoRefLite[];
  reposRemoved: RepoRefLite[];
  reposRenamed: Array<{ id: number; from: string; to: string }>;
  workflowsAdded: WorkflowChange[];
  workflowsRemoved: WorkflowChange[];
  workflowsChanged: WorkflowChange[];
  /** Other settings, e.g. "agent kiro disabled", "pool art added". */
  other: string[];
}

export function describeWorkflow(wf: WorkflowInput): string {
  const pool =
    typeof wf.pool === 'string'
      ? wf.pool
      : `${wf.pool.default}${wf.pool.rules?.length ? ` (${wf.pool.rules.map((r) => `${r.hasLabel}→${r.use}`).join(', ')})` : ''}`;
  return `"${wf.trigger.label}" → ${wf.action} via pool ${pool}`;
}

function reposById(c: FactoryConfigInput | null): Map<number, { fullName: string; repo: RepositoryInput }> {
  const m = new Map<number, { fullName: string; repo: RepositoryInput }>();
  for (const [fullName, repo] of Object.entries(c?.repositories ?? {})) m.set(repo.id, { fullName, repo });
  return m;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function diffRecord(kind: string, a: Record<string, unknown> = {}, b: Record<string, unknown> = {}, out: string[]): void {
  for (const k of Object.keys(b)) if (!(k in a)) out.push(`${kind} ${k} added`);
  for (const k of Object.keys(a)) if (!(k in b)) out.push(`${kind} ${k} removed`);
  for (const k of Object.keys(b)) if (k in a && !same(a[k], b[k])) out.push(`${kind} ${k} changed`);
}

/**
 * What changed between two configs. `before` is null when no config existed; then
 * `seed` (the defaults the new config started from) is used to report setting changes.
 */
export function diffConfigs(
  before: FactoryConfigInput | null,
  after: FactoryConfigInput,
  opts: { seed?: FactoryConfigInput } = {},
): ConfigDiff {
  const diff: ConfigDiff = {
    reposAdded: [],
    reposRemoved: [],
    reposRenamed: [],
    workflowsAdded: [],
    workflowsRemoved: [],
    workflowsChanged: [],
    other: [],
  };
  const a = reposById(before);
  const b = reposById(after);

  for (const [id, { fullName, repo }] of b) {
    const prev = a.get(id);
    if (!prev) diff.reposAdded.push({ id, fullName });
    else if (prev.fullName !== fullName) diff.reposRenamed.push({ id, from: prev.fullName, to: fullName });
    const prevWfs = new Map((prev?.repo.workflows ?? []).map((w) => [workflowId(w), w]));
    for (const wf of repo.workflows) {
      const wid = workflowId(wf);
      const old = prevWfs.get(wid);
      const change = { repo: fullName, id: wid, summary: describeWorkflow(wf) };
      if (!old) diff.workflowsAdded.push(change);
      else if (!same(old, wf)) diff.workflowsChanged.push(change);
    }
    const nowIds = new Set(repo.workflows.map((w) => workflowId(w)));
    for (const [wid, wf] of prevWfs) {
      if (!nowIds.has(wid)) diff.workflowsRemoved.push({ repo: fullName, id: wid, summary: describeWorkflow(wf) });
    }
    if (prev && prev.repo.backfillSince !== repo.backfillSince && repo.backfillSince) {
      diff.other.push(`${fullName} backfill since ${repo.backfillSince}`);
    }
  }
  for (const [id, { fullName, repo }] of a) {
    if (b.has(id)) continue;
    diff.reposRemoved.push({ id, fullName });
    for (const wf of repo.workflows) {
      diff.workflowsRemoved.push({ repo: fullName, id: workflowId(wf), summary: describeWorkflow(wf) });
    }
  }

  if (!before) diff.other.push('new config created with default agents, pools and actions');
  const base = before ?? opts.seed;
  if (base) {
    for (const [name, agent] of Object.entries(after.agents)) {
      const prev = base.agents[name];
      if (!prev) continue;
      const was = prev.enabled !== false;
      const is = agent.enabled !== false;
      if (was !== is) diff.other.push(`agent ${name} ${is ? 'enabled' : 'disabled'}`);
      else if (!same(prev, agent)) diff.other.push(`agent ${name} changed`);
    }
    for (const k of Object.keys(after.agents)) if (!(k in base.agents)) diff.other.push(`agent ${k} added`);
    for (const k of Object.keys(base.agents)) if (!(k in after.agents)) diff.other.push(`agent ${k} removed`);
    diffRecord('pool', base.pools, after.pools, diff.other);
    diffRecord('action', base.actions, after.actions, diff.other);
    if (!same(base.dispatch, after.dispatch)) diff.other.push('dispatch.allowedActors changed');
    for (const key of ['pollIntervalSeconds', 'maxConcurrent'] as const) {
      if (!same(base[key], after[key])) diff.other.push(`${key} changed to ${after[key] ?? '(default)'}`);
    }
  }
  return diff;
}

export function isEmptyDiff(d: ConfigDiff): boolean {
  return (
    !d.reposAdded.length &&
    !d.reposRemoved.length &&
    !d.reposRenamed.length &&
    !d.workflowsAdded.length &&
    !d.workflowsRemoved.length &&
    !d.workflowsChanged.length &&
    !d.other.length
  );
}

export function formatDiff(d: ConfigDiff): string[] {
  if (isEmptyDiff(d)) return ['No changes.'];
  const lines: string[] = [];
  for (const r of d.reposAdded) lines.push(`+ repo ${r.fullName} (id ${r.id})`);
  for (const r of d.reposRemoved) lines.push(`- repo ${r.fullName} (id ${r.id})`);
  for (const r of d.reposRenamed) lines.push(`~ repo ${r.from} → ${r.to} (id ${r.id})`);
  for (const w of d.workflowsAdded) lines.push(`+ workflow ${w.repo} [${w.id}]: ${w.summary}`);
  for (const w of d.workflowsChanged) lines.push(`~ workflow ${w.repo} [${w.id}]: ${w.summary}`);
  for (const w of d.workflowsRemoved) lines.push(`- workflow ${w.repo} [${w.id}]: ${w.summary}`);
  for (const o of d.other) lines.push(`~ ${o}`);
  return lines;
}

export const RESTART_REMINDER = 'Changes apply when the worker restarts ("factory start").';
