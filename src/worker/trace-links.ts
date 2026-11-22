// Agent telemetry links (docs/agent-telemetry.md, "Across jobs"): each job is its own trace, in its
// own microVM, so a revision's trace cannot know the trace of the review it answers unless it is
// written down. The runner gives `updraft run-event` its trace id (UPDRAFT_TRACE_ID); the worker
// records it with each run it starts, in `meta` (merged into the shared state like any row), and
// names the earlier runs a run follows, with their traces, in its run.log header. The runner's
// tracer turns those lines into span links; a run's invoke_agent span id is derived from its run
// id there, so nothing else needs to be stored.
import type { Db } from '../db/database.js';
import { codeRunForHead } from '../db/pr-reviews.js';
import { resumeOf, reviewOf, revisionOf, type Job } from '../types.js';

export const TRACE_KEY_PREFIX = 'trace:';
const TRACE_ID = /^[0-9a-f]{32}$/;

/** A trace id as the runner passes it, or null when absent or not one. */
export function traceIdFrom(env: NodeJS.ProcessEnv): string | null {
  const id = env.UPDRAFT_TRACE_ID?.trim();
  return id && TRACE_ID.test(id) ? id : null;
}

export interface FollowedRun {
  runId: string;
  /** How this run relates to it: the review it answers, the code it reviews, ... */
  relation: 'review' | 'code' | 'source' | 'resumes' | 'retry';
  traceId: string;
}

/** Records the trace a run is in. Best effort: telemetry never stops a run. */
export function recordRunTrace(db: Db, runId: string, traceId: string): void {
  if (!TRACE_ID.test(traceId)) return;
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(`${TRACE_KEY_PREFIX}${runId}`, traceId);
}

export function traceOfRun(db: Db, runId: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(`${TRACE_KEY_PREFIX}${runId}`) as { value: string } | undefined;
  return row && TRACE_ID.test(row.value) ? row.value : null;
}

/**
 * The earlier runs `runId` (a run of `job`) follows, that were traced: for a revision the review
 * that queued it and the run that opened the pull request; for a review the run that pushed the
 * commit under review; for a follow-up the run that waited; for a retry the job's earlier attempt.
 */
export function followedRuns(db: Db, job: Job, runId: string): FollowedRun[] {
  const found: Array<{ runId: string | null | undefined; relation: FollowedRun['relation'] }> = [];
  const revision = revisionOf(job);
  const review = reviewOf(job);
  const resume = resumeOf(job);
  if (revision) {
    const row = db.prepare('SELECT run_id FROM pr_reviews WHERE revision_job_id = ? LIMIT 1').get(job.id) as { run_id: string } | undefined;
    found.push({ runId: row?.run_id, relation: 'review' }, { runId: revision.sourceRunId, relation: 'source' });
  } else if (review) {
    found.push({ runId: codeRunForHead(db, job.repoId, review.pullRequest.number, review.headSha), relation: 'code' }, { runId: review.sourceRunId, relation: 'source' });
  } else if (resume) found.push({ runId: resume.waitingRunId, relation: 'resumes' });
  const earlier = db.prepare('SELECT id FROM runs WHERE job_id = ? AND id <> ? ORDER BY attempt DESC LIMIT 1').get(job.id, runId) as { id: string } | undefined;
  found.push({ runId: earlier?.id, relation: 'retry' });

  const out: FollowedRun[] = [];
  const seen = new Set<string>([runId]);
  for (const f of found) {
    if (!f.runId || seen.has(f.runId)) continue;
    seen.add(f.runId);
    const traceId = traceOfRun(db, f.runId);
    if (traceId) out.push({ runId: f.runId, relation: f.relation, traceId });
  }
  return out;
}

/** The run.log header lines that name them (read by the runner's tracer). */
export const followsLines = (follows: readonly FollowedRun[]): string[] => follows.map((f) => `follows: run ${f.runId} (${f.relation}, trace ${f.traceId})`);
