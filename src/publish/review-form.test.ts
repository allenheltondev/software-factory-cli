import { describe, expect, it } from 'vitest';
import { chooseReviewForm, COMMENT_FORM, reviewFormSentence } from './review-form.js';

const base = {
  publisher: { kind: 'user' as const, login: 'alice' },
  reviewer: 'updraft[bot]',
  liveHead: 'a'.repeat(40),
  headSha: 'a'.repeat(40),
  heldForPerson: false,
  openBlockers: 0,
};

describe('chooseReviewForm', () => {
  it('is the plain comment review for a pull request the worker published itself (unchanged)', () => {
    expect(chooseReviewForm({ ...base, publisher: null, verdict: 'ready-to-merge' })).toBe(COMMENT_FORM);
    expect(chooseReviewForm({ ...base, publisher: { kind: 'worker', login: 'updraft[bot]' }, verdict: 'changes-requested' })).toBe(COMMENT_FORM);
  });

  it('approves or requests changes as the App on a person\'s pull request at the reviewed head', () => {
    expect(chooseReviewForm({ ...base, verdict: 'ready-to-merge' })).toEqual({ event: 'APPROVE', reviewer: 'updraft[bot]' });
    expect(chooseReviewForm({ ...base, verdict: 'changes-requested' })).toEqual({ event: 'REQUEST_CHANGES', reviewer: 'updraft[bot]' });
  });

  it('falls back to an explained comment: same account, stale head, held for a person, open blockers', () => {
    expect(chooseReviewForm({ ...base, reviewer: 'ALICE', verdict: 'ready-to-merge' })).toMatchObject({ event: 'COMMENT', instead: 'APPROVE', why: expect.stringMatching(/same account/) });
    expect(chooseReviewForm({ ...base, liveHead: 'b'.repeat(40), verdict: 'changes-requested' })).toMatchObject({ event: 'COMMENT', instead: 'REQUEST_CHANGES', why: expect.stringMatching(/no longer at the reviewed commit/) });
    expect(chooseReviewForm({ ...base, liveHead: null, verdict: 'ready-to-merge' })).toMatchObject({ event: 'COMMENT' });
    expect(chooseReviewForm({ ...base, heldForPerson: true, verdict: 'changes-requested' })).toMatchObject({ event: 'COMMENT', why: expect.stringMatching(/for a person/) });
    expect(chooseReviewForm({ ...base, openBlockers: 2, verdict: 'ready-to-merge' })).toMatchObject({ event: 'COMMENT', why: expect.stringMatching(/2 blocker/) });
    // Open blockers do not stop a change request.
    expect(chooseReviewForm({ ...base, openBlockers: 2, verdict: 'changes-requested' })).toMatchObject({ event: 'REQUEST_CHANGES' });
  });
});

describe('reviewFormSentence', () => {
  it('keeps the words of the comment review the worker always posted', () => {
    expect(reviewFormSentence()).toBe(
      'It is posted as a comment because the account that opened a pull request cannot approve or request changes on it; the verdict itself is recorded by the worker.',
    );
  });

  it('never presents an automated approval as one a person or code owner must give', () => {
    const s = reviewFormSentence({ event: 'APPROVE', reviewer: 'updraft[bot]' });
    expect(s).toContain('approval of exactly this commit by `updraft[bot]`');
    expect(s).toContain('only where GitHub itself reports that it does, never in place of a review a person or code owner must give');
    expect(reviewFormSentence({ event: 'REQUEST_CHANGES', reviewer: 'updraft[bot]' })).toContain('queued from the verdict the worker recorded, not from this GitHub review');
  });

  it('says a fallback comment is not an approval, and why', () => {
    expect(reviewFormSentence({ event: 'COMMENT', instead: 'APPROVE', why: 'GitHub refused it as one' })).toBe(
      'It is posted as a comment, not as a GitHub approval, because GitHub refused it as one; the verdict itself is recorded by the worker.',
    );
  });
});
