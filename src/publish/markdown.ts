// Safe Markdown for untrusted agent prose (final messages, review findings).
//
// The text is rendered as GitHub-flavored Markdown, but it is first made unable to cause side
// effects or to pass as the worker's own text:
//   - @mentions and team mentions get a zero-width space after the `@`;
//   - closing keywords ("Closes #1", "Fixes o/r#2", "Resolves <issue URL>") are broken up;
//   - `<!--` gets a zero-width space, so no HTML comment (and no forged updraft marker) exists;
//   - raw HTML outside code is escaped (`<` becomes `&lt;`);
//   - every line is put in a blockquote, so headings, rules and unclosed fences in the text stay
//     inside it and cannot look like a section of the worker's comment.
// Fenced code blocks and inline code spans are kept as they are, apart from `<!--`.
// Text is capped before it is processed, and a fence left open by the cap is closed.

import { cap } from './publish.js';

const ZWSP = '\u200B';

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSING_KEYWORD =
  /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b(:?\s+|:)(?=(?:[\w.-]+\/[\w.-]+)?#\d|https?:\/\/(?:www\.)?github\.com\/)/gi;
const MENTION = /(^|[\s([{>"'*_~,;:!?])@(?=[A-Za-z0-9])/g;
const CODE_SPAN = /(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;

const noComments = (s: string) => s.replace(/<!--/g, `<!${ZWSP}--`).replace(/-->/g, `--${ZWSP}>`);

/** Neutralize one stretch of Markdown prose that contains no code. */
function neutralizeProse(s: string): string {
  return noComments(s)
    .replace(/<(?=[A-Za-z/!?])/g, '&lt;')
    .replace(MENTION, `$1@${ZWSP}`)
    .replace(CLOSING_KEYWORD, (_m, kw: string, sep: string) => `${kw}${sep.replace(/\s+$/, ' ')}${ZWSP}`);
}

/** Neutralize prose, leaving inline code spans alone. */
function neutralizeInline(s: string): string {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(CODE_SPAN)) {
    out += neutralizeProse(s.slice(last, m.index));
    out += noComments(m[0]);
    last = m.index + m[0].length;
  }
  return out + neutralizeProse(s.slice(last));
}

/**
 * Markdown for `text` that is safe to publish inside a worker-generated comment. `max` caps the
 * raw text first, so the size limit never cuts through what this function adds.
 */
export function safeMarkdown(text: string, max: number): string {
  const lines = cap(text.replace(/\r\n?/g, '\n').trim(), max).split('\n');
  const out: string[] = [];
  let prose: string[] = [];
  let fence: { char: string; len: number } | null = null;

  const flush = () => {
    if (prose.length) out.push(...neutralizeInline(prose.join('\n')).split('\n'));
    prose = [];
  };

  for (const line of lines) {
    if (fence) {
      out.push(noComments(line));
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
      flush();
      fence = { char: open[1]![0]!, len: open[1]!.length };
      out.push(noComments(line));
      continue;
    }
    prose.push(line);
  }
  flush();
  // A fence the cap left open is closed here, so nothing after this text is read as code.
  if (fence) out.push(fence.char.repeat(fence.len));
  return out.map((l) => (l ? `> ${l}` : '>')).join('\n');
}
