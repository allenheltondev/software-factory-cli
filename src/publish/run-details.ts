// Worker, model and complexity lines shared by the lifecycle comments on the source issue.
//
// Read from what is already persisted: the run's agent name, the `run.selected` metric row written
// at claim (configured model and its source), and the job's recorded routing complexity. No model
// call, and nothing but those three values reaches the comment: no prompt, path, log or credential.
import type { Db } from '../db/database.js';
import type { Job, Run } from '../types.js';
import { code } from './failure-comment.js';

export interface RunDetails {
  worker: string;
  /** A model name, 'CLI default' or 'Unknown'. */
  model: string;
  /** Whether `model` is a configured value, one the CLI reported, or neither. */
  modelKind: 'configured' | 'observed' | null;
  /** routine | standard | complex, or 'Not classified'. */
  complexity: string;
}

const SAFE_VALUE = /^[A-Za-z0-9._:@+/-]{1,80}$/;
const COMPLEXITIES: readonly string[] = ['routine', 'standard', 'complex'];

/** The details of one run, from persisted data only; tolerant of missing metadata. */
export function runDetails(db: Db, job: Job, run: Run): RunDetails {
  let row: { model: string | null; model_source: string | null } | undefined;
  try {
    row = db.prepare("SELECT model, model_source FROM metric_events WHERE kind = 'run.selected' AND subject_id = ?").get(run.id) as typeof row;
  } catch {
    row = undefined;
  }
  const known = row?.model && SAFE_VALUE.test(row.model) && !row.model.includes('..') ? row.model : null;
  const complexity = job.envelope?.routing?.complexity;
  return {
    worker: run.agent.replace(/[^\w.-]/g, '') || 'unknown',
    model: known ?? (row ? 'CLI default' : 'Unknown'),
    modelKind: known ? (row?.model_source === 'observed' ? 'observed' : 'configured') : null,
    complexity: complexity && COMPLEXITIES.includes(complexity) ? complexity : 'Not classified',
  };
}

/**
 * Bullet lines for the details. At assignment (`assignment`) a known model is always labelled
 * configured: nothing has been observed yet.
 */
export function detailLines(d: RunDetails, assignment = false, plain = false): string[] {
  const kind = assignment ? (d.modelKind ? 'configured' : null) : d.modelKind;
  const label = (t: string) => (plain ? `${t}:` : `**${t}**`);
  return [`- ${label(`Model${kind ? ` (${kind})` : ''}`)} ${code(d.model)}`, `- ${label('Complexity')} ${code(d.complexity)}`];
}
