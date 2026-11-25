// The structured findings of a reviewer run (docs/review-loop.md, "Findings as threads"). Next to
// its prose, the reviewer may write one fenced block,
//
//   ```updraft-findings
//   {"findings": [{"id": "F1", "severity": "blocker", "title": "...", "path": "src/a.ts",
//                  "line": 42, "problem": "...", "suggestion": "..."}],
//    "checks":   [{"finding": "run_abc#F1", "status": "verified", "note": "..."}]}
//   ```
//
// that the worker turns into inline review threads, and into the list the coding agent answers
// finding by finding. The block is optional and never decides anything: the verdict line is read
// by verdict.ts alone, and a message without a block (or with one that cannot be read) is a
// legacy review whose prose is posted as before.
//
// Everything in the block is an agent's text about untrusted code, so it is bounded and checked
// here, and is never trusted for more than it says: a location is only a claim until it is
// matched against the reviewed diff (src/publish/anchors.ts), and a finding is never dropped
// because its location is unusable. It is kept, without the location, with the reason.
export const FINDINGS_BLOCK = 'updraft-findings';

/** At most this many findings are read from one block; the rest are counted, and the prose keeps them. */
export const MAX_STRUCTURED_FINDINGS = 50;
/** At most this many checks of earlier findings. */
export const MAX_FINDING_CHECKS = 50;
const MAX_TITLE = 200;
const MAX_TEXT = 4_000;
const MAX_PATH = 400;
const MAX_LINE = 10_000_000;

export type FindingSeverity = 'blocker' | 'suggestion';

export interface FindingLocation {
  /** Repository-relative, normalized: no leading `./`, no `..`, forward slashes. */
  path: string;
  /** The last (or only) line, on `side`. */
  line: number;
  /** The first line of a range; null for a single line. */
  startLine: number | null;
  /** RIGHT: the line in the reviewed head. LEFT: a line the change removed. */
  side: 'LEFT' | 'RIGHT';
}

export interface StructuredFinding {
  /** Stable within the review: the reviewer's own id, or `F<n>` when it gave none that is usable. */
  id: string;
  severity: FindingSeverity;
  title: string;
  problem: string;
  suggestion: string | null;
  /** A file the finding is about, with or without a usable line. */
  path: string | null;
  /** A usable location, still to be matched against the diff; null when there is none. */
  location: FindingLocation | null;
  /** The key (`<runId>#<id>`) of an earlier finding this one repeats: its thread is reused. */
  sameAs: string | null;
  /** What the worker had to change or leave out, in its own words. */
  notes: string[];
}

export type CheckStatus = 'verified' | 'unresolved';

/** A reviewer's re-check of an earlier finding against the head it reviewed. */
export interface FindingCheck {
  /** `<runId>#<id>` of the earlier finding. */
  finding: string;
  status: CheckStatus;
  note: string;
}

export interface StructuredReview {
  findings: StructuredFinding[];
  checks: FindingCheck[];
  /** Findings or checks beyond the limits, not read. */
  omitted: number;
}

export interface FindingsReading {
  /** The findings text without the block (all of it when the block could not be read). */
  prose: string;
  /** Null when there is no block, or it could not be read. */
  structured: StructuredReview | null;
  /** Why a block that is there could not be read; null otherwise. In the worker's own words. */
  problem: string | null;
}

/** The key of a finding: unique across the reviews of a pull request. */
export function findingKey(runId: string, id: string): string {
  return `${runId}#${id}`;
}

const KEY = /^[A-Za-z0-9_-]{1,80}#[A-Za-z0-9_-]{1,16}$/;
const ID = /^[A-Za-z0-9_-]{1,16}$/;
// CSI/OSC escape sequences and other control characters (except tab and line breaks).
const CONTROL = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function clean(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(CONTROL, '').replace(/\r\n?/g, '\n').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A repository-relative path, or null with why not. */
export function normalizePath(v: unknown): { path: string } | { problem: string } {
  if (typeof v !== 'string' || !v.trim()) return { problem: 'no path' };
  let p = v.trim();
  if (p.length > MAX_PATH) return { problem: 'the path is too long' };
  if (/[\u0000-\u001f\u007f\\]/.test(p)) return { problem: 'the path has characters a repository path does not' };
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return { problem: 'the path is not relative to the repository' };
  while (p.startsWith('./')) p = p.slice(2);
  const parts = p.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return { problem: 'the path is not a plain repository path' };
  return { path: p };
}

const wholeLine = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_LINE ? v : null);

function severityOf(v: unknown): { severity: FindingSeverity; note?: string } {
  if (v === undefined || v === null) return { severity: 'blocker' };
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (s === 'blocker' || s === 'blocking') return { severity: 'blocker' };
  if (s === 'suggestion' || s === 'non-blocking' || s === 'nit' || s === 'minor') return { severity: 'suggestion' };
  // Unknown is a blocker: a finding is never made optional by a typo.
  return { severity: 'blocker', note: 'its severity was not blocker or suggestion, so it is treated as a blocker' };
}

function readFinding(raw: unknown, index: number, taken: Set<string>): StructuredFinding | null {
  if (!isObject(raw)) return null;
  const notes: string[] = [];
  let id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!ID.test(id) || taken.has(id)) {
    const fallback = (n: number) => `F${n}`;
    let n = index + 1;
    while (taken.has(fallback(n))) n++;
    if (raw.id !== undefined) notes.push(`its id was not usable, so it is ${fallback(n)}`);
    id = fallback(n);
  }
  taken.add(id);
  const { severity, note } = severityOf(raw.severity);
  if (note) notes.push(note);
  const problem = clean(raw.problem, MAX_TEXT);
  const title = clean(raw.title, MAX_TITLE) ?? (problem ? clean(problem.split('\n')[0], 80) : null);
  if (!title && !problem) return null;
  let path: string | null = null;
  let location: FindingLocation | null = null;
  if (raw.path !== undefined && raw.path !== null) {
    const p = normalizePath(raw.path);
    if ('problem' in p) notes.push(`its file reference was left out: ${p.problem}`);
    else {
      path = p.path;
      const line = wholeLine(raw.line);
      if (raw.line === undefined || raw.line === null) {
        // A file without a line: a reference, not an anchor.
      } else if (line === null) {
        notes.push('its line was not a line number, so it is not attached to a line');
      } else {
        const start = raw.startLine === undefined || raw.startLine === null ? null : wholeLine(raw.startLine);
        const side = raw.side === undefined || raw.side === null ? 'RIGHT' : raw.side === 'LEFT' || raw.side === 'RIGHT' ? raw.side : null;
        if (side === null) notes.push('its side was not LEFT or RIGHT, so it is not attached to a line');
        else if (raw.startLine !== undefined && raw.startLine !== null && (start === null || start > line)) {
          notes.push('its line range was not a range, so it is not attached to a line');
        } else location = { path: p.path, line, startLine: start !== null && start < line ? start : null, side };
      }
    }
  }
  const sameAs = typeof raw.sameAs === 'string' && KEY.test(raw.sameAs.trim()) ? raw.sameAs.trim() : null;
  if (raw.sameAs !== undefined && raw.sameAs !== null && !sameAs) notes.push('the earlier finding it named is not one this review knows');
  return {
    id,
    severity,
    title: title ?? `Finding ${id}`,
    problem: problem ?? title!,
    suggestion: clean(raw.suggestion, MAX_TEXT),
    path,
    location,
    sameAs,
    notes,
  };
}

function readCheck(raw: unknown): FindingCheck | null {
  if (!isObject(raw)) return null;
  const finding = typeof raw.finding === 'string' ? raw.finding.trim() : '';
  if (!KEY.test(finding)) return null;
  const status = raw.status === 'verified' || raw.status === 'unresolved' ? raw.status : null;
  // A check that is neither is not a verification: it counts as unresolved.
  return { finding, status: status ?? 'unresolved', note: clean(raw.note, MAX_TEXT) ?? '' };
}

/** The fenced blocks tagged updraft-findings: where each starts and ends (line indexes), and its text. */
function blocks(lines: string[]): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,}|~{3,})\s*updraft-findings\s*$/i.exec(lines[i]!);
    if (!open) continue;
    const fence = open[1]!;
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(lines[j]!)) j++;
    out.push({ start: i, end: Math.min(j, lines.length - 1), text: lines.slice(i + 1, j).join('\n') });
    i = j;
  }
  return out;
}

/**
 * The JSON object of a review's one findings block, for readers of fields other than findings and
 * checks (acceptance.ts). `present` is false when there is no block; `data` is null, with why,
 * when there is one that cannot be read. A bare list reads as `{findings: [...]}`.
 */
export function readFindingsBlock(text: string): { present: boolean; data: Record<string, unknown> | null; problem: string | null } {
  const found = blocks(text.replace(/\r\n?/g, '\n').split('\n'));
  if (found.length === 0) return { present: false, data: null, problem: null };
  if (found.length > 1) return { present: true, data: null, problem: `the review has ${found.length} ${FINDINGS_BLOCK} blocks; exactly one is read` };
  let data: unknown;
  try {
    data = JSON.parse(found[0]!.text);
  } catch {
    return { present: true, data: null, problem: `the ${FINDINGS_BLOCK} block is not valid JSON` };
  }
  const obj = Array.isArray(data) ? { findings: data } : data;
  return isObject(obj) ? { present: true, data: obj, problem: null } : { present: true, data: null, problem: `the ${FINDINGS_BLOCK} block is not an object` };
}

/**
 * Read the structured findings from a review's findings text (what parseVerdict left before the
 * verdict line). No block: a legacy review, structured null and no problem. One block that reads:
 * its findings and checks, and the prose without it. Anything else (two blocks, text that is not
 * JSON, no findings or checks list): structured null, the reason, and all of the text as prose.
 */
export function readStructuredFindings(text: string): FindingsReading {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const found = blocks(lines);
  if (found.length === 0) return { prose: text.trim(), structured: null, problem: null };
  if (found.length > 1) return { prose: text.trim(), structured: null, problem: `the review has ${found.length} ${FINDINGS_BLOCK} blocks; exactly one is read` };
  const block = found[0]!;
  let data: unknown;
  try {
    data = JSON.parse(block.text);
  } catch {
    return { prose: text.trim(), structured: null, problem: `the ${FINDINGS_BLOCK} block is not valid JSON` };
  }
  const obj = Array.isArray(data) ? { findings: data } : data;
  if (!isObject(obj) || (obj.findings !== undefined && !Array.isArray(obj.findings)) || (obj.checks !== undefined && !Array.isArray(obj.checks))) {
    return { prose: text.trim(), structured: null, problem: `the ${FINDINGS_BLOCK} block is not a list of findings and checks` };
  }
  const rawFindings = (obj.findings as unknown[] | undefined) ?? [];
  const rawChecks = (obj.checks as unknown[] | undefined) ?? [];
  const taken = new Set<string>();
  const findings: StructuredFinding[] = [];
  let omitted = Math.max(0, rawFindings.length - MAX_STRUCTURED_FINDINGS) + Math.max(0, rawChecks.length - MAX_FINDING_CHECKS);
  rawFindings.slice(0, MAX_STRUCTURED_FINDINGS).forEach((f, i) => {
    const read = readFinding(f, i, taken);
    if (read) findings.push(read);
    else omitted++;
  });
  const checks: FindingCheck[] = [];
  const checked = new Set<string>();
  for (const c of rawChecks.slice(0, MAX_FINDING_CHECKS)) {
    const read = readCheck(c);
    if (!read || checked.has(read.finding)) {
      omitted++;
      continue;
    }
    checked.add(read.finding);
    checks.push(read);
  }
  const prose = [...lines.slice(0, block.start), ...lines.slice(block.end + 1)].join('\n').trim();
  return { prose, structured: { findings, checks, omitted }, problem: null };
}


// ---------------------------------------------------------------------------
// The coding agent's report: one resolution per finding it was given (src/agents/prompt.ts).
//
//   ```updraft-resolutions
//   [{"finding": "run_abc#F1", "status": "fixed", "note": "...", "tests": "npm test: 112 passed"}]
//   ```
//
// A claim about its own work, never a verification: the worker posts it in the finding's thread
// only after the revision's push is confirmed, and the next reviewer checks it on the new head.
// ---------------------------------------------------------------------------

export const RESOLUTIONS_BLOCK = 'updraft-resolutions';
export type ResolutionStatus = 'fixed' | 'disagreed' | 'deferred' | 'unable';
const RESOLUTION_STATUSES: readonly ResolutionStatus[] = ['fixed', 'disagreed', 'deferred', 'unable'];

export interface ResolutionReport {
  finding: string;
  status: ResolutionStatus;
  note: string | null;
  tests: string | null;
}

/** Read the coding agent's resolutions from its final message; [] when there are none, or they cannot be read (with why). */
export function readResolutions(text: string, known: ReadonlySet<string>): { resolutions: ResolutionReport[]; problem: string | null } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,}|~{3,})\s*updraft-resolutions\s*$/i.exec(lines[i]!);
    if (!open) continue;
    const fence = open[1]!;
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(lines[j]!)) j++;
    found.push(lines.slice(i + 1, j).join('\n'));
    i = j;
  }
  if (found.length === 0) return { resolutions: [], problem: `the agent wrote no ${RESOLUTIONS_BLOCK} block` };
  // The last one counts: the agent's final word.
  let data: unknown;
  try {
    data = JSON.parse(found.at(-1)!);
  } catch {
    return { resolutions: [], problem: `the ${RESOLUTIONS_BLOCK} block is not valid JSON` };
  }
  const list = Array.isArray(data) ? data : isObject(data) && Array.isArray(data.resolutions) ? data.resolutions : null;
  if (!list) return { resolutions: [], problem: `the ${RESOLUTIONS_BLOCK} block is not a list` };
  const out: ResolutionReport[] = [];
  const seen = new Set<string>();
  for (const raw of list.slice(0, MAX_STRUCTURED_FINDINGS)) {
    if (!isObject(raw) || typeof raw.finding !== 'string') continue;
    const finding = raw.finding.trim();
    // Only the findings it was given; a report on anything else is not about this revision.
    if (!known.has(finding) || seen.has(finding)) continue;
    const status = RESOLUTION_STATUSES.find((s) => s === raw.status);
    if (!status) continue;
    seen.add(finding);
    out.push({ finding, status, note: clean(raw.note, MAX_TEXT), tests: clean(raw.tests, 1_000) });
  }
  return { resolutions: out, problem: null };
}

/**
 * `text` cut to at most `max` characters, keeping its one findings block whole where it fits: the
 * prose is what is shortened, so a long review keeps its structured findings.
 */
export function capFindings(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const found = blocks(lines);
  if (found.length !== 1) return cut(text, max);
  const b = found[0]!;
  const block = lines.slice(b.start, b.end + 1).join('\n');
  if (block.length > max / 2) return cut(text, max);
  const prose = [...lines.slice(0, b.start), ...lines.slice(b.end + 1)].join('\n').trim();
  return `${cut(prose, max - block.length - 2)}\n\n${block}`;
}
