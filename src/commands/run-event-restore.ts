// What `updraft run-event` reads from GitHub about a pull request the state database does not
// know, and how it puts a lost publication back on record. docs/run-event.md ("A pull request
// the state database does not know", "Restoring lost state") is the contract.
//
// Both start from the same question, asked of the API and never of a webhook payload: is this
// pull request one Updraft opened? It is when it is open, was opened by the worker's own
// identity, has a job branch of this repository as its head, and carries the marker publication
// puts in the body, which names the run that opened it.
import type { Db } from '../db/database.js';
import { transaction } from '../db/database.js';
import { RECONSTRUCTED_AT, RECONSTRUCTED_PREFIX, RECONSTRUCTED_WORKER } from '../db/reconstructed.js';
import { getRevisionPr, syncRevisionPrs } from '../db/revisions.js';
import { isJobBranchName } from '../git/worktree.js';
import { GitHubError, type GitHubApi, type PullRequestDetails } from '../github/api.js';
import { isWorkerLogin } from '../github/credentials.js';
import type { RepoRef } from '../types.js';

/** What the API establishes about a pull request Updraft opened. */
export interface OwnPullRequest {
  pr: PullRequestDetails;
  /** The run that opened it, from the marker in its body. */
  runId: string;
  /** The agent of that run, from the line publication writes above the marker; null when it cannot be read. */
  agent: string | null;
}

export type OwnPullRequestAnswer =
  | { kind: 'ours'; own: OwnPullRequest }
  /** Not there, or not readable. */
  | { kind: 'gone' }
  /** Closed or merged: nothing acts on it any more, whoever opened it. */
  | { kind: 'closed' }
  | { kind: 'not-ours'; why: string };

const MARKER = /<!-- updraft-run: (run_[0-9a-z]+) -->/;
const OPENED_BY = /Opened by updraft from run `(run_[0-9a-z]+)` \(agent ([^)\r\n]+)\)/;

/**
 * Ask GitHub whether pull request `prNumber` is one Updraft opened. Two requests at most (the
 * pull request, and who the worker is), none of them a write. Throws for API failures other than
 * "not found".
 */
export async function readOwnPullRequest(api: Pick<GitHubApi, 'getPullRequest' | 'getWorkerIdentity'>, repo: RepoRef, prNumber: number): Promise<OwnPullRequestAnswer> {
  let pr: PullRequestDetails;
  try {
    pr = await api.getPullRequest(repo, prNumber);
  } catch (err) {
    if (err instanceof GitHubError && [301, 404, 410].includes(err.status)) return { kind: 'gone' };
    throw err;
  }
  if (pr.state !== 'open') return { kind: 'closed' };
  if (!isJobBranchName(pr.headRef)) return { kind: 'not-ours', why: `its head branch ${pr.headRef} is not a job branch` };
  if (pr.headRepoId !== repo.id) return { kind: 'not-ours', why: 'its head branch is in another repository' };
  const runId = MARKER.exec(pr.body ?? '')?.[1];
  if (!runId) return { kind: 'not-ours', why: 'its body does not carry the marker of the run that opened it' };
  const identity = await api.getWorkerIdentity();
  if (!isWorkerLogin(identity, pr.author)) return { kind: 'not-ours', why: `it was opened by ${pr.author ?? 'an unknown account'}, not by ${identity.login}` };
  const opened = OPENED_BY.exec(pr.body ?? '');
  return { kind: 'ours', own: { pr, runId, agent: opened && opened[1] === runId ? opened[2]!.trim() : null } };
}

export interface RestoreInput {
  repo: RepoRef;
  /** The event's job, already in the database (queued by this run, or found there). */
  jobId: string;
  /** The attempt whose branch the pull request is on (jobBranchName). */
  attempt: number;
  own: OwnPullRequest & { agent: string };
  mode: 'draft-pr' | 'pr';
  deliveryId: string | null;
  now: () => number;
}

/** A note for the fields that say why a row is what it is (jobs.status_reason, runs.error, publications.error). */
function note(o: RestoreInput): string {
  return (
    `${RECONSTRUCTED_PREFIX}pull request #${o.own.pr.number} exists on GitHub for this event and the state database had no record of the run that opened it ` +
    `(${o.own.runId}); restored from the GitHub API on ${new Date(o.now()).toISOString()}${o.deliveryId ? ` by delivery ${o.deliveryId}` : ''}. ` +
    'Only what the API shows is recorded: no run summary, log or commit of the original run'
  );
}

/**
 * Put the publication of the event's job back on record, from what the API established: the job
 * as succeeded, the run under its own id (from the pull request's marker), its publication as
 * published, and the pull request as watched. Rows that are there already are completed, never
 * replaced: a run the database has is left as recorded (closed, if it was left open).
 *
 * Every row written says that it was reconstructed (src/db/reconstructed.ts), which is also what
 * lets `updraft state merge` prefer the recorded rows should the original run's state turn up.
 * Throws when the database contradicts the API (the run id belongs to another job).
 */
export function restorePublication(db: Db, o: RestoreInput): { run: 'created' | 'kept'; watched: boolean } {
  const at = new Date(o.now()).toISOString();
  const why = note(o);
  const { pr, runId, agent } = o.own;
  const before = getRevisionPr(db, o.repo.id, pr.number);
  const run = transaction(db, (): 'created' | 'kept' => {
    const job = db.prepare('SELECT pool, issue_number, repo_full_name, status FROM jobs WHERE id = ?').get(o.jobId) as { pool: string; issue_number: number; repo_full_name: string; status: string } | undefined;
    if (!job) throw new Error(`job ${o.jobId} is not in the state database`);
    const existingRun = db.prepare('SELECT job_id, ended_at FROM runs WHERE id = ?').get(runId) as { job_id: string; ended_at: string | null } | undefined;
    if (existingRun && existingRun.job_id !== o.jobId) {
      throw new Error(`the pull request names run ${runId}, which the state database has for another job (${existingRun.job_id}), not for ${o.jobId}`);
    }
    if (!existingRun) {
      db.prepare(
        `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, hostname, lease_expires_at, started_at, ended_at, outcome, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', ?)`,
      ).run(runId, o.jobId, o.attempt, job.pool, agent, RECONSTRUCTED_WORKER, RECONSTRUCTED_WORKER, at, at, at, why);
    } else if (existingRun.ended_at === null) {
      // A checkpoint carried the run while it was going, and its end was never saved.
      db.prepare("UPDATE runs SET ended_at = ?, outcome = 'succeeded', error = ? WHERE id = ? AND ended_at IS NULL").run(at, why, runId);
    }
    if (job.status !== 'succeeded') {
      db.prepare("UPDATE jobs SET status = 'succeeded', status_reason = ?, attempts = max(attempts, ?), updated_at = ? WHERE id = ?").run(why, o.attempt, at, o.jobId);
    }
    db.prepare(
      `INSERT INTO publications (run_id, job_id, repo_id, repo_full_name, issue_number, mode, state, branch, base_branch, pr_number, pr_url,
                                 error, retryable, attempts, created_at, updated_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)
       ON CONFLICT (run_id) DO UPDATE SET
         state = 'published', branch = excluded.branch, base_branch = excluded.base_branch, pr_number = excluded.pr_number, pr_url = excluded.pr_url,
         error = excluded.error, retryable = 0, lease_expires_at = NULL, next_attempt_at = NULL, updated_at = excluded.updated_at,
         published_at = coalesce(publications.published_at, excluded.published_at)`,
    ).run(runId, o.jobId, o.repo.id, job.repo_full_name, job.issue_number, o.mode, pr.headRef, pr.baseRef, pr.number, pr.htmlUrl, why, at, at, at);
    return existingRun ? 'kept' : 'created';
  });
  // The watch row is derived from the publication, as it always is (a transaction of its own).
  syncRevisionPrs(db, o.repo.id, o.now);
  if (!before && getRevisionPr(db, o.repo.id, pr.number)) {
    db.prepare('UPDATE revision_prs SET author_agent = ?, created_at = ?, updated_at = ? WHERE repo_id = ? AND pr_number = ?').run(agent, RECONSTRUCTED_AT, RECONSTRUCTED_AT, o.repo.id, pr.number);
  }
  return { run, watched: getRevisionPr(db, o.repo.id, pr.number) !== null };
}
