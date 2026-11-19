/**
 * The triage agent's reply: a strict, schema-validated JSON verdict. Anything else (extra keys
 * such as a claimed `tier` or `pool`, prose around the JSON, a wrong enum, an oversized reply) is
 * rejected as a whole; there is no partial acceptance. The verdict is advice to the router, which
 * can only raise a tier from it (src/tier-routing.ts), never lower a policy floor.
 */
import { z } from 'zod';

export const verdictSchema = z.strictObject({
  complexity: z.enum(['routine', 'standard', 'complex']),
  risk: z.enum(['low', 'medium', 'high']),
  /** 0..1: how sure the agent is of `complexity`. */
  confidence: z.number().min(0).max(1),
  explanation: z.string().trim().min(1).max(500),
  evidence: z.array(z.string().max(300)).max(5).optional(),
});

export type TriageVerdict = z.output<typeof verdictSchema>;

export type ParsedVerdict = { ok: true; verdict: TriageVerdict } | { ok: false; reason: string };

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** One-line, bounded text safe to print: control characters (and ANSI sequences) removed. */
export function cleanText(s: string, max = 200): string {
  const t = s.replace(ANSI, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Parse the agent's final message. Accepted: the JSON object alone, or the object alone inside one
 * fenced block. `maxBytes` bounds the message (UTF-8 bytes).
 */
export function parseTriageResponse(message: string, maxBytes: number): ParsedVerdict {
  if (Buffer.byteLength(message, 'utf8') > maxBytes) return { ok: false, reason: `reply is larger than ${maxBytes} bytes` };
  let text = message.replace(ANSI, '').trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  if (fenced) text = fenced[1]!.trim();
  if (!text.startsWith('{')) return { ok: false, reason: 'reply is not a JSON object' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'reply is not valid JSON' };
  }
  const parsed = verdictSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join('.') : 'reply';
    return { ok: false, reason: `reply does not match the schema (${cleanText(`${where}: ${issue?.message ?? 'invalid'}`, 120)})` };
  }
  return { ok: true, verdict: parsed.data };
}
