// `updraft state merge`: carry what ONE finished run changed in its own copy of the state database
// into the latest shared copy. docs/shared-state.md is the contract.
//
// Three databases: `changed` (the copy the run used), `base` (the snapshot that copy started
// from; absent when the run started from nothing) and `into` (the latest shared copy, which other
// runs may have changed since the snapshot). A row of `changed` that equals its row in `base` was
// not touched by the run and is never looked at again; every other row is merged into `into` by
// primary key, under the rule of its table (TABLE_RULES). Rows the run did not touch, and rows
// only other runs have, stay exactly as they are in `into`.
//
// Nothing is written to the caller's `into` until the whole merge has succeeded: the work happens
// on a copy next to it, which replaces it in one rename. The result is one self-contained file
// (checkpointed, rollback-journal mode, no -wal or -shm beside it).
//
// `live` is the same merge for a run that has NOT finished (a checkpoint): `changed` is read in
// one read transaction while the run keeps writing to it, and nothing unfinished is settled.
// The final merge of the same run, against the same `base`, then finds its own earlier rows in
// `into` and brings each to its final state under the rule of its table.
import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { foldWriteAheadLog, openDatabase, openDatabaseReadOnly, recordError, SCHEMA_VERSION, schemaVersion, transaction, type Db } from './database.js';
import { HOLD_PREFIX, releasedHoldValue } from './holds.js';
import { noteJobFinished } from './metrics.js';
import { finishRun, releaseClaim } from './queue.js';
import { isReconstructedText, RECONSTRUCTED_WORKER } from './reconstructed.js';

type Value = null | number | bigint | string | Uint8Array;
type Row = Record<string, Value>;

/** What a conflict is resolved to: the row to store, or null to keep the shared copy's row. */
type Resolve = (c: { mine: Row; theirs: Row; base: Row | null }) => Row | null;

interface KeyedRule {
  kind: 'keyed';
  /** The same key changed by this run and, since the snapshot, by another run. */
  conflict: Resolve;
  /** A new row is only inserted when the row it hangs off exists in the shared copy. */
  parent?: { column: string; table: string };
  /** The rule in one line, for docs/shared-state.md and the tests that hold the two together. */
  rule: string;
}

interface AppendRule {
  kind: 'append';
  /** Columns that identify a fact; without them a row is identified by all its columns but the id. */
  unique?: readonly string[];
  rule: string;
}

interface NeverRule {
  kind: 'never';
  rule: string;
}

export type TableRule = KeyedRule | AppendRule | NeverRule;

const mine: Resolve = (c) => c.mine;
const theirs: Resolve = () => null;
const text = (v: Value | undefined): string => (v === null || v === undefined ? '' : String(v));
/** The row whose `column` (an ISO time) is later; this run's on a tie. */
const later =
  (column: string): Resolve =>
  (c) =>
    text(c.mine[column]) >= text(c.theirs[column]) ? c.mine : null;
const maxOf = (a: Value | undefined, b: Value | undefined): Value => {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return a >= b ? a : b;
};

const TERMINAL = new Set(['succeeded', 'failed', 'interrupted', 'canceled']);

/**
 * A finished job is never put back by a run that left it unfinished; otherwise the later change
 * wins. Counters never go down. A reconstructed row (reconstructed.ts) never replaces a finished
 * job that a run recorded.
 */
const jobConflict: Resolve = (c) => {
  const mineDone = TERMINAL.has(text(c.mine.status));
  const theirsDone = TERMINAL.has(text(c.theirs.status));
  const mineRebuilt = isReconstructedText(c.mine.status_reason);
  const theirsRebuilt = isReconstructedText(c.theirs.status_reason);
  let winner = mineDone !== theirsDone ? (mineDone ? c.mine : c.theirs) : text(c.mine.updated_at) >= text(c.theirs.updated_at) ? c.mine : c.theirs;
  if (mineRebuilt !== theirsRebuilt) {
    const recorded = mineRebuilt ? c.theirs : c.mine;
    if (TERMINAL.has(text(recorded.status))) winner = recorded;
  }
  const merged: Row = { ...winner };
  for (const counter of ['attempts', 'retries', 'deferrals', 'escalation_hops']) {
    if (counter in merged) merged[counter] = maxOf(c.mine[counter], c.theirs[counter]);
  }
  return merged;
};

/** Closed and merged are final; between two open rows the later change wins, whole row. */
const pullRequestConflict: Resolve = (c) => {
  const merged = (r: Row) => r.merge_state === 'merged';
  const closed = (r: Row) => r.state === 'closed';
  if (merged(c.mine) !== merged(c.theirs)) return merged(c.mine) ? c.mine : null;
  if (closed(c.mine) !== closed(c.theirs)) return closed(c.mine) ? c.mine : null;
  return text(c.mine.updated_at) >= text(c.theirs.updated_at) ? c.mine : null;
};

/** Neither position ever moves backwards; where the subscription started is kept as first recorded. */
const repoCheckpointConflict: Resolve = (c) => {
  const winner = text(c.mine.updated_at) >= text(c.theirs.updated_at) ? c.mine : c.theirs;
  return {
    ...winner,
    last_event_id: maxOf(c.mine.last_event_id, c.theirs.last_event_id),
    last_event_created_at: maxOf(c.mine.last_event_created_at, c.theirs.last_event_created_at),
    start_event_id: c.theirs.start_event_id ?? null,
    start_created_at: c.theirs.start_created_at ?? null,
    initialized_at: c.theirs.initialized_at ?? null,
  };
};

const reviewCheckpointConflict: Resolve = (c) => {
  const a = text(c.mine.last_updated_at);
  const b = text(c.theirs.last_updated_at);
  if (a !== b) return a > b ? c.mine : null;
  return text(c.mine.updated_at) >= text(c.theirs.updated_at) ? c.mine : null;
};

const RUN_FACT = 'keyed by the run id, which only one run ever writes: this run\'s row wins';
const REBUILT_LOSES = '. A reconstructed row never replaces a recorded one';
/** This run's row wins, unless it is a reconstructed row and the shared copy has the recorded one. */
const recordedOverRebuilt =
  (rebuilt: (r: Row) => boolean): Resolve =>
  (c) =>
    rebuilt(c.mine) && !rebuilt(c.theirs) ? null : c.mine;

/**
 * How each table of the state database is merged, in the order they are merged (a row's parent
 * first). Every table must be listed: a table without a rule makes the merge refuse to run, and
 * src/db/merge.test.ts fails when a migration adds one without adding it here.
 */
export const TABLE_RULES: Readonly<Record<string, TableRule>> = {
  jobs: {
    kind: 'keyed',
    conflict: jobConflict,
    rule:
      'a finished job beats an unfinished one, otherwise the later updated_at wins (this run on a tie); attempts, retries, deferrals and ' +
      'escalation_hops take the larger value. A job the shared copy pruned is not brought back. A job whose dedupe key (repository, workflow, ' +
      'event) the shared copy already has under another id is folded into that job. A reconstructed row never replaces a finished job a run recorded',
  },
  runs: { kind: 'keyed', conflict: recordedOverRebuilt((r) => r.worker_id === RECONSTRUCTED_WORKER), parent: { column: 'job_id', table: 'jobs' }, rule: RUN_FACT + REBUILT_LOSES },
  publications: { kind: 'keyed', conflict: recordedOverRebuilt((r) => isReconstructedText(r.error)), parent: { column: 'run_id', table: 'runs' }, rule: RUN_FACT + REBUILT_LOSES },
  failure_comments: { kind: 'keyed', conflict: mine, parent: { column: 'run_id', table: 'runs' }, rule: RUN_FACT },
  revisions: { kind: 'keyed', conflict: mine, parent: { column: 'run_id', table: 'runs' }, rule: RUN_FACT },
  pr_reviews: { kind: 'keyed', conflict: mine, parent: { column: 'run_id', table: 'runs' }, rule: RUN_FACT },
  revision_prs: {
    kind: 'keyed',
    conflict: pullRequestConflict,
    rule: 'a merged row beats an unmerged one and a closed row an open one; between two open rows the later updated_at wins, as a whole row',
  },
  review_requests: { kind: 'keyed', conflict: theirs, rule: 'the decision recorded first stands: the shared copy\'s row is kept' },
  pruned_events: { kind: 'keyed', conflict: theirs, rule: 'tombstones are only ever added; an existing one is kept as it is' },
  triage_cache: {
    kind: 'keyed',
    conflict: (c) => (c.mine.outcome !== c.theirs.outcome ? (c.mine.outcome === 'ok' ? c.mine : null) : later('created_at')(c)),
    rule: 'an answer beats a recorded failure; otherwise the later created_at wins',
  },
  capacity_cooldowns: { kind: 'keyed', conflict: later('until'), rule: 'the later expiry (until) wins' },
  publish_settings: { kind: 'keyed', conflict: later('updated_at'), rule: 'the later updated_at wins' },
  meta: { kind: 'keyed', conflict: mine, rule: 'last writer wins: this run\'s value' },
  pool_cursors: { kind: 'keyed', conflict: mine, rule: 'last writer wins: this run\'s position' },
  repo_checkpoints: {
    kind: 'keyed',
    conflict: repoCheckpointConflict,
    rule: 'the further position wins: last_event_id and last_event_created_at take the larger value, the rest comes from the later updated_at; the subscription start is never changed',
  },
  review_checkpoints: { kind: 'keyed', conflict: reviewCheckpointConflict, rule: 'the later last_updated_at wins, then the later updated_at' },
  errors: { kind: 'append', rule: 'rows the run added are appended under new ids' },
  metric_events: {
    kind: 'append',
    unique: ['kind', 'subject_id'],
    rule: 'rows the run added are appended under new ids; a fact (kind, subject_id) the shared copy already has is kept as recorded first',
  },
  policy_events: { kind: 'append', rule: 'rows the run added are appended under new ids' },
  triage_runs: { kind: 'append', rule: 'rows the run added are appended under new ids' },
  worker_lock: { kind: 'never', rule: 'never carried over: a lock belongs to one process on one machine' },
};

/** Columns that hold a job id, in any table: rewritten when a job was folded into another (see the jobs rule). */
const JOB_ID_COLUMNS = ['job_id', 'revision_job_id'];

/** Rows that record a step towards GitHub with a lease: what a run that ended mid-step leaves behind. */
const LEASED_TABLES: ReadonlyArray<{ table: string; busy: string; retryLater: boolean }> = [
  // The commits to push exist only in the clone of the machine that made them.
  { table: 'publications', busy: 'publishing', retryLater: false },
  { table: 'revisions', busy: 'publishing', retryLater: false },
  // These are posted from the database alone, so a later run of the same event can still post them.
  { table: 'pr_reviews', busy: 'publishing', retryLater: true },
  { table: 'failure_comments', busy: 'posting', retryLater: true },
];

export interface TableCounts {
  /** Rows the shared copy did not have. */
  inserted: number;
  /** Rows the shared copy had, replaced by this run's version (or by the resolution of a conflict). */
  updated: number;
  /** Rows added to an append-only table under a new id. */
  appended: number;
  /** Keys changed by this run and by another since the snapshot, resolved by the table's rule. */
  conflicts: number;
  /** Rows of this run left out: their job was pruned or deleted in the shared copy meanwhile. */
  dropped: number;
}

export interface MergeResult {
  /** False when the run changed nothing the shared copy does not already have: `into` was not rewritten. */
  changed: boolean;
  /** The schema version of `into` as it is now. */
  schemaVersion: number;
  /** True when `into` did not exist and was created. */
  created: boolean;
  /** The schema version `into` was migrated from, when it was older than this CLI's. */
  migratedFrom: number | null;
  tables: Record<string, TableCounts>;
  totals: TableCounts;
  /** Work this run left unfinished, as the shared copy now records it. */
  unfinished: {
    /** Runs that had started: closed as interrupted, their job `interrupted`. */
    runsInterrupted: number;
    /** Runs claimed but never started: closed without an outcome, their job back to `queued`. */
    runsReleased: number;
    /** Jobs left `running` with no open run: now `interrupted`. */
    jobsInterrupted: number;
    /** Publications, revision pushes, review postings and failure comments that were mid-step. */
    stepsClosed: number;
    /** Holds of the run (holds.ts) that it did not release itself. */
    holdsReleased: number;
  };
  /** Jobs of this run folded into the job the shared copy already had for the same event: this run's id to the kept id. */
  jobsFolded: Record<string, string>;
}

/** `into` (or a source) was written by a newer CLI than this one. Nothing was changed. */
export class SchemaTooNewError extends Error {
  constructor(
    readonly file: string,
    readonly version: number,
  ) {
    super(
      `${file} is at state schema v${version}, newer than this CLI supports (v${SCHEMA_VERSION}); nothing was changed. ` +
        'Run the merge with a newer updraft.',
    );
    this.name = 'SchemaTooNewError';
  }
}

/** The merge cannot run as asked (a missing file, the same file twice, a table without a rule). Nothing was changed. */
export class MergeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeInputError';
  }
}

const zero = (): TableCounts => ({ inserted: 0, updated: 0, appended: 0, conflicts: 0, dropped: 0 });
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

function sameRow(a: Row, b: Row, columns: readonly string[]): boolean {
  return columns.every((c) => {
    const x = a[c] ?? null;
    const y = b[c] ?? null;
    if (x instanceof Uint8Array && y instanceof Uint8Array) return x.length === y.length && x.every((v, i) => v === y[i]);
    return x === y;
  });
}

/** User tables of a state database, by name. */
export function listTables(db: Db): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
}

interface TableInfo {
  columns: string[];
  /** Primary key columns, in key order. */
  key: string[];
}

function tableInfo(db: Db, table: string): TableInfo {
  const rows = db.prepare(`PRAGMA table_info(${q(table)})`).all() as Array<{ name: string; pk: number }>;
  return { columns: rows.map((r) => r.name), key: rows.filter((r) => r.pk > 0).sort((a, b) => a.pk - b.pk).map((r) => r.name) };
}

const sidecars = (file: string) => [`${file}-wal`, `${file}-shm`, `${file}-journal`];

function removeQuietly(file: string): void {
  try {
    rmSync(file, { force: true, recursive: true });
  } catch {
    // a leftover temporary file is not worth failing for
  }
}

/** The schema version of a database file, read without changing it. */
function versionOf(file: string): number {
  const db = openDatabaseReadOnly(file);
  try {
    return schemaVersion(db);
  } finally {
    db.close();
  }
}

/**
 * Open a source database (`changed` or `base`) for reading at this CLI's schema version. One that
 * is older is copied aside and the copy migrated: the caller's file is never written.
 */
function openSource(file: string, role: string, scratch: () => string, live = false): Db {
  if (!existsSync(file)) throw new MergeInputError(`${role} ${file} does not exist`);
  let version: number;
  try {
    version = versionOf(file);
  } catch (err) {
    throw new MergeInputError(`${role} ${file} is not a readable state database: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (version > SCHEMA_VERSION) throw new SchemaTooNewError(file, version);
  if (version === SCHEMA_VERSION) return openDatabaseReadOnly(file);
  const copy = join(scratch(), `${role.replace(/[^a-z]/gi, '')}.db`);
  if (live) {
    // Another process may be writing (or migrating) the file right now: never copy it raw.
    copyState(file, copy);
    return openDatabase(copy);
  }
  copyFileSync(file, copy);
  // Commits a killed process left in the write-ahead log belong to the database.
  if (existsSync(`${file}-wal`)) copyFileSync(`${file}-wal`, `${copy}-wal`);
  return openDatabase(copy);
}

export interface MergeOptions {
  /** The database the run used. */
  changed: string;
  /** The latest shared copy; created when missing. */
  into: string;
  /** The snapshot the run started from. Omit when it started from nothing. */
  base?: string;
  /**
   * `changed` belongs to a run that is still going (a checkpoint). It is read in one read
   * transaction, through SQLite, so that what is merged is one consistent state of it; its
   * files are left exactly as they are; and nothing the run has in flight is settled: open runs,
   * running jobs and steps towards GitHub are carried as they are.
   */
  live?: boolean;
  now?: () => number;
}

/**
 * A consistent copy of a state database in one file, made through SQLite (VACUUM INTO), so it is
 * safe while another process writes to `file`: the copy is the database as of one moment, with
 * every row under the id it has, and no -wal or -shm beside it. `out` must not exist.
 */
export function copyState(file: string, out: string): { bytes: number; schemaVersion: number } {
  const from = resolve(file);
  const to = resolve(out);
  if (!existsSync(from)) throw new MergeInputError(`--db ${from} does not exist`);
  if (existsSync(to)) throw new MergeInputError(`--out ${to} exists already; the copy is never written over a file`);
  let db: Db;
  try {
    db = openDatabaseReadOnly(from);
  } catch (err) {
    throw new MergeInputError(`--db ${from} is not a readable state database: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const version = schemaVersion(db);
    db.prepare('VACUUM INTO ?').run(to);
    return { bytes: statSync(to).size, schemaVersion: version };
  } catch (err) {
    removeQuietly(to);
    throw err;
  } finally {
    db.close();
  }
}

/**
 * Merge what a finished run changed into the shared copy. Throws SchemaTooNewError,
 * MergeInputError, or whatever SQLite reports; in every case `into` is as it was.
 */
export function mergeState(opts: MergeOptions): MergeResult {
  const now = opts.now ?? Date.now;
  const changedFile = resolve(opts.changed);
  const intoFile = resolve(opts.into);
  const baseFile = opts.base !== undefined ? resolve(opts.base) : null;
  if (changedFile === intoFile || baseFile === intoFile) throw new MergeInputError('--into must be a different file from --changed and --base');
  if (baseFile === changedFile) throw new MergeInputError('--base and --changed are the same file: the snapshot must be a copy taken before the run');

  const created = !existsSync(intoFile);
  let migratedFrom: number | null = null;
  // Reading a database in write-ahead-log mode leaves empty -wal and -shm files beside it. The
  // caller hands over single files and gets single files back: whatever was not there is removed.
  // Not those of a database a run is still using: they are part of it, whenever they appeared.
  const callerFiles = [...(opts.live ? [] : [changedFile]), intoFile, ...(baseFile ? [baseFile] : [])];
  const preexisting = new Set(callerFiles.flatMap(sidecars).filter((f) => existsSync(f)));
  const tidy = () => {
    for (const f of callerFiles.flatMap(sidecars)) if (!preexisting.has(f)) removeQuietly(f);
  };
  if (!created) {
    let version: number;
    try {
      version = versionOf(intoFile);
    } catch (err) {
      throw new MergeInputError(`--into ${intoFile} is not a readable state database: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (version > SCHEMA_VERSION) {
      tidy();
      throw new SchemaTooNewError(intoFile, version);
    }
    if (version < SCHEMA_VERSION) migratedFrom = version;
  }

  let scratchDir: string | null = null;
  const scratch = () => (scratchDir ??= mkdtempSync(join(tmpdir(), 'updraft-merge-')));
  const work = join(dirname(intoFile), `.${basename(intoFile)}.merging-${process.pid}-${now().toString(36)}`);
  const open: Db[] = [];
  const closeAll = () => {
    for (const db of open.splice(0)) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
  };
  try {
    const changed = openSource(changedFile, '--changed', scratch, opts.live === true);
    open.push(changed);
    const base = baseFile ? openSource(baseFile, '--base', scratch) : null;
    if (base) open.push(base);

    if (!created) {
      // A shared copy that arrived with a write-ahead log beside it: fold the log in first, so the one file is all of it.
      if (existsSync(`${intoFile}-wal`) && statSync(`${intoFile}-wal`).size > 0) {
        foldWriteAheadLog(intoFile);
      }
      copyFileSync(intoFile, work);
    }
    const into = openDatabase(work);
    open.push(into);

    const result = mergeInto({ changed, base, into, now, ...(opts.live ? { live: true } : {}) });
    result.created = created;
    result.migratedFrom = migratedFrom;

    const broken = into.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) throw new Error(`the merge would leave ${broken.length} row(s) pointing at a row that does not exist; nothing was changed`);

    if (!result.changed && !created) {
      // Nothing to add: the caller's file stays byte for byte what it was.
      result.schemaVersion = migratedFrom ?? SCHEMA_VERSION;
      return result;
    }
    // One self-contained file: everything in the main file, and no write-ahead log to go with it.
    into.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    into.exec('PRAGMA journal_mode = DELETE');
    result.schemaVersion = schemaVersion(into);
    closeAll();
    for (const s of sidecars(work)) removeQuietly(s);
    // Sidecars of the file being replaced would be read as belonging to the new one.
    for (const s of sidecars(intoFile)) rmSync(s, { force: true });
    renameSync(work, intoFile);
    return result;
  } finally {
    closeAll();
    removeQuietly(work);
    for (const s of sidecars(work)) removeQuietly(s);
    if (scratchDir) removeQuietly(scratchDir);
    tidy();
  }
}

/**
 * The merge itself, on open databases: `changed` and `base` are read, `into` is written. Exported
 * for tests; mergeState is what makes it safe for the caller's file.
 */
export function mergeInto(dbs: { changed: Db; base: Db | null; into: Db; now?: () => number; live?: boolean }): MergeResult {
  const { changed } = dbs;
  if (!dbs.live) return mergeRows(dbs);
  // One read transaction for everything read from a database that is being written to: in
  // write-ahead-log mode that is one consistent state of it, however long the merge takes.
  changed.exec('BEGIN');
  try {
    return mergeRows(dbs);
  } finally {
    try {
      changed.exec('ROLLBACK');
    } catch {
      // the transaction ended with the error that brought us here
    }
  }
}

function mergeRows(dbs: { changed: Db; base: Db | null; into: Db; now?: () => number; live?: boolean }): MergeResult {
  const { changed, base, into } = dbs;
  const now = dbs.now ?? Date.now;
  const tables = listTables(changed);
  const unknown = tables.filter((t) => !Object.hasOwn(TABLE_RULES, t));
  if (unknown.length) {
    throw new MergeInputError(`no merge rule for table(s) ${unknown.join(', ')}: this CLI does not know how to merge them, so nothing was changed`);
  }
  const intoTables = new Set(listTables(into));
  const baseTables = new Set(base ? listTables(base) : []);

  const counts: Record<string, TableCounts> = {};
  const folded = new Map<string, string>();
  /** Runs and run-keyed rows this merge wrote: the ones whose unfinished state is this run's to settle. */
  const carriedRuns = new Set<string>();
  const carriedJobs = new Set<string>();
  const carriedSteps = new Map<string, Set<string>>();
  const carriedHolds = new Set<string>();

  transaction(into, () => {
    for (const [table, rule] of Object.entries(TABLE_RULES)) {
      if (rule.kind === 'never' || !tables.includes(table)) continue;
      if (!intoTables.has(table)) throw new MergeInputError(`the shared copy has no table ${table} although it is at the same schema version`);
      const info = tableInfo(changed, table);
      const c = (counts[table] = zero());
      const baseHas = baseTables.has(table);
      const insert = into.prepare(`INSERT INTO ${q(table)} (${info.columns.map(q).join(', ')}) VALUES (${info.columns.map(() => '?').join(', ')})`);
      const values = (row: Row, columns: readonly string[]) => columns.map((col) => row[col] ?? null);
      const fold = (row: Row): Row => {
        let out = row;
        for (const col of JOB_ID_COLUMNS) {
          const to = typeof row[col] === 'string' ? folded.get(row[col] as string) : undefined;
          if (to !== undefined) out = { ...out, [col]: to };
        }
        return out;
      };

      if (rule.kind === 'append') {
        const data = info.columns.filter((col) => !info.key.includes(col));
        const inBase = baseHas ? base!.prepare(`SELECT 1 AS x FROM ${q(table)} WHERE ${info.key.map((k) => `${q(k)} = ?`).join(' AND ')}`) : null;
        const identity = rule.unique ?? data;
        const exists = into.prepare(`SELECT 1 AS x FROM ${q(table)} WHERE ${identity.map((col) => `${q(col)} IS ?`).join(' AND ')} LIMIT 1`);
        const append = into.prepare(`INSERT INTO ${q(table)} (${data.map(q).join(', ')}) VALUES (${data.map(() => '?').join(', ')})`);
        for (const raw of changed.prepare(`SELECT * FROM ${q(table)} ORDER BY ${info.key.map(q).join(', ')}`).iterate() as Iterable<Row>) {
          if (inBase?.get(...values(raw, info.key))) continue;
          const row = fold(raw);
          if (exists.get(...values(row, identity))) {
            // Recorded already: the same merge applied twice, or (with a unique key) the same fact noted by another run.
            if (rule.unique) c.conflicts++;
            continue;
          }
          append.run(...values(row, data));
          c.appended++;
        }
        continue;
      }

      if (info.key.length === 0) throw new MergeInputError(`table ${table} has no primary key to merge by`);
      const where = info.key.map((k) => `${q(k)} = ?`).join(' AND ');
      const getBase = baseHas ? base!.prepare(`SELECT * FROM ${q(table)} WHERE ${where}`) : null;
      const getInto = into.prepare(`SELECT * FROM ${q(table)} WHERE ${where}`);
      const nonKey = info.columns.filter((col) => !info.key.includes(col));
      const update = nonKey.length ? into.prepare(`UPDATE ${q(table)} SET ${nonKey.map((col) => `${q(col)} = ?`).join(', ')} WHERE ${where}`) : null;
      const parentExists = rule.parent ? into.prepare(`SELECT 1 AS x FROM ${q(rule.parent.table)} WHERE id = ?`) : null;
      const noteCarried = (row: Row) => {
        if (table === 'jobs') carriedJobs.add(text(row.id));
        if (table === 'runs') carriedRuns.add(text(row.id));
        if (table === 'meta' && text(row.key).startsWith(HOLD_PREFIX)) carriedHolds.add(text(row.key));
        if (LEASED_TABLES.some((t) => t.table === table)) {
          let set = carriedSteps.get(table);
          if (!set) carriedSteps.set(table, (set = new Set()));
          set.add(text(row.run_id));
        }
      };
      const store = (row: Row, existing: Row) => {
        if (sameRow(row, existing, info.columns)) return;
        update?.run(...values(row, nonKey), ...values(row, info.key));
        c.updated++;
        noteCarried(row);
      };

      for (const raw of changed.prepare(`SELECT * FROM ${q(table)}`).iterate() as Iterable<Row>) {
        const key = values(raw, info.key);
        const before = (getBase?.get(...key) as Row | undefined) ?? null;
        // Not touched by this run: whatever the shared copy says about it stands.
        if (before && sameRow(before, raw, info.columns)) continue;
        let row = fold(raw);
        let existing = (getInto.get(...key) as Row | undefined) ?? null;

        if (!existing && table === 'jobs') {
          const dedupe = [row.repo_id ?? null, row.workflow_id ?? null, row.event_id ?? null];
          if (into.prepare('SELECT 1 AS x FROM pruned_events WHERE repo_id = ? AND workflow_id = ? AND event_id = ?').get(...dedupe)) {
            c.dropped++; // pruned in the shared copy: its tombstone stands
            continue;
          }
          const twin = into.prepare('SELECT * FROM jobs WHERE repo_id = ? AND workflow_id = ? AND event_id = ?').get(...dedupe) as Row | undefined;
          if (twin && !before) {
            // Two runs queued the same event under ids of their own. The shared copy's job keeps
            // the key; this run's runs and records are attached to it.
            folded.set(text(row.id), text(twin.id));
            row = { ...row, id: twin.id ?? null };
            existing = twin;
          }
        }

        if (!existing) {
          if (before) {
            c.dropped++; // deleted in the shared copy since the snapshot: not brought back
            continue;
          }
          if (parentExists && rule.parent && !parentExists.get(row[rule.parent.column] ?? null)) {
            c.dropped++; // its job (or run) was dropped above
            continue;
          }
          insert.run(...values(row, info.columns));
          c.inserted++;
          noteCarried(row);
          continue;
        }
        if (sameRow(existing, row, info.columns)) {
          // Already there (an earlier merge of this run, a checkpoint for one). Still this
          // run's row: what it shows as unfinished is settled below like any other.
          noteCarried(row);
          continue;
        }
        if (before && sameRow(existing, before, info.columns)) {
          store(row, existing); // only this run changed it
          continue;
        }
        c.conflicts++;
        const resolved = rule.conflict({ mine: row, theirs: existing, base: before });
        if (resolved) store(resolved, existing);
      }
    }
  });

  // What the run left unfinished. It has ended, so nothing of it is running any more; the shared
  // copy must not say otherwise, or the work would look taken for ever. Only rows this merge
  // wrote: another run's unfinished work in the shared copy is that run's to settle.
  //
  // Not for a checkpoint (`live`): that run is still going, and its rows say so truthfully. They
  // are carried as they are; its final merge settles whatever it then leaves.
  const unfinished = { runsInterrupted: 0, runsReleased: 0, jobsInterrupted: 0, stepsClosed: 0, holdsReleased: 0 };
  const at = new Date(now()).toISOString();
  if (dbs.live) {
    carriedRuns.clear();
    carriedJobs.clear();
    carriedSteps.clear();
    carriedHolds.clear();
  }
  const openRun = into.prepare('SELECT execution_started_at, pid, container_name FROM runs WHERE id = ? AND ended_at IS NULL');
  for (const runId of carriedRuns) {
    const run = openRun.get(runId) as { execution_started_at: string | null; pid: number | null; container_name: string | null } | undefined;
    if (!run) continue;
    if (run.execution_started_at === null && run.pid === null && run.container_name === null) {
      releaseClaim(into, runId, 'requeued: the process that claimed the run ended before it started', now);
      unfinished.runsReleased++;
    } else {
      finishRun(into, runId, { outcome: 'interrupted', error: 'the process that ran this ended before the run finished; nothing of it is running', now });
      unfinished.runsInterrupted++;
    }
  }
  const stranded = into.prepare("SELECT repo_full_name FROM jobs WHERE id = ? AND status = 'running' AND id NOT IN (SELECT job_id FROM runs WHERE ended_at IS NULL)");
  for (const jobId of carriedJobs) {
    const job = stranded.get(jobId) as { repo_full_name: string } | undefined;
    if (!job) continue;
    const reason = 'the process that ran this job ended while it was marked running';
    transaction(into, () => {
      into.prepare("UPDATE jobs SET status = 'interrupted', status_reason = ?, updated_at = ? WHERE id = ?").run(reason, at, jobId);
      noteJobFinished(into, jobId);
      recordError(into, { scope: 'worker', jobId, repoFullName: job.repo_full_name, message: reason, at });
    });
    unfinished.jobsInterrupted++;
  }
  for (const t of LEASED_TABLES) {
    for (const runId of carriedSteps.get(t.table) ?? []) {
      const note = 'the process doing this ended before it was done';
      const res = t.retryLater
        ? into
            .prepare(
              `UPDATE ${t.table} SET state = 'failed', retryable = 1, lease_expires_at = NULL, next_attempt_at = ?, error = coalesce(error, ?), updated_at = ?
               WHERE run_id = ? AND state = ?`,
            )
            .run(at, note, at, runId, t.busy)
        : into
            .prepare(
              `UPDATE ${t.table} SET state = 'failed', retryable = 0, lease_expires_at = NULL, next_attempt_at = NULL,
                      error = coalesce(error, ?) || '; not retried: the commits exist only on the machine that made them', updated_at = ?
               WHERE run_id = ? AND (state = ? OR (state = 'failed' AND retryable = 1))`,
            )
            .run(note, at, runId, t.busy);
      unfinished.stepsClosed += Number(res.changes);
    }
  }

  for (const key of carriedHolds) {
    const row = into.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    const released = row ? releasedHoldValue(key, row.value, at) : null;
    if (released === null) continue;
    into.prepare('UPDATE meta SET value = ? WHERE key = ?').run(released, key);
    unfinished.holdsReleased++;
  }

  const totals = zero();
  for (const c of Object.values(counts)) for (const k of Object.keys(totals) as Array<keyof TableCounts>) totals[k] += c[k];
  const settled = unfinished.runsInterrupted + unfinished.runsReleased + unfinished.jobsInterrupted + unfinished.stepsClosed + unfinished.holdsReleased;
  return {
    changed: totals.inserted + totals.updated + totals.appended + settled > 0,
    schemaVersion: schemaVersion(into),
    created: false,
    migratedFrom: null,
    tables: counts,
    totals,
    unfinished,
    jobsFolded: Object.fromEntries(folded),
  };
}

export interface StateInfo {
  file: string;
  schemaVersion: number;
  /** The newest schema this CLI can open. */
  supportedSchemaVersion: number;
  /** False when the file is newer than this CLI: no command of it will open the file. */
  compatible: boolean;
  /** Rows per table. */
  tables: Record<string, number>;
  /** Jobs by status. */
  jobs: Record<string, number>;
  /** Runs not closed yet. */
  openRuns: number;
  /** True when the file carries a worker lock. */
  workerLock: boolean;
}

/** What a state database file holds, read without changing it. */
export function stateInfo(file: string): StateInfo {
  const db = openDatabaseReadOnly(file);
  try {
    const version = schemaVersion(db);
    const names = listTables(db);
    const count = (table: string, where = '') => (db.prepare(`SELECT count(*) AS n FROM ${q(table)} ${where}`).get() as { n: number }).n;
    const jobs: Record<string, number> = {};
    if (names.includes('jobs')) {
      for (const r of db.prepare('SELECT status, count(*) AS n FROM jobs GROUP BY status ORDER BY status').all() as Array<{ status: string; n: number }>) jobs[r.status] = r.n;
    }
    return {
      file,
      schemaVersion: version,
      supportedSchemaVersion: SCHEMA_VERSION,
      compatible: version <= SCHEMA_VERSION,
      tables: Object.fromEntries(names.map((t) => [t, count(t)])),
      jobs,
      openRuns: names.includes('runs') ? count('runs', 'WHERE ended_at IS NULL') : 0,
      workerLock: names.includes('worker_lock') ? count('worker_lock') > 0 : false,
    };
  } finally {
    db.close();
  }
}
