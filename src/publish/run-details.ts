// The selection details shared by the lifecycle comments on the source issue and pull request:
// which profile ran, with which adapter, configured model and effort, in which capability tier,
// and why (docs/assignment-comments.md).
//
// Read from what is already persisted, never from the current config or a model call:
// - the run's own `run.selected` metric row, written in the claim's transaction (profile,
//   adapter, configured model and effort, resolved and requested tier, route source and reason
//   code, escalation hops and retries). One row per run, so a later attempt never changes what an
//   earlier one reports;
// - the job's routing decision, fixed at enqueue (issue complexity, rule);
// - after the run: the model the agent CLI itself reported (`run.summary.observedModel`), kept
//   apart from the configured one.
// Every value shown is a short code or a name checked against a strict pattern: no prompt, path,
// log, issue text or credential reaches a comment.
import type { Db } from '../db/database.js';
import { routeReasonCode } from '../db/metrics.js';
import type { Job, Run } from '../types.js';
import { code } from './failure-comment.js';

/** Values a comment states when the persisted data has no name to show. */
export const CLI_DEFAULT = 'CLI default';
export const UNKNOWN = 'Unknown';
export const NOT_APPLICABLE = 'Not applicable';

export interface RunDetails {
  /** The agent profile (`agents.<name>`) the run was given. */
  worker: string;
  /** A model name, 'CLI default' or 'Unknown'. */
  model: string;
  /** Whether `model` is a configured value, one the CLI reported, or neither. */
  modelKind: 'configured' | 'observed' | null;
  /**
   * The issue's complexity as the router classified it (routine | standard | complex), or why
   * there is none: 'Not classified (tier routing off)', '... (tier set by label)', 'Not
   * applicable' for review and revision runs, or plain 'Not classified'.
   */
  complexity: string;
  /**
   * The capability tier the run's pool belongs to (routine | standard | complex | high-risk),
   * 'Not applicable (tier routing off)' when the job was not tier-routed, 'Not applicable' for a
   * review or revision run in a pool no tier names, or 'Unknown' when nothing was recorded.
   * Never inferred from a model or profile name.
   */
  tier?: string;
  /** The adapter (provider CLI) of the profile; null when not recorded. */
  adapter?: string | null;
  /** The configured reasoning effort, 'CLI default' or 'Unknown'. */
  effort?: string;
  /** A short reason for the route, built from fixed codes only; null when none is known. */
  reason?: string | null;
  /** The model the agent CLI reported for this run, when it reported one; never assumed. */
  observedModel?: string | null;
  /** 'retry N', 'escalation N', both, or null for a first attempt. */
  attempt?: string | null;
}

const SAFE_VALUE = /^[A-Za-z0-9._:@+/-]{1,80}$/;
const safe = (v: unknown): string | null => (typeof v === 'string' && SAFE_VALUE.test(v) && !v.includes('..') && !v.startsWith('/') ? v : null);
const COMPLEXITIES: readonly string[] = ['routine', 'standard', 'complex'];
const TIERS: readonly string[] = ['routine', 'standard', 'complex', 'high-risk'];
const oneOf = (v: unknown, list: readonly string[]): string | null => (typeof v === 'string' && list.includes(v) ? v : null);

/** A reason code (metrics.ts routeReasonCode) in words. Fixed text only. */
const REASONS: Record<string, string> = {
  'override-label': 'tier override label',
  'legacy-label': 'pool rule label',
  default: 'workflow pool',
  confident: 'local classifier',
  'low-confidence': 'local classifier, low confidence',
  'triage-answered': 'triage',
  'triage-cached': 'triage (earlier answer reused)',
  'triage-unavailable': 'triage unavailable, local policy used',
};

interface SelectedRow {
  model: string | null;
  model_source: string | null;
  tier: string | null;
  requested_tier: string | null;
  risk: string | null;
  adapter: string | null;
  effort: string | null;
  reason: string | null;
  hops: number | null;
  retries: number | null;
}

function selectedRow(db: Db, runId: string): SelectedRow | undefined {
  try {
    return db
      .prepare("SELECT model, model_source, tier, requested_tier, risk, adapter, effort, reason, hops, retries FROM metric_events WHERE kind = 'run.selected' AND subject_id = ?")
      .get(runId) as SelectedRow | undefined;
  } catch {
    return undefined;
  }
}

/** The details of one run, from persisted data only; tolerant of missing metadata. */
export function runDetails(db: Db, job: Job, run: Run): RunDetails {
  const row = selectedRow(db, run.id);
  const type = job.envelope?.type;
  const loopRun = type === 'pull_request.review' || type === 'pull_request.changes_requested';
  const routing = loopRun ? undefined : job.envelope?.routing;

  const known = safe(row?.model);
  const recordedComplexity = oneOf(routing?.complexity, COMPLEXITIES);
  let complexity: string;
  if (loopRun) complexity = NOT_APPLICABLE;
  else if (recordedComplexity) complexity = recordedComplexity;
  // A job carries a routing decision exactly when its workflow had tier routing on at enqueue.
  else if (!routing) complexity = 'Not classified (tier routing off)';
  else if (routing.rule === 'override-label') complexity = 'Not classified (tier set by label)';
  else if (routing.rule === 'legacy-label') complexity = 'Not classified (pool set by label rule)';
  else complexity = 'Not classified';

  const resolvedTier = oneOf(row?.tier, TIERS);
  let tier: string;
  if (resolvedTier) tier = resolvedTier;
  else if (loopRun) tier = NOT_APPLICABLE;
  else if (!routing) tier = 'Not applicable (tier routing off)';
  else if (routing.rule === 'legacy-label') tier = 'Not applicable (pool set by label rule)';
  else tier = UNKNOWN;

  const hops = typeof row?.hops === 'number' && row.hops > 0 ? row.hops : 0;
  const retries = typeof row?.retries === 'number' && row.retries > 0 ? row.retries : 0;
  const attempt = [retries ? `retry ${retries}` : '', hops ? `escalation ${hops}` : ''].filter(Boolean).join(', ') || null;

  const parts: string[] = [];
  const reasonCode = row ? row.reason : loopRun ? null : routeReasonCode(routing ?? null);
  if (reasonCode && REASONS[reasonCode]) parts.push(REASONS[reasonCode]!);
  if (resolvedTier === 'high-risk' && row?.risk === 'high' && reasonCode !== 'override-label') parts.push('high-risk floor');
  const requested = oneOf(row?.requested_tier, TIERS);
  if (hops && requested && requested !== resolvedTier) parts.push(`escalated from ${requested}`);
  else if (hops) parts.push('escalated');

  const observed = safe(run.summary?.observedModel);
  return {
    worker: run.agent.replace(/[^\w.-]/g, '') || 'unknown',
    model: known ?? (row ? CLI_DEFAULT : UNKNOWN),
    modelKind: known ? (row?.model_source === 'observed' ? 'observed' : 'configured') : null,
    complexity,
    tier,
    adapter: safe(row?.adapter),
    effort: safe(row?.effort) ?? (row ? CLI_DEFAULT : UNKNOWN),
    reason: parts.length ? parts.join('; ') : null,
    observedModel: observed,
    attempt,
  };
}

/**
 * Bullet lines for the details. At assignment (`assignment`) a known model is always labelled
 * configured: nothing has been observed yet. After the run, a model the CLI reported is listed
 * on its own line, beside the configured one, never in its place.
 */
export function detailLines(d: RunDetails, assignment = false, plain = false): string[] {
  const kind = assignment ? (d.modelKind ? 'configured' : null) : d.modelKind;
  const label = (t: string) => (plain ? `${t}:` : `**${t}**`);
  const lines = [`- ${label(`Model${kind ? ` (${kind})` : ''}`)} ${code(d.model)}`];
  if (!assignment && d.observedModel && d.modelKind !== 'observed') lines.push(`- ${label('Model (observed)')} ${code(d.observedModel)}`);
  if (d.effort !== undefined) lines.push(`- ${label('Reasoning effort')} ${code(d.effort)}`);
  lines.push(`- ${label('Complexity')} ${code(d.complexity)}`);
  if (d.tier !== undefined) lines.push(`- ${label('Capability tier')} ${code(d.tier)}`);
  return lines;
}

/**
 * One line naming what ran, for a pull request message (a review, a revision's reply): profile,
 * adapter, configured and observed model, effort and tier. Values are inline code.
 */
export function selectionLine(d: RunDetails): string {
  const parts = [`Profile ${code(d.worker)}`];
  if (d.adapter) parts.push(`adapter ${code(d.adapter)}`);
  parts.push(`model${d.modelKind ? ` (${d.modelKind})` : ''} ${code(d.model)}`);
  if (d.observedModel && d.modelKind !== 'observed') parts.push(`model (observed) ${code(d.observedModel)}`);
  if (d.effort !== undefined) parts.push(`effort ${code(d.effort)}`);
  if (d.tier && d.tier !== NOT_APPLICABLE) parts.push(`tier ${code(d.tier)}`);
  if (d.attempt) parts.push(d.attempt);
  return parts.join(' · ');
}
