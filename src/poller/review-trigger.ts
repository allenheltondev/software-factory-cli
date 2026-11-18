// The one place that decides what counts as a change request. The review poller asks it about
// every review it has not seen before and does what it says; the queue, the executor and the push
// never look at a review's state or author themselves. A new kind of trigger (for example a
// review carrying a marker) is a new branch here, a new RevisionTriggerKind, and nothing else.
import type { GitHubReview, GitHubReviewComment } from '../github/api.js';
import type { RevisionRequest, RevisionTriggerKind } from '../types.js';

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
