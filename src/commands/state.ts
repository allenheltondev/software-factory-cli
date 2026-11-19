// `updraft state merge` and `updraft state info`: the state database as a file that is passed
// between machines (docs/shared-state.md). Neither needs the config, GitHub or a worker.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { mergeState, MergeInputError, SchemaTooNewError, stateInfo, type MergeResult, type StateInfo, type TableCounts } from '../db/merge.js';
import { println, type CommandContext } from './context.js';
import { EXIT } from './errors.js';

export interface StateMergeOptions {
  /** The database the run used. */
  changed: string;
  /** The latest shared copy; created when missing. */
  into: string;
  /** The snapshot the run started from; omitted when it started from nothing. */
  base?: string;
  json?: boolean;
}

/** What `updraft state merge --json` prints on stdout: one object, also when the merge was refused. */
export type StateMergeSummary =
  | (MergeResult & { ok: true; exitCode: number })
  | { ok: false; changed: false; error: string; reason: 'schema-too-new' | 'bad-input' | 'failed'; exitCode: number };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function describeCounts(c: TableCounts): string {
  return [
    c.inserted ? `${c.inserted} inserted` : '',
    c.updated ? `${c.updated} updated` : '',
    c.appended ? `${c.appended} appended` : '',
    c.conflicts ? `${c.conflicts} conflict(s) resolved` : '',
    c.dropped ? `${c.dropped} left out` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * `updraft state merge`: apply what one finished run changed to the latest shared copy.
 * Exit 0: merged (or nothing to merge). 5: `--into` or a source is newer than this CLI. 2: a
 * file is missing or named twice. 1: anything else. In every case but 0, `--into` is untouched.
 */
export async function stateMergeCommand(ctx: CommandContext, opts: StateMergeOptions): Promise<number> {
  let summary: StateMergeSummary;
  try {
    const result = mergeState({ changed: opts.changed, into: opts.into, ...(opts.base !== undefined ? { base: opts.base } : {}), now: ctx.now });
    summary = { ok: true, exitCode: EXIT.OK, ...result };
  } catch (err) {
    const reason = err instanceof SchemaTooNewError ? 'schema-too-new' : err instanceof MergeInputError ? 'bad-input' : 'failed';
    const exitCode = reason === 'schema-too-new' ? EXIT.SCHEMA_TOO_NEW : reason === 'bad-input' ? EXIT.USAGE : EXIT.FAILURE;
    summary = { ok: false, changed: false, error: message(err), reason, exitCode };
  }
  if (opts.json) println(ctx.out, JSON.stringify(summary));
  if (!summary.ok) {
    println(ctx.err, `error: ${summary.error}`);
    return summary.exitCode;
  }
  if (!opts.json) {
    const into = resolve(opts.into);
    if (!summary.changed) {
      println(ctx.out, summary.created ? `Nothing to merge; created ${into} (schema v${summary.schemaVersion}).` : `Nothing to merge; ${into} was not changed.`);
    } else {
      const notes = `${summary.migratedFrom !== null ? `, migrated from v${summary.migratedFrom}` : ''}${summary.created ? ', created' : ''}`;
      println(ctx.out, `Merged into ${into} (schema v${summary.schemaVersion}${notes}).`);
      for (const [table, c] of Object.entries(summary.tables)) {
        const line = describeCounts(c);
        if (line) println(ctx.out, `  ${table}: ${line}`);
      }
      const u = summary.unfinished;
      if (u.runsInterrupted + u.runsReleased + u.jobsInterrupted + u.stepsClosed > 0) {
        println(
          ctx.out,
          `  unfinished work closed: ${u.runsInterrupted} run(s) interrupted, ${u.runsReleased} claim(s) released, ${u.jobsInterrupted} job(s) interrupted, ${u.stepsClosed} step(s) towards GitHub`,
        );
      }
    }
  }
  return EXIT.OK;
}

/** `updraft state info`: schema version and row counts of a state database file. Read-only. */
export async function stateInfoCommand(ctx: CommandContext, opts: { db: string; json?: boolean }): Promise<number> {
  const file = resolve(opts.db);
  if (!existsSync(file)) {
    if (opts.json) println(ctx.out, JSON.stringify({ file, exists: false }));
    println(ctx.err, `error: ${file} does not exist`);
    return EXIT.USAGE;
  }
  let info: StateInfo;
  try {
    info = stateInfo(file);
  } catch (err) {
    if (opts.json) println(ctx.out, JSON.stringify({ file, exists: true, error: message(err) }));
    println(ctx.err, `error: ${file} is not a readable state database: ${message(err)}`);
    return EXIT.FAILURE;
  }
  if (opts.json) {
    println(ctx.out, JSON.stringify({ exists: true, ...info }));
    return EXIT.OK;
  }
  println(ctx.out, info.file);
  println(ctx.out, `  schema v${info.schemaVersion} (this CLI supports up to v${info.supportedSchemaVersion}${info.compatible ? '' : '; too new for this CLI'})`);
  const jobs = Object.entries(info.jobs)
    .map(([status, n]) => `${n} ${status}`)
    .join(', ');
  println(ctx.out, `  jobs: ${jobs || 'none'}; open runs: ${info.openRuns}; worker lock: ${info.workerLock ? 'present' : 'none'}`);
  for (const [table, n] of Object.entries(info.tables)) println(ctx.out, `  ${table}: ${n}`);
  return EXIT.OK;
}
