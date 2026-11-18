// Queue rows for tests that drive the worker or `updraft clean` against a real DB.
import type { Db } from '../src/db/database.js';
import { ENVELOPE_SCHEMA_VERSION, type EventEnvelope } from '../src/types.js';

let seq = 0;

export function insertQueuedJob(
  db: Db,
  o: { repoId: number; fullName: string; issue: number; pool?: string; action?: string },
): string {
  seq++;
  const id = `job_t${String(seq).padStart(5, '0')}`;
  const createdAt = new Date(Date.parse('2026-11-17T10:00:00.000Z') + seq).toISOString();
  const url = `https://github.com/${o.fullName}/issues/${o.issue}`;
  const envelope: EventEnvelope = {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    type: 'issue.labeled',
    repo: { id: o.repoId, fullName: o.fullName },
    issue: { number: o.issue, title: `Issue ${o.issue}`, url },
    eventId: String(5000 + seq),
    url,
    actor: 'allen',
    label: 'updraft:ready',
    labelsAtEnqueue: ['updraft:ready'],
    createdAt,
  };
  db.prepare(
    `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'wf', ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
  ).run(
    id,
    o.repoId,
    o.fullName,
    envelope.eventId,
    o.issue,
    o.action ?? 'implement-issue',
    o.pool ?? 'general',
    JSON.stringify(envelope),
    createdAt,
    createdAt,
  );
  return id;
}
