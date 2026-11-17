/**
 * Shared domain types. Persisted shapes here are versioned; bump
 * ENVELOPE_SCHEMA_VERSION when the envelope changes incompatibly.
 */

export const ENVELOPE_SCHEMA_VERSION = 1;

export interface RepoRef {
  /** Stable GitHub repository ID. Use this for persisted state. */
  id: number;
  /** owner/name at the time the event was observed. Display only. */
  fullName: string;
}

/**
 * Transport-independent description of the GitHub event that caused a job.
 * Polling builds these today; a webhook relay could build the same shape later.
 */
export interface EventEnvelope {
  schemaVersion: typeof ENVELOPE_SCHEMA_VERSION;
  type: 'issue.labeled';
  repo: RepoRef;
  issue: { number: number; title: string; url: string };
  /** GitHub issue-event ID (stringified). For PR revisions this would be the head SHA. */
  eventId: string;
  /** Link to the event's subject (the issue URL). */
  url: string;
  actor: string | null;
  label: string;
  /** Labels on the issue when the job was enqueued (used for routing). */
  labelsAtEnqueue: string[];
  createdAt: string;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'canceled';

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'interrupted', 'canceled'];

export interface Job {
  id: string;
  repoId: number;
  repoFullName: string;
  workflowId: string;
  eventId: string;
  issueNumber: number;
  action: string;
  /** Pool chosen once at enqueue time. */
  pool: string;
  envelope: EventEnvelope;
  status: JobStatus;
  statusReason: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export type RunOutcome = 'succeeded' | 'failed' | 'interrupted' | 'start_failed';

export interface Run {
  id: string;
  jobId: string;
  attempt: number;
  pool: string;
  agent: string;
  checkoutPath: string | null;
  logPath: string | null;
  workerId: string;
  pid: number | null;
  leaseExpiresAt: string;
  startedAt: string;
  endedAt: string | null;
  outcome: RunOutcome | null;
  error: string | null;
}
