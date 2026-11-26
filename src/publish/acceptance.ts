// The acceptance checklist of a review on the pull request (docs/acceptance.md): one line per
// criterion with the review's assessment as the worker takes it, the evidence the reviewer cited
// (linked at the reviewed commit), what changed since the previous review of the pull request,
// and why the head is held back. Criterion text is the issue's, and notes and references are an
// agent's: all of it is flattened to one line and made inert (no mentions, HTML, comments or
// closing keywords). Nothing here is read back to decide anything.
import {
  acceptanceChanges,
  assessAcceptance,
  gateReason,
  type AcceptanceAssessment,
  type AcceptanceGate,
  type CriterionAssessment,
  type CriterionStatus,
  type EvidenceRef,
} from '../agents/acceptance.js';
import type { Db } from '../db/database.js';
import { getRun } from '../db/queue.js';
import { code } from './failure-comment.js';
import { cap, inline } from './publish.js';

const MAX_CHECKLIST = 15_000;
const ZWSP = '​';

export const STATUS_WORDS: Record<CriterionStatus, string> = {
  verified: 'Verified',
  unmet: 'Not met',
  unverified: 'Unverified',
  'not-applicable': 'Not applicable',
  'needs-clarification': 'Needs clarification',
};

const CLOSING_KEYWORD = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b(:?\s+|:)(?=(?:[\w.-]+\/[\w.-]+)?#\d|https?:\/\/)/gi;

/** Untrusted text as one inert line. */
export function plain(text: string, max = 300): string {
  return cap(inline(text), max)
    .replace(/</g, '&lt;')
    .replace(/[[\]]/g, (c) => `\\${c}`)
    .replace(CLOSING_KEYWORD, (_m, kw: string, sep: string) => `${kw}${sep}${ZWSP}`);
}

/** The repository's web URL, from the pull request's: same host. Null when the URL is not a pull request's. */
export function repoWebUrl(prUrl: string): string | null {
  const m = /^(https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+)\/pull\/\d+/.exec(prUrl);
  return m ? m[1]! : null;
}

function evidenceText(e: EvidenceRef, repoUrl: string | null, headSha: string): string {
  switch (e.kind) {
    case 'file': {
      const where = `${e.ref}${e.line ? `:${e.line}${e.endLine && e.endLine !== e.line ? `-${e.endLine}` : ''}` : ''}`;
      if (!repoUrl) return code(where);
      const anchor = e.line ? `#L${e.line}${e.endLine && e.endLine !== e.line ? `-L${e.endLine}` : ''}` : '';
      return `[${code(where)}](${repoUrl}/blob/${headSha}/${e.ref.split('/').map((p) => encodeURIComponent(p).replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'))).join('/')}${anchor})`;
    }
    case 'commit':
      return repoUrl ? `[commit ${code(e.ref.slice(0, 12))}](${repoUrl}/commit/${e.ref})` : `commit ${code(e.ref.slice(0, 12))}`;
    case 'link':
      return `[link](${e.ref.replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'))})`;
    case 'test':
      return `test ${code(cap(e.ref, 200))}`;
    case 'check':
      return `check ${code(cap(e.ref, 200))}`;
  }
}

const MARKER = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/;

/**
 * A criterion's text on one line: its first line, then its sub-points as a compact numbered list,
 * "Unit tests cover: (1) ordering; (2) filtering". Inert like any untrusted text.
 */
export function criterionLine(text: string, max = 600): string {
  const [first = '', ...rest] = text.split('\n');
  const points = rest.map((l) => l.replace(MARKER, '').trim()).filter(Boolean);
  if (!points.length) return plain(first, max);
  const list = points.map((p, i) => `(${i + 1}) ${p}${i < points.length - 1 && !/[;,.:]$/.test(p) ? ';' : ''}`).join(' ');
  return plain(`${first.trim()} ${list}`, max);
}

function row(r: CriterionAssessment, repoUrl: string | null, headSha: string): string[] {
  const tags = [
    ...(r.mandatory ? [] : ['optional']),
    ...(r.gate === 'live' ? ['live validation'] : []),
    ...(r.origin === 'inferred' ? ['inferred by the reviewer'] : r.origin === 'steering' ? ['from a change request'] : []),
    ...(r.checkedInSource ? ['ticked in the issue, not evidence'] : []),
    ...(r.context ? [`under: ${plain(r.context, 80)}`] : []),
  ];
  const lines = [`- **${STATUS_WORDS[r.status]}** · ${code(r.id)} · ${criterionLine(r.text)}${tags.length ? ` (${tags.join('; ')})` : ''}`];
  if (r.evidence.length) lines.push(`  - Evidence (the reviewer's references): ${r.evidence.map((e) => evidenceText(e, repoUrl, headSha)).join(', ')}`);
  if (r.note) lines.push(`  - Review agent: ${plain(r.note, 600)}`);
  if (r.claimed && r.claimed !== r.status) lines.push(`  - Updraft: the reviewer called it ${STATUS_WORDS[r.claimed].toLowerCase()}; ${r.notes.map((n) => plain(n, 300)).join('; ')}`);
  else for (const n of r.notes) lines.push(`  - Updraft: ${plain(n, 300)}`);
  return lines;
}

/**
 * The checklist section of a review body. `previous`: the assessment of the PR's previous review,
 * for what changed since; null when there is none.
 */
export function renderAcceptanceChecklist(o: {
  assessment: AcceptanceAssessment;
  gate: AcceptanceGate;
  headSha: string;
  prUrl: string;
  previous: AcceptanceAssessment | null;
}): string {
  const { assessment: a, gate } = o;
  const repoUrl = repoWebUrl(o.prUrl);
  const mandatory = a.rows.filter((r) => r.mandatory);
  const done = mandatory.filter((r) => r.status === 'verified' || r.status === 'not-applicable').length;
  const lines: string[] = [`**Acceptance criteria** · reviewed ${code(o.headSha.slice(0, 12))} · issue revision ${code(a.fingerprint)}`, ''];
  if (!a.rows.length) {
    lines.push(
      a.source === 'none'
        ? 'The issue has no task list or requirements list, and the reviewer named no concrete requirement of it.'
        : 'No acceptance criteria were read from the issue.',
      '',
    );
  } else {
    lines.push(`${done} of ${mandatory.length} mandatory criteria verified (or not applicable) on this commit.`, '');
    for (const r of a.rows) lines.push(...row(r, repoUrl, o.headSha));
    lines.push('');
  }
  if (a.omitted) lines.push(`Updraft: ${a.omitted} more criteria or assessments were beyond what one review carries.`, '');
  if (a.problem) lines.push(`Updraft: ${plain(a.problem)}; every criterion it did not assess counts as unverified.`, '');
  if (o.previous) {
    const { issueChanged, changes } = acceptanceChanges(o.previous, a);
    if (issueChanged) lines.push('The issue changed since the previous review: a criterion whose text changed has a new id and is assessed afresh.', '');
    if (changes.length) {
      lines.push(
        `Since the previous review: ${changes
          .slice(0, 20)
          .map((c) => `${code(c.id)} ${c.before ? STATUS_WORDS[c.before].toLowerCase() : 'new'} → ${c.after ? STATUS_WORDS[c.after].toLowerCase() : 'no longer in the issue'}`)
          .join(', ')}${changes.length > 20 ? `, and ${changes.length - 20} more` : ''}.`,
        '',
      );
    } else if (!issueChanged) lines.push('No criterion changed since the previous review.', '');
  }
  const reason = gateReason(gate);
  if (reason) {
    lines.push(
      a.policy === 'enforce'
        ? `Updraft: this head is not ready while ${reason}. A coding agent's report or a ticked box does not count; a criterion that needs live validation needs a person.`
        : `Updraft: ${reason}. Acceptance is set to report for this repository, so this does not hold the head back.`,
      '',
    );
  }
  return cap(lines.join('\n').trimEnd(), MAX_CHECKLIST);
}

/**
 * The acceptance assessment of the review before `runId` on the same pull request, from its run's
 * recorded result; null when there is none, or it has no acceptance (older runs, a pruned run).
 */
export function previousAssessment(db: Db, o: { repoId: number; prNumber: number; runId: string; createdAt: string }): AcceptanceAssessment | null {
  const prior = db
    .prepare(
      `SELECT run_id FROM pr_reviews WHERE repo_id = ? AND pr_number = ? AND run_id != ? AND created_at <= ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(o.repoId, o.prNumber, o.runId, o.createdAt) as { run_id: string } | undefined;
  if (!prior) return null;
  const result = getRun(db, prior.run_id)?.summary?.review;
  return result?.acceptance ? assessAcceptance(result.acceptance, result.findings) : null;
}

