import { classifyIssue, type Classification } from './classify.js';
import type { PoolSelector, TierConfig } from './config/schema.js';
import { selectPool, labelEquals } from './routing.js';
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
}

const ORDER: TierName[] = ['routine', 'standard', 'complex', 'high-risk'];

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
  if (!tiers) return { rule: 'default', pool: selectPool(selector, issue.labels) };

  if (typeof selector !== 'string') {
    const have = new Set(issue.labels.map((l) => l.toLowerCase()));
    const rule = selector.rules.find((r) => have.has(r.hasLabel.toLowerCase()));
    if (rule) return { rule: 'legacy-label', detail: `label "${rule.hasLabel}"`, pool: rule.use };
  }

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
    tier = c.risk === 'high' ? 'high-risk' : uncertain ? 'standard' : c.complexity;
    decision = {
      rule: 'heuristic',
      detail: c.reasons.join('; ') + (uncertain ? ` (confidence ${c.confidence.toFixed(2)} below ${min}; standard)` : ''),
      complexity: uncertain ? 'standard' : c.complexity,
      risk: c.risk,
      confidence: c.confidence,
    };
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
  return `tier ${r.tier}${risk}, rule ${r.rule}, pool ${r.pool}`;
}
