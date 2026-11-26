// The suggestion step of the review loop (repositories.<repo>.review.suggestions; address unless
// set). See docs/review-loop.md, "Suggestions".
//
// A ready-to-merge verdict can come with non-blocking suggestions. They never hold a head back as
// blockers do, but they are not left as open threads either. Once the reviewer found the current
// head ready:
//   - address, with the revision budget (maxRevisions) allowing and none had yet: ONE revision of
//     the pull request applies the suggestions the coding agent agrees with. It is an ordinary
//     revision (kind `suggestions`, one per pull request: its review id is suggestions:<pr>), so
//     its push is reviewed again and that head goes through the checks and the merge as any
//     other. The checks and the merge of the head it revises wait for it;
//   - otherwise (follow-up, the budget spent, a suggestion revision already had, or the one that
//     was queued ended without moving the head): every open suggestion is settled on the ready
//     head. A fixed one's thread is resolved (its reply names the commit), a declined one's gets
//     the coding agent's reason, and the rest go into ONE follow-up issue per pull request, found
//     again by its marker, whose link each of their threads gets. Then the head goes on to its
//     checks and its merge.
// Only threads the worker started are replied to or resolved; a person's never are. Suggestions
// never become blockers and change no verdict, so the acceptance and CI gates are untouched.
// Nothing here posts a status comment: thread replies and the follow-up issue are the only
// GitHub writes, and the issue's live status comment says where the loop is.
import { autoMergeMethod, DEFAULT_MAX_REVISIONS, reviseActive, suggestionMode, suggestionsActive, workflowId, type RepositoryConfig } from '../config/schema.js';
import { transaction } from '../db/database.js';
import {
  activeRevisionJob,
  clearSuggestIssue,
  getLoopPr,
  listSuggestionCandidates,
  noteSuggestAttempt,
  observeHead,
  recordSuggestIssue,
  setSuggestState,
  startSuggestionsFor,
  type LoopPr,
} from '../db/pr-reviews.js';
import { getJob, latestRunOfJob } from '../db/queue.js';
import { deferredSuggestions, markSettled, markThreadResolved, openSuggestions, recordResolution, type ReviewFinding, type SettledAs } from '../db/review-findings.js';
import { countRevisions, enqueueRevision, getReviewRequest, revisionJob, revisionPushOfJob } from '../db/revisions.js';
import { GitHubError, type GitHubIssue } from '../github/api.js';
import { sameLogin, workerLogin } from '../github/identity.js';
import { suggestionsReviewId, suggestionsTrigger } from '../poller/review-trigger.js';
import type { RepoRef, RevisionFinding, RevisionRequest } from '../types.js';
import { code } from './failure-comment.js';
import { safeMarkdown } from './markdown.js';
import { cap, inline, type PublishDeps } from './publish.js';
import { noteStatus, quietFor, shortSha } from './status-comment.js';
import { STATUS_STAGE } from './status-marker.js';
import { findThread, ownComments, replyOnce, ROLE, settle, threadReplyMarker, type ThreadDeps } from './threads.js';
import { verdictStatus } from './verdict-status.js';

export type SuggestionDeps = Pick<PublishDeps, 'db' | 'config' | 'api' | 'log' | 'now' | 'scope' | 'console'>;

/** Failed attempts to settle one head before it is let through anyway: a suggestion never holds a merge back for good. */
export const MAX_SUGGEST_ATTEMPTS = 5;
/** Suggestions one revision is given; the rest are deferred to the follow-up issue. */
const MAX_REVISION_SUGGESTIONS = 25;
/** Suggestions settled on one head at most (each is a few requests); the next head settles what is left. */
const MAX_SETTLED = 500;
/** GitHub's limit on an issue body is 65,536 characters. */
const MAX_ISSUE_BODY = 60_000;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const short = (sha: string) => sha.slice(0, 12);
const isTransient = (err: unknown) => err instanceof GitHubError && (err.status === 0 || err.status >= 500 || err.isRateLimit);
/** The issue is not there to edit: deleted, transferred (a redirect) or gone. */
const isGone = (err: unknown) => err instanceof GitHubError && [301, 404, 410].includes(err.status);

/** Hidden marker on the one follow-up issue of a pull request. */
export function followUpMarker(repoId: number, prNumber: number): string {
  return `<!-- updraft-suggestions-followup: ${repoId}#${prNumber} -->`;
}

// ---------------------------------------------------------------------------
// Queueing the one suggestion revision
// ---------------------------------------------------------------------------

/** Why no suggestion revision is (or was) made for a head: what the follow-up issue says. */
type NoRevision = 'mode' | 'revise-off' | 'had-one' | 'budget' | 'answered';

export type QueueDecision =
  | { status: 'queued'; jobId: string; count: number }
  /** Nothing to answer on this head. */
  | { status: 'none' }
  /** Another revision of the pull request is on its way: its push replaces the head. */
  | { status: 'wait'; reason: string }
  /** No revision: the open suggestions are settled on this head. */
  | { status: 'settle'; why: NoRevision };

function noRevisionWords(why: NoRevision, max: number): string {
  switch (why) {
    case 'mode':
      return 'review.suggestions is follow-up for this repository';
    case 'revise-off':
      return 'revisions are off for this repository';
    case 'had-one':
      return 'this pull request already had its one revision for suggestions';
    case 'budget':
      return `the pull request had used its ${max} revision(s) (maxRevisions)`;
    case 'answered':
      return 'every suggestion was already answered by an earlier revision';
  }
}

/** The worker's own list of the suggestions, for the revision's "review" body. Titles are the reviewer's. */
function revisionSummary(headSha: string, open: readonly ReviewFinding[]): string {
  return [
    `Updraft's reviewer found commit ${headSha} ready to merge and left ${open.length} non-blocking suggestion(s):`,
    ...open.map((f) => `- ${f.key}: ${f.title}${f.path ? ` (${f.path}${f.line !== null ? `:${f.line}` : ''})` : ''}`),
  ].join('\n');
}

/**
 * For a head the reviewer found ready (the PR's current head, as `pr` has it): queue its one
 * suggestion revision when the repository and the budget allow, or say what to do instead. Local
 * state only: no GitHub request. A head that already has a decision is left as it is.
 */
export function queueSuggestions(deps: Pick<SuggestionDeps, 'db' | 'config' | 'log' | 'now'>, repo: RepoRef, cfg: RepositoryConfig, pr: LoopPr, o: { reviewUrl: string; worker: string }): QueueDecision {
  const { db } = deps;
  const sha = pr.headSha;
  const mode = suggestionMode(deps.config, cfg);
  if (!sha || (mode !== 'address' && mode !== 'follow-up')) return { status: 'none' };
  startSuggestionsFor(db, pr.repoId, pr.prNumber, sha, deps.now);
  const row = getLoopPr(db, pr.repoId, pr.prNumber);
  if (!row || row.suggestSha !== sha) return { status: 'none' };
  // A retry of the step that queued it (a review posting that was interrupted) finds it again.
  if (row.suggestState === 'fixing' && row.suggestJobId) return { status: 'queued', jobId: row.suggestJobId, count: Math.min(MAX_REVISION_SUGGESTIONS, openSuggestions(db, pr.repoId, pr.prNumber).length) };
  if (row.suggestState !== null) return { status: 'none' };
  const open = openSuggestions(db, pr.repoId, pr.prNumber);
  if (!open.length) return { status: 'none' };
  if (mode === 'follow-up') return { status: 'settle', why: 'mode' };
  // Only what no revision answered yet: a suggestion a reviewer verified, or one a revision fixed
  // or declined, is settled as it is, not asked about again.
  const pending = open.filter((f) => classify(f, new Map()).as === 'deferred');
  if (!pending.length) return { status: 'settle', why: 'answered' };
  if (!reviseActive(deps.config, cfg)) return { status: 'settle', why: 'revise-off' };
  const reviewId = suggestionsReviewId(pr.prNumber);
  if (getReviewRequest(db, pr.repoId, reviewId)) return { status: 'settle', why: 'had-one' };
  const active = activeRevisionJob(db, pr.repoId, pr.prNumber, reviewId);
  if (active) return { status: 'wait', reason: `revision job ${active} is on its way; its push replaces ${short(sha)}` };
  const max = cfg.maxRevisions ?? DEFAULT_MAX_REVISIONS;
  const wf = cfg.workflows.find((w) => workflowId(w) === pr.workflowId);
  if (!wf) return { status: 'settle', why: 'revise-off' };

  const given = pending.slice(0, MAX_REVISION_SUGGESTIONS);
  const recordedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const trigger = suggestionsTrigger({ prNumber: pr.prNumber, headSha: sha, summary: revisionSummary(sha, given), worker: o.worker, url: o.reviewUrl, recordedAt });
  const findings: RevisionFinding[] = given.map((f) => ({ key: f.key, severity: 'suggestion', title: f.title, problem: f.problem, suggestion: f.suggestion, path: f.path, line: f.line, threadUrl: f.commentUrl }));
  const revision: RevisionRequest = {
    trigger: trigger.kind,
    pullRequest: { number: pr.prNumber, url: pr.prUrl, branch: pr.branch },
    sourceRunId: pr.sourceRunId,
    originalEventId: pr.originalEventId,
    review: trigger.review,
    reviewedSha: trigger.reviewedSha,
    findings,
  };
  // The budget is checked here, in the same transaction as the queueing: a spent budget is not
  // a change request over the limit (no limit comment), only a reason to file the follow-up.
  const decision = transaction(db, (): QueueDecision => {
    const count = countRevisions(db, pr.repoId, pr.prNumber);
    if (count >= max) return { status: 'settle', why: 'budget' };
    const queued = enqueueRevision(
      db,
      {
        repoId: pr.repoId,
        reviewId,
        prNumber: pr.prNumber,
        reviewer: o.worker,
        trigger: trigger.kind,
        reviewUrl: trigger.review.url,
        submittedAt: trigger.review.submittedAt,
        job: revisionJob(repo, pr, revision),
        max,
      },
      deps.now,
    );
    if (queued.status !== 'queued') return { status: 'settle', why: queued.status === 'over-limit' ? 'budget' : 'had-one' };
    setSuggestState(db, pr.repoId, pr.prNumber, sha, { state: 'fixing', reason: `${given.length} suggestion(s) on ${short(sha)}`, jobId: queued.job.id }, deps.now);
    return { status: 'queued', jobId: queued.job.id, count: given.length };
  });
  if (decision.status === 'queued') deps.log.info('revision queued for the review suggestions', { repo: repo.fullName, pr: pr.prNumber, job: decision.jobId, suggestions: decision.count });
  return decision;
}

/** The status comment's line while the suggestion revision is on its way (quiet notifications). */
export function suggestionStatus(prNumber: number, sha: string, count: number, merges: boolean): { stage: number; title: string; text: string } {
  return {
    stage: STATUS_STAGE.loop,
    title: 'Addressing suggestions',
    text:
      `The review found \`${shortSha(sha)}\` of PR #${prNumber} ready, with ${count} suggestion(s); a revision applies the ones the coding agent agrees with` +
      (merges ? ' before Updraft merges.' : ' before it is ready to merge.'),
  };
}

// ---------------------------------------------------------------------------
// Settling a head
// ---------------------------------------------------------------------------

/** How one open suggestion is closed, and what its thread is told. */
interface Settlement {
  finding: ReviewFinding;
  as: SettledAs;
  /** The coding agent's reason, for a decline or a deferral. */
  note: string | null;
  /** Declined by a revision that pushed nothing: no reply in the thread says so yet. */
  unanswered?: boolean;
}

/** The coding agent's reports of a suggestion revision that did not move the head, by finding key. */
function unpushedReports(deps: SuggestionDeps, jobId: string | null): Map<string, { status: string; note: string | null }> {
  const out = new Map<string, { status: string; note: string | null }>();
  if (!jobId) return out;
  const run = latestRunOfJob(deps.db, jobId);
  for (const r of run?.outcome === 'succeeded' ? (run.summary?.resolutions ?? []) : []) out.set(r.finding, { status: r.status, note: r.note });
  return out;
}

/**
 * fixed: a reviewer verified it, or the coding agent reported it fixed in a push that no reviewer
 * found unfixed since. declined: the coding agent left it, saying why. deferred: everything else
 * (deferred, unable, no report, not given to any revision, or found unfixed after the claim).
 */
export function classify(f: ReviewFinding, unpushed: Map<string, { status: string; note: string | null }>): Settlement {
  if (f.status === 'verified') return { finding: f, as: 'fixed', note: null };
  if (f.resolution === 'fixed' && !(f.status === 'unresolved' && f.statusSha === f.resolutionSha)) return { finding: f, as: 'fixed', note: f.resolutionNote };
  if (f.resolution === 'disagreed') return { finding: f, as: 'declined', note: f.resolutionNote };
  const report = unpushed.get(f.key);
  if (report?.status === 'disagreed') return { finding: f, as: 'declined', note: report.note, unanswered: true };
  return { finding: f, as: 'deferred', note: f.resolution === 'deferred' || f.resolution === 'unable' ? f.resolutionNote : report?.status === 'deferred' || report?.status === 'unable' ? report.note : null };
}

/** The body of the follow-up issue: every suggestion of the pull request deferred to it, as a task list a dispatched run can work through. */
export function renderFollowUp(o: { repoId: number; prNumber: number; prUrl: string; issueNumber: number; label: string; reason: string; items: readonly { finding: ReviewFinding; note: string | null }[] }): string {
  const rendered = o.items.map(({ finding: f, note }) => {
    const where = f.path ? ` · ${code(f.path)}${f.line !== null ? ` line ${f.line}` : ''}` : '';
    const thread = f.commentUrl ? ` ([thread](${f.commentUrl}))` : '';
    const quoted = safeMarkdown(cap(f.suggestion ? `${f.problem}\n\nSuggested change: ${f.suggestion}` : f.problem, 2_000), 2_000)
      .split('\n')
      .map((l) => `  ${l}`);
    return [`- [ ] **${inline(cap(f.title, 200))}**${where}${thread}`, '', ...quoted, ...(note ? ['', `  Coding agent: ${inline(cap(note, 500))}`] : []), ''].join('\n');
  });
  // Within GitHub's limit on a body: the rest are named by count, and their threads have them.
  const items: string[] = [];
  let size = 0;
  for (const [i, r] of rendered.entries()) {
    if (size + r.length > MAX_ISSUE_BODY - 2_000) {
      items.push(`- and ${rendered.length - i} more suggestion(s), each in its thread on pull request #${o.prNumber}`, '');
      break;
    }
    items.push(r);
    size += r.length + 1;
  }
  return [
    `Non-blocking suggestions Updraft's reviewer made on pull request #${o.prNumber} (${o.prUrl}), for issue #${o.issueNumber}, that were not applied there: ${inline(o.reason)}.`,
    'Each one is an agent\'s suggestion about the code, not a decision: check it against the code as it is now.',
    '',
    '## Acceptance criteria',
    '',
    ...items,
    '## Context',
    '',
    `- Pull request: #${o.prNumber}`,
    `- Original issue: #${o.issueNumber}`,
    '',
    `To have Updraft work on these, add the label ${code(o.label)} to this issue.`,
    '',
    followUpMarker(o.repoId, o.prNumber),
  ].join('\n');
}

export type SuggestionStepResult =
  | { status: 'none' }
  | { status: 'waiting'; reason: string }
  | { status: 'fixing'; jobId: string }
  | { status: 'settled'; reason: string };

/**
 * Take the suggestion step for one PR whose current head was found ready. Never throws. GitHub is
 * asked only to settle a head: whether the pull request is still there, its threads, the issue.
 */
export async function evaluateSuggestions(deps: SuggestionDeps, repo: RepoRef, cfg: RepositoryConfig, candidate: LoopPr): Promise<SuggestionStepResult> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const sha = candidate.headSha;
  if (!sha || !suggestionsActive(deps.config, cfg)) return { status: 'none' };
  const log = deps.log.child({ repo: repo.fullName, pr: candidate.prNumber, head: sha });
  try {
    startSuggestionsFor(db, candidate.repoId, candidate.prNumber, sha, now);
    const pr = getLoopPr(db, candidate.repoId, candidate.prNumber);
    if (!pr || pr.state !== 'open' || pr.verdict !== 'ready-to-merge' || pr.verdictSha !== sha || pr.headSha !== sha || pr.suggestSha !== sha) return { status: 'none' };
    if (pr.suggestState === 'settled') return { status: 'none' };
    const max = cfg.maxRevisions ?? DEFAULT_MAX_REVISIONS;
    let reason: string;
    let released = false;
    if (pr.suggestState === 'fixing') {
      const job = pr.suggestJobId ? getJob(db, pr.suggestJobId) : null;
      if (job && (job.status === 'queued' || job.status === 'running')) return { status: 'waiting', reason: `the suggestion revision (job ${job.id}) is ${job.status}` };
      // The queue's own rule: a push the worker will still retry by itself is pending; one it gave up on is not.
      const push = (pr.suggestJobId ? revisionPushOfJob(db, pr.suggestJobId, now) : null) ?? { unsettled: false, pushedSha: null };
      if (push.unsettled) return { status: 'waiting', reason: 'the suggestion revision is being pushed' };
      // Pushed: the pull request moves to that head, which gets its own review.
      if (push.pushedSha && push.pushedSha !== sha) return { status: 'waiting', reason: `the suggestion revision pushed ${short(push.pushedSha)}` };
      released = true;
      reason = `the revision for the suggestions (job ${pr.suggestJobId ?? '?'}) ended without changing ${short(sha)}`;
    } else {
      // No request for a head with nothing to answer: most heads.
      const login = openSuggestions(db, pr.repoId, pr.prNumber).length ? await workerLogin(deps.api) : '';
      const decision = queueSuggestions(deps, repo, cfg, pr, { reviewUrl: pr.prUrl, worker: login });
      if (decision.status === 'none') {
        // Nothing to answer on this head: it goes on to its checks and its merge at once.
        setSuggestState(db, pr.repoId, pr.prNumber, sha, { state: 'settled', reason: 'no open suggestions' }, now);
        return { status: 'settled', reason: 'no open suggestions' };
      }
      if (decision.status === 'wait') return { status: 'waiting', reason: decision.reason };
      if (decision.status === 'queued') {
        if (quietFor(deps.config, { repoId: pr.repoId, repoFullName: repo.fullName })) {
          await noteStatus({ api: deps.api, log }, { repo, issue: pr.issueNumber, target: { pr: pr.prNumber }, sha, latest: true, at: now(), ...suggestionStatus(pr.prNumber, sha, decision.count, Boolean(autoMergeMethod(deps.config, cfg))) });
        }
        return { status: 'fixing', jobId: decision.jobId };
      }
      reason = noRevisionWords(decision.why, max);
    }
    const done = await settleHead(deps, repo, cfg, pr, sha, reason, log);
    if (done.status === 'settled' && released && quietFor(deps.config, { repoId: pr.repoId, repoFullName: repo.fullName })) {
      // Back to where the review left the head: ready, with its checks or its merge to come.
      const status = verdictStatus(deps.config, cfg, 'ready', pr.prNumber, sha);
      if (status) await noteStatus({ api: deps.api, log }, { repo, issue: pr.issueNumber, target: { pr: pr.prNumber }, sha, latest: true, at: now(), ...status });
    }
    return done;
  } catch (err) {
    const why = message(err);
    try {
      const attempts = noteSuggestAttempt(db, candidate.repoId, candidate.prNumber, sha, why, now);
      if (attempts >= MAX_SUGGEST_ATTEMPTS) {
        // A suggestion never holds a merge back for good.
        setSuggestState(db, candidate.repoId, candidate.prNumber, sha, { state: 'settled', reason: `gave up answering the suggestions after ${attempts} attempts: ${why}` }, now);
        log.warn('gave up answering the suggestions; the head goes on without', { error: why, attempts });
        return { status: 'settled', reason: why };
      }
    } catch {
      // looked at again on the next cycle
    }
    if (isTransient(err)) log.warn('could not answer the suggestions for now', { error: why });
    else log.error('the suggestion step failed', { error: why });
    return { status: 'waiting', reason: why };
  }
}

/**
 * The follow-up issue the suggestions deferred now go into, as a task list. An issue is only
 * reused while it is open, the worker's own (its author is checked here, whatever GitHub's filter
 * said), and not taken up yet: once it carries one of the repository's trigger labels its run is
 * dispatched, and an edit by the worker would read as an edit of the issue (and stop that run), so
 * the new deferrals go into a new follow-up issue instead. The recorded issue is read first; else
 * the worker's issues are looked through for the marker. One that is closed, gone or transferred
 * is forgotten, and a new one opened in the same attempt.
 */
async function fileFollowUp(
  deps: SuggestionDeps,
  repo: RepoRef,
  cfg: RepositoryConfig,
  pr: LoopPr,
  login: string,
  reason: string,
  deferred: readonly Settlement[],
  log: SuggestionDeps['log'],
): Promise<{ number: number; url: string }> {
  const { db, api } = deps;
  const now = deps.now ?? Date.now;
  const marker = followUpMarker(pr.repoId, pr.prNumber);
  const triggers = new Set(cfg.workflows.map((w) => w.trigger.label.toLowerCase()));
  const usable = (i: GitHubIssue) => i.state === 'open' && !i.isPullRequest && i.body.includes(marker) && !i.labels.some((l) => triggers.has(l.toLowerCase()));
  let target: GitHubIssue | null = null;
  if (pr.suggestIssueNumber) {
    try {
      const recorded = await api.getIssue(repo, pr.suggestIssueNumber);
      if (usable(recorded)) target = recorded;
    } catch (err) {
      if (!isGone(err)) throw err;
    }
    if (!target) clearSuggestIssue(db, pr.repoId, pr.prNumber, now);
  } else if (api.listIssuesByCreator) {
    // Fails closed: an issue whose author is not the worker is not its follow-up, whatever it says.
    target = (await api.listIssuesByCreator(repo, login)).find((i) => sameLogin(i.author ?? null, login) && usable(i)) ?? null;
  }
  const render = (into: number | null) =>
    renderFollowUp({
      repoId: pr.repoId,
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      issueNumber: pr.issueNumber,
      label: pr.label,
      reason,
      items: [...(into === null ? [] : deferredSuggestions(db, pr.repoId, pr.prNumber, into).map((finding) => ({ finding, note: finding.resolutionNote }))), ...deferred.map((s) => ({ finding: s.finding, note: s.note }))],
    });
  if (target) {
    const body = render(target.number);
    try {
      if (target.body !== body && api.updateIssueBody) await api.updateIssueBody(repo, target.number, body);
      const kept = { number: target.number, url: target.htmlUrl };
      recordSuggestIssue(db, pr.repoId, pr.prNumber, kept, now);
      return kept;
    } catch (err) {
      if (!isGone(err)) throw err;
      clearSuggestIssue(db, pr.repoId, pr.prNumber, now);
    }
  }
  const created = await api.openIssue!(repo, { title: cap(`Follow-up to #${pr.prNumber}: review suggestions not applied`, 200), body: render(null) });
  const opened = { number: created.number, url: created.htmlUrl };
  recordSuggestIssue(db, pr.repoId, pr.prNumber, opened, now);
  log.info('filed the follow-up issue for the suggestions left open', { issue: created.htmlUrl, suggestions: deferred.length });
  return opened;
}

/**
 * Settle every open suggestion on `sha`, which must still be the pull request's head on GitHub:
 * fixed and declined ones are resolved, the rest deferred to the follow-up issue, whose link
 * their threads get. Throws on a failure worth retrying (the next cycle settles what is left:
 * every reply is found again by its marker, and the issue by its marker).
 */
async function settleHead(deps: SuggestionDeps, repo: RepoRef, cfg: RepositoryConfig, pr: LoopPr, sha: string, reason: string, log: SuggestionDeps['log']): Promise<SuggestionStepResult> {
  const { db, api } = deps;
  const now = deps.now ?? Date.now;
  const readAt = new Date(now()).toISOString();
  const live = await api.getPullRequest(repo, pr.prNumber);
  if (live.state !== 'open' || live.merged) return { status: 'none' };
  if (live.headSha !== sha) {
    // Moved on (a person's push, or another machine's suggestion revision): the new head has its own review.
    observeHead(db, pr.repoId, pr.prNumber, live.headSha, readAt);
    return { status: 'none' };
  }
  const login = await workerLogin(api);
  const lines: string[] = [];
  const threadDeps: ThreadDeps = { db, api, now, guard: () => {}, repoFullName: repo.fullName, runId: `suggestions-${pr.prNumber}` };
  const unpushed = unpushedReports(deps, pr.suggestJobId);
  // Every open suggestion, however many: past what one revision is given, they are deferred.
  const settlements = openSuggestions(db, pr.repoId, pr.prNumber, MAX_SETTLED).map((f) => classify(f, unpushed));
  const deferred = settlements.filter((s) => s.as === 'deferred');

  // The follow-up issue (fileFollowUp): the one the deferred suggestions go into.
  let issue: { number: number; url: string } | null = null;
  if (deferred.length) {
    if (!api.openIssue) lines.push('this GitHub client cannot open issues; the deferred suggestions stay open');
    else issue = await fileFollowUp(deps, repo, cfg, pr, login, reason, deferred, log);
  }

  // Each thread: a reply where one is owed, then resolved. Only the worker's own threads.
  let comments: Awaited<ReturnType<typeof ownComments>> | null = null;
  const cache: Parameters<typeof findThread>[5] = {};
  for (const s of settlements) {
    const f = s.finding;
    if (s.as === 'deferred' && !issue) continue;
    if (s.unanswered) recordResolution(db, pr.repoId, pr.prNumber, f.key, { resolution: 'disagreed', note: s.note, sha, runId: latestRunOfJob(db, pr.suggestJobId ?? '')?.id ?? 'unknown', now });
    if (f.commentId) {
      try {
        comments ??= await ownComments(threadDeps, repo, pr.prNumber, login);
        if (s.as === 'deferred') {
          await replyOnce(
            threadDeps,
            repo,
            pr.prNumber,
            f.commentId,
            threadReplyMarker('defer', threadDeps.runId, f.key),
            `**${ROLE.updraft}:** Deferred to the follow-up issue #${issue!.number} (${issue!.url}), with every suggestion not applied in this pull request: ${inline(reason)}.`,
            comments,
          );
        } else if (s.unanswered) {
          await replyOnce(
            threadDeps,
            repo,
            pr.prNumber,
            f.commentId,
            threadReplyMarker('decline', threadDeps.runId, f.key),
            `**${ROLE.coding}:** Not changed: I disagree.${s.note ? ` ${inline(cap(s.note, 1_500))}` : ''}`,
            comments,
          );
        }
        if (api.listReviewThreads && api.resolveReviewThread) {
          const thread = await findThread(threadDeps, repo, pr.prNumber, f.commentId, login, cache);
          if (!thread) lines.push(`the thread of ${f.key} is not among the pull request's threads; not resolved`);
          else {
            if (!thread.isResolved) await api.resolveReviewThread(repo, thread.id);
            markThreadResolved(db, pr.repoId, pr.prNumber, f.key, now);
          }
        }
      } catch (err) {
        settle(threadDeps, err, lines, `could not answer or resolve the thread of ${f.key}`);
      }
    }
    markSettled(db, pr.repoId, pr.prNumber, f.key, s.as, now, s.as === 'deferred' ? issue?.number : null);
  }
  const count = (as: SettledAs) => settlements.filter((s) => s.as === as).length;
  const summary = settlements.length
    ? `${count('fixed')} fixed, ${count('declined')} declined, ${count('deferred')} deferred${issue && deferred.length ? ` to #${issue.number}` : ''} (${reason})`
    : 'no open suggestions';
  setSuggestState(db, pr.repoId, pr.prNumber, sha, { state: 'settled', reason: summary }, now);
  for (const l of lines) log.warn(`suggestions: ${l}`);
  log.info('suggestions answered', { summary });
  return { status: 'settled', reason: summary };
}

/** The suggestion step for every repository that has it on. `only`: this pull request (a webhook named it). Never throws. */
export async function evaluateSuggestionsAll(deps: SuggestionDeps, signal?: AbortSignal, opts: { only?: { repoId: number; prNumber: number } } = {}): Promise<SuggestionStepResult[]> {
  const results: SuggestionStepResult[] = [];
  for (const [fullName, cfg] of Object.entries(deps.config.repositories)) {
    if (!suggestionsActive(deps.config, cfg)) continue;
    if (opts.only && opts.only.repoId !== cfg.id) continue;
    let candidates: LoopPr[];
    try {
      candidates = listSuggestionCandidates(deps.db, cfg.id).filter((pr) => (deps.scope?.pr(pr.repoId, pr.prNumber) ?? true) && (!opts.only || opts.only.prNumber === pr.prNumber));
    } catch (err) {
      deps.log.error('could not list pull requests whose suggestions to answer', { repo: fullName, error: message(err) });
      continue;
    }
    for (const pr of candidates) {
      if (signal?.aborted) return results;
      results.push(await evaluateSuggestions(deps, { id: cfg.id, fullName }, cfg, pr));
    }
  }
  return results;
}
