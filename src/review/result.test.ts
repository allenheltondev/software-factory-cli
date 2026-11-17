import { describe, expect, it } from 'vitest';
import type { GitHubPullRequestReview } from '../github/api.js';
import { currentReviewResult, MAX_FINDINGS_CHARS, parseReviewBlock } from './result.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = '0123456789abcdef0123456789abcdef01234567';
const SHA_C = 'c'.repeat(40);

const block = (head: string, blockers: string, extra = '') => `<!-- factory-review v1\nhead: ${head}\nblockers: ${blockers}\n${extra}-->`;

let nextId = 1;
function review(over: Partial<GitHubPullRequestReview> & { head?: string; blockers?: string } = {}): GitHubPullRequestReview {
  const { head = SHA_A, blockers = 'no', ...rest } = over;
  const id = rest.id ?? nextId++;
  return {
    id,
    user: 'allen',
    state: 'COMMENTED',
    body: `Looks fine.\n\n${block(head, blockers)}`,
    commitId: head,
    submittedAt: '2026-11-17T10:00:00Z',
    htmlUrl: `https://github.com/o/r/pull/5#pullrequestreview-${id}`,
    ...rest,
  };
}

describe('parseReviewBlock', () => {
  it('reads blockers: no and blockers: yes, and keeps the findings outside the block', () => {
    const no = parseReviewBlock(`## Review\n\nNo issues found.\n\n${block(SHA_B, 'no')}\n`);
    expect(no).toEqual({ kind: 'block', head: SHA_B, blockers: false, findings: '## Review\n\nNo issues found.', findingsTruncated: false });
    const yes = parseReviewBlock(`${block(SHA_B, 'yes')}\n1. src/a.ts:10 null deref`);
    expect(yes).toMatchObject({ kind: 'block', blockers: true, findings: '1. src/a.ts:10 null deref' });
  });

  it('returns none for an ordinary review and for unrelated HTML comments', () => {
    expect(parseReviewBlock('')).toEqual({ kind: 'none' });
    expect(parseReviewBlock('LGTM <!-- factory-run: run_1 --> <!-- some note -->')).toEqual({ kind: 'none' });
    expect(parseReviewBlock('<!-- factory-reviewer v1 -->')).toEqual({ kind: 'none' });
  });

  it('accepts CRLF, extra whitespace, a one-line header, upper-case keys and values, and ignores unknown keys', () => {
    const body = `Findings\r\n\r\n<!--   factory-review   v1\r\n\r\n  HEAD :   ${SHA_B.toUpperCase()}  \r\nBlockers:YES\r\nsummary: two nits\r\n-->\r\n`;
    expect(parseReviewBlock(body)).toEqual({ kind: 'block', head: SHA_B, blockers: true, findings: 'Findings', findingsTruncated: false });
    expect(parseReviewBlock(`<!--\nfactory-review v1\nhead: ${SHA_B}\nblockers: no -->`)).toMatchObject({ kind: 'block', blockers: false });
  });

  it('is strict about the version tag', () => {
    expect(parseReviewBlock(`<!-- factory-review v2\nhead: ${SHA_B}\nblockers: no\n-->`)).toEqual({
      kind: 'invalid',
      reason: 'unsupported block version "v2" (expected "factory-review v1")',
    });
    expect(parseReviewBlock(`<!-- factory-review V1\nhead: ${SHA_B}\nblockers: no\n-->`)).toMatchObject({ kind: 'invalid' });
    expect(parseReviewBlock(`<!-- factory-review\nhead: ${SHA_B}\nblockers: no\n-->`)).toMatchObject({
      kind: 'invalid',
      reason: expect.stringContaining('must start with "factory-review v1"'),
    });
    expect(parseReviewBlock(`<!-- Factory-Review v1\nhead: ${SHA_B}\nblockers: no\n-->`)).toMatchObject({ kind: 'invalid' });
  });

  it('is strict about the SHA and blockers', () => {
    for (const head of [SHA_B.slice(0, 12), `${SHA_B}0`, 'g'.repeat(40), '', '<sha>']) {
      expect(parseReviewBlock(block(head, 'no'))).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/head/) });
    }
    for (const b of ['maybe', 'true', '0', '']) {
      expect(parseReviewBlock(block(SHA_B, b))).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/blockers/) });
    }
    expect(parseReviewBlock(`<!-- factory-review v1\nblockers: no\n-->`)).toMatchObject({ kind: 'invalid', reason: 'missing "head"' });
    expect(parseReviewBlock(`<!-- factory-review v1\nhead: ${SHA_B}\n-->`)).toMatchObject({ kind: 'invalid', reason: 'missing "blockers"' });
    expect(parseReviewBlock(block(SHA_B, 'no', `head: ${SHA_A}\n`))).toMatchObject({ kind: 'invalid', reason: '"head" appears more than once' });
    expect(parseReviewBlock(block(SHA_B, 'no', 'this is prose\n'))).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('malformed line') });
  });

  it('rejects several blocks in one review, and an unterminated block', () => {
    expect(parseReviewBlock(`${block(SHA_B, 'no')}\n${block(SHA_B, 'no')}`)).toEqual({
      kind: 'invalid',
      reason: 'found 2 factory-review blocks; a review must carry exactly one',
    });
    expect(parseReviewBlock(`${block(SHA_B, 'no')}\n<!-- factory-review v2 -->`)).toMatchObject({ kind: 'invalid' });
    expect(parseReviewBlock(`text\n<!-- factory-review v1\nhead: ${SHA_B}\nblockers: no\n`)).toMatchObject({
      kind: 'invalid',
      reason: expect.stringContaining('not closed'),
    });
  });

  it('caps the findings', () => {
    const r = parseReviewBlock(`${'x'.repeat(MAX_FINDINGS_CHARS + 50)}\n${block(SHA_B, 'yes')}`);
    expect(r).toMatchObject({ kind: 'block', findingsTruncated: true });
    expect(r.kind === 'block' && r.findings.length).toBe(MAX_FINDINGS_CHARS);
  });
});

describe('currentReviewResult', () => {
  const opts = { headSha: SHA_A, reviewers: ['Allen'] };

  it('returns the trusted review of the current head', () => {
    const r = review({ id: 10, blockers: 'yes', body: `1. bug\n\n${block(SHA_A, 'yes')}` });
    expect(currentReviewResult([r], opts)).toEqual({
      status: 'reviewed',
      headSha: SHA_A,
      ignored: [],
      review: {
        reviewId: 10,
        reviewer: 'allen',
        url: r.htmlUrl,
        submittedAt: r.submittedAt,
        head: SHA_A,
        blockers: true,
        findings: '1. bug',
        findingsTruncated: false,
      },
    });
  });

  it('compares reviewer logins and SHAs case-insensitively', () => {
    const r = review({ user: 'ALLEN', commitId: SHA_B.toUpperCase(), head: SHA_B });
    expect(currentReviewResult([r], { headSha: SHA_B.toUpperCase(), reviewers: ['allen'] })).toMatchObject({ status: 'reviewed' });
  });

  it('lets the newest trusted review of the head win, by submission time', () => {
    const older = review({ id: 30, blockers: 'yes', submittedAt: '2026-11-17T10:00:00Z' });
    const newer = review({ id: 20, blockers: 'no', submittedAt: '2026-11-17T11:00:00Z' });
    const untrustedNewest = review({ id: 40, user: 'mallory', blockers: 'no', submittedAt: '2026-11-17T12:00:00Z' });
    const result = currentReviewResult([older, newer, untrustedNewest], { headSha: SHA_A, reviewers: ['allen', 'bot'] });
    expect(result).toMatchObject({ status: 'reviewed', review: { reviewId: 20, blockers: false } });
    expect(result.ignored).toEqual([expect.objectContaining({ reviewId: 40, reason: 'mallory is not in review.reviewers' })]);
    // Same second: the larger id is newer.
    const a = review({ id: 1, blockers: 'yes' });
    const b = review({ id: 2, blockers: 'no' });
    expect(currentReviewResult([b, a], opts)).toMatchObject({ review: { reviewId: 2 } });
  });

  it('does not trust anyone when review.reviewers is empty, or an author who is not listed', () => {
    const r = review();
    expect(currentReviewResult([r], { headSha: SHA_A, reviewers: [] })).toMatchObject({
      status: 'not-reviewed',
      ignored: [{ reason: 'review.reviewers is empty, so no reviewer is trusted' }],
    });
    expect(currentReviewResult([review({ user: 'someone-else' })], opts)).toMatchObject({
      status: 'not-reviewed',
      ignored: [{ reason: 'someone-else is not in review.reviewers' }],
    });
    expect(currentReviewResult([review({ user: null })], opts)).toMatchObject({ status: 'not-reviewed', ignored: [{ reviewer: null }] });
  });

  it('reports a block whose head does not match the review commit_id as invalid', () => {
    const r = review({ head: SHA_A, commitId: SHA_B });
    const result = currentReviewResult([r], opts);
    expect(result).toMatchObject({ status: 'not-reviewed' });
    expect(result.ignored).toEqual([
      expect.objectContaining({ blockHead: SHA_A, commitId: SHA_B, reason: expect.stringContaining('does not match the commit the review was made on') }),
    ]);
    expect(currentReviewResult([review({ commitId: null })], opts)).toMatchObject({ status: 'not-reviewed' });
  });

  it('reports invalid blocks from trusted reviewers and skips reviews without a block', () => {
    const plain = review({ body: 'just a comment' });
    const two = review({ body: `${block(SHA_A, 'no')}${block(SHA_A, 'no')}` });
    const result = currentReviewResult([plain, two], opts);
    expect(result.status).toBe('not-reviewed');
    expect(result.ignored).toEqual([expect.objectContaining({ reviewId: two.id, reason: expect.stringContaining('invalid factory-review block: found 2') })]);
  });

  it('ignores pending and dismissed reviews', () => {
    const pending = review({ state: 'PENDING', submittedAt: null });
    const dismissed = review({ state: 'DISMISSED' });
    const result = currentReviewResult([pending, dismissed], opts);
    expect(result.status).toBe('not-reviewed');
    expect(result.ignored.map((i) => i.reason).sort()).toEqual(['the review is pending (not submitted)', 'the review was dismissed']);
  });

  it('counts COMMENTED, APPROVED and CHANGES_REQUESTED alike: the block decides blockers', () => {
    expect(currentReviewResult([review({ state: 'APPROVED', blockers: 'yes' })], opts)).toMatchObject({ review: { blockers: true } });
    expect(currentReviewResult([review({ state: 'CHANGES_REQUESTED', blockers: 'no' })], opts)).toMatchObject({ review: { blockers: false } });
  });

  it('reports no review for the current head and names the latest reviewed SHA', () => {
    const old1 = review({ head: SHA_B, submittedAt: '2026-11-17T09:00:00Z' });
    const old2 = review({ head: SHA_C, submittedAt: '2026-11-17T10:00:00Z', blockers: 'yes' });
    expect(currentReviewResult([old1, old2], opts)).toMatchObject({
      status: 'no-review-for-head',
      headSha: SHA_A,
      latestReviewedSha: SHA_C,
      latest: { blockers: true },
    });
    expect(currentReviewResult([], opts)).toEqual({ status: 'not-reviewed', headSha: SHA_A, ignored: [] });
  });
});
