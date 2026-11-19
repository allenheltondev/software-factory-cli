import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/io.js';
import type { Db } from '../db/database.js';
import { appCommitIdentity } from '../github/credentials.js';
import { checkJobDispatchable, pollOnce } from '../poller/poller.js';
import { createAssignmentCommenter } from '../publish/assignment-comment.js';
import { createFailureCommenter, failureCommentsEnabled } from '../publish/failure-comment.js';
import { createPublisher, publicationEnabled, type PublishDeps } from '../publish/publish.js';
import { createReviewLoopPublisher, reviewsEnabled } from '../publish/review.js';
import { createRevisionPublisher, revisionsEnabled } from '../publish/revision.js';
import { createLogger, type Logger, type LoggerOptions } from '../util/log.js';
import { isInNpxCache, NPX_START_WARNING } from '../util/npx.js';
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
  /** This CLI's own file, checked for the npx cache (see {@link isInNpxCache}); unset skips the check. */
  cliFile?: string;
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
  cliFile: fileURLToPath(import.meta.url),
};

/** `updraft start`: non-interactive worker. Never prompts. */
export async function startCommand(ctx: CommandContext, deps: StartDeps = defaultStartDeps): Promise<number> {
  const { paths } = ctx;
  const { config, warnings } = loadConfig(paths.configFile);
  // The logger only calls write(); ctx.err is process.stderr outside tests.
  const log = deps.createLogger({ stream: ctx.err as NodeJS.WritableStream, file: join(paths.logDir, 'updraft.log') });
  if (deps.cliFile && isInNpxCache(deps.cliFile)) log.warn(NPX_START_WARNING, { cli: deps.cliFile });
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
    // The gh account, or the GitHub App of github.app: one provider for the API and for pushes.
    const credentials = ctx.createCredentials(config, { log: log.child({ component: 'github' }) });
    const api = await ctx.createApi({ log: log.child({ component: 'github' }), credentials });
    log.info('worker starting', {
      github: credentials.kind === 'app' ? 'GitHub App' : 'gh account',
      config: paths.configFile,
      db: paths.dbFile,
      repos: repoCount,
      mode: config.execution.mode,
      pollIntervalSeconds: config.pollIntervalSeconds,
    });
    const openDb = db;
    const pollLog = log.child({ component: 'poller' });
    const publishDeps = (component: string): PublishDeps => ({
      db: openDb,
      config,
      paths,
      api,
      log: log.child({ component }),
      token: (repoFullName) => credentials.token(repoFullName, { fresh: true }),
      workerKind: credentials.kind,
      env: ctx.env,
    });
    const publication = publicationEnabled(config) ? createPublisher(publishDeps('publish')) : undefined;
    // With the revision loop on, revision runs are pushed to their PR and every other run goes
    // to the publisher as before. With the review loop on, reviewer runs are posted as reviews,
    // and whatever the other two pushed gets a reviewer run.
    const revising = revisionsEnabled(config) ? createRevisionPublisher(publishDeps('revision'), publication) : publication;
    const publisher = reviewsEnabled(config) ? createReviewLoopPublisher(publishDeps('review'), revising) : revising;
    const appAuth = credentials.app;
    await deps.runDaemon({
      db: openDb,
      config,
      paths,
      log: log.child({ component: 'worker' }),
      poll: () => deps.pollOnce({ db: openDb, api, config, log: pollLog, configDir: paths.configDir }),
      checkDispatchable: (job) => deps.checkJobDispatchable({ api, config }, job),
      signal: controller.signal,
      executor: createExecutor(config, appAuth && config.github?.app?.commitAsApp ? { commitIdentity: (repoFullName) => appCommitIdentity(appAuth, repoFullName) } : {}),
      ...(publisher ? { publisher } : {}),
      ...(config.execution.mode === 'live'
        ? { assignmentCommenter: createAssignmentCommenter({ db: openDb, config, api, log: log.child({ component: 'assignment-comment' }) }) }
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
