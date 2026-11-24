import { describe, expect, it, vi } from 'vitest';
import { enrichFinishedJobs } from './job-finished-lambda.js';
import { stepsOf } from './jobs/lifecycle.js';

const time = '2026-11-24T00:00:00Z';
const row = {
  pk: { S: 'TENANT#42' }, sk: { S: `JOB#${time}#job_example` }, jobId: { S: 'job_example' },
  repository: { S: 'example/repo' }, createdAt: { S: time }, finishedAt: { S: time },
  status: { S: 'finished' }, outcome: { S: 'succeeded' }, issue: { N: '17' },
  detail: { M: { logs: { L: [{ S: 'secret-log-path' }] }, steps: { L: [
    { M: { kind: { S: 'implement' }, model: { S: 'model-1' }, modelSource: { S: 'response' }, usage: { M: { inputTokens: { N: '123' } } } } },
  ] } } },
};
const record = { eventName: 'MODIFY', dynamodb: { NewImage: row, OldImage: { status: { S: 'launched' } } } };

describe('finished job enrichment', () => {
  it.each(['succeeded', 'superseded', 'launch_failed', 'microvm_gone', 'admin_released'])('emits a stored finish with outcome %s independently of who wrote it', async (outcome) => {
    const image = { ...row, outcome: { S: outcome } };
    await expect(enrichFinishedJobs([
      { ...record, dynamodb: { ...record.dynamodb, NewImage: image } },
      { ...record, dynamodb: { NewImage: { ...image, retriedAs: { S: 'job_retry' } }, OldImage: image } },
    ], 'test', async () => true)).resolves.toMatchObject([{ jobId: 'job_example', outcome }]);
  });

  it('emits an opted-in summary transition and excludes private fields', async () => {
    const optedIn = vi.fn(async () => true);
    const events = await enrichFinishedJobs([record], 'test', optedIn);
    expect(optedIn).toHaveBeenCalledWith('42');
    expect(events).toMatchObject([{ schemaVersion: 1, stack: 'test', tenantId: '42', jobId: 'job_example', issue: 17,
      steps: [{ model: 'model-1', modelSource: 'response', usage: { inputTokens: 123 } }],
    }]);
    expect(JSON.stringify(events)).not.toContain('secret-log-path');
  });

  it('suppresses opted-out tenants, later job updates and non-summary records', async () => {
    await expect(enrichFinishedJobs([record], 'test', async () => false)).resolves.toEqual([]);
    const optedIn = vi.fn(async () => true);
    await expect(enrichFinishedJobs([
      { ...record, dynamodb: { ...record.dynamodb, OldImage: row } },
      { ...record, dynamodb: { ...record.dynamodb, NewImage: { ...row, sk: { S: 'META' } } } },
    ], 'test', optedIn)).resolves.toEqual([]);
    expect(optedIn).not.toHaveBeenCalled();
  });
});

it('bounds step metadata while keeping old step shapes', () => {
  expect(stepsOf([{ kind: 'implement' }, {
    kind: 'review', adapter: 'claude', model: 'invalid model', modelSource: 'response',
    effort: 'high', usage: { inputTokens: -1, outputTokens: 0, durationMs: Infinity, costUsd: 100_001, toolCalls: 8 },
  }])).toEqual([
    { kind: 'implement' },
    { kind: 'review', adapter: 'claude', effort: 'high', usage: { outputTokens: 0, toolCalls: 8 } },
  ]);
});
