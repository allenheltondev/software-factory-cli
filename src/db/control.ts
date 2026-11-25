// Workflow control state for human steering (#135, docs/controls.md): a pause per workflow (a
// repository's issue, with the pull requests opened for it), and an audit record per command.
//
// Kept in `meta` rows, so the state database needs no new schema and shared copies merge them like
// every other meta row (last writer wins, docs/shared-state.md). A pause is never deleted: resuming
// marks it resumed, so a merge cannot bring back a pause that was lifted, and every command keeps
// its record (who, what, when, on which head, and what came of it).
import type { Db } from './database.js';
import { transaction } from './database.js';
import { nowIso } from '../util/ids.js';

export const CONTROL_PAUSE_PREFIX = 'control:pause:';
export const CONTROL_COMMAND_PREFIX = 'control:command:';
export const CONTROL_CHECKPOINT_PREFIX = 'control:checkpoint:';

/** Why a workflow is held: a `pause`, or a `stop`/`cancel` (resuming those needs maintain). */
export type PauseKind = 'pause' | 'stop' | 'cancel';

export interface WorkflowControlPause {
  state: 'paused' | 'resumed';
  kind: PauseKind;
  by: string;
  at: string;
  reason: string;
  /** The command that made it (a comment id, or `cli-…`). */
  source: string;
  /** Jobs the pause canceled or stopped: what resume puts back. */
  held: string[];
  resumedAt?: string;
  resumedBy?: string;
}

const pauseKey = (repoId: number, issue: number) => `${CONTROL_PAUSE_PREFIX}${repoId}#${issue}`;

function readJson<T>(db: Db, key: string): T | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

function writeJson(db: Db, key: string, value: unknown): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

/** The workflow's pause record (paused or resumed), or null when it was never paused. */
export function getControlPause(db: Db, repoId: number, issue: number): WorkflowControlPause | null {
  const p = readJson<WorkflowControlPause>(db, pauseKey(repoId, issue));
  return p && (p.state === 'paused' || p.state === 'resumed') && Array.isArray(p.held) ? p : null;
}

/** The pause holding the workflow now, or null. */
export function activeControlPause(db: Db, repoId: number, issue: number): WorkflowControlPause | null {
  const p = getControlPause(db, repoId, issue);
  return p?.state === 'paused' ? p : null;
}

/**
 * Pause the workflow. A pause already in place stays (its first author and reason), but a stronger
 * kind replaces a weaker one (a `stop` after a `pause` needs maintain to resume), and newly held
 * jobs are added. Returns the pause now in place and whether it was new.
 */
export function pauseWorkflow(
  db: Db,
  repoId: number,
  issue: number,
  p: { kind: PauseKind; by: string; reason: string; source: string; held: string[] },
  now?: () => number,
): { pause: WorkflowControlPause; created: boolean } {
  return transaction(db, () => {
    const current = activeControlPause(db, repoId, issue);
    const strength = (k: PauseKind) => (k === 'pause' ? 0 : 1);
    const pause: WorkflowControlPause = current
      ? { ...current, kind: strength(p.kind) > strength(current.kind) ? p.kind : current.kind, held: [...new Set([...current.held, ...p.held])] }
      : { state: 'paused', kind: p.kind, by: p.by, at: nowIso(now), reason: p.reason, source: p.source, held: [...new Set(p.held)] };
    writeJson(db, pauseKey(repoId, issue), pause);
    return { pause, created: !current };
  });
}

/** Add jobs the pause canceled (its gate, src/poller/poller.ts) to what resume puts back. */
export function holdUnderPause(db: Db, repoId: number, issue: number, jobId: string): void {
  transaction(db, () => {
    const current = activeControlPause(db, repoId, issue);
    if (current && !current.held.includes(jobId)) writeJson(db, pauseKey(repoId, issue), { ...current, held: [...current.held, jobId] });
  });
}

/**
 * Lift exactly the pause `expected` names (its time and source): a newer pause in the meantime
 * (a stop after the resume was decided) is not lifted. Returns the resumed record, or null.
 */
export function resumeWorkflow(
  db: Db,
  repoId: number,
  issue: number,
  expected: Pick<WorkflowControlPause, 'at' | 'source'>,
  by: string,
  now?: () => number,
): WorkflowControlPause | null {
  return transaction(db, () => {
    const current = activeControlPause(db, repoId, issue);
    if (!current || current.at !== expected.at || current.source !== expected.source) return null;
    const resumed: WorkflowControlPause = { ...current, state: 'resumed', resumedAt: nowIso(now), resumedBy: by };
    writeJson(db, pauseKey(repoId, issue), resumed);
    return resumed;
  });
}

/** One command, as received and as handled: the audit trail. */
export interface ControlCommandRecord {
  /** The comment id (or `cli-…`): one record per command, which is what dedupes redeliveries. */
  source: string;
  repoId: number;
  issue: number;
  pullRequest: number | null;
  actor: string;
  command: string;
  receivedAt: string;
  /** The pull request head the command was judged against, when there was one. */
  headSha: string | null;
  outcome: 'applied' | 'noop' | 'refused' | 'ignored' | 'ambiguous' | 'unsupported';
  message: string;
  /** The reply comment, once posted. */
  replyId?: number;
}

const commandKey = (repoId: number, source: string) => `${CONTROL_COMMAND_PREFIX}${repoId}#${source}`;

export function getControlCommand(db: Db, repoId: number, source: string): ControlCommandRecord | null {
  return readJson<ControlCommandRecord>(db, commandKey(repoId, source));
}

/** Record a command. False, and nothing written, when it was recorded already (a duplicate). */
export function recordControlCommand(db: Db, record: ControlCommandRecord): boolean {
  const res = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING').run(commandKey(record.repoId, record.source), JSON.stringify(record));
  return Number(res.changes) > 0;
}

export function setControlReply(db: Db, repoId: number, source: string, replyId: number): void {
  const current = getControlCommand(db, repoId, source);
  if (current) writeJson(db, commandKey(repoId, source), { ...current, replyId });
}

/** Commands of one workflow, oldest first: its control history. */
export function listControlCommands(db: Db, repoId: number, issue?: number): ControlCommandRecord[] {
  const prefix = `${CONTROL_COMMAND_PREFIX}${repoId}#`;
  const rows = db.prepare('SELECT value FROM meta WHERE substr(key, 1, ?) = ?').all(prefix.length, prefix) as Array<{ value: string }>;
  return rows
    .flatMap((r) => {
      try {
        return [JSON.parse(r.value) as ControlCommandRecord];
      } catch {
        return [];
      }
    })
    .filter((r) => issue === undefined || r.issue === issue)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.source.localeCompare(b.source));
}

/**
 * Where the comment poller is for a repository: `startedAt` is when it first looked (comments
 * older are history, never commands), `since` the newest update time it has read.
 */
export interface ControlCheckpoint {
  startedAt: string;
  since: string;
}

export function getControlCheckpoint(db: Db, repoId: number): ControlCheckpoint | null {
  return readJson<ControlCheckpoint>(db, `${CONTROL_CHECKPOINT_PREFIX}${repoId}`);
}

export function saveControlCheckpoint(db: Db, repoId: number, cp: ControlCheckpoint): void {
  writeJson(db, `${CONTROL_CHECKPOINT_PREFIX}${repoId}`, cp);
}
