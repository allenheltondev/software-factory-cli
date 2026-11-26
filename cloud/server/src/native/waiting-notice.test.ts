import { describe, expect, it, vi } from 'vitest';
import type { UpdateCommand, QueryCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { NativeReadiness } from '../jobs/launch.js';
import { waitingComment } from '../jobs/launch.js';
import { createWorkflowRecorder } from '../workflows/recorder.js';
import { createMemoryWorkflowStore } from '../workflows/store.js';
import { createClaudeSessions, type WaitingClaudeJob } from './sessions.js';
import { createWaitingNotifier } from './waiting-notice.js';

const NOW = Date.parse('2026-11-26T01:00:00Z');

/** The waiting records, with the notice claim's conditional semantics. */
function waitingStore(jobs: WaitingClaudeJob[]) {
  const claims: string[] = [];
  return {
    jobs, claims,
    async unnoticed(_id: number, now: number) { return jobs.filter((j) => j.status === 'waiting' && j.expiresAt > now && j.noticeAt === undefined && j.subject); },
    async claimNotice(_id: number, job: string, at: number) {
      const j = jobs.find((x) => x.id === job);
      if (!j || j.status !== 'waiting' || j.noticeAt !== undefined || j.expiresAt <= at) return false;
      j.noticeAt = at; claims.push(job); return true;
    },
    async releaseNotice(_id: number, job: string, at: number) { const j = jobs.find((x) => x.id === job); if (j?.noticeAt === at) delete j.noticeAt; },
  };
}

const parked = (id: string, issue = 12): WaitingClaudeJob => ({
  id, request: { installationId: 55, deliveryId: `delivery-${id}`, eventName: 'issues' }, eventKey: `k/${id}`, expiresAt: NOW + 24 * 3600_000,
  status: 'waiting', subject: { repository: 'acme/web', repositoryId: 9, issue },
});

function harness(jobs: WaitingClaudeJob[]) {
  const sessions = waitingStore(jobs);
  let readiness: NativeReadiness = 'heartbeat-stale';
  let retirement: string | undefined;
  const comments: { issue: number; body: string }[] = [];
  const comment = vi.fn(async (job: WaitingClaudeJob & { subject: NonNullable<WaitingClaudeJob['subject']> }, body: string) => { comments.push({ issue: job.subject.issue, body }); });
  const workflowStore = createMemoryWorkflowStore();
  const notify = createWaitingNotifier({
    tenants: { listTenants: async () => [{ installationId: 55, status: 'active' }, { installationId: 56, status: 'uninstalled' }] as never },
    sessions, consoleOrigin: 'https://console.example', now: () => NOW, log: () => {},
    workflows: createWorkflowRecorder({ store: workflowStore, log: () => {}, now: () => NOW }),
    resolveNative: async () => ({
      route: { installationId: 55, workerId: 'managed-55', microvmId: 'mvm-a', imageVersion: '7', generation: 'g', controlSecretArn: '' },
      secret: async () => 'x', readiness: async () => readiness, retirement: async () => retirement,
    }),
    comment,
  });
  return {
    sessions, comments, comment, workflowStore, notify,
    set(next: NativeReadiness, reason?: string) { readiness = next; retirement = reason; },
  };
}

describe('a parked Claude job whose wait comes to need a sign-in gets one comment then (#176)', () => {
  it('heartbeat-stale (parked silently) -> sealed as worker-lost: one friendly comment and the reason on the timeline', async () => {
    // At park, a heartbeat gap posts nothing.
    expect(waitingComment('https://console.example/x', 'heartbeat-stale')).toBeUndefined();
    const h = harness([parked('job_a')]);
    expect(await h.notify()).toEqual({ tenants: 1, noticed: 0, failed: 0 });
    expect(h.comment).not.toHaveBeenCalled();
    // Cleanup seals the session: dispatch now reads environment-retiring.
    h.set('environment-retiring', 'worker-lost');
    expect(await h.notify()).toMatchObject({ noticed: 1, failed: 0 });
    expect(h.comments).toEqual([{ issue: 12, body:
      'Claude needs you to sign in again because the previous Claude session ended (its worker stopped answering): [sign in from Updraft](https://console.example/installations/55/claude?request=job_a) and this job starts on its own.' }]);
    expect(await h.workflowStore.getWorkflow(55, '9-i12')).toMatchObject({ status: 'waiting', stage: 'awaiting-sign-in', reason: 'reconnect_required' });
    expect(await h.workflowStore.listWorkflowEvents(55, '9-i12', 10)).toContainEqual(expect.objectContaining({ kind: 'waiting', reason: 'claude_session_worker_lost', jobId: 'job_a' }));
    // Never twice.
    expect(await h.notify()).toMatchObject({ noticed: 0 });
    expect(h.comment).toHaveBeenCalledOnce();
  });

  it('worker-starting -> startup-failed: one comment for each waiting job', async () => {
    const h = harness([parked('job_a', 12), parked('job_b', 13)]);
    h.set('worker-starting');
    expect(await h.notify()).toMatchObject({ noticed: 0 });
    h.set('startup-failed');
    expect(await h.notify()).toMatchObject({ noticed: 2 });
    expect(h.comments.map((c) => c.issue)).toEqual([12, 13]);
    expect(h.comments[0]!.body).toMatch(/^Claude needs you to sign in again because the previous Claude session ended \(it never became ready\): \[sign in from Updraft\]/);
    expect(await h.workflowStore.listWorkflowEvents(55, '9-i13', 10)).toContainEqual(expect.objectContaining({ reason: 'claude_startup_failed' }));
  });

  it('a lapsed login (auth-unavailable -> auth-required) asks for a sign-in once', async () => {
    const h = harness([parked('job_a')]);
    h.set('auth-unavailable');
    await h.notify();
    h.set('auth-required');
    await h.notify();
    await h.notify();
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]!.body).toMatch(/^Claude needs you to sign in before this job can start/);
  });

  it('skips a job already commented on at park, and retries a comment that failed', async () => {
    const commented = { ...parked('job_a'), noticeAt: NOW - 60_000 };
    const h = harness([commented, parked('job_b', 13)]);
    h.set('auth-required');
    h.comment.mockRejectedValueOnce(new Error('GitHub down'));
    expect(await h.notify()).toMatchObject({ noticed: 0, failed: 1 });
    expect(h.sessions.jobs[1]!.noticeAt).toBeUndefined();
    expect(await h.notify()).toMatchObject({ noticed: 1, failed: 0 });
    expect(h.comment).toHaveBeenCalledTimes(2);
    expect(h.comments.map((c) => c.issue)).toEqual([13]);
  });
});

describe('the notice claim on the waiting record', () => {
  it('is conditional on a still-waiting job with no notice, and released only by its own claim', async () => {
    const send = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new ConditionalCheckFailedException({ message: 'c', $metadata: {} })).mockResolvedValue({});
    const sessions = createClaudeSessions('table', { send } as unknown as DynamoDBDocumentClient);
    expect(await sessions.claimNotice(55, 'job_a', NOW)).toBe(true);
    expect(await sessions.claimNotice(55, 'job_a', NOW)).toBe(false);
    const claim = send.mock.calls[0]![0] as UpdateCommand;
    expect(claim.input.ConditionExpression).toBe('#status = :waiting AND attribute_not_exists(noticeAt) AND expiresAt > :now');
    await sessions.releaseNotice(55, 'job_a', NOW);
    expect((send.mock.calls[2]![0] as UpdateCommand).input).toMatchObject({ UpdateExpression: 'REMOVE noticeAt', ConditionExpression: 'noticeAt = :at' });
    send.mockResolvedValueOnce({ Items: [parked('job_c')] });
    expect((await sessions.unnoticed(55, NOW)).map((j) => j.id)).toEqual(['job_c']);
    expect((send.mock.calls[3]![0] as QueryCommand).input.FilterExpression).toContain('attribute_not_exists(noticeAt)');
  });
});
