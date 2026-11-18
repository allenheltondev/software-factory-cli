// The one place that decides what counts as a change request. The review poller asks it about
// every review it has not seen before and does what it says; the queue, the executor and the push
// never look at a review's state or author themselves. A new kind of trigger (for example a
// review carrying a marker) is a new branch here, a new RevisionTriggerKind, and nothing else.
//
// There are two kinds. changes_requested: a person's "Request changes" review, read from GitHub
// (reviewTrigger). updraft_review: a changes-requested verdict of Updraft's own reviewer run
// (verdictTrigger), taken from the worker's database at the moment the verdict is recorded; the
// comment review the worker posts for people to read is never read back to decide anything.
import type { GitHubReview, GitHubReviewComment } from '../github/api.js';
import type { ReviewSnapshot, ReviewVerdict, RevisionRequest, RevisionTriggerKind } from '../types.js';

export type ReviewDecision =
  /** Not a change request of any kind (a comment, an approval, a pending or dismissed review). Nothing is recorded. */
  | { triggers: false; kind: null }
  /**
   * A change request that must not be acted on. `not-allowed`: its author may not dispatch work.
   * `ignored`: text in it was last edited by someone who may not, so nobody allowed stands behind it.
   */
  | { triggers: false; kind: RevisionTriggerKind; disposition: 'not-allowed' | 'ignored'; reason: string }
  /** Queue a revision. `body` and `comments` are the only text of the review that may reach the prompt. */
  | { triggers: true; kind: RevisionTriggerKind; author: string; body: string; comments: GitHubReviewComment[]; omittedComments: number };

export function isAllowedActor(allowedActors: readonly string[], login: string | null): login is string {
  return login !== null && allowedActors.some((a) => a.toLowerCase() === login.toLowerCase());
}

/**
 * Does `review` ask for a revision, and which of its text may the agent be given?
 *
 * `allowedActors` is the allowlist of the workflow that produced the PR (the workflow's own
 * allowedActors, else dispatch.allowedActors): whoever may dispatch an issue may ask for changes
 * to the result.
 *
 * - Trigger: a submitted review with state CHANGES_REQUESTED whose author is allowed. A review by
 *   anyone else is never acted on; comments and approvals are not change requests.
 * - Text: the review body and the review's own inline comments written by an allowed actor.
 *   Comments by anyone else are left out (and counted).
 * - Edits: GitHub lets people with write access edit a review body and its comments. If the
 *   newest edit of any text that would be used was made by someone not allowed (or unknown), the
 *   whole review is refused rather than used in part.
 */
export function reviewTrigger(review: GitHubReview, allowedActors: readonly string[]): ReviewDecision {
  if (review.state !== 'CHANGES_REQUESTED' || review.submittedAt === null) return { triggers: false, kind: null };
  const kind: RevisionTriggerKind = 'changes_requested';
  if (!isAllowedActor(allowedActors, review.author)) {
    return {
      triggers: false,
      kind,
      disposition: 'not-allowed',
      reason: `${review.author ?? 'an unknown user'} is not an allowed actor for the workflow that opened this pull request`,
    };
  }
  const editedByOther = (t: { lastEditedAt: string | null; editor: string | null }) => t.lastEditedAt !== null && !isAllowedActor(allowedActors, t.editor);
  if (editedByOther(review)) {
    return {
      triggers: false,
      kind,
      disposition: 'ignored',
      reason: `the review body was edited by ${review.editor ?? 'an unknown user'}, who is not an allowed actor; submit a new review to request the changes`,
    };
  }
  const comments = review.comments.filter((c) => isAllowedActor(allowedActors, c.author));
  const edited = comments.find(editedByOther);
  if (edited) {
    return {
      triggers: false,
      kind,
      disposition: 'ignored',
      reason: `a review comment on ${edited.path || 'the pull request'} was edited by ${edited.editor ?? 'an unknown user'}, who is not an allowed actor; submit a new review to request the changes`,
    };
  }
  return { triggers: true, kind, author: review.author, body: review.body, comments, omittedComments: review.commentCount - comments.length };
}

/** Review id (the dedupe key in review_requests) of the change request a reviewer run's verdict makes. */
export function verdictReviewId(runId: string): string {
  return `updraft-review:${runId}`;
}

export type VerdictDecision =
  /** Not a change request (ready to merge). */
  | { triggers: false; kind: null }
  /** Queue a revision for the reviewer's findings. `review.body` is the only text that may reach the prompt. */
  | { triggers: true; kind: RevisionTriggerKind; reviewId: string; review: ReviewSnapshot; reviewedSha: string };

/**
 * Does a verdict of Updraft's own reviewer ask for a revision?
 *
 * - Trigger: `changes-requested`, and nothing else. Whether it is still about the PR's current
 *   head is checked by the caller when it is recorded, and again before the revision starts
 *   (verdictStale): a verdict is bound to the commit it reviewed.
 * - Text: the reviewer's findings as the worker recorded them. They are an agent's output about
 *   untrusted code, so the revision prompt fences them like any review.
 * - Who: the worker itself, as `reviewer` (its own GitHub login). No allowlist applies: that
 *   reviewer runs exist at all is the repository's `review` setting.
 */
export function verdictTrigger(v: {
  runId: string;
  verdict: ReviewVerdict;
  findings: string;
  headSha: string;
  reviewer: string;
  /** Link shown in the revision's reply: the posted comment review. */
  reviewUrl: string;
  recordedAt: string;
}): VerdictDecision {
  if (v.verdict !== 'changes-requested') return { triggers: false, kind: null };
  return {
    triggers: true,
    kind: 'updraft_review',
    reviewId: verdictReviewId(v.runId),
    reviewedSha: v.headSha,
    review: { id: verdictReviewId(v.runId), url: v.reviewUrl, author: v.reviewer, submittedAt: v.recordedAt, body: v.findings, comments: [], omittedComments: 0 },
  };
}

/**
 * Why whoever asked for a queued revision may no longer do so, or null. A person must still be an
 * allowed actor; Updraft's own reviewer needs `reviewOn` (the repository still has review on).
 */
export function requesterProblem(revision: RevisionRequest, allowedActors: readonly string[], reviewOn: boolean): string | null {
  if (revision.trigger === 'updraft_review') return reviewOn ? null : 'review is off for this repository now, so its reviewer verdicts are no longer acted on';
  return isAllowedActor(allowedActors, revision.review.author)
    ? null
    : `${revision.review.author}, who requested the changes, is no longer an allowed actor for this workflow`;
}

/**
 * A verdict is for one commit. Returns why a revision queued by a verdict must be dropped given
 * the PR's head now (`headSha`; null when it is not known), or null when it still applies.
 * Change requests by people are not bound to a commit and are never stale.
 */
export function verdictStale(revision: RevisionRequest, headSha: string | null): string | null {
  if (revision.trigger !== 'updraft_review' || !revision.reviewedSha || headSha === null || headSha === revision.reviewedSha) return null;
  return `the reviewer's verdict was for ${revision.reviewedSha.slice(0, 12)}, but the pull request is now at ${headSha.slice(0, 12)}; the verdict is stale`;
}

/**
 * Has the change request behind a queued revision been taken back since it was ingested? Checked
 * against the PR's current reviews just before the run starts. Returns a cancel reason, or null.
 * A review that is no longer listed is not proof of anything and does not cancel.
 */
export function reviewWithdrawn(revision: RevisionRequest, current: readonly GitHubReview[]): string | null {
  const { review } = revision;
  const now = current.find((r) => r.id === review.id);
  if (now && now.state !== 'CHANGES_REQUESTED') {
    return `the review by ${review.author} that requested the changes is now ${now.state.toLowerCase().replace(/_/g, ' ')}`;
  }
  const approvedSince = current.some(
    (r) =>
      r.state === 'APPROVED' &&
      r.author?.toLowerCase() === review.author.toLowerCase() &&
      Date.parse(r.submittedAt ?? '') > Date.parse(review.submittedAt),
  );
  return approvedSince ? `${review.author} approved the pull request after requesting these changes` : null;
}
