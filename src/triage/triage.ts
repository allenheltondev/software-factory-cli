/**
 * Opt-in triage of ambiguous issues by an installed, signed-in coding CLI (docs/triage.md).
 *
 * This module never calls a model API and never reads a provider credential. It launches the
 * configured agent profile (agents.<name>) through the adapter's read-only triage invocation,
 * the same discovery and spawn-without-a-shell machinery live runs use, and reads one JSON
 * verdict from its final message.
 *
 * Every failure (CLI missing, signed out or out of usage, timeout, oversized or malformed reply,
 * frequency limit) comes back as `{ ok: false, reason }`; the router then keeps the local tier
 * (src/tier-routing.ts). Triage never triages itself: nothing here queues work or re-enters the
 * router.
 *
 * Cost control: a verdict is cached by issue identity + content revision + agent profile + policy
 * version, in the state database, so polling and restarts reuse it. Failures are cached for a
 * cooldown. Concurrent callers for one key share one launch. Launches per hour are capped.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAdapter } from '../agents/adapters/registry.js';
import { defaultVerdict } from '../agents/adapters/adapter.js';
import { defaultDiscoveryProbes, locateLaunch, runProcess, type DiscoveryProbes, type LocatedLaunch, type ProcessResult, type RunProcessOptions } from '../agents/discovery.js';
import { failureLine } from '../agents/failure-line.js';
import { effectiveArgs } from '../agents/profile.js';
import type { AdapterName, TriageConfig, UpdraftConfig } from '../config/schema.js';
import type { Db } from '../db/database.js';
import type { Logger } from '../util/log.js';
import { buildTriagePrompt, type TriagePromptInput } from './prompt.js';
import { cleanText, parseTriageResponse, type TriageVerdict } from './response.js';

/** Bump when the prompt, the schema or the way a verdict is applied changes: old answers are then not reused. */
export const TRIAGE_POLICY_VERSION = 1;

export interface TriageRequest {
  repoId: number;
  repo: string;
  action: string;
  issueNumber: number;
  title: string;
  body: string;
  labels: readonly string[];
  localSignals: readonly string[];
  localRisk: 'low' | 'medium' | 'high';
}

export type TriageOutcome =
  | { ok: true; origin: 'cli' | 'cache'; agent: string; verdict: TriageVerdict }
  | { ok: false; agent: string; reason: string };

export type TriageRunner = (cfg: TriageConfig, req: TriageRequest) => Promise<TriageOutcome>;

export interface TriageDeps {
  db: Db;
  config: UpdraftConfig;
  /** Directory of the config file; resolves a relative agents.<name>.command. */
  configDir?: string;
  log: Logger;
  now?: () => number;
  /** Test seams. Defaults: discovery's lookup and the shell-less process runner. */
  locate?: (adapter: AdapterName, command: string | undefined) => LocatedLaunch;
  run?: (file: string, args: string[], opts: RunProcessOptions) => Promise<ProcessResult>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** Launches in flight, by cache key: concurrent claims of one issue revision share one run. */
const inFlight = new Map<string, Promise<TriageOutcome>>();

function digest(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** The cache key: identity, content revision (title, body, labels), agent profile and policy version. */
export function triageCacheKey(req: TriageRequest, agent: string, profile: unknown): string {
  const content = digest([req.title, req.body, [...req.labels].map((l) => l.toLowerCase()).sort()]);
  return digest([TRIAGE_POLICY_VERSION, req.repoId, req.issueNumber, content, agent, profile]);
}

interface CacheRow {
  outcome: 'ok' | 'failed';
  result: string | null;
  reason: string | null;
  expires_at: string | null;
}

function readCache(db: Db, key: string, nowIso: string): CacheRow | null {
  const row = db.prepare('SELECT outcome, result, reason, expires_at FROM triage_cache WHERE cache_key = ?').get(key) as CacheRow | undefined;
  if (!row) return null;
  if (row.expires_at !== null && row.expires_at <= nowIso) return null;
  return row;
}

function writeCache(db: Db, key: string, agent: string, nowIso: string, v: { verdict: TriageVerdict } | { reason: string; expiresAt: string }): void {
  db.prepare(
    `INSERT INTO triage_cache (cache_key, outcome, result, reason, agent, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (cache_key) DO UPDATE SET outcome = excluded.outcome, result = excluded.result, reason = excluded.reason,
       agent = excluded.agent, created_at = excluded.created_at, expires_at = excluded.expires_at`,
  ).run(key, 'verdict' in v ? 'ok' : 'failed', 'verdict' in v ? JSON.stringify(v.verdict) : null, 'reason' in v ? v.reason : null, agent, nowIso, 'reason' in v ? v.expiresAt : null);
}

function launchesSince(db: Db, sinceIso: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM triage_runs WHERE started_at >= ?').get(sinceIso) as { n: number }).n;
}

/** Forget launch records older than a day, so the table stays small. */
function pruneRuns(db: Db, beforeIso: string): void {
  db.prepare('DELETE FROM triage_runs WHERE started_at < ?').run(beforeIso);
  db.prepare('DELETE FROM triage_cache WHERE expires_at IS NOT NULL AND expires_at < ?').run(beforeIso);
}

const HOUR_MS = 3_600_000;

export function createTriageRunner(deps: TriageDeps): TriageRunner {
  const now = deps.now ?? (() => Date.now());
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? runProcess;
  const locate =
    deps.locate ??
    ((adapter: AdapterName, command: string | undefined) => {
      const probes: DiscoveryProbes = defaultDiscoveryProbes(deps.env ?? process.env);
      return locateLaunch(adapter, probes, { ...(command ? { command } : {}), ...(deps.configDir ? { baseDir: deps.configDir } : {}) });
    });

  return async (cfg, req) => {
    const agent = cfg.agent;
    const fail = (reason: string): TriageOutcome => ({ ok: false, agent, reason });
    const agentCfg = deps.config.agents[agent];
    if (!agentCfg) return fail(`triage agent "${agent}" is not defined in agents`);
    if (!agentCfg.enabled) return fail(`triage agent "${agent}" is disabled`);
    const adapterName = agentCfg.adapter ?? agent;
    const adapter = getAdapter(adapterName);
    if (!adapter?.buildTriageInvocation) return fail(`the ${adapterName} adapter cannot run triage`);
    if (agentCfg.container) return fail('triage runs the agent on the host; an agent with a container cannot triage');

    const args = effectiveArgs(adapterName, agentCfg);
    const key = triageCacheKey(req, agent, [adapterName, agentCfg.command ?? null, args]);
    const nowIso = new Date(now()).toISOString();

    const cached = readCache(deps.db, key, nowIso);
    if (cached?.outcome === 'ok' && cached.result) {
      try {
        const parsed = parseTriageResponse(cached.result, Number.MAX_SAFE_INTEGER);
        if (parsed.ok) return { ok: true, origin: 'cache', agent, verdict: parsed.verdict };
      } catch {
        // fall through and ask again
      }
    } else if (cached?.outcome === 'failed') {
      return fail(`an earlier triage of this issue revision failed (${cached.reason ?? 'unknown'}); not retrying until the cooldown ends`);
    }

    const existing = inFlight.get(key);
    if (existing) return existing;
    const p = launch().finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;

    async function launch(): Promise<TriageOutcome> {
      const located = locate(adapterName as AdapterName, agentCfg!.command);
      if (!located.launch) return fail(`${located.problem ?? `${adapterName} CLI not found`}`);
      let invocation;
      try {
        invocation = adapter!.buildTriageInvocation!({ launch: located.launch, extraArgs: args, platform });
      } catch (err) {
        return fail(cleanText((err as Error).message, 300));
      }
      const prompt = buildTriagePrompt({
        repo: req.repo,
        action: req.action,
        title: req.title,
        body: req.body,
        labels: req.labels,
        localSignals: req.localSignals,
        localRisk: req.localRisk,
      } satisfies TriagePromptInput);
      const env = { ...(deps.env ?? process.env), ...(agentCfg!.env ?? {}), ...(invocation.env ?? {}) };

      // The prompt is on stdin and the run starts in an empty directory, so the agent sees no repository.
      const workDir = await mkdtemp(join(tmpdir(), 'updraft-triage-'));
      try {
        let lastReason = 'no attempt was made';
        for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
          const t = now();
          const tIso = new Date(t).toISOString();
          pruneRuns(deps.db, new Date(t - 24 * HOUR_MS).toISOString());
          if (launchesSince(deps.db, new Date(t - HOUR_MS).toISOString()) >= cfg.maxPerHour) {
            // Not cached: the limit lifts by itself, and nothing was learned about the issue.
            return fail(`triage limit reached (${cfg.maxPerHour} launches per hour)`);
          }
          deps.db.prepare('INSERT INTO triage_runs (agent, started_at) VALUES (?, ?)').run(agent, tIso);
          const result = await run(invocation.file, invocation.args, { timeoutMs: cfg.timeoutSeconds * 1000, cwd: workDir, env, input: prompt });
          const read = readReply(result, invocation.args);
          if (read.ok) {
            writeCache(deps.db, key, agent, tIso, { verdict: read.verdict });
            return { ok: true, origin: 'cli', agent, verdict: read.verdict };
          }
          lastReason = read.reason;
          if (!read.retry) break;
        }
        const expiresAt = new Date(now() + cfg.failureCooldownMinutes * 60_000).toISOString();
        writeCache(deps.db, key, agent, new Date(now()).toISOString(), { reason: lastReason, expiresAt });
        return fail(lastReason);
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    function readReply(result: ProcessResult, invocationArgs: readonly string[]): { ok: true; verdict: TriageVerdict } | { ok: false; reason: string; retry: boolean } {
      if (result.timedOut) return { ok: false, reason: `triage timed out after ${cfg.timeoutSeconds}s`, retry: false };
      if (result.error) return { ok: false, reason: `could not start the triage CLI: ${cleanText(result.error, 160)}`, retry: false };
      const output = result.stdout;
      const verdict = adapter!.interpretExit
        ? adapter!.interpretExit({ code: result.code, signal: null, outputTail: [], output: output + (result.stderr ? `\n${result.stderr}` : ''), args: invocationArgs })
        : defaultVerdict({ code: result.code, signal: null, outputTail: [], output, args: invocationArgs });
      if (verdict.outcome === 'failed') {
        const said = failureLine(result.stderr || output);
        return { ok: false, reason: cleanText(`${verdict.error ?? 'triage CLI failed'}${said && !verdict.error?.includes(said) ? `: ${said}` : ''}`, 300), retry: false };
      }
      const message = adapter!.finalMessage ? adapter!.finalMessage(output) : undefined;
      if (message === null) return { ok: false, reason: 'the triage CLI ended without a final message', retry: true };
      const parsed = parseTriageResponse(message ?? output, cfg.maxOutputBytes);
      return parsed.ok ? parsed : { ok: false, reason: parsed.reason, retry: true };
    }
  };
}
