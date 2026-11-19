// Local, deterministic issue classifier for tier routing. No network, no model, no tokens.
// Output is a routing hint, not a quality guarantee. Issue text is untrusted: it can only ever
// push work toward MORE capable pools (risk floors); nothing in it can select a cheaper pool
// over a conflicting signal. Only labels (set by people with triage access) and configuration
// can force a tier.

export type Complexity = 'routine' | 'standard' | 'complex';
export type Risk = 'low' | 'medium' | 'high';

export interface Classification {
  complexity: Complexity;
  risk: Risk;
  /** 0..1 confidence in `complexity`. Risk 'high' is never discounted by low confidence. */
  confidence: number;
  /** Human-readable rule explanations, in the order they fired. */
  reasons: string[];
}

export interface ClassifyInput {
  title: string;
  body: string;
  labels: readonly string[];
}

interface Rule {
  id: string;
  re: RegExp;
}

const HIGH_RISK: Rule[] = [
  { id: 'auth', re: /\b(auth(?:n|z|entication|orization|orize|orise)?|oauth|sso|login|privilege|permissions?|access\s+control|rbac)\b/i },
  { id: 'secrets', re: /\b(secrets?|credentials?|api[\s_-]?keys?|tokens?|passwords?|private\s+key|encrypt\w*|decrypt\w*)\b/i },
  { id: 'vulnerability', re: /\b(security|vulnerab\w*|cve-\d+|xss|csrf|sql\s+injection|injection|exploit\w*)\b/i },
  { id: 'data-loss', re: /\b(data[\s-]loss|delete\s+(?:all\s+)?(?:user\s+)?data|drop\s+table|truncate|irreversibl\w*|destructive|wipe|purge)\b/i },
];

const COMPLEX: Rule[] = [
  { id: 'migration', re: /\b(migrations?|migrate|schema\s+change|data\s+model\s+change)\b/i },
  { id: 'concurrency', re: /\b(concurren\w*|race\s+conditions?|deadlock\w*|locking|parallelism|thread[\s-]safe\w*)\b/i },
  { id: 'lifecycle', re: /\b(lifecycle|cross[\s-]component|multi[\s-]component|state\s+machine|restart\s+(?:safety|recovery)|crash\s+recovery)\b/i },
  { id: 'architecture', re: /\b(architecture|architectural|redesign|re-?architect\w*|rewrite|breaking\s+change|backwards?[\s-]compat\w*)\b/i },
];

const ROUTINE: Rule[] = [
  { id: 'docs', re: /\b(typos?|docs?|documentation|readme|spelling|wording|comments?|changelog|grammar)\b/i },
  { id: 'isolated-test', re: /\b(add|adds|adding|missing)\s+(?:a\s+|an\s+)?(?:unit\s+)?tests?\b/i },
];

const ROUTINE_LABELS = new Set(['documentation', 'docs', 'typo']);
const HIGH_RISK_LABELS = new Set(['security', 'vulnerability', 'auth', 'data-loss']);
const COMPLEX_LABELS = new Set(['architecture', 'migration', 'epic']);

/** Bodies longer than this are not treated as routine: a long description is rarely a one-line fix. */
const ROUTINE_MAX_CHARS = 1500;

function hits(rules: Rule[], text: string): string[] {
  return rules.filter((r) => r.re.test(text)).map((r) => r.id);
}

/**
 * Classify an issue from its title, body and labels. Deterministic: the same input always gives
 * the same result. See docs/tier-routing.md for the rules.
 */
export function classifyIssue(input: ClassifyInput): Classification {
  const text = `${input.title}\n${input.body}`;
  const labels = input.labels.map((l) => l.toLowerCase());
  const reasons: string[] = [];

  const riskHits = hits(HIGH_RISK, text);
  const riskLabels = labels.filter((l) => HIGH_RISK_LABELS.has(l));
  const complexHits = hits(COMPLEX, text);
  const complexLabels = labels.filter((l) => COMPLEX_LABELS.has(l));
  const routineHits = hits(ROUTINE, text);
  const routineLabels = labels.filter((l) => ROUTINE_LABELS.has(l));

  let risk: Risk = 'low';
  if (riskHits.length || riskLabels.length) {
    risk = 'high';
    if (riskHits.length) reasons.push(`high-risk wording: ${riskHits.join(', ')}`);
    if (riskLabels.length) reasons.push(`high-risk label: ${riskLabels.join(', ')}`);
  }

  const complexAll = [...complexHits, ...complexLabels];
  const routineAll = [...routineHits, ...routineLabels];
  let complexity: Complexity = 'standard';
  let confidence = 0.5;

  if (complexAll.length > 0 && routineAll.length > 0) {
    reasons.push(`conflicting signals (complex: ${complexAll.join(', ')}; routine: ${routineAll.join(', ')}); standard`);
    confidence = 0.3;
  } else if (complexAll.length > 0) {
    complexity = 'complex';
    confidence = Math.min(0.95, 0.6 + 0.15 * complexAll.length);
    reasons.push(`complex signals: ${complexAll.join(', ')}`);
  } else if (routineAll.length > 0) {
    if (input.body.length > ROUTINE_MAX_CHARS) {
      reasons.push('routine wording but a long description; standard');
      confidence = 0.4;
    } else {
      complexity = 'routine';
      confidence = Math.min(0.9, 0.6 + 0.1 * routineAll.length);
      reasons.push(`routine signals: ${routineAll.join(', ')}`);
    }
  } else {
    reasons.push('no distinguishing signals; standard');
  }

  if (risk === 'low' && complexity === 'complex') risk = 'medium';
  return { complexity, risk, confidence, reasons };
}
