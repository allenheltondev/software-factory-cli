/**
 * Escalation: a run may *ask* for a more capable tier; a worker-side policy *decides*.
 *
 * The request is data (reason, requested tier, evidence), validated by a strict schema. It never
 * names a pool, an agent, a command or a budget, so nothing a model prints can widen the
 * configured ceiling, hop cap or tier pools; at most it can ask for less than the policy would
 * grant. An escalation is distinct from an ordinary failed run: it is recorded as its own event
 * and moves the job to a stronger pool, where the next attempt runs on a fresh branch and
 * worktree after the failed run has ended (never concurrently in the same worktree).
 *
 * Pure: no I/O.
 */
import { z } from 'zod';
import type { EscalationConfig, TierConfig } from '../config/schema.js';

export const TIERS = ['routine', 'standard', 'complex', 'high-risk'] as const;
export type Tier = (typeof TIERS)[number];
const rank = (t: Tier) => TIERS.indexOf(t);

export const ESCALATION_REASONS = [
  'underestimated-complexity',
  'migration-risk',
  'concurrency-risk',
  'security-risk',
  'verification-failed',
  'other',
] as const;

export const escalationRequestSchema = z.strictObject({
  reason: z.enum(ESCALATION_REASONS),
  requestedTier: z.enum(['standard', 'complex', 'high-risk']),
  evidence: z.string().trim().min(10).max(1000),
});
export type EscalationRequest = z.output<typeof escalationRequestSchema>;

/** The marker an agent prints (one line, JSON after the colon) to request escalation. */
export const ESCALATION_MARKER = 'updraft-escalation:';

export type ParsedRequest = { ok: true; request: EscalationRequest } | { ok: false; problem: string };

/**
 * The agent's escalation request in its output, if it printed one: the last line that starts with
 * the marker. Returns null when there is none. A malformed request is reported, not guessed at.
 */
export function parseEscalationRequest(output: string): ParsedRequest | null {
  let last: string | null = null;
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (line.toLowerCase().startsWith(ESCALATION_MARKER)) last = line.slice(ESCALATION_MARKER.length).trim();
  }
  if (last === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(last);
  } catch {
    return { ok: false, problem: 'the request is not valid JSON' };
  }
  const r = escalationRequestSchema.safeParse(json);
  return r.success ? { ok: true, request: r.data } : { ok: false, problem: r.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ') };
}

export type EscalationSource = 'agent-request' | 'verification-failure';

export type EscalationDecision =
  | { escalate: true; fromTier: Tier; toTier: Tier; pool: string; reason: string }
  | { escalate: false; reason: string };

export interface EscalationInput {
  policy: EscalationConfig | undefined;
  tiers: TierConfig | undefined;
  /** The tier the job runs at now (its routing decision), when it has one. */
  currentTier: Tier | undefined;
  /** Escalations the job already had. */
  hops: number;
  source: EscalationSource;
  request?: EscalationRequest;
  /** The pool has at least one enabled agent. Escalating into a pool nobody can run is refused. */
  poolAvailable: (pool: string) => boolean;
}

/**
 * The worker's own decision. The target tier is what the request asked for (or one tier up for a
 * verification failure), clamped to the ceiling; it must be strictly stronger than the current
 * tier, within the hop cap, and its pool must exist and be runnable. High risk is reachable only
 * with an explicit highRisk pool and ceiling. Nothing here ever lowers a tier.
 */
export function decideEscalation(i: EscalationInput): EscalationDecision {
  const p = i.policy;
  if (!p || !p.enabled || !i.tiers) return { escalate: false, reason: 'escalation is not enabled for this workflow' };
  if (i.source === 'agent-request' && !p.allowAgentRequests) return { escalate: false, reason: 'agent escalation requests are disabled (allowAgentRequests: false)' };
  if (i.source === 'verification-failure' && !p.onVerificationFailure) return { escalate: false, reason: 'escalation after verification failure is disabled' };
  if (!i.currentTier) return { escalate: false, reason: 'the job has no recorded tier to escalate from' };
  if (i.hops >= p.maxHops) return { escalate: false, reason: `the job already escalated ${i.hops} time(s); the cap is ${p.maxHops}` };

  const from = i.currentTier;
  const asked: Tier = i.request?.requestedTier ?? TIERS[Math.min(rank(from) + 1, TIERS.length - 1)]!;
  const ceiling = p.ceiling as Tier;
  const to = rank(asked) > rank(ceiling) ? ceiling : asked;
  const clamp = to !== asked ? ` (requested ${asked}, clamped to the ceiling ${ceiling})` : '';
  if (rank(to) <= rank(from)) return { escalate: false, reason: `no stronger tier is allowed than ${from}: ceiling ${ceiling}${i.request ? `, requested ${asked}` : ''}` };

  const pool = to === 'high-risk' ? i.tiers.highRisk?.pool : i.tiers.pools[to];
  if (!pool) return { escalate: false, reason: `no pool is configured for tier ${to}` };
  if (!i.poolAvailable(pool)) return { escalate: false, reason: `pool "${pool}" for tier ${to} has no enabled agent` };
  return { escalate: true, fromTier: from, toTier: to, pool, reason: `${from} -> ${to}${clamp}` };
}
