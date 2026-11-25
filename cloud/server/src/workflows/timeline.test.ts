import { describe, expect, it } from 'vitest';
import { createWorkflowRecorder, updateWorkflow } from './recorder.js';
import { createMemoryWorkflowStore } from './store.js';
import { endedWait, historyOf, keepPaused, orderEvents, pauseControlOf, pausedWorkflow, resumedWorkflow, waitKindOf } from './timeline.js';
import { newWorkflow, type Workflow, type WorkflowEvent } from './workflow.js';

const T0 = Date.parse('2026-11-25T12:00:00.000Z');
const job = (over: Record<string, unknown> = {}) => ({
  jobId: 'job_issue0001',
  installationId: 55,
  repository: 'acme/web',
  repositoryId: 99,
  issue: 7,
  eventName: 'issues',
  deliveryId: 'd-1',
  ...over,
}) as Parameters<ReturnType<typeof createWorkflowRecorder>['started']>[0];

function setup() {
  const store = createMemoryWorkflowStore();
  let clock = T0;
  const recorder = createWorkflowRecorder({ store, now: () => clock, log: () => {} });
  return {
    store,
    recorder,
    tick: (ms: number) => (clock += ms),
    set: (ms: number) => (clock = ms),
    wf: () => store.getWorkflow(55, '99-i7'),
    events: () => store.listWorkflowEvents(55, '99-i7', 100),
  };
}

const ev = (id: string, at: string, seq?: number): WorkflowEvent => ({ id, at, kind: 'waiting', generation: 1, ...(seq !== undefined ? { seq } : {}) });

describe('timeline ordering', () => {
  it('orders saved events by the version they were saved with, whatever the writers\' clocks said', () => {
    // A writer whose clock runs behind saved the later change.
    const events = [ev('b', '2026-11-25T12:00:00.500Z', 2), ev('a', '2026-11-25T12:00:01.000Z', 1), ev('c', '2026-11-25T12:00:00.100Z', 3)];
    expect(orderEvents(events).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('orders events without versions (rebuilt history) by time, then id, deterministically', () => {
    const events = [ev('z', '2026-11-25T12:00:02.000Z'), ev('b', '2026-11-25T12:00:01.000Z'), ev('a', '2026-11-25T12:00:01.000Z')];
    expect(orderEvents(events).map((e) => e.id)).toEqual(['a', 'b', 'z']);
    expect(orderEvents([...events].reverse()).map((e) => e.id)).toEqual(['a', 'b', 'z']);
  });

  it('keeps the recorded order when a later event is recorded with an earlier time', async () => {
    const s = setup();
    await s.recorder.started(job());
    // The broker's clock is behind the launcher's.
    s.tick(-5_000);
    await s.recorder.finished(job(), 'failed');
    expect((await s.events()).map((e) => e.kind)).toEqual(['job_started', 'job_finished']);
  });

  it('records a duplicate finish once, and a finish replayed out of order changes nothing', async () => {
    const s = setup();
    await s.recorder.started(job());
    s.tick(60_000);
    await s.recorder.finished(job(), 'succeeded', { prNumber: 12, loop: { rounds: 0, reviews: 1, stage: 'waiting-for-ci' } });
    const pr = job({ jobId: 'job_pr000001', issue: undefined, pullRequest: 12, eventName: 'check_suite', deliveryId: 'd-2' });
    s.tick(60_000);
    await s.recorder.started(pr);
    // The first job's finish delivered again, after the next job started.
    await s.recorder.finished(job(), 'succeeded', { prNumber: 12, loop: { rounds: 0, reviews: 1, stage: 'waiting-for-ci' } });
    const events = await s.events();
    expect(events.filter((e) => e.kind === 'job_finished')).toHaveLength(1);
    expect(await s.wf()).toMatchObject({ status: 'active', lastJobId: 'job_pr000001' });
  });
});

describe('waits on the timeline', () => {
  it('says how long a CI wait lasted on the job that ended it', async () => {
    const s = setup();
    await s.recorder.started(job());
    s.tick(60_000);
    await s.recorder.finished(job(), 'succeeded', { prNumber: 12, loop: { rounds: 0, reviews: 1, stage: 'waiting-for-ci' } });
    s.tick(20 * 60_000);
    await s.recorder.started(job({ jobId: 'job_pr000001', issue: undefined, pullRequest: 12, eventName: 'check_suite', deliveryId: 'd-2' }));
    const started = (await s.events()).at(-1)!;
    expect(started).toMatchObject({ kind: 'job_started', jobId: 'job_pr000001', waited: { for: 'ci', since: new Date(T0 + 60_000).toISOString(), seconds: 1200 } });
  });

  it('says how long a sign-in wait lasted, and a capacity wait by the queue entry\'s own clock', async () => {
    const s = setup();
    await s.recorder.waiting({ ...job(), jobId: 'job_issue0001' }, { reason: 'claude_sign_in', message: 'Waiting for a sign-in.', nextAction: 'Sign in.' });
    s.tick(90_000);
    await s.recorder.started(job());
    expect((await s.events()).at(-1)).toMatchObject({ kind: 'job_started', waited: { for: 'sign_in', seconds: 90 } });

    // A queued job that never starts: the wait ends where the queue says it began.
    const q = setup();
    await q.recorder.queued(job({ jobId: 'job_queued001' }), { reason: 'capacity_wait', code: 'concurrent_jobs', message: 'Queued.' });
    q.tick(10 * 60_000);
    await q.recorder.queueEnded(job({ jobId: 'job_queued001' }), { reason: 'queue_canceled', message: 'The label was removed.' }, { enqueuedAt: T0 - 30_000 });
    const events = await q.events();
    expect(events[0]).toMatchObject({ kind: 'waiting', stage: 'queued', reason: 'concurrent_jobs' });
    expect(events[1]).toMatchObject({ kind: 'blocked', reason: 'queue_canceled', waited: { for: 'capacity', seconds: 630 } });
    expect(await q.wf()).toMatchObject({ status: 'blocked', reason: 'queue_canceled' });
  });

  it('records an admission once, filed under the run of the job it admitted', async () => {
    const s = setup();
    await s.recorder.queued(job(), { reason: 'capacity_wait', message: 'Queued.' });
    s.tick(120_000);
    await s.recorder.started(job());
    await s.recorder.queueAdmitted(job(), { enqueuedAt: T0, reason: 'platform_concurrency' });
    await s.recorder.queueAdmitted(job(), { enqueuedAt: T0, reason: 'platform_concurrency' });
    const events = await s.events();
    expect(events.map((e) => e.kind)).toEqual(['waiting', 'job_started', 'admitted']);
    // The capacity wait is reported once: by the admission, not again by the start.
    expect(events[1]!.waited).toBeUndefined();
    expect(events[2]).toMatchObject({ generation: 1, reason: 'platform_concurrency', waited: { for: 'capacity', seconds: 120 } });
    expect(await s.wf()).toMatchObject({ status: 'active', lastJobId: 'job_issue0001' });
  });

  it('names what a workflow waits for, and says nothing ended when the wait goes on', () => {
    const w = newWorkflow(job(), '99-i7', T0);
    expect(waitKindOf({ stage: 'waiting-for-ci' })).toBe('ci');
    expect(waitKindOf({ stage: 'ready-to-merge' })).toBe('person');
    expect(waitKindOf({ stage: 'changes-requested', reason: 'awaiting_event' })).toBe('review_event');
    const waiting: Workflow = { ...w, status: 'waiting', stage: 'waiting-for-ci', waitingSince: new Date(T0).toISOString() };
    expect(endedWait(waiting, { ...waiting, nextCheckAt: 'later' }, T0 + 1000)).toBeUndefined();
    expect(endedWait(waiting, { ...waiting, status: 'blocked' }, T0 + 1000)).toEqual({ for: 'ci', since: new Date(T0).toISOString(), seconds: 1 });
    expect(endedWait(null, waiting, T0)).toBeUndefined();
  });
});

describe('routing and roles on the timeline', () => {
  it('keeps the tier, the tier first chosen, the reason, and each step\'s adapter, model and effort', async () => {
    const s = setup();
    await s.recorder.started(job());
    await s.recorder.finished(job(), 'succeeded', {
      routing: { source: 'tier', pool: 'big', tier: 'complex', requestedTier: 'standard', reason: 'confident', confidence: 0.9 },
      steps: [
        { kind: 'implement', agent: 'coder', adapter: 'claude', model: 'claude-opus-4', effort: 'high', outcome: 'succeeded', runId: 'run_1' },
        { kind: 'review', agent: 'reviewer', adapter: 'codex', outcome: 'succeeded' },
      ],
    });
    const finished = (await s.events()).at(-1)!;
    expect(finished.routing).toEqual({ source: 'tier', pool: 'big', tier: 'complex', requestedTier: 'standard', reason: 'confident' });
    expect(finished.steps).toEqual([
      { kind: 'implement', agent: 'coder', adapter: 'claude', model: 'claude-opus-4', effort: 'high', outcome: 'succeeded' },
      { kind: 'review', agent: 'reviewer', adapter: 'codex', outcome: 'succeeded' },
    ]);
  });
});

describe('stop and resume on the timeline', () => {
  it('pauses the workflow when a stop is requested, keeps it paused through the stopped job\'s finish, and restores it on resume', async () => {
    const s = setup();
    await s.recorder.started(job());
    s.tick(60_000);
    const requestedAt = s.tick(0);
    await s.recorder.stopRequested(job(), { requestedAt, by: 'pat', reason: 'wrong approach' });
    expect(await s.wf()).toMatchObject({ status: 'blocked', reason: 'workflow_paused', controlPause: { jobId: 'job_issue0001', at: requestedAt, by: 'pat' } });
    // The same stop again (a retried request) is one event.
    await s.recorder.stopRequested(job(), { requestedAt, by: 'pat', reason: 'wrong approach' });

    s.tick(5_000);
    await s.recorder.finished(job(), 'canceled');
    // Still paused: the finish is what a resume gives back.
    expect(await s.wf()).toMatchObject({ status: 'blocked', reason: 'workflow_paused', controlPause: { previous: { status: 'blocked', reason: 'job_canceled' } } });

    s.tick(10 * 60_000);
    await s.recorder.resumed({ installationId: 55, workflowId: '99-i7' }, { jobId: 'job_issue0001', at: requestedAt }, 'sam');
    await s.recorder.resumed({ installationId: 55, workflowId: '99-i7' }, { jobId: 'job_issue0001', at: requestedAt }, 'sam');
    const w = (await s.wf())!;
    expect(w).toMatchObject({ status: 'blocked', reason: 'job_canceled', message: expect.stringMatching(/resumed since/) });
    expect(w.controlPause).toBeUndefined();
    const events = await s.events();
    expect(events.map((e) => e.kind)).toEqual(['job_started', 'control', 'job_finished', 'control']);
    expect(events[1]).toMatchObject({ jobId: 'job_issue0001', control: { action: 'stop_requested', by: 'pat', reason: 'wrong approach' } });
    expect(events[3]).toMatchObject({ control: { action: 'resumed', by: 'sam' }, waited: { for: 'pause', seconds: 605 } });
  });

  it('resumes from the stopped job\'s own page through the job\'s workflow', async () => {
    const s = setup();
    const pr = job({ jobId: 'job_review001', issue: undefined, pullRequest: 12, eventName: 'pull_request_review', deliveryId: 'd-2' });
    await s.recorder.started(job());
    await s.recorder.finished(job(), 'succeeded', { prNumber: 12, loop: { rounds: 0, reviews: 0, stage: 'awaiting-review' } });
    await s.recorder.started(pr);
    await s.recorder.stopRequested(pr, { requestedAt: T0, by: 'pat' });
    await s.recorder.resumed({ installationId: 55, job: pr }, { jobId: pr.jobId, at: T0 }, 'pat');
    expect((await s.events()).filter((e) => e.kind === 'control').map((e) => e.control?.action)).toEqual(['stop_requested', 'resumed']);
    // Back to what it said before the pause: a job was running.
    expect(await s.wf()).toMatchObject({ status: 'active', lastJobId: pr.jobId });
  });

  it('only restores the pause it resumed: a resume of another stop is an event, not a change of state', async () => {
    const w0 = newWorkflow(job(), '99-i7', T0);
    const paused = pausedWorkflow({ ...w0, status: 'waiting', stage: 'waiting-for-ci', reason: 'ci_pending' }, { jobId: 'job_b', at: 2, by: 'pat' }, T0);
    const s = setup();
    await updateWorkflow(s.store, 55, '99-i7', () => ({ workflow: paused }));
    await s.recorder.resumed({ installationId: 55, workflowId: '99-i7' }, { jobId: 'job_a', at: 1 }, 'sam');
    expect(await s.wf()).toMatchObject({ reason: 'workflow_paused', controlPause: { jobId: 'job_b' } });
    expect(resumedWorkflow(paused, T0)).toMatchObject({ status: 'waiting', reason: 'ci_pending' });
    expect(resumedWorkflow(paused, T0).controlPause).toBeUndefined();
  });

  it('does not carry a lost job\'s retry on after a resume, and keeps a pause through a finish only while one holds', () => {
    const w0 = newWorkflow(job(), '99-i7', T0);
    const lost = pausedWorkflow({ ...w0, status: 'blocked', reason: 'job_lost', nextCheckAt: 'soon' }, { jobId: 'job_a', at: 1, by: 'pat' }, T0);
    expect(resumedWorkflow(lost, T0)).toMatchObject({ status: 'blocked', reason: 'job_lost', message: expect.stringMatching(/not retried automatically/) });
    expect(resumedWorkflow(lost, T0).nextCheckAt).toBeUndefined();
    const finished: Workflow = { ...w0, status: 'finished', stage: 'done' };
    expect(keepPaused(w0, finished, T0)).toBe(finished);
    expect(keepPaused(lost, finished, T0)).toMatchObject({ reason: 'workflow_paused', controlPause: { previous: { status: 'finished' } } });
  });
});

describe('a wait a pause interrupts', () => {
  it('is reported once up to the pause, and again only from the resume: paused time is never waiting', async () => {
    const s = setup();
    await s.recorder.started(job());
    await s.recorder.finished(job(), 'succeeded', { prNumber: 12, loop: { rounds: 0, reviews: 1, stage: 'waiting-for-ci' } });
    const waitStart = s.tick(0);
    s.tick(60_000);
    await s.recorder.stopRequested(job({ jobId: 'job_stopped001' }), { requestedAt: s.tick(0), by: 'pat' });
    const stopAt = s.tick(0);
    expect((await s.events()).at(-1)).toMatchObject({ kind: 'control', waited: { for: 'ci', since: new Date(waitStart).toISOString(), seconds: 60 } });
    expect((await s.wf())!.waitingSince).toBeUndefined();

    s.tick(60 * 60_000);
    await s.recorder.resumed({ installationId: 55, workflowId: '99-i7' }, { jobId: 'job_stopped001', at: stopAt }, 'pat');
    const resumedAt = s.tick(0);
    expect(await s.wf()).toMatchObject({ status: 'waiting', stage: 'waiting-for-ci', waitingSince: new Date(resumedAt).toISOString() });

    s.tick(60_000);
    await s.recorder.started(job({ jobId: 'job_pr000001', issue: undefined, pullRequest: 12, eventName: 'check_suite', deliveryId: 'd-2' }));
    const started = (await s.events()).at(-1)!;
    expect(started).toMatchObject({ kind: 'job_started', waited: { for: 'ci', since: new Date(resumedAt).toISOString(), seconds: 60 } });
    // Never the whole span, pause included.
    expect((await s.events()).some((e) => e.waited?.for === 'ci' && e.waited.seconds > 120)).toBe(false);
  });

  it('keeps a workflow paused when a resume lifts one pause and another still holds it', async () => {
    const store = createMemoryWorkflowStore();
    let clock = T0;
    const held = { jobId: 'job_review001', at: T0 + 10, by: 'sam' };
    const pauses = { getWorkflowPause: async (_i: number, _r: number, n: number) => (n === 12 ? held : null) };
    const recorder = createWorkflowRecorder({ store, pauses, now: () => clock, log: () => {} });
    await recorder.started(job());
    await recorder.finished(job(), 'succeeded', { prNumber: 12, loop: { rounds: 0, reviews: 1, stage: 'waiting-for-ci' } });
    await recorder.stopRequested(job(), { requestedAt: T0, by: 'pat' });
    clock += 60_000;
    await recorder.resumed({ installationId: 55, workflowId: '99-i7' }, { jobId: 'job_issue0001', at: T0 }, 'pat');
    const w = (await store.getWorkflow(55, '99-i7'))!;
    expect(w).toMatchObject({ status: 'blocked', reason: 'workflow_paused', message: expect.stringContaining('sam'), controlPause: { jobId: 'job_review001', at: T0 + 10, by: 'sam', previous: { status: 'waiting', reason: 'ci_pending' } } });
    expect((await store.listWorkflowEvents(55, '99-i7', 20)).at(-1)).toMatchObject({ kind: 'control', control: { action: 'resumed' }, message: expect.stringMatching(/stays paused/) });
  });

  it('words a command-made pause or cancel as what it was, and ignores a malformed descriptor', () => {
    const w0 = newWorkflow(job(), '99-i7', T0);
    const paused = pausedWorkflow(w0, { jobId: 'control-1', at: 1, by: 'pat', control: { kind: 'pause', source: 'github_comment' } }, T0);
    expect(paused.message).toBe('Automation was paused by pat (github comment). Existing commits and the pull request are preserved.');
    expect(paused.nextAction).not.toMatch(/retry job/);
    expect(paused.controlPause).toMatchObject({ control: { kind: 'pause', source: 'github_comment' } });
    expect(pausedWorkflow(w0, { jobId: 'control-1', at: 1, by: 'pat', control: { kind: 'cancel', source: 'github_comment', by: 'sam' } }, T0).message).toMatch(/^Automation was canceled by sam/);
    // The finish of a job keeps the command's words.
    expect(keepPaused(paused, { ...w0, status: 'finished', stage: 'done' }, T0).message).toMatch(/paused by pat \(github comment\)/);
    expect(pauseControlOf({ kind: 'pause', source: 'GitHub Comment!' })).toBeUndefined();
    expect(pauseControlOf({ kind: 'stop', source: 'x' })).toBeUndefined();
    expect(pauseControlOf({ kind: 'cancel', source: 'console', by: 'sam' })).toEqual({ kind: 'cancel', source: 'console', by: 'sam' });
  });
});

describe('retention and history', () => {
  it('says how many older events a page leaves out', async () => {
    const s = setup();
    await s.recorder.started(job());
    for (let i = 0; i < 4; i++) {
      s.tick(1000);
      await s.recorder.finished(job({ jobId: `job_extra00${i}` }), 'failed');
    }
    const page = await s.store.listWorkflowHistory(55, '99-i7', 3);
    expect(page.events).toHaveLength(3);
    expect(page.omitted).toBe(2);
    expect(page.complete).toBe(true);
    // The newest are the ones kept.
    expect(page.events.at(-1)!.jobId).toBe('job_extra003');
  });

  it('says when a workflow began before its earliest events could still be kept', () => {
    const now = T0;
    const recent = historyOf({ createdAt: new Date(now - 10 * 86_400_000).toISOString() }, { shown: 1, omitted: 0, complete: true }, now);
    expect(recent).toMatchObject({ expiredEarlier: false, eventRetentionDays: 90, workflowRetentionDays: 90, jobRetentionDays: 30 });
    expect(historyOf({ createdAt: new Date(now - 91 * 86_400_000).toISOString() }, { shown: 1, omitted: 0, complete: true }, now).expiredEarlier).toBe(true);
  });
});
