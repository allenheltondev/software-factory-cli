// Secret redaction for everything the runner forwards or keeps (#70): the job's stdout and
// stderr (the microVM log stream), the logs uploaded to S3, and the result document. The keys
// the runner loaded for this job are removed wherever they appear, and so is anything shaped
// like a provider key, a bearer token or an API-key header (a key we did not load, or one a
// tool printed in part). Mirrors cloud/server/src/tenants/redact.ts.

export const REDACTED = '[redacted]';

const KEY_SHAPED = /\bsk-[A-Za-z0-9_-]{16,}/g;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;
const API_KEY_HEADER = /\b((?:x-api-key|api[-_]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;}]{8,}/gi;
/** Shorter values are never matched literally (they would redact ordinary words). */
const MIN_KNOWN = 8;

/**
 * A redactor for these secret values: a function from text to redacted text. Its `spans` gives
 * where in a text each thing it redacts starts and ends (before redaction), for a stream that
 * must not cut through one.
 */
export function createRedactor(known = []) {
  const values = [...new Set(known.filter((v) => typeof v === 'string' && v.length >= MIN_KNOWN))].sort((a, b) => b.length - a.length);
  const redact = (text) => {
    let out = String(text);
    for (const value of values) out = out.split(value).join(REDACTED);
    return out.replace(KEY_SHAPED, REDACTED).replace(BEARER, `$1${REDACTED}`).replace(API_KEY_HEADER, `$1${REDACTED}`);
  };
  redact.spans = (text) => {
    const spans = [];
    for (const value of values) for (let i = text.indexOf(value); i !== -1; i = text.indexOf(value, i + 1)) spans.push([i, i + value.length]);
    for (const re of [KEY_SHAPED, BEARER, API_KEY_HEADER]) for (const m of text.matchAll(new RegExp(re.source, re.flags))) spans.push([m.index, m.index + m[0].length]);
    return spans;
  };
  return redact;
}

/** The longest a secret is assumed to be: a stream keeps this much back so a value split across chunks is still found. */
export const MAX_SECRET_BYTES = 1024;

/** What ends a token the redactor matched: whitespace, a quote, a comma, a semicolon or a brace. */
const TOKEN_END = /[\s"',;}]/;

/**
 * A text stream that redacts before writing. Output is redacted per line; a line longer than
 * `flushAt` is written in pieces. A piece ends where no secret can be cut: at least
 * MAX_SECRET_BYTES before the end of what has arrived (a secret still arriving is in that
 * part), and before anything the redactor would match across the cut (a known key, or a
 * key-shaped token that may still be growing). The piece and the rest are then redacted
 * separately, and neither holds part of a secret the other completes.
 *
 * Bounded: a match already longer than MAX_SECRET_BYTES is no key we know, and holding it back
 * could hold everything after it. It is written as one "[redacted]", and if it is still growing
 * at the end of what has arrived, what follows is dropped until the token ends. So at most about
 * `flushAt` characters are ever held, whatever the job writes.
 */
export function redactingWriter(write, redact, flushAt = 64 * 1024) {
  let pending = '';
  let skipping = false;
  const spansOf = (text) => (redact.spans ? redact.spans(text) : []);
  return {
    write(chunk) {
      if (skipping) {
        const end = chunk.search(TOKEN_END);
        if (end === -1) return;
        chunk = chunk.slice(end);
        skipping = false;
      }
      pending += chunk;
      const newline = pending.lastIndexOf('\n');
      if (newline !== -1) {
        write(redact(pending.slice(0, newline + 1)));
        pending = pending.slice(newline + 1);
      }
      while (pending.length > flushAt) {
        const spans = spansOf(pending);
        let cut = pending.length - MAX_SECRET_BYTES;
        const crossing = spans.filter(([start, end]) => start < cut && end > cut);
        const overlong = crossing.find(([start, end]) => end - start > MAX_SECRET_BYTES);
        if (overlong) {
          // From the earliest start of anything overlapping it, so no other match is cut.
          let start = Math.min(...crossing.map(([s0]) => s0));
          for (let moved = true; moved; ) {
            moved = false;
            for (const [s0, e0] of spans) {
              if (s0 < start && e0 > start) {
                start = s0;
                moved = true;
              }
            }
          }
          const end = Math.max(...spans.filter(([s0]) => s0 >= start && s0 < cut).map(([, e0]) => e0));
          write(`${redact(pending.slice(0, start))}${REDACTED}`);
          if (end >= pending.length) {
            skipping = true;
            pending = '';
          } else pending = pending.slice(end);
          continue;
        }
        for (let moved = true; moved; ) {
          moved = false;
          for (const [start, end] of spans) {
            if (start < cut && end > cut) {
              cut = start;
              moved = true;
            }
          }
        }
        if (cut <= 0) break;
        write(redact(pending.slice(0, cut)));
        pending = pending.slice(cut);
      }
    },
    end() {
      if (pending !== '') write(redact(pending));
      pending = '';
      skipping = false;
    },
  };
}
