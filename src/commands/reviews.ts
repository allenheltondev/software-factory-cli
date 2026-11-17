// `factory reviews`: read-only view of the machine-readable review result (docs/review-result.md)
// for each PR the factory published. Reads the state DB and GitHub; writes nothing anywhere.
import { existsSync } from 'node:fs';
import { loadConfig } from '../config/io.js';
import { listRecentPublications } from '../db/publications.js';
import { GitHubError, type GitHubApi } from '../github/api.js';
import { currentReviewResult, type CurrentReviewResult } from '../review/result.js';
import type { Publication } from '../types.js';
import { createLogger } from '../util/log.js';
import { println, type CommandContext } from './context.js';
import { CliError, describeGitHubError, EXIT } from './errors.js';

export interface ReviewsOptions {
  json?: boolean;
  /** Most recent published PRs to check (each costs two GitHub requests). */
  limit?: string;
}

export const DEFAULT_REVIEWS_LIMIT = 20;
/** How many publications to scan for published PRs. */
const PUBLICATION_SCAN = 1000;

export interface PullReviewView {
  runId: string;
  repoFullName: string;
  repoId: number;
  issueNumber: number;
  prNumber: number;
  prUrl: string | null;
  pr: { state: 'open' | 'closed'; draft: boolean; merged: boolean; headSha: string } | null;
  result: CurrentReviewResult | null;
  /** Why this PR could not be read. */
  error: string | null;
}

export interface ReviewsView {
  /** review.reviewers from the config. */
  reviewers: string[];
  pulls: PullReviewView[];
  /** Published PRs beyond --limit that were not checked. */
  omitted: number;
}

/** Published runs with a PR, newest first, one entry per PR. */
export function publishedPulls(publications: readonly Publication[]): Array<Publication & { prNumber: number }> {
  const seen = new Set<string>();
  const out: Array<Publication & { prNumber: number }> = [];
  for (const p of publications) {
    if (p.state !== 'published' || p.prNumber === null) continue;
    const key = `${p.repoId}#${p.prNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p as Publication & { prNumber: number });
  }
  return out;
}

/** Fetch each PR and its reviews and choose the current review result. GET requests only. */
export async function collectReviews(o: {
  api: GitHubApi;
  publications: readonly Publication[];
  reviewers: string[];
  limit: number;
}): Promise<ReviewsView> {
  const all = publishedPulls(o.publications);
  const pulls: PullReviewView[] = [];
  for (const p of all.slice(0, o.limit)) {
    const repo = { id: p.repoId, fullName: p.repoFullName };
    const view: PullReviewView = {
      runId: p.runId,
      repoFullName: p.repoFullName,
      repoId: p.repoId,
      issueNumber: p.issueNumber,
      prNumber: p.prNumber,
      prUrl: p.prUrl,
      pr: null,
      result: null,
      error: null,
    };
    try {
      const pr = await o.api.getPullRequest(repo, p.prNumber);
      view.prUrl = pr.htmlUrl;
      view.pr = { state: pr.state, draft: pr.draft, merged: pr.merged, headSha: pr.headSha };
      const reviews = await o.api.listPullRequestReviews(repo, p.prNumber);
      view.result = currentReviewResult(reviews, { headSha: pr.headSha, reviewers: o.reviewers });
    } catch (err) {
      view.error = err instanceof GitHubError ? describeGitHubError(err) : err instanceof Error ? err.message : String(err);
    }
    pulls.push(view);
  }
  return { reviewers: o.reviewers, pulls, omitted: Math.max(0, all.length - o.limit) };
}

const short = (sha: string) => sha.slice(0, 12);

function prState(pr: NonNullable<PullReviewView['pr']>): string {
  if (pr.merged) return 'merged';
  if (pr.state === 'closed') return 'closed';
  return pr.draft ? 'open, draft' : 'open';
}

export function renderReviews(v: ReviewsView): string {
  const lines: string[] = [];
  lines.push(
    v.reviewers.length
      ? `Trusted reviewers (review.reviewers): ${v.reviewers.join(', ')}`
      : 'Trusted reviewers (review.reviewers): none, so no review result is trusted. See docs/review-result.md.',
  );
  lines.push('', `Published PRs (${v.pulls.length}):`);
  if (!v.pulls.length) lines.push('  (none)');
  for (const p of v.pulls) {
    const head = p.pr ? `  ${prState(p.pr)}  head ${short(p.pr.headSha)}` : '';
    lines.push(`  ${p.repoFullName}#${p.prNumber}${head}  (issue #${p.issueNumber}, run ${p.runId})`);
    if (p.prUrl) lines.push(`    ${p.prUrl}`);
    if (p.error) {
      lines.push(`    error: ${p.error}`);
      continue;
    }
    const r = p.result!;
    switch (r.status) {
      case 'reviewed': {
        const rv = r.review;
        const size = rv.findings ? `${rv.findings.length} chars${rv.findingsTruncated ? ', truncated' : ''}` : 'none';
        lines.push(`    blockers: ${rv.blockers ? 'yes' : 'no'} — reviewed by ${rv.reviewer} at ${rv.submittedAt}`);
        lines.push(`    ${rv.url}`);
        lines.push(`    findings: ${size} (not sent to any agent)`);
        break;
      }
      case 'no-review-for-head':
        lines.push(
          `    no review for this head (${short(r.headSha)}); latest review covers ${short(r.latestReviewedSha)}` +
            ` (blockers: ${r.latest.blockers ? 'yes' : 'no'}, ${r.latest.url})`,
        );
        break;
      case 'not-reviewed':
        lines.push('    not reviewed');
        break;
    }
    // Only near misses on this head are worth showing: why a review the user expected didn't count.
    const relevant = r.ignored.filter((i) => i.commitId?.toLowerCase() === r.headSha || i.blockHead === r.headSha);
    for (const i of relevant) lines.push(`    ignored review by ${i.reviewer ?? '(deleted user)'}: ${i.reason} (${i.url})`);
  }
  if (v.omitted) lines.push('', `${v.omitted} older published PR(s) not checked; raise --limit to include them.`);
  return lines.join('\n');
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_REVIEWS_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new CliError(`--limit must be a positive whole number, got "${raw}"`, EXIT.USAGE);
  return n;
}

export async function reviewsCommand(ctx: CommandContext, opts: ReviewsOptions = {}): Promise<number> {
  const limit = parseLimit(opts.limit);
  const { config } = loadConfig(ctx.paths.configFile);
  const reviewers = config.review.reviewers;

  // Don't create state as a side effect of looking at it.
  let publications: Publication[] = [];
  if (existsSync(ctx.paths.dbFile)) {
    const db = ctx.openDb(ctx.paths.dbFile);
    try {
      publications = listRecentPublications(db, PUBLICATION_SCAN);
    } finally {
      db.close();
    }
  }

  const view: ReviewsView = publishedPulls(publications).length
    ? await collectReviews({ api: await ctx.createApi({ log: createLogger({ stream: null }) }), publications, reviewers, limit })
    : { reviewers, pulls: [], omitted: 0 };

  if (opts.json) println(ctx.out, JSON.stringify(view, null, 2));
  else println(ctx.out, renderReviews(view));
  return view.pulls.some((p) => p.error) ? EXIT.FAILURE : EXIT.OK;
}
