/**
 * What the worker does with a run that did not succeed, beyond recording it: recognize a CLI usage
 * limit (cooldown, then wait), or decide an escalation (docs/capacity-and-escalation.md).
 * Both are opt-in: without `capacity` or `tiers.escalation` this returns nothing and the run is
 * recorded exactly as before.
 */
import { workflowId, type UpdraftConfig } from '../config/schema.js';
import { capacityKey, cooldownDuration, jobCounters, recordPolicyEvent } from '../db/capacity.js';
import type { Db } from '../db/database.js';
import { ownEntry, type FailureHandling } from '../db/queue.js';
import { decideEscalation, parseEscalationRequest, type EscalationRequest, type Tier } from '../escalation/escalation.js';
import type { Job, Run } from '../types.js';
import { revisionOf, reviewOf } from '../types.js';
import { classifyCliFailure, type CliFailure } from '../capacity/usage-limit.js';
import { agentAdapter } from '../config/schema.js';
import type { ExecutionResult } from './executor.js';

export interface PolicyOutcome {
  /** What the run is recorded as (a pre-edit escalation from a run that exited cleanly is closed as failed). */
  outcome: ExecutionResult['outcome'];
  error?: string | null;
  handling?: FailureHandling;
}

function workflowOf(config: UpdraftConfig, job: Job) {
  for (const repo of Object.values(config.repositories)) {
    if (repo.id !== job.repoId) continue;
    return repo.workflows.find((w) => workflowId(w) === job.workflowId);
  }
  return undefined;
}

/** Usage-limit text a CLI printed on exit (set by the live executor), or a failure the daemon classifies from the error. */
function usageFailure(config: UpdraftConfig, run: Run, result: ExecutionResult, nowMs: number): CliFailure | null {
  const text = result.cliOutput ?? '';
  if (!text) return null;
  const agent = ownEntry(config.agents, run.agent);
  const f = classifyCliFailure(agent ? agentAdapter(run.agent, agent) : run.agent, text, nowMs);
  return f.kind === 'usage-limit' ? f : null;
}

/**
 * Decide what to do with a finished run. `result.cliOutput` is the agent CLI's own output when it
 * exited unsuccessfully (never verification output or a timeout); `result.escalationRequest` is
 * the raw request line parsed by the executor, validated here and decided by policy.
 */
export function decideFailureHandling(db: Db, config: UpdraftConfig, job: Job, run: Run, result: ExecutionResult, nowMs: number): PolicyOutcome {
  const base: PolicyOutcome = { outcome: result.outcome, ...(result.error !== undefined ? { error: result.error } : {}) };

  // 1. A recognized usage limit: cool the group or profile down and put the job back.
  if (config.capacity && result.outcome === 'failed') {
    const f = usageFailure(config, run, result, nowMs);
    if (f) {
      const key = capacityKey(config, run.agent);
      const { ms, stated } = cooldownDuration(config, key, f.retryAfterMs);
      return {
        ...base,
        handling: { kind: 'usage-limit', cooldown: { ...key, untilMs: nowMs + ms, stated }, maxDeferrals: config.capacity.maxDeferrals, detail: `usage limit: ${f.detail}` },
      };
    }
  }

  // 2. Escalation. Only first-hand implementation jobs; reviewer and revision jobs never escalate.
  if (reviewOf(job) || revisionOf(job) || job.envelope.type !== 'issue.labeled') return base;
  const tiers = workflowOf(config, job)?.tiers;
  if (!tiers?.escalation) return base;
  if (result.outcome !== 'failed' && result.outcome !== 'succeeded') return base;

  let request: EscalationRequest | undefined;
  let source: 'agent-request' | 'verification-failure' | null = null;
  if (result.escalationRequest !== undefined) {
    const parsed = parseEscalationRequest(result.escalationRequest);
    if (parsed && !parsed.ok) {
      recordPolicyEvent(db, { kind: 'escalation-denied', jobId: job.id, runId: run.id, detail: `invalid escalation request: ${parsed.problem}`, now: () => nowMs });
    } else if (parsed) {
      request = parsed.request;
      source = 'agent-request';
    }
  }
  // A run that exited cleanly is only a pre-edit deferral if it left nothing behind.
  if (request && result.outcome === 'succeeded' && (result.summary?.commitCount ?? 0) > 0) {
    recordPolicyEvent(db, { kind: 'escalation-denied', jobId: job.id, runId: run.id, detail: 'the run succeeded and left commits; a request after editing is not honored', now: () => nowMs });
    return base;
  }
  if (!source && result.outcome === 'failed' && result.summary?.verification && result.error?.startsWith('verification failed')) {
    source = 'verification-failure';
  }
  if (!source) return base;

  const tier = job.envelope.routing?.tier as Tier | undefined;
  const decision = decideEscalation({
    policy: tiers.escalation,
    tiers,
    currentTier: tier,
    hops: jobCounters(db, job.id).escalationHops,
    source,
    ...(request ? { request } : {}),
    poolAvailable: (pool) => {
      const p = ownEntry(config.pools, pool);
      return !!p && p.agents.some((a) => ownEntry(config.agents, a)?.enabled);
    },
  });
  if (!decision.escalate) {
    recordPolicyEvent(db, { kind: 'escalation-denied', jobId: job.id, runId: run.id, detail: `${source}: ${decision.reason}`, now: () => nowMs });
    return base;
  }
  const why = request ? `${request.reason}: ${request.evidence}` : 'verification failed';
  return {
    outcome: 'failed',
    error: `escalated (${source}): ${decision.reason}; ${why}`.slice(0, 500),
    handling: { kind: 'escalate', fromTier: decision.fromTier, toTier: decision.toTier, pool: decision.pool, reason: why.slice(0, 300), source },
  };
}

/** True when any workflow turns escalation on (so the daemon needs to consult the policy). */
export function hasEscalation(config: UpdraftConfig): boolean {
  return Object.values(config.repositories).some((r) => r.workflows.some((w) => w.tiers?.escalation?.enabled));
}
