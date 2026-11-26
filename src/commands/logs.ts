// `updraft logs`: print a run's run.log, optionally following it while the run is in progress.
// Reads only the state database and the log file: no network, and no worker needed.
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Db } from '../db/database.js';
import { getJob, getRun, latestRunOfJob } from '../db/queue.js';
import type { Run } from '../types.js';
import { readWorkerLock, WORKER_STALE_MS } from '../worker/lock.js';
import { println, type CommandContext, type Output } from './context.js';
import { CliError, EXIT } from './errors.js';

export interface LogsOptions {
  /** Keep printing as the log grows; stop once the run is closed and the rest has been printed. */
  follow?: boolean;
  /** Print only the log file's path. */
  path?: boolean;
}

export interface LogsDeps {
  /** How often --follow looks for new output. Default 500 ms. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Stops --follow at its next poll; the command then closes what it opened and returns. */
  signal?: AbortSignal;
}

const describeRun = (run: Run) => (run.endedAt === null ? 'in progress' : (run.outcome ?? (run.cancelRequestedAt ? 'canceled' : 'closed')));

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';

/**
 * Print the file from byte `from` to its current end and return the new offset. The file is
 * opened for each call rather than held open, so following a log never stands in the way of the
 * worker (or `updraft clean`) on Windows. The read is synchronous: a call never yields to the
 * event loop with the file open, and a finished run is printed without waiting on the thread
 * pool. Bytes go through `decoder`, which keeps a multi-byte character that is split across two
 * reads intact.
 */
function printFrom(path: string, from: number, decoder: StringDecoder, out: Output): number {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = from;
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) return position;
      position += bytesRead;
      const text = decoder.write(buffer.subarray(0, bytesRead));
      if (text) out.write(text);
    }
  } finally {
    closeSync(fd);
  }
}

/** Whether a followed run can still write: 'orphaned' is an open run that no live worker owns. */
function followState(db: Db, runId: string, now: () => number): 'open' | 'closed' | 'orphaned' {
  const run = getRun(db, runId);
  if (!run || run.endedAt !== null) return 'closed'; // a missing row was pruned, so it had ended
  const lock = readWorkerLock(db);
  const owned = lock !== null && lock.workerId === run.workerId && now() - Date.parse(lock.heartbeatAt) <= WORKER_STALE_MS;
  return owned ? 'open' : 'orphaned';
}

function missingLog(run: Run, logPath: string): CliError {
  const why =
    run.endedAt === null
      ? 'the run has not written one yet (try --follow)'
      : run.executionStartedAt === null
        ? 'the run was closed before it started, so it never wrote one'
        : 'it has been deleted';
  return new CliError(`run ${run.id} has no log file at ${logPath}: ${why}`);
}

/** A sleep that ends early, without rejecting, once `signal` is aborted. */
function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export async function logsCommand(ctx: CommandContext, id: string, opts: LogsOptions = {}, deps: LogsDeps = {}): Promise<number> {
  if (!existsSync(ctx.paths.dbFile)) {
    throw new CliError(`No state database at ${ctx.paths.dbFile}; there are no runs yet.`);
  }
  const pollMs = deps.pollMs ?? 500;
  const { signal } = deps;
  const sleep = deps.sleep ?? ((ms: number) => abortableSleep(ms, signal));
  const db = ctx.openDb(ctx.paths.dbFile);
  // Closed as soon as the database is no longer needed, and in any case on the way out, so no
  // exit path (an error, an abort, a caller giving up) leaves state.db open: on Windows an open
  // handle keeps the file, and its directory, from being removed.
  let dbOpen = true;
  const closeDb = () => {
    if (!dbOpen) return;
    dbOpen = false;
    db.close();
  };
  try {
    let run = getRun(db, id);
    if (!run) {
      const job = getJob(db, id);
      if (!job) {
        throw new CliError(
          `No run or job with id ${id}. "updraft status" lists recent ones; old ones may have been pruned by "updraft clean --older-than".`,
        );
      }
      run = latestRunOfJob(db, job.id);
      if (!run) throw new CliError(`job ${job.id} is ${job.status} and has no runs yet, so there is no log.`);
      // On stderr, so stdout carries nothing but the log (or the path).
      println(ctx.err, `Job ${job.id}: latest run is ${run.id} (attempt ${run.attempt}, agent ${run.agent}, ${describeRun(run)}).`);
    }
    const logPath = run.logPath ?? join(ctx.paths.runsDir, run.id, 'run.log');

    if (opts.path) {
      println(ctx.out, logPath);
      return EXIT.OK;
    }

    const decoder = new StringDecoder('utf8');
    if (!opts.follow) {
      closeDb();
      try {
        printFrom(logPath, 0, decoder, ctx.out);
      } catch (err) {
        throw isMissing(err) ? missingLog(run, logPath) : err;
      }
      ctx.out.write(decoder.end());
      return EXIT.OK;
    }

    let position = 0;
    let found = false;
    let final = run;
    let state: ReturnType<typeof followState>;
    for (;;) {
      // Read the state first, then the file: output written before the run closed is then
      // certain to be printed by the pass that sees it closed. That first check comes before any
      // wait, so a run that has already finished is printed and returned from at once.
      state = signal?.aborted ? 'closed' : followState(db, run.id, ctx.now);
      if (state !== 'open') {
        // The last pass: nothing more is read from the database.
        final = getRun(db, run.id) ?? run;
        closeDb();
      }
      try {
        position = printFrom(logPath, position, decoder, ctx.out);
        found = true;
      } catch (err) {
        if (!isMissing(err)) throw err; // not written yet: keep waiting while the run is open
      }
      if (state !== 'open') break;
      await sleep(pollMs);
    }
    ctx.out.write(decoder.end());
    if (!found) throw missingLog(final, logPath);
    if (state === 'orphaned') {
      println(
        ctx.err,
        `Run ${run.id} is still marked in progress, but no worker is running, so nothing more will be written. ` +
          'The next "updraft start" closes it.',
      );
    }
    return EXIT.OK;
  } finally {
    closeDb();
  }
}
