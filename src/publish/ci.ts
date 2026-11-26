// The CI step of the review loop (repositories.<repo>.ciFix; off unless set). See docs/ci-fix.md.
//
// A ready-to-merge verdict is about the code the reviewer read; GitHub's checks are about what
// the code does. With ciFix on, a verdict for the current head does not end the loop: after each
// poll (and on a check or status webhook for the pull request) the checks of that head are read:
//   - pending ones, or a decisive check that has not reported yet, are waited for, up to
//     ciFix.waitMinutes. Nothing is held while waiting: no worker, no job, only the PR's row;
//   - a failure the code can cause (a check run that concluded failure or timed_out, a status in
//     state failure) queues a revision of the same PR, through the same queue, pool and
//     maxRevisions count as a change request, with the failed checks, their annotations and the
//     end of their logs as its diagnostics. One per (PR, head): repeated deliveries, reruns and
//     several failing checks of one head all come to the same revision;
//   - anything else (cancelled, action_required, startup_failure, an error status, checks that
//     cannot be read or never finish, the same failure again after a fix, the limit reached, revise
//     off) stops for a person with the reason, in one comment on the PR;
//   - all decisive checks passed (or there are none): the draft is marked ready for review, and
//     auto-merge, when on, may consider the head (merge.ts applies its own gates on top).
// Every decision is about one head: the PR is read on GitHub first, and a head that moved on is
// left to its own review. The revision is dropped before it starts if the head moved since
// (verdictStale). CI output is untrusted input: it is redacted, capped and fenced in the prompt.
import { createHash } from 'node:crypto';
import { autoMergeMethod, ciSettings, DEFAULT_MAX_REVISIONS, workflowId, type CiSettings, type MergeMethod, type RepositoryConfig } from '../config/schema.js';
import {
  activeRevisionJob,
  getLoopPr,
  listCiCandidates,
  listPendingCiNotices,
  markReadyRecorded,
  observeHead,
  recordCiNotice,
  setCiState,
  startCiFor,
  type LoopPr,
} from '../db/pr-reviews.js';
import { enqueueRevision, getReviewRequest, revisionJob } from '../db/revisions.js';
import { redactGitHubSecrets } from '../github/app-auth.js';
import { GitHubError, type CheckDetail, type CheckRunDiagnostics, type CommitChecks } from '../github/api.js';
import { sameLogin, workerLogin } from '../github/identity.js';
import { ciFailureReviewId, ciTrigger } from '../poller/review-trigger.js';
import { createRedactor } from '../telemetry/runner/redact.mjs';
import type { RepoRef, RevisionRequest } from '../types.js';
import { findRepoConfig } from '../worker/executor.js';
import { code } from './failure-comment.js';
import { cap, fenced, inline, type PublishDeps } from './publish.js';
import { consoleWorkflowUrl } from './console-link.js';
import { noteStatus, quietFor, shortSha } from './status-comment.js';
import { STATUS_STAGE } from './status-marker.js';

export type CiDeps = Pick<PublishDeps, 'db' | 'config' | 'api' | 'log' | 'now' | 'scope' | 'console'>;

/** How often a head that is waiting for its checks is read again by the polling worker. A webhook does not wait for this. */
export const CI_POLL_MS = 60_000;
/** How long after a head was pushed a commit with no checks at all is still waited on: CI registers a moment after the push. */
export const CI_REGISTER_GRACE_MS = 5 * 60_000;
/** Failed check runs whose annotations and log are read per head. */
export const MAX_DIAGNOSED_CHECKS = 5;
/** Attempts to post the one CI comment for a head. */
export const MAX_CI_NOTICE_ATTEMPTS = 5;
const MAX_LOG_BYTES = 64_000;
const MAX_LOG_EXCERPT = 6_000;
const MAX_ANNOTATIONS = 20;
const MAX_DIAGNOSTICS = 30_000;
const MAX_NAMES = 8;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const short = (sha: string) => sha.slice(0, 12);
const isTransient = (err: unknown) => err instanceof GitHubError && (err.status === 0 || err.status >= 500 || err.isRateLimit);
const redactor = createRedactor();
/** CI output can print credentials; the shapes GitHub's own masking can miss are removed. */
export const redactCi = (text: string): string => redactor(redactGitHubSecrets(text));

function names(list: readonly string[]): string {
  const shown = list.slice(0, MAX_NAMES).join(', ');
  return list.length > MAX_NAMES ? `${shown} and ${list.length - MAX_NAMES} more` : shown;
}

// ---------------------------------------------------------------------------
// What the checks say
// ---------------------------------------------------------------------------

/**
 * code: the code under test can have caused it, so a revision may fix it. infra: the run did not
 * get to judge the code (canceled, could not start, an error status). manual: someone has to act
 * on GitHub (action_required). stale: GitHub gave up on it.
 */
export type FailureKind = 'code' | 'infra' | 'manual' | 'stale';

export function failureKind(d: Pick<CheckDetail, 'kind' | 'conclusion'>): FailureKind {
  if (d.kind === 'status') return d.conclusion === 'failure' ? 'code' : 'infra';
  switch (d.conclusion) {
    case 'failure':
    case 'timed_out':
      return 'code';
    case 'action_required':
      return 'manual';
    case 'stale':
      return 'stale';
    default:
      return 'infra'; // cancelled, startup_failure, or a conclusion this client does not know
  }
}

/** The checks of a commit as details, also from a client that reports names only. */
export function checkDetails(checks: CommitChecks): CheckDetail[] {
  if (checks.details) return checks.details;
  return [
    ...checks.pending.map((name): CheckDetail => ({ kind: 'check-run', name, outcome: 'pending', conclusion: null, url: null })),
    ...checks.succeeded.map((name): CheckDetail => ({ kind: 'check-run', name, outcome: 'success', conclusion: 'success', url: null })),
    ...checks.failing.map((name): CheckDetail => ({ kind: 'check-run', name, outcome: 'failure', conclusion: 'failure', url: null })),
  ];
}

/** The checks that decide under the repository's settings: not ignored, and among `checks` when it is set. */
export function relevantChecks(checks: CommitChecks, s: Pick<CiSettings, 'checks' | 'ignore'>): CheckDetail[] {
  const ignored = new Set(s.ignore.map((n) => n.toLowerCase()));
  const wanted = s.checks ? new Set(s.checks.map((n) => n.toLowerCase())) : null;
  return checkDetails(checks).filter((d) => !ignored.has(d.name.toLowerCase()) && (wanted === null || wanted.has(d.name.toLowerCase())));
}

export type CiVerdict =
  | { action: 'wait'; reason: string; failures: CheckDetail[] }
  | { action: 'pass'; reason: string }
  | { action: 'fix'; failures: CheckDetail[]; others: CheckDetail[] }
  | { action: 'block'; reason: string };

/**
 * Judge the checks of one head under the repository's settings. `waitedMs`: how long this head has
 * been waited on; `sincePushMs`: how long ago it was pushed (null when unknown). Pure.
 */
export function judgeChecks(checks: CommitChecks, s: Pick<CiSettings, 'checks' | 'ignore' | 'waitMs'>, sha: string, waitedMs: number, sincePushMs: number | null): CiVerdict {
  const wanted = s.checks ? new Set(s.checks.map((n) => n.toLowerCase())) : null;
  const relevant = relevantChecks(checks, s);
  const failed = relevant.filter((d) => d.outcome === 'failure');
  const fixable = failed.filter((d) => failureKind(d) === 'code');
  const pending = relevant.filter((d) => d.outcome === 'pending');
  const timedOut = waitedMs >= s.waitMs;
  const minutes = Math.round(s.waitMs / 60_000);

  if (!checks.complete && !fixable.length) {
    return timedOut
      ? { action: 'block', reason: `the checks of ${short(sha)} could not all be read (${checks.total} seen) within ${minutes} minute(s), so it is unknown whether they passed` }
      : { action: 'wait', reason: `the checks of ${short(sha)} could not all be read (${checks.total} seen)`, failures: [] };
  }
  // Every failure of one head goes into one revision: wait for the rest to finish first.
  if (pending.length && !timedOut) {
    return { action: 'wait', reason: `${pending.length} check(s) of ${short(sha)} are pending: ${names(pending.map((d) => d.name))}`, failures: failed };
  }
  if (fixable.length) return { action: 'fix', failures: fixable, others: failed.filter((d) => !fixable.includes(d)) };
  if (failed.length) {
    const what = failed.map((d) => `${d.name} (${d.conclusion ?? 'failed'})`);
    const manual = failed.some((d) => failureKind(d) === 'manual');
    return {
      action: 'block',
      reason:
        `${failed.length} check(s) of ${short(sha)} did not pass for a reason a code change cannot fix: ${names(what)}. ` +
        (manual ? 'One is waiting for someone to approve or act on it on GitHub.' : 'Re-run them on GitHub once the cause is dealt with.'),
    };
  }
  if (pending.length) {
    return { action: 'block', reason: `gave up after waiting ${minutes} minute(s): ${pending.length} check(s) of ${short(sha)} are still pending: ${names(pending.map((d) => d.name))}` };
  }
  if (wanted) {
    const seen = new Set(relevant.filter((d) => d.outcome === 'success' || d.outcome === 'skipped').map((d) => d.name.toLowerCase()));
    const missing = (s.checks ?? []).filter((n) => !seen.has(n.toLowerCase()));
    if (missing.length) {
      return timedOut
        ? { action: 'block', reason: `gave up after waiting ${minutes} minute(s): check(s) ${names(missing)} never reported on ${short(sha)}` }
        : { action: 'wait', reason: `check(s) ${names(missing)} have not reported on ${short(sha)} yet`, failures: [] };
    }
    return { action: 'pass', reason: `the check(s) ${names(s.checks ?? [])} passed on ${short(sha)}` };
  }
  if (!relevant.length) {
    // CI registers its checks a moment after the push. A repository without CI passes once that moment is over.
    const since = sincePushMs ?? waitedMs;
    if (since < Math.min(CI_REGISTER_GRACE_MS, s.waitMs)) return { action: 'wait', reason: `no check has reported on ${short(sha)} yet`, failures: [] };
    return { action: 'pass', reason: `no check reported on ${short(sha)}; there is nothing to wait for` };
  }
  const passed = relevant.filter((d) => d.outcome === 'success').length;
  return { action: 'pass', reason: `${passed} check(s) of ${short(sha)} passed${relevant.length > passed ? `, ${relevant.length - passed} skipped or neutral` : ''}` };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** A GitHub Actions log line without its timestamp. */
const stripTimestamp = (line: string) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '');
const ERROR_LINE = /##\[error\]|\berror\b|\bfail(?:ed|ure|s)?\b|✗|✖|panic|exception|assert/i;

/**
 * The part of a job log worth reading: the lines around the first error marker and the end of the
 * log, without timestamps, at most `max` characters.
 */
export function logExcerpt(log: string, max = MAX_LOG_EXCERPT): string {
  const lines = log.replace(/\r\n?/g, '\n').split('\n').map(stripTimestamp);
  while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
  const tailFrom = Math.max(0, lines.length - 60);
  const first = lines.findIndex((l) => ERROR_LINE.test(l));
  const parts: string[] = [];
  if (first >= 0 && first < tailFrom - 1) parts.push(...lines.slice(Math.max(0, first - 10), Math.min(tailFrom, first + 30)), '…');
  parts.push(...lines.slice(tailFrom));
  const text = parts.join('\n');
  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
}

/** One failed check, read for the revision: its annotations and the end of its log, redacted. */
export interface DiagnosedFailure {
  check: CheckDetail;
  diagnostics: CheckRunDiagnostics | null;
}

/** What every failed Actions step says, whatever failed: not a fingerprint of anything. */
const GENERIC_LINE = /^(?:##\[error\])?\s*process completed with exit code #\.?$/;

/**
 * The failure as a digest of what was read of it: the annotations and the error region of each
 * failed check's log, with timestamps and numbers (durations, counts, line numbers) taken out and
 * the runner's generic "Process completed with exit code N." left out. The same digest after a fix
 * is no progress.
 *
 * `null` when the content of some failed check was not read (a commit status, a check past
 * MAX_DIAGNOSED_CHECKS, a log that could not be read) or says nothing beyond the generic line:
 * two such failures cannot be told apart, so they are not taken for the same failure.
 */
export function failureSignature(failures: readonly DiagnosedFailure[]): string | null {
  if (!failures.length) return null;
  const norm = (t: string) => t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  const meaningful = (t: string) => t !== '' && !GENERIC_LINE.test(t);
  const parts: string[] = [];
  for (const f of failures) {
    const notes = (f.diagnostics?.annotations ?? [])
      .slice(0, MAX_ANNOTATIONS)
      .filter((a) => meaningful(norm(a.message)))
      .map((a) => norm(`${a.path} ${a.title ?? ''} ${a.message}`))
      .sort();
    let tail = f.diagnostics?.logTail ?? '';
    // A tail cut at MAX_LOG_BYTES starts mid-line, at a place that moves with the length of the log.
    if (tail.length >= MAX_LOG_BYTES) tail = tail.slice(tail.indexOf('\n') + 1);
    const lines = tail ? logExcerpt(tail).split('\n').map(norm).filter(meaningful) : [];
    if (!notes.length && !lines.length) return null;
    parts.push([norm(f.check.name), f.check.conclusion ?? '', ...notes, '\u0002', ...lines].join('\u0001'));
  }
  return createHash('sha256').update(parts.sort().join('\u0000')).digest('hex').slice(0, 32);
}

/** The diagnostics a CI-fix revision is given, as plain text. Untrusted parts are redacted and capped; the prompt fences the whole. */
export function renderDiagnostics(o: { prNumber: number; headSha: string; failures: readonly DiagnosedFailure[]; others: readonly CheckDetail[] }): string {
  const out: string[] = [`Checks that failed on ${o.headSha} (pull request #${o.prNumber}):`, ''];
  for (const f of o.failures) {
    const c = f.check;
    out.push(`## ${c.name} (${c.kind === 'status' ? 'commit status' : 'check run'}: ${c.conclusion ?? 'failed'})`);
    if (c.url) out.push(`URL: ${c.url}`);
    if (c.summary) out.push('', 'Summary:', redactCi(cap(c.summary, 2_000)));
    const d = f.diagnostics;
    if (d?.annotations.length) {
      out.push('', 'Annotations:');
      for (const a of d.annotations.slice(0, MAX_ANNOTATIONS)) {
        out.push(`- ${a.path || '(no file)'}${a.line !== null ? `:${a.line}` : ''} [${a.level}]${a.title ? ` ${redactCi(cap(a.title, 200))}:` : ''} ${redactCi(cap(a.message, 1_000))}`);
      }
    }
    if (d?.logTail) out.push('', 'End of the job log:', redactCi(logExcerpt(d.logTail)));
    for (const p of d?.problems ?? []) out.push('', `(Updraft: ${p})`);
    if (!d && c.kind === 'check-run') out.push('', '(Updraft: no annotations or log were read for this check)');
    out.push('');
  }
  if (o.others.length) {
    out.push('Also not passing, but not for a reason in the code (leave these alone):');
    for (const c of o.others) out.push(`- ${c.name}: ${c.conclusion ?? 'failed'}${c.url ? ` (${c.url})` : ''}`);
  }
  return cap(out.join('\n'), MAX_DIAGNOSTICS);
}

async function diagnose(deps: CiDeps, repo: RepoRef, failures: readonly CheckDetail[]): Promise<DiagnosedFailure[]> {
  const out: DiagnosedFailure[] = [];
  let read = 0;
  for (const check of failures) {
    if (check.kind !== 'check-run' || check.checkRunId === undefined || read >= MAX_DIAGNOSED_CHECKS) {
      out.push({ check, diagnostics: null });
      continue;
    }
    read++;
    // Transient failures throw, and the step is taken again on the next cycle.
    out.push({ check, diagnostics: await deps.api.getCheckRunDiagnostics(repo, check.checkRunId, { maxLogBytes: MAX_LOG_BYTES }) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

export type CiStepResult =
  | { status: 'none' }
  | { status: 'waiting'; reason: string }
  | { status: 'passed'; reason: string }
  | { status: 'fixing'; jobId: string }
  | { status: 'blocked'; reason: string };

/**
 * Take the CI step for one PR. `force`: read the checks now even if they were read less than
 * CI_POLL_MS ago (a webhook said they changed). Never throws.
 */
export async function evaluateCi(deps: CiDeps, repo: RepoRef, cfg: RepositoryConfig, candidate: LoopPr, opts: { force?: boolean } = {}): Promise<CiStepResult> {
  const { db, api } = deps;
  const now = deps.now ?? Date.now;
  const settings = ciSettings(deps.config, cfg);
  const sha = candidate.headSha;
  if (!settings || !sha) return { status: 'none' };
  const log = deps.log.child({ repo: repo.fullName, pr: candidate.prNumber, head: sha });
  try {
    startCiFor(db, candidate.repoId, candidate.prNumber, sha, now);
    const pr = getLoopPr(db, candidate.repoId, candidate.prNumber);
    if (!pr || pr.state !== 'open' || pr.verdict !== 'ready-to-merge' || pr.verdictSha !== sha || pr.headSha !== sha) return { status: 'none' };
    if (pr.ciState !== null && pr.ciState !== 'waiting') return { status: 'none' };
    if (!opts.force && pr.ciState === 'waiting' && pr.ciCheckedAt && now() - Date.parse(pr.ciCheckedAt) < CI_POLL_MS) return { status: 'waiting', reason: pr.ciReason ?? '' };

    const block = (reason: string, signature?: string | null): CiStepResult => {
      if (setCiState(db, pr.repoId, pr.prNumber, sha, { state: 'blocked', reason, signature: signature ?? null }, now)) log.warn('the checks need a person', { reason });
      return { status: 'blocked', reason };
    };
    const wait = (reason: string): CiStepResult => {
      setCiState(db, pr.repoId, pr.prNumber, sha, { state: 'waiting', reason }, now);
      log.info('waiting for checks', { reason });
      return { status: 'waiting', reason };
    };

    // The pull request as it is on GitHub now: a decision is only ever about its current head.
    const readAt = new Date(now()).toISOString();
    const live = await api.getPullRequest(repo, pr.prNumber);
    if (live.state !== 'open' || live.merged) return { status: 'none' };
    if (live.headSha !== sha) {
      observeHead(db, pr.repoId, pr.prNumber, live.headSha, readAt);
      log.info('not judging the checks: the pull request moved on from the reviewed commit', { head: live.headSha });
      return { status: 'none' };
    }

    const checks = await api.getCommitChecks(repo, sha);
    const waitedMs = pr.ciWaitStartedAt ? now() - Date.parse(pr.ciWaitStartedAt) : 0;
    const sincePushMs = pr.headAt ? now() - Date.parse(pr.headAt) : null;
    const verdict = judgeChecks(checks, settings, sha, waitedMs, sincePushMs);

    if (verdict.action === 'wait') return wait(verdict.reason);
    if (verdict.action === 'block') return block(verdict.reason);
    if (verdict.action === 'pass') {
      // Ready for review only now that the checks hold; a draft becomes ready.
      if (live.draft) {
        await api.markPullRequestReady(repo, live.nodeId);
        markReadyRecorded(db, pr.repoId, pr.prNumber, now);
      }
      setCiState(db, pr.repoId, pr.prNumber, sha, { state: 'passed', reason: verdict.reason }, now);
      log.info('checks passed', { reason: verdict.reason });
      return { status: 'passed', reason: verdict.reason };
    }

    // A failure the code can cause.
    const failedNames = names(verdict.failures.map((d) => d.name));
    if (!settings.fix) return block(`check(s) failed on ${short(sha)}: ${failedNames}. Revisions are off for this repository, so fixing them is up to a person`);
    // One revision at a time per pull request: one that is on its way (a person's change request)
    // comes first, and its push gets a review and checks of its own.
    // This head's own fix (queued by an earlier try of this step) is not another revision.
    const active = activeRevisionJob(db, pr.repoId, pr.prNumber, ciFailureReviewId(pr.prNumber, sha));
    if (active) return wait(`check(s) failed on ${short(sha)} (${failedNames}), but revision job ${active} is already on its way`);

    let diagnosed: DiagnosedFailure[];
    try {
      diagnosed = await diagnose(deps, repo, verdict.failures);
    } catch (err) {
      if (isTransient(err)) throw err;
      diagnosed = verdict.failures.map((check) => ({ check, diagnostics: { annotations: [], logTail: null, problems: [`the diagnostics could not be read: ${message(err)}`] } }));
    }
    const signature = failureSignature(diagnosed);
    if (signature !== null && pr.ciLastFixSignature === signature) {
      return block(
        `check(s) ${failedNames} failed on ${short(sha)} in the same way as before the last automatic fix, so another fix is unlikely to help`,
        signature,
      );
    }

    const wf = cfg.workflows.find((w) => workflowId(w) === pr.workflowId);
    if (!wf) return block(`check(s) failed on ${short(sha)}: ${failedNames}, but workflow "${pr.workflowId}" no longer exists in the config`, signature);
    const login = await workerLogin(api);
    const trigger = ciTrigger({
      prNumber: pr.prNumber,
      headSha: sha,
      diagnostics: renderDiagnostics({ prNumber: pr.prNumber, headSha: sha, failures: diagnosed, others: verdict.others }),
      worker: login,
      url: verdict.failures.find((d) => d.url)?.url ?? pr.prUrl,
      recordedAt: readAt,
    });
    const revision: RevisionRequest = {
      trigger: trigger.kind,
      pullRequest: { number: pr.prNumber, url: pr.prUrl, branch: pr.branch },
      sourceRunId: pr.sourceRunId,
      originalEventId: pr.originalEventId,
      review: trigger.review,
      reviewedSha: trigger.reviewedSha,
    };
    const max = cfg.maxRevisions ?? DEFAULT_MAX_REVISIONS;
    const queued = enqueueRevision(
      db,
      {
        repoId: pr.repoId,
        reviewId: trigger.reviewId,
        prNumber: pr.prNumber,
        reviewer: login,
        trigger: trigger.kind,
        reviewUrl: trigger.review.url,
        submittedAt: trigger.review.submittedAt,
        // The pool of the job that opened the PR, as for every revision: the same agents and the
        // same way of running them (subscription or key) as the code it fixes.
        job: revisionJob(repo, pr, revision),
        max,
      },
      now,
    );
    // A retry of this step (after a crash between the two writes) finds the record the first try wrote.
    const recorded = queued.status === 'duplicate' ? getReviewRequest(db, pr.repoId, trigger.reviewId) : null;
    const jobId = queued.status === 'queued' ? queued.job.id : recorded?.state === 'queued' ? recorded.jobId : null;
    if (jobId) {
      const reason = `check(s) failed on ${short(sha)}: ${failedNames}`;
      setCiState(db, pr.repoId, pr.prNumber, sha, { state: 'fixing', reason, jobId, signature }, now);
      log.info('revision queued for the failed checks', { job: jobId, checks: failedNames });
      return { status: 'fixing', jobId };
    }
    if (queued.status === 'over-limit' || recorded?.state === 'over-limit') {
      return block(`check(s) failed on ${short(sha)}: ${failedNames}, and the pull request has used its ${max} revision(s) (maxRevisions)`, signature);
    }
    return block(`check(s) failed on ${short(sha)}: ${failedNames}, and a revision for this commit was recorded before (${recorded?.reason ?? 'its job was pruned'})`, signature);
  } catch (err) {
    if (isTransient(err)) {
      log.warn('could not read the checks for now', { error: message(err) });
      return { status: 'none' };
    }
    log.error('the CI step failed', { error: message(err) });
    try {
      setCiState(db, candidate.repoId, candidate.prNumber, sha, { state: 'blocked', reason: `GitHub could not be asked about the checks: ${message(err)}` }, now);
    } catch {
      // looked at again on the next cycle
    }
    return { status: 'blocked', reason: message(err) };
  }
}

/** The CI step for every repository that has it on. `only`: these pull requests (a webhook named them). Never throws. */
export async function evaluateCiAll(deps: CiDeps, signal?: AbortSignal, opts: { only?: { repoId: number; prNumber: number }; force?: boolean } = {}): Promise<CiStepResult[]> {
  const results: CiStepResult[] = [];
  for (const [fullName, cfg] of Object.entries(deps.config.repositories)) {
    if (!ciSettings(deps.config, cfg)) continue;
    if (opts.only && opts.only.repoId !== cfg.id) continue;
    let candidates: LoopPr[];
    try {
      candidates = listCiCandidates(deps.db, cfg.id).filter(
        (pr) => (deps.scope?.pr(pr.repoId, pr.prNumber) ?? true) && (!opts.only || opts.only.prNumber === pr.prNumber),
      );
    } catch (err) {
      deps.log.error('could not list pull requests whose checks to read', { repo: fullName, error: message(err) });
      continue;
    }
    for (const pr of candidates) {
      if (signal?.aborted) return results;
      results.push(await evaluateCi(deps, { id: cfg.id, fullName }, cfg, pr, { force: opts.force ?? false }));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// The comment
// ---------------------------------------------------------------------------

const CI_ROLE = 'Updraft · CI';
/** The first line of a CI comment written by this version (renderCiNotice), and not before. */
const CI_HEADING = /^\*\*Updraft · CI · `/;

/** Hidden marker on the one CI comment of a head. */
export function ciNoticeMarker(sha: string): string {
  return `<!-- updraft-ci: ${sha} -->`;
}

/** A check's link for Markdown: https only, and the characters that would end the link escaped. Null when it is not one. */
export function checkLink(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  return u.href.replace(/[()<>\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** One line per failed check of the head: its name, what it concluded and its link where GitHub gave one. */
function failedLines(failed: readonly CheckDetail[]): string[] {
  const shown = failed.slice(0, MAX_NAMES).map((d) => {
    const link = checkLink(d.url);
    const name = code(d.name);
    return `- ${link ? `[${name}](${link})` : name} (${d.kind === 'status' ? 'status' : 'check run'}: ${d.conclusion ?? 'failed'})`;
  });
  return failed.length > MAX_NAMES ? [...shown, `- and ${failed.length - MAX_NAMES} more, on the pull request's Checks tab`] : shown;
}

/**
 * The one comment of a head's CI step, spoken as **Updraft · CI**: a fix was queued (with the
 * failed checks and their links), the checks need a person, or, after an automatic CI fix of the
 * pull request, the checks passed and what happens now. `failed`: the head's failed checks as read
 * for the comment, or null when they could not be read (the reason still names them).
 */
export function renderCiNotice(o: {
  pr: LoopPr;
  sha: string;
  max: number;
  repoFullName: string;
  failed?: readonly CheckDetail[] | null;
  merge?: MergeMethod | null;
}): string {
  const { pr } = o;
  const reason = fenced(cap(pr.ciReason ?? 'no reason was recorded', 2_000));
  const head = `**${CI_ROLE} · ${code(short(o.sha))}**`;
  const failed = o.failed?.length ? ['**Failed checks**', '', ...failedLines(o.failed), ''] : [];
  let lines: string[];
  if (pr.ciState === 'passed') {
    lines = [
      head,
      '',
      `The checks passed on commit ${code(short(o.sha))} after ${pr.ciFixes} automatic CI fix(es) on this pull request, and Updraft's reviewer found this ` +
        'same commit ready to merge: review and checks are both clean on it.',
      '',
      code(cap(pr.ciReason ?? 'passed', 300)),
      '',
      o.merge ? `Updraft merges it (${code(o.merge)}) if nothing else stands in the way; if something does, it says why here.` : 'It is ready for a person to merge.',
    ];
  } else if (pr.ciState === 'fixing') {
    lines = [
      head,
      '',
      `The review passed, but GitHub's checks failed on commit ${code(short(o.sha))}, which Updraft's reviewer found ready to merge. Updraft queued a revision to fix them ` +
        `(automatic CI fix ${pr.ciFixes} on this pull request; revisions of this pull request count against ${code(`repositories.${o.repoFullName}.maxRevisions`)}: ${o.max}).`,
      '',
      ...failed,
      '**Failed**',
      '',
      reason,
      '',
      `Revision job ${code(pr.ciFixJobId ?? '?')} gets the failed checks, their annotations and the end of their logs. Its push gets a new review and new checks.`,
    ];
  } else {
    lines = [
      head,
      '',
      `Updraft's reviewer found commit ${code(short(o.sha))} ready to merge, but its checks need a person: Updraft will not fix or merge this commit by itself.`,
      '',
      ...failed,
      '**Reason**',
      '',
      reason,
      '',
      'A new commit on this branch gets a new review and new checks.',
    ];
  }
  return [...lines, '', ciNoticeMarker(o.sha)].join('\n');
}

/**
 * Quiet notifications: the CI step speaks on the pull request only when it stops and a person has
 * to act (the checks need a person, or they passed after a fix and merging is up to a person), in
 * one or two plain sentences with what to do. Null when nothing is owed to a person: a fix under
 * way, or a pass that auto-merge takes from here (the status comment says both).
 */
export function renderQuietCiNotice(o: { pr: LoopPr; sha: string; failed?: readonly CheckDetail[] | null; merge?: MergeMethod | null; link?: string | null }): string | null {
  const { pr } = o;
  const link = o.link ? ` [View this work in Updraft](${o.link})` : '';
  let lines: string[];
  if (pr.ciState === 'blocked') {
    lines = [
      `Updraft stopped working on the checks of PR #${pr.prNumber} at ${code(short(o.sha))} and needs a person: ${inline(cap(pr.ciReason ?? 'no reason was recorded', 600))}. ` +
        `Please fix the checks or push a commit; a new commit gets a new review and new checks.${link}`,
      ...(o.failed?.length ? ['', ...failedLines(o.failed)] : []),
    ];
  } else if (pr.ciState === 'passed' && !o.merge) {
    lines = [
      `The checks of PR #${pr.prNumber} pass on ${code(short(o.sha))} after CI fix ${pr.ciFixes}, and the review found it ready. ` +
        `Please merge it when you are ready; Updraft does not merge pull requests in this repository.${link}`,
    ];
  } else {
    return null;
  }
  return [...lines, '', ciNoticeMarker(o.sha)].join('\n');
}

/** The status comment's line for a head's CI step (quiet notifications). */
function ciStatus(pr: LoopPr, sha: string, merge: MergeMethod | null): { title: string; text: string } | null {
  if (pr.ciState === 'fixing') return { title: 'Fixing checks', text: `Fixing failed checks on \`${shortSha(sha)}\` of PR #${pr.prNumber} (CI fix ${pr.ciFixes}).` };
  if (pr.ciState === 'passed') {
    return merge
      ? { title: 'Checks passed', text: `Checks passed on \`${shortSha(sha)}\` of PR #${pr.prNumber} after CI fix ${pr.ciFixes}; Updraft merges it once nothing else stands in the way.` }
      : { title: 'Waiting for a person', text: `Checks passed on \`${shortSha(sha)}\` of PR #${pr.prNumber} after CI fix ${pr.ciFixes}; it is ready for a person to merge.` };
  }
  if (pr.ciState === 'blocked') return { title: 'Waiting for a person', text: `The checks of PR #${pr.prNumber} need a person (see the PR).` };
  return null;
}

/** The failed checks of `sha` that decide, for the comment. Best effort: null when GitHub could not be asked. */
async function failedChecks(deps: CiDeps, repo: RepoRef, sha: string, settings: Pick<CiSettings, 'checks' | 'ignore'>): Promise<CheckDetail[] | null> {
  try {
    return relevantChecks(await deps.api.getCommitChecks(repo, sha), settings).filter((d) => d.outcome === 'failure');
  } catch {
    return null;
  }
}

/**
 * Post the one comment for each head whose CI step queued a fix or stopped for a person, or whose
 * checks passed after an automatic CI fix of the pull request. Looks
 * for the marker among the worker's own comments before posting. Never throws.
 */
export async function postCiNotices(deps: CiDeps, signal?: AbortSignal): Promise<void> {
  let pending: LoopPr[];
  try {
    pending = listPendingCiNotices(deps.db, MAX_CI_NOTICE_ATTEMPTS).filter((pr) => deps.scope?.pr(pr.repoId, pr.prNumber) ?? true);
  } catch (err) {
    deps.log.error('could not list pull requests with a CI comment to post', { error: message(err) });
    return;
  }
  for (const pr of pending) {
    if (signal?.aborted) return;
    const found = findRepoConfig(deps.config, { repoId: pr.repoId, repoFullName: '' });
    const sha = pr.ciSha;
    const settings = found ? ciSettings(deps.config, found.repo) : null;
    if (!found || !sha || !settings) continue;
    const repoRef = { id: pr.repoId, fullName: found.fullName };
    try {
      const merge = autoMergeMethod(deps.config, found.repo);
      if (quietFor(deps.config, { repoId: pr.repoId, repoFullName: found.fullName })) {
        const status = ciStatus(pr, sha, merge);
        if (status) await noteStatus({ api: deps.api, log: deps.log }, { repo: repoRef, issue: pr.issueNumber, target: { pr: pr.prNumber }, stage: STATUS_STAGE.loop, ...status });
        const body = renderQuietCiNotice({
          pr,
          sha,
          failed: pr.ciState === 'blocked' ? await failedChecks(deps, repoRef, sha, settings) : null,
          merge,
          link: consoleWorkflowUrl(deps.console, pr.repoId, pr.issueNumber),
        });
        if (!body) {
          // Nothing a person has to do: the status comment said it.
          recordCiNotice(deps.db, pr.repoId, pr.prNumber, sha, { skipped: true }, deps.now);
          continue;
        }
        const login = await workerLogin(deps.api);
        const marker = ciNoticeMarker(sha);
        const existing = (await deps.api.listIssueComments(repoRef, pr.prNumber)).find((c) => c.body.includes(marker) && sameLogin(c.user, login));
        const posted = existing ?? (await deps.api.createIssueComment(repoRef, pr.prNumber, body));
        recordCiNotice(deps.db, pr.repoId, pr.prNumber, sha, { commentId: posted.id, commentUrl: posted.htmlUrl }, deps.now);
        deps.log.info('asked a person about the checks', { repo: found.fullName, pr: pr.prNumber, state: pr.ciState, comment: posted.htmlUrl });
        continue;
      }
      const login = await workerLogin(deps.api);
      const marker = ciNoticeMarker(sha);
      const own = (await deps.api.listIssueComments(repoRef, pr.prNumber)).filter((c) => sameLogin(c.user, login));
      const existing = own.find((c) => c.body.includes(marker));
      // The outcome of a fix is said only where this version said the fix was queued (its CI
      // comment carries the Updraft · CI heading). A pull request fixed before this version
      // already had its last word: it is recorded as said, and never gets a late comment.
      if (!existing && pr.ciState === 'passed' && !own.some((c) => c.body.includes('<!-- updraft-ci: ') && CI_HEADING.test(c.body))) {
        recordCiNotice(deps.db, pr.repoId, pr.prNumber, sha, { skipped: true }, deps.now);
        deps.log.info('not commenting on checks that passed after a fix queued before this version', { repo: found.fullName, pr: pr.prNumber });
        continue;
      }
      const render = async () =>
        renderCiNotice({
          pr,
          sha,
          max: found.repo.maxRevisions ?? DEFAULT_MAX_REVISIONS,
          repoFullName: found.fullName,
          // Linked on the pull request even when their logs cannot be read.
          failed: pr.ciState === 'passed' ? null : await failedChecks(deps, repoRef, sha, settings),
          merge,
        });
      const posted = existing ?? (await deps.api.createIssueComment(repoRef, pr.prNumber, await render()));
      recordCiNotice(deps.db, pr.repoId, pr.prNumber, sha, { commentId: posted.id, commentUrl: posted.htmlUrl }, deps.now);
      deps.log.info('commented on the checks', { repo: found.fullName, pr: pr.prNumber, state: pr.ciState, comment: posted.htmlUrl });
    } catch (err) {
      const detail = message(err);
      deps.log.warn('could not comment on the checks', { repo: found.fullName, pr: pr.prNumber, error: inline(detail) });
      try {
        recordCiNotice(deps.db, pr.repoId, pr.prNumber, sha, { error: detail }, deps.now);
      } catch {
        // tried again after the next poll
      }
    }
  }
}
