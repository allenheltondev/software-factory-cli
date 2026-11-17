import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GitHubPullRequestDetail, GitHubPullRequestReview } from '../github/api.js';
import type { Publication } from '../types.js';
import { EXIT } from './errors.js';
import { fakeApi, fakeContext } from './fakes.js';
import { collectReviews, publishedPulls, renderReviews, reviewsCommand } from './reviews.js';

const pubsMock = vi.hoisted(() => ({ current: [] as Publication[] }));
vi.mock('../db/publications.js', () => ({ listRecentPublications: () => pubsMock.current }));

const HEAD = '1111111111111111111111111111111111111111';
const OLD = '2222222222222222222222222222222222222222';

function pub(over: Partial<Publication> = {}): Publication {
  const prNumber = over.prNumber === undefined ? 5 : over.prNumber;
  return {
    runId: `run_${prNumber ?? 'x'}`,
    jobId: 'job_1',
    repoId: 42,
    repoFullName: 'o/r',
    issueNumber: 7,
    mode: 'draft-pr',
    state: 'published',
    branch: 'factory/issue-7-job_1',
    baseBranch: 'main',
    headSha: OLD,
    pushedAt: 't',
    prNumber,
    prUrl: prNumber === null ? null : `https://github.com/o/r/pull/${prNumber}`,
    commentId: 1,
    commentUrl: 'c',
    error: null,
    retryable: false,
    attempts: 1,
    leaseExpiresAt: null,
    nextAttemptAt: null,
    createdAt: 't',
    updatedAt: 't',
    publishedAt: 't',
    ...over,
  };
}

function pull(n: number, headSha: string, over: Partial<GitHubPullRequestDetail> = {}): GitHubPullRequestDetail {
  return {
    number: n,
    htmlUrl: `https://github.com/o/r/pull/${n}`,
    state: 'open',
    draft: true,
    merged: false,
    headRef: `factory/issue-${n}`,
    headRepoId: 42,
    baseRef: 'main',
    body: '',
    headSha,
    ...over,
  };
}

function review(id: number, head: string, blockers: 'yes' | 'no', over: Partial<GitHubPullRequestReview> = {}): GitHubPullRequestReview {
  return {
    id,
    user: 'allen',
    state: 'COMMENTED',
    body: `1. src/a.ts:3 off by one\n\n<!-- factory-review v1\nhead: ${head}\nblockers: ${blockers}\n-->`,
    commitId: head,
    submittedAt: `2026-11-17T1${id}:00:00Z`,
    htmlUrl: `https://github.com/o/r/pull/5#pullrequestreview-${id}`,
    ...over,
  };
}

function scenario() {
  const api = fakeApi({
    pulls: {
      'o/r#5': pull(5, HEAD),
      'o/r#6': pull(6, HEAD, { state: 'closed', merged: true, draft: false }),
      'o/r#7': pull(7, HEAD),
    },
    reviews: {
      'o/r#5': [review(1, OLD, 'no'), review(2, HEAD, 'yes'), review(3, HEAD, 'no', { user: 'mallory' })],
      'o/r#6': [review(4, OLD, 'yes')],
      'o/r#7': [],
    },
  });
  const publications = [
    pub({ prNumber: 5 }),
    pub({ prNumber: 5, runId: 'run_dup' }),
    pub({ prNumber: 6 }),
    pub({ prNumber: 7 }),
    pub({ prNumber: 8 }), // not on GitHub any more
    pub({ prNumber: null, state: 'failed', runId: 'run_failed' }),
    pub({ prNumber: 9, state: 'publishing', runId: 'run_busy' }),
  ];
  return { api, publications };
}

describe('publishedPulls', () => {
  it('keeps published runs with a PR, once per PR, in order', () => {
    expect(publishedPulls(scenario().publications).map((p) => p.prNumber)).toEqual([5, 6, 7, 8]);
  });
});

describe('collectReviews', () => {
  it('reads each published PR and its reviews with GET calls only, and picks the current result', async () => {
    const { api, publications } = scenario();
    const view = await collectReviews({ api, publications, reviewers: ['allen'], limit: 20 });
    expect(api.calls.every((c) => c.startsWith('getPullRequest ') || c.startsWith('listPullRequestReviews '))).toBe(true);
    expect(view.omitted).toBe(0);
    const [p5, p6, p7, p8] = view.pulls;
    expect(p5).toMatchObject({ prNumber: 5, pr: { headSha: HEAD }, result: { status: 'reviewed', review: { reviewId: 2, blockers: true } } });
    expect(p5!.result!.ignored).toEqual([expect.objectContaining({ reviewId: 3, reason: 'mallory is not in review.reviewers' })]);
    expect(p6).toMatchObject({ pr: { merged: true }, result: { status: 'no-review-for-head', latestReviewedSha: OLD } });
    expect(p7).toMatchObject({ result: { status: 'not-reviewed' } });
    expect(p8).toMatchObject({ result: null, error: expect.stringContaining('not found') });
  });

  it('checks at most --limit PRs and counts the rest', async () => {
    const { api, publications } = scenario();
    const view = await collectReviews({ api, publications, reviewers: ['allen'], limit: 1 });
    expect(view.pulls.map((p) => p.prNumber)).toEqual([5]);
    expect(view.omitted).toBe(3);
  });
});

describe('renderReviews', () => {
  it('prints each PR with its head and current review result', async () => {
    const { api, publications } = scenario();
    const text = renderReviews(await collectReviews({ api, publications, reviewers: ['allen'], limit: 20 }));
    expect(text).toContain('Trusted reviewers (review.reviewers): allen');
    expect(text).toContain('o/r#5  open, draft  head 111111111111  (issue #7, run run_5)');
    expect(text).toContain('blockers: yes — reviewed by allen at 2026-11-17T12:00:00Z');
    expect(text).toContain('https://github.com/o/r/pull/5#pullrequestreview-2');
    expect(text).toContain('findings: 24 chars (not sent to any agent)');
    expect(text).toContain('ignored review by mallory: mallory is not in review.reviewers');
    expect(text).toContain('o/r#6  merged  head 111111111111');
    expect(text).toContain('no review for this head (111111111111); latest review covers 222222222222 (blockers: yes,');
    expect(text).toMatch(/o\/r#7 .*\n.*\n {4}not reviewed/);
    expect(text).toMatch(/o\/r#8\s+\(issue #7, run run_8\)\n.*\n {4}error: .*not found/);
  });

  it('says when no reviewer is trusted and when nothing is published', () => {
    expect(renderReviews({ reviewers: [], pulls: [], omitted: 0 })).toBe(
      'Trusted reviewers (review.reviewers): none, so no review result is trusted. See docs/review-result.md.\n\nPublished PRs (0):\n  (none)',
    );
  });
});

describe('reviewsCommand', () => {
  function setup(o: { db?: boolean; reviewers?: string[] } = {}) {
    const { api, publications } = scenario();
    pubsMock.current = publications;
    const ctx = fakeContext({ api });
    mkdirSync(dirname(ctx.paths.configFile), { recursive: true });
    writeFileSync(
      ctx.paths.configFile,
      `version: 1\nreview:\n  reviewers: [${(o.reviewers ?? ['Allen']).join(', ')}]\nagents: {}\npools: {}\nactions: {}\n`,
    );
    const opened: string[] = [];
    if (o.db !== false) {
      mkdirSync(dirname(ctx.paths.dbFile), { recursive: true });
      writeFileSync(ctx.paths.dbFile, '');
    }
    ctx.openDb = (file) => {
      opened.push(file);
      return { close() {} } as never;
    };
    return { ctx, api, opened };
  }

  it('prints JSON with the trusted reviewers from the config, and fails when a PR could not be read', async () => {
    const { ctx, api } = setup();
    const code = await reviewsCommand(ctx, { json: true });
    const view = JSON.parse(ctx.out.text);
    expect(view.reviewers).toEqual(['Allen']);
    expect(view.pulls).toHaveLength(4);
    expect(view.pulls[0].result).toMatchObject({ status: 'reviewed', review: { blockers: true, findings: '1. src/a.ts:3 off by one' } });
    expect(code).toBe(EXIT.FAILURE);
    expect(api.calls.filter((c) => !/^(getPullRequest|listPullRequestReviews) /.test(c))).toEqual([]);
  });

  it('returns OK when every PR was read', async () => {
    const { ctx } = setup();
    expect(await reviewsCommand(ctx, { limit: '3' })).toBe(EXIT.OK);
    expect(ctx.out.text).toContain('Published PRs (3):');
    expect(ctx.out.text).toContain('1 older published PR(s) not checked');
  });

  it('does not create the state DB or call GitHub when there is none', async () => {
    const { ctx, api, opened } = setup({ db: false });
    expect(await reviewsCommand(ctx, {})).toBe(EXIT.OK);
    expect(opened).toEqual([]);
    expect(api.calls).toEqual([]);
    expect(ctx.out.text).toContain('Published PRs (0):');
  });

  it('rejects a bad --limit', async () => {
    const { ctx } = setup();
    await expect(reviewsCommand(ctx, { limit: '0' })).rejects.toMatchObject({ exitCode: EXIT.USAGE });
  });
});
