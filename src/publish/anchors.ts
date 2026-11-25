// Where a reviewer's finding may be attached as an inline comment (docs/review-loop.md, "Findings
// as threads"). GitHub takes a review comment only on a line of the pull request's diff: a line
// the change added or kept as context (RIGHT, the head's numbering) or removed or kept (LEFT, the
// base's numbering), and a range only within one hunk. The reviewer's location is a claim; it is
// used only when the diff of the reviewed head has that line. Nothing is guessed: a finding whose
// line is not in the diff is not attached anywhere, and goes in the review's summary instead.
import type { FindingLocation, StructuredFinding } from '../agents/findings.js';
import type { PullRequestFile } from '../github/api.js';

export interface CommentableLines {
  /** Line number on that side -> the hunk it is in. */
  right: Map<number, number>;
  left: Map<number, number>;
}

/** The lines of a unified diff patch a review comment can be put on, by side. */
export function commentableLines(patch: string): CommentableLines {
  const right = new Map<number, number>();
  const left = new Map<number, number>();
  let hunk = -1;
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.replace(/\r\n?/g, '\n').split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      hunk++;
      oldLine = Number(h[1]);
      newLine = Number(h[2]);
      continue;
    }
    if (hunk < 0) continue;
    if (line.startsWith('+')) right.set(newLine++, hunk);
    else if (line.startsWith('-')) left.set(oldLine++, hunk);
    else if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    else {
      right.set(newLine++, hunk);
      left.set(oldLine++, hunk);
    }
  }
  return { right, left };
}

export type Anchor = { ok: true; location: FindingLocation } | { ok: false; reason: string };

/** The diff of a pull request, by path, ready to anchor findings in. */
export function diffIndex(files: readonly PullRequestFile[]): Map<string, CommentableLines | null> {
  const out = new Map<string, CommentableLines | null>();
  for (const f of files) out.set(f.path, f.patch === null ? null : commentableLines(f.patch));
  return out;
}

/** Whether `finding` can be an inline comment on this diff, and why not. */
export function anchorFinding(finding: StructuredFinding, diff: Map<string, CommentableLines | null>): Anchor {
  const loc = finding.location;
  if (!loc) return { ok: false, reason: finding.path ? 'no line in the diff was given' : 'no file was given' };
  if (!diff.has(loc.path)) return { ok: false, reason: 'the file is not part of this pull request\'s change' };
  const lines = diff.get(loc.path);
  if (!lines) return { ok: false, reason: 'GitHub shows no diff for this file (binary or too large)' };
  const side = loc.side === 'LEFT' ? lines.left : lines.right;
  const end = side.get(loc.line);
  if (end === undefined) return { ok: false, reason: `line ${loc.line} is not in the diff of this file` };
  if (loc.startLine !== null) {
    const start = side.get(loc.startLine);
    if (start === undefined || start !== end) return { ok: false, reason: `lines ${loc.startLine}-${loc.line} are not in one part of the diff of this file` };
  }
  return { ok: true, location: loc };
}
