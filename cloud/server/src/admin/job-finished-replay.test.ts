import { ConditionalCheckFailedException, DeleteItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { Caller } from '../caller.js';
import { enrichFinishedJobs } from '../job-finished-lambda.js';
import { EVENT_DETAIL_TYPE, EVENT_SOURCE, type SummaryItem } from '../jobs/job-finished-event.js';
import { createMemoryStore } from '../store/store.js';
import { adminAccess } from './access.js';
import { createAdminService } from './admin.js';
import { dynamoReplayLock } from './job-finished-replay-aws.js';
import { REPLAY_LOCK_MS, createJobFinishedReplay, replayWindow, type ReplayEntry, type ReplayLock, type ReplayPut } from './job-finished-replay.js';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A finished summary as DynamoDB holds it (the same format as a stream image). */
function summary(jobId: string, finishedAt: number, extra: SummaryItem = {}): SummaryItem {
  const createdAt = iso(finishedAt - 600_000);
  return {
    pk: { S: 'TENANT#55' }, sk: { S: `JOB#${createdAt}#${jobId}` }, jobId: { S: jobId },
    repository: { S: 'acme/web' }, createdAt: { S: createdAt }, finishedAt: { S: iso(finishedAt) },
    status: { S: 'finished' }, outcome: { S: 'succeeded' }, issue: { N: '17' }, durationSeconds: { N: '600' },
    configVersion: { N: '3' }, ttl: { N: String(Math.floor((finishedAt + 30 * DAY) / 1000)) },
    detail: { M: {
      updraftOutcome: { S: 'succeeded' }, verificationPassed: { BOOL: true },
      prUrl: { S: 'https://github.com/acme/web/pull/9' }, prNumber: { N: '9' },
      logs: { L: [{ S: 'secret-log-path' }] },
      steps: { L: [{ M: { kind: { S: 'implement' }, model: { S: 'model-1' }, modelSource: { S: 'response' }, usage: { M: { inputTokens: { N: '123' } } } } }] },
    } },
    ...extra,
  };
}

function memoryLock(): ReplayLock & { held: Map<number, number> } {
  const held = new Map<number, number>();
  return {
    held,
    async acquire(id, now, expiresAt) {
      const current = held.get(id);
      if (current !== undefined && current > now) return { ok: false, expiresAt: current };
      held.set(id, expiresAt);
      return { ok: true };
    },
    async release(id, expiresAt) {
      if (held.get(id) === expiresAt) held.delete(id);
    },
  };
}

async function setup({ items = [] as SummaryItem[], put, optIn = true }: { items?: SummaryItem[]; put?: ReplayPut; optIn?: boolean } = {}) {
  const store = createMemoryStore();
  await store.putTenantWithMember(
    { installationId: 55, accountId: 550, accountLogin: 'acme', accountType: 'Organization', status: 'active', createdAt: '2026-11-01T00:00:00.000Z', createdBy: 's' },
    { installationId: 55, sub: 's', role: 'owner', githubUserId: 1, githubLogin: 'pat', addedAt: '' },
  );
  if (optIn) await store.setJobFinishedEvents(55, true);
  const calls: ReplayEntry[][] = [];
  const sent = vi.fn<ReplayPut>(put ?? (async () => ({ FailedEntryCount: 0 })));
  const clock = { now: NOW };
  const lock = memoryLock();
  const replay = createJobFinishedReplay({
    store, stack: 'test', lock, now: () => clock.now, log: () => {},
    summaries: async function* () { yield* items; },
    put: async (entries) => { calls.push(entries); return sent(entries); },
  });
  const app = (caller: Caller) => createApp({
    resolveCaller: () => caller,
    admin: { access: adminAccess('admin'), service: createAdminService({ store, quotas: { concurrentJobs: 1, jobsPerDay: 20, microvmMinutesPerMonth: 1200, platformConcurrentJobs: 20 }, log: () => {} }), replay },
  });
  const admin = app({ sub: 'x', groups: ['admin'] });
  const post = (body: unknown, a = admin, id = 55) => a.request(`/api/v1/admin/tenants/${id}/job-finished-events/replay`, {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  return { store, calls, sent, clock, lock, app, post, replay };
}
const last7 = { since: iso(NOW - 7 * DAY), until: iso(NOW) };
const detailsOf = (calls: ReplayEntry[][]) => calls.flat().map((e) => JSON.parse(e.Detail) as Record<string, unknown>);

describe('replaying Job Finished events', () => {
  it('sends the live path’s detail for the same summary, plus replayed: true', async () => {
    const row = summary('job_same', NOW - DAY);
    const [live] = await enrichFinishedJobs([{ eventName: 'MODIFY', dynamodb: { NewImage: row, OldImage: { status: { S: 'launched' } } } }], 'test', async () => true);
    expect(live).toBeDefined();
    expect(live).not.toHaveProperty('replayed');

    const { post, calls } = await setup({ items: [row] });
    const res = await post(last7);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ replayed: 1, since: last7.since, until: last7.until });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({ Source: EVENT_SOURCE, DetailType: EVENT_DETAIL_TYPE });
    expect(calls[0]![0]).not.toHaveProperty('EventBusName');
    // Exactly the live detail, serialized the same way, with the one additive field.
    expect(calls[0]![0]!.Detail).toBe(JSON.stringify({ ...live, replayed: true }));
    expect(calls[0]![0]!.Detail).not.toContain('secret-log-path');
  });

  it('sends one event per finished job in the window, in batches of at most 10', async () => {
    const inside = Array.from({ length: 23 }, (_, i) => summary(`job_in_${i}`, NOW - DAY - i * 60_000));
    const items = [
      ...inside,
      summary('job_before', NOW - 8 * DAY),
      // The window is [since, until): a finish at `until` belongs to the next one.
      summary('job_at_until', NOW - DAY + 1),
      summary('job_running', NOW - DAY, { status: { S: 'launched' } }),
      summary('job_expired', NOW - 2 * DAY, { ttl: { N: String(Math.floor(NOW / 1000) - 1) } }),
      summary('job_other_tenant', NOW - DAY, { pk: { S: 'TENANT#66' } }),
      { pk: { S: 'TENANT#55' }, sk: { S: 'META' }, status: { S: 'finished' } },
    ];
    const { post, calls } = await setup({ items });
    const res = await post({ since: last7.since, until: iso(NOW - DAY + 1) });
    expect(await res.json()).toMatchObject({ replayed: 23 });
    expect(calls.map((c) => c.length)).toEqual([10, 10, 3]);
    const ids = detailsOf(calls).map((d) => d.jobId);
    expect(ids.sort()).toEqual(inside.map((r) => r.jobId!.S).sort());
    expect(detailsOf(calls).every((d) => d.replayed === true)).toBe(true);
  });

  it('clamps an until in the future to now', async () => {
    const { post } = await setup({ items: [summary('job_a', NOW - DAY)] });
    const res = await post({ since: last7.since, until: iso(NOW + DAY) });
    expect(await res.json()).toEqual({ replayed: 1, since: last7.since, until: iso(NOW) });
  });

  it('refuses a tenant that has not opted in with 409, and gives the lock back', async () => {
    const { post, store, calls } = await setup({ items: [summary('job_a', NOW - DAY)], optIn: false });
    const res = await post(last7);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'not_opted_in', message: expect.stringMatching(/not opted in/) });
    expect(calls).toHaveLength(0);
    // Refused before sending anything: no lock is kept, so a replay right after opting in runs.
    await store.setJobFinishedEvents(55, true);
    expect((await post(last7)).status).toBe(200);
  });

  it('refuses an unknown tenant with 404', async () => {
    const { post } = await setup();
    expect((await post(last7, undefined, 99)).status).toBe(404);
  });

  it.each([
    ['over 30 days', { since: iso(NOW - 30 * DAY - 1), until: iso(NOW) }],
    ['since after until', { since: iso(NOW - DAY), until: iso(NOW - 2 * DAY) }],
    ['since equal to until', { since: iso(NOW - DAY), until: iso(NOW - DAY) }],
    ['since in the future', { since: iso(NOW + DAY), until: iso(NOW + 2 * DAY) }],
    ['a missing since', { until: iso(NOW) }],
    ['a date without a time', { since: '2026-11-20', until: iso(NOW) }],
    ['a time without a zone', { since: '2026-11-20T00:00:00', until: iso(NOW) }],
    ['not a timestamp', { since: 'last week', until: iso(NOW) }],
    ['a number', { since: NOW - DAY, until: NOW }],
    ['an impossible date', { since: '2026-02-31T00:00:00Z', until: iso(NOW) }],
  ])('refuses %s with 400, and gives the lock back', async (_name, body) => {
    const { post, calls } = await setup({ items: [summary('job_a', NOW - DAY)] });
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_window' });
    expect(calls).toHaveLength(0);
    expect((await post(last7)).status).toBe(200);
  });

  it('accepts exactly 30 days', async () => {
    const { post } = await setup();
    expect((await post({ since: iso(NOW - 30 * DAY), until: iso(NOW) })).status).toBe(200);
  });

  it('refuses a body that is not JSON with 400', async () => {
    const { post } = await setup();
    expect((await post('not json')).status).toBe(400);
  });

  it('refuses a non-admin with 403', async () => {
    const { post, app, calls } = await setup({ items: [summary('job_a', NOW - DAY)] });
    const res = await post(last7, app({ sub: 'someone', groups: ['rsc-pro'] }));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('allows one replay per tenant per 15 minutes: a second gets 429 with Retry-After', async () => {
    const { post, clock, calls } = await setup({ items: [summary('job_a', NOW - DAY)] });
    expect((await post(last7)).status).toBe(200);
    clock.now = NOW + 5 * 60_000;
    const res = await post(last7);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(10 * 60));
    expect(await res.json()).toMatchObject({ error: 'replay_rate_limited' });
    expect(calls).toHaveLength(1);
    clock.now = NOW + REPLAY_LOCK_MS;
    expect((await post(last7)).status).toBe(200);
  });

  it('retries only the failed entries of a partial PutEvents failure, once', async () => {
    let call = 0;
    const put: ReplayPut = async (entries) => {
      call++;
      if (call === 1) return { FailedEntryCount: 2, Entries: entries.map((_, i) => (i === 1 || i === 3 ? { ErrorCode: 'ThrottlingException' } : {})) };
      return { FailedEntryCount: 0, Entries: entries.map(() => ({})) };
    };
    const items = Array.from({ length: 5 }, (_, i) => summary(`job_${i}`, NOW - DAY - i));
    const { post, calls } = await setup({ items, put });
    const res = await post(last7);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replayed: 5 });
    expect(calls.map((c) => c.length)).toEqual([5, 2]);
    expect(calls[1]).toEqual([calls[0]![1], calls[0]![3]]);
  });

  it('answers 502 with the counts when entries still fail after the retry, and keeps the lock', async () => {
    const put: ReplayPut = async (entries) => ({ FailedEntryCount: 1, Entries: entries.map((_, i) => (i === 0 ? { ErrorCode: 'InternalFailure' } : {})) });
    const items = Array.from({ length: 12 }, (_, i) => summary(`job_${i}`, NOW - DAY - i));
    const { post, calls, clock } = await setup({ items, put });
    const res = await post(last7);
    expect(res.status).toBe(502);
    // Each batch's first entry failed, and failed again on its one retry.
    expect(await res.json()).toMatchObject({ error: 'replay_incomplete', sent: 10, failed: 2, since: last7.since, until: last7.until });
    expect(calls.map((c) => c.length)).toEqual([10, 1, 2, 1]);
    clock.now = NOW + 60_000;
    expect((await post(last7)).status).toBe(429);
  });

  it('counts a batch whose PutEvents call throws twice as failed', async () => {
    const { post, calls } = await setup({ items: [summary('job_a', NOW - DAY)], put: async () => { throw new Error('network'); } });
    const res = await post(last7);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ sent: 0, failed: 1 });
    expect(calls).toHaveLength(2);
  });
});

describe('the replay window', () => {
  it('normalizes offsets and clamps until', () => {
    expect(replayWindow({ since: '2026-11-20T01:00:00+01:00', until: '2026-12-01T00:00:00Z' }, NOW))
      .toEqual({ since: Date.parse('2026-11-20T00:00:00Z'), until: NOW });
  });
});

describe('the DynamoDB replay lock', () => {
  it('is a conditional put on the tenant’s lock item, refused while an unexpired lock is held', async () => {
    const send = vi.fn(async (_command: unknown): Promise<unknown> => ({}));
    const lock = dynamoReplayLock('T', { send } as never);
    await expect(lock.acquire(55, NOW, NOW + REPLAY_LOCK_MS)).resolves.toEqual({ ok: true });
    const put = send.mock.calls[0]![0] as PutItemCommand;
    expect(put).toBeInstanceOf(PutItemCommand);
    expect(put.input).toMatchObject({
      TableName: 'T',
      Item: { pk: { S: 'TENANT#55' }, sk: { S: 'JOB_FINISHED_REPLAY' }, expiresAt: { N: String(NOW + REPLAY_LOCK_MS) } },
      ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now',
      ExpressionAttributeValues: { ':now': { N: String(NOW) } },
    });

    send.mockRejectedValueOnce(new ConditionalCheckFailedException({ message: 'held', $metadata: {}, Item: { expiresAt: { N: String(NOW + 1000) } } }));
    await expect(lock.acquire(55, NOW, NOW + REPLAY_LOCK_MS)).resolves.toEqual({ ok: false, expiresAt: NOW + 1000 });

    await lock.release(55, NOW + REPLAY_LOCK_MS);
    const del = send.mock.calls[2]![0] as DeleteItemCommand;
    expect(del).toBeInstanceOf(DeleteItemCommand);
    expect(del.input).toMatchObject({ ConditionExpression: 'expiresAt = :mine', ExpressionAttributeValues: { ':mine': { N: String(NOW + REPLAY_LOCK_MS) } } });
    // Another replay's lock is left alone.
    send.mockRejectedValueOnce(new ConditionalCheckFailedException({ message: 'not mine', $metadata: {} }));
    await expect(lock.release(55, 1)).resolves.toBeUndefined();
  });
});
