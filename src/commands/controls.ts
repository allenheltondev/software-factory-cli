// `updraft controls OWNER/REPO[#N]`: the mention-command history (docs/controls.md) recorded in the
// state database, oldest first. Read-only and local: the database is opened read-only, and neither
// GitHub nor any credentials are touched.
import { existsSync } from 'node:fs';
import { loadConfig } from '../config/io.js';
import { CONTROL_OUTCOMES, listControlCommands, type ControlCommandRecord, type ControlOutcome } from '../db/control.js';
import { SCHEMA_VERSION, schemaVersion, type Db } from '../db/database.js';
import { getLoopPr } from '../db/pr-reviews.js';
import { println, type CommandContext } from './context.js';
import { CliError, EXIT } from './errors.js';

export interface ControlsOptions {
  json?: boolean;
  limit?: string;
  outcome?: string;
}

export const DEFAULT_CONTROLS_LIMIT = 50;
/** Text mode caps a message at this many characters. */
export const CONTROLS_MESSAGE_WIDTH = 80;

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_CONTROLS_LIMIT;
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(n) || n < 1) throw new CliError(`--limit must be a positive whole number, got "${raw}"`, EXIT.USAGE);
  return n;
}

function parseOutcome(raw: string | undefined): ControlOutcome | null {
  if (raw === undefined) return null;
  if (!(CONTROL_OUTCOMES as readonly string[]).includes(raw)) {
    throw new CliError(`--outcome must be one of: ${CONTROL_OUTCOMES.join(', ')}; got "${raw}"`, EXIT.USAGE);
  }
  return raw as ControlOutcome;
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]?|\x9b[0-?]*[ -/]*[@-~]/g;
const LINE_BREAKS = /[\r\n\t\v\f\u0085\u2028\u2029]+/g;
/** C0 and C1 controls, DEL, and bidirectional overrides that could reorder what the terminal shows. */
const CONTROL = /[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** A stored value as one line of plain text: escape sequences and control characters removed. */
export function plainText(value: string): string {
  return value.replace(ANSI, '').replace(LINE_BREAKS, ' ').replace(CONTROL, '').replace(/ {2,}/g, ' ').trim();
}

/** One line of at most `width` characters, with "…" where it was cut. */
export function truncateLine(value: string, width = CONTROLS_MESSAGE_WIDTH): string {
  const line = plainText(value);
  const chars = [...line];
  return chars.length <= width ? line : `${chars.slice(0, width - 1).join('').trimEnd()}…`;
}

export function renderControls(records: readonly ControlCommandRecord[]): string {
  const header = ['RECEIVED', 'ISSUE', 'PR', 'ACTOR', 'COMMAND', 'OUTCOME', 'MESSAGE'];
  const rows = records.map((r) => [
    plainText(r.receivedAt),
    `#${r.issue}`,
    r.pullRequest === null || r.pullRequest === undefined ? '-' : `#${r.pullRequest}`,
    plainText(r.actor) || '-',
    plainText(r.command) || '-',
    plainText(r.outcome),
    truncateLine(r.message ?? ''),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => [...row[i]!].length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c + ' '.repeat(widths[i]! - [...c].length)))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}

function hasTable(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

export async function controlsCommand(ctx: CommandContext, ref: string, opts: ControlsOptions = {}, fileExists: (p: string) => boolean = existsSync): Promise<number> {
  const m = /^([^/\s#]+\/[^/\s#]+)(?:#(\d+))?$/.exec(ref);
  if (!m) throw new CliError(`"${ref}" is not OWNER/REPO or OWNER/REPO#NUMBER`);
  const limit = parseLimit(opts.limit);
  const outcome = parseOutcome(opts.outcome);
  if (!fileExists(ctx.paths.dbFile)) throw new CliError(`No state database at ${ctx.paths.dbFile}; nothing has run yet.`);
  const { config } = loadConfig(ctx.paths.configFile);
  const entry = Object.entries(config.repositories).find(([name]) => name.toLowerCase() === m[1]!.toLowerCase());
  if (!entry) throw new CliError(`${m[1]} is not a configured repository`);
  const [fullName, cfg] = entry;

  let records: ControlCommandRecord[];
  let issue: number | undefined;
  // Looking must not change anything: opened read-only, so it is neither migrated nor written.
  const db = ctx.openDbReadOnly(ctx.paths.dbFile);
  try {
    const version = schemaVersion(db);
    if (version > SCHEMA_VERSION) {
      throw new CliError(`The state database at ${ctx.paths.dbFile} is at schema v${version}, newer than this CLI supports (v${SCHEMA_VERSION}). Upgrade Updraft to read it.`);
    }
    if (m[2] !== undefined) {
      const n = Number(m[2]);
      // A pull request the review loop knows is its issue's workflow, as for `updraft control`.
      issue = (hasTable(db, 'revision_prs') ? getLoopPr(db, cfg.id, n)?.issueNumber : undefined) ?? n;
    }
    records = listControlCommands(db, cfg.id, issue);
  } finally {
    db.close();
  }
  if (outcome) records = records.filter((r) => r.outcome === outcome);
  // The newest `limit`, still oldest first.
  records = records.slice(Math.max(0, records.length - limit));

  if (opts.json) {
    println(ctx.out, JSON.stringify(records, null, 2));
  } else if (!records.length) {
    const subject = issue === undefined ? fullName : `${fullName}#${issue}`;
    println(ctx.out, `No commands recorded for ${subject}${outcome ? ` with outcome ${outcome}` : ''}.`);
  } else {
    println(ctx.out, renderControls(records));
  }
  return EXIT.OK;
}
