// The resolve step of each poll (#190): every thread a reviewer verified is resolved on GitHub,
// however the review step's own try went. That try (answerInThreads, threads.ts) resolves the
// thread right after its "I verified this" reply, but only while the pull request is still at the
// verified head, and a refusal there is only said in the run log. Here the same thread is tried
// again on every poll, for as long as the pull request is open, until GitHub confirms it.
//
// What is resolved: the root of a thread the worker started (its first comment, by the worker's
// own login), whose finding is verified and not yet recorded as resolved. A verified finding is not
// re-checked by later reviewers (openThreads), so its verification stands until a later review
// repeats it, which makes it unresolved again; the state is read once more right before each
// resolution. Every failure or skip is a log line; nothing is ever said in a pull request comment.
import { getFinding, markThreadResolved, verifiedUnresolvedThreads, type ReviewFinding } from '../db/review-findings.js';
import { GitHubError } from '../github/api.js';
import { workerLogin } from '../github/identity.js';
import type { RepoRef } from '../types.js';
import { findThread } from './threads.js';
import type { PublishDeps } from './publish.js';

export type ThreadResolveDeps = Pick<PublishDeps, 'db' | 'config' | 'api' | 'log' | 'now' | 'scope'>;

export interface ThreadResolveResult {
  repoId: number;
  prNumber: number;
  /** Threads resolved now (or found resolved on GitHub and recorded). */
  resolved: string[];
  /** Threads left for a later poll, each with why. */
  left: { key: string; why: string }[];
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Threads that were not found among the pull request's threads (their root comment deleted, for
 * example), by database: each is tried again after a growing wait, not on every poll, and the
 * warning says when. Found again (or resolved), it is forgotten.
 */
const MISSING_FIRST_WAIT_MS = 5 * 60_000;
const MISSING_MAX_WAIT_MS = 6 * 60 * 60_000;
const missing = new WeakMap<object, Map<string, { misses: number; until: number }>>();
const missingOf = (db: object) => {
  let m = missing.get(db);
  if (!m) missing.set(db, (m = new Map()));
  return m;
};
const missingKey = (repoId: number, prNumber: number, f: ReviewFinding) => `${repoId}:${prNumber}:${f.key}:${f.commentId}`;

/** One pull request's verified threads, resolved. Never throws for GitHub's answers; a later poll retries what is left. */
async function resolvePr(deps: ThreadResolveDeps, repo: RepoRef, prNumber: number, findings: ReviewFinding[]): Promise<ThreadResolveResult> {
  const { db, api, log } = deps;
  const out: ThreadResolveResult = { repoId: repo.id, prNumber, resolved: [], left: [] };
  const leave = (keys: string[], why: string) => {
    for (const key of keys) out.left.push({ key, why });
    log.warn(`threads: ${keys.join(', ')} verified, not resolved yet: ${why}; tried again on the next poll`, { repo: repo.fullName, pr: prNumber });
  };
  const clock = deps.now ?? Date.now;
  const waiting = missingOf(db);
  // A thread not found before waits out its backoff (already said in the warning that set it).
  findings = findings.filter((f) => (waiting.get(missingKey(repo.id, prNumber, f))?.until ?? 0) <= clock());
  if (findings.length === 0) return out;
  const keys = findings.map((f) => f.key);
  if (!api.listReviewThreads || !api.resolveReviewThread) {
    leave(keys, 'this GitHub client cannot list or resolve review threads');
    return out;
  }
  let login: string;
  let threads: Parameters<typeof findThread>[5];
  try {
    const live = await api.getPullRequest(repo, prNumber);
    // Closed or merged: nothing is resolved any more; the loop's sync stops watching it.
    if (live.state !== 'open' || live.merged) return out;
    login = await workerLogin(api);
    threads = { threads: await api.listReviewThreads(repo, prNumber) };
  } catch (err) {
    leave(keys, `could not read the pull request's threads (${message(err)})`);
    return out;
  }
  for (const f of findings) {
    try {
      const thread = await findThread({ api }, repo, prNumber, f.commentId!, login, threads);
      const mk = missingKey(repo.id, prNumber, f);
      if (!thread) {
        const misses = (waiting.get(mk)?.misses ?? 0) + 1;
        const wait = Math.min(MISSING_FIRST_WAIT_MS * 2 ** (misses - 1), MISSING_MAX_WAIT_MS);
        waiting.set(mk, { misses, until: clock() + wait });
        out.left.push({ key: f.key, why: `its thread (comment ${f.commentId}) is not among the pull request's threads as ${login}'s` });
        log.warn(
          `threads: ${f.key} verified, not resolved yet: its thread (comment ${f.commentId}) is not among the pull request's threads as ${login}'s; tried again in ${Math.round(wait / 60_000)} minutes`,
          { repo: repo.fullName, pr: prNumber },
        );
        continue;
      }
      waiting.delete(mk);
      // Right before: still a verified root with this thread, not resolved by another attempt meanwhile.
      const now = getFinding(db, repo.id, prNumber, f.key);
      if (now?.status !== 'verified' || now.threadKey !== now.key || now.commentId !== f.commentId) continue;
      if (now.threadResolvedAt) continue;
      if (!thread.isResolved) await api.resolveReviewThread(repo, thread.id);
      thread.isResolved = true;
      markThreadResolved(db, repo.id, prNumber, f.key, deps.now);
      out.resolved.push(f.key);
      log.info(`threads: resolved the verified thread of ${f.key}`, { repo: repo.fullName, pr: prNumber });
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
      leave([f.key], `GitHub did not resolve its thread (${err.message})`);
    }
  }
  return out;
}

/**
 * The resolve step for every repository (or for `only`, a pull request a webhook named). Never
 * throws: what fails is logged and tried again on the next poll.
 */
export async function resolveVerifiedThreadsAll(deps: ThreadResolveDeps, signal?: AbortSignal, opts: { only?: { repoId: number; prNumber: number } } = {}): Promise<ThreadResolveResult[]> {
  const results: ThreadResolveResult[] = [];
  for (const [fullName, cfg] of Object.entries(deps.config.repositories)) {
    if (opts.only && opts.only.repoId !== cfg.id) continue;
    let pending: ReviewFinding[];
    try {
      pending = verifiedUnresolvedThreads(deps.db, cfg.id).filter(
        (f) => (deps.scope?.pr(f.repoId, f.prNumber) ?? true) && (!opts.only || opts.only.prNumber === f.prNumber),
      );
    } catch (err) {
      deps.log.error('could not list the verified threads to resolve', { repo: fullName, error: message(err) });
      continue;
    }
    const byPr = new Map<number, ReviewFinding[]>();
    for (const f of pending) byPr.set(f.prNumber, [...(byPr.get(f.prNumber) ?? []), f]);
    for (const [prNumber, findings] of byPr) {
      if (signal?.aborted) return results;
      try {
        results.push(await resolvePr(deps, { id: cfg.id, fullName }, prNumber, findings));
      } catch (err) {
        deps.log.error('resolving the verified threads crashed', { repo: fullName, pr: prNumber, error: message(err) });
      }
    }
  }
  return results;
}
