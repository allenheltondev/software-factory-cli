import { describe, expect, it } from 'vitest';
import { History, MIN } from '../../test/factory-history.js';
import { configSchema, type UpdraftConfig } from '../config/schema.js';
import { openDatabase } from '../db/database.js';
import { getJob, getRun, retryJob } from '../db/queue.js';
import { routeJob } from '../tier-routing.js';
import type { Job, Run, RunSummary } from '../types.js';
import { renderAssignmentComment } from './assignment-comment.js';
import { renderIssueComment } from './publish.js';
import { detailLines, runDetails, selectionLine } from './run-details.js';

const job = (complexity?: string): Job => ({ id: 'job_1', envelope: { routing: complexity ? { rule: 'heuristic', tier: complexity, complexity } : undefined } }) as unknown as Job;
const run = (id: string, agent = 'codex-standard', summary?: Partial<RunSummary>): Run => ({ id, jobId: 'job_1', agent, pool: 'Workhorses', summary }) as unknown as Run;

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
    expect(d).toMatchObject({ worker: 'codex-standard', model: 'gpt-5', modelKind: 'configured', complexity: 'standard', effort: 'CLI default' });
    const body = renderAssignmentComment({ details: d, jobId: 'job_1', runId: 'run_1', pool: 'Workhorses' });
    expect(body).toContain('| Worker | `codex-standard` |\n| Model (configured) | `gpt-5` |\n| Reasoning effort | `CLI default` |');
    expect(body).toContain('| Complexity | `standard` |');
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
    expect(runDetails(db, job(), run('run_1'))).toMatchObject({ model: 'CLI default', modelKind: null, effort: 'CLI default', complexity: 'Not classified (tier routing off)', tier: 'Not applicable (tier routing off)' });
    // No selection recorded at all: nothing is claimed.
    expect(runDetails(db, job(), run('run_2'))).toMatchObject({ model: 'Unknown', effort: 'Unknown', adapter: null, reason: null });
    expect(runDetails(db, job(), run('run_3')).model).toBe('CLI default');
  });

  it('keeps the model the CLI reported apart from the configured one, and only after the run', () => {
    const db = openDatabase(':memory:');
    select(db, 'run_1', 'opus', 'configured');
    const d = runDetails(db, job('complex'), run('run_1', 'claude-deep', { observedModel: 'claude-opus-4-5-20251101' }));
    expect(d).toMatchObject({ model: 'opus', modelKind: 'configured', observedModel: 'claude-opus-4-5-20251101' });
    expect(detailLines(d)).toEqual(expect.arrayContaining(['- **Model (configured)** `opus`', '- **Model (observed)** `claude-opus-4-5-20251101`']));
    // At assignment nothing has been observed: no observed line, even if a value were there.
    expect(detailLines(d, true).join('\n')).not.toContain('observed');
    expect(renderAssignmentComment({ details: d, jobId: 'job_1', runId: 'run_1', pool: 'p' })).not.toContain('observed');
    // An odd reported value is dropped, not shown.
    expect(runDetails(db, job('complex'), run('run_1', 'claude-deep', { observedModel: '../x y' })).observedModel).toBeNull();
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
    expect(body).toContain('- **Capability tier** `Unknown`');
  });
});

// The real path: the router's decision is stored on the job at enqueue, the claim writes the run's
// selection in its own transaction, and the comment reads both back. Nothing is prepopulated.
describe('run details from the routing and claim records', () => {
  const REPO = { repoId: 42, fullName: 'octo/widgets' };
  const config: UpdraftConfig = configSchema.parse({
    version: 1,
    maxConcurrent: 10,
    agents: {
      'claude-fast': { adapter: 'claude', model: 'haiku', effort: 'low', maxConcurrent: 5 },
      'claude-deep': { adapter: 'claude', model: 'opus', effort: 'high', maxConcurrent: 5 },
      'claude-guard': { adapter: 'claude', model: 'opus', effort: 'max', maxConcurrent: 5 },
      codex: { maxConcurrent: 5 },
    },
    pools: { fast: { agents: ['claude-fast'] }, deep: { agents: ['claude-deep'] }, guarded: { agents: ['claude-guard'] }, plain: { agents: ['codex'] } },
    actions: { 'implement-issue': {} },
    dispatch: { allowedActors: ['allen'] },
    repositories: {
      'octo/widgets': {
        id: 42,
        workflows: [
          {
            id: 'wf',
            trigger: { event: 'issue.labeled', label: 'updraft:ready' },
            action: 'implement-issue',
            pool: 'plain',
            tiers: { pools: { routine: 'fast', standard: 'plain', complex: 'deep' }, highRisk: { pool: 'guarded' } },
          },
        ],
      },
    },
  });
  const wf = config.repositories['octo/widgets']!.workflows[0]!;
  const route = (labels: string[], body = 'Some change.') =>
    routeJob(wf.pool, wf.tiers, { title: 'Change', body, labels: ['updraft:ready', ...labels] }, { poolAvailable: () => true });

  function setup() {
    const h = new History(Date.parse('2026-11-18T10:00:00.000Z'));
    h.config = config;
    return h;
  }
  const queue = (h: History, labels: string[]) => {
    const routing = route(labels);
    return h.queueIssue({ ...REPO, issue: 1, pool: routing.pool, routing });
  };
  const details = (h: History, runId: string) => {
    const r = getRun(h.db, runId)!;
    return runDetails(h.db, getJob(h.db, r.jobId)!, r);
  };
  const table = (h: History, runId: string) => renderAssignmentComment({ details: details(h, runId), jobId: getRun(h.db, runId)!.jobId, runId, pool: getRun(h.db, runId)!.pool });

  it('shows the classified complexity, the tier, the profile, its configured model and effort, and why', () => {
    const h = setup();
    queue(h, ['architecture']);
    const { runId } = h.run({});
    expect(details(h, runId)).toMatchObject({
      worker: 'claude-deep',
      adapter: 'claude',
      model: 'opus',
      modelKind: 'configured',
      effort: 'high',
      complexity: 'complex',
      tier: 'complex',
      reason: 'local classifier',
      attempt: null,
    });
    const body = table(h, runId);
    expect(body).toContain(
      [
        '| Status | Assigned |',
        '| Complexity | `complex` |',
        '| Capability tier | `complex` |',
        '| Worker | `claude-deep` |',
        '| Adapter | `claude` |',
        '| Model (configured) | `opus` |',
        '| Reasoning effort | `high` |',
        '| Pool | `deep` |',
        '| Routing reason | local classifier |',
      ].join('\n'),
    );
    expect(body).not.toContain('observed');
  });

  it('does not pretend a label override was a classification', () => {
    const h = setup();
    queue(h, ['tier:routine']);
    const { runId } = h.run({});
    expect(details(h, runId)).toMatchObject({ complexity: 'Not classified (tier set by label)', tier: 'routine', reason: 'tier override label', model: 'haiku', effort: 'low' });
  });

  it('names the high-risk floor', () => {
    const h = setup();
    queue(h, ['security']);
    const { runId } = h.run({});
    expect(details(h, runId)).toMatchObject({ tier: 'high-risk', worker: 'claude-guard', effort: 'max', reason: 'local classifier, low confidence; high-risk floor' });
  });

  it('says the classifier was not confident, with the CLI default for a profile that sets nothing', () => {
    const h = setup();
    queue(h, []);
    const { runId } = h.run({});
    expect(details(h, runId)).toMatchObject({
      tier: 'standard',
      worker: 'codex',
      adapter: 'codex',
      model: 'CLI default',
      modelKind: null,
      effort: 'CLI default',
      reason: 'local classifier, low confidence',
    });
    expect(table(h, runId)).toContain('| Model | `CLI default` |');
  });

  it('reports routing off instead of a classification when the workflow has no tiers', () => {
    const h = setup();
    h.config = configSchema.parse({ ...config, repositories: { 'octo/widgets': { id: 42, workflows: [{ ...wf, tiers: undefined }] } } });
    h.queueIssue({ ...REPO, issue: 1, pool: 'plain' });
    const { runId } = h.run({});
    const body = table(h, runId);
    expect(body).toContain('| Complexity | `Not classified (tier routing off)` |');
    expect(body).toContain('| Capability tier | `Not applicable (tier routing off)` |');
    expect(body).toContain('| Worker | `codex` |');
    expect(body).not.toContain('Routing reason');
  });

  it('an escalation is announced with the tier and model it ran, and the earlier attempt keeps its own', () => {
    const h = setup();
    queue(h, ['docs']);
    const first = h.run({
      outcome: 'failed',
      verify: false,
      handling: { kind: 'escalate', fromTier: 'routine', toTier: 'complex', pool: 'deep', reason: 'verification failed', source: 'verification' },
    });
    const second = h.run({ wait: MIN });
    expect(details(h, first.runId)).toMatchObject({ worker: 'claude-fast', model: 'haiku', tier: 'routine', attempt: null, reason: 'local classifier' });
    expect(details(h, second.runId)).toMatchObject({
      worker: 'claude-deep',
      model: 'opus',
      effort: 'high',
      complexity: 'routine',
      tier: 'complex',
      attempt: 'escalation 1',
      reason: 'local classifier; escalated from routine',
    });
    expect(table(h, second.runId)).toContain('| Status | Assigned |\n| Attempt | escalation 1 |');
  });

  it('a retry is announced as one', () => {
    const h = setup();
    const jobId = queue(h, ['architecture']);
    h.run({ outcome: 'failed', verify: false });
    retryJob(h.db, jobId, h.now);
    const { runId } = h.run({});
    expect(details(h, runId)).toMatchObject({ attempt: 'retry 1', tier: 'complex', model: 'opus' });
  });

  it('a review or revision run has no issue complexity, and the selection line names what ran', () => {
    const h = setup();
    queue(h, ['architecture']);
    const { runId } = h.run({});
    const r = getRun(h.db, runId)!;
    const j = getJob(h.db, r.jobId)!;
    const review = { ...j, envelope: { ...j.envelope, type: 'pull_request.review' as const } };
    const d = runDetails(h.db, review, { ...r, summary: { observedModel: 'claude-opus-4-5' } as RunSummary });
    expect(d).toMatchObject({ complexity: 'Not applicable', tier: 'complex' });
    expect(selectionLine(d)).toBe('Profile `claude-deep` · adapter `claude` · model (configured) `opus` · model (observed) `claude-opus-4-5` · effort `high` · tier `complex`');
  });
});
