import type { AgentAdapter, ConfigIssue, ConfigView, ConsoleConfig, ConsoleRepository, ConsoleWorkflow } from '../../api/client';

/** Agent, pool and workflow names, as the server checks them. */
export const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const NAME_RULE = 'Lower-case letters, digits and "-", at most 40';

export const AGENT_LABEL: Record<AgentAdapter, string> = { claude: 'Claude Code', codex: 'Codex', kiro: 'Kiro', vibe: 'Mistral Vibe' };
export const KEY_FOR: Record<AgentAdapter, string> = { claude: 'ANTHROPIC_API_KEY', codex: 'CODEX_API_KEY', kiro: 'KIRO_API_KEY', vibe: 'MISTRAL_API_KEY' };
/** What an API from before the deployment named its agents offers. */
export const DEFAULT_OFFERED: AgentAdapter[] = ['claude', 'codex'];

/** Logins from free text: commas or spaces between them, an @ in front allowed. */
export const parseLogins = (text: string) => [...new Set(text.split(/[\s,]+/).map((s) => s.replace(/^@/, '')).filter(Boolean))];
export const parseLines = (text: string) => text.split('\n').map((s) => s.trim()).filter(Boolean);
export const numberOrUndefined = (v: string) => (v.trim() === '' ? undefined : Number(v));

/** The issues about a field or anything inside it (paths as the server reports them). */
export function issuesAt(issues: ConfigIssue[], path: string): string | undefined {
  const found = issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`));
  return found.length ? found.map((i) => i.message).join('; ') : undefined;
}

/** A name not yet taken: `base`, else `base-2`, `base-3`, ... */
export function freeName(base: string, taken: Record<string, unknown>): string {
  const stem = base.slice(0, 36);
  if (!Object.hasOwn(taken, stem)) return stem;
  for (let i = 2; ; i++) if (!Object.hasOwn(taken, `${stem}-${i}`)) return `${stem}-${i}`;
}

/**
 * A repository just added. When its workflows review, CI repair starts on (the guided software
 * factory: a failing check on a reviewed pull request is fixed, not left). A repository already
 * configured keeps what it has: an explicit off stays off.
 */
export function newRepository(workflows: string[], reviewed = false): ConsoleRepository {
  return { enabled: true, workflows, publish: 'draft-pr', commentOnFailure: true, verify: [], ...(reviewed ? { ci: {} } : {}) };
}

/** A new workflow: the first pool builds, a second one (when there is one) reviews, with the packaged prompts. */
export function newWorkflow(config: ConsoleConfig, prompts: ConfigView['defaults']['prompts'], label: string): ConsoleWorkflow {
  const pools = Object.keys(config.pools);
  const pool = pools.includes('builders') ? 'builders' : (pools[0] ?? '');
  const reviewPool = pools.includes('reviewers') ? 'reviewers' : (pools.find((p) => p !== pool) ?? pool);
  return {
    label,
    pool,
    prompt: prompts.implement,
    review: { enabled: true, pool: reviewPool, prompt: prompts.review, allowSameAgent: enabledAgents(config, reviewPool).length < 2 },
    revise: { enabled: true, prompt: prompts.revise },
  };
}

/** The agents of a pool that are on. */
export const enabledAgents = (config: ConsoleConfig, pool: string) => (config.pools[pool]?.agents ?? []).filter((a) => config.agents[a]?.enabled);

/** The pools a workflow uses: the one that builds, and the reviewers when it reviews. */
export const poolsOf = (w: ConsoleWorkflow) => (w.review.enabled ? [w.pool, w.review.pool] : [w.pool]);

/** Every key the agents an enabled repository can start need, and which are not set. */
export function keysNeeded(config: ConsoleConfig, keys: Record<string, boolean>) {
  const agents = new Set<string>();
  for (const r of Object.values(config.repositories)) {
    if (!r.enabled) continue;
    for (const n of r.workflows) {
      const w = config.workflows[n];
      if (!w) continue;
      for (const p of poolsOf(w)) enabledAgents(config, p).forEach((a) => agents.add(a));
    }
  }
  const needed = [...new Set([...agents].map((a) => KEY_FOR[config.agents[a]!.adapter]))];
  return { needed, missing: needed.filter((k) => !keys[k]), agents: [...agents] };
}

/** Workflows the repository runs whose labels clash or whose pull-request handling differs: what the server would refuse. */
export function workflowConflict(config: ConsoleConfig, repo: ConsoleRepository): string | null {
  const wfs = repo.workflows.map((n) => [n, config.workflows[n]] as const).filter((x): x is readonly [string, ConsoleWorkflow] => !!x[1]);
  const labels = new Map<string, string>();
  for (const [n, w] of wfs) {
    const prior = labels.get(w.label.toLowerCase());
    if (prior) return `${prior} and ${n} both start on the label "${w.label}".`;
    labels.set(w.label.toLowerCase(), n);
  }
  const policy = (w: ConsoleWorkflow) => JSON.stringify([w.review.enabled, w.review.enabled && w.review.allowSameAgent, w.revise.enabled, w.revise.enabled ? (w.revise.maxRevisions ?? null) : null]);
  const first = wfs[0];
  const other = first && wfs.find(([, w]) => policy(w) !== policy(first[1]));
  if (first && other) return `${first[0]} and ${other[0]} review or revise pull requests differently; one repository's workflows must agree.`;
  return null;
}

/** Whether a repository's workflows revise pull requests (they agree on it). */
export const revises = (config: ConsoleConfig, repo: ConsoleRepository) => repo.workflows.some((n) => config.workflows[n]?.revise.enabled);

export const reviews = (config: ConsoleConfig, repo: ConsoleRepository) => repo.workflows.some((n) => config.workflows[n]?.review.enabled);

/** Which editor section a field path belongs to. */
export type Section = 'repositories' | 'workflows' | 'agents';
export const sectionOf = (path: string): Section =>
  path.startsWith('agents') || path.startsWith('pools') ? 'agents' : path.startsWith('workflows') ? 'workflows' : 'repositories';
