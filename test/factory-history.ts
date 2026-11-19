// A factory's history built through the real state functions (queue, publications, review loop,
// auto-merge) against an in-memory DB, on a clock the test moves. Used by the rollup and
// `updraft stats` tests: every metric row in such a DB was written by the code path that writes it
// in production.
import { configSchema, type UpdraftConfig } from '../src/config/schema.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { beginPublication, finishPublication, recordPublicationProgress } from '../src/db/publications.js';
import { adoptOwnPushes, beginPrReview, enqueueReviewJob, finishPrReview, getLoopPr, setMergeState, startMergeFor, type MergeStep } from '../src/db/pr-reviews.js';
import { claimNextJob, finishRun, type FailureHandling, markExecutionStarted, retryJob, setRunProcess, setRunSummary } from '../src/db/queue.js';
import { beginRevision, enqueueRevision, finishRevision, holdRevision, revisionJob, syncRevisionPrs, getRevisionPr } from '../src/db/revisions.js';
import { ENVELOPE_SCHEMA_VERSION, type EventEnvelope, type RoutingDecision, type RunOutcome, type RunSummary, type ReviewVerdict } from '../src/types.js';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const historyConfig: UpdraftConfig = configSchema.parse({
  version: 1,
  maxConcurrent: 10,
  agents: { claude: { maxConcurrent: 5 }, codex: { maxConcurrent: 5 }, kiro: { maxConcurrent: 5 } },
  pools: { general: { agents: ['claude'] }, art: { agents: ['kiro'] }, reviewers: { agents: ['codex'] } },
  actions: { 'implement-issue': {} },
  dispatch: { allowedActors: ['allen'] },
});

const WORKER = 'wrk_history';
let seq = 0;

/** A clock and a DB with the worker lock held, so runs can be started. */
export class History {
  readonly db: Db;
  t: number;
  /** The configuration runs are claimed under. */
  config: UpdraftConfig = historyConfig;

  constructor(start: number, db?: Db) {
    this.t = start;
    this.db = db ?? openDatabase(':memory:');
    const at = new Date(start).toISOString();
    this.db
      .prepare("INSERT OR REPLACE INTO worker_lock (id, worker_id, pid, hostname, started_at, heartbeat_at) VALUES (1, ?, 1, 'host', ?, ?)")
      .run(WORKER, at, at);
  }

  readonly now = () => this.t;
  iso = (offset = 0) => new Date(this.t + offset).toISOString();
  advance(ms: number): this {
    this.t += ms;
    return this;
  }

  /** Queue an issue job now, for a label applied `labelAgo` ms ago. */
  queueIssue(o: { repoId: number; fullName: string; issue: number; pool?: string; labelAgo?: number; routing?: RoutingDecision }): string {
    seq++;
    const id = `job_h${String(seq).padStart(5, '0')}`;
    const url = `https://github.com/${o.fullName}/issues/${o.issue}`;
    const envelope: EventEnvelope = {
      schemaVersion: ENVELOPE_SCHEMA_VERSION,
      type: 'issue.labeled',
      repo: { id: o.repoId, fullName: o.fullName },
      issue: { number: o.issue, title: `Issue ${o.issue}`, url },
      eventId: String(9000 + seq),
      url,
      actor: 'allen',
      label: 'updraft:ready',
      labelsAtEnqueue: ['updraft:ready'],
      createdAt: this.iso(-(o.labelAgo ?? 0)),
      ...(o.routing ? { routing: o.routing } : {}),
    };
    this.db
      .prepare(
        `INSERT INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, 'wf', ?, ?, 'implement-issue', ?, ?, 'queued', 0, ?, ?)`,
      )
      .run(id, o.repoId, o.fullName, envelope.eventId, o.issue, o.pool ?? 'general', JSON.stringify(envelope), this.iso(), this.iso());
    return id;
  }

  /**
   * Claim the oldest queued job after waiting `wait` ms, run its agent for `runMs` and close it
   * with `outcome`. Returns the run id. `launched: false` is a run that entered the executor but
   * failed before its agent process was spawned (checkout preparation, for example): it has an
   * execution start but no agent start. A start_failed run has neither.
   */
  run(
    o: { wait?: number; runMs?: number; outcome?: RunOutcome; verify?: boolean; review?: RunSummary['review']; launched?: boolean; handling?: FailureHandling } = {},
  ): { runId: string; jobId: string } {
    this.advance(o.wait ?? 0);
    const c = claimNextJob(this.db, this.config, { workerId: WORKER, hostname: 'host', leaseSeconds: 3600, runsDir: '/runs', now: this.now });
    if (!c) throw new Error('nothing to claim');
    if (o.outcome !== 'start_failed') {
      markExecutionStarted(this.db, c.run.id, { workerId: WORKER, now: this.now });
      if (o.launched !== false) setRunProcess(this.db, c.run.id, { pid: 4242 }, this.now);
    }
    this.advance(o.runMs ?? 0);
    if (o.verify !== undefined || o.review) {
      const summary: RunSummary = {
        branch: 'b',
        baseSha: 'base',
        headSha: `sha_${c.run.id}`,
        worktree: '/wt',
        commits: [],
        commitCount: 1,
        filesChanged: 1,
        diffStat: '',
        untracked: 0,
        lastOutput: [],
        notes: [],
        ...(o.verify !== undefined ? { verification: { passed: o.verify, commands: [], uncommittedBefore: 0, uncommittedAfter: 0, sha: `sha_${c.run.id}`, exact: true } } : {}),
        ...(o.review ? { review: o.review } : {}),
      };
      setRunSummary(this.db, c.run.id, summary);
    }
    finishRun(this.db, c.run.id, { outcome: o.outcome ?? 'succeeded', ...(o.outcome === 'failed' ? { error: 'agent failed' } : {}), ...(o.handling ? { handling: o.handling } : {}), now: this.now });
    return { runId: c.run.id, jobId: c.job.id };
  }

  /** Publish a succeeded run as PR `pr` after `delay` ms, and start watching it. */
  publish(runId: string, o: { repoId: number; fullName: string; issue: number; pr: number; delay?: number }): void {
    this.advance(o.delay ?? 0);
    const job = this.db.prepare('SELECT job_id FROM runs WHERE id = ?').get(runId) as { job_id: string };
    const b = beginPublication(this.db, {
      runId,
      jobId: job.job_id,
      repoId: o.repoId,
      repoFullName: o.fullName,
      issueNumber: o.issue,
      mode: 'draft-pr',
      branch: `updraft/issue-${o.issue}`,
      leaseSeconds: 600,
      now: this.now,
    });
    if (!b.ok) throw new Error('publication not begun');
    const fence = { attempt: b.publication.attempts, leaseSeconds: 600, now: this.now };
    recordPublicationProgress(this.db, runId, fence, {
      baseBranch: 'main',
      headSha: `sha_${runId}`,
      pushedAt: this.iso(),
      prNumber: o.pr,
      prUrl: `https://github.com/${o.fullName}/pull/${o.pr}`,
    });
    finishPublication(this.db, runId, fence.attempt, { state: 'published', now: this.now });
    syncRevisionPrs(this.db, o.repoId, this.now);
    adoptOwnPushes(this.db, o.repoId, this.now);
  }

  /** Queue and run the reviewer job of the PR's current head, and record its verdict. Returns the reviewer run id. */
  review(o: {
    repoId: number;
    fullName: string;
    pr: number;
    verdict: ReviewVerdict;
    findings: number | null;
    wait?: number;
    runMs?: number;
    /** Queue the revision the verdict asks for (default true for changes-requested). */
    revise?: boolean;
    max?: number;
  }): string {
    const pr = getLoopPr(this.db, o.repoId, o.pr)!;
    const job = enqueueReviewJob(this.db, { repo: { id: o.repoId, fullName: o.fullName }, pr, pool: 'reviewers', allowedActors: ['allen'], now: this.now });
    if (!job) throw new Error('no review job queued');
    const { runId } = this.run({
      wait: o.wait,
      runMs: o.runMs,
      review: { headSha: pr.headSha!, baseSha: 'base', verdict: o.verdict, findings: 'text that must not reach the rollup', findingsCount: o.findings },
    });
    beginPrReview(this.db, {
      runId,
      jobId: job.id,
      repoId: o.repoId,
      repoFullName: o.fullName,
      issueNumber: pr.issueNumber,
      prNumber: o.pr,
      headSha: pr.headSha!,
      agent: 'codex',
      verdict: o.verdict,
      findings: 'text that must not reach the rollup',
      findingsCount: o.findings,
      leaseSeconds: 600,
      now: this.now,
    });
    finishPrReview(this.db, runId, 1, { state: 'published', now: this.now });
    if (o.verdict === 'changes-requested' && o.revise !== false) {
      this.changeRequest({ ...o, trigger: 'updraft_review', reviewId: `updraft-review:${runId}`, max: o.max });
    }
    return runId;
  }

  /** A change request on the PR (by a person unless `trigger` says otherwise), queueing a revision job within `max`. */
  changeRequest(o: { repoId: number; fullName: string; pr: number; reviewId: string; trigger?: 'changes_requested' | 'updraft_review'; max?: number }) {
    const w = getRevisionPr(this.db, o.repoId, o.pr)!;
    const trigger = o.trigger ?? 'changes_requested';
    const review = { id: o.reviewId, url: 'https://example.invalid/r', author: 'allen', submittedAt: this.iso(), body: 'please change it', comments: [], omittedComments: 0 };
    const revision = { trigger, pullRequest: { number: o.pr, url: w.prUrl, branch: w.branch }, sourceRunId: w.sourceRunId, originalEventId: w.originalEventId, review };
    return enqueueRevision(
      this.db,
      {
        repoId: o.repoId,
        reviewId: o.reviewId,
        prNumber: o.pr,
        reviewer: 'allen',
        trigger,
        reviewUrl: review.url,
        submittedAt: review.submittedAt,
        job: revisionJob({ id: o.repoId, fullName: o.fullName }, w, revision),
        max: o.max ?? 3,
      },
      this.now,
    );
  }

  /** Run the queued revision job and push its commits to the PR. Returns the revision run id. */
  revise(o: { repoId: number; fullName: string; pr: number; wait?: number; runMs?: number; outcome?: RunOutcome }): string {
    const { runId, jobId } = this.run({ wait: o.wait, runMs: o.runMs, outcome: o.outcome, verify: true });
    if (o.outcome && o.outcome !== 'succeeded') return runId;
    const w = getRevisionPr(this.db, o.repoId, o.pr)!;
    const request = this.db.prepare('SELECT review_id, trigger_kind FROM review_requests WHERE job_id = ?').get(jobId) as { review_id: string; trigger_kind: 'changes_requested' };
    const b = beginRevision(this.db, {
      runId,
      jobId,
      repoId: o.repoId,
      repoFullName: o.fullName,
      issueNumber: w.issueNumber,
      prNumber: o.pr,
      reviewId: request.review_id,
      trigger: request.trigger_kind,
      branch: w.branch,
      baseSha: 'base',
      leaseSeconds: 600,
      now: this.now,
    });
    if (!b.ok) throw new Error('revision not begun');
    const fence = { attempt: b.revision.attempts, leaseSeconds: 600, now: this.now };
    holdRevision(this.db, runId, fence, { headSha: `sha_${runId}`, pushedAt: this.iso() });
    finishRevision(this.db, runId, fence.attempt, { state: 'published', now: this.now });
    adoptOwnPushes(this.db, o.repoId, this.now);
    return runId;
  }

  /** Auto-merge the PR's current head: merged, or blocked with a reason. */
  merge(o: { repoId: number; pr: number; step: Extract<MergeStep, { state: 'merged' | 'blocked' }>; delay?: number }): void {
    this.advance(o.delay ?? 0);
    const pr = getLoopPr(this.db, o.repoId, o.pr)!;
    startMergeFor(this.db, o.repoId, o.pr, pr.headSha!, this.now);
    setMergeState(this.db, o.repoId, o.pr, pr.headSha!, o.step, this.now);
  }
}

/** Facts of the routing and selection kinds: written live only, never backfilled (src/db/metrics.ts). */
const ROUTING_KINDS = "('route.decided', 'run.selected', 'job.retried', 'capacity.cooldown', 'job.deferred', 'job.escalated')";
/** The columns migration 16 added; the original facts are compared without them. */
const V16_COLUMNS = ['tier', 'requested_tier', 'risk', 'adapter', 'model', 'effort', 'model_source', 'route_source', 'confidence', 'hops', 'retries', 'head_sha'];

/** Every original-kind row of metric_events without the columns that differ between a live record and a backfill. */
export function metricRows(db: Db): Array<Record<string, unknown>> {
  return (
    db.prepare(`SELECT * FROM metric_events WHERE kind NOT IN ${ROUTING_KINDS} ORDER BY kind, subject_id`).all() as Array<Record<string, unknown>>
  ).map(({ id: _id, backfilled: _b, recorded_at: _r, ...rest }) => Object.fromEntries(Object.entries(rest).filter(([k]) => !V16_COLUMNS.includes(k))));
}

/** The routing and selection facts, by kind and subject. */
export function routingRows(db: Db): Array<Record<string, unknown>> {
  return (db.prepare(`SELECT * FROM metric_events WHERE kind IN ${ROUTING_KINDS} ORDER BY kind, subject_id`).all() as Array<Record<string, unknown>>).map(
    ({ id: _id, backfilled: _b, recorded_at: _r, ...rest }) => rest,
  );
}

/**
 * A small but complete history in two repositories, over the 40 days before `end`:
 *
 * octo/widgets (42)
 * - issue 1, 35 days ago: claude implements it (wait 2m, run 10m), PR #101 opened 1h after the
 *   label; codex reviews it (changes requested, 2 findings), claude revises it, codex finds it ready
 *   (0 findings); auto-merge merges it. Outside a 30-day window.
 * - issue 2, 5 days ago: claude implements it (wait 1m, run 20m, label 30m earlier), PR #102;
 *   codex requests changes (3 findings), a person requests changes too, claude revises twice;
 *   codex requests changes again with no readable count; the limit (max 2) is reached; a second
 *   person's request is refused.
 * - issue 3, 4 days ago: claude fails (verify failed); retried, succeeds; PR #103; codex finds
 *   the first head ready (1 finding); auto-merge is blocked by failing checks.
 * - issue 4, 3 days ago: claude fails outright (no verify ran).
 * - issue 5: queued now; issue 6: running now.
 *
 * octo/art (7)
 * - issue 9, 2 days ago: kiro implements it (wait 4m, run 30m), PR #9 opened; codex finds it ready
 *   (no count line). Merged by Updraft.
 */
export function buildHistory(end: number, db?: Db): History {
  const h = new History(end - 40 * DAY, db);
  const W = { repoId: 42, fullName: 'octo/widgets' };
  const A = { repoId: 7, fullName: 'octo/art' };

  // widgets #1 (35 days before end)
  h.advance(5 * DAY);
  h.queueIssue({ ...W, issue: 1, labelAgo: 30 * MIN });
  let r = h.run({ wait: 2 * MIN, runMs: 10 * MIN, verify: true });
  h.publish(r.runId, { ...W, issue: 1, pr: 101, delay: 18 * MIN });
  h.review({ ...W, pr: 101, verdict: 'changes-requested', findings: 2, wait: MIN, runMs: 5 * MIN });
  h.revise({ ...W, pr: 101, wait: MIN, runMs: 8 * MIN });
  h.review({ ...W, pr: 101, verdict: 'ready-to-merge', findings: 0, wait: MIN, runMs: 4 * MIN });
  h.merge({ ...W, pr: 101, step: { state: 'merged', mergeCommitSha: 'm101' }, delay: 30 * MIN });

  // widgets #2 (5 days before end)
  h.t = end - 5 * DAY;
  h.queueIssue({ ...W, issue: 2, labelAgo: 30 * MIN });
  r = h.run({ wait: MIN, runMs: 20 * MIN, verify: true });
  h.publish(r.runId, { ...W, issue: 2, pr: 102, delay: 9 * MIN });
  h.review({ ...W, pr: 102, verdict: 'changes-requested', findings: 3, wait: MIN, runMs: 6 * MIN, max: 2 });
  h.revise({ ...W, pr: 102, wait: MIN, runMs: 12 * MIN });
  h.advance(10 * MIN);
  h.changeRequest({ ...W, pr: 102, reviewId: 'PRR_human_1', max: 2 });
  h.revise({ ...W, pr: 102, wait: 2 * MIN, runMs: 6 * MIN });
  h.review({ ...W, pr: 102, verdict: 'changes-requested', findings: null, wait: MIN, runMs: 7 * MIN, max: 2 });
  h.advance(HOUR);
  h.changeRequest({ ...W, pr: 102, reviewId: 'PRR_human_2', max: 2 });

  // widgets #3 (4 days before end)
  h.t = end - 4 * DAY;
  const j3 = h.queueIssue({ ...W, issue: 3, labelAgo: 10 * MIN });
  h.run({ wait: 3 * MIN, runMs: 15 * MIN, verify: false, outcome: 'failed' });
  h.advance(HOUR);
  retryJob(h.db, j3, h.now);
  r = h.run({ wait: MIN, runMs: 9 * MIN, verify: true });
  h.publish(r.runId, { ...W, issue: 3, pr: 103, delay: 5 * MIN });
  h.review({ ...W, pr: 103, verdict: 'ready-to-merge', findings: 1, wait: MIN, runMs: 3 * MIN });
  h.merge({ ...W, pr: 103, step: { state: 'blocked', reason: '1 check(s) of abc did not pass: test', code: 'checks-failed' }, delay: 20 * MIN });

  // widgets #4 (3 days before end)
  h.t = end - 3 * DAY;
  h.queueIssue({ ...W, issue: 4 });
  h.run({ wait: 5 * MIN, runMs: 2 * MIN, outcome: 'failed' });

  // art #9 (2 days before end)
  h.t = end - 2 * DAY;
  h.queueIssue({ ...A, issue: 9, pool: 'art', labelAgo: HOUR });
  r = h.run({ wait: 4 * MIN, runMs: 30 * MIN, verify: true });
  h.publish(r.runId, { ...A, issue: 9, pr: 9, delay: 6 * MIN });
  h.review({ ...A, pr: 9, verdict: 'ready-to-merge', findings: null, wait: 2 * MIN, runMs: 5 * MIN });
  h.merge({ ...A, pr: 9, step: { state: 'merged', mergeCommitSha: 'm9' }, delay: 3 * HOUR });

  // Now: one running, one queued.
  h.t = end - 10 * MIN;
  h.queueIssue({ ...W, issue: 6 });
  h.advance(MIN);
  const c = claimNextJob(h.db, historyConfig, { workerId: WORKER, hostname: 'host', leaseSeconds: 3600, runsDir: '/runs', now: h.now })!;
  markExecutionStarted(h.db, c.run.id, { workerId: WORKER, now: h.now });
  setRunProcess(h.db, c.run.id, { pid: 4242 }, h.now);
  h.queueIssue({ ...W, issue: 5 });
  h.t = end;
  return h;
}
