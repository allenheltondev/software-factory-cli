// The runner's side of the live status comment (status-marker.ts has the format and the rules;
// docs/assignment-comments.md says what each stage shows). With repositories.<repo>.notifications
// quiet (the default), an issue's run has one Updraft comment that says what is happening: the
// assignment, the pull request it opened, the review loop's progress and the merge are edits of
// it, never new comments.
//
// Every write lists the issue's comments first and finds the comment by its marker: a retry after
// a lost response, a restart, or another machine of the same workflow edits that comment instead
// of posting another. Only the job that starts the run (its assignment or its publication) ever
// posts one; the review loop only edits.
import { notificationMode, type UpdraftConfig } from '../config/schema.js';
import { GitHubError, type GitHubApi, type GitHubIssueComment } from '../github/api.js';
import { GitHubAppError } from '../github/app-auth.js';
import { sameLogin, workerLogin } from '../github/identity.js';
import type { Db } from '../db/database.js';
import { getLoopPr } from '../db/pr-reviews.js';
import type { RepoRef } from '../types.js';
import type { Logger } from '../util/log.js';
import { findRepoConfig } from '../worker/executor.js';
import {
  FINAL_STAGE,
  mayReplace,
  parseStatusMarker,
  renderStatusComment,
  RUNNER_STAGE,
  STATUS_STAGE,
  statusDetails,
  statusLink,
  type StatusMark,
} from './status-marker.js';

/** Writes tried per status change (the first plus retries of transient failures). */
export const STATUS_MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 2_000;

/** Whether a repository speaks through the one status comment (quiet) or the separate comments of earlier versions (verbose). */
export function quietFor(config: UpdraftConfig, repo: { repoId: number; repoFullName: string }): boolean {
  return notificationMode(findRepoConfig(config, repo)?.repo) === 'quiet';
}

/**
 * Which comment a write is about.
 * - `keys`: the run's own (the first key is the one a new comment gets; the others are names the
 *   same job also goes by, its local and its Cloud id). Without one, a queue acknowledgement that
 *   still waits for its run is taken over. `create`: post one when none is found.
 * - `pr`: the review loop's; the comment that names the pull request, else the newest one that
 *   names none yet. Never posted.
 */
export type StatusTarget = { keys: string[]; create: boolean } | { pr: number };

export interface StatusWrite {
  repo: RepoRef;
  issue: number;
  target: StatusTarget;
  stage: number;
  title: string;
  text: string;
  /** The assignment table; undefined keeps what the comment has. */
  details?: string | null;
  /** The console link line; undefined keeps what the comment has. */
  link?: string | null;
  /** The pull request, once there is one; undefined keeps what the comment names. */
  pr?: number;
  /** Review-loop stages: the head the stage is about, and whether it is the pull request's newest (mayReplace). */
  sha?: string;
  latest?: boolean;
  /** Review-loop stages: when the job attempt (or step) writing it started, epoch ms (mayReplace orders one head's stages by it). */
  at?: number;
}

export type StatusWriteResult =
  | { status: 'created' | 'updated' | 'unchanged'; comment: GitHubIssueComment }
  /** A later stage is already shown (or a final one): left as it is. */
  | { status: 'skipped'; comment: GitHubIssueComment; reason: string }
  /** No comment to edit, and this write does not post one. */
  | { status: 'none' };

export interface StatusDeps {
  api: GitHubApi;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof GitHubError) || err instanceof GitHubAppError) return false;
  return err.status === 0 || err.status >= 500 || err.isRateLimit;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Found {
  comment: GitHubIssueComment;
  mark: StatusMark;
}

/** The status comment a write is about, among the issue's comments (oldest first), or null. */
export function findStatusComment(comments: readonly GitHubIssueComment[], target: StatusTarget, login: string): Found | null {
  const own: Found[] = [];
  for (const c of comments) {
    const mark = parseStatusMarker(c.body);
    // Only the worker's own: anyone can type a marker into a comment.
    if (mark && sameLogin(c.user, login)) own.push({ comment: c, mark });
  }
  const newest = (list: Found[]) => list[list.length - 1] ?? null;
  if ('keys' in target) {
    return (
      newest(own.filter((f) => target.keys.includes(f.mark.key))) ??
      // The Cloud queue's acknowledgement of this very work, posted while it waited (under the
      // queue entry's id, which a run started under another id does not know). Only one that
      // still waits: an ended one belongs to work that never started.
      newest(own.filter((f) => f.mark.stage < STATUS_STAGE.ended))
    );
  }
  return newest(own.filter((f) => f.mark.pr === target.pr)) ?? newest(own.filter((f) => f.mark.pr === undefined && f.mark.stage >= RUNNER_STAGE && f.mark.stage < FINAL_STAGE));
}

/** Bring the status comment to a stage. Throws a GitHub error that retrying did not fix. */
export async function writeStatusComment(deps: StatusDeps, w: StatusWrite): Promise<StatusWriteResult> {
  const sleep = deps.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await writeOnce(deps, w);
    } catch (err) {
      if (!isTransient(err) || attempt >= STATUS_MAX_ATTEMPTS) throw err;
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
}

async function writeOnce(deps: StatusDeps, w: StatusWrite): Promise<StatusWriteResult> {
  // Fails closed: without the worker's own login, anyone's comment could pass for the status comment.
  const login = await workerLogin(deps.api);
  const found = findStatusComment(await deps.api.listIssueComments(w.repo, w.issue), w.target, login);
  const at = w.at !== undefined && Number.isFinite(w.at) ? Math.floor(w.at / 1000) : undefined;
  if (found && !mayReplace(found.mark, w.stage, { ...(w.sha ? { sha: w.sha } : {}), ...(w.latest !== undefined ? { latest: w.latest } : {}), ...(at !== undefined ? { at } : {}) })) {
    return { status: 'skipped', comment: found.comment, reason: `the comment shows a later stage (${found.mark.stage})` };
  }
  if (!found && !('keys' in w.target && w.target.create)) return { status: 'none' };
  const prev = found?.comment.body ?? '';
  const key = 'keys' in w.target ? w.target.keys[0]! : found!.mark.key;
  const pr = w.pr ?? found?.mark.pr;
  const body = renderStatusComment({
    title: w.title,
    text: w.text,
    details: w.details === undefined ? statusDetails(prev) : w.details,
    link: w.link === undefined ? statusLink(prev) : w.link,
    // A review-loop stage names its head; any other keeps none (a new stage of the run starts over).
    mark: { key, stage: w.stage, ...(pr !== undefined ? { pr } : {}), ...(w.sha && w.stage >= STATUS_STAGE.loop && w.stage < FINAL_STAGE ? { sha: w.sha.slice(0, 40), ...(at !== undefined ? { at } : {}) } : {}) },
  });
  if (found) {
    if (found.comment.body === body) return { status: 'unchanged', comment: found.comment };
    return { status: 'updated', comment: await deps.api.updateIssueComment(w.repo, found.comment.id, body) };
  }
  return { status: 'created', comment: await deps.api.createIssueComment(w.repo, w.issue, body) };
}

/** A best-effort status change: logged, never thrown. For the review loop's stages. */
export async function noteStatus(deps: StatusDeps, w: StatusWrite): Promise<StatusWriteResult | null> {
  try {
    const r = await writeStatusComment(deps, w);
    if (r.status !== 'none' && r.status !== 'unchanged') deps.log.info(`status comment ${r.status}`, { issue: w.issue, stage: w.stage, comment: r.comment.htmlUrl });
    return r;
  } catch (err) {
    deps.log.warn('status comment not updated', { issue: w.issue, stage: w.stage, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Short SHA for a status line. */
export const shortSha = (sha: string) => sha.slice(0, 7);

/** Whether `sha` is the newest head the worker's records have for the pull request (true when they have none). */
export function isLatestHead(db: Db, repoId: number, prNumber: number, sha: string | null | undefined): boolean {
  if (!sha) return false;
  try {
    const head = getLoopPr(db, repoId, prNumber)?.headSha;
    return !head || head.startsWith(sha) || sha.startsWith(head);
  } catch {
    return false;
  }
}
