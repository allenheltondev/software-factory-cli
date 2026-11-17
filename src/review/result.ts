// Machine-readable review results (issue #13). A reviewer posts a GitHub PR review whose body
// carries one hidden block:
//
//   <!-- factory-review v1
//   head: <40-hex SHA the review covers>
//   blockers: yes | no
//   -->
//
// Everything here is pure: no GitHub calls, no state. See docs/review-result.md for the format,
// the trust rules and how the current result for a PR is chosen.
import type { GitHubPullRequestReview } from '../github/api.js';

/** Findings text longer than this is cut (and flagged) before it is exposed. */
export const MAX_FINDINGS_CHARS = 20_000;

export const REVIEW_BLOCK_VERSION = 'v1';

export interface ReviewBlock {
  /** Lowercase 40-hex SHA the reviewer says the review covers. */
  head: string;
  blockers: boolean;
  /** The review body outside the block, trimmed and capped at MAX_FINDINGS_CHARS. */
  findings: string;
  findingsTruncated: boolean;
}

export type ParsedReview =
  /** No factory-review block in the body: an ordinary review. */
  | { kind: 'none' }
  /** A block is there but cannot be used. */
  | { kind: 'invalid'; reason: string }
  | ({ kind: 'block' } & ReviewBlock);

// Any HTML comment whose text starts with "factory-review" (in any case) is treated as an attempt
// at a block, so a near miss is reported as invalid instead of being ignored.
const COMMENT = /<!--([\s\S]*?)-->/g;
const MARKER = /^\s*factory-review(?![A-Za-z0-9_-])/i;
const UNTERMINATED = /<!--\s*factory-review(?![A-Za-z0-9_-])/i;
const HEADER = /^factory-review[ \t]+(\S+)$/;
const KEY_VALUE = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*?)$/;
const SHA = /^[0-9a-f]{40}$/i;

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

function capFindings(text: string): { findings: string; findingsTruncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_FINDINGS_CHARS) return { findings: trimmed, findingsTruncated: false };
  return { findings: trimmed.slice(0, MAX_FINDINGS_CHARS), findingsTruncated: true };
}

function parseBlockText(inner: string): { head: string; blockers: boolean } | { reason: string } {
  const lines = inner
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const header = HEADER.exec(lines[0] ?? '');
  if (!header) return { reason: 'the block must start with "factory-review v1"' };
  if (header[1] !== REVIEW_BLOCK_VERSION) {
    return { reason: `unsupported block version "${header[1]}" (expected "factory-review ${REVIEW_BLOCK_VERSION}")` };
  }
  const values = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const kv = KEY_VALUE.exec(line);
    if (!kv) return { reason: `malformed line "${line.slice(0, 60)}" (expected "key: value")` };
    const key = kv[1]!.toLowerCase();
    if (values.has(key) && (key === 'head' || key === 'blockers')) return { reason: `"${key}" appears more than once` };
    values.set(key, kv[2]!);
  }
  const head = values.get('head');
  if (head === undefined) return { reason: 'missing "head"' };
  if (!SHA.test(head)) return { reason: `"head" must be a full 40-character commit SHA, got "${head.slice(0, 60)}"` };
  const blockers = values.get('blockers');
  if (blockers === undefined) return { reason: 'missing "blockers"' };
  const b = blockers.toLowerCase();
  if (b !== 'yes' && b !== 'no') return { reason: `"blockers" must be yes or no, got "${blockers.slice(0, 60)}"` };
  return { head: head.toLowerCase(), blockers: b === 'yes' };
}

/**
 * Find and parse the factory-review block in a review body. Lenient about whitespace, line
 * endings and the case of keys and values; strict about the version tag, the SHA (40 hex) and
 * `blockers` (yes/no). Unknown keys are ignored. More than one block makes the review invalid.
 */
export function parseReviewBlock(body: string): ParsedReview {
  const text = normalizeNewlines(body ?? '');
  const blocks: Array<{ start: number; end: number; inner: string }> = [];
  for (const m of text.matchAll(COMMENT)) {
    if (MARKER.test(m[1]!)) blocks.push({ start: m.index, end: m.index + m[0].length, inner: m[1]! });
  }
  // A block opened but never closed: the rest of the body would be hidden on GitHub, and the
  // reviewer's intent is unclear.
  const outside = text.replace(COMMENT, '');
  if (UNTERMINATED.test(outside)) return { kind: 'invalid', reason: 'the factory-review block is not closed with "-->"' };
  if (blocks.length === 0) return { kind: 'none' };
  if (blocks.length > 1) return { kind: 'invalid', reason: `found ${blocks.length} factory-review blocks; a review must carry exactly one` };
  const block = blocks[0]!;
  const parsed = parseBlockText(block.inner);
  if ('reason' in parsed) return { kind: 'invalid', reason: parsed.reason };
  return { kind: 'block', ...parsed, ...capFindings(text.slice(0, block.start) + text.slice(block.end)) };
}

/** A review that carried a block but does not count, and why. */
export interface IgnoredReview {
  reviewId: number;
  reviewer: string | null;
  url: string;
  /** The commit GitHub says the review was made on. */
  commitId: string | null;
  /** The head the block claims, when it could be read. */
  blockHead: string | null;
  submittedAt: string | null;
  reason: string;
}

/** A trusted, valid review result. */
export interface TrustedReview {
  reviewId: number;
  reviewer: string;
  url: string;
  submittedAt: string;
  /** Lowercase SHA the review covers (block head, equal to the review's commit_id). */
  head: string;
  blockers: boolean;
  findings: string;
  findingsTruncated: boolean;
}

export type CurrentReviewResult =
  /** The newest trusted, valid review of the PR's current head. */
  | ({ status: 'reviewed'; headSha: string; ignored: IgnoredReview[] } & { review: TrustedReview })
  /** Trusted results exist, but none for the current head (the PR moved on). */
  | { status: 'no-review-for-head'; headSha: string; latestReviewedSha: string; latest: TrustedReview; ignored: IgnoredReview[] }
  /** No trusted, valid result at all. */
  | { status: 'not-reviewed'; headSha: string; ignored: IgnoredReview[] };

export interface CurrentReviewOptions {
  /** The PR's current head SHA, from the API. */
  headSha: string;
  /** Trusted reviewer logins (review.reviewers); compared case-insensitively. Empty trusts nobody. */
  reviewers: readonly string[];
}

function newestFirst(a: GitHubPullRequestReview, b: GitHubPullRequestReview): number {
  return Date.parse(b.submittedAt ?? '') - Date.parse(a.submittedAt ?? '') || b.id - a.id;
}

/**
 * Choose a PR's current review result: the newest trusted, valid review whose head is the PR's
 * current head. A review counts only when it is submitted (not pending or dismissed), its author
 * is in `reviewers`, its block parses, and the block's head equals the review's commit_id.
 * Reviews of older heads are history; the newest of them is reported as the latest reviewed SHA.
 * `ignored` lists, newest first, reviews that carried a block but did not count.
 */
export function currentReviewResult(reviews: readonly GitHubPullRequestReview[], opts: CurrentReviewOptions): CurrentReviewResult {
  const headSha = opts.headSha.toLowerCase();
  const trusted = new Set(opts.reviewers.map((r) => r.toLowerCase()));
  const ignored: IgnoredReview[] = [];
  const valid: TrustedReview[] = [];

  for (const r of [...reviews].sort(newestFirst)) {
    const parsed = parseReviewBlock(r.body);
    if (parsed.kind === 'none') continue;
    const ignore = (reason: string) =>
      ignored.push({
        reviewId: r.id,
        reviewer: r.user,
        url: r.htmlUrl,
        commitId: r.commitId,
        blockHead: parsed.kind === 'block' ? parsed.head : null,
        submittedAt: r.submittedAt,
        reason,
      });
    if (r.state === 'PENDING' || !r.submittedAt) {
      ignore('the review is pending (not submitted)');
      continue;
    }
    if (r.state === 'DISMISSED') {
      ignore('the review was dismissed');
      continue;
    }
    if (!r.user || !trusted.has(r.user.toLowerCase())) {
      ignore(trusted.size ? `${r.user ?? 'the author'} is not in review.reviewers` : 'review.reviewers is empty, so no reviewer is trusted');
      continue;
    }
    if (parsed.kind === 'invalid') {
      ignore(`invalid factory-review block: ${parsed.reason}`);
      continue;
    }
    const commit = r.commitId?.toLowerCase() ?? null;
    if (commit !== parsed.head) {
      ignore(`the block's head ${parsed.head.slice(0, 12)} does not match the commit the review was made on (${commit?.slice(0, 12) ?? 'unknown'})`);
      continue;
    }
    valid.push({
      reviewId: r.id,
      reviewer: r.user,
      url: r.htmlUrl,
      submittedAt: r.submittedAt,
      head: parsed.head,
      blockers: parsed.blockers,
      findings: parsed.findings,
      findingsTruncated: parsed.findingsTruncated,
    });
  }

  const current = valid.find((v) => v.head === headSha);
  if (current) return { status: 'reviewed', headSha, review: current, ignored };
  const latest = valid[0];
  if (latest) return { status: 'no-review-for-head', headSha, latestReviewedSha: latest.head, latest, ignored };
  return { status: 'not-reviewed', headSha, ignored };
}
