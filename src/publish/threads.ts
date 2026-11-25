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
import { transaction } from '../db/database.js';
import {
  applyRepeat,
  findingsOfRun,
  getFinding,
  markThreadReopened,
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
import type { RepoRef, ReviewVerdict, RevisionFinding } from '../types.js';
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
 * What a review says about each earlier thread, by the thread's root: verified only when every
 * check of it (through any of its keys) says verified and no finding of the review repeats it;
 * anything else is unresolved. A key that is no finding of the pull request is left out. One
 * review never says two things about one thread.
 */
export function effectiveChecks(
  structured: StructuredReview | null,
  runId: string,
  rootOf: (key: string) => ReviewFinding | null,
): Map<string, EffectiveCheck> {
  const out = new Map<string, EffectiveCheck>();
  const entry = (root: ReviewFinding) => {
    let e = out.get(root.key);
    if (!e) out.set(root.key, (e = { root, status: 'verified', notes: [], repeats: [] }));
    return e;
  };
  for (const c of structured?.checks ?? []) {
    const root = rootOf(c.finding);
    if (!root) continue;
    const e = entry(root);
    if (c.status !== 'verified') e.status = 'unresolved';
    if (c.note) e.notes.push(c.note);
  }
  for (const f of structured?.findings ?? []) {
    if (!f.sameAs) continue;
    // A finding naming another of this same review is not about an earlier thread.
    if (f.sameAs.startsWith(`${runId}#`)) continue;
    const root = rootOf(f.sameAs);
    if (!root) continue;
    const e = entry(root);
    e.status = 'unresolved';
    e.repeats.push({ key: findingKey(runId, f.id), severity: f.severity });
  }
  // The strongest repeat first: a blocker is never outweighed by a suggestion about the same thread.
  for (const e of out.values()) e.repeats.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'blocker' ? -1 : 1));
  return out;
}

export interface EffectiveCheck {
  root: ReviewFinding;
  status: 'verified' | 'unresolved';
  notes: string[];
  /** This review's findings that repeat the thread, the strongest first. */
  repeats: { key: string; severity: StructuredFinding['severity'] }[];
}

/**
 * Why a ready-to-merge verdict contradicts the review it ends, or null when it does not: the
 * review lists a blocker, or an earlier blocker thread of the pull request (every one recorded,
 * not only those the reviewer was shown) is not verified by it. Such a verdict is never acted on
 * as ready; the caller takes it as changes requested. A legacy review on a pull request without
 * earlier blockers is not checked: there is nothing structured to agree with.
 */
export function verdictContradiction(
  verdict: ReviewVerdict,
  structured: StructuredReview | null,
  o: { runId: string; blockers: readonly ReviewFinding[]; rootOf: (key: string) => ReviewFinding | null },
): string | null {
  if (verdict !== 'ready-to-merge') return null;
  const blockers = (structured?.findings ?? []).filter((f) => f.severity === 'blocker');
  if (blockers.length) return `it lists ${blockers.length} blocker(s) (${blockers.map((b) => b.id).join(', ')})`;
  const said = effectiveChecks(structured, o.runId, o.rootOf);
  // Any blocker thread it leaves unresolved, whatever its recorded state: one verified before and found broken again is open.
  const reopened = [...said.values()].find((e) => e.status === 'unresolved' && (e.root.severity === 'blocker' || e.repeats.some((r) => r.severity === 'blocker')));
  if (reopened) return `it found the earlier blocker ${reopened.root.key} still unresolved`;
  if (!o.blockers.length) return null;
  if (!structured) return `it re-checked none of the ${o.blockers.length} earlier blocker(s)`;
  const open = o.blockers.filter((b) => said.get(b.key)?.status !== 'verified');
  if (!open.length) return null;
  const unresolved = open.filter((b) => said.get(b.key)?.status === 'unresolved');
  if (unresolved.length) return `it found the earlier blocker ${unresolved[0]!.key} still unresolved`;
  return open.length === 1 ? `it did not re-check the earlier blocker ${open[0]!.key}` : `it did not re-check ${open.length} earlier blockers (${open[0]!.key}, ...)`;
}

// ---------------------------------------------------------------------------
// After the review is on GitHub: threads, repeats and checks
// ---------------------------------------------------------------------------

export interface ThreadDeps {
  db: Db;
  api: Pick<GitHubApi, 'listPullRequestReviewComments' | 'replyToReviewComment' | 'listReviewThreads' | 'resolveReviewThread' | 'unresolveReviewThread'>;
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

/** The worker's own thread whose first comment is `rootCommentId`, among the pull request's threads (read once per step). */
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

export interface ThreadAnswers {
  repeats: { root: ReviewFinding; finding: ReviewFinding }[];
  checks: { root: ReviewFinding; status: 'verified' | 'unresolved'; note: string }[];
  log: string[];
}

/**
 * Step 2, for a review of the pull request's current head only (the caller checks GitHub right
 * before): what the review says about earlier threads becomes their state, in one transaction, so
 * nothing is left half done. A repeat posted inline of a finding that had no thread becomes that
 * thread's root; each earlier thread the review checks or repeats gets the review's one effective
 * status (effectiveChecks), a repeat also its current severity and text. `at` is when the review
 * was recorded: a newer review's state is never overwritten by an older one's. Returns what to
 * answer in the threads (answerInThreads). Idempotent: a retry finds everything done.
 */
export function applyFindingState(
  deps: ThreadDeps,
  o: { repoId: number; prNumber: number; runId: string; headSha: string; at: string; structured: StructuredReview },
): ThreadAnswers {
  deps.guard();
  return transaction(deps.db, () => {
    const { repoId, prNumber, runId } = o;
    const log: string[] = [];
    const rootOf = (key: string) => threadOf(deps.db, repoId, prNumber, key);
    // Promotions first, so every key below resolves to the thread as it is now.
    for (const f of o.structured.findings) {
      if (!f.sameAs) continue;
      const own = getFinding(deps.db, repoId, prNumber, findingKey(runId, f.id));
      const root = rootOf(findingKey(runId, f.id));
      if (own && root && root.key !== own.key && !root.commentId && own.commentId) promoteThread(deps.db, repoId, prNumber, own.key, deps.now);
    }
    for (const c of o.structured.checks) if (!rootOf(c.finding)) log.push(`threads: the check of ${c.finding} names no finding of this pull request; ignored`);
    const answers: ThreadAnswers = { repeats: [], checks: [], log };
    for (const [key, e] of effectiveChecks(o.structured, runId, rootOf)) {
      const note = e.notes.join(' ');
      const rows = e.repeats.map((r) => getFinding(deps.db, repoId, prNumber, r.key)).filter((r): r is ReviewFinding => r !== null);
      // The strongest repeat speaks for the thread; the others' evidence is kept with it.
      const repeat = rows[0] ? { ...rows[0], problem: [rows[0].problem, ...rows.slice(1).map((r) => `Also: ${r.problem}`)].join('\n\n') } : null;
      const applied = repeat
        ? applyRepeat(deps.db, repoId, prNumber, key, repeat, o.at, deps.now)
        : recordCheck(deps.db, repoId, prNumber, key, { status: e.status, sha: o.headSha, note, at: o.at, now: deps.now });
      if (!applied) {
        log.push(`threads: a newer review already recorded the state of ${key}; this review's is not applied`);
        continue;
      }
      const root = getFinding(deps.db, repoId, prNumber, key)!;
      if (repeat && repeat.key !== root.key) answers.repeats.push({ root, finding: repeat });
      if (e.notes.length || !repeat) answers.checks.push({ root, status: e.status, note });
    }
    return answers;
  });
}

/**
 * Step 3: the state step 2 recorded, answered in each thread the worker started. A thread is
 * resolved only when step 2 verified it, it is still verified for this head, and `stillCurrent`
 * (GitHub, read right before) says the pull request has not moved on; the resolution is recorded
 * only once GitHub confirms it. Never repeats a write a retry already made.
 */
export async function answerInThreads(
  deps: ThreadDeps,
  o: { repo: RepoRef; prNumber: number; runId: string; headSha: string; round: number; login: string; comments: Comments | null; answers: ThreadAnswers; stillCurrent: () => Promise<boolean> },
): Promise<{ log: string[] }> {
  const log = [...o.answers.log];
  const { repo, prNumber, runId } = o;
  const comments = o.comments ?? [];
  for (const { root, finding } of o.answers.repeats) {
    if (!root.commentId) continue;
    try {
      await replyOnce(
        deps,
        repo,
        prNumber,
        root.commentId,
        threadReplyMarker('repeat', runId, root.key),
        [`**${ROLE.review} · Round ${o.round} · ${code(short(o.headSha))}:** this is still not fixed.`, '', ...findingText(finding)].join('\n'),
        comments,
      );
    } catch (err) {
      settle(deps, err, log, `could not reply in the thread of ${root.key}; the review summary has the finding`);
    }
  }
  const cache: Parameters<typeof findThread>[5] = {};
  // A thread this review found unresolved is reopened on GitHub if it was resolved: a regressed
  // blocker must not sit in a collapsed thread. Only the worker's own threads, while the pull
  // request is still at this head.
  const reopened = new Set<string>();
  const unresolvedRoots = [...o.answers.repeats.map((r) => r.root), ...o.answers.checks.filter((c) => c.status === 'unresolved').map((c) => c.root)];
  for (const root of unresolvedRoots) {
    if (!root.commentId || reopened.has(root.key) || !deps.api.listReviewThreads || !deps.api.unresolveReviewThread) continue;
    reopened.add(root.key);
    try {
      const thread = await findThread(deps, repo, prNumber, root.commentId, o.login, cache);
      if (!thread?.isResolved) {
        if (root.threadResolvedAt) {
          deps.guard();
          markThreadReopened(deps.db, repo.id, prNumber, root.key, deps.now);
        }
        continue;
      }
      if (!(await o.stillCurrent())) {
        log.push(`threads: the pull request moved on from ${short(o.headSha)}; the thread of ${root.key} was not reopened`);
        continue;
      }
      deps.guard();
      await deps.api.unresolveReviewThread(repo, thread.id);
      thread.isResolved = false;
      deps.guard();
      markThreadReopened(deps.db, repo.id, prNumber, root.key, deps.now);
    } catch (err) {
      settle(deps, err, log, `could not reopen the thread of ${root.key}; its reply and the review summary say it is unresolved`);
    }
  }
  for (const c of o.answers.checks) {
    const { root } = c;
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
    if (c.status !== 'verified' || !deps.api.listReviewThreads || !deps.api.resolveReviewThread) continue;
    try {
      const thread = await findThread(deps, repo, prNumber, root.commentId, o.login, cache);
      if (!thread) {
        log.push(`threads: the thread of ${root.key} is not among the pull request's threads; it is verified, not resolved`);
        continue;
      }
      if (!thread.isResolved) {
        // Right before: still this head's verification, and still this head on GitHub.
        const now = getFinding(deps.db, repo.id, prNumber, root.key);
        if (now?.status !== 'verified' || now.statusSha !== o.headSha) {
          log.push(`threads: ${root.key} is no longer verified for ${short(o.headSha)}; not resolved`);
          continue;
        }
        if (!(await o.stillCurrent())) {
          log.push(`threads: the pull request moved on from ${short(o.headSha)}; ${root.key} is verified, not resolved`);
          continue;
        }
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

/**
 * What a revision of this review answers, by thread, as the threads stand once the review's state
 * is recorded: each finding of the review (a repeat by the thread it repeats, which now carries
 * the strongest severity and all the evidence), then each earlier thread its checks found
 * unresolved without repeating it, so a reopened blocker gets a keyed answer too.
 */
export function revisionFindingsOf(db: Db, o: { repoId: number; prNumber: number; runId: string; structured: StructuredReview }): RevisionFinding[] {
  const roots: ReviewFinding[] = [];
  const seen = new Set<string>();
  const add = (r: ReviewFinding | null) => {
    if (!r || seen.has(r.key) || r.status === 'verified') return;
    seen.add(r.key);
    roots.push(r);
  };
  for (const f of findingsOfRun(db, o.runId)) add(threadOf(db, o.repoId, o.prNumber, f.key) ?? f);
  for (const c of o.structured.checks) if (c.status !== 'verified') add(threadOf(db, o.repoId, o.prNumber, c.finding));
  return roots.map((r) => ({ key: r.key, severity: r.severity, title: r.title, problem: r.problem, suggestion: r.suggestion, path: r.path, line: r.line, threadUrl: r.commentUrl }));
}

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
