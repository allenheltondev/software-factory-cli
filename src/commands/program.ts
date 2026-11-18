import { Command, Option } from 'commander';
import { addCommand, type AddOptions } from './add.js';
import { agentsCommand, type AgentsOptions } from './agents.js';
import { cancelCommand } from './cancel.js';
import { cleanCommand } from './clean.js';
import { configureCommand } from './configure.js';
import { DEFAULT_LABEL } from './config-edit.js';
import { createDefaultContext, println, type CommandContext, type GlobalOptions } from './context.js';
import { doctorCommand } from './doctor.js';
import { describeError } from './errors.js';
import { logsCommand, type LogsOptions } from './logs.js';
import { publishCommand } from './publish.js';
import { retryCommand } from './retry.js';
import { reviewsCommand, type ReviewsOptions } from './reviews.js';
import { startCommand } from './start.js';
import { statsCommand, type StatsOptions } from './stats.js';
import { statusCommand } from './status.js';
import { validateCommand } from './validate.js';

export interface Handlers {
  configure(ctx: CommandContext): Promise<number>;
  add(ctx: CommandContext, repo: string, opts: AddOptions): Promise<number>;
  validate(ctx: CommandContext): Promise<number>;
  start(ctx: CommandContext): Promise<number>;
  status(ctx: CommandContext, opts: { json?: boolean }): Promise<number>;
  doctor(ctx: CommandContext, opts: { json?: boolean }): Promise<number>;
  retry(ctx: CommandContext, jobId: string): Promise<number>;
  agents(ctx: CommandContext, opts: AgentsOptions): Promise<number>;
  clean(ctx: CommandContext, opts: { dryRun?: boolean; olderThan?: string }): Promise<number>;
  publish(ctx: CommandContext, runId: string): Promise<number>;
  reviews(ctx: CommandContext, opts: ReviewsOptions): Promise<number>;
  stats(ctx: CommandContext, opts: StatsOptions): Promise<number>;
  cancel(ctx: CommandContext, jobId: string): Promise<number>;
  logs(ctx: CommandContext, id: string, opts: LogsOptions): Promise<number>;
}

export const defaultHandlers: Handlers = {
  configure: configureCommand,
  add: addCommand,
  validate: validateCommand,
  start: (ctx) => startCommand(ctx),
  status: statusCommand,
  doctor: (ctx, opts) => doctorCommand(ctx, opts),
  retry: (ctx, jobId) => retryCommand(ctx, jobId),
  agents: agentsCommand,
  clean: (ctx, opts) => cleanCommand(ctx, opts),
  publish: (ctx, runId) => publishCommand(ctx, runId),
  reviews: (ctx, opts) => reviewsCommand(ctx, opts),
  stats: (ctx, opts) => statsCommand(ctx, opts),
  cancel: (ctx, jobId) => cancelCommand(ctx, jobId),
  logs: (ctx, id, opts) => logsCommand(ctx, id, opts),
};

export interface ProgramOptions {
  version: string;
  /** Builds the context from global options (e.g. --config). */
  context?: (globals: GlobalOptions) => CommandContext;
  handlers?: Partial<Handlers>;
  setExitCode?: (code: number) => void;
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

export function buildProgram(opts: ProgramOptions): Command {
  const handlers: Handlers = { ...defaultHandlers, ...opts.handlers };
  const makeContext = opts.context ?? createDefaultContext;
  const setExitCode = opts.setExitCode ?? ((code: number) => (process.exitCode = code));

  const program = new Command();
  program
    .name('updraft')
    .description('Watch GitHub repos and dispatch labeled issues to coding agents')
    .version(opts.version)
    .option('-c, --config <path>', 'config file (default: per-user config location; env UPDRAFT_CONFIG)')
    .showHelpAfterError('(run "updraft --help" for usage)');

  /** Run a handler with the global options, mapping errors to friendly messages and exit codes. */
  const exec = async (fn: (ctx: CommandContext) => Promise<number>): Promise<void> => {
    const ctx = makeContext(program.opts<GlobalOptions>());
    try {
      setExitCode(await fn(ctx));
    } catch (err) {
      const { message, exitCode } = describeError(err);
      println(ctx.err, `error: ${message}`);
      setExitCode(exitCode);
    }
  };

  program
    .command('configure')
    .description('Interactively select repos, trigger labels, actions and pools (needs a terminal)')
    .action(() => exec((ctx) => handlers.configure(ctx)));

  program
    .command('add')
    .description('Add or update a repo workflow non-interactively')
    .argument('<repo>', 'OWNER/REPO')
    .option('--label <label>', 'trigger label', DEFAULT_LABEL)
    .option('--action <action>', 'action to run', 'implement-issue')
    .option('--pool <pool>', 'default pool', 'general')
    .option('--route <label=pool>', 'route issues with LABEL to POOL (repeatable)', collect, [])
    .option('--backfill-since <date>', 'enqueue matching events since this date on the first poll (YYYY-MM-DD or ISO 8601)')
    .option('--workflow-id <id>', 'stable workflow id (default ACTION:LABEL)')
    .action((repo: string, o: AddOptions) => exec((ctx) => handlers.add(ctx, repo, o)));

  program
    .command('validate')
    .description('Check the config without network access (exit 1 if invalid)')
    .action(() => exec((ctx) => handlers.validate(ctx)));

  program
    .command('start')
    .description('Run the worker: poll GitHub and process the queue (non-interactive)')
    .action(() => exec((ctx) => handlers.start(ctx)));

  program
    .command('status')
    .description('Show worker state, watched repos, agents, queue and recent errors')
    .addOption(new Option('--json', 'machine-readable output'))
    .action((o: { json?: boolean }) => exec((ctx) => handlers.status(ctx, o)));

  program
    .command('doctor')
    .description('Check Node, config, state, git, gh, GitHub access, labels and agent commands in this environment')
    .addOption(new Option('--json', 'machine-readable output'))
    .action((o: { json?: boolean }) => exec((ctx) => handlers.doctor(ctx, o)));

  program
    .command('agents')
    .description('List coding agents found on this machine: path, version, sign-in and platform support')
    .addOption(new Option('--json', 'machine-readable output'))
    .addOption(new Option('--deep', 'also send one trivial headless prompt to each usable agent (uses tokens)'))
    .action((o: AgentsOptions) => exec((ctx) => handlers.agents(ctx, o)));

  program
    .command('retry')
    .description('Requeue a failed, interrupted or canceled job')
    .argument('<jobId>', 'job id (see "updraft status")')
    .action((jobId: string) => exec((ctx) => handlers.retry(ctx, jobId)));

  program
    .command('cancel')
    .description('Cancel a queued job, or ask the running worker to stop a running one (its worktree is kept)')
    .argument('<jobId>', 'job id (see "updraft status")')
    .action((jobId: string) => exec((ctx) => handlers.cancel(ctx, jobId)));

  program
    .command('logs')
    .description("Print a run's log (run.log); for a job id, the log of its latest run")
    .argument('<id>', 'run id or job id (see "updraft status")')
    .option('-f, --follow', 'keep printing as the log grows; exits when the run has finished')
    .option('--path', 'print only the path of the log file')
    .action((id: string, o: LogsOptions) => exec((ctx) => handlers.logs(ctx, id, o)));

  program
    .command('publish')
    .description('Push the branch of a succeeded live run and open its PR, or finish a failed publication (never duplicates)')
    .argument('<runId>', 'run id (see "updraft status")')
    .action((runId: string) => exec((ctx) => handlers.publish(ctx, runId)));

  program
    .command('reviews')
    .description('Show the review result for the current head of each published PR (read-only; see docs/review-result.md)')
    .addOption(new Option('--json', 'machine-readable output'))
    .option('--limit <n>', 'most recent published PRs to check', '20')
    .action((o: ReviewsOptions) => exec((ctx) => handlers.reviews(ctx, o)));

  program
    .command('stats')
    .description('Show how the factory is doing: work done, time taken, outcomes, reviews and revisions (read-only; see docs/stats.md)')
    .addOption(new Option('--json', 'machine-readable output'))
    .option('--since <age>', 'window: a number and a unit (h, d, w), or "all"', '30d')
    .option('--repo <owner/repo>', 'only this repository')
    .action((o: StatsOptions) => exec((ctx) => handlers.stats(ctx, o)));

  program
    .command('clean')
    .description('Remove worktrees of succeeded or never-started runs; keeps failed/interrupted ones and all branches')
    .option('--dry-run', 'list what would be removed without removing anything')
    .option('--older-than <age>', 'also prune jobs that finished longer ago than this (e.g. 30d, 12h, 2w) with their runs and logs, and old errors')
    .action((o: { dryRun?: boolean; olderThan?: string }) => exec((ctx) => handlers.clean(ctx, o)));

  return program;
}
