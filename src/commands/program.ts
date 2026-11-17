import { Command, Option } from 'commander';
import { addCommand, type AddOptions } from './add.js';
import { configureCommand } from './configure.js';
import { DEFAULT_LABEL } from './config-edit.js';
import { createDefaultContext, println, type CommandContext, type GlobalOptions } from './context.js';
import { doctorCommand } from './doctor.js';
import { describeError } from './errors.js';
import { retryCommand } from './retry.js';
import { startCommand } from './start.js';
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
}

export const defaultHandlers: Handlers = {
  configure: configureCommand,
  add: addCommand,
  validate: validateCommand,
  start: (ctx) => startCommand(ctx),
  status: statusCommand,
  doctor: (ctx, opts) => doctorCommand(ctx, opts),
  retry: (ctx, jobId) => retryCommand(ctx, jobId),
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
    .name('factory')
    .description('Watch GitHub repos and dispatch labeled issues to coding agents')
    .version(opts.version)
    .option('-c, --config <path>', 'config file (default: per-user config location; env FACTORY_CONFIG)')
    .showHelpAfterError('(run "factory --help" for usage)');

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
    .command('retry')
    .description('Requeue a failed, interrupted or canceled job')
    .argument('<jobId>', 'job id (see "factory status")')
    .action((jobId: string) => exec((ctx) => handlers.retry(ctx, jobId)));

  return program;
}
