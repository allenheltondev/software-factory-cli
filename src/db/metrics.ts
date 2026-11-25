// The operator rollup behind `updraft stats` (docs/stats.md): metric_events, an append-only table
// of facts, one row per fact. It exists so that `updraft clean --older-than` never makes the
// numbers undercount: prune.ts deletes jobs, runs and what hangs off them, never these rows.
//
// Rules every writer here follows:
// - One row per fact, keyed by (kind, subject_id). Every insert is ON CONFLICT DO NOTHING, so a
//   replay, a retry or a restart that records the same fact again changes nothing.
// - Written in the same transaction as the state change it describes, by the function that makes
//   that change (see the callers of each note* function), so the rollup cannot drift from state.
// - Ids, numbers, timestamps, agent and pool names and outcomes only. Never issue text, review or
//   findings text, paths, error messages or logs. Free-text reasons are reduced to fixed codes.
// - A row is built from the state rows it describes by one SELECT per kind (SOURCES below). The
//   live writers and the backfill of migration 13 run the same SELECTs, so an upgraded install's
//   history is computed exactly as new facts are. Migration 13 runs them against the v13 schema:
//   a later change that makes a SELECT read a newer column must give migration 13 its own copy.
import { agentProfile } from '../agents/profile.js';
import { workflowId, type TierConfig, type UpdraftConfig } from '../config/schema.js';
import { nowIso } from '../util/ids.js';
import type { Db } from './database.js';

export type MetricKind =
  /** A run was closed (by finishRun or closeClaim). subject: run id. */
  | 'run.ended'
  /** A job reached a terminal status. subject: "<job id>:<attempts>:<status>", so a job that is retried and finishes again is a new fact. */
  | 'job.finished'
  /** A publication opened (or adopted) a PR. subject: "<repo id>#<pr>". */
  | 'pr.opened'
  /** Updraft's auto-merge merged a PR. subject: "<repo id>#<pr>". */
  | 'pr.merged'
  /** Auto-merge gave up on one head of a PR (final for that head). subject: "<repo id>#<pr>@<head sha>". */
  | 'pr.merge_blocked'
  /** A PR's first change request refused by maxRevisions. subject: "<repo id>#<pr>". */
  | 'pr.limit_reached'
  /** The verdict of one reviewer run was recorded. subject: run id. */
  | 'review.verdict'
  /** A change request on a watched PR was recorded (by a person or by Updraft's reviewer). subject: "<repo id>:<review id>". */
  | 'change_request'
  /** A revision run's commits were pushed to its PR. subject: run id. */
  | 'revision.pushed';

export const METRIC_KINDS: readonly MetricKind[] = [
  'run.ended',
  'job.finished',
  'pr.opened',
  'pr.merged',
  'pr.merge_blocked',
  'pr.limit_reached',
  'review.verdict',
  'change_request',
  'revision.pushed',
];

/**
 * Why auto-merge gave up on a head, as a fixed code (the recorded reason is free text that can
 * name checks, people and GitHub's messages, and stays on revision_prs).
 */
export type MergeBlockCode =
  /** The action or workflow is no longer in the config. */
  | 'config'
  /** No record that the action's verify commands passed on exactly that commit. */
  | 'not-verified'
  /** The PR's base branch changed, or is not on record. */
  | 'base-changed'
  /** The PR is still a draft. */
  | 'draft'
  /** GitHub reports a conflict. */
  | 'unmergeable'
  /** An allowed actor's "Request changes" review is outstanding. */
  | 'changes-requested'
  /** A check of the commit failed. */
  | 'checks-failed'
  /** The checks could not all be read. */
  | 'checks-unreadable'
  /** Pending checks, or no successful check, until autoMergeWaitMinutes ran out. */
  | 'wait-timeout'
  /** GitHub refused or declined the merge request. */
  | 'merge-refused'
  /** The merge request got no answer, repeatedly. */
  | 'no-answer'
  /** GitHub could not be asked what the merge needs to know. */
  | 'github-error'
  /** A reason recorded before codes existed that matches none of the above. */
  | 'other';

export const MERGE_BLOCK_CODES: readonly MergeBlockCode[] = [
  'config',
  'not-verified',
  'base-changed',
  'draft',
  'unmergeable',
  'changes-requested',
  'checks-failed',
  'checks-unreadable',
  'wait-timeout',
  'merge-refused',
  'no-answer',
  'github-error',
  'other',
];

/**
 * The code of a merge_reason recorded before codes existed (migration 13's backfill). Live
 * blocks pass their code explicitly (src/publish/merge.ts); this only reads the wording of the
 * reasons merge.ts wrote, as SQL so it runs inside the migration.
 */
export function mergeReasonCodeSql(reason: string): string {
  const r = reason;
  return `(CASE
    WHEN ${r} IS NULL THEN 'other'
    WHEN ${r} LIKE 'gave up after waiting %' THEN 'wait-timeout'
    WHEN ${r} LIKE 'action "%' OR ${r} LIKE 'workflow "%' THEN 'config'
    WHEN ${r} LIKE '% was not pushed by an Updraft run%' OR ${r} LIKE 'there is no record that the verify commands passed%'
      OR ${r} LIKE 'the verify commands of run %' THEN 'not-verified'
    WHEN ${r} LIKE 'the merge was requested % times without an answer%' THEN 'no-answer'
    WHEN ${r} LIKE 'the branch this pull request was opened against%' OR ${r} LIKE 'its base branch is now %' THEN 'base-changed'
    WHEN ${r} = 'it is still a draft' THEN 'draft'
    WHEN ${r} LIKE 'GitHub reports that it cannot be merged%' THEN 'unmergeable'
    WHEN ${r} LIKE 'a "Request changes" review by %' THEN 'changes-requested'
    WHEN ${r} LIKE '% check(s) of % did not pass%' THEN 'checks-failed'
    WHEN ${r} LIKE 'the checks of % could not all be read%' THEN 'checks-unreadable'
    WHEN ${r} LIKE 'GitHub did not merge it%' OR ${r} LIKE 'GitHub refused the merge%' THEN 'merge-refused'
    WHEN ${r} LIKE 'GitHub could not be asked%' THEN 'github-error'
    ELSE 'other' END)`;
}

const COLUMNS =
  '(kind, subject_id, at, repo_id, repo_full_name, job_id, job_kind, pr_number, agent, pool, outcome, reason, start_at, wait_ms, findings, backfilled, recorded_at)';

/** The job kind of a jobs.envelope: implement, revision or review. NULL for an envelope that is not valid JSON. */
const KIND_OF = (env: string) =>
  `(CASE WHEN json_valid(${env}) THEN CASE json_extract(${env}, '$.type') WHEN 'issue.labeled' THEN 'implement' ` +
  `WHEN 'pull_request.changes_requested' THEN 'revision' WHEN 'pull_request.review' THEN 'review' END END)`;

/** The PR a revision or reviewer job is about, from its envelope. */
const PR_OF = (env: string) =>
  `(CASE WHEN json_valid(${env}) THEN coalesce(json_extract(${env}, '$.review.pullRequest.number'), json_extract(${env}, '$.revision.pullRequest.number')) END)`;

const MS_BETWEEN = (from: string, to: string) => `CAST(round((julianday(${to}) - julianday(${from})) * 86400000) AS INTEGER)`;

/** owner/name of a repository id, for tables that do not record it (revision_prs, review_requests). */
const REPO_NAME = (id: string) =>
  `coalesce((SELECT j2.repo_full_name FROM jobs j2 WHERE j2.repo_id = ${id} ORDER BY j2.created_at DESC LIMIT 1), ` +
  `(SELECT c.full_name FROM repo_checkpoints c WHERE c.repo_id = ${id}), ` +
  `(SELECT m.repo_full_name FROM metric_events m WHERE m.repo_id = ${id} AND m.repo_full_name IS NOT NULL ORDER BY m.at DESC LIMIT 1))`;

const TAIL = '$backfilled, $recorded';

/**
 * One SELECT per kind, each yielding COLUMNS, over every state row that is such a fact. A writer
 * narrows it to the row it just changed; the backfill runs it whole. `reason` overrides the
 * reason column where the live writer knows more than the rows do (merge block codes).
 */
const SOURCES: Record<MetricKind, (o?: { reason?: string }) => string> = {
  // outcome: the run's outcome, or 'canceled' (the user asked) / 'not-started' (closed before its
  // agent started) for a run closed without one. start_at: when the agent process was spawned
  // (runs.agent_started_at), NULL when it never was: a start_failed run, or one that failed while
  // its checkout was prepared, has no agent run time. wait_ms: for the job's first run whose agent
  // was spawned, how long the job waited from being queued; attempts that never launched an agent
  // do not end the wait.
  'run.ended': () => `
    SELECT 'run.ended', r.id, r.ended_at, j.repo_id, j.repo_full_name, j.id, ${KIND_OF('j.envelope')}, ${PR_OF('j.envelope')}, r.agent, r.pool,
      coalesce(r.outcome, CASE WHEN r.cancel_requested_at IS NOT NULL THEN 'canceled' ELSE 'not-started' END),
      CASE WHEN json_valid(r.summary) THEN CASE json_extract(r.summary, '$.verification.passed') WHEN 1 THEN 'verify-passed' WHEN 0 THEN 'verify-failed' END END,
      r.agent_started_at,
      CASE WHEN r.agent_started_at IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM runs p WHERE p.job_id = r.job_id AND p.id != r.id AND p.agent_started_at IS NOT NULL
            AND (p.agent_started_at < r.agent_started_at OR (p.agent_started_at = r.agent_started_at AND p.attempt < r.attempt)))
        THEN ${MS_BETWEEN('j.created_at', 'r.agent_started_at')} END,
      NULL, ${TAIL}
    FROM runs r JOIN jobs j ON j.id = r.job_id
    WHERE r.ended_at IS NOT NULL`,
  // agent: of the job's latest run. start_at: when the job was queued. subject: the job with its
  // attempts (bumped by each claim) and retries (bumped by each "updraft retry"), so every terminal
  // state the job reaches is its own fact, including two with no claim in between (canceled,
  // retried, canceled again).
  'job.finished': () => `
    SELECT 'job.finished', j.id || ':' || j.attempts || ':' || j.retries || ':' || j.status, j.updated_at, j.repo_id, j.repo_full_name, j.id,
      ${KIND_OF('j.envelope')}, ${PR_OF('j.envelope')},
      (SELECT r.agent FROM runs r WHERE r.job_id = j.id ORDER BY r.attempt DESC LIMIT 1), j.pool, j.status, NULL,
      j.created_at, NULL, NULL, ${TAIL}
    FROM jobs j
    WHERE j.status IN ('succeeded', 'failed', 'interrupted', 'canceled')`,
  // at: when the publication finished. start_at: when the trigger label was applied (the label
  // event's time on GitHub). outcome: draft-pr or pr.
  'pr.opened': () => `
    SELECT 'pr.opened', p.repo_id || '#' || p.pr_number, p.published_at, p.repo_id, p.repo_full_name, p.job_id,
      ${KIND_OF('j.envelope')}, p.pr_number, r.agent, coalesce(r.pool, j.pool), p.mode, NULL,
      CASE WHEN json_valid(j.envelope) THEN json_extract(j.envelope, '$.createdAt') END, NULL, NULL, ${TAIL}
    FROM publications p LEFT JOIN jobs j ON j.id = p.job_id LEFT JOIN runs r ON r.id = p.run_id
    WHERE p.state = 'published' AND p.pr_number IS NOT NULL AND p.published_at IS NOT NULL`,
  // start_at: when the PR was opened (its pr.opened fact, unless that time is only approximate).
  'pr.merged': () => `
    SELECT 'pr.merged', w.repo_id || '#' || w.pr_number, w.merged_at, w.repo_id, ${REPO_NAME('w.repo_id')}, NULL, NULL, w.pr_number,
      w.author_agent, w.pool, 'merged', NULL,
      coalesce(
        (SELECT m.at FROM metric_events m WHERE m.kind = 'pr.opened' AND m.subject_id = w.repo_id || '#' || w.pr_number AND m.reason IS NULL),
        (SELECT min(p.published_at) FROM publications p WHERE p.repo_id = w.repo_id AND p.pr_number = w.pr_number AND p.state = 'published')),
      NULL, NULL, ${TAIL}
    FROM revision_prs w
    WHERE w.merge_state = 'merged' AND w.merged_at IS NOT NULL`,
  // reason: a MergeBlockCode.
  'pr.merge_blocked': (o) => `
    SELECT 'pr.merge_blocked', w.repo_id || '#' || w.pr_number || '@' || w.merge_sha, w.updated_at, w.repo_id, ${REPO_NAME('w.repo_id')}, NULL, NULL,
      w.pr_number, w.author_agent, w.pool, 'blocked', ${o?.reason ?? mergeReasonCodeSql('w.merge_reason')}, NULL, NULL, NULL, ${TAIL}
    FROM revision_prs w
    WHERE w.merge_state = 'blocked' AND w.merge_sha IS NOT NULL`,
  'pr.limit_reached': () => `
    SELECT 'pr.limit_reached', w.repo_id || '#' || w.pr_number, w.limit_reached_at, w.repo_id, ${REPO_NAME('w.repo_id')}, NULL, NULL, w.pr_number,
      w.author_agent, w.pool, 'limit-reached', NULL, NULL, NULL, NULL, ${TAIL}
    FROM revision_prs w
    WHERE w.limit_reached_at IS NOT NULL`,
  // outcome: the verdict. findings: the reviewer's UPDRAFT-FINDINGS count, or NULL.
  'review.verdict': () => `
    SELECT 'review.verdict', v.run_id, v.created_at, v.repo_id, v.repo_full_name, v.job_id, 'review', v.pr_number, v.agent, r.pool,
      v.verdict, NULL, NULL, NULL, v.findings_count, ${TAIL}
    FROM pr_reviews v LEFT JOIN runs r ON r.id = v.run_id
    WHERE true`,
  // outcome: what was decided (queued, over-limit, ignored, not-allowed). reason: who asked
  // (changes_requested: a person's review; updraft_review: Updraft's reviewer). No login is kept.
  change_request: () => `
    SELECT 'change_request', q.repo_id || ':' || q.review_id, q.created_at, q.repo_id, ${REPO_NAME('q.repo_id')}, q.job_id, NULL, q.pr_number,
      NULL, NULL, q.state, q.trigger_kind, NULL, NULL, NULL, ${TAIL}
    FROM review_requests q
    WHERE true`,
  // reason: who asked for the revision (as for change_request).
  'revision.pushed': () => `
    SELECT 'revision.pushed', v.run_id, v.pushed_at, v.repo_id, v.repo_full_name, v.job_id, 'revision', v.pr_number, r.agent, r.pool,
      NULL, v.trigger_kind, NULL, NULL, NULL, ${TAIL}
    FROM revisions v LEFT JOIN runs r ON r.id = v.run_id
    WHERE v.pushed_at IS NOT NULL`,
};

const INSERT = (select: string, filter: string) => `INSERT INTO metric_events ${COLUMNS} ${select} ${filter} ON CONFLICT (kind, subject_id) DO NOTHING`;

function note(db: Db, kind: MetricKind, filter: string, params: Record<string, string | number | null>, o?: { reason?: string }): void {
  db.prepare(INSERT(SOURCES[kind](o), filter)).run({ ...params, backfilled: 0, recorded: nowIso() });
}

// ---------------------------------------------------------------------------
// Live writers. Each is called inside the transaction of the state change it records, right
// after that change, and records nothing when the rows do not (yet) describe the fact.
// ---------------------------------------------------------------------------

/** After a run was closed. */
export function noteRunEnded(db: Db, runId: string): void {
  note(db, 'run.ended', 'AND r.id = $id', { id: runId });
}

/** After a job's status changed; records something only when it is now terminal. */
export function noteJobFinished(db: Db, jobId: string): void {
  note(db, 'job.finished', 'AND j.id = $id', { id: jobId });
}

/** After a publication was finished; records something only when it is published with a PR. */
export function notePrOpened(db: Db, runId: string): void {
  note(db, 'pr.opened', 'AND p.run_id = $id', { id: runId });
}

/** After auto-merge recorded a PR as merged. */
export function notePrMerged(db: Db, repoId: number, prNumber: number): void {
  note(db, 'pr.merged', 'AND w.repo_id = $repo AND w.pr_number = $pr', { repo: repoId, pr: prNumber });
}

/** After auto-merge recorded a head of a PR as blocked, with the code of its reason. */
export function noteMergeBlocked(db: Db, repoId: number, prNumber: number, code: MergeBlockCode): void {
  note(db, 'pr.merge_blocked', 'AND w.repo_id = $repo AND w.pr_number = $pr', { repo: repoId, pr: prNumber, code }, { reason: '$code' });
}

/** After a PR was stamped with limit_reached_at. */
export function noteLimitReached(db: Db, repoId: number, prNumber: number): void {
  note(db, 'pr.limit_reached', 'AND w.repo_id = $repo AND w.pr_number = $pr', { repo: repoId, pr: prNumber });
}

/**
 * After the verdict of a reviewer run was first written down (its pr_reviews row). The PR head
 * commit it reviewed is stored on the fact (a column added by migration 16, written with it).
 */
export function noteReview(db: Db, runId: string): void {
  note(db, 'review.verdict', 'AND v.run_id = $id', { id: runId });
  db.prepare(
    `UPDATE metric_events SET head_sha = (SELECT head_sha FROM pr_reviews WHERE run_id = $id)
     WHERE kind = 'review.verdict' AND subject_id = $id AND head_sha IS NULL`,
  ).run({ id: runId });
}

/** After a change request was recorded. */
export function noteChangeRequest(db: Db, repoId: number, reviewId: string): void {
  note(db, 'change_request', 'AND q.repo_id = $repo AND q.review_id = $review', { repo: repoId, review: reviewId });
}

/** After a revision's push was recorded; records something only once pushed_at is set. */
export function noteRevisionPushed(db: Db, runId: string): void {
  note(db, 'revision.pushed', 'AND v.run_id = $id', { id: runId });
  db.prepare(
    `UPDATE metric_events SET head_sha = (SELECT head_sha FROM revisions WHERE run_id = $id)
     WHERE kind = 'revision.pushed' AND subject_id = $id AND head_sha IS NULL`,
  ).run({ id: runId });
}

// ---------------------------------------------------------------------------
// Routing and selection facts (docs/stats.md, "Model tiers"). Written by the code that makes the
// decision, with the same one-row-per-fact idempotency as above. They are never backfilled: a
// database from before they existed reports those runs as unknown.
// ---------------------------------------------------------------------------

export type RoutingMetricKind =
  /** The router chose a pool for a new job (at enqueue). subject: job id. */
  | 'route.decided'
  /** A run was selected for a job: the claim picked an agent profile. subject: run id. */
  | 'run.selected'
  /** "updraft retry" requeued a job. subject: "<job id>:<retries after>". */
  | 'job.retried'
  /** A usage limit started (or extended) a cooldown. subject: run id. */
  | 'capacity.cooldown'
  /** A job was requeued to wait out a usage limit. subject: "<job id>:<deferrals after>". */
  | 'job.deferred'
  /** A job was moved to a more capable tier. subject: "<job id>:<hops after>". */
  | 'job.escalated'
  /** A run declared a wait on another repository's pull request (docs/dependencies.md). subject: run id. */
  | 'dependency.waiting'
  /** That wait ended; outcome resumed | closed | canceled | expired, start_at when it began. subject: run id. */
  | 'dependency.ended';

export const ROUTING_METRIC_KINDS: readonly RoutingMetricKind[] = [
  'route.decided',
  'run.selected',
  'job.retried',
  'capacity.cooldown',
  'job.deferred',
  'job.escalated',
  'dependency.waiting',
  'dependency.ended',
];

export type Tier = 'routine' | 'standard' | 'complex' | 'high-risk';
export type RouteSource = 'override' | 'local-rule' | 'cli-triage' | 'fallback' | 'legacy-label' | 'default';

interface RoutingFact {
  kind: RoutingMetricKind;
  subject: string;
  at: string;
  repoId: number;
  repoFullName: string | null;
  jobId: string | null;
  jobKind?: string | null;
  agent?: string | null;
  pool?: string | null;
  outcome?: string | null;
  reason?: string | null;
  startAt?: string | null;
  waitMs?: number | null;
  tier?: string | null;
  requestedTier?: string | null;
  risk?: string | null;
  adapter?: string | null;
  model?: string | null;
  effort?: string | null;
  modelSource?: string | null;
  routeSource?: string | null;
  confidence?: number | null;
  hops?: number | null;
  retries?: number | null;
}

function insertRouting(db: Db, f: RoutingFact): void {
  db.prepare(
    `INSERT INTO metric_events (kind, subject_id, at, repo_id, repo_full_name, job_id, job_kind, agent, pool, outcome, reason, start_at, wait_ms,
       backfilled, recorded_at, tier, requested_tier, risk, adapter, model, effort, model_source, route_source, confidence, hops, retries)
     VALUES ($kind, $subject, $at, $repo, $name, $job, $jobKind, $agent, $pool, $outcome, $reason, $startAt, $waitMs,
       0, $recorded, $tier, $requested, $risk, $adapter, $model, $effort, $modelSource, $routeSource, $confidence, $hops, $retries)
     ON CONFLICT (kind, subject_id) DO NOTHING`,
  ).run({
    kind: f.kind,
    subject: f.subject,
    at: f.at,
    repo: f.repoId,
    name: f.repoFullName,
    job: f.jobId,
    jobKind: f.jobKind ?? null,
    agent: f.agent ?? null,
    pool: f.pool ?? null,
    outcome: f.outcome ?? null,
    reason: f.reason ?? null,
    startAt: f.startAt ?? null,
    waitMs: f.waitMs ?? null,
    recorded: nowIso(),
    tier: f.tier ?? null,
    requested: f.requestedTier ?? null,
    risk: f.risk ?? null,
    adapter: f.adapter ?? null,
    model: f.model ?? null,
    effort: f.effort ?? null,
    modelSource: f.modelSource ?? null,
    routeSource: f.routeSource ?? null,
    confidence: f.confidence ?? null,
    hops: f.hops ?? null,
    retries: f.retries ?? null,
  });
}

interface RoutingNote {
  rule?: string;
  tier?: string;
  risk?: string;
  confidence?: number;
  uncertain?: boolean;
  triage?: { origin?: string };
}

/** What a job's envelope says about its kind and routing; tolerant of anything unexpected. */
function envelopeOf(envelope: string): { kind: string | null; routing: RoutingNote | null } {
  try {
    const e = JSON.parse(envelope) as { type?: string; routing?: RoutingNote };
    const kind = e.type === 'issue.labeled' ? 'implement' : e.type === 'pull_request.changes_requested' ? 'revision' : e.type === 'pull_request.review' ? 'review' : null;
    return { kind, routing: e.routing && typeof e.routing === 'object' ? e.routing : null };
  } catch {
    return { kind: null, routing: null };
  }
}

const TIERS: readonly string[] = ['routine', 'standard', 'complex', 'high-risk'];
const RISKS: readonly string[] = ['low', 'medium', 'high'];
const tierOrNull = (t: unknown): Tier | null => (typeof t === 'string' && TIERS.includes(t) ? (t as Tier) : null);

/** How the pool of a job was chosen, as a fixed code. */
export function routeSourceOf(r: RoutingNote | null): RouteSource | null {
  if (!r?.rule) return null;
  switch (r.rule) {
    case 'override-label':
      return 'override';
    case 'legacy-label':
      return 'legacy-label';
    case 'triage':
      return 'cli-triage';
    case 'heuristic':
      return r.triage?.origin === 'fallback' ? 'fallback' : 'local-rule';
    case 'default':
      return 'default';
    default:
      return null;
  }
}

/** A fixed code for why the route is what it is; never the free-text detail. */
export function routeReasonCode(r: RoutingNote | null): string | null {
  if (!r?.rule) return null;
  if (r.rule === 'triage') return r.triage?.origin === 'cache' ? 'triage-cached' : 'triage-answered';
  if (r.rule === 'heuristic') return r.triage?.origin === 'fallback' ? 'triage-unavailable' : r.uncertain ? 'low-confidence' : 'confident';
  return r.rule;
}

/** A configured model or effort value kept only when it looks like one (no paths, no free text). */
const safeSetting = (v: string | null | undefined): string | null => (v && v.length <= 80 && /^[A-Za-z0-9._:@+/-]+$/.test(v) && !v.startsWith('/') && !v.includes('..') ? v : null);

/** The pool the configuration gives a tier. */
const poolOfTier = (t: TierConfig, tier: Tier): string | undefined => (tier === 'high-risk' ? t.highRisk?.pool : t.pools[tier]);

/** The tier whose pool this is, when the configuration names one. */
export function tierOfPool(t: TierConfig | undefined, pool: string): Tier | null {
  if (!t) return null;
  if (t.highRisk?.pool === pool) return 'high-risk';
  for (const tier of ['routine', 'standard', 'complex'] as const) if (t.pools[tier] === pool) return tier;
  return null;
}

/** After a poll batch inserted a job: the router's decision, when tier routing made one. */
export function noteRouteDecided(db: Db, job: { id: string; repoId: number; repoFullName: string; envelope: string; at: string }): void {
  const { kind, routing } = envelopeOf(job.envelope);
  const tier = tierOrNull(routing?.tier);
  if (!routing || !tier) return;
  insertRouting(db, {
    kind: 'route.decided',
    subject: job.id,
    at: job.at,
    repoId: job.repoId,
    repoFullName: job.repoFullName,
    jobId: job.id,
    jobKind: kind,
    tier,
    requestedTier: tier,
    risk: RISKS.includes(routing.risk ?? '') ? routing.risk : null,
    routeSource: routeSourceOf(routing),
    reason: routeReasonCode(routing),
    confidence: typeof routing.confidence === 'number' ? routing.confidence : null,
    outcome: 'decided',
  });
}

/**
 * In the claim's transaction: which profile, adapter, configured model and effort a run was
 * given, with the job's routing and how many escalations and retries it had had. The model and
 * effort are what the profile asks its CLI for; whether the CLI honored them is not known.
 */
export function noteRunSelected(
  db: Db,
  config: UpdraftConfig,
  job: { id: string; repo_id: number; repo_full_name: string; workflow_id: string; envelope: string; created_at: string; escalation_hops: number },
  run: { id: string; agent: string; pool: string; started_at: string },
): void {
  const { kind, routing } = envelopeOf(job.envelope);
  const agent = Object.hasOwn(config.agents, run.agent) ? config.agents[run.agent] : undefined;
  const adapter = agent ? (agent.adapter ?? run.agent) : null;
  const profile = agent && adapter ? agentProfile(adapter, agent) : null;
  const model = safeSetting(profile?.model.value);
  const effort = safeSetting(profile?.effort.value);
  const requested = tierOrNull(routing?.tier);
  // After an escalation the pool is no longer the one the router chose; the pool says what ran.
  const tiers = Object.values(config.repositories)
    .find((r) => r.id === job.repo_id)
    ?.workflows.find((w) => workflowId(w) === job.workflow_id)?.tiers;
  // The tier this attempt was given: the router's, or the newest escalation's. Several tiers may
  // share one pool, so the pool alone cannot name it; it is the fallback (a config that changed).
  const target =
    job.escalation_hops === 0
      ? requested
      : tierOrNull((db.prepare("SELECT tier FROM metric_events WHERE kind = 'job.escalated' AND subject_id = ?").get(`${job.id}:${job.escalation_hops}`) as { tier: string | null } | undefined)?.tier);
  const resolved = (target && tiers && poolOfTier(tiers, target) === run.pool ? target : null) ?? tierOfPool(tiers, run.pool) ?? (job.escalation_hops === 0 ? requested : null);
  insertRouting(db, {
    kind: 'run.selected',
    subject: run.id,
    at: run.started_at,
    repoId: job.repo_id,
    repoFullName: job.repo_full_name,
    jobId: job.id,
    jobKind: kind,
    agent: run.agent,
    pool: run.pool,
    startAt: job.created_at,
    tier: resolved,
    requestedTier: requested,
    risk: RISKS.includes(routing?.risk ?? '') ? routing!.risk : null,
    adapter: safeSetting(adapter),
    model,
    effort,
    modelSource: model || effort ? 'configured' : 'unknown',
    routeSource: routeSourceOf(routing),
    reason: routeReasonCode(routing),
    confidence: typeof routing?.confidence === 'number' ? routing.confidence : null,
    hops: job.escalation_hops,
    retries: (db.prepare('SELECT retries FROM jobs WHERE id = ?').get(job.id) as { retries: number } | undefined)?.retries ?? null,
  });
}

/** After "updraft retry" requeued a job (`retries` is the count after the retry). */
export function noteJobRetried(db: Db, job: { id: string; repo_id: number; repo_full_name: string; envelope: string; retries: number }, at: string): void {
  insertRouting(db, {
    kind: 'job.retried',
    subject: `${job.id}:${job.retries}`,
    at,
    repoId: job.repo_id,
    repoFullName: job.repo_full_name,
    jobId: job.id,
    jobKind: envelopeOf(job.envelope).kind,
    retries: job.retries,
  });
}

/** After a usage limit started a cooldown of a capacity group or profile. `waitMs` is its length. */
export function noteCooldown(
  db: Db,
  c: { runId: string; job: { id: string; repo_id: number; repo_full_name: string }; scope: 'group' | 'agent'; name: string; waitMs: number; stated: boolean; at: string },
): void {
  insertRouting(db, {
    kind: 'capacity.cooldown',
    subject: c.runId,
    at: c.at,
    repoId: c.job.repo_id,
    repoFullName: c.job.repo_full_name,
    jobId: c.job.id,
    agent: c.name,
    outcome: c.scope,
    reason: c.stated ? 'stated' : 'default',
    waitMs: Math.max(0, Math.round(c.waitMs)),
  });
}

/** A run started waiting on a pull request in another repository. No repository name or PR number: ids and codes only. */
export function noteDependencyWaiting(db: Db, w: { runId: string; jobId: string; repoId: number; repoFullName: string; agent: string; at: string }): void {
  insertRouting(db, { kind: 'dependency.waiting', subject: w.runId, at: w.at, repoId: w.repoId, repoFullName: w.repoFullName, jobId: w.jobId, agent: w.agent, jobKind: 'implement' });
}

/** A wait ended: resumed (the pull request merged), closed (closed unmerged or unreadable), canceled or expired. */
export function noteDependencyEnded(
  db: Db,
  w: { runId: string; jobId: string; repoId: number; repoFullName: string; outcome: 'resumed' | 'closed' | 'canceled' | 'expired'; startAt: string; at: string; mergedAt?: string | null },
): void {
  const mergedAt = Date.parse(w.mergedAt ?? '');
  const waitUntil = Number.isFinite(mergedAt) ? mergedAt : Date.parse(w.at);
  insertRouting(db, {
    kind: 'dependency.ended',
    subject: w.runId,
    at: w.at,
    repoId: w.repoId,
    repoFullName: w.repoFullName,
    jobId: w.jobId,
    jobKind: 'implement',
    outcome: w.outcome,
    startAt: w.startAt,
    waitMs: Math.max(0, waitUntil - Date.parse(w.startAt)) || 0,
  });
}

/** After a job was requeued to wait out a usage limit (`deferrals` is the count after it). */
export function noteJobDeferred(db: Db, job: { id: string; repo_id: number; repo_full_name: string }, d: { deferrals: number; agent: string; at: string }): void {
  insertRouting(db, {
    kind: 'job.deferred',
    subject: `${job.id}:${d.deferrals}`,
    at: d.at,
    repoId: job.repo_id,
    repoFullName: job.repo_full_name,
    jobId: job.id,
    agent: d.agent,
    reason: 'usage-limit',
  });
}

/** After a job was moved to a more capable tier (`hops` is the count after it). */
export function noteJobEscalated(
  db: Db,
  job: { id: string; repo_id: number; repo_full_name: string },
  e: { hops: number; fromTier: string; toTier: string; source: string; agent: string; pool: string; at: string },
): void {
  insertRouting(db, {
    kind: 'job.escalated',
    subject: `${job.id}:${e.hops}`,
    at: e.at,
    repoId: job.repo_id,
    repoFullName: job.repo_full_name,
    jobId: job.id,
    agent: e.agent,
    pool: e.pool,
    tier: tierOrNull(e.toTier),
    requestedTier: tierOrNull(e.fromTier),
    reason: /^[a-z-]{1,30}$/.test(e.source) ? e.source : 'other',
    hops: e.hops,
  });
}

/**
 * Migration 13: record every fact the state rows still hold, marked backfilled. Facts whose rows
 * were already pruned are gone and cannot be recovered. A job's earlier terminal statuses (before
 * a retry) were never recorded; only its current one is. PRs whose publication was pruned but
 * that are still watched (revision_prs) get a pr.opened fact at the time watching started, with
 * reason 'approximate' and no lead time. Order matters: pr.merged reads the pr.opened facts.
 */
export function backfillMetrics(db: Db): void {
  const params = { backfilled: 1, recorded: nowIso() };
  const run = (sql: string) => db.prepare(sql).run(params);
  run(INSERT(SOURCES['run.ended'](), 'ORDER BY r.ended_at, r.rowid'));
  run(INSERT(SOURCES['job.finished'](), 'ORDER BY j.updated_at, j.rowid'));
  run(INSERT(SOURCES['pr.opened'](), 'ORDER BY p.published_at, p.rowid'));
  run(
    INSERT(
      `SELECT 'pr.opened', w.repo_id || '#' || w.pr_number, w.created_at, w.repo_id, ${REPO_NAME('w.repo_id')}, NULL, 'implement', w.pr_number,
         r.agent, w.pool, NULL, 'approximate', NULL, NULL, NULL, ${TAIL}
       FROM revision_prs w LEFT JOIN runs r ON r.id = w.source_run_id
       WHERE true`,
      'ORDER BY w.created_at',
    ),
  );
  run(INSERT(SOURCES['pr.merged'](), 'ORDER BY w.merged_at'));
  run(INSERT(SOURCES['pr.merge_blocked'](), 'ORDER BY w.updated_at'));
  run(INSERT(SOURCES['pr.limit_reached'](), 'ORDER BY w.limit_reached_at'));
  run(INSERT(SOURCES['review.verdict'](), 'ORDER BY v.created_at, v.rowid'));
  run(INSERT(SOURCES.change_request(), 'ORDER BY q.created_at'));
  run(INSERT(SOURCES['revision.pushed'](), 'ORDER BY v.pushed_at, v.rowid'));
}
