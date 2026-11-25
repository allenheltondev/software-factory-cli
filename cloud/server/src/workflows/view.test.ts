import { describe, expect, it } from 'vitest';
import type { JobSummary } from '../store/store.js';
import { LEGACY_WORKFLOW_ID, reconstructWorkflows, totalsOf } from './view.js';
import type { WorkflowEvent } from './workflow.js';

const at = (min: number) => new Date(Date.parse('2026-11-25T12:00:00.000Z') + min * 60_000).toISOString();

describe('workflow totals', () => {
  it('counts each job once, its roles, tokens, cost and time, and says what is estimated or missing', () => {
    const events: WorkflowEvent[] = [
      { id: 'a:started', at: at(0), kind: 'job_started', generation: 1, jobId: 'a', subscription: true },
      {
        id: 'a:finished',
        at: at(10),
        kind: 'job_finished',
        generation: 1,
        jobId: 'a',
        steps: [
          { kind: 'implement', usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.5 } },
          { kind: 'review', usage: { inputTokens: 500, outputTokens: 100 } },
        ],
      },
      // Recorded twice: counted once.
      { id: 'a:finished-again', at: at(11), kind: 'job_finished', generation: 1, jobId: 'a', steps: [{ kind: 'implement', usage: { costUsd: 9 } }] },
      { id: 'b:started', at: at(20), kind: 'job_started', generation: 1, jobId: 'b', retry: true },
      { id: 'b:finished', at: at(25), kind: 'finish_recovered', generation: 1, jobId: 'b', steps: [{ kind: 'revision', usage: { costUsd: 0.25 } }] },
      { id: 'c:started', at: at(30), kind: 'job_started', generation: 1, jobId: 'c' },
    ];
    expect(totalsOf(events, Date.parse(at(40)))).toEqual({
      jobs: 3,
      retries: 1,
      reviews: 1,
      revisions: 1,
      inputTokens: 1500,
      outputTokens: 300,
      costUsd: 0.75,
      stepsWithoutCost: 1,
      subscription: true,
      activeSeconds: 15 * 60,
      wallSeconds: 40 * 60,
      running: true,
    });
  });
});

describe('rebuilt workflows', () => {
  const summary = (over: Partial<JobSummary>): JobSummary => ({ jobId: 'job_x', repository: 'acme/web', createdAt: at(0), status: 'finished', outcome: 'succeeded', deliveryId: 'd', ...over }) as JobSummary;

  it("rebuilds an issue's workflow from its jobs, with its pull request's jobs, and says what it cannot know", () => {
    const out = reconstructWorkflows(55, [
      summary({ jobId: 'job_i1', issue: 7, createdAt: at(0), finishedAt: at(5), detail: { prNumber: 12, loop: { rounds: 0, reviews: 1, stage: 'changes-requested' } } }),
      summary({ jobId: 'job_p1', pullRequest: 12, createdAt: at(10), finishedAt: at(15), outcome: 'failed' }),
      summary({ jobId: 'job_other', pullRequest: 40, createdAt: at(20), status: 'launched', outcome: undefined }),
    ], () => false);
    expect(out).toHaveLength(2);
    const issue = out.find((r) => r.workflow.issue === 7)!;
    expect(issue.workflow).toMatchObject({ reconstructed: true, status: 'blocked', reason: 'job_failed', pullRequest: 12, lastJobId: 'job_p1' });
    expect(issue.workflow.workflowId).toMatch(LEGACY_WORKFLOW_ID);
    expect(issue.workflow.gaps!.length).toBeGreaterThan(0);
    expect(issue.workflow.nextCheckAt).toBeUndefined();
    expect(issue.events.map((e) => [e.kind, e.jobId])).toEqual([
      ['job_started', 'job_i1'],
      ['job_finished', 'job_i1'],
      ['job_started', 'job_p1'],
      ['job_finished', 'job_p1'],
    ]);
    const orphan = out.find((r) => r.workflow.pullRequest === 40 && r.workflow.issue === undefined)!;
    expect(orphan.workflow).toMatchObject({ status: 'active' });
  });

  it('leaves out what a recorded workflow already covers', () => {
    const out = reconstructWorkflows(55, [summary({ jobId: 'job_i1', issue: 7 }), summary({ jobId: 'job_i2', issue: 8 })], (_repo, o) => o.issue === 7);
    expect(out.map((r) => r.workflow.issue)).toEqual([8]);
  });
});
