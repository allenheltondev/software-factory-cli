/**
 * The lifecycle of a job as its runner reports it at the finish: where the review loop left the
 * pull request, and each step the run took (the event's own job, then the reviewer runs and
 * revisions that followed). Shown in the console; checked here (the broker, and again when read
 * back) so it can only ever hold short codes, counts and booleans.
 */

export const STEP_KINDS = ['implement', 'revision', 'review'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** The review loop's stages (`updraft status`; docs/run-event.md, `loop.stage`). */
export const LOOP_STAGES = ['awaiting-review', 'reviewing', 'changes-requested', 'revising', 'ready-to-merge', 'merging', 'merged', 'needs-human', 'closed'] as const;
export type LoopStage = (typeof LOOP_STAGES)[number];

export interface JobLoop {
  /** Revision rounds so far, of maxRevisions. */
  rounds: number;
  maxRevisions?: number;
  /** Reviewer verdicts recorded. */
  reviews: number;
  verdict?: 'ready-to-merge' | 'changes-requested';
  stage?: LoopStage;
  merged?: boolean;
}

export interface JobStep {
  kind: StepKind;
  /** The agent profile that ran it, as the tenant's config names it. */
  agent?: string;
  /** How the step ended (succeeded, failed, canceled, superseded, ...). */
  outcome?: string;
  verificationPassed?: boolean;
  /** published, skipped, failed: its pull request, push or review posting. */
  publication?: string;
}

/** The most steps a job keeps: a loop with maxRevisions 10 is 21. */
export const MAX_STEPS = 24;
const CODE = /^[a-z][a-z_-]{0,39}$/;
const AGENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const count = (v: unknown, max: number) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max ? v : undefined);

export function loopOf(raw: unknown): JobLoop | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const l = raw as Record<string, unknown>;
  const rounds = count(l.rounds, 1000);
  const reviews = count(l.reviews, 1000);
  if (rounds === undefined || reviews === undefined) return undefined;
  const out: JobLoop = { rounds, reviews };
  const max = count(l.maxRevisions, 1000);
  if (max !== undefined) out.maxRevisions = max;
  if (l.verdict === 'ready-to-merge' || l.verdict === 'changes-requested') out.verdict = l.verdict;
  if ((LOOP_STAGES as readonly unknown[]).includes(l.stage)) out.stage = l.stage as LoopStage;
  if (typeof l.merged === 'boolean') out.merged = l.merged;
  return out;
}

export function stepsOf(raw: unknown): JobStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: JobStep[] = [];
  for (const s of raw.slice(0, MAX_STEPS)) {
    if (typeof s !== 'object' || s === null) continue;
    const r = s as Record<string, unknown>;
    if (!(STEP_KINDS as readonly unknown[]).includes(r.kind)) continue;
    const step: JobStep = { kind: r.kind as StepKind };
    if (typeof r.agent === 'string' && AGENT.test(r.agent)) step.agent = r.agent;
    if (typeof r.outcome === 'string' && CODE.test(r.outcome)) step.outcome = r.outcome;
    if (typeof r.verificationPassed === 'boolean') step.verificationPassed = r.verificationPassed;
    if (typeof r.publication === 'string' && CODE.test(r.publication)) step.publication = r.publication;
    out.push(step);
  }
  return out.length ? out : undefined;
}

/** What a job's runner sent to the tenant's telemetry: the trace, for a link, and how many spans got there. */
export interface JobTelemetryReport {
  traceId: string;
  spans: number;
  exported: number;
  failed: number;
  /** When the trace started (ISO), for the link's time range. */
  startedAt?: string;
  /** A short code (HTTP 401, timeout, ...). */
  lastError?: string;
}

export function telemetryOf(raw: unknown): JobTelemetryReport | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const t = raw as Record<string, unknown>;
  if (typeof t.traceId !== 'string' || !/^[0-9a-f]{32}$/.test(t.traceId)) return undefined;
  const n = (v: unknown) => count(v, 10_000_000) ?? 0;
  const out: JobTelemetryReport = { traceId: t.traceId, spans: n(t.spans), exported: n(t.exported), failed: n(t.failed) };
  if (typeof t.startedAt === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(t.startedAt)) out.startedAt = t.startedAt;
  if (typeof t.lastError === 'string' && /^[A-Za-z0-9 ._-]{1,40}$/.test(t.lastError)) out.lastError = t.lastError;
  return out;
}
