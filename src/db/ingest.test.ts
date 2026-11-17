import { describe, expect, it } from 'vitest';
import { ENVELOPE_SCHEMA_VERSION, type EventEnvelope } from '../types.js';
import { openDatabase } from './database.js';
import { cancelQueuedJob, commitPollBatch, getCheckpoint, listQueuedJobs, type NewJob } from './ingest.js';

function newJob(eventId: string, workflowId = 'wf', issueNumber = 1): NewJob {
  const envelope: EventEnvelope = {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    type: 'issue.labeled',
    repo: { id: 7, fullName: 'o/r' },
    issue: { number: issueNumber, title: 't', url: 'u' },
    eventId,
    url: 'u',
    actor: 'allen',
    label: 'factory:ready',
    labelsAtEnqueue: ['factory:ready'],
    createdAt: '2026-01-01T00:00:00Z',
  };
  return { repoId: 7, repoFullName: 'o/r', workflowId, eventId, issueNumber, action: 'a', pool: 'general', envelope };
}

describe('ingest persistence', () => {
  it('inserts jobs and advances the checkpoint together, ignoring duplicates', () => {
    const db = openDatabase(':memory:');
    expect(getCheckpoint(db, 7)).toBeNull();
    const first = commitPollBatch(db, { repoId: 7, fullName: 'o/r', lastEventId: 10, etag: 'e1', jobs: [newJob('9'), newJob('10')] });
    expect(first.map((j) => j.eventId)).toEqual(['9', '10']);
    expect(first[0]).toMatchObject({ status: 'queued', attempts: 0, statusReason: null });
    expect(first[0]!.id).toMatch(/^job_/);
    const cp = getCheckpoint(db, 7)!;
    expect(cp).toMatchObject({ repoId: 7, fullName: 'o/r', lastEventId: 10, etag: 'e1' });

    // Replay plus one new event and a second workflow for an old event.
    const second = commitPollBatch(db, {
      repoId: 7,
      fullName: 'o/renamed',
      lastEventId: 11,
      etag: 'e2',
      jobs: [newJob('9'), newJob('10'), newJob('11'), newJob('10', 'other-wf')],
    });
    expect(second.map((j) => `${j.workflowId}:${j.eventId}`)).toEqual(['wf:11', 'other-wf:10']);
    expect(listQueuedJobs(db)).toHaveLength(4);
    expect(getCheckpoint(db, 7)).toMatchObject({ fullName: 'o/renamed', lastEventId: 11, etag: 'e2', initializedAt: cp.initializedAt });
  });

  it('never moves last_event_id backwards and keeps it when the batch has none', () => {
    const db = openDatabase(':memory:');
    commitPollBatch(db, { repoId: 7, fullName: 'o/r', lastEventId: 50, etag: null, jobs: [] });
    commitPollBatch(db, { repoId: 7, fullName: 'o/r', lastEventId: 40, etag: null, jobs: [] });
    expect(getCheckpoint(db, 7)!.lastEventId).toBe(50);
    commitPollBatch(db, { repoId: 7, fullName: 'o/r', lastEventId: null, etag: 'x', jobs: [] });
    expect(getCheckpoint(db, 7)).toMatchObject({ lastEventId: 50, etag: 'x' });
  });

  it('rolls back job inserts when the batch fails', () => {
    const db = openDatabase(':memory:');
    const bad = { ...newJob('2'), pool: null as unknown as string };
    expect(() => commitPollBatch(db, { repoId: 7, fullName: 'o/r', lastEventId: 2, etag: null, jobs: [newJob('1'), bad] })).toThrow();
    expect(listQueuedJobs(db)).toHaveLength(0);
    expect(getCheckpoint(db, 7)).toBeNull();
  });

  it('lists queued jobs oldest first and cancels only queued jobs', () => {
    const db = openDatabase(':memory:');
    const jobs = commitPollBatch(db, {
      repoId: 7,
      fullName: 'o/r',
      lastEventId: 3,
      etag: null,
      jobs: [newJob('1'), newJob('2'), newJob('3')],
      now: () => Date.parse('2026-01-01T00:00:00Z'),
    });
    expect(listQueuedJobs(db).map((j) => j.eventId)).toEqual(['1', '2', '3']);
    expect(listQueuedJobs(db)[0]!.envelope.labelsAtEnqueue).toEqual(['factory:ready']);

    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobs[1]!.id);
    expect(cancelQueuedJob(db, jobs[0]!.id, 'issue #1 is closed')).toBe(true);
    expect(cancelQueuedJob(db, jobs[0]!.id, 'again')).toBe(false);
    expect(cancelQueuedJob(db, jobs[1]!.id, 'running')).toBe(false);
    expect(cancelQueuedJob(db, 'job_missing', 'x')).toBe(false);

    const rows = db.prepare('SELECT event_id, status, status_reason FROM jobs ORDER BY rowid').all();
    expect(rows).toEqual([
      { event_id: '1', status: 'canceled', status_reason: 'issue #1 is closed' },
      { event_id: '2', status: 'running', status_reason: null },
      { event_id: '3', status: 'queued', status_reason: null },
    ]);
    expect(listQueuedJobs(db).map((j) => j.eventId)).toEqual(['3']);
  });
});
