// How a reviewer run's review is submitted on GitHub (docs/github-app.md, "Publishing as a
// person"; docs/review-loop.md). By default it is a COMMENT review, because the worker that opened
// the pull request is also the one reviewing it and GitHub refuses an approval or change request
// from a pull request's own author. When a person publishes the pull request (publishAs user) and
// the GitHub App reviews it, the App may submit a formal APPROVE or REQUEST_CHANGES, pinned to the
// exact commit it reviewed. Whatever the form, the worker's own verdict is what acts: a formal
// review is a statement on GitHub, never what queues a revision or a merge.

export type FormalEvent = 'APPROVE' | 'REQUEST_CHANGES';

export type ReviewForm =
  /** `why`: why it is a comment and not `instead`; null for the plain comment review of the worker's own pull request. */
  | { event: 'COMMENT'; why: string | null; instead?: FormalEvent }
  | { event: FormalEvent; reviewer: string };

export const COMMENT_FORM: ReviewForm = { event: 'COMMENT', why: null };

const NAMES: Record<FormalEvent, string> = { APPROVE: 'approval', REQUEST_CHANGES: 'change request' };

/** The sentence of a review body that says what kind of GitHub review it is, and what that does and does not mean. */
export function reviewFormSentence(form: ReviewForm = COMMENT_FORM): string {
  if (form.event === 'COMMENT') {
    if (form.why === null) {
      return 'It is posted as a comment because the account that opened a pull request cannot approve or request changes on it; the verdict itself is recorded by the worker.';
    }
    return `It is posted as a comment, not as a GitHub ${NAMES[form.instead ?? 'APPROVE']}, because ${form.why}; the verdict itself is recorded by the worker.`;
  }
  const reviewer = form.reviewer.replace(/[^A-Za-z0-9_.\-[\]]/g, '');
  if (form.event === 'APPROVE') {
    return (
      `It is submitted as a GitHub approval of exactly this commit by \`${reviewer}\`, an automated reviewer that did not open this pull request. ` +
      'It counts toward required reviews only where GitHub itself reports that it does, never in place of a review a person or code owner must give, ' +
      "and Updraft's own verdict and the checks on this commit still decide what happens next."
    );
  }
  return (
    `It is submitted as a GitHub change request on exactly this commit by \`${reviewer}\`, an automated reviewer that did not open this pull request. ` +
    'Any revision is queued from the verdict the worker recorded, not from this GitHub review.'
  );
}

/**
 * The form a review takes. `publisher`: who opened the pull request (null: the worker, as before
 * publishAs existed). `reviewer`: the worker's login, which submits the review. Formal only when
 * the two are different accounts, the commit is still the head, and nothing is left for a person
 * or for earlier blockers to settle; otherwise a comment that says why.
 */
export function chooseReviewForm(o: {
  publisher: { kind: 'worker' | 'user'; login: string } | null;
  reviewer: string;
  verdict: 'ready-to-merge' | 'changes-requested';
  /** The head as GitHub reports it just before posting; null when not read. */
  liveHead: string | null;
  headSha: string;
  /** The verdict holds the head for a person (acceptance criteria only a person can settle). */
  heldForPerson: boolean;
  /** Blockers of earlier reviews not verified yet. */
  openBlockers: number;
}): ReviewForm {
  if (!o.publisher || o.publisher.kind !== 'user') return COMMENT_FORM;
  const instead: FormalEvent = o.verdict === 'changes-requested' ? 'REQUEST_CHANGES' : 'APPROVE';
  if (o.publisher.login.toLowerCase() === o.reviewer.toLowerCase()) {
    return { event: 'COMMENT', instead, why: `the reviewer and the publisher of this pull request are the same account (${o.reviewer}), and GitHub refuses that account's approval or change request on it` };
  }
  if (o.liveHead !== o.headSha) {
    return { event: 'COMMENT', instead, why: `the pull request is no longer at the reviewed commit (it is at ${o.liveHead ? o.liveHead.slice(0, 12) : 'an unknown commit'}), and a formal review is only ever for the current head` };
  }
  if (o.heldForPerson) {
    return { event: 'COMMENT', instead, why: 'what is still missing is for a person to settle, which an automated approval or change request would misstate' };
  }
  if (instead === 'APPROVE' && o.openBlockers > 0) {
    return { event: 'COMMENT', instead, why: `${o.openBlockers} blocker(s) of earlier reviews are not verified yet` };
  }
  return { event: instead, reviewer: o.reviewer };
}
