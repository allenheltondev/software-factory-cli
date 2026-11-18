// What a reviewer run (repositories.<repo>.review) does differently from a code run. The live
// executor (live.ts) runs it through the same path as any agent: same lookup, container, pid
// tracking, timeout, cancel and run.log. The differences, all here or behind a `review` check:
// - the worktree is a throwaway at exactly the pull request's head commit, and it and its branch
//   are removed after the run whatever the outcome: nothing a reviewer changes or commits is
//   kept, and no step after it pushes anything;
// - in a container the clone's git directory is mounted read-only (container.ts, gitMounts);
// - the action's verify commands are not run (they ran for the code run that produced the head);
// - the result is the verdict parsed from the agent's final message. No verdict, no success.
import { appendFile } from 'node:fs/promises';
import type { AgentAdapter } from '../agents/adapters/registry.js';
import { parseVerdict, type ParsedVerdict } from '../agents/verdict.js';
import { fetchBranch, remoteDefaultBranch, runGit, type GitOptions } from '../git/git.js';
import { discardWorktree, withCheckoutLock } from '../git/worktree.js';
import type { ReviewRunRequest } from '../types.js';

/** Findings kept from a reviewer's final message (the run log has all of it). */
export const MAX_FINDINGS = 30_000;

/** A reviewer run in progress. `worktree` is set as soon as its throwaway worktree exists. */
export interface ReviewRunState {
  request: ReviewRunRequest;
  worktree: { checkoutPath: string; worktreePath: string; branch: string } | null;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The commit the pull request's change starts from: the merge base of its base branch (fetched
 * now) and the head under review. Best effort: without it the reviewer is told the base is
 * unknown and can still read the head commit.
 */
export function reviewBase(o: {
  checkoutPath: string;
  remote: string;
  baseBranch: string | null | undefined;
  headSha: string;
  git?: string;
  signal?: AbortSignal;
}): Promise<{ baseBranch: string | null; baseSha: string | null; note?: string }> {
  return withCheckoutLock(o.checkoutPath, async () => {
    const opts: GitOptions = { cwd: o.checkoutPath, git: o.git };
    const net: GitOptions = { ...opts, signal: o.signal };
    let baseBranch = o.baseBranch ?? null;
    try {
      baseBranch ??= await remoteDefaultBranch(o.remote, net);
      const tip = await fetchBranch(o.remote, baseBranch, net);
      const baseSha = (await runGit(['merge-base', tip, o.headSha], opts)).stdout.trim() || null;
      return { baseBranch, baseSha };
    } catch (err) {
      return { baseBranch, baseSha: null, note: `could not determine the base commit of the pull request: ${message(err)}` };
    }
  });
}

/**
 * The verdict of a reviewer run, read from the adapter's final message: the agent's own last
 * message where the adapter can isolate it (structured output), else the whole plain output.
 */
export function readReviewVerdict(adapter: AgentAdapter, rawOutput: string): ParsedVerdict {
  let final: string | null | undefined;
  try {
    final = adapter.finalMessage ? adapter.finalMessage(rawOutput) : undefined;
  } catch (err) {
    return { ok: false, problem: `the reviewer's final message could not be read (${message(err)})` };
  }
  if (final === null) return { ok: false, problem: 'the reviewer ended without a final message' };
  const parsed = parseVerdict(final ?? rawOutput);
  if (!parsed.ok) return parsed;
  const findings = parsed.findings.length > MAX_FINDINGS ? `${parsed.findings.slice(0, MAX_FINDINGS - 1)}…` : parsed.findings;
  return { ...parsed, findings };
}

/** Remove a reviewer run's worktree and branch, and say so in run.log. Never throws. */
export async function discardReviewWorktree(state: ReviewRunState, o: { git?: string; logPath: string }): Promise<void> {
  const wt = state.worktree;
  if (!wt) return;
  let notes: string[];
  try {
    notes = await discardWorktree({ ...wt, git: o.git });
  } catch (err) {
    notes = [`could not remove the review worktree: ${message(err)}`];
  }
  const lines = notes.length
    ? notes.map((n) => `review: ${n}`)
    : [`review: the worktree ${wt.worktreePath} and its branch ${wt.branch} were removed; nothing the reviewer changed or committed is kept, and nothing was pushed`];
  try {
    await appendFile(o.logPath, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    // the log is best effort here; the removal itself is what matters
  }
}
