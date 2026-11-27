// Telling GitHub catching up from a real move (#197). Right after a push, a pull request's
// `head.sha` can still name the commit the push replaced; the branch's git ref moves with the
// push itself. Where a read of the pull request may only be lag (the head on record is the
// worker's own push that replaced the commit read), the ref decides: at the worker's push, it is
// lag; anywhere else, the branch really moved, and that is believed at once.
import type { Db } from '../db/database.js';
import { observeHead, ownPushOnRecord } from '../db/pr-reviews.js';
import type { GitHubApi } from '../github/api.js';
import type { RepoRef } from '../types.js';

/** The commit `branch` points at now (null: no such branch), or undefined when the client cannot say (no method, a failed read). */
export async function branchSha(api: Pick<GitHubApi, 'getBranchSha'>, repo: RepoRef, branch: string): Promise<string | null | undefined> {
  if (!api.getBranchSha) return undefined;
  try {
    return await api.getBranchSha(repo, branch);
  } catch {
    return undefined;
  }
}

/**
 * observeHead for a read of the pull request on GitHub. A read that may only be lag (the head on
 * record is the worker's own push that replaced the commit read: ownPushOnRecord) is checked
 * against the branch's git ref (one request, only then): at the worker's push, it is lag and not
 * believed, however long GitHub takes (the reviewer job's pre-start check bounds that wait:
 * HEAD_LAG_LIMIT_MS, #199); anywhere else, the move is believed at once. When the ref cannot be
 * read, observeHead's grace decides. True when the head on record changed.
 */
export async function observeLiveHead(
  deps: { db: Db; api: Pick<GitHubApi, 'getBranchSha'> },
  repo: RepoRef,
  pr: { prNumber: number; branch: string },
  sha: string,
  observedAt: string,
): Promise<boolean> {
  const ours = ownPushOnRecord(deps.db, repo.id, pr.prNumber, sha);
  if (ours) {
    const at = await branchSha(deps.api, repo, pr.branch);
    if (at === ours) return false;
    if (at !== undefined) return observeHead(deps.db, repo.id, pr.prNumber, sha, observedAt, { believe: true });
  }
  return observeHead(deps.db, repo.id, pr.prNumber, sha, observedAt);
}
