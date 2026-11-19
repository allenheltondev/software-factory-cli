// Persistence for subscription capacity groups, cooldowns and policy events
// (docs/capacity-and-escalation.md). Nothing here runs unless `capacity` or `tiers.escalation`
// is configured.
import type { UpdraftConfig } from '../config/schema.js';
import type { Db } from './database.js';
import { nowIso } from '../util/ids.js';

export type CapacityKey = { scope: 'group' | 'agent'; name: string };

/** Agents sharing an account name one group; an ungrouped profile is its own scope. */
export function capacityKey(config: Pick<UpdraftConfig, 'agents'>, agentName: string): CapacityKey {
  const group = Object.hasOwn(config.agents, agentName) ? config.agents[agentName]!.capacityGroup : undefined;
  return group ? { scope: 'group', name: group } : { scope: 'agent', name: agentName };
}

export interface Cooldown extends CapacityKey {
  until: string;
  reason: string;
  stated: boolean;
  jobId: string | null;
  runId: string | null;
}

interface CooldownRow {
  scope: 'group' | 'agent';
  name: string;
  until: string;
  reason: string;
  stated: number;
  job_id: string | null;
  run_id: string | null;
}

/** Cooldowns that have not expired at `nowMs`. */
export function activeCooldowns(db: Db, nowMs: number): Cooldown[] {
  const rows = db.prepare('SELECT * FROM capacity_cooldowns WHERE until > ? ORDER BY until').all(new Date(nowMs).toISOString()) as unknown as CooldownRow[];
  return rows.map((r) => ({ scope: r.scope, name: r.name, until: r.until, reason: r.reason, stated: r.stated === 1, jobId: r.job_id, runId: r.run_id }));
}

/** Start (or lengthen, never shorten) a cooldown. An expired one is replaced. */
export function setCooldown(
  db: Db,
  c: CapacityKey & { untilMs: number; reason: string; stated: boolean; jobId?: string; runId?: string; nowMs: number },
): void {
  const until = new Date(c.untilMs).toISOString();
  db.prepare(
    `INSERT INTO capacity_cooldowns (scope, name, until, reason, stated, job_id, run_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (scope, name) DO UPDATE SET until = excluded.until, reason = excluded.reason, stated = excluded.stated,
       job_id = excluded.job_id, run_id = excluded.run_id, created_at = excluded.created_at
     WHERE excluded.until > capacity_cooldowns.until OR capacity_cooldowns.until <= excluded.created_at`,
  ).run(c.scope, c.name, until, c.reason, c.stated ? 1 : 0, c.jobId ?? null, c.runId ?? null, new Date(c.nowMs).toISOString());
}

export type PolicyEventKind = 'cooldown' | 'deferred' | 'escalated' | 'escalation-denied' | 'exhausted';

export interface PolicyEvent {
  id: number;
  at: string;
  kind: PolicyEventKind;
  jobId: string;
  runId: string | null;
  detail: string;
}

interface EventRow {
  id: number;
  at: string;
  kind: PolicyEventKind;
  job_id: string;
  run_id: string | null;
  detail: string;
}

const toEvent = (r: EventRow): PolicyEvent => ({ id: r.id, at: r.at, kind: r.kind, jobId: r.job_id, runId: r.run_id, detail: r.detail });

export function recordPolicyEvent(db: Db, e: { kind: PolicyEventKind; jobId: string; runId?: string | null; detail: string; now?: () => number }): void {
  db.prepare('INSERT INTO policy_events (at, kind, job_id, run_id, detail) VALUES (?, ?, ?, ?, ?)').run(
    nowIso(e.now ?? Date.now),
    e.kind,
    e.jobId,
    e.runId ?? null,
    e.detail.slice(0, 500),
  );
}

export function listPolicyEvents(db: Db, jobId: string): PolicyEvent[] {
  return (db.prepare('SELECT * FROM policy_events WHERE job_id = ? ORDER BY id').all(jobId) as unknown as EventRow[]).map(toEvent);
}

export function listRecentPolicyEvents(db: Db, limit: number): PolicyEvent[] {
  return (db.prepare('SELECT * FROM policy_events ORDER BY id DESC LIMIT ?').all(limit) as unknown as EventRow[]).reverse().map(toEvent);
}

export function jobCounters(db: Db, jobId: string): { escalationHops: number; deferrals: number } {
  const r = db.prepare('SELECT escalation_hops, deferrals FROM jobs WHERE id = ?').get(jobId) as { escalation_hops: number; deferrals: number } | undefined;
  return { escalationHops: r?.escalation_hops ?? 0, deferrals: r?.deferrals ?? 0 };
}

/**
 * Why `agent` cannot take a new run right now because of capacity policy, or null. Only acts
 * when `capacity` is configured; plain per-agent maxConcurrent is checked by the caller as before.
 */
export function capacityBlock(
  config: UpdraftConfig,
  agentName: string,
  cooldowns: readonly Cooldown[],
  load: ReadonlyMap<string, number>,
): string | null {
  if (!config.capacity) return null;
  const key = capacityKey(config, agentName);
  const cd = cooldowns.find((c) => c.scope === key.scope && c.name === key.name);
  if (cd) return `${key.scope} "${key.name}" is cooling down until ${cd.until} (${cd.reason})`;
  if (key.scope === 'group' && Object.hasOwn(config.capacity.groups, key.name)) {
    const group = config.capacity.groups[key.name]!;
    let used = 0;
    for (const [a, n] of load) {
      const k = capacityKey(config, a);
      if (k.scope === 'group' && k.name === key.name) used += n;
    }
    if (used >= group.maxConcurrent) return `group "${key.name}" is at its limit of ${group.maxConcurrent} concurrent run(s)`;
  }
  return null;
}

/** Cooldown length for a usage limit: the CLI's stated retry-after (bounded by the max), else the default. */
export function cooldownDuration(
  config: Pick<UpdraftConfig, 'capacity'>,
  key: CapacityKey,
  retryAfterMs: number | undefined,
): { ms: number; stated: boolean } {
  const cap = config.capacity;
  const group = key.scope === 'group' && cap && Object.hasOwn(cap.groups, key.name) ? cap.groups[key.name] : undefined;
  const max = (group?.maxCooldownMinutes ?? cap?.maxCooldownMinutes ?? 360) * 60_000;
  const def = (group?.defaultCooldownMinutes ?? cap?.defaultCooldownMinutes ?? 60) * 60_000;
  if (retryAfterMs !== undefined && retryAfterMs > 0) return { ms: Math.min(retryAfterMs, max), stated: true };
  return { ms: Math.min(def, max), stated: false };
}
