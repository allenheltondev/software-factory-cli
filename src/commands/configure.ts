import { saveConfig } from '../config/io.js';
import { writeStarterPrompts } from '../config/prompts.js';
import { workflowId, type FactoryConfigInput } from '../config/schema.js';
import { formatIssues, validateConfig } from '../config/validate.js';
import type { GitHubApi, GitHubLabel, GitHubRepo } from '../github/api.js';
import { labelEquals } from '../routing.js';
import { loadEditableConfig } from './add.js';
import {
  DEFAULT_ACTION,
  DEFAULT_LABEL,
  DEFAULT_POOL,
  RESTART_REMINDER,
  applyRepoSelections,
  buildWorkflow,
  describeWorkflow,
  diffConfigs,
  findRepoKeyById,
  formatDiff,
  isEmptyDiff,
  normalizeBackfillSince,
  seedConfig,
  setEnabledAgents,
  type RepoSelection,
  type RouteRule,
  type WorkflowInput,
} from './config-edit.js';
import type { AgentReport } from '../agents/discovery.js';
import { agentHint } from './agents.js';
import type { CommandContext } from './context.js';
import { CliError, EXIT } from './errors.js';
import type { Choice, Prompter } from './prompter.js';

const CUSTOM = '\u0000custom';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface RepoChoiceInput {
  /** Repos from GET /user/repos. */
  listed: GitHubRepo[];
  /** Configured repos that were not listed, after a getRepo check (null = inaccessible). */
  extra: Array<{ fullName: string; id: number; repo: GitHubRepo | null }>;
  /** IDs currently in the config. */
  watchedIds: Set<number>;
}

/** Picker options and preselection (by repo ID). Watched repos sort first. Pure. */
export function buildRepoChoices(input: RepoChoiceInput): { options: Choice<number>[]; initialValues: number[] } {
  const rows: Array<{ choice: Choice<number>; watched: boolean }> = [];
  const hintFor = (r: GitHubRepo, watched: boolean) =>
    [watched ? 'watched' : null, r.private ? 'private' : 'public', r.archived ? 'archived' : null, r.description]
      .filter(Boolean)
      .join(' · ')
      .slice(0, 80);
  for (const r of input.listed) {
    const watched = input.watchedIds.has(r.id);
    rows.push({ choice: { value: r.id, label: r.fullName, hint: hintFor(r, watched) }, watched });
  }
  for (const e of input.extra) {
    rows.push({
      choice: e.repo
        ? { value: e.id, label: e.repo.fullName, hint: hintFor(e.repo, true) }
        : { value: e.id, label: e.fullName, hint: 'watched · NOT accessible with this account (deselected)' },
      watched: true,
    });
  }
  rows.sort((a, b) => Number(b.watched) - Number(a.watched) || a.choice.label.localeCompare(b.choice.label));
  const initialValues = [
    ...input.listed.filter((r) => input.watchedIds.has(r.id)).map((r) => r.id),
    ...input.extra.filter((e) => e.repo).map((e) => e.id),
  ];
  return { options: rows.map((r) => r.choice), initialValues };
}

interface Session {
  p: Prompter;
  api: GitHubApi;
  /** Working copy; new pools/actions created during prompts are added here. */
  config: FactoryConfigInput;
  /** Agent names that are enabled and usable on this machine (from discovery). */
  usable: Set<string>;
  /** Discovery hint per agent name, for pickers. */
  agentHints: Map<string, string>;
}

/**
 * Agent picker options from discovery. Pre-selects agents that are usable here and not explicitly
 * disabled in the existing config; missing or signed-out agents are listed with why. Pure.
 */
export function buildAgentChoices(
  agents: Record<string, { adapter?: string; enabled?: boolean }>,
  reports: AgentReport[],
  hasConfig: boolean,
): { options: Choice<string>[]; initialValues: string[]; hints: Map<string, string>; usable: Set<string> } {
  const hints = new Map<string, string>();
  const usable = new Set<string>();
  for (const [n, a] of Object.entries(agents)) {
    const r = reports.find((x) => x.adapter === (a.adapter ?? n));
    hints.set(n, r ? `${r.command} · ${agentHint(r)}` : 'unknown adapter');
    if (r?.usable) usable.add(n);
  }
  const names = Object.keys(agents);
  return {
    options: names.map((n) => ({ value: n, label: n, hint: hints.get(n) })),
    initialValues: names.filter((n) => usable.has(n) && (!hasConfig || agents[n]!.enabled !== false)),
    hints,
    usable,
  };
}

/** Pools worth suggesting: those with at least one usable agent. Falls back to all pools if none qualify. */
export function suggestedPools(pools: Record<string, { agents: string[] }>, usable: Set<string>): { pools: string[]; hidden: string[] } {
  const all = Object.keys(pools);
  const ok = all.filter((n) => pools[n]!.agents.some((a) => usable.has(a)));
  return ok.length ? { pools: ok, hidden: all.filter((n) => !ok.includes(n)) } : { pools: all, hidden: [] };
}

async function pickLabel(
  s: Session,
  labels: GitHubLabel[],
  repoName: string,
  message: string,
  preferred?: string,
): Promise<string> {
  let name: string = CUSTOM;
  if (labels.length) {
    const initial = preferred ? labels.find((l) => labelEquals(l.name, preferred))?.name : undefined;
    name = await s.p.searchSelect<string>({
      message,
      options: [
        ...labels.map((l) => ({ value: l.name, label: l.name, hint: l.description ?? undefined })),
        { value: CUSTOM, label: 'Type a label name…', hint: 'for a label you will create on GitHub' },
      ],
      initialValue: initial,
    });
  }
  if (name === CUSTOM) {
    name = (
      await s.p.text({
        message,
        initialValue: preferred,
        placeholder: preferred,
        validate: (v) => (v.trim() ? undefined : 'Enter a label name'),
      })
    ).trim();
  }
  if (!labels.some((l) => labelEquals(l.name, name))) {
    s.p.warn(`Label "${name}" does not exist on ${repoName}. Create it on GitHub before dispatching (factory never creates labels).`);
  }
  return name;
}

async function pickPool(s: Session, message: string, initial?: string): Promise<string> {
  const { pools, hidden } = suggestedPools(s.config.pools, s.usable);
  if (hidden.length) s.p.info(`Not offering pool(s) with no usable agent here: ${hidden.join(', ')}`);
  const choice = await s.p.select<string>({
    message,
    options: [
      ...pools.map((n) => ({ value: n, label: n, hint: s.config.pools[n]!.agents.join(', ') })),
      { value: CUSTOM, label: 'New pool…' },
    ],
    initialValue: initial && pools.includes(initial) ? initial : pools[0],
  });
  if (choice !== CUSTOM) return choice;
  const name = (
    await s.p.text({
      message: 'Pool name',
      validate: (v) =>
        !NAME_RE.test(v.trim()) ? 'Use letters, digits, ".", "_" or "-"' : s.config.pools[v.trim()] ? 'That pool exists' : undefined,
    })
  ).trim();
  const agents = await s.p.multiselect<string>({
    message: `Agents in pool ${name} (round-robin)`,
    options: Object.keys(s.config.agents).map((a) => ({ value: a, label: a, hint: s.agentHints.get(a) })),
    initialValues: Object.keys(s.config.agents).filter((a) => s.usable.has(a)),
    required: true,
  });
  s.config.pools[name] = { agents, strategy: 'round-robin' };
  return name;
}

async function pickAction(s: Session): Promise<string> {
  const actions = Object.keys(s.config.actions);
  const choice = await s.p.select<string>({
    message: 'Action to run',
    options: [
      ...actions.map((a) => ({ value: a, label: a, hint: s.config.actions[a]!.prompt })),
      { value: CUSTOM, label: 'New action…' },
    ],
    initialValue: actions.includes(DEFAULT_ACTION) ? DEFAULT_ACTION : actions[0],
  });
  if (choice !== CUSTOM) return choice;
  const name = (
    await s.p.text({
      message: 'Action name',
      validate: (v) =>
        !NAME_RE.test(v.trim()) ? 'Use letters, digits, ".", "_" or "-"' : s.config.actions[v.trim()] ? 'That action exists' : undefined,
    })
  ).trim();
  const prompt = (
    await s.p.text({
      message: 'Prompt file (relative to the config file)',
      initialValue: `./prompts/${name}.md`,
      validate: (v) => (v.trim() ? undefined : 'Enter a path'),
    })
  ).trim();
  s.config.actions[name] = { prompt };
  return name;
}

async function promptWorkflow(s: Session, repo: GitHubRepo, labels: GitHubLabel[], takenIds: Set<string>): Promise<WorkflowInput> {
  const label = await pickLabel(s, labels, repo.fullName, `${repo.fullName}: trigger label`, DEFAULT_LABEL);
  const action = await pickAction(s);
  const routes: RouteRule[] = [];
  let more = await s.p.confirm({ message: 'Route issues with certain labels to a different pool?', initialValue: false });
  while (more) {
    const hasLabel = await pickLabel(s, labels, repo.fullName, 'Issues with label');
    const use = await pickPool(s, `…go to pool`);
    routes.push({ hasLabel, use });
    more = await s.p.confirm({ message: 'Add another routing rule?', initialValue: false });
  }
  const pool = await pickPool(s, routes.length ? 'Default pool (no rule matched)' : 'Pool', DEFAULT_POOL);

  let id: string | undefined;
  if (takenIds.has(workflowId({ action, trigger: { event: 'issue.labeled', label } }))) {
    id = (
      await s.p.text({
        message: 'This repo already has a workflow for that action and label. Workflow id',
        validate: (v) => (!NAME_RE.test(v.trim()) ? 'Use letters, digits, ".", "_" or "-"' : takenIds.has(v.trim()) ? 'Already used' : undefined),
      })
    ).trim();
  }
  const wf = buildWorkflow({ label, action, pool, routes, id });
  takenIds.add(workflowId(wf));
  return wf;
}

async function promptWorkflows(s: Session, repo: GitHubRepo, existing: WorkflowInput[]): Promise<WorkflowInput[]> {
  const labels = await s.p
    .spin(`Loading labels for ${repo.fullName}`, () => s.api.listLabels({ id: repo.id, fullName: repo.fullName }))
    .catch((err: unknown) => {
      s.p.warn(`Could not load labels for ${repo.fullName}: ${(err as Error).message}`);
      return [] as GitHubLabel[];
    });
  const taken = new Set(existing.map((w) => workflowId(w)));
  const out: WorkflowInput[] = [];
  do {
    out.push(await promptWorkflow(s, repo, labels, taken));
  } while (await s.p.confirm({ message: `Add another workflow to ${repo.fullName}?`, initialValue: false }));
  return out;
}

async function promptBackfill(p: Prompter, repo: GitHubRepo): Promise<string | undefined> {
  const mode = await p.select<'now' | 'backfill'>({
    message: `${repo.fullName} is new. Where should it start?`,
    options: [
      { value: 'now', label: 'Start at the current state', hint: 'only label events from now on' },
      { value: 'backfill', label: 'Backfill since a date', hint: 'enqueue matching label events since then' },
    ],
    initialValue: 'now',
  });
  if (mode === 'now') return undefined;
  const raw = await p.text({
    message: 'Backfill since (YYYY-MM-DD or ISO 8601)',
    placeholder: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10),
    validate: (v) => (normalizeBackfillSince(v) ? undefined : 'Enter a date like 2025-01-31'),
  });
  return normalizeBackfillSince(raw) ?? undefined;
}

export async function configureCommand(ctx: CommandContext): Promise<number> {
  if (!ctx.isTTY) {
    throw new CliError(
      '"factory configure" is interactive and needs a terminal. For scripted setup use "factory add OWNER/REPO".',
      EXIT.USAGE,
    );
  }
  const configPath = ctx.paths.configFile;
  const existing = loadEditableConfig(configPath);
  const p = ctx.prompter();
  p.intro('factory configure');

  const api = await p.spin('Connecting to GitHub', () => ctx.createApi());
  const viewer = await api.getViewer();
  p.info(`GitHub account: ${viewer.login}`);
  const seed = seedConfig(viewer.login);
  const s: Session = { p, api, config: structuredClone(existing ?? seed), usable: new Set(), agentHints: new Map() };
  if (!existing) {
    p.info(`No config at ${configPath}; starting from defaults (allowed dispatcher: ${viewer.login}).`);
  }

  // Agents: pre-select the ones discovery finds usable here; list the rest with why.
  const reports = await p.spin('Looking for coding agents', () => ctx.discoverAgents());
  const agentChoices = buildAgentChoices(s.config.agents, reports, Boolean(existing));
  s.agentHints = agentChoices.hints;
  if (!agentChoices.usable.size) p.warn('No usable coding agent found on this machine. Run "factory agents" for details.');
  const enabled = await p.multiselect<string>({
    message: 'Enabled agents',
    options: agentChoices.options,
    initialValues: agentChoices.initialValues,
    required: true,
  });
  s.config = setEnabledAgents(s.config, enabled);
  s.usable = new Set(enabled.filter((n) => agentChoices.usable.has(n)));

  // Repositories (matched by stable ID)
  const listed = await p.spin('Loading repositories', () => api.listUserRepos());
  const listedIds = new Set(listed.map((r) => r.id));
  const extra: RepoChoiceInput['extra'] = [];
  for (const [fullName, r] of Object.entries(s.config.repositories ?? {})) {
    if (listedIds.has(r.id)) continue;
    // Added by name (e.g. a public repo) — verify it's still accessible.
    const repo = await api.getRepo(fullName).catch(() => null);
    extra.push({ fullName, id: r.id, repo: repo && repo.id === r.id ? repo : null });
  }
  const watchedIds = new Set(Object.values(s.config.repositories ?? {}).map((r) => r.id));
  const { options, initialValues } = buildRepoChoices({ listed, extra, watchedIds });
  const selectedIds = await p.searchMultiselect<number>({
    message: 'Repositories to watch (type to search, space to toggle)',
    options,
    initialValues,
  });
  const byId = new Map<number, GitHubRepo>(listed.map((r) => [r.id, r]));
  for (const e of extra) if (e.repo) byId.set(e.id, e.repo);

  const selections: RepoSelection[] = [];
  for (const id of selectedIds) {
    const repo = byId.get(id);
    if (!repo) {
      p.warn(`Skipping repo id ${id}: not accessible with this account.`);
      continue;
    }
    const key = findRepoKeyById(s.config, id);
    const current = key ? s.config.repositories![key]!.workflows : [];
    let workflows: WorkflowInput[];
    if (current.length) {
      p.note(current.map((w) => `[${workflowId(w)}] ${describeWorkflow(w)}`).join('\n'), repo.fullName);
      const mode = await p.select<'keep' | 'add' | 'replace'>({
        message: `${repo.fullName}: workflows`,
        options: [
          { value: 'keep', label: 'Keep as is' },
          { value: 'add', label: 'Add a workflow' },
          { value: 'replace', label: 'Replace with new workflows' },
        ],
        initialValue: 'keep',
      });
      workflows =
        mode === 'keep'
          ? current
          : mode === 'add'
            ? [...current, ...(await promptWorkflows(s, repo, current))]
            : await promptWorkflows(s, repo, []);
    } else {
      workflows = await promptWorkflows(s, repo, []);
    }
    const sel: RepoSelection = { id, fullName: repo.fullName, workflows };
    if (!key) {
      const since = await promptBackfill(p, repo);
      if (since) sel.backfillSince = since;
    }
    selections.push(sel);
  }

  const next = applyRepoSelections(s.config, selections);
  const diff = diffConfigs(existing, next, { seed });
  if (isEmptyDiff(diff)) {
    p.outro('No changes.');
    return EXIT.OK;
  }
  p.note(formatDiff(diff).join('\n'), 'Changes');
  const check = validateConfig(next);
  if (!check.ok) throw new CliError(`These changes would make the config invalid:\n${formatIssues(check.errors)}`);
  if (!(await p.confirm({ message: `Save to ${configPath}?`, initialValue: true }))) {
    p.outro('Nothing saved.');
    return EXIT.OK;
  }
  const saved = saveConfig(configPath, next);
  for (const w of saved.warnings) p.warn(`${w.path}: ${w.message}`);
  for (const file of writeStarterPrompts(configPath, next)) p.info(`Wrote starter prompt ${file}`);
  p.outro(`Saved ${configPath}. ${RESTART_REMINDER}`);
  return EXIT.OK;
}
