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

/** The issue as fetched by the worker's pre-start check, handed to the executor. Untrusted text. */
export interface IssueSnapshot {
  title: string;
  body: string;
  labels: string[];
  url: string;
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
  /** Consecutive start failures since enqueue or the user's last retry (capped by MAX_START_FAILURES). */
  startFailures: number;
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
  /** Host of the worker that claimed the run (null for runs from before it was recorded). */
  hostname: string | null;
  pid: number | null;
  /**
   * OS start time of `pid`, platform-tagged (see processStartTime). A pid is only signalled when
   * this still matches, so a reused pid is never killed. Null for runs recorded before v5.
   */
  pidStartTime: string | null;
  leaseExpiresAt: string;
  /** When the job was claimed. */
  startedAt: string;
  /** When the worker handed the run to the executor; null while claimed but not started. */
  executionStartedAt: string | null;
  endedAt: string | null;
  outcome: RunOutcome | null;
  error: string | null;
  /** What a live agent run left behind; null for log-only and prepare-only runs. */
  summary: RunSummary | null;
  /**
   * The container a containerized live run started (agents.<name>.container): the runtime client
   * and the container's name, so a later worker on the same host can remove it. Null when the
   * agent ran on the host.
   */
  container: RunContainer | null;
}

export interface RunContainer {
  /** Absolute path of the runtime client (docker, podman) that started the container. */
  runtime: string;
  name: string;
}

/** Recorded after a live agent run, in run.log and the state DB (`factory status`). */
export interface RunSummary {
  branch: string;
  baseSha: string;
  worktree: string;
  /** Commits on the job branch since the base commit, newest first ("<short sha> <subject>"), capped. */
  commits: string[];
  commitCount: number;
  /** Tracked files that differ from the base commit, committed or not. */
  filesChanged: number;
  /** Last line of `git diff --stat <base>`, e.g. "3 files changed, 10 insertions(+), 2 deletions(-)". */
  diffStat: string;
  /** Files in the worktree that git does not track yet. */
  untracked: number;
  /** The agent's last output lines (stdout and stderr). */
  lastOutput: string[];
  /** Parts of the summary that could not be computed. */
  notes: string[];
}

export type PublicationState = 'publishing' | 'published' | 'failed' | 'skipped';

/** Publication of a succeeded live run: job branch pushed, PR opened, issue commented. */
export interface Publication {
  runId: string;
  jobId: string;
  repoId: number;
  repoFullName: string;
  issueNumber: number;
  mode: 'draft-pr' | 'pr';
  state: PublicationState;
  branch: string;
  baseBranch: string | null;
  /** The commit pushed, or found already on the remote at the same SHA. */
  headSha: string | null;
  pushedAt: string | null;
  prNumber: number | null;
  prUrl: string | null;
  commentId: number | null;
  commentUrl: string | null;
  /** Why it failed, or why it was skipped. */
  error: string | null;
  /** A transient failure (network, 5xx, rate limit) the worker retries on its own. */
  retryable: boolean;
  attempts: number;
  leaseExpiresAt: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}
