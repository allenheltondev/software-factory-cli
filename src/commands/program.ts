import { Command, Option } from 'commander';
import { addCommand, type AddOptions } from './add.js';
import { agentsCommand, type AgentsOptions } from './agents.js';
import { nativeClaudeAuthCommand } from './native-claude-auth.js';
import { cancelCommand } from './cancel.js';
import { cleanCommand } from './clean.js';
import { configureCommand } from './configure.js';
import { DEFAULT_LABEL } from './config-edit.js';
import { MissingConfigError } from '../config/io.js';
import { createDefaultContext, legacyNotice, println, type CommandContext, type GlobalOptions } from './context.js';
import { doctorCommand } from './doctor.js';
import { describeError } from './errors.js';
import { logsCommand, type LogsOptions } from './logs.js';
import { publishCommand } from './publish.js';
import { retryCommand } from './retry.js';
import { reviewsCommand, type ReviewsOptions } from './reviews.js';
import { runEventCommand, type RunEventOptions } from './run-event.js';
import { startCommand } from './start.js';
import { stateCopyCommand, stateInfoCommand, stateMergeCommand, type StateMergeOptions } from './state.js';
import { statsCommand, type StatsOptions } from './stats.js';
import { statusCommand } from './status.js';
import { validateCommand } from './validate.js';

export interface Handlers {
  configure(ctx: CommandContext): Promise<number>;
  add(ctx: CommandContext, repo: string, opts: AddOptions): Promise<number>;
  validate(ctx: CommandContext, opts?: { json?: boolean }): Promise<number>;
  start(ctx: CommandContext): Promise<number>;
  runEvent(ctx: CommandContext, opts: RunEventOptions): Promise<number>;
  stateMerge(ctx: CommandContext, opts: StateMergeOptions): Promise<number>;
  stateInfo(ctx: CommandContext, opts: { db: string; json?: boolean }): Promise<number>;
  stateCopy(ctx: CommandContext, opts: { db: string; out: string; json?: boolean }): Promise<number>;
  status(ctx: CommandContext, opts: { json?: boolean }): Promise<number>;
  doctor(ctx: CommandContext, opts: { json?: boolean }): Promise<number>;
  retry(ctx: CommandContext, jobId: string): Promise<number>;
  agents(ctx: CommandContext, opts: AgentsOptions): Promise<number>;
  nativeClaudeAuth(ctx: CommandContext, opts: { json?: boolean }): Promise<number>;
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
  runEvent: (ctx, opts) => runEventCommand(ctx, opts),
  stateMerge: (ctx, opts) => stateMergeCommand(ctx, opts),
  stateInfo: (ctx, opts) => stateInfoCommand(ctx, opts),
  stateCopy: (ctx, opts) => stateCopyCommand(ctx, opts),
  status: statusCommand,
  doctor: (ctx, opts) => doctorCommand(ctx, opts),
  retry: (ctx, jobId) => retryCommand(ctx, jobId),
  agents: agentsCommand,
  nativeClaudeAuth: nativeClaudeAuthCommand,
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
      if (err instanceof MissingConfigError) for (const line of legacyNotice(ctx)) println(ctx.err, line);
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
    .addOption(new Option('--json', 'print one JSON object on stdout: errors, warnings and the validated config with its defaults filled in'))
    .action((o: { json?: boolean }) => exec((ctx) => handlers.validate(ctx, o)));

  program
    .command('start')
    .description('Run the worker: poll GitHub and process the queue (non-interactive)')
    .action(() => exec((ctx) => handlers.start(ctx)));

  program
    .command('run-event')
    .description('Handle one GitHub webhook event to the end, then exit: run its job, verify, publish (no polling; see docs/run-event.md)')
    .requiredOption('--event-file <path>', 'file holding the webhook payload (the JSON body GitHub POSTs)')
    .option('--event-name <name>', 'the X-GitHub-Event header of the delivery', 'issues')
    .option('--delivery-id <id>', 'the X-GitHub-Delivery header, for the logs and the summary')
    .option('--deadline-minutes <n>', 'stop everything, a running agent included, after this many minutes')
    .option('--worker-git-credentials', "fetch with the worker's GitHub credentials even into a clone run-event did not create")
    .option('--retry', "first requeue the event's failed, interrupted or canceled jobs in the state database, as 'updraft retry' does, so this run does them again")
    .option('--shared-state <file>', 'a copy of the shared state database kept fresher than the one this run started from; read before the last look, never written')
    .addOption(new Option('--json', 'print one JSON summary object on stdout'))
    .action((o: RunEventOptions) => exec((ctx) => handlers.runEvent(ctx, o)));

  const state = program.command('state').description('Work with a state database as a file shared between runs (see docs/shared-state.md)');
  state
    .command('merge')
    .description('Apply what one finished run changed in its copy of the state database to the latest shared copy (a three-way merge by key)')
    .requiredOption('--changed <file>', 'the state database the run used')
    .requiredOption('--into <file>', 'the latest shared copy; created when it does not exist')
    .option('--base <file>', 'the snapshot the run started from (omit when it started from nothing)')
    .option('--live', 'the run is still going: read --changed consistently while it is written to, and leave unfinished work as it is (a checkpoint)')
    .addOption(new Option('--json', 'print one JSON object on stdout: per-table counts, schema version, and whether anything changed'))
    .action((o: StateMergeOptions) => exec((ctx) => handlers.stateMerge(ctx, o)));
  state
    .command('info')
    .description('Show the schema version and row counts of a state database file (read-only)')
    .requiredOption('--db <file>', 'the state database file')
    .addOption(new Option('--json', 'machine-readable output'))
    .action((o: { db: string; json?: boolean }) => exec((ctx) => handlers.stateInfo(ctx, o)));
  state
    .command('copy')
    .description('Write a consistent single-file copy of a state database, read through SQLite (safe while a run is writing to it)')
    .requiredOption('--db <file>', 'the state database to copy')
    .requiredOption('--out <file>', 'the file to write; it must not exist')
    .addOption(new Option('--json', 'machine-readable output'))
    .action((o: { db: string; out: string; json?: boolean }) => exec((ctx) => handlers.stateCopy(ctx, o)));

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
    .command('native-claude-auth')
    .description('Read-only native Claude Code subscription sign-in status on a persistent worker (never prints credentials)')
    .addOption(new Option('--json', 'machine-readable fixed state and reason; no account data'))
    .action((o: { json?: boolean }) => exec((ctx) => handlers.nativeClaudeAuth(ctx, o)));

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
    .option('--since <age>', 'window: a number and a unit (h, d, w), "today" (since local midnight), or "all"', '30d')
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
