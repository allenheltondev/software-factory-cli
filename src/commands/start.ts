import { join } from 'node:path';
import { loadConfig } from '../config/io.js';
import type { Db } from '../db/database.js';
import { resolveGitHubToken } from '../github/client.js';
import { checkJobDispatchable, pollOnce } from '../poller/poller.js';
import { createFailureCommenter, failureCommentsEnabled } from '../publish/failure-comment.js';
import { createPublisher, publicationEnabled } from '../publish/publish.js';
import { createLogger, type Logger, type LoggerOptions } from '../util/log.js';
import { runDaemon, type DaemonDeps } from '../worker/daemon.js';
import { createExecutor } from '../worker/prepare-only.js';
import type { CommandContext } from './context.js';
import { EXIT } from './errors.js';

export interface StartDeps {
  runDaemon: (deps: DaemonDeps) => Promise<void>;
  pollOnce: typeof pollOnce;
  checkJobDispatchable: typeof checkJobDispatchable;
  createLogger: (opts: LoggerOptions) => Logger;
  /** Install SIGINT/SIGTERM handlers that call `abort`; returns an uninstaller. */
  onShutdownSignal: (abort: (signal: string) => void) => () => void;
}

export function installSignalHandlers(abort: (signal: string) => void): () => void {
  let received = 0;
  const handler = (signal: NodeJS.Signals) => {
    received++;
    if (received > 1) {
      process.stderr.write(`Received ${signal} again; exiting immediately.\n`);
      process.exit(130);
    }
    abort(signal);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}

export const defaultStartDeps: StartDeps = {
  runDaemon,
  pollOnce,
  checkJobDispatchable,
  createLogger,
  onShutdownSignal: installSignalHandlers,
};

/** `updraft start`: non-interactive worker. Never prompts. */
export async function startCommand(ctx: CommandContext, deps: StartDeps = defaultStartDeps): Promise<number> {
  const { paths } = ctx;
  const { config, warnings } = loadConfig(paths.configFile);
  // The logger only calls write(); ctx.err is process.stderr outside tests.
  const log = deps.createLogger({ stream: ctx.err as NodeJS.WritableStream, file: join(paths.logDir, 'updraft.log') });
  for (const w of warnings) log.warn(`config: ${w.path}: ${w.message}`);
  const repoCount = Object.keys(config.repositories).length;
  if (repoCount === 0) log.warn('no repositories configured; add one with "updraft add OWNER/REPO"');

  const controller = new AbortController();
  const uninstall = deps.onShutdownSignal((signal) => {
    log.info(config.execution.mode === 'live' ? 'shutdown requested; stopping running agents' : 'shutdown requested; finishing current work', { signal });
    controller.abort();
  });

  let db: Db | undefined;
  try {
    db = ctx.openDb(paths.dbFile);
    const api = await ctx.createApi({ log: log.child({ component: 'github' }) });
    log.info('worker starting', {
      config: paths.configFile,
      db: paths.dbFile,
      repos: repoCount,
      mode: config.execution.mode,
      pollIntervalSeconds: config.pollIntervalSeconds,
    });
    const openDb = db;
    const pollLog = log.child({ component: 'poller' });
    await deps.runDaemon({
      db: openDb,
      config,
      paths,
      log: log.child({ component: 'worker' }),
      poll: () => deps.pollOnce({ db: openDb, api, config, log: pollLog }),
      checkDispatchable: (job) => deps.checkJobDispatchable({ api, config }, job),
      signal: controller.signal,
      executor: createExecutor(config),
      ...(publicationEnabled(config)
        ? {
            publisher: createPublisher({
              db: openDb,
              config,
              paths,
              api,
              log: log.child({ component: 'publish' }),
              token: () => resolveGitHubToken(ctx.env),
              env: ctx.env,
            }),
          }
        : {}),
      ...(failureCommentsEnabled(config)
        ? { failureCommenter: createFailureCommenter({ db: openDb, config, paths, api, log: log.child({ component: 'failure-comment' }) }) }
        : {}),
    });
    log.info('worker stopped');
    return EXIT.OK;
  } finally {
    uninstall();
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}
