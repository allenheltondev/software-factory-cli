import type { PoolSelector } from './config/schema.js';

/**
 * Pick a pool for a job from the issue's labels at enqueue time.
 * The first matching rule wins; otherwise the default. Label matching is
 * case-insensitive, matching GitHub's label semantics.
 */
export function selectPool(selector: PoolSelector, labels: readonly string[]): string {
  if (typeof selector === 'string') return selector;
  const have = new Set(labels.map((l) => l.toLowerCase()));
  for (const rule of selector.rules) {
    if (have.has(rule.hasLabel.toLowerCase())) return rule.use;
  }
  return selector.default;
}

export function labelEquals(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
