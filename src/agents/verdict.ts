// The verdict protocol of a reviewer run (repositories.<repo>.review). The review prompt tells
// the reviewer to end its final message with exactly one line,
//
//   UPDRAFT-VERDICT: ready-to-merge      or      UPDRAFT-VERDICT: changes-requested
//
// preceded by its findings. This is the only place that reads it, and it fails closed: a message
// without the line, with two of them (even two that agree), with any other value, or with text
// after the line is not a verdict. Nothing is ever inferred from the findings.
import { REVIEW_VERDICTS, type ReviewVerdict } from '../types.js';

export const VERDICT_TOKEN = 'UPDRAFT-VERDICT';

/** The verdict line for `verdict`, as the reviewer must write it. */
export function verdictLine(verdict: ReviewVerdict): string {
  return `${VERDICT_TOKEN}: ${verdict}`;
}

export type ParsedVerdict =
  | { ok: true; verdict: ReviewVerdict; findings: string }
  /** `problem` is in the worker's own words and safe to show (it quotes nothing of the message). */
  | { ok: false; problem: string };

// CSI/OSC escape sequences and other control characters (except tab and line breaks).
const CONTROL = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** A line with the Markdown decoration a model may wrap around it removed: emphasis, code ticks, a quote or list marker. */
function bare(line: string): string {
  return line
    .trim()
    .replace(/^(?:[>*+-]\s+)+/, '')
    .replace(/^[*_`~\s]+|[*_`~\s]+$/g, '');
}

/**
 * Read the verdict from a reviewer's final message.
 *
 * A verdict line is a line that, once Markdown decoration around it is removed, starts with
 * `UPDRAFT-VERDICT`. There must be exactly one, its value must be exactly one of the two
 * verdicts, and it must be the last non-empty line. Mentions of the token inside a sentence are
 * not verdict lines (the prompt itself contains them). The findings are everything before the line.
 */
export function parseVerdict(message: string): ParsedVerdict {
  const lines = message.replace(CONTROL, '').replace(/\r\n?/g, '\n').split('\n');
  const marked = lines.map((l, i) => ({ i, text: bare(l) })).filter((l) => l.text.toUpperCase().startsWith(VERDICT_TOKEN));
  if (marked.length === 0) return { ok: false, problem: `the reviewer's final message has no ${VERDICT_TOKEN} line` };
  const values = marked.map((l) => /^UPDRAFT-VERDICT\s*:\s*(.*)$/i.exec(l.text)?.[1]?.trim() ?? null);
  if (marked.length > 1) {
    const distinct = new Set(values.map((v) => v?.toLowerCase()));
    return {
      ok: false,
      problem:
        distinct.size > 1
          ? `the reviewer's final message has ${marked.length} ${VERDICT_TOKEN} lines that disagree`
          : `the reviewer's final message has ${marked.length} ${VERDICT_TOKEN} lines; exactly one is required`,
    };
  }
  const value = values[0];
  const verdict = REVIEW_VERDICTS.find((v) => v === value);
  if (!verdict) {
    return { ok: false, problem: `the reviewer's ${VERDICT_TOKEN} line does not name a verdict (${REVIEW_VERDICTS.join(' or ')})` };
  }
  const at = marked[0]!.i;
  if (lines.slice(at + 1).some((l) => l.trim() !== '')) {
    return { ok: false, problem: `the reviewer's final message does not end with its ${VERDICT_TOKEN} line (text follows it)` };
  }
  return { ok: true, verdict, findings: lines.slice(0, at).join('\n').trim() };
}
