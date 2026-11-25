// Findings as review threads (docs/review-loop.md, "Findings as threads"). A reviewer's
// structured findings (src/agents/findings.ts) become one COMMENT review: a short summary, plus
// an inline comment on the diff for each finding whose line the reviewed diff has. The coding
// agent and later reviewers then answer in those threads.
//
// Three roles speak on the pull request, all as the worker's one GitHub account, and each says
// which it is: the **Review agent**, the **Coding agent**, and **Updraft** itself. Nothing here
// pretends to be another GitHub user.
//
// What decides is never the posted text: a thread belongs to a finding only when its first
// comment was posted by the worker's own login, with the review the worker recorded for that run,
// and carries the finding's marker (so a person copying a marker into their comment changes
// nothing). Replies carry a marker of their own, so a retry finds the reply it already posted
// instead of posting it twice.
//
// Every write goes through the caller's `guard` right before it: the same lease, attempt fence,
// stop and deadline as the rest of the step, so an attempt that lost its lease writes nothing.
// What changes a thread's state (a repeat, a check, a resolution) is only applied for a review of
// the pull request's current head. GitHub refusing a thread write for good (a permission, a
// thread that is gone) is said in run.log and the summary still has every finding; a failure that
// is worth retrying fails the attempt, which is retried without posting anything twice.
import type { FindingCheck, FindingLocation, StructuredFinding, StructuredReview } from '../agents/findings.js';
import { findingKey } from '../agents/findings.js';
import type { Db } from '../db/database.js';
import {
  applyRepeat,
  findingsOfRun,
  markThreadResolved,
  promoteThread,
  recordCheck,
  recordResolution,
  setThreadComment,
  threadOf,
  type FindingResolution,
  type ReviewFinding,
} from '../db/review-findings.js';
import { GitHubError, type GitHubApi, type PullRequestReviewComment, type ReviewCommentInput } from '../github/api.js';
import { sameLogin } from '../github/identity.js';
import type { OpenFindingSnapshot, RepoRef, ReviewVerdict, RevisionFinding } from '../types.js';
import { anchorFinding, type CommentableLines } from './anchors.js';
import { code } from './failure-comment.js';
import { safeMarkdown } from './markdown.js';
import { cap, classifyFailure, inline } from './publish.js';

/** Inline comments one review carries at most; the rest are in its summary. */
export const MAX_INLINE_COMMENTS = 25;
const MAX_COMMENT = 8_000;
const MAX_TEXT = 3_000;

export const ROLE = { review: 'Review agent', coding: 'Coding agent', updraft: 'Updraft' } as const;

const short = (sha: string) => sha.slice(0, 12);

/** Hidden marker on the inline comment that starts a finding's thread. */
export function findingMarker(key: string): string {
  return `<!-- updraft-finding: ${key} -->`;
}

/** Hidden marker on a reply the worker posts in a thread: one per kind, run and thread. */
export function threadReplyMarker(kind: 'fix' | 'check' | 'repeat', runId: string, threadKey: string): string {
  return `<!-- updraft-thread-reply: ${kind} ${runId} ${threadKey} -->`;
}

const SEVERITY: Record<StructuredFinding['severity'], string> = { blocker: 'Blocker', suggestion: 'Suggestion' };

function where(f: { path: string | null; line?: number | null; location?: FindingLocation | null }): string {
  const line = f.location?.line ?? f.line ?? null;
  const start = f.location?.startLine ?? null;
  if (!f.path) return '';
  return line !== null ? `${code(f.path)} ${start !== null ? `lines ${start}-${line}` : `line ${line}`}` : code(f.path);
}

// ---------------------------------------------------------------------------
// The plan: which finding is an inline thread, which is in the summary, which reuses a thread
// ---------------------------------------------------------------------------

export interface ThreadPlan {
  inline: { finding: StructuredFinding; location: FindingLocation }[];
  summary: { finding: StructuredFinding; reason: string }[];
  /** Repeats of an earlier finding whose thread is on GitHub: answered there. */
  repeats: { finding: StructuredFinding; root: ReviewFinding }[];
}

/**
 * Sort the findings of a review. `diff` is the reviewed head's diff, or null with `noDiff` saying
 * why it cannot be used (the pull request moved on, the API has no threads): then nothing is inline.
 */
export function planThreads(
  structured: StructuredReview,
  o: { diff: Map<string, CommentableLines | null> | null; noDiff?: string; rootOf: (key: string) => ReviewFinding | null },
): ThreadPlan {
  const plan: ThreadPlan = { inline: [], summary: [], repeats: [] };
  for (const finding of structured.findings) {
    const root = finding.sameAs ? o.rootOf(finding.sameAs) : null;
    if (root?.commentId) {
      plan.repeats.push({ finding, root });
      continue;
    }
    if (!o.diff) {
      plan.summary.push({ finding, reason: o.noDiff ?? 'inline comments are not available' });
      continue;
    }
    const anchored = anchorFinding(finding, o.diff);
    if (!anchored.ok) plan.summary.push({ finding, reason: anchored.reason });
    else if (plan.inline.length >= MAX_INLINE_COMMENTS) plan.summary.push({ finding, reason: `one review carries at most ${MAX_INLINE_COMMENTS} inline comments` });
    else plan.inline.push({ finding, location: anchored.location });
  }
  return plan;
}

/** The same plan with nothing inline: what is posted when GitHub refuses the inline comments. */
export function withoutInline(plan: ThreadPlan, reason: string): ThreadPlan {
  return { ...plan, inline: [], summary: [...plan.inline.map(({ finding }) => ({ finding, reason })), ...plan.summary] };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function findingText(f: { problem: string; suggestion: string | null }): string[] {
  return [safeMarkdown(f.problem, MAX_TEXT), ...(f.suggestion ? ['', '**Suggested change:**', '', safeMarkdown(f.suggestion, MAX_TEXT)] : [])];
}

/** The inline comment that starts a finding's thread. */
export function renderFindingComment(o: { runId: string; round: number; headSha: string; finding: StructuredFinding }): string {
  const { finding } = o;
  const marker = findingMarker(findingKey(o.runId, finding.id));
  const body = [
    `**${ROLE.review} · ${SEVERITY[finding.severity]} ${inline(finding.id)}:** ${inline(finding.title)}`,
    '',
    ...findingText(finding),
    '',
    `<sub>Round ${o.round} · reviewed ${code(short(o.headSha))} · run ${code(o.runId)}</sub>`,
  ].join('\n');
  return `${cap(body, MAX_COMMENT - marker.length - 2)}\n\n${marker}`;
}

function headline(verdict: ReviewVerdict, findings: readonly StructuredFinding[]): string {
  const blockers = findings.filter((f) => f.severity === 'blocker').length;
  const suggestions = findings.length - blockers;
  const counted = [blockers ? `${blockers} blocker${blockers === 1 ? '' : 's'}` : '', suggestions ? `${suggestions} suggestion${suggestions === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
  if (verdict === 'changes-requested') return `${counted ? `I found ${counted}.` : 'I have changes to ask for.'} I'm requesting a revision before this is ready.`;
  return `${counted ? `No blockers; I left ${counted}.` : 'No findings.'} This head is ready to merge as far as review goes.`;
}

const CHECK_WORDS: Record<FindingCheck['status'], string> = { verified: 'verified on this head', unresolved: 'still open on this head' };

/**
 * The body of a structured review: who is speaking, the round and commit, the verdict in plain
 * words, the reviewer's short prose, then one line per finding (with the full text only for those
 * that are not in an inline thread), the re-checks of earlier findings, and what happens next.
 */
export function renderStructuredReview(o: {
  runId: string;
  agent: string;
  round: number;
  verdict: ReviewVerdict;
  headSha: string;
  prose: string;
  structured: StructuredReview;
  plan: ThreadPlan;
  /** Earlier threads by key, to name the checks. */
  threads: (key: string) => ReviewFinding | null;
  /** Why the reviewer's ready-to-merge was taken as changes requested (verdictContradiction), if it was. */
  override?: string | null;
  next: string;
  marker: string;
  maxBody: number;
}): string {
  const lines: string[] = [
    `**${ROLE.review} · Round ${o.round} · reviewed ${code(short(o.headSha))}**`,
    '',
    headline(o.verdict, o.structured.findings),
    '',
    ...(o.override ? [`${ROLE.updraft}: the reviewer wrote ready to merge, but ${inline(o.override)}, so this counts as changes requested.`, ''] : []),
  ];
  if (o.prose.trim()) lines.push(safeMarkdown(o.prose.trim(), 20_000), '');
  const inlineIds = new Set(o.plan.inline.map((i) => i.finding.id));
  const repeated = new Map(o.plan.repeats.map((r) => [r.finding.id, r.root]));
  const summarized = new Map(o.plan.summary.map((s) => [s.finding.id, s.reason]));
  if (o.structured.findings.length) {
    lines.push('**Findings**', '');
    for (const f of o.structured.findings) {
      const head = `- **${SEVERITY[f.severity]} ${inline(f.id)}** · ${inline(f.title)}${where(f) ? ` · ${where(f)}` : ''}`;
      if (inlineIds.has(f.id)) lines.push(`${head}: in its thread on the diff`);
      else if (repeated.has(f.id)) {
        const root = repeated.get(f.id)!;
        lines.push(`${head}: still not fixed; followed up in [its thread](${root.commentUrl ?? ''})`, '', ...findingText(f).join('\n').split('\n').map((l) => (l ? `  ${l}` : '')), '');
      } else {
        lines.push(`${head} (${inline(summarized.get(f.id) ?? 'not on the diff')})`, '', ...findingText(f).join('\n').split('\n').map((l) => (l ? `  ${l}` : '')), '');
      }
      for (const n of f.notes) lines.push(`  - Updraft: ${inline(n)}`);
    }
    lines.push('');
  }
  if (o.structured.checks.length) {
    lines.push('**Earlier findings**', '');
    for (const c of o.structured.checks) {
      const t = o.threads(c.finding);
      const name = t ? `${SEVERITY[t.severity]} ${inline(t.findingId)} · ${inline(t.title)}` : `${code(c.finding)} (not a finding of this pull request; ignored)`;
      lines.push(`- ${name}: ${t ? CHECK_WORDS[c.status] : 'not checked'}${c.note ? `. ${inline(cap(c.note, 400))}` : ''}`);
    }
    lines.push('');
  }
  if (o.structured.omitted) lines.push(`Updraft: ${o.structured.omitted} more finding(s) or check(s) were beyond what one review carries; the reviewer's prose above may mention them.`, '');
  lines.push(
    `Agent ${inline(o.agent)}, run ${code(o.runId)}. Posted as a comment review: the account that opened a pull request cannot approve or request changes on it, so the verdict is recorded by the worker.`,
    '',
    o.next,
  );
  return `${cap(lines.join('\n'), o.maxBody - o.marker.length - 2)}\n\n${o.marker}`;
}

export function inlineComments(o: { runId: string; round: number; headSha: string; plan: ThreadPlan }): ReviewCommentInput[] {
  return o.plan.inline.map(({ finding, location }) => ({
    path: location.path,
    line: location.line,
    side: location.side,
    ...(location.startLine !== null ? { startLine: location.startLine, startSide: location.side } : {}),
    body: renderFindingComment({ runId: o.runId, round: o.round, headSha: o.headSha, finding }),
  }));
}

// ---------------------------------------------------------------------------
// The verdict and the findings must agree
// ---------------------------------------------------------------------------

/**
 * Why a ready-to-merge verdict contradicts the review it ends, or null when it does not: the
 * review lists a blocker, re-checks an earlier blocker as unresolved, or leaves an earlier blocker
 * it was given (`open`) unchecked and unrepeated. Such a verdict is never acted on as ready; the
 * caller takes it as changes requested. A legacy review (no block) with no earlier findings is
 * not checked: there is nothing structured to agree with.
 */
export function verdictContradiction(
  verdict: ReviewVerdict,
  structured: StructuredReview | null,
  open: readonly OpenFindingSnapshot[],
  rootOf: (key: string) => ReviewFinding | null,
): string | null {
  if (verdict !== 'ready-to-merge') return null;
  const blockers = (structured?.findings ?? []).filter((f) => f.severity === 'blocker');
  if (blockers.length) return `it lists ${blockers.length} blocker(s) (${blockers.map((b) => b.id).join(', ')})`;
  const openBlockers = open.filter((f) => f.severity === 'blocker');
  if (!openBlockers.length) return null;
  if (!structured) return `it re-checked none of the ${openBlockers.length} earlier blocker(s)`;
  const rootKey = (key: string) => rootOf(key)?.key ?? key;
  const checked = new Map(structured.checks.map((c) => [rootKey(c.finding), c.status]));
  const repeated = new Set(structured.findings.flatMap((f) => (f.sameAs ? [rootKey(f.sameAs)] : [])));
  for (const f of openBlockers) {
    const key = rootKey(f.key);
    if (checked.get(key) === 'unresolved' || repeated.has(key)) return `it found the earlier blocker ${f.key} still unresolved`;
    if (checked.get(key) !== 'verified') return `it did not re-check the earlier blocker ${f.key}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// After the review is on GitHub: threads, repeats and checks
// ---------------------------------------------------------------------------

export interface ThreadDeps {
  db: Db;
  api: Pick<GitHubApi, 'listPullRequestReviewComments' | 'replyToReviewComment' | 'listReviewThreads' | 'resolveReviewThread'>;
  now?: () => number;
  /**
   * Called right before every external write and every change of the database: confirms the
   * attempt still owns its step (renewing the lease), and throws when it does not, when the
   * worker is stopping, or past the deadline. Whatever it throws ends the step.
   */
  guard: () => void;
  /** The repository, for the words of a failure. */
  repoFullName: string;
  runId: string;
}

type Comments = PullRequestReviewComment[];

/**
 * A thread write GitHub refused for good (a permission, a thread or comment that is gone, a
 * request it will not take): said in `log`, and the step goes on. Anything else is rethrown: the
 * guard's own errors, and failures worth retrying, which fail the attempt so it is retried.
 */
function settle(deps: ThreadDeps, err: unknown, log: string[], what: string): void {
  if (!(err instanceof GitHubError)) throw err;
  const c = classifyFailure(err, { repoFullName: deps.repoFullName, runId: deps.runId, aborted: false });
  if (c.retryable) throw err;
  log.push(`threads: ${what} (${c.error})`);
}

/** The worker's own comments of the pull request, read once per step. */
async function ownComments(deps: ThreadDeps, repo: RepoRef, prNumber: number, login: string): Promise<Comments> {
  if (!deps.api.listPullRequestReviewComments) return [];
  return (await deps.api.listPullRequestReviewComments(repo, prNumber)).filter((c) => sameLogin(c.user, login));
}

/**
 * Fill in the inline comment of each finding of a run from the comments the worker posted with
 * its review: its own login, that review's id, the finding's marker. Anything else is not a
 * thread. A repeat posted inline (its earlier finding had no thread) gets its comment here too;
 * it becomes its thread's root only for a current review (applyCurrentReview).
 */
export function mapThreads(deps: ThreadDeps, repoId: number, prNumber: number, runId: string, reviewId: number, comments: Comments): number {
  let mapped = 0;
  for (const f of findingsOfRun(deps.db, runId)) {
    if (f.commentId !== null) continue;
    const c = comments.find((x) => x.reviewId === reviewId && x.inReplyToId === null && x.body.includes(findingMarker(f.key)));
    if (!c) continue;
    deps.guard();
    setThreadComment(deps.db, repoId, prNumber, f.key, { id: c.id, url: c.htmlUrl }, deps.now);
    mapped++;
  }
  return mapped;
}

/** Reply in a thread unless this exact reply is already there. Returns the reply, or null when the API has no replies. */
export async function replyOnce(
  deps: ThreadDeps,
  repo: RepoRef,
  prNumber: number,
  rootCommentId: number,
  marker: string,
  text: string,
  comments: Comments,
): Promise<PullRequestReviewComment | null> {
  const existing = comments.find((c) => (c.id === rootCommentId || c.inReplyToId === rootCommentId) && c.body.includes(marker));
  if (existing) return existing;
  if (!deps.api.replyToReviewComment) return null;
  const body = `${cap(text, MAX_COMMENT - marker.length - 2)}\n\n${marker}`;
  deps.guard();
  const posted = await deps.api.replyToReviewComment(repo, prNumber, rootCommentId, body);
  comments.push(posted);
  return posted;
}

/**
 * Step 1 of a posted structured review, whatever head it is for: the inline comments it posted
 * are recorded as threads. Returns the worker's comments of the pull request for the next step.
 */
export async function recordPostedThreads(
  deps: ThreadDeps,
  o: { repo: RepoRef; prNumber: number; runId: string; reviewId: number; login: string },
): Promise<{ comments: Comments | null; log: string[] }> {
  const log: string[] = [];
  if (!deps.api.listPullRequestReviewComments) return { comments: null, log: ['threads: this GitHub client has no review threads; every finding is in the review summary'] };
  let comments: Comments;
  try {
    comments = await ownComments(deps, o.repo, o.prNumber, o.login);
  } catch (err) {
    settle(deps, err, log, 'could not read the review comments; every finding is in the review summary');
    return { comments: null, log };
  }
  const mapped = mapThreads(deps, o.repo.id, o.prNumber, o.runId, o.reviewId, comments);
  if (mapped) log.push(`threads: ${mapped} finding(s) have an inline thread`);
  return { comments, log };
}

/** GitHub reads the threads of a pull request this many at a time (client.ts); the root comment is looked up among them. */
async function findThread(
  deps: ThreadDeps,
  repo: RepoRef,
  prNumber: number,
  rootCommentId: number,
  login: string,
  cache: { threads?: Awaited<ReturnType<NonNullable<ThreadDeps['api']['listReviewThreads']>>> },
) {
  cache.threads ??= await deps.api.listReviewThreads!(repo, prNumber);
  // The worker's own thread only: its first comment is the one recorded for this finding, by the worker.
  return cache.threads.find((t) => t.rootCommentId === rootCommentId && sameLogin(t.rootAuthor, login)) ?? null;
}

/**
 * Step 2, only for a review of the pull request's current head (the caller checks): what it says
 * about earlier findings becomes their state. A repeat makes its thread unresolved again with what
 * the reviewer found now (its severity and text), and is followed up in that thread; a repeat
 * posted inline because its earlier finding had no thread becomes that thread's root. Each check
 * is recorded on the thread it names and answered there, and a verified thread the worker started
 * is resolved, recorded only once GitHub confirms it. `at` is when the review was recorded: a
 * newer review's state is never overwritten by an older one's. Never repeats a write a retry
 * already made.
 */
export async function applyCurrentReview(
  deps: ThreadDeps,
  o: { repo: RepoRef; prNumber: number; runId: string; headSha: string; round: number; at: string; structured: StructuredReview; login: string; comments: Comments | null },
): Promise<{ log: string[] }> {
  const log: string[] = [];
  const { repo, prNumber, runId } = o;
  const comments = o.comments ?? [];

  // Repeats.
  for (const f of findingsOfRun(deps.db, runId)) {
    if (f.threadKey === f.key) continue;
    let root = threadOf(deps.db, repo.id, prNumber, f.key);
    if (!root) continue;
    if (!root.commentId && f.commentId) {
      // The earlier finding was only in a summary; this one is on the diff. Its comment is the thread now.
      deps.guard();
      promoteThread(deps.db, repo.id, prNumber, f.key, deps.now);
      root = getRoot(deps, repo.id, prNumber, f.key)!;
    }
    deps.guard();
    applyRepeat(deps.db, repo.id, prNumber, root.key, f, o.at, deps.now);
    if (!root.commentId || root.key === f.key) continue;
    try {
      await replyOnce(
        deps,
        repo,
        prNumber,
        root.commentId,
        threadReplyMarker('repeat', runId, root.key),
        [`**${ROLE.review} · Round ${o.round} · ${code(short(o.headSha))}:** this is still not fixed.`, '', ...findingText(f)].join('\n'),
        comments,
      );
    } catch (err) {
      settle(deps, err, log, `could not reply in the thread of ${root.key}; the review summary has the finding`);
    }
  }

  // Checks of earlier findings: only findings of this pull request, and only their own threads.
  const cache: Parameters<typeof findThread>[5] = {};
  for (const c of o.structured.checks) {
    const root = threadOf(deps.db, repo.id, prNumber, c.finding);
    if (!root) {
      log.push(`threads: the check of ${c.finding} names no finding of this pull request; ignored`);
      continue;
    }
    deps.guard();
    if (!recordCheck(deps.db, repo.id, prNumber, root.key, { status: c.status, sha: o.headSha, note: c.note, at: o.at, now: deps.now })) {
      log.push(`threads: a newer review already checked ${root.key}; this check is not applied`);
      continue;
    }
    if (!root.commentId) continue;
    const words = c.status === 'verified' ? `I verified this on ${code(short(o.headSha))}.` : `This is still open on ${code(short(o.headSha))}.`;
    try {
      await replyOnce(
        deps,
        repo,
        prNumber,
        root.commentId,
        threadReplyMarker('check', runId, root.key),
        `**${ROLE.review} · Round ${o.round}:** ${words}${c.note ? ` ${inline(cap(c.note, 1_000))}` : ''}`,
        comments,
      );
    } catch (err) {
      settle(deps, err, log, `could not answer the check of ${root.key} in its thread; the review summary has it`);
      continue;
    }
    if (c.status !== 'verified' || root.threadResolvedAt || !deps.api.listReviewThreads || !deps.api.resolveReviewThread) continue;
    try {
      const thread = await findThread(deps, repo, prNumber, root.commentId, o.login, cache);
      if (!thread) {
        log.push(`threads: the thread of ${root.key} is not among the pull request's threads; it is verified, not resolved`);
        continue;
      }
      if (!thread.isResolved) {
        deps.guard();
        await deps.api.resolveReviewThread(repo, thread.id);
      }
      deps.guard();
      markThreadResolved(deps.db, repo.id, prNumber, root.key, deps.now);
    } catch (err) {
      settle(deps, err, log, `could not resolve the thread of ${root.key}; it is verified, not resolved`);
    }
  }
  return { log };
}

const getRoot = (deps: ThreadDeps, repoId: number, prNumber: number, key: string) => threadOf(deps.db, repoId, prNumber, key);

// ---------------------------------------------------------------------------
// The coding agent's replies, after its revision's push is confirmed
// ---------------------------------------------------------------------------

const RESOLUTION_WORDS: Record<FindingResolution, string> = {
  fixed: 'Fixed in',
  disagreed: 'Not changed: I disagree, in',
  deferred: 'Deferred, not changed in',
  unable: 'I could not fix this in',
  unreported: 'No report on this finding for',
};

/** The coding agent's reply in a thread, for a revision whose push is confirmed at `sha`. */
export function renderResolutionReply(o: { resolution: FindingResolution; note: string | null; tests: string | null; sha: string; commitUrl: string | null }): string {
  const commit = o.commitUrl ? `[${short(o.sha)}](${o.commitUrl})` : code(short(o.sha));
  return [
    `**${ROLE.coding}:** ${RESOLUTION_WORDS[o.resolution]} ${commit}.${o.note ? ` ${inline(cap(o.note, 1_500))}` : ''}`,
    ...(o.tests ? ['', `Tests: ${inline(cap(o.tests, 600))}`] : []),
    ...(o.resolution === 'fixed' ? ['', `The ${ROLE.review.toLowerCase()} checks this on the new head; this is the coding agent's account, not a verification.`] : []),
  ].join('\n');
}

/** The commit's page, from the pull request's: same host, same repository. Null when the pull request URL is not one. */
export function commitUrl(prUrl: string, sha: string): string | null {
  const m = /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/.exec(prUrl);
  return m ? `${m[1]}/commit/${sha}` : null;
}

/**
 * The coding agent's answer to each finding it was given, once its revision's push is confirmed
 * at `sha`: recorded as its claim on the finding's thread, and replied in that thread. Returns one
 * line per finding for the revision's PR comment, which carries the whole answer for a finding
 * whose thread is not on GitHub or refused the reply.
 */
export async function answerFindings(
  deps: ThreadDeps,
  o: {
    repo: RepoRef;
    prNumber: number;
    runId: string;
    sha: string;
    prUrl: string;
    login: string;
    findings: readonly RevisionFinding[];
    resolutions: readonly { finding: string; status: Exclude<FindingResolution, 'unreported'>; note: string | null; tests: string | null }[];
  },
): Promise<{ lines: string[]; log: string[] }> {
  const log: string[] = [];
  const lines: string[] = [];
  let comments: Comments | null = null;
  const url = commitUrl(o.prUrl, o.sha);
  for (const f of o.findings) {
    const r = o.resolutions.find((x) => x.finding === f.key);
    const resolution: FindingResolution = r?.status ?? 'unreported';
    // The thread as it is now: a repeat may have taken it over since the revision was queued.
    const root = threadOf(deps.db, o.repo.id, o.prNumber, f.key);
    deps.guard();
    recordResolution(deps.db, o.repo.id, o.prNumber, root?.key ?? f.key, { resolution, note: r?.note ?? null, sha: o.sha, runId: o.runId, now: deps.now });
    const reply = renderResolutionReply({ resolution, note: r?.note ?? null, tests: r?.tests ?? null, sha: o.sha, commitUrl: url });
    const name = `${SEVERITY[f.severity]} · ${inline(f.title)}`;
    let replied: PullRequestReviewComment | null = null;
    if (root?.commentId) {
      try {
        if (comments === null) comments = await ownComments(deps, o.repo, o.prNumber, o.login);
        replied = await replyOnce(deps, o.repo, o.prNumber, root.commentId, threadReplyMarker('fix', o.runId, root.key), reply, comments);
      } catch (err) {
        settle(deps, err, log, `could not reply in the thread of ${root.key}; the answer is in the pull request comment`);
      }
    }
    lines.push(
      replied
        ? `- ${name}: ${resolution} ([in its thread](${replied.htmlUrl}))`
        : `- ${name}: ${reply.replace(/^\*\*Coding agent:\*\* /, '').replace(/\n+/g, ' ')}`,
    );
  }
  return { lines, log };
}
