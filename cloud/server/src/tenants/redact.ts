/**
 * Secret redaction (#70). Key values are write-only: they live in Secrets Manager and in the
 * job's environment, and must not surface in logs served to the browser, error messages or
 * results. Two layers, because a log can carry a key we know and one we do not (a rotated one):
 *
 *   - every value in `known` (the tenant's stored keys), found anywhere, including when a tool
 *     quoted it with separators between characters it cannot split (nothing clever: exact match);
 *   - anything shaped like a provider key (`sk-...`), a bearer token or an `x-api-key` header.
 */

export const REDACTED = '[redacted]';

// sk-ant-..., sk-proj-..., sk-... : at least 16 key characters after the prefix, so prose like
// "sk-8" is left alone.
const KEY_SHAPED = /\bsk-[A-Za-z0-9_-]{16,}/g;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;
const API_KEY_HEADER = /\b((?:x-api-key|api[-_]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;}]{8,}/gi;

/** Values shorter than this are never used as a literal match (they would redact ordinary words). */
const MIN_KNOWN = 8;

export function redact(text: string, known: readonly string[] = []): string {
  let out = text;
  // Longest first, so a value that contains another is replaced whole.
  for (const value of [...known].filter((v) => v.length >= MIN_KNOWN).sort((a, b) => b.length - a.length)) {
    out = out.split(value).join(REDACTED);
  }
  return out.replace(KEY_SHAPED, REDACTED).replace(BEARER, `$1${REDACTED}`).replace(API_KEY_HEADER, `$1${REDACTED}`);
}

/** The message of an error, redacted: what may be logged or returned from a failure. */
export function safeMessage(err: unknown, known: readonly string[] = []): string {
  return redact(err instanceof Error ? err.message : String(err), known);
}
