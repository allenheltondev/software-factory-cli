import { classifyIssue, type Classification } from './classify.js';
import type { PoolSelector, TierConfig, TriageConfig } from './config/schema.js';
import { selectPool, labelEquals } from './routing.js';
import { cleanText } from './triage/response.js';
import type { TriageOutcome } from './triage/triage.js';
import type { RoutingDecision } from './types.js';

export const DEFAULT_OVERRIDE_LABELS = {
  routine: 'tier:routine',
  standard: 'tier:standard',
  complex: 'tier:complex',
  highRisk: 'tier:high-risk',
} as const;
export const DEFAULT_MIN_CONFIDENCE = 0.6;

type TierName = NonNullable<RoutingDecision['tier']>;

export interface TierDeps {
  /** Does this pool have at least one enabled agent? */
  poolAvailable: (pool: string) => boolean;
  /**
   * The outcome of CLI triage (docs/triage.md) for this issue, when the caller ran it because
   * {@link triageWanted} said so. Absent: the local classifier decides alone. Only the heuristic
   * rule consults it; labels and legacy rules are never second-guessed.
   */
  triage?: TriageOutcome;
}

const ORDER: TierName[] = ['routine', 'standard', 'complex', 'high-risk'];
const rank = (t: TierName) => ORDER.indexOf(t);
const RISKS = ['low', 'medium', 'high'] as const;

/**
 * Should the caller ask the triage CLI about this issue? Only after the local router fell to its
 * heuristic rule (a label or legacy rule already decided otherwise), when it was not already
 * high-risk (triage can only raise, and that is the top tier), and either its confidence was low
 * or the issue carries the explicit request label. Never when triage is absent or disabled.
 */
export function triageWanted(local: RoutingDecision, labels: readonly string[], triage: TriageConfig | undefined): boolean {
  if (!triage?.enabled || local.rule !== 'heuristic' || local.tier === 'high-risk') return false;
  if (triage.onLowConfidence && local.uncertain) return true;
  return labels.some((l) => labelEquals(l, triage.requestLabel));
}

function poolForTier(tiers: TierConfig, tier: TierName): string | undefined {
  return tier === 'high-risk' ? tiers.highRisk?.pool : tiers.pools[tier];
}

/**
 * Choose the pool for a job. Precedence, highest first:
 *   1. legacy `pool.rules` label match (explicit configuration; the only step when tiers is off),
 *   2. a tier override label on the issue (several: the most capable tier wins),
 *   3. the local heuristic classifier (high-risk floor; low confidence means standard).
 * Decided once at enqueue and stored on the job; never recomputed for an existing job.
 */
export function routeJob(
  selector: PoolSelector,
  tiers: TierConfig | undefined,
  issue: { title: string; body: string; labels: readonly string[] },
  deps: TierDeps,
): RoutingDecision {
  if (typeof selector !== 'string') {
    const have = new Set(issue.labels.map((l) => l.toLowerCase()));
    const rule = selector.rules.find((r) => have.has(r.hasLabel.toLowerCase()));
    if (rule) return { rule: 'legacy-label', detail: `label "${rule.hasLabel}"`, pool: rule.use };
  }
  if (!tiers) return { rule: 'default', pool: selectPool(selector, issue.labels) };

  const names = { ...DEFAULT_OVERRIDE_LABELS, ...tiers.overrideLabels };
  const forced = ORDER.filter((t) => {
    const l = t === 'high-risk' ? names.highRisk : names[t];
    return issue.labels.some((x) => labelEquals(x, l));
  });
  let tier: TierName;
  let decision: Omit<RoutingDecision, 'pool' | 'tier'>;
  if (forced.length) {
    tier = forced[forced.length - 1]!;
    decision = { rule: 'override-label', detail: `label for tier ${tier}${forced.length > 1 ? ` (most capable of ${forced.join(', ')})` : ''}` };
  } else {
    const c: Classification = classifyIssue(issue);
    const min = tiers.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    const uncertain = c.confidence < min;
    const localTier: TierName = c.risk === 'high' ? 'high-risk' : uncertain ? 'standard' : c.complexity;
    tier = localTier;
    decision = {
      rule: 'heuristic',
      detail: c.reasons.join('; ') + (uncertain ? ` (confidence ${c.confidence.toFixed(2)} below ${min}; standard)` : ''),
      complexity: uncertain ? 'standard' : c.complexity,
      risk: c.risk,
      confidence: c.confidence,
      uncertain,
    };
    if (deps.triage) {
      const t = deps.triage;
      if (!t.ok) {
        // No usable answer: standard, or the higher tier local policy already requires.
        tier = rank(localTier) >= rank('standard') ? localTier : 'standard';
        decision = {
          ...decision,
          detail: `${decision.detail}; triage unavailable (${t.reason}); using ${tier}`,
          triage: { origin: 'fallback', agent: t.agent, reason: t.reason },
        };
      } else {
        const v = t.verdict;
        const said: TierName = v.risk === 'high' ? 'high-risk' : v.confidence < min ? 'standard' : v.complexity;
        // The hard floor: what local policy already requires. A high-risk signal always; a confident
        // local classification as its own tier. With low local confidence there is no floor, so the
        // agent may pick a cheaper tier. The agent can raise the tier, never go below the floor.
        const floor: TierName = c.risk === 'high' ? 'high-risk' : uncertain ? 'routine' : c.complexity;
        tier = rank(said) >= rank(floor) ? said : floor;
        const conflict = rank(said) < rank(floor) ? `triage said ${said} but local policy requires at least ${floor}` : undefined;
        decision = {
          rule: 'triage',
          detail:
            `triage (${t.agent}, ${t.origin}): complexity ${v.complexity}, risk ${v.risk}, confidence ${v.confidence.toFixed(2)}: ${cleanText(v.explanation, 160)}` +
            (conflict ? `; ${conflict}` : '') +
            `; local: ${decision.detail}`,
          complexity: tier === 'high-risk' ? v.complexity : (tier as 'routine' | 'standard' | 'complex'),
          risk: RISKS.indexOf(v.risk) > RISKS.indexOf(c.risk) ? v.risk : c.risk,
          confidence: v.confidence,
          uncertain,
          triage: {
            origin: t.origin,
            agent: t.agent,
            complexity: v.complexity,
            risk: v.risk,
            confidence: v.confidence,
            reason: cleanText(v.explanation, 160),
            ...(conflict ? { conflict } : {}),
          },
        };
      }
    }
  }

  const pool = poolForTier(tiers, tier);
  if (!pool) {
    return {
      ...decision,
      tier,
      pool: tiers.pools.standard,
      hold: `no pool is configured for tier "${tier}"; a human must decide how to run it (label the issue with a tier override or configure tiers.highRisk)`,
    };
  }
  if (tier === 'high-risk' && !deps.poolAvailable(pool)) {
    return {
      ...decision,
      tier,
      pool,
      hold: `high-risk work needs pool "${pool}", which has no enabled agent; not falling back to a weaker pool`,
    };
  }
  return { ...decision, tier, pool };
}

export function describeRouting(r: RoutingDecision | undefined): string | null {
  if (!r?.tier) return null;
  const risk = r.risk ? `, risk ${r.risk}` : '';
  const triage = r.triage
    ? r.triage.origin === 'fallback'
      ? `, triage unavailable (${r.triage.agent}: ${r.triage.reason}), ${r.tier} used`
      : `, triage ${r.triage.origin} (${r.triage.agent})${r.triage.conflict ? ', local floor kept' : ''}`
    : '';
  return `tier ${r.tier}${risk}, rule ${r.rule}${triage}, pool ${r.pool}`;
}
