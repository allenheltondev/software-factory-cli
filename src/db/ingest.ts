// OWNER: GitHub/poller workstream. Ingestion-side persistence: checkpoints,
// deduplicated job inserts, and cancellation of queued jobs.
import { rowToJob, transaction, type Db, type JobRow } from './database.js';
import type { EventEnvelope, Job } from '../types.js';
import { newId, nowIso } from '../util/ids.js';

export interface Checkpoint {
  repoId: number;
  fullName: string;
  lastEventId: number | null;
  /** created_at of the newest event seen by the last committed scan (GitHub's clock). */
  lastEventCreatedAt: string | null;
  /** Events with id <= this existed before the subscription started; never dispatched. */
  startEventId: number | null;
  /** Events created before this (backfillSince at subscription time) are never dispatched. */
  startCreatedAt: string | null;
  /** Whether page 1 of the last scan reached past the overlap boundary; null if unknown. */
  page1CoversOverlap: boolean | null;
  etag: string | null;
  initializedAt: string;
  updatedAt: string;
}

export interface NewJob {
  /**
   * The job's id when the caller must be able to derive it again elsewhere (`updraft run-event`
   * derives it from the event, see src/poller/webhook.ts); a new random id otherwise.
   */
  id?: string;
  repoId: number;
  repoFullName: string;
  workflowId: string;
  eventId: string;
  issueNumber: number;
  action: string;
  pool: string;
  envelope: EventEnvelope;
}

interface CheckpointRow {
  repo_id: number;
  full_name: string;
  last_event_id: number | null;
  last_event_created_at: string | null;
  start_event_id: number | null;
  start_created_at: string | null;
  page1_covers_overlap: number | null;
  etag: string | null;
  initialized_at: string;
  updated_at: string;
}

export function getCheckpoint(db: Db, repoId: number): Checkpoint | null {
  const r = db.prepare('SELECT * FROM repo_checkpoints WHERE repo_id = ?').get(repoId) as unknown as
    | CheckpointRow
    | undefined;
  if (!r) return null;
  return {
    repoId: r.repo_id,
    fullName: r.full_name,
    lastEventId: r.last_event_id,
    lastEventCreatedAt: r.last_event_created_at,
    startEventId: r.start_event_id,
    startCreatedAt: r.start_created_at,
    page1CoversOverlap: r.page1_covers_overlap === null ? null : r.page1_covers_overlap !== 0,
    etag: r.etag,
    initializedAt: r.initialized_at,
    updatedAt: r.updated_at,
  };
}

/**
 * In ONE transaction: insert jobs (ignoring duplicates on repo_id+workflow_id+event_id, among
 * existing jobs and jobs since pruned) and advance the repo checkpoint. Returns the jobs actually inserted, in batch order.
 * The stored last_event_id never moves backwards. `subscriptionStart` is written only
 * when the checkpoint is first created and never changes afterwards.
 */
export function commitPollBatch(
  db: Db,
  batch: {
    repoId: number;
    fullName: string;
    lastEventId: number | null;
    /** ISO created_at of the newest event scanned. Never moves backwards. */
    lastEventCreatedAt?: string | null;
    /** Recorded only on the first commit for a repo. */
    subscriptionStart?: { eventId: number | null; createdAt: string | null };
    /** Omit (or null) to keep the stored value. */
    page1CoversOverlap?: boolean | null;
    etag: string | null;
    jobs: NewJob[];
    now?: () => number;
  },
): Job[] {
  const at = nowIso(batch.now);
  // Ignore only duplicates of the dedupe key. Plain INSERT OR IGNORE would also swallow
  // NOT NULL / CHECK / primary-key violations and silently drop a job.
  // The dedupe key of a job that `updraft clean --older-than` deleted lives on in pruned_events;
  // an event listed there already had its job and is never enqueued again.
  const insert = db.prepare(
    `INSERT INTO jobs
       (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope,
        status, status_reason, attempts, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, 0, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM pruned_events WHERE repo_id = ? AND workflow_id = ? AND event_id = ?)
     ON CONFLICT (repo_id, workflow_id, event_id) DO NOTHING`,
  );
  const upsert = db.prepare(
    `INSERT INTO repo_checkpoints
       (repo_id, full_name, last_event_id, last_event_created_at, start_event_id, start_created_at,
        page1_covers_overlap, etag, initialized_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo_id) DO UPDATE SET
       full_name     = excluded.full_name,
       last_event_id = CASE
                         WHEN repo_checkpoints.last_event_id IS NULL THEN excluded.last_event_id
                         WHEN excluded.last_event_id IS NULL THEN repo_checkpoints.last_event_id
                         ELSE MAX(repo_checkpoints.last_event_id, excluded.last_event_id)
                       END,
       last_event_created_at = CASE
                         WHEN repo_checkpoints.last_event_created_at IS NULL THEN excluded.last_event_created_at
                         WHEN excluded.last_event_created_at IS NULL THEN repo_checkpoints.last_event_created_at
                         WHEN julianday(excluded.last_event_created_at) > julianday(repo_checkpoints.last_event_created_at)
                           THEN excluded.last_event_created_at
                         ELSE repo_checkpoints.last_event_created_at
                       END,
       page1_covers_overlap = COALESCE(excluded.page1_covers_overlap, repo_checkpoints.page1_covers_overlap),
       etag          = excluded.etag,
       updated_at    = excluded.updated_at`,
  );

  return transaction(db, () => {
    const inserted: Job[] = [];
    for (const j of batch.jobs) {
      const id = j.id ?? newId('job');
      const res = insert.run(
        id,
        j.repoId,
        j.repoFullName,
        j.workflowId,
        j.eventId,
        j.issueNumber,
        j.action,
        j.pool,
        JSON.stringify(j.envelope),
        at,
        at,
        j.repoId,
        j.workflowId,
        j.eventId,
      );
      if (Number(res.changes) > 0) {
        inserted.push({
          id,
          repoId: j.repoId,
          repoFullName: j.repoFullName,
          workflowId: j.workflowId,
          eventId: j.eventId,
          issueNumber: j.issueNumber,
          action: j.action,
          pool: j.pool,
          envelope: j.envelope,
          status: 'queued',
          statusReason: null,
          attempts: 0,
          startFailures: 0,
          createdAt: at,
          updatedAt: at,
        });
      }
    }
    const covers = batch.page1CoversOverlap;
    upsert.run(
      batch.repoId,
      batch.fullName,
      batch.lastEventId,
      batch.lastEventCreatedAt ?? null,
      batch.subscriptionStart?.eventId ?? null,
      batch.subscriptionStart?.createdAt ?? null,
      covers === undefined || covers === null ? null : covers ? 1 : 0,
      batch.etag,
      at,
      at,
    );
    return inserted;
  });
}

/** Queued jobs, oldest first (insertion order breaks created_at ties). */
export function listQueuedJobs(db: Db): Job[] {
  const rows = db
    .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, rowid")
    .all() as unknown as JobRow[];
  return rows.map(rowToJob);
}

/** Mark a job canceled only if it is still queued. Returns true if it changed. */
export function cancelQueuedJob(db: Db, jobId: string, reason: string, now?: () => number): boolean {
  const res = db
    .prepare(
      "UPDATE jobs SET status = 'canceled', status_reason = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
    )
    .run(reason, nowIso(now), jobId);
  return Number(res.changes) > 0;
}
