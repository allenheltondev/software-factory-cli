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

/** A redactor for these secret values. */
export function createRedactor(known = []) {
  const values = [...new Set(known.filter((v) => typeof v === 'string' && v.length >= MIN_KNOWN))].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text);
    for (const value of values) out = out.split(value).join(REDACTED);
    return out.replace(KEY_SHAPED, REDACTED).replace(BEARER, `$1${REDACTED}`).replace(API_KEY_HEADER, `$1${REDACTED}`);
  };
}

/** The longest a secret is assumed to be: a stream keeps this much back so a value split across chunks is still found. */
export const MAX_SECRET_BYTES = 1024;

/**
 * A text stream that redacts before writing. Output is redacted per line; a line longer than
 * `flushAt` is written in pieces, holding back MAX_SECRET_BYTES so a secret that spans two
 * pieces is still whole in one of them.
 */
export function redactingWriter(write, redact, flushAt = 64 * 1024) {
  let pending = '';
  return {
    write(chunk) {
      pending += chunk;
      const newline = pending.lastIndexOf('\n');
      if (newline !== -1) {
        write(redact(pending.slice(0, newline + 1)));
        pending = pending.slice(newline + 1);
      }
      if (pending.length > flushAt) {
        // Cut where no secret can be split: before the last MAX_SECRET_BYTES, at a space if there is one.
        let cut = pending.length - MAX_SECRET_BYTES;
        const space = pending.lastIndexOf(' ', cut);
        if (space > 0) cut = space + 1;
        write(redact(pending.slice(0, cut)));
        pending = pending.slice(cut);
      }
    },
    end() {
      if (pending !== '') write(redact(pending));
      pending = '';
    },
  };
}
