import { describe, expect, it, vi } from 'vitest';
import { EVENT_DETAIL_TYPE, EVENT_SOURCE, enrichFinishedJobs, publishFinishedJobs } from './job-finished-lambda.js';
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

  it('includes the benchmark arm from the stored summary even when no runner detail exists', async () => {
    const { detail: _detail, ...summary } = row;
    const benchmark = { M: { runId: { S: 'pilot' }, caseId: { S: 'issue-17' }, arm: { S: 'fast' } } };
    const image = { ...summary, outcome: { S: 'launch_failed' }, benchmark };
    await expect(enrichFinishedJobs([{ ...record, dynamodb: { ...record.dynamodb, NewImage: image } }], 'test', async () => true))
      .resolves.toMatchObject([{ outcome: 'launch_failed', benchmark: { runId: 'pilot', caseId: 'issue-17', arm: 'fast' } }]);
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

describe('publishing to the default bus', () => {
  const detail = (jobId: string) => ({ schemaVersion: 1, stack: 'test', tenantId: '42', jobId }) as unknown as Parameters<typeof publishFinishedJobs>[0][number];

  it('puts each finished job as one Job Finished event, at most 10 per call', async () => {
    type Entry = { Source: string; DetailType: string; Detail: string };
    const calls: Entry[][] = [];
    const put = vi.fn(async (entries: Entry[]) => { calls.push(entries); return { FailedEntryCount: 0 }; });
    const details = Array.from({ length: 12 }, (_, i) => detail(`job_${i}`));
    await expect(publishFinishedJobs(details, put)).resolves.toBe(12);
    expect(put).toHaveBeenCalledTimes(2);
    const first = calls[0]!;
    expect(first).toHaveLength(10);
    expect(first[0]).toEqual({ Source: EVENT_SOURCE, DetailType: EVENT_DETAIL_TYPE, Detail: JSON.stringify(details[0]) });
    // No EventBusName: the account's default bus.
    expect(first[0]).not.toHaveProperty('EventBusName');
  });

  it('throws on a rejected entry, so the stream trigger retries the batch', async () => {
    await expect(publishFinishedJobs([detail('job_1')], async () => ({ FailedEntryCount: 1 }))).rejects.toThrow(/rejected 1 of 1/);
  });

  it('puts nothing when no record is a first finish', async () => {
    const put = vi.fn(async () => ({}));
    await expect(publishFinishedJobs([], put)).resolves.toBe(0);
    expect(put).not.toHaveBeenCalled();
  });
});
