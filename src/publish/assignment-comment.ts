// The assignment comment: when the worker claims a live implementation run and the final dispatch
// check passes, it comments once on the source issue as the active GitHub identity, so the issue
// shows which agent was assigned and which local job and run to look up.
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
import type { Job, Run } from '../types.js';
import type { Logger } from '../util/log.js';
import { runDetails, UNKNOWN, type RunDetails } from './run-details.js';

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
}

/** Hidden marker on the assignment comment; finds it again on a retry. Distinct from the others. */
export function assignmentCommentMarker(runId: string): string {
  return `<!-- updraft-run-assigned: ${runId} -->`;
}

/**
 * Hosted context the runner hands to `updraft run-event`: the trusted console origin, the GitHub
 * installation id and the Cloud job id. All three are required for a link; none is a secret.
 */
export interface ConsoleContext {
  origin: string;
  installationId: string;
  cloudJobId: string;
}

/** Reads the hosted context from the runner's environment; null when absent or unusable. */
export function consoleContextFromEnv(env: NodeJS.ProcessEnv): ConsoleContext | null {
  const installationId = env.UPDRAFT_CLOUD_INSTALLATION_ID?.trim();
  const cloudJobId = env.UPDRAFT_CLOUD_JOB_ID?.trim();
  const origin = env.UPDRAFT_CONSOLE_ORIGIN?.trim();
  if (!origin || !installationId || !cloudJobId) return null;
  return { origin, installationId, cloudJobId };
}

/** The job page URL, or null when the context is missing or not a plain https (or localhost http) origin. */
export function consoleJobUrl(ctx: ConsoleContext | null | undefined): string | null {
  if (!ctx || !/^\d+$/.test(ctx.installationId) || !/^[A-Za-z0-9_.-]{1,128}$/.test(ctx.cloudJobId)) return null;
  let u: URL;
  try {
    u = new URL(ctx.origin);
  } catch {
    return null;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
  return `${u.origin}/installations/${encodeURIComponent(ctx.installationId)}/jobs/${encodeURIComponent(ctx.cloudJobId)}`;
}

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
      if (!assignmentApplies(deps.config, job)) return;
      const log = deps.log.child({ runId: run.id, jobId: job.id, repo: job.repoFullName, issue: job.issueNumber });
      try {
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
  };
}
