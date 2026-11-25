// Acceptance criteria (docs/acceptance.md): what the original issue asks for, checked by the
// reviewer criterion by criterion, independently of the coding agent's own account.
//
// 1. extractCriteria reads the criteria from the issue as the run was given it: its task-list
//    items, or, without any, the list items under a heading such as "Acceptance" or
//    "Requirements". Nothing is rewritten: the text is the issue's, trimmed and capped. Each
//    criterion's id comes from its own normalized text, so an edit elsewhere in the issue keeps
//    it, and an edit of the criterion itself makes a new one (an earlier assessment does not carry
//    over). A heuristic marks the criteria that need live evidence (a real deployment, staging,
//    screenshots): it can only make a criterion harder to pass, never easier.
// 2. The coding agent is given the criteria and asked for an `updraft-acceptance` report: a claim
//    per criterion, read by readAcceptanceReport and shown to the reviewer as a claim.
// 3. The reviewer adds a `criteria` list to its `updraft-findings` block: an assessment per
//    criterion with evidence references. assessAcceptance reads it and decides, failing closed:
//    no assessment, an unreadable block, "verified" without a usable evidence reference, or any
//    "verified" of a live gate counts as unverified. A ticked box in the issue is never evidence.
// 4. acceptanceGate says what stands between the head and ready-to-merge: mandatory criteria not
//    met (a revision can fix those) and mandatory criteria unverified or unclear (a person must
//    act). Optional criteria are shown and never block.
//
// Everything here is untrusted text (the issue's, the agents'): bounded, stripped of control
// characters, and never trusted for more than it says.
import { createHash } from 'node:crypto';
import type {
  AcceptanceClaim,
  AcceptanceClaimStatus,
  AcceptanceCriterion,
  AcceptancePolicy,
  AcceptanceReport,
  AcceptanceSnapshot,
  RevisionCriterion,
} from '../types.js';
import { FINDINGS_BLOCK, normalizePath, readFindingsBlock } from './findings.js';

export const ACCEPTANCE_REPORT_BLOCK = 'updraft-acceptance';
/** At most this many criteria are taken from one issue; the rest are counted. */
export const MAX_CRITERIA = 30;
/** At most this many criteria a reviewer may add (inferred from the issue or from authorized steering). */
export const MAX_INFERRED = 10;
/** Evidence references read per assessment. */
export const MAX_EVIDENCE = 8;
/** The row of an issue whose body the review did not have. */
export const UNREAD_ISSUE = 'ISSUE';
/** The row of the criteria beyond MAX_CRITERIA, which no review was given. */
export const UNLISTED_CRITERIA = 'MORE';
const MAX_CRITERION_TEXT = 500;
const MAX_NOTE = 1_500;
const MAX_REF = 300;

// CSI/OSC escape sequences and other control characters (except tab and line breaks).
const CONTROL = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function clean(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(CONTROL, '').replace(/\r\n?/g, '\n').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// 1. Extraction
// ---------------------------------------------------------------------------

const CHECKBOX = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+\[( |x|X)\]\s+(.*)$/;
const BULLET = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
/** A line that is all bold, or a short label ending in a colon: used as a heading by many issues. */
const LABEL = /^\s{0,3}(?:\*\*|__)([^*_].*?)(?:\*\*|__)\s*:?\s*$|^\s{0,3}([A-Z][A-Za-z0-9 /&()-]{2,60}):\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

const OUT_OF_SCOPE = /\b(out of scope|non-goals?|not in scope|won'?t do|not doing)\b/i;
const OPTIONAL_SECTION = /\b(optional|nice[- ]to[- ]haves?|stretch( goals?)?|follow[- ]?ups?|future( work)?|later)\b/i;
const REQUIREMENT_SECTION = /\b(acceptance|criteria|requirements?|definition of done|done when|must|deliverables?|expected (behaviou?r|results?))\b/i;
const OPTIONAL_ITEM = /^\s*(?:\(optional\)|\[optional\]|optional\s*[:-]|nice[- ]to[- ]have\s*[:-]?)|\((?:optional|nice[- ]to[- ]have)\)/i;
// Evidence no agent review can produce on its own: a criterion that asks for something to be
// shown or done on a live system, not one that merely names one ("keep hosted mode working",
// "don't break production deployments" are code criteria). Deliberately narrow phrases: a false
// match only makes a criterion need a person, never pass.
const LIVE_GATE = new RegExp(
  [
    String.raw`\b(?:on|in|against|to) (?:the |a )?staging\b`,
    String.raw`\bstaging (?:pr|pull requests?|runs?|tests?|environment|deploy\w*|validation|evidence|issues?)\b`,
    String.raw`\bhosted (?:runs?|tests?|testing|validation|end-to-end|e2e|jobs?|evidence|acceptance)\b`,
    String.raw`\bscreenshots?\b`,
    String.raw`\bscreen recordings?\b`,
    String.raw`\bmanual(?:ly)? (?:tests?|testing|verif\w*|qa)\b`,
    String.raw`\bmanually (?:check|confirm|test|verify)\w*`,
    String.raw`\breal (?:github )?(?:pr|pull requests?|staging|deployments?|environments?|hosted (?:runs?|jobs?)|end-to-end runs?)\b`,
    String.raw`\b(?:verif\w*|validat\w*|test(?:ed|ing)?|demonstrat\w*|observ\w*|confirm\w*|shown?) (?:on|in|against) (?:production|prod|a real\b|the hosted|a hosted|a deployed)`,
    String.raw`\bdeployed (?:to|on|in) (?:staging|production|prod)\b`,
    String.raw`\blive (?:validation|tests?|testing|runs?)\b`,
  ].join('|'),
  'i',
);
// Checked items of an issue template that are about the report itself, not the change: never
// criteria. Only ticked items, and only these phrasings, so a real criterion is never dropped.
const TEMPLATE_BOILERPLATE =
  /^\s*(?:i\s+(?:have\s+)?(?:searched|read|reviewed|checked|agree|confirm(?:ed)?)\b.*\b(?:existing issues|duplicates?|code of conduct|contributing|documentation|faq|guidelines|terms)\b|i\s+agree to (?:follow )?(?:the|this project's) code of conduct)/i;

/** The text a criterion's id is derived from: case, spacing and Markdown emphasis do not change it. */
function normalized(text: string): string {
  return text.toLowerCase().replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
}

/** The fingerprint of an issue revision: what its criteria were read from. */
export function issueFingerprint(issue: { title: string; body: string | null }): string {
  return sha256(`${issue.title.replace(/\r\n?/g, '\n').trim()}\n\n${(issue.body ?? '').replace(/\r\n?/g, '\n').trim()}`).slice(0, 16);
}

interface Item {
  text: string;
  section: string | null;
  checkbox: boolean;
  checked: boolean;
  optionalSection: boolean;
  outOfScope: boolean;
  requirementSection: boolean;
}

/** The list items of an issue body, outside code blocks and HTML comments, with the heading each is under. */
function listItems(body: string): Item[] {
  const lines = body.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const items: Item[] = [];
  let section: string | null = null;
  let fence: string | null = null;
  let current: { item: Item; indent: number } | null = null;
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      current = null;
      continue;
    }
    const heading = HEADING.exec(line) ?? null;
    const label = heading ? null : LABEL.exec(line);
    if (heading || label) {
      section = clean((heading ? heading[1] : (label![1] ?? label![2]))!.replace(/[*_`]/g, ''), 120);
      current = null;
      continue;
    }
    const box = CHECKBOX.exec(line);
    const bullet = box ? null : BULLET.exec(line);
    if (box || bullet) {
      const text = (box ? box[3] : bullet![2])!.trim();
      const item: Item = {
        text,
        section,
        checkbox: Boolean(box),
        checked: box ? box[2] !== ' ' : false,
        optionalSection: section !== null && OPTIONAL_SECTION.test(section),
        outOfScope: section !== null && OUT_OF_SCOPE.test(section),
        requirementSection: section !== null && REQUIREMENT_SECTION.test(section),
      };
      items.push(item);
      current = { item, indent: (box ? box[1] : bullet![1])!.length };
      continue;
    }
    // A continuation of the item above: indented further than its marker.
    if (current && line.trim() && /^\s+/.test(line) && line.search(/\S/) > current.indent) {
      current.item.text = `${current.item.text} ${line.trim()}`;
      continue;
    }
    if (!line.trim()) continue;
    current = null;
  }
  return items;
}

/**
 * The acceptance criteria of an issue, as the run was given it. `body` null: the body was
 * withheld or not available, and there are no criteria to read (source "unavailable").
 */
export function extractCriteria(issue: { title: string; body: string | null }, policy: AcceptancePolicy = 'enforce'): AcceptanceSnapshot {
  const fingerprint = issueFingerprint(issue);
  if (issue.body === null) return { fingerprint, source: 'unavailable', criteria: [], omitted: 0, policy };
  const items = listItems(issue.body).filter(
    (i) => !i.outOfScope && i.text.replace(/[*_`~\s]/g, '').length > 0 && !(i.checkbox && i.checked && TEMPLATE_BOILERPLATE.test(i.text)),
  );
  const boxes = items.filter((i) => i.checkbox);
  const chosen = boxes.length ? boxes : items.filter((i) => i.requirementSection);
  const source = boxes.length ? 'checklist' : chosen.length ? 'requirements' : 'none';
  const criteria: AcceptanceCriterion[] = [];
  const ids = new Set<string>();
  for (const item of chosen.slice(0, MAX_CRITERIA)) {
    const text = clean(item.text, MAX_CRITERION_TEXT)!;
    const base = `AC-${sha256(normalized(item.text)).slice(0, 8)}`;
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    criteria.push({
      id,
      text,
      section: item.section,
      origin: item.checkbox ? 'checklist' : 'requirement',
      mandatory: !item.optionalSection && !OPTIONAL_ITEM.test(item.text),
      gate: LIVE_GATE.test(item.text) ? 'live' : 'code',
      checkedInSource: item.checked,
    });
  }
  return { fingerprint, source, criteria, omitted: Math.max(0, chosen.length - MAX_CRITERIA), policy };
}

// ---------------------------------------------------------------------------
// 2. The coding agent's report
// ---------------------------------------------------------------------------

const CLAIM_STATUSES: readonly AcceptanceClaimStatus[] = ['implemented', 'partial', 'not-done', 'needs-live-validation'];

/** Read a code run's acceptance report from its final message. Only ids it was given are read; the last block counts. */
export function readAcceptanceReport(text: string, snapshot: AcceptanceSnapshot): { report: AcceptanceReport | null; problem: string | null } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,}|~{3,})\s*updraft-acceptance\s*$/i.exec(lines[i]!);
    if (!open) continue;
    const fence = open[1]!;
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(lines[j]!)) j++;
    found.push(lines.slice(i + 1, j).join('\n'));
    i = j;
  }
  if (!found.length) return { report: null, problem: `the agent wrote no ${ACCEPTANCE_REPORT_BLOCK} block` };
  let data: unknown;
  try {
    data = JSON.parse(found.at(-1)!);
  } catch {
    return { report: null, problem: `the ${ACCEPTANCE_REPORT_BLOCK} block is not valid JSON` };
  }
  const list = Array.isArray(data) ? data : isObject(data) && Array.isArray(data.criteria) ? data.criteria : null;
  if (!list) return { report: null, problem: `the ${ACCEPTANCE_REPORT_BLOCK} block is not a list` };
  const known = new Set(snapshot.criteria.map((c) => c.id));
  const claims: AcceptanceClaim[] = [];
  for (const raw of list.slice(0, MAX_CRITERIA)) {
    if (!isObject(raw) || typeof raw.criterion !== 'string') continue;
    const criterion = raw.criterion.trim();
    if (!known.has(criterion) || claims.some((c) => c.criterion === criterion)) continue;
    const status = CLAIM_STATUSES.find((s) => s === raw.status);
    if (!status) continue;
    claims.push({ criterion, status, evidence: clean(raw.evidence, MAX_NOTE), tests: clean(raw.tests, 1_000) });
  }
  return { report: { fingerprint: snapshot.fingerprint, claims }, problem: null };
}

// ---------------------------------------------------------------------------
// 3. The reviewer's assessments
// ---------------------------------------------------------------------------

export type CriterionStatus = 'verified' | 'unmet' | 'unverified' | 'not-applicable' | 'needs-clarification';
const CRITERION_STATUSES: readonly CriterionStatus[] = ['verified', 'unmet', 'unverified', 'not-applicable', 'needs-clarification'];

export type EvidenceKind = 'file' | 'test' | 'check' | 'commit' | 'link';

/** A reference the reviewer gave. Only its form is checked: that it exists is the reviewer's claim, shown with a link. */
export interface EvidenceRef {
  kind: EvidenceKind;
  /** file: a repository path; commit: the sha; test/check: a name or command; link: an https URL. */
  ref: string;
  /** file only. */
  line: number | null;
  endLine: number | null;
}

/** One criterion as this review leaves it, after the worker's rules. */
export interface CriterionAssessment {
  id: string;
  text: string;
  mandatory: boolean;
  gate: 'code' | 'live';
  /** From the issue (extracted) or added by the reviewer (inferred from the issue or from steering). */
  origin: 'checklist' | 'requirement' | 'inferred' | 'steering';
  checkedInSource: boolean;
  /** What the reviewer said, before the worker's rules; null when it said nothing about it. */
  claimed: CriterionStatus | null;
  status: CriterionStatus;
  evidence: EvidenceRef[];
  note: string | null;
  /** Why the worker changed or left out something of what the reviewer said, in its own words. */
  notes: string[];
}

export interface AcceptanceAssessment {
  fingerprint: string;
  source: AcceptanceSnapshot['source'];
  policy: AcceptancePolicy;
  rows: CriterionAssessment[];
  omitted: number;
  /** Why the reviewer's assessments could not be read at all; null when they could (or there were none to read). */
  problem: string | null;
}

/** One evidence reference, or null when it has no form the worker recognizes. */
export function readEvidence(raw: unknown): EvidenceRef | null {
  let kind: string | null = null;
  let ref: string | null = null;
  if (isObject(raw)) {
    kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : null;
    ref = clean(raw.ref, MAX_REF);
  } else {
    const s = clean(raw, MAX_REF);
    if (!s) return null;
    const m = /^(file|test|check|commit|link)\s*:\s*(.+)$/i.exec(s);
    if (m) {
      kind = m[1]!.toLowerCase();
      ref = m[2]!.trim();
    } else if (/^https:\/\//i.test(s)) {
      kind = 'link';
      ref = s;
    } else if (/^[0-9a-f]{7,40}$/i.test(s)) {
      kind = 'commit';
      ref = s;
    } else if (/^[^\s]+\/[^\s]*$|^[^\s/]+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?$/.test(s)) {
      kind = 'file';
      ref = s;
    }
  }
  if (!kind || !ref) return null;
  switch (kind) {
    case 'commit':
      return /^[0-9a-f]{7,40}$/i.test(ref) ? { kind, ref: ref.toLowerCase(), line: null, endLine: null } : null;
    case 'link':
      return /^https:\/\/[^\s<>"'`]+$/i.test(ref) ? { kind, ref, line: null, endLine: null } : null;
    case 'test':
    case 'check':
      return { kind, ref: ref.replace(/\s+/g, ' '), line: null, endLine: null };
    case 'file': {
      const m = /^(.*?)(?::(\d{1,7})(?:-(\d{1,7}))?)?$/.exec(ref)!;
      const p = normalizePath(m[1]);
      if ('problem' in p) return null;
      const line = m[2] ? Number(m[2]) : null;
      const endLine = m[3] ? Number(m[3]) : null;
      if (line !== null && (line < 1 || (endLine !== null && endLine < line))) return null;
      return { kind, ref: p.path, line, endLine };
    }
    default:
      return null;
  }
}

/**
 * The reviewer's assessment of every criterion, as the worker takes it. `findingsText` is the
 * review's findings (with its block). Every criterion of the snapshot has a row; a reviewer's
 * entry for an id it was not given is ignored unless it adds a criterion (`I<n>`/`S<n>` with text).
 */
export function assessAcceptance(snapshot: AcceptanceSnapshot, findingsText: string): AcceptanceAssessment {
  const block = readFindingsBlock(findingsText);
  let problem: string | null = null;
  let raw: unknown[] = [];
  if (!block.present) problem = `the review has no ${FINDINGS_BLOCK} block with a criteria list`;
  else if (!block.data) problem = block.problem;
  else if (block.data.criteria === undefined) problem = `the ${FINDINGS_BLOCK} block has no criteria list`;
  else if (!Array.isArray(block.data.criteria)) problem = `the criteria of the ${FINDINGS_BLOCK} block are not a list`;
  else raw = block.data.criteria;

  const given = new Map(snapshot.criteria.map((c) => [c.id, c]));
  const said = new Map<string, Record<string, unknown>>();
  const added: { id: string; text: string; origin: 'inferred' | 'steering'; mandatory: boolean; entry: Record<string, unknown> }[] = [];
  let omitted = Math.max(0, raw.length - (MAX_CRITERIA + MAX_INFERRED));
  for (const entry of raw.slice(0, MAX_CRITERIA + MAX_INFERRED)) {
    if (!isObject(entry) || typeof entry.criterion !== 'string') {
      omitted++;
      continue;
    }
    const id = entry.criterion.trim();
    if (given.has(id)) {
      if (said.has(id)) omitted++;
      else said.set(id, entry);
      continue;
    }
    // A criterion the reviewer adds: one it inferred from the issue, or from authorized steering.
    const text = clean(entry.text, MAX_CRITERION_TEXT);
    if (/^[IS]\d{1,2}$/.test(id) && text && added.length < MAX_INFERRED && !added.some((a) => a.id === id)) {
      added.push({ id, text, origin: id.startsWith('S') || entry.basis === 'steering' ? 'steering' : 'inferred', mandatory: entry.optional !== true, entry });
    } else omitted++;
  }

  const rows: CriterionAssessment[] = [];
  const judge = (
    base: Omit<CriterionAssessment, 'claimed' | 'status' | 'evidence' | 'note' | 'notes'>,
    entry: Record<string, unknown> | undefined,
  ): CriterionAssessment => {
    const notes: string[] = [];
    if (!entry) {
      notes.push(problem ? `${problem}, so it is unverified` : 'the reviewer gave no assessment of it, so it is unverified');
      return { ...base, claimed: null, status: 'unverified', evidence: [], note: null, notes };
    }
    const claimed = CRITERION_STATUSES.find((s) => s === entry.status) ?? null;
    const note = clean(entry.note, MAX_NOTE);
    const rawEvidence = Array.isArray(entry.evidence) ? entry.evidence : entry.evidence === undefined || entry.evidence === null ? [] : [entry.evidence];
    const evidence: EvidenceRef[] = [];
    let dropped = 0;
    for (const e of rawEvidence.slice(0, MAX_EVIDENCE)) {
      const read = readEvidence(e);
      if (read) evidence.push(read);
      else dropped++;
    }
    dropped += Math.max(0, rawEvidence.length - MAX_EVIDENCE);
    if (dropped) notes.push(`${dropped} evidence reference(s) had no form the worker recognizes and were left out`);
    let status: CriterionStatus = claimed ?? 'unverified';
    if (!claimed) notes.push('its status was not one of verified, unmet, unverified, not-applicable or needs-clarification, so it is unverified');
    if (status === 'verified' && base.gate === 'live') {
      status = 'unverified';
      notes.push('it needs live evidence (a real deployment, staging run or screenshot), which an agent review cannot provide; a person confirms it');
    } else if (status === 'verified' && !evidence.length) {
      status = 'unverified';
      notes.push('it was called verified without a file, test, check, commit or link reference, so it is unverified');
    } else if (status === 'not-applicable' && !note) {
      status = 'unverified';
      notes.push('it was called not applicable without a reason, so it is unverified');
    }
    return { ...base, claimed, status, evidence, note, notes };
  };
  for (const c of snapshot.criteria) {
    rows.push(
      judge({ id: c.id, text: c.text, mandatory: c.mandatory, gate: c.gate, origin: c.origin, checkedInSource: c.checkedInSource }, said.get(c.id)),
    );
  }
  for (const a of added) {
    const gate = LIVE_GATE.test(a.text) || a.entry.live === true ? 'live' : 'code';
    rows.push(judge({ id: a.id, text: a.text, mandatory: a.mandatory, gate, origin: a.origin, checkedInSource: false }, a.entry));
  }
  if (snapshot.omitted > 0) {
    // Criteria no review was given cannot have been verified by one.
    rows.push({
      id: UNLISTED_CRITERIA,
      text: `${snapshot.omitted} more criteria of the issue`,
      mandatory: true,
      gate: 'code',
      origin: 'requirement',
      checkedInSource: false,
      claimed: null,
      status: 'unverified',
      evidence: [],
      note: null,
      notes: [`the issue lists more than ${MAX_CRITERIA} criteria and these were beyond what one review is given, so they are unverified; a person confirms them, or the issue is split`],
    });
  }
  if (snapshot.source === 'unavailable') {
    // Not knowing what the issue asks for is not the same as it asking for nothing.
    rows.unshift({
      id: UNREAD_ISSUE,
      text: "The issue's requirements",
      mandatory: true,
      gate: 'code',
      origin: 'requirement',
      checkedInSource: false,
      claimed: null,
      status: 'unverified',
      evidence: [],
      note: null,
      notes: ['the issue body was not available to this review (withheld or not readable), so its requirements could not be checked; a person confirms them'],
    });
  }
  // A review that assesses nothing at all on an issue with no criteria has nothing to say: not a problem.
  if (problem && !snapshot.criteria.length) problem = null;
  return { fingerprint: snapshot.fingerprint, source: snapshot.source, policy: snapshot.policy, rows, omitted, problem };
}

// ---------------------------------------------------------------------------
// 4. What stands between the head and ready-to-merge
// ---------------------------------------------------------------------------

export interface AcceptanceGate {
  /** Mandatory criteria the review found not met: a revision can address them. */
  unmet: CriterionAssessment[];
  /** Mandatory criteria unverified or unclear: a person must provide evidence or clarify. */
  pending: CriterionAssessment[];
  /** True when nothing mandatory stands in the way. */
  passed: boolean;
}

export function acceptanceGate(a: AcceptanceAssessment): AcceptanceGate {
  const mandatory = a.rows.filter((r) => r.mandatory);
  const unmet = mandatory.filter((r) => r.status === 'unmet');
  const pending = mandatory.filter((r) => r.status === 'unverified' || r.status === 'needs-clarification');
  return { unmet, pending, passed: !unmet.length && !pending.length };
}

const ids = (rows: readonly CriterionAssessment[]) => (rows.length <= 4 ? rows.map((r) => r.id).join(', ') : `${rows.slice(0, 3).map((r) => r.id).join(', ')} and ${rows.length - 3} more`);

/** Why the gate stands in the way, in the worker's words (it quotes no criterion text); null when it passed. */
export function gateReason(g: AcceptanceGate): string | null {
  if (g.passed) return null;
  const part = (rows: readonly CriterionAssessment[], one: string, many: string) =>
    rows.length ? [`${rows.length} mandatory acceptance ${rows.length === 1 ? `criterion ${one}` : `criteria ${many}`} (${ids(rows)})`] : [];
  return [
    ...part(g.unmet, 'is not met', 'are not met'),
    ...part(g.pending.filter((r) => r.status === 'unverified'), 'is unverified', 'are unverified'),
    ...part(g.pending.filter((r) => r.status === 'needs-clarification'), 'needs clarification', 'need clarification'),
  ].join('; ');
}

/** What a revision is given about the criteria: every mandatory one not verified on the reviewed head. */
export function revisionCriteria(g: AcceptanceGate): RevisionCriterion[] {
  return [...g.unmet, ...g.pending].map((r) => ({
    id: r.id,
    text: r.text,
    status: r.status === 'unmet' ? 'unmet' : r.status === 'needs-clarification' ? 'needs-clarification' : 'unverified',
    gate: r.gate,
    note: r.note,
  }));
}

/** How each criterion changed since an earlier review of the same pull request. */
export interface AcceptanceChange {
  id: string;
  before: CriterionStatus | null;
  after: CriterionStatus | null;
}

export function acceptanceChanges(before: AcceptanceAssessment, after: AcceptanceAssessment): { issueChanged: boolean; changes: AcceptanceChange[] } {
  const was = new Map(before.rows.map((r) => [r.id, r.status]));
  const now = new Map(after.rows.map((r) => [r.id, r.status]));
  const changes: AcceptanceChange[] = [];
  for (const r of after.rows) if (was.get(r.id) !== r.status) changes.push({ id: r.id, before: was.get(r.id) ?? null, after: r.status });
  for (const r of before.rows) if (!now.has(r.id)) changes.push({ id: r.id, before: r.status, after: null });
  return { issueChanged: before.fingerprint !== after.fingerprint, changes };
}
