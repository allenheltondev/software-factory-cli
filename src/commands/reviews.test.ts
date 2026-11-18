import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, openDatabaseReadOnly, schemaVersion, SCHEMA_VERSION, type Db } from '../db/database.js';
import { listPublishedPulls } from '../db/publications.js';
import type { PullRequestDetails, PullRequestReviewSummary } from '../github/api.js';
import type { Publication } from '../types.js';
import { EXIT } from './errors.js';
import { fakeApi, fakeContext } from './fakes.js';
import { collectReviews, renderReviews, reviewsCommand } from './reviews.js';

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
    branch: 'updraft/issue-7-job_1',
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

function pull(n: number, headSha: string, over: Partial<PullRequestDetails> = {}): PullRequestDetails {
  return {
    number: n,
    nodeId: `PR_${n}`,
    htmlUrl: `https://github.com/o/r/pull/${n}`,
    state: 'open',
    draft: true,
    merged: false,
    headRef: `updraft/issue-${n}`,
    headSha,
    baseRef: 'main',
    mergeable: null,
    mergeableState: 'unknown',
    ...over,
  };
}

function review(id: number, head: string, blockers: 'yes' | 'no', over: Partial<PullRequestReviewSummary> = {}): PullRequestReviewSummary {
  return {
    id,
    user: 'allen',
    state: 'COMMENTED',
    body: `1. src/a.ts:3 off by one\n\n<!-- updraft-review-result v1\nhead: ${head}\nblockers: ${blockers}\n-->`,
    commitId: head,
    submittedAt: `2026-11-17T1${id}:00:00Z`,
    htmlUrl: `https://github.com/o/r/pull/5#pullrequestreview-${id}`,
    ...over,
  };
}

const published = (...prs: number[]) => prs.map((prNumber) => pub({ prNumber }) as Publication & { prNumber: number });

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
  // #8 is published but no longer on GitHub.
  return { api, pulls: published(5, 6, 7, 8) };
}

/** A real state database holding publication rows, written at `at` (ISO), one per call. */
function seed(db: Db, rows: Array<{ pr: number | null; state?: Publication['state']; at: string; run?: string }>) {
  db.prepare(
    `INSERT OR IGNORE INTO jobs (id, repo_id, repo_full_name, workflow_id, event_id, issue_number, action, pool, envelope, status, attempts, created_at, updated_at)
     VALUES ('job_1', 42, 'o/r', 'wf', 'e1', 7, 'implement-issue', 'general', '{}', 'succeeded', 1, 't', 't')`,
  ).run();
  rows.forEach((r, i) => {
    const run = r.run ?? `run_${r.pr ?? 'x'}_${i}`;
    db.prepare(
      `INSERT INTO runs (id, job_id, attempt, pool, agent, worker_id, lease_expires_at, started_at, ended_at, outcome)
       VALUES (?, 'job_1', ?, 'general', 'claude', 'wrk_1', 't', 't', 't', 'succeeded')`,
    ).run(run, i + 1);
    db.prepare(
      `INSERT INTO publications (run_id, job_id, repo_id, repo_full_name, issue_number, mode, state, branch, pr_number, pr_url, created_at, updated_at)
       VALUES (?, 'job_1', 42, 'o/r', 7, 'draft-pr', ?, 'updraft/issue-7-job_1', ?, ?, ?, ?)`,
    ).run(run, r.state ?? 'published', r.pr, r.pr === null ? null : `https://github.com/o/r/pull/${r.pr}`, r.at, r.at);
  });
}

const at = (minute: number) => `2026-11-18T10:${String(minute).padStart(2, '0')}:00.000Z`;

describe('listPublishedPulls', () => {
  it('returns published PRs newest first, once per PR, and counts the same set', () => {
    const db = openDatabase(':memory:');
    seed(db, [
      { pr: 5, at: at(1) },
      { pr: 6, at: at(2) },
      { pr: 5, at: at(3), run: 'run_5_again' }, // a later publication of the same PR
      { pr: null, state: 'failed', at: at(4) },
      { pr: 9, state: 'publishing', at: at(5) },
      { pr: 7, at: at(6) },
    ]);
    const all = listPublishedPulls(db, 20);
    expect(all.pulls.map((p) => [p.prNumber, p.runId])).toEqual([[7, 'run_7_5'], [5, 'run_5_again'], [6, 'run_6_1']]);
    expect(all.total).toBe(3);
    expect(listPublishedPulls(db, 2)).toMatchObject({ pulls: [{ prNumber: 7 }, { prNumber: 5 }], total: 3 });
    db.close();
  });

  it('applies the limit after filtering, so failures and repeats in between never shrink the result', () => {
    const db = openDatabase(':memory:');
    const rows: Parameters<typeof seed>[1] = [];
    // 30 published PRs, then 1,200 newer rows that are not published PRs.
    for (let i = 0; i < 30; i++) rows.push({ pr: 100 + i, at: at(0) });
    for (let i = 0; i < 1200; i++) rows.push({ pr: null, state: 'failed', at: at(30) });
    seed(db, rows);
    const view = listPublishedPulls(db, 25);
    expect(view.pulls).toHaveLength(25);
    expect(view.total).toBe(30);
    db.close();
  });
});

describe('collectReviews', () => {
  it('reads each published PR and its reviews with GET calls only, and picks the current result', async () => {
    const { api, pulls } = scenario();
    const view = await collectReviews({ api, pulls, total: pulls.length, reviewers: ['allen'] });
    expect(api.calls.every((c) => c.startsWith('getPullRequest ') || c.startsWith('listPullRequestReviews '))).toBe(true);
    expect(view.omitted).toBe(0);
    const [p5, p6, p7, p8] = view.pulls;
    expect(p5).toMatchObject({ prNumber: 5, pr: { headSha: HEAD }, result: { status: 'reviewed', review: { reviewId: 2, blockers: true } } });
    expect(p5!.result!.ignored).toEqual([expect.objectContaining({ reviewId: 3, reason: 'mallory is not in review.reviewers' })]);
    expect(p6).toMatchObject({ pr: { merged: true }, result: { status: 'no-review-for-head', latestReviewedSha: OLD } });
    expect(p7).toMatchObject({ result: { status: 'not-reviewed' } });
    expect(p8).toMatchObject({ result: null, error: expect.stringContaining('not found') });
  });

  it('counts the published PRs it was not given as omitted', async () => {
    const { api, pulls } = scenario();
    const view = await collectReviews({ api, pulls: pulls.slice(0, 1), total: 1500, reviewers: ['allen'] });
    expect(view.pulls.map((p) => p.prNumber)).toEqual([5]);
    expect(view.omitted).toBe(1499);
  });
});

describe('renderReviews', () => {
  it('prints each PR with its head and current review result', async () => {
    const { api, pulls } = scenario();
    const text = renderReviews(await collectReviews({ api, pulls, total: pulls.length, reviewers: ['allen'] }));
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
  /** A context with a config, and (unless `db` is false) a real state database at `schema`. */
  function setup(o: { db?: boolean; schema?: number; reviewers?: string[] } = {}) {
    const { api } = scenario();
    const ctx = fakeContext({ api });
    mkdirSync(dirname(ctx.paths.configFile), { recursive: true });
    writeFileSync(
      ctx.paths.configFile,
      `version: 1\nreview:\n  reviewers: [${(o.reviewers ?? ['Allen']).join(', ')}]\nagents: {}\npools: {}\nactions: {}\n`,
    );
    if (o.db !== false) {
      const db = openDatabase(ctx.paths.dbFile, o.schema ? { migrateTo: o.schema } : {});
      if (!o.schema) seed(db, [{ pr: 8, at: at(1), run: 'run_8' }, { pr: 7, at: at(2), run: 'run_7' }, { pr: 6, at: at(3), run: 'run_6' }, { pr: 5, at: at(4), run: 'run_5' }]);
      db.close();
    }
    const opened: string[] = [];
    // The command may only ever use the read-only opener.
    ctx.openDbReadOnly = (file) => {
      opened.push(file);
      return openDatabaseReadOnly(file);
    };
    const credentialsFor: unknown[] = [];
    const create = ctx.createCredentials;
    ctx.createCredentials = (config, opts) => {
      credentialsFor.push(config);
      return create(config, opts);
    };
    const withCredentials: boolean[] = [];
    const createApi = ctx.createApi;
    ctx.createApi = (opts) => {
      withCredentials.push(Boolean(opts?.credentials));
      return createApi(opts);
    };
    return { ctx, api, opened, credentialsFor, withCredentials };
  }

  it('prints JSON with the trusted reviewers from the config, and fails when a PR could not be read', async () => {
    const { ctx, api } = setup();
    const code = await reviewsCommand(ctx, { json: true });
    const view = JSON.parse(ctx.out.text);
    expect(view.reviewers).toEqual(['Allen']);
    expect(view.pulls.map((p: { prNumber: number }) => p.prNumber)).toEqual([5, 6, 7, 8]);
    expect(view.pulls[0].result).toMatchObject({ status: 'reviewed', review: { blockers: true, findings: '1. src/a.ts:3 off by one' } });
    expect(code).toBe(EXIT.FAILURE);
    expect(api.calls.filter((c) => !/^(getPullRequest|listPullRequestReviews) /.test(c))).toEqual([]);
  });

  it('returns OK when every PR was read, and reads GitHub with the worker credentials', async () => {
    const { ctx, credentialsFor, withCredentials } = setup();
    expect(await reviewsCommand(ctx, { limit: '3' })).toBe(EXIT.OK);
    expect(ctx.out.text).toContain('Published PRs (3):');
    expect(ctx.out.text).toContain('1 older published PR(s) not checked');
    // The same credential selection as the worker (the gh account, or github.app when configured).
    expect(credentialsFor).toHaveLength(1);
    expect(withCredentials).toEqual([true]);
  });

  it('opens the database read-only: it is not migrated by being looked at', async () => {
    // An older database that already has publications (v6): readable, and left at v6.
    const { ctx, opened } = setup({ schema: 6 });
    expect(await reviewsCommand(ctx, {})).toBe(EXIT.OK);
    expect(opened).toEqual([ctx.paths.dbFile]);
    expect(ctx.out.text).toContain('Published PRs (0):');
    const after = openDatabaseReadOnly(ctx.paths.dbFile);
    expect(schemaVersion(after)).toBe(6);
    expect(SCHEMA_VERSION).toBeGreaterThan(6);
    after.close();
  });

  it('says how to upgrade a database from before publications, without touching it', async () => {
    const { ctx, api } = setup({ schema: 5 });
    await expect(reviewsCommand(ctx, {})).rejects.toThrow(/schema v5, from before publications were recorded \(v6\).*run "updraft status" once to upgrade it/);
    expect(api.calls).toEqual([]);
    const after = openDatabaseReadOnly(ctx.paths.dbFile);
    expect(schemaVersion(after)).toBe(5);
    after.close();
  });

  it('does not create the state DB or call GitHub when there is none', async () => {
    const { ctx, api, opened } = setup({ db: false });
    expect(await reviewsCommand(ctx, {})).toBe(EXIT.OK);
    expect(opened).toEqual([]);
    expect(existsSync(ctx.paths.dbFile)).toBe(false);
    expect(api.calls).toEqual([]);
    expect(ctx.out.text).toContain('Published PRs (0):');
  });

  it('rejects a bad --limit', async () => {
    const { ctx } = setup();
    await expect(reviewsCommand(ctx, { limit: '0' })).rejects.toMatchObject({ exitCode: EXIT.USAGE });
  });
});
