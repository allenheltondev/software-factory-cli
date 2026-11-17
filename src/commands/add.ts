import { configExists, readRawConfig, saveConfig } from '../config/io.js';
import { writeStarterPrompts } from '../config/prompts.js';
import type { FactoryConfigInput } from '../config/schema.js';
import { validateConfig } from '../config/validate.js';
import { labelEquals } from '../routing.js';
import {
  DEFAULT_ACTION,
  DEFAULT_LABEL,
  DEFAULT_POOL,
  RESTART_REMINDER,
  buildWorkflow,
  diffConfigs,
  formatDiff,
  normalizeBackfillSince,
  parseRoute,
  seedConfig,
  upsertRepoWorkflow,
} from './config-edit.js';
import { println, type CommandContext } from './context.js';
import { CliError, EXIT } from './errors.js';

export interface AddOptions {
  label?: string;
  action?: string;
  pool?: string;
  route?: string[];
  backfillSince?: string;
  workflowId?: string;
}

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** Read the existing config for editing; refuses to edit an invalid one. */
export function loadEditableConfig(path: string): FactoryConfigInput | null {
  if (!configExists(path)) return null;
  const raw = readRawConfig(path);
  const result = validateConfig(raw);
  if (!result.ok) {
    throw new CliError(
      `The config at ${path} is invalid; fix it first ("factory validate" lists the problems).`,
      EXIT.FAILURE,
    );
  }
  return raw as FactoryConfigInput;
}

export async function addCommand(ctx: CommandContext, repoArg: string, opts: AddOptions): Promise<number> {
  if (!REPO_RE.test(repoArg)) throw new CliError(`"${repoArg}" is not OWNER/REPO.`, EXIT.USAGE);
  const label = opts.label ?? DEFAULT_LABEL;
  const action = opts.action ?? DEFAULT_ACTION;
  const pool = opts.pool ?? DEFAULT_POOL;
  let routes;
  try {
    routes = (opts.route ?? []).map(parseRoute);
  } catch (err) {
    throw new CliError((err as Error).message, EXIT.USAGE);
  }
  let backfillSince: string | undefined;
  if (opts.backfillSince !== undefined) {
    backfillSince = normalizeBackfillSince(opts.backfillSince) ?? undefined;
    if (!backfillSince) {
      throw new CliError(`--backfill-since "${opts.backfillSince}" is not a date (use YYYY-MM-DD or ISO 8601).`, EXIT.USAGE);
    }
  }

  const configPath = ctx.paths.configFile;
  const existing = loadEditableConfig(configPath);
  const api = await ctx.createApi();
  const repo = await api.getRepo(repoArg);
  const base = existing ?? seedConfig((await api.getViewer()).login);

  for (const p of [pool, ...routes.map((r) => r.use)]) {
    if (!base.pools[p]) {
      throw new CliError(`Unknown pool "${p}". Known pools: ${Object.keys(base.pools).join(', ') || '(none)'}.`, EXIT.USAGE);
    }
  }
  if (!base.actions[action]) {
    throw new CliError(
      `Unknown action "${action}". Known actions: ${Object.keys(base.actions).join(', ') || '(none)'}.`,
      EXIT.USAGE,
    );
  }

  const workflow = buildWorkflow({ label, action, pool, routes, id: opts.workflowId });
  const { config, replaced, renamedFrom } = upsertRepoWorkflow(
    base,
    { id: repo.id, fullName: repo.fullName },
    workflow,
    backfillSince ? { backfillSince } : {},
  );
  const saved = saveConfig(configPath, config);

  println(ctx.out, `${existing ? 'Updated' : 'Created'} ${configPath}`);
  for (const p of writeStarterPrompts(configPath, config)) println(ctx.out, `  wrote starter prompt ${p}`);
  for (const line of formatDiff(diffConfigs(existing, config))) println(ctx.out, `  ${line}`);
  if (replaced) println(ctx.out, '  (replaced the existing workflow with the same id)');
  if (renamedFrom) println(ctx.out, `  (repo was renamed on GitHub; moved from ${renamedFrom})`);
  if (repo.archived) println(ctx.err, `! ${repo.fullName} is archived; it will not receive new issue events.`);

  // Labels are only read, never created. A missing trigger label is a warning.
  try {
    const labels = await api.listLabels({ id: repo.id, fullName: repo.fullName });
    if (!labels.some((l) => labelEquals(l.name, label))) {
      println(ctx.err, `! Label "${label}" does not exist on ${repo.fullName} yet; create it on GitHub before dispatching.`);
    }
  } catch {
    // Non-fatal: doctor checks labels too.
  }
  for (const w of saved.warnings) println(ctx.err, `! ${w.path}: ${w.message}`);
  println(ctx.out, RESTART_REMINDER);
  return EXIT.OK;
}
