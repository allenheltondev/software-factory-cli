// The assignment comment: when the worker claims a live implementation run and the final dispatch
// check passes, it comments once on the source issue as the active GitHub identity, so the issue
// shows which agent was assigned and which local job and run to look up.
//
// With repositories.<repo>.notifications quiet (the default) there is no separate assignment
// comment: the assignment is a stage of the issue's one live status comment (status-comment.ts),
// edited in place (or posted, when the Cloud queue did not post it first), and a review or
// revision run moves that same comment on. What follows describes verbose mode, as before.
//
// The comment carries only what the worker itself persisted when it claimed the run
// (run-details.ts): the routing decision (complexity, capability tier, reason), the profile, its
// adapter, configured model and effort, the pool, and the job and run ids. No prompt, path or log.
// It is posted after routing and selection, so it never claims a choice that was not made, and it
// says "assigned", so it stays true if the run later fails.
//
// Delivery is independent of the run: the caller does not wait for it, it never throws, and a
// failure is only logged and recorded as an error. Idempotent by run id: a hidden marker carries
// the run id and the issue's comments are searched for it before every write, so a retry after a
// lost response (or a restart that repeats the announcement) leaves one comment per run. A new
// attempt has a new run id and so gets its own comment.
import type { UpdraftConfig } from '../config/schema.js';
import { recordError, type Db } from '../db/database.js';
import { GitHubError, type GitHubApi } from '../github/api.js';
import { GitHubAppError } from '../github/app-auth.js';
import { reviewOf, revisionOf, type Job, type Run } from '../types.js';
import type { Logger } from '../util/log.js';
import { consoleJobUrl, consoleWorkflowUrl, type ConsoleContext } from './console-link.js';
import { CLI_DEFAULT, NOT_APPLICABLE, runDetails, UNKNOWN, type RunDetails } from './run-details.js';
import { countRevisions } from '../db/revisions.js';
import { quietFor, shortSha, writeStatusComment, type StatusWrite } from './status-comment.js';
import { STATUS_STAGE, statusLinkLine } from './status-marker.js';

/** Writes tried per assignment (the first plus retries of transient failures). */
export const ASSIGNMENT_MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;

export interface AssignmentCommentDeps {
  db: Db;
  config: UpdraftConfig;
  api: GitHubApi;
  log: Logger;
  now?: () => number;
  /** Hosted console context (runner-provided); absent for standalone workers. */
  console?: ConsoleContext | null;
  /** Wait between attempts; resolves early on abort. Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface AssignmentCommenter {
  /**
   * After a run's final dispatch check passed and it is about to start. Decides itself whether a
   * comment applies. Resolves when delivery finished or gave up; never throws.
   */
  announce(job: Job, run: Run, signal?: AbortSignal): Promise<void>;
  /**
   * After an implementation run failed for good (not requeued): quiet notifications move the
   * status comment off "Assigned", so it never says a worker is on an issue nobody works on.
   * Never throws.
   */
  ended?(job: Job, run: Run, signal?: AbortSignal): Promise<void>;
}

/** Hidden marker on the assignment comment; finds it again on a retry. Distinct from the others. */
export function assignmentCommentMarker(runId: string): string {
  return `<!-- updraft-run-assigned: ${runId} -->`;
}

export { consoleContextFromEnv, consoleJobUrl, type ConsoleContext } from './console-link.js';

/** A table cell: one line, pipes and markup escaped. */
function cell(text: string): string {
  return text.replace(/<!--|-->/g, '').replace(/\s+/g, ' ').trim().replace(/[\\|]/g, '\\$&').replace(/`/g, '\\`') || '?';
}
const codeCell = (text: string) => `\`${cell(text).replace(/\\([`])/g, '$1').replace(/`/g, "'")}\``;

export function renderAssignmentComment(o: {
  details: RunDetails;
  jobId: string;
  runId: string;
  pool: string;
  console?: ConsoleContext | null;
}): string {
  const url = consoleJobUrl(o.console);
  const cloudId = o.console?.cloudJobId ?? '';
  const d = o.details;
  // The order of the issue's example (#140): what was decided about the issue, then what runs it.
  const rows: Array<[string, string]> = [['Status', 'Assigned']];
  if (d.attempt) rows.push(['Attempt', cell(d.attempt)]);
  rows.push(['Complexity', codeCell(d.complexity)], ['Capability tier', codeCell(d.tier ?? UNKNOWN)], ['Worker', codeCell(d.worker)]);
  if (d.adapter) rows.push(['Adapter', codeCell(d.adapter)]);
  // Nothing has been observed at assignment: a known model is the configured one.
  rows.push([`Model${d.modelKind ? ' (configured)' : ''}`, codeCell(d.model)]);
  rows.push(['Reasoning effort', codeCell(d.effort ?? UNKNOWN)], ['Pool', codeCell(o.pool)]);
  if (d.reason) rows.push(['Routing reason', cell(d.reason)]);
  if (url && cloudId === o.jobId) {
    rows.push(['Job ID', `[${cell(o.jobId).replace(/[[\]]/g, '\\$&')}](${url})`]);
  } else {
    rows.push(['Job ID', codeCell(o.jobId)]);
    if (url) rows.push(['Updraft job', `[${cell(cloudId).replace(/[[\]]/g, '\\$&')}](${url})`]);
  }
  rows.push(['Run ID', codeCell(o.runId)]);
  return [
    'Updraft assigned a worker to this issue.',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    assignmentCommentMarker(o.runId),
  ].join('\n');
}

const TIERS: readonly string[] = ['routine', 'standard', 'complex', 'high-risk'];
/** A value worth a row: a name, not "CLI default", "Unknown" or "Not applicable". */
const shown = (v: string | null | undefined): v is string => !!v && v !== CLI_DEFAULT && v !== UNKNOWN && !v.startsWith(NOT_APPLICABLE) && !v.startsWith('Not classified');

/**
 * The live status comment's table (quiet notifications): only the rows that carry information.
 * The worker (profile); the model, configured and, once the CLI reported it, observed; the
 * reasoning effort and capability tier when they were set; the job, linked to the console. Run
 * and job ids otherwise stay behind that link.
 */
export function renderStatusTable(o: { details: RunDetails; jobId: string; console?: ConsoleContext | null }): string {
  const d = o.details;
  const rows: Array<[string, string]> = [['Worker', codeCell(d.worker)]];
  if (d.attempt) rows.push(['Attempt', cell(d.attempt)]);
  if (d.modelKind === 'observed' && shown(d.model)) rows.push(['Model (observed)', codeCell(d.model)]);
  else {
    if (shown(d.model)) rows.push(['Model', codeCell(d.model)]);
    if (shown(d.observedModel) && d.observedModel !== d.model) rows.push([shown(d.model) ? 'Model (observed)' : 'Model', codeCell(d.observedModel)]);
  }
  if (shown(d.effort)) rows.push(['Reasoning effort', codeCell(d.effort)]);
  if (d.tier && TIERS.includes(d.tier)) rows.push(['Capability tier', codeCell(d.tier)]);
  const url = consoleJobUrl(o.console);
  const id = o.console?.cloudJobId ?? o.jobId;
  rows.push(['Job', url ? `[${cell(id).replace(/[[\]]/g, '\\$&')}](${url})` : codeCell(o.jobId)]);
  return ['| | |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
}

/** The keys a run's status comment goes by: its Cloud job id (when hosted) and its local job id. */
export function statusKeys(job: Pick<Job, 'id'>, ctx?: ConsoleContext | null): string[] {
  const cloud = ctx?.cloudJobId && /^[A-Za-z0-9_.-]{1,128}$/.test(ctx.cloudJobId) ? ctx.cloudJobId : null;
  return [...new Set([...(cloud ? [cloud] : []), job.id])];
}

/** The console link line of an issue's status comment: its workflow timeline. Null when not hosted. */
export function statusLinkFor(ctx: ConsoleContext | null | undefined, repoId: number, issue: number): string | null {
  const url = consoleWorkflowUrl(ctx, repoId, issue);
  return url ? statusLinkLine(url, 'work') : null;
}

/**
 * The status change a claimed run makes (quiet notifications): an implementation run is assigned
 * (and posts the comment if the queue did not); a review or revision run moves the review loop on.
 */
export function assignmentStatus(db: Db, job: Job, run: Run, ctx?: ConsoleContext | null): StatusWrite {
  const repo = { id: job.repoId, fullName: job.repoFullName };
  const review = reviewOf(job);
  const revision = revisionOf(job);
  if (review) {
    const round = (review.priorReviews?.length ?? 0) + 1;
    return {
      repo,
      issue: job.issueNumber,
      target: { pr: review.pullRequest.number },
      stage: STATUS_STAGE.loop,
      title: 'Reviewing',
      text: `Reviewing PR #${review.pullRequest.number} at \`${shortSha(review.headSha)}\` (review round ${round}).`,
    };
  }
  if (revision) {
    const pr = revision.pullRequest.number;
    if (revision.trigger === 'ci_failure') {
      const sha = revision.reviewedSha;
      return {
        repo,
        issue: job.issueNumber,
        target: { pr },
        stage: STATUS_STAGE.loop,
        title: 'Fixing checks',
        text: sha ? `Fixing failed checks on \`${shortSha(sha)}\` of PR #${pr}.` : `Fixing failed checks of PR #${pr}.`,
      };
    }
    let round = 1;
    try {
      round = Math.max(1, countRevisions(db, job.repoId, pr));
    } catch {
      // the round is decoration
    }
    return { repo, issue: job.issueNumber, target: { pr }, stage: STATUS_STAGE.loop, title: 'Revising', text: `Revising PR #${pr} for review round ${round}.` };
  }
  return {
    repo,
    issue: job.issueNumber,
    target: { keys: statusKeys(job, ctx), create: true },
    stage: STATUS_STAGE.assigned,
    title: 'Assigned',
    text: 'Updraft assigned a worker to this issue and is working on it.',
    details: renderStatusTable({ details: runDetails(db, job, run), jobId: job.id, console: ctx }),
    link: statusLinkFor(ctx, job.repoId, job.issueNumber),
  };
}

/** Live implementation runs only: not log-only or prepare-only, and not reviewer or revision jobs. */
export function assignmentApplies(config: UpdraftConfig, job: Job): boolean {
  const type = job.envelope?.type;
  return config.execution.mode === 'live' && type !== 'pull_request.review' && type !== 'pull_request.changes_requested';
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function isTransient(err: unknown): boolean {
  if (!(err instanceof GitHubError) || err instanceof GitHubAppError) return false;
  return err.status === 0 || err.status >= 500 || err.isRateLimit;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export function createAssignmentCommenter(deps: AssignmentCommentDeps): AssignmentCommenter {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  return {
    async announce(job, run, signal) {
      if (deps.config.execution.mode !== 'live') return;
      const quiet = quietFor(deps.config, job);
      if (!quiet && !assignmentApplies(deps.config, job)) return;
      const log = deps.log.child({ runId: run.id, jobId: job.id, repo: job.repoFullName, issue: job.issueNumber });
      try {
        if (quiet) {
          // One live status comment (status-comment.ts): it retries transient failures itself.
          const r = await writeStatusComment({ api: deps.api, log, sleep: (ms) => sleep(ms, signal) }, assignmentStatus(deps.db, job, run, deps.console));
          if (r.status !== 'none') log.info(`status comment ${r.status}`, { comment: r.comment.htmlUrl });
          return;
        }
        const repoRef = { id: job.repoId, fullName: job.repoFullName };
        const marker = assignmentCommentMarker(run.id);
        for (let attempt = 1; ; attempt++) {
          try {
            const existing = (await deps.api.listIssueComments(repoRef, job.issueNumber)).find((c) => c.body.includes(marker));
            if (existing) {
              log.info('assignment comment already on issue', { comment: existing.htmlUrl });
              return;
            }
            const created = await deps.api.createIssueComment(
              repoRef,
              job.issueNumber,
              renderAssignmentComment({ details: runDetails(deps.db, job, run), jobId: job.id, runId: run.id, pool: run.pool, console: deps.console }),
            );
            log.info('assignment comment posted', { comment: created.htmlUrl });
            return;
          } catch (err) {
            if (!isTransient(err) || attempt >= ASSIGNMENT_MAX_ATTEMPTS || signal?.aborted) throw err;
            const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
            log.warn('assignment comment write failed; retrying', { error: message(err), attempt, backoffMs: backoff });
            await sleep(backoff, signal);
            if (signal?.aborted) throw err;
          }
        }
      } catch (err) {
        log.warn('assignment comment not posted', { error: message(err) });
        try {
          recordError(deps.db, {
            scope: 'assignment-comment',
            repoFullName: job.repoFullName,
            jobId: job.id,
            message: `run ${run.id}: could not comment on issue #${job.issueNumber}: ${message(err)}`,
            at: new Date(now()).toISOString(),
          });
        } catch {
          // already in the worker log
        }
      }
    },
    async ended(job, run, signal) {
      if (deps.config.execution.mode !== 'live' || reviewOf(job) || revisionOf(job) || !quietFor(deps.config, job)) return;
      const log = deps.log.child({ runId: run.id, jobId: job.id, repo: job.repoFullName, issue: job.issueNumber });
      try {
        // Edit only: a run that never got its comment out has nothing to take back. Stage
        // "assigned", so a retry's assignment replaces it.
        const r = await writeStatusComment(
          { api: deps.api, log, sleep: (ms) => sleep(ms, signal) },
          {
            repo: { id: job.repoId, fullName: job.repoFullName },
            issue: job.issueNumber,
            target: { keys: statusKeys(job, deps.console), create: false },
            stage: STATUS_STAGE.assigned,
            title: 'Stopped',
            text: 'The run ended without opening a pull request. The job says why, and can be retried from there.',
          },
        );
        if (r.status !== 'none') log.info(`status comment ${r.status}`, { comment: r.comment.htmlUrl });
      } catch (err) {
        log.warn('status comment not updated', { error: message(err) });
      }
    },
  };
}
