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
import { observeLiveHead } from '../poller/head-lag.js';
import { createHash } from 'node:crypto';
import { autoMergeMethod, ciSettings, DEFAULT_MAX_REVISIONS, suggestionsActive, workflowId, type CiSettings, type MergeMethod, type RepositoryConfig } from '../config/schema.js';
import {
  activeRevisionJob,
  getLoopPr,
  listCiCandidates,
  listPendingCiNotices,
  markReadyRecorded,
  recordCiNotice,
  recordCiRerun,
  resumeBlockedCi,
  setCiState,
  startCiFor,
  touchBlockedCi,
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
/** How often the checks of a head stopped for a person are read again by the polling worker, for a pass after a re-run. A webhook does not wait for this. */
export const CI_BLOCKED_POLL_MS = 5 * 60_000;
/** GitHub lists at most this many files of a pull request: a diff this long may not be all of it. */
const MAX_DIFF_FILES = 3_000;
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
// One re-run (docs/ci-fix.md, "One re-run")
// ---------------------------------------------------------------------------

const OS_TOKEN = /\b(?:ubuntu|windows|macos|linux|darwin|win|mac|osx)(?:-(?:latest|\d+(?:\.\d+)*))?\b/g;
const VERSION_TOKEN = /\bv?\d+(?:\.(?:\d+|x))*\b/g;
/** A shard ("3/4", "3 of 4"): another part of the tests, not the same tests elsewhere. */
const SHARD = /\b\d+\s*(?:\/|of)\s*\d+\b/i;

/**
 * A check's name with its matrix values (an OS, a runtime or tool version) taken out, or null when
 * it has none: two legs of one matrix job ("windows-latest / node 22", "ubuntu-latest / node 22",
 * "test (macos-14, 3.12)") come to the same key. Shards of one job do not.
 */
export function matrixKey(name: string): string | null {
  const lower = name.toLowerCase();
  if (SHARD.test(lower)) return null;
  const key = lower.replace(OS_TOKEN, '<os>').replace(VERSION_TOKEN, '<v>');
  return key === lower ? null : key.replace(/\s+/g, ' ').trim();
}

const SOURCE_FILE =
  /(?:[A-Za-z]:)?(?:[\w.@+-]+[\\/])*[\w@+-][\w.@+-]*\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|kts|scala|cs|fs|php|swift|c|cc|cpp|cxx|h|hpp|m|mm|vue|svelte|ex|exs|erl|dart|lua|sh|ps1)\b/g;
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec|specs)\/|[._-](?:test|spec)s?\.[a-z]+$|(?:^|\/)test_[^/]+$|_test\.[a-z]+$/i;
const MAX_NAMED_FILES = 50;

/** A file path as a log or an annotation names it, as a repository path: forward slashes, no drive or leading "./". */
const normPath = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').replace(/^(?:\.\/)+/, '');

/**
 * The source and test files a failed check names: its annotations' paths and the paths in the
 * error region and end of its log. Dependencies (node_modules, vendor, site-packages) and the
 * runtime's own files are left out: they are not the repository's. Untrusted text, read only to
 * compare against the diff.
 */
export function namedFiles(d: CheckRunDiagnostics | null): string[] {
  if (!d) return [];
  const out = new Set<string>();
  const add = (raw: string) => {
    const p = normPath(raw.trim());
    if (!p || /(?:^|\/)(?:node_modules|vendor|site-packages|dist-packages|\.pnpm|\.yarn)\//.test(p) || /^node:/.test(p)) return;
    if (out.size < MAX_NAMED_FILES) out.add(p);
  };
  for (const a of d.annotations) if (a.path) add(a.path);
  const text = d.logTail ? logExcerpt(d.logTail).replace(/\b(?:https?|file|node):\/*[^\s)'"]+/g, ' ') : '';
  for (const m of text.matchAll(SOURCE_FILE)) add(m[0]);
  return [...out];
}

/**
 * Whether a file a check named is one of the diff's: the same path, the diff's path at the end of
 * an absolute one (the runner's checkout), or, for a bare file name, a diff file of that name.
 */
export function inDiff(file: string, diff: readonly string[]): boolean {
  const f = normPath(file).toLowerCase();
  return diff.some((raw) => {
    const d = normPath(raw).toLowerCase();
    if (!d) return false;
    if (f === d || f.endsWith(`/${d}`) || d.endsWith(`/${f}`)) return true;
    return !f.includes('/') && d.slice(d.lastIndexOf('/') + 1) === f;
  });
}

export type RerunDecision =
  | { rerun: true; runs: number[]; checks: string[]; files: string[]; why: string }
  | { rerun: false; why: string };

/**
 * Whether the failed checks of a head are re-run once instead of fixed: every one of them is a job
 * of a GitHub Actions workflow run, its log or annotations were read and name no file of the
 * pull request's diff, and either the same job passed on another leg of its matrix (same workflow
 * run, a name that differs only in its matrix values) or what it names includes a test file, all
 * outside the diff. `diff`: the pull request's files, null when they could not all be read (then
 * nothing is re-run: a failure inside the diff must never be). Pure.
 */
export function decideRerun(failures: readonly DiagnosedFailure[], all: readonly CheckDetail[], diff: readonly string[] | null): RerunDecision {
  if (!failures.length) return { rerun: false, why: 'nothing failed' };
  if (diff === null) return { rerun: false, why: "the pull request's files could not all be read" };
  const runs = new Set<number>();
  const files = new Set<string>();
  const whys: string[] = [];
  for (const f of failures) {
    const c = f.check;
    if (c.kind !== 'check-run' || c.workflowRunId === undefined) return { rerun: false, why: `${c.name} is not a GitHub Actions job that can be re-run` };
    if (failureKind(c) !== 'code') return { rerun: false, why: `${c.name} did not fail in a way a re-run answers` };
    const d = f.diagnostics;
    if (!d || (!d.logTail && !d.annotations.length)) return { rerun: false, why: `nothing of ${c.name} could be read, so it is unknown whether it fails in the change` };
    const named = namedFiles(d);
    const inside = named.filter((n) => inDiff(n, diff));
    if (inside.length) return { rerun: false, why: `${c.name} names ${names(inside)}, which this pull request changes` };
    const key = matrixKey(c.name);
    const leg =
      key === null
        ? undefined
        : all.find((o) => o !== c && o.kind === 'check-run' && o.outcome === 'success' && o.workflowRunId === c.workflowRunId && o.name !== c.name && matrixKey(o.name) === key);
    if (leg) whys.push(`${c.name} passed on another leg of its matrix (${leg.name})`);
    else if (named.some((n) => TEST_FILE.test(n))) whys.push(`${c.name} failed in ${names(named)}, which this pull request does not touch`);
    else return { rerun: false, why: `${c.name} failed, and nothing shows it is not the change's` };
    runs.add(c.workflowRunId);
    for (const n of named) files.add(n);
  }
  return { rerun: true, runs: [...runs], checks: failures.map((f) => f.check.name), files: [...files], why: whys.join('; ') };
}

/** The pull request's files, or null when they could not all be read. Transient failures throw. */
async function diffFiles(deps: CiDeps, repo: RepoRef, prNumber: number): Promise<string[] | null> {
  if (!deps.api.listPullRequestFiles) return null;
  try {
    const files = await deps.api.listPullRequestFiles(repo, prNumber);
    return files.length >= MAX_DIFF_FILES ? null : files.map((f) => f.path);
  } catch (err) {
    if (isTransient(err)) throw err;
    return null;
  }
}

/**
 * For the reason a person reads, when the checks of `sha` failed again after their one re-run
 * (`pr` as it was before this step): that it failed twice, where, and that a pass on this commit
 * still carries on. Empty when `sha` was not re-run.
 */
function afterRerun(pr: LoopPr, sha: string, failedNames: string, merge: boolean): string {
  if (pr.ciRerunSha !== sha) return '';
  const where = pr.ciRerunFiles.length ? ` in ${names(pr.ciRerunFiles)}, which this pull request does not touch` : '';
  return (
    `. ${failedNames} failed twice, before and after Updraft re-ran it${where}. ` +
    `It looks unrelated to the change: re-run it or fix it on ${pr.baseBranch ?? 'the base branch'}, and Updraft ${merge ? 'merges' : 'carries on'} once the checks pass on this commit`
  );
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
    if (pr.ciState !== null && pr.ciState !== 'waiting' && pr.ciState !== 'blocked') return { status: 'none' };
    if (!opts.force && pr.ciState === 'waiting' && pr.ciCheckedAt && now() - Date.parse(pr.ciCheckedAt) < CI_POLL_MS) return { status: 'waiting', reason: pr.ciReason ?? '' };
    if (pr.ciState === 'blocked' && !opts.force && pr.ciCheckedAt && now() - Date.parse(pr.ciCheckedAt) < CI_BLOCKED_POLL_MS) return { status: 'blocked', reason: pr.ciReason ?? '' };
    const merge = autoMergeMethod(deps.config, cfg);
    const quiet = quietFor(deps.config, { repoId: pr.repoId, repoFullName: repo.fullName });

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
      await observeLiveHead({ db, api }, repo, pr, live.headSha, readAt);
      log.info('not judging the checks: the pull request moved on from the reviewed commit', { head: live.headSha });
      return { status: 'none' };
    }

    const checks = await api.getCommitChecks(repo, sha);
    const sincePushMs = pr.headAt ? now() - Date.parse(pr.headAt) : null;

    // Stopped for a person on this head: only a pass on it now (a re-run, by a person or by
    // Updraft) moves it on, exactly as a pass would have. Anything else leaves it where it is,
    // with nothing queued and nothing said again.
    if (pr.ciState === 'blocked') {
      const again = judgeChecks(checks, settings, sha, 0, sincePushMs);
      if (again.action !== 'pass') {
        touchBlockedCi(db, pr.repoId, pr.prNumber, sha, now);
        return { status: 'blocked', reason: pr.ciReason ?? '' };
      }
      if (live.draft) {
        await api.markPullRequestReady(repo, live.nodeId);
        markReadyRecorded(db, pr.repoId, pr.prNumber, now);
      }
      if (!resumeBlockedCi(db, pr.repoId, pr.prNumber, sha, again.reason, now)) return { status: 'none' };
      log.info('checks pass now on a head that was stopped for a person; carrying on', { reason: again.reason });
      if (quiet) {
        const status = ciStatus({ ciState: 'passed', ciFixes: pr.ciFixes, prNumber: pr.prNumber }, sha, merge);
        if (status) await noteStatus({ api, log }, { repo, issue: pr.issueNumber, target: { pr: pr.prNumber }, sha, latest: true, at: now(), ...status });
      }
      return { status: 'passed', reason: again.reason };
    }

    const waitedMs = pr.ciWaitStartedAt ? now() - Date.parse(pr.ciWaitStartedAt) : 0;
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
      // A pass with no fix before it gets no CI comment (postCiNotices): the status says it.
      if (pr.ciFixes === 0 && quiet) {
        const status = ciStatus({ ciState: 'passed', ciFixes: 0, prNumber: pr.prNumber }, sha, merge);
        if (status) await noteStatus({ api, log }, { repo, issue: pr.issueNumber, target: { pr: pr.prNumber }, sha, latest: true, at: now(), ...status });
      }
      return { status: 'passed', reason: verdict.reason };
    }

    // A failure the code can cause.
    const failedNames = names(verdict.failures.map((d) => d.name));
    // Right after Updraft's re-run, GitHub may still list the attempt it re-ran as the latest:
    // a failure that completed before the re-run was asked for is that attempt, not the re-run's
    // verdict. Wait for the new attempt, for a while.
    if (pr.ciRerunSha === sha && pr.ciRerunAt) {
      const rerunAt = Date.parse(pr.ciRerunAt);
      const stale = verdict.failures.filter((d) => d.completedAt !== undefined && Date.parse(d.completedAt) < rerunAt);
      if (stale.length && now() - rerunAt < CI_REGISTER_GRACE_MS) {
        return wait(`waiting for the re-run of ${names(stale.map((d) => d.name))} on ${short(sha)} to start: GitHub still lists the attempt that failed before it`);
      }
    }
    // One revision at a time per pull request: one that is on its way (a person's change request)
    // comes first, and its push gets a review and checks of its own.
    // This head's own fix (queued by an earlier try of this step) is not another revision.
    const active = settings.fix ? activeRevisionJob(db, pr.repoId, pr.prNumber, ciFailureReviewId(pr.prNumber, sha)) : null;
    if (active) return wait(`check(s) failed on ${short(sha)} (${failedNames}), but revision job ${active} is already on its way`);

    // Before anything else, once per head: a failure the change cannot have caused (the same job
    // passed on another leg of its matrix, or it failed only in files the change does not touch)
    // is re-run, and a pass carries on as if it had passed the first time.
    const mayRerun = pr.ciRerunSha !== sha && api.rerunFailedJobs !== undefined && verdict.failures.every((d) => d.kind === 'check-run' && d.workflowRunId !== undefined);
    let diagnosed: DiagnosedFailure[] | null = null;
    const readDiagnostics = async (): Promise<DiagnosedFailure[]> => {
      try {
        return await diagnose(deps, repo, verdict.failures);
      } catch (err) {
        if (isTransient(err)) throw err;
        return verdict.failures.map((check) => ({ check, diagnostics: { annotations: [], logTail: null, problems: [`the diagnostics could not be read: ${message(err)}`] } }));
      }
    };
    if (mayRerun) {
      diagnosed = await readDiagnostics();
      const decision = decideRerun(diagnosed, relevantChecks(checks, settings), await diffFiles(deps, repo, pr.prNumber));
      if (decision.rerun) {
        const reason = `check(s) ${failedNames} failed on ${short(sha)}, and Updraft re-ran the failed jobs once (it looks unrelated to the change: ${decision.why})`;
        if (recordCiRerun(db, pr.repoId, pr.prNumber, sha, { reason, checks: decision.checks, files: decision.files }, now)) {
          const accepted: number[] = [];
          try {
            for (const id of decision.runs) {
              await api.rerunFailedJobs!(repo, id);
              accepted.push(id);
            }
            log.info('re-ran the failed jobs once', { checks: failedNames, runs: decision.runs, why: decision.why });
            if (quiet) {
              await noteStatus(
                { api, log },
                {
                  repo,
                  issue: pr.issueNumber,
                  target: { pr: pr.prNumber },
                  stage: STATUS_STAGE.loop,
                  sha,
                  latest: true,
                  at: now(),
                  title: 'Re-running a failed check',
                  text: `${failedNames} failed on \`${shortSha(sha)}\` of PR #${pr.prNumber}, in a way that looks unrelated to the change; Updraft re-ran the failed jobs once.`,
                },
              );
            }
            return { status: 'waiting', reason };
          } catch (err) {
            // Recorded first, so it is never asked for twice: a re-run that could not be asked
            // for goes the way any failure does, unless part of it is under way: then wait for
            // that part, and judge the checks again once it is done.
            if (accepted.length) {
              const failedRuns = decision.runs.filter((id) => !accepted.includes(id));
              log.warn('re-ran the failed jobs of only some workflow runs; waiting for those', { error: message(err), rerun: accepted, failed: failedRuns });
              return wait(`${reason}; GitHub re-ran workflow run(s) ${accepted.join(', ')} but refused ${failedRuns.join(', ')}`);
            }
            log.warn('could not re-run the failed jobs; handling the failure as usual', { error: message(err), runs: decision.runs });
          }
        }
      } else {
        log.info('not re-running the failed checks', { why: decision.why });
      }
    }
    const rerunNote = afterRerun(pr, sha, failedNames, merge !== null);

    if (!settings.fix) return block(`check(s) failed on ${short(sha)}: ${failedNames}. Revisions are off for this repository, so fixing them is up to a person${rerunNote}`);
    diagnosed ??= await readDiagnostics();
    const signature = failureSignature(diagnosed);
    if (signature !== null && pr.ciLastFixSignature === signature) {
      return block(
        `check(s) ${failedNames} failed on ${short(sha)} in the same way as before the last automatic fix, so another fix is unlikely to help${rerunNote}`,
        signature,
      );
    }

    const wf = cfg.workflows.find((w) => workflowId(w) === pr.workflowId);
    if (!wf) return block(`check(s) failed on ${short(sha)}: ${failedNames}, but workflow "${pr.workflowId}" no longer exists in the config${rerunNote}`, signature);
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
      return block(`check(s) failed on ${short(sha)}: ${failedNames}, and the pull request has used its ${max} revision(s) (maxRevisions)${rerunNote}`, signature);
    }
    return block(`check(s) failed on ${short(sha)}: ${failedNames}, and a revision for this commit was recorded before (${recorded?.reason ?? 'its job was pruned'})${rerunNote}`, signature);
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
      candidates = listCiCandidates(deps.db, cfg.id, { requireSuggestions: suggestionsActive(deps.config, cfg) }).filter(
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
      `The review passed, but GitHub's checks failed on commit ${code(short(o.sha))}. Updraft queued a revision to fix them ` +
        `(automatic CI fix ${pr.ciFixes} on this pull request; revisions of this pull request count against ${code(`repositories.${o.repoFullName}.maxRevisions`)}: ${o.max}).`,
      '',
      ...failed,
      '**Failed**',
      '',
      reason,
      '',
      `Revision job ${code(pr.ciFixJobId ?? '?')} gets the failed checks, their annotations and the end of their logs. Its push gets a new review and new checks.`,
    ];
  } else if (o.failed?.length) {
    // Not ready to merge while a check fails: say which, and why Updraft stopped.
    lines = [
      head,
      '',
      `**Blocked by a failing check:** ${blockedNames(o.failed)} did not pass on commit ${code(short(o.sha))}. The review passed, but Updraft will not fix this commit by itself.`,
      '',
      ...failed,
      '**Why it is blocked**',
      '',
      reason,
      '',
      `Fix the check, or push a commit (it gets a new review and new checks). If the failure is unrelated to this change, re-run it on GitHub: ${afterPass(o.merge ?? null)}`,
    ];
  } else {
    lines = [
      head,
      '',
      `The review passed on commit ${code(short(o.sha))}, but its checks need a person: Updraft will not fix this commit by itself.`,
      '',
      '**Reason**',
      '',
      reason,
      '',
      `A new commit on this branch gets a new review and new checks. ${afterPass(o.merge ?? null)}`,
    ];
  }
  return [...lines, '', ciNoticeMarker(o.sha)].join('\n');
}

/** The failed checks of a head, by name, for one sentence. */
function blockedNames(failed: readonly CheckDetail[]): string {
  const shown = failed.slice(0, MAX_NAMES).map((d) => code(d.name));
  return failed.length > MAX_NAMES ? `${shown.join(', ')} and ${failed.length - MAX_NAMES} more` : shown.join(', ');
}

/** What a pass on the same commit leads to, once a person dealt with what stopped the CI step. */
const afterPass = (merge: MergeMethod | null) =>
  merge ? 'once the checks pass on this commit, Updraft merges it without a new commit.' : 'once the checks pass on this commit, Updraft carries on without a new commit.';

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
  if (pr.ciState === 'blocked' && o.failed?.length) {
    lines = [
      `**Blocked by a failing check:** ${blockedNames(o.failed)} did not pass on ${code(short(o.sha))} of PR #${pr.prNumber}: ${inline(cap(pr.ciReason ?? 'no reason was recorded', 600))}. ` +
        `Fix the check or push a commit (a new commit gets a new review and new checks); if it is unrelated, re-run it on GitHub: ${afterPass(o.merge ?? null)}${link}`,
      '',
      ...failedLines(o.failed),
    ];
  } else if (pr.ciState === 'blocked') {
    lines = [
      `Updraft stopped working on the checks of PR #${pr.prNumber} at ${code(short(o.sha))} and needs a person: ${inline(cap(pr.ciReason ?? 'no reason was recorded', 600))}. ` +
        `Please fix the checks or push a commit; a new commit gets a new review and new checks.${link}`,
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

/** The status comment's line for a head's CI step (quiet notifications). `failed`: the head's failed checks, when the CI step stopped. */
function ciStatus(
  pr: Pick<LoopPr, 'ciState' | 'ciFixes' | 'prNumber'>,
  sha: string,
  merge: MergeMethod | null,
  failed?: readonly CheckDetail[] | null,
): { stage: number; title: string; text: string } | null {
  const after = pr.ciFixes > 0 ? ` after CI fix ${pr.ciFixes}` : '';
  if (pr.ciState === 'fixing') return { stage: STATUS_STAGE.loop, title: 'Fixing checks', text: `Fixing failed checks on \`${shortSha(sha)}\` of PR #${pr.prNumber} (CI fix ${pr.ciFixes}).` };
  if (pr.ciState === 'passed') {
    return merge
      ? { stage: STATUS_STAGE.loop, title: 'Checks passed', text: `Checks passed on \`${shortSha(sha)}\` of PR #${pr.prNumber}${after}; Updraft merges it once nothing else stands in the way.` }
      : { stage: STATUS_STAGE.person, title: 'Ready for a person to merge', text: `Checks passed on \`${shortSha(sha)}\` of PR #${pr.prNumber}${after}; it is ready for a person to merge.` };
  }
  if (pr.ciState === 'blocked' && failed?.length) {
    return {
      stage: STATUS_STAGE.person,
      title: 'Blocked by a failing check',
      text: `${blockedNames(failed)} did not pass on \`${shortSha(sha)}\` of PR #${pr.prNumber}, and Updraft stopped (see the PR for why). Updraft ${merge ? 'merges it' : 'carries on'} once the checks pass on this commit.`,
    };
  }
  if (pr.ciState === 'blocked') return { stage: STATUS_STAGE.person, title: 'Waiting for a person', text: `The checks of PR #${pr.prNumber} need a person (see the PR).` };
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
        const failed = pr.ciState === 'blocked' ? await failedChecks(deps, repoRef, sha, settings) : null;
        const status = ciStatus(pr, sha, merge, failed);
        if (status) await noteStatus({ api: deps.api, log: deps.log }, { repo: repoRef, issue: pr.issueNumber, target: { pr: pr.prNumber }, sha, latest: pr.headSha === sha, at: (deps.now ?? Date.now)(), ...status });
        const body = renderQuietCiNotice({
          pr,
          sha,
          failed,
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
