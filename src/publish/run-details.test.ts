import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import type { Job, Run } from '../types.js';
import { renderAssignmentComment } from './assignment-comment.js';
import { renderIssueComment } from './publish.js';
import { detailLines, runDetails } from './run-details.js';

const job = (complexity?: string): Job => ({ id: 'job_1', envelope: { routing: complexity ? { complexity } : undefined } }) as unknown as Job;
const run = (id: string, agent = 'codex-standard'): Run => ({ id, jobId: 'job_1', agent, pool: 'Workhorses' }) as unknown as Run;

function select(db: ReturnType<typeof openDatabase>, runId: string, model: string | null, source: string) {
  db.prepare(
    `INSERT INTO metric_events (kind, subject_id, at, repo_id, backfilled, recorded_at, model, model_source) VALUES ('run.selected', ?, 'x', 1, 0, 'x', ?, ?)`,
  ).run(runId, model, source);
}

describe('run details', () => {
  it('labels a configured model at assignment and keeps the issue complexity', () => {
    const db = openDatabase(':memory:');
    select(db, 'run_1', 'gpt-5', 'configured');
    const d = runDetails(db, job('standard'), run('run_1'));
    expect(d).toMatchObject({ worker: 'codex-standard', model: 'gpt-5', modelKind: 'configured', complexity: 'standard' });
    const body = renderAssignmentComment({ details: d, jobId: 'job_1', runId: 'run_1', pool: 'Workhorses' });
    expect(body).toContain('| Worker | `codex-standard` |\n| Model (configured) | `gpt-5` |\n| Complexity | `standard` |');
  });

  it('uses observed later, and each run reports its own model with the same job id', () => {
    const db = openDatabase(':memory:');
    select(db, 'run_1', 'gpt-5', 'observed');
    select(db, 'run_2', 'opus', 'configured');
    expect(detailLines(runDetails(db, job('routine'), run('run_1')))[0]).toBe('- **Model (observed)** `gpt-5`');
    expect(detailLines(runDetails(db, job('routine'), run('run_1')), true)[0]).toBe('- **Model (configured)** `gpt-5`');
    const second = runDetails(db, job('routine'), run('run_2', 'claude-deep'));
    expect(second).toMatchObject({ worker: 'claude-deep', model: 'opus', complexity: 'routine' });
  });

  it('falls back to CLI default, Unknown and Not classified; never trusts odd model text', () => {
    const db = openDatabase(':memory:');
    select(db, 'run_1', null, 'unknown');
    select(db, 'run_3', '/etc/secret path', 'configured');
    expect(runDetails(db, job(), run('run_1'))).toMatchObject({ model: 'CLI default', modelKind: null, complexity: 'Not classified' });
    expect(runDetails(db, job(), run('run_2')).model).toBe('Unknown');
    expect(runDetails(db, job(), run('run_3')).model).toBe('CLI default');
  });

  it('adds the details to the publication comment', () => {
    const db = openDatabase(':memory:');
    select(db, 'run_1', 'gpt-5', 'configured');
    const body = renderIssueComment({
      runId: 'run_1',
      pr: { number: 3, htmlUrl: 'https://x/pr/3', draft: false } as never,
      commitCount: 1,
      summary: { diffStat: '1 file' } as never,
      details: runDetails(db, job('complex'), run('run_1')),
    });
    expect(body).toContain('- **Worker** `codex-standard`');
    expect(body).toContain('- **Complexity** `complex`');
  });
});
