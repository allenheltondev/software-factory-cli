import { existsSync } from 'node:fs';
import { configSchema, type UpdraftConfig } from '../config/schema.js';
import type { FailureComment } from '../db/failure-comments.js';
import { getStatusSnapshot, type StatusSnapshot } from '../db/queue.js';
import type { ReviewRequest } from '../db/revisions.js';
import { revisionOf, type Job, type JobStatus, type Publication, type Revision } from '../types.js';
import { verificationLines, verificationNotes } from '../worker/verify.js';
import { println, type CommandContext } from './context.js';
import { EXIT } from './errors.js';
import { checkConfig } from './validate.js';

export interface WatchedRepo {
  fullName: string;
  id: number;
  workflows: number;
  checkpoint: { lastEventId: number | null; updatedAt: string } | null;
}

export interface StatusView {
  configPath: string;
  configState: 'ok' | 'missing' | 'invalid';
  configMessage: string | null;
  dbFile: string;
  dbExists: boolean;
  repos: WatchedRepo[];
  /** Checkpoints for repos that are no longer in the config. */
  orphanCheckpoints: StatusSnapshot['checkpoints'];
  snapshot: StatusSnapshot;
}

const JOB_STATUSES: JobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'interrupted', 'canceled'];

export function emptyConfig(): UpdraftConfig {
  return configSchema.parse({ version: 1, agents: {}, pools: {}, actions: {} });
}

export function buildStatusView(o: {
  configPath: string;
  configState: StatusView['configState'];
  configMessage: string | null;
  config: UpdraftConfig | null;
  dbFile: string;
  dbExists: boolean;
  snapshot: StatusSnapshot;
}): StatusView {
  const byId = new Map(o.snapshot.checkpoints.map((c) => [c.repoId, c]));
  const repos: WatchedRepo[] = Object.entries(o.config?.repositories ?? {}).map(([fullName, r]) => {
    const cp = byId.get(r.id);
    return {
      fullName,
      id: r.id,
      workflows: r.workflows.length,
      checkpoint: cp ? { lastEventId: cp.lastEventId, updatedAt: cp.updatedAt } : null,
    };
  });
  const configured = new Set(repos.map((r) => r.id));
  return {
    configPath: o.configPath,
    configState: o.configState,
    configMessage: o.configMessage,
    dbFile: o.dbFile,
    dbExists: o.dbExists,
    repos,
    orphanCheckpoints: o.snapshot.checkpoints.filter((c) => !configured.has(c.repoId)),
    snapshot: o.snapshot,
  };
}

function oneLine(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One line: the PR, or why there is none yet and how to retry. */
export function renderPublication(p: Publication): string {
  const pr = p.prUrl ? `PR #${p.prNumber}: ${p.prUrl}` : null;
  switch (p.state) {
    case 'published':
      return `${p.mode === 'draft-pr' ? 'draft ' : ''}${pr ?? 'published'}`;
    case 'publishing':
      return `publishing (attempt ${p.attempts})${pr ? `; ${pr}` : p.pushedAt ? '; branch pushed' : ''}`;
    case 'skipped':
      return `not published: ${oneLine(p.error ?? 'nothing to publish', 140)}`;
    case 'failed': {
      const next = p.nextAttemptAt ? `worker retries at ${p.nextAttemptAt}, or ` : '';
      const done = [p.pushedAt ? 'branch pushed' : null, pr].filter(Boolean).join(', ');
      return (
        `publication failed (attempt ${p.attempts}${done ? `; ${done}` : ''}): ${oneLine(p.error ?? 'unknown error', 140)}` +
        ` — ${next}run "updraft publish ${p.runId}"`
      );
    }
  }
}

/** One line: the failure comment on the issue, or why there is none. */
export function renderFailureComment(c: FailureComment): string {
  switch (c.state) {
    case 'posted':
      return `failure comment posted: ${c.commentUrl ?? `on issue #${c.issueNumber}`}`;
    case 'posting':
      return `posting the failure comment (attempt ${c.attempts})`;
    case 'skipped':
      return `failure comment not posted: ${oneLine(c.error ?? 'no longer applies', 140)}`;
    case 'failed': {
      const next = c.nextAttemptAt ? `worker retries at ${c.nextAttemptAt}` : 'the worker will not retry it';
      return `failure comment not posted (attempt ${c.attempts}): ${oneLine(c.error ?? 'unknown error', 140)} — ${next}`;
    }
  }
}

/** One line: what happened to a revision run's commits. */
export function renderRevision(r: Revision): string {
  const range = `${r.baseSha?.slice(0, 12) ?? '?'}..${r.headSha?.slice(0, 12) ?? '?'}`;
  switch (r.state) {
    case 'published':
      return `pushed ${range} to ${r.branch}; reply ${r.commentUrl ?? '(none)'}`;
    case 'publishing':
      return `pushing (attempt ${r.attempts})${r.pushedAt ? '; branch pushed' : ''}`;
    case 'skipped':
      return `not pushed: ${oneLine(r.error ?? 'nothing to push', 140)}`;
    case 'failed': {
      if (r.moved) return `not pushed, the branch moved: ${oneLine(r.error ?? 'unknown error', 140)} — not retried; request changes again to revise the current head`;
      const next = r.nextAttemptAt ? `worker retries at ${r.nextAttemptAt}, or ` : '';
      return `revision push failed (attempt ${r.attempts}${r.pushedAt ? '; branch pushed' : ''}): ${oneLine(r.error ?? 'unknown error', 140)} — ${next}run "updraft publish ${r.runId}"`;
    }
  }
}

/** One line: a change request and what was decided about it. */
export function renderReviewRequest(r: ReviewRequest): string {
  const who = `by ${r.reviewer ?? 'an unknown user'}${r.submittedAt ? ` at ${r.submittedAt}` : ''}`;
  switch (r.state) {
    case 'queued':
      return `${who}: revision job ${r.jobId ?? '(pruned)'}`;
    case 'over-limit':
      return `${who}: not acted on — ${oneLine(r.reason ?? 'the pull request reached maxRevisions', 140)}`;
    default:
      return `${who}: ignored — ${oneLine(r.reason ?? 'no reason recorded', 140)}`;
  }
}

/** " (revision of PR #n)" for a revision job, so its issue number is not read as the whole story. */
function revisionNote(job: Job): string {
  const revision = revisionOf(job);
  return revision ? ` (revision of PR #${revision.pullRequest.number})` : '';
}

export function renderStatus(v: StatusView): string {
  const s = v.snapshot;
  const lines: string[] = [];
  const configNote =
    v.configState === 'ok'
      ? ''
      : v.configState === 'missing'
        ? ' (not found; run "updraft configure" or "updraft add")'
        : ` (invalid: ${oneLine(v.configMessage ?? 'see "updraft validate"')})`;
  lines.push(`Config: ${v.configPath}${configNote}`);
  lines.push(`State:  ${v.dbFile}${v.dbExists ? '' : ' (not created yet)'}`);

  if (!s.worker) lines.push('Worker: not running');
  else {
    const w = s.worker;
    lines.push(
      `Worker: ${w.stale ? 'stale lock (no recent heartbeat)' : 'running'} — pid ${w.pid} on ${w.hostname}, ` +
        `started ${w.startedAt}, heartbeat ${w.heartbeatAt}`,
    );
  }

  lines.push('', `Repositories (${v.repos.length}):`);
  if (!v.repos.length) lines.push('  (none)');
  for (const r of v.repos) {
    const cp = r.checkpoint
      ? `checkpoint event ${r.checkpoint.lastEventId ?? '(none yet)'}, updated ${r.checkpoint.updatedAt}`
      : 'not polled yet';
    lines.push(`  ${r.fullName} (id ${r.id}) — ${r.workflows} workflow(s); ${cp}`);
  }
  for (const c of v.orphanCheckpoints) {
    lines.push(`  ${c.fullName} (id ${c.repoId}) — no longer configured; checkpoint event ${c.lastEventId ?? '(none)'}`);
  }

  lines.push('', 'Agents:');
  if (!s.agents.length) lines.push('  (none)');
  const width = Math.max(0, ...s.agents.map((a) => a.agent.length));
  for (const a of s.agents) {
    lines.push(
      `  ${a.agent.padEnd(width)}  ${a.enabled ? 'enabled ' : 'disabled'}  ${a.running}/${a.maxConcurrent} running`,
    );
  }

  lines.push('', `Queue: ${JOB_STATUSES.map((st) => `${st} ${s.counts[st] ?? 0}`).join(', ')}`);

  lines.push('', `Active runs (${s.activeRuns.length}):`);
  if (!s.activeRuns.length) lines.push('  (none)');
  for (const { run, job } of s.activeRuns) {
    // A claimed run that has not started yet is requeued if its worker stops; a started one is interrupted.
    const phase = run.executionStartedAt
      ? `running since ${run.executionStartedAt}`
      : `claimed ${run.startedAt}, not started yet`;
    const canceling = run.cancelRequestedAt ? ', cancel requested' : '';
    lines.push(
      `  ${run.id}  ${job.repoFullName}#${job.issueNumber}${revisionNote(job)}  ${job.workflowId}  agent ${run.agent} (pool ${run.pool})  ${phase}${canceling}`,
    );
  }

  lines.push('', 'Recent jobs:');
  if (!s.recentJobs.length) lines.push('  (none)');
  for (const j of s.recentJobs) {
    const reason = j.statusReason ? ` — ${oneLine(j.statusReason, 100)}` : '';
    lines.push(
      `  ${j.id}  ${j.status.padEnd(11)}  ${j.repoFullName}#${j.issueNumber}${revisionNote(j)}  ${j.workflowId}  updated ${j.updatedAt}${reason}`,
    );
  }

  const publications = s.publications ?? [];
  const pubByRun = new Map(publications.map((p) => [p.runId, p]));
  const failureComments = s.failureComments ?? [];
  const failureCommentByRun = new Map(failureComments.map((c) => [c.runId, c]));
  const revisions = s.revisions ?? [];
  const revisionByRun = new Map(revisions.map((r) => [r.runId, r]));
  if (s.recentAgentRuns.length) {
    lines.push('', 'Recent agent runs:');
    for (const { run, job } of s.recentAgentRuns) {
      const sum = run.summary!;
      lines.push(
        `  ${run.id}  ${run.outcome ?? (run.cancelRequestedAt ? 'canceled' : 'closed')}  ${job.repoFullName}#${job.issueNumber}${revisionNote(job)}  agent ${run.agent}  ended ${run.endedAt}`,
        `    ${sum.commitCount} commit(s), ${sum.filesChanged} file(s) changed (${sum.diffStat}), ${sum.untracked} untracked`,
        `    worktree ${sum.worktree} (branch ${sum.branch})`,
      );
      const last = sum.lastOutput.at(-1);
      if (last) lines.push(`    last output: ${oneLine(last, 120)}`);
      if (sum.verification) {
        lines.push(`    verification: ${sum.verification.passed ? 'passed' : 'did not pass'}`);
        for (const l of verificationLines(sum.verification)) lines.push(`      ${oneLine(l)}`);
        for (const note of verificationNotes(sum.verification)) lines.push(`      note: ${note}`);
      }
      const pub = pubByRun.get(run.id);
      if (pub) lines.push(`    ${renderPublication(pub)}`);
      const revision = revisionByRun.get(run.id);
      if (revision) lines.push(`    ${renderRevision(revision)}`);
      const failureComment = failureCommentByRun.get(run.id);
      if (failureComment) lines.push(`    ${renderFailureComment(failureComment)}`);
    }
  }

  if (publications.length) {
    lines.push('', 'Publications:');
    for (const p of publications) {
      lines.push(`  ${p.runId}  ${p.state.padEnd(10)}  ${p.repoFullName}#${p.issueNumber}  ${p.branch}  updated ${p.updatedAt}`);
      lines.push(`    ${renderPublication(p)}`);
    }
  }

  if (revisions.length) {
    lines.push('', 'Revisions:');
    for (const r of revisions) {
      lines.push(`  ${r.runId}  ${r.state.padEnd(10)}  ${r.repoFullName} PR #${r.prNumber}  ${r.branch}  updated ${r.updatedAt}`);
      lines.push(`    ${renderRevision(r)}`);
    }
  }

  const reviewRequests = s.reviewRequests ?? [];
  if (reviewRequests.length) {
    const repoName = new Map(v.repos.map((r) => [r.id, r.fullName]));
    lines.push('', 'Change requests:');
    for (const r of reviewRequests) {
      lines.push(`  ${repoName.get(r.repoId) ?? `repository ${r.repoId}`} PR #${r.prNumber}  ${r.state.padEnd(10)}  ${r.reviewUrl ?? r.reviewId}`);
      lines.push(`    ${renderReviewRequest(r)}`);
    }
    for (const pr of s.limitedPullRequests ?? []) {
      const comment = pr.limitCommentUrl ?? (pr.limitCommentError ? `not posted yet: ${oneLine(pr.limitCommentError, 100)}` : 'not posted yet');
      lines.push(`  ${repoName.get(pr.repoId) ?? `repository ${pr.repoId}`} PR #${pr.prNumber} reached maxRevisions at ${pr.limitReachedAt}; comment: ${comment}`);
    }
  }

  // Its own section too: a run that failed before its agent started is not among the agent runs.
  if (failureComments.length) {
    lines.push('', 'Failure comments:');
    for (const c of failureComments) {
      lines.push(`  ${c.runId}  ${c.state.padEnd(7)}  ${c.repoFullName}#${c.issueNumber}  updated ${c.updatedAt}`);
      lines.push(`    ${renderFailureComment(c)}`);
    }
  }

  lines.push('', 'Recent errors:');
  if (!s.recentErrors.length) lines.push('  (none)');
  for (const e of s.recentErrors) {
    const where = [e.repoFullName, e.jobId].filter(Boolean).join(' ');
    lines.push(`  ${e.at}  [${e.scope}]${where ? ` ${where}` : ''}: ${oneLine(e.message)}`);
  }
  return lines.join('\n');
}

export async function statusCommand(ctx: CommandContext, opts: { json?: boolean }): Promise<number> {
  const check = checkConfig(ctx.paths.configFile);
  let config: UpdraftConfig | null = null;
  let configState: StatusView['configState'] = 'missing';
  let configMessage: string | null = null;
  if (check.state === 'ok') {
    config = check.config;
    configState = 'ok';
  } else if (check.state === 'invalid') {
    configState = 'invalid';
    configMessage = check.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
  } else if (check.state === 'unreadable') {
    configState = 'invalid';
    configMessage = check.message;
  }

  // Don't create state as a side effect of looking at it: use an empty in-memory DB when none exists.
  const dbExists = existsSync(ctx.paths.dbFile);
  const db = ctx.openDb(dbExists ? ctx.paths.dbFile : ':memory:');
  let snapshot: StatusSnapshot;
  try {
    snapshot = getStatusSnapshot(db, config ?? emptyConfig(), ctx.now);
  } finally {
    db.close();
  }

  const view = buildStatusView({
    configPath: ctx.paths.configFile,
    configState,
    configMessage,
    config,
    dbFile: ctx.paths.dbFile,
    dbExists,
    snapshot,
  });
  if (opts.json) println(ctx.out, JSON.stringify(view, null, 2));
  else println(ctx.out, renderStatus(view));
  return EXIT.OK;
}
