import { existsSync } from 'node:fs';
import { configSchema, type FactoryConfig } from '../config/schema.js';
import { getStatusSnapshot, type StatusSnapshot } from '../db/queue.js';
import type { JobStatus } from '../types.js';
import { println, type CommandContext } from './context.js';
import { EXIT } from './errors.js';
import { checkConfig } from './validate.js';

export interface WatchedRepo {
  fullName: string;
  id: number;
  workflows: number;
  checkpoint: { lastEventId: number | null; updatedAt: string } | null;
}

export interface StatusView {
  configPath: string;
  configState: 'ok' | 'missing' | 'invalid';
  configMessage: string | null;
  dbFile: string;
  dbExists: boolean;
  repos: WatchedRepo[];
  /** Checkpoints for repos that are no longer in the config. */
  orphanCheckpoints: StatusSnapshot['checkpoints'];
  snapshot: StatusSnapshot;
}

const JOB_STATUSES: JobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'interrupted', 'canceled'];

export function emptyConfig(): FactoryConfig {
  return configSchema.parse({ version: 1, agents: {}, pools: {}, actions: {} });
}

export function buildStatusView(o: {
  configPath: string;
  configState: StatusView['configState'];
  configMessage: string | null;
  config: FactoryConfig | null;
  dbFile: string;
  dbExists: boolean;
  snapshot: StatusSnapshot;
}): StatusView {
  const byId = new Map(o.snapshot.checkpoints.map((c) => [c.repoId, c]));
  const repos: WatchedRepo[] = Object.entries(o.config?.repositories ?? {}).map(([fullName, r]) => {
    const cp = byId.get(r.id);
    return {
      fullName,
      id: r.id,
      workflows: r.workflows.length,
      checkpoint: cp ? { lastEventId: cp.lastEventId, updatedAt: cp.updatedAt } : null,
    };
  });
  const configured = new Set(repos.map((r) => r.id));
  return {
    configPath: o.configPath,
    configState: o.configState,
    configMessage: o.configMessage,
    dbFile: o.dbFile,
    dbExists: o.dbExists,
    repos,
    orphanCheckpoints: o.snapshot.checkpoints.filter((c) => !configured.has(c.repoId)),
    snapshot: o.snapshot,
  };
}

function oneLine(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function renderStatus(v: StatusView): string {
  const s = v.snapshot;
  const lines: string[] = [];
  const configNote =
    v.configState === 'ok'
      ? ''
      : v.configState === 'missing'
        ? ' (not found; run "factory configure" or "factory add")'
        : ` (invalid: ${oneLine(v.configMessage ?? 'see "factory validate"')})`;
  lines.push(`Config: ${v.configPath}${configNote}`);
  lines.push(`State:  ${v.dbFile}${v.dbExists ? '' : ' (not created yet)'}`);

  if (!s.worker) lines.push('Worker: not running');
  else {
    const w = s.worker;
    lines.push(
      `Worker: ${w.stale ? 'stale lock (no recent heartbeat)' : 'running'} — pid ${w.pid} on ${w.hostname}, ` +
        `started ${w.startedAt}, heartbeat ${w.heartbeatAt}`,
    );
  }

  lines.push('', `Repositories (${v.repos.length}):`);
  if (!v.repos.length) lines.push('  (none)');
  for (const r of v.repos) {
    const cp = r.checkpoint
      ? `checkpoint event ${r.checkpoint.lastEventId ?? '(none yet)'}, updated ${r.checkpoint.updatedAt}`
      : 'not polled yet';
    lines.push(`  ${r.fullName} (id ${r.id}) — ${r.workflows} workflow(s); ${cp}`);
  }
  for (const c of v.orphanCheckpoints) {
    lines.push(`  ${c.fullName} (id ${c.repoId}) — no longer configured; checkpoint event ${c.lastEventId ?? '(none)'}`);
  }

  lines.push('', 'Agents:');
  if (!s.agents.length) lines.push('  (none)');
  const width = Math.max(0, ...s.agents.map((a) => a.agent.length));
  for (const a of s.agents) {
    lines.push(
      `  ${a.agent.padEnd(width)}  ${a.enabled ? 'enabled ' : 'disabled'}  ${a.running}/${a.maxConcurrent} running`,
    );
  }

  lines.push('', `Queue: ${JOB_STATUSES.map((st) => `${st} ${s.counts[st] ?? 0}`).join(', ')}`);

  lines.push('', `Active runs (${s.activeRuns.length}):`);
  if (!s.activeRuns.length) lines.push('  (none)');
  for (const { run, job } of s.activeRuns) {
    // A claimed run that has not started yet is requeued if its worker stops; a started one is interrupted.
    const phase = run.executionStartedAt
      ? `running since ${run.executionStartedAt}`
      : `claimed ${run.startedAt}, not started yet`;
    lines.push(
      `  ${run.id}  ${job.repoFullName}#${job.issueNumber}  ${job.workflowId}  agent ${run.agent} (pool ${run.pool})  ${phase}`,
    );
  }

  lines.push('', 'Recent jobs:');
  if (!s.recentJobs.length) lines.push('  (none)');
  for (const j of s.recentJobs) {
    const reason = j.statusReason ? ` — ${oneLine(j.statusReason, 100)}` : '';
    lines.push(
      `  ${j.id}  ${j.status.padEnd(11)}  ${j.repoFullName}#${j.issueNumber}  ${j.workflowId}  updated ${j.updatedAt}${reason}`,
    );
  }

  lines.push('', 'Recent errors:');
  if (!s.recentErrors.length) lines.push('  (none)');
  for (const e of s.recentErrors) {
    const where = [e.repoFullName, e.jobId].filter(Boolean).join(' ');
    lines.push(`  ${e.at}  [${e.scope}]${where ? ` ${where}` : ''}: ${oneLine(e.message)}`);
  }
  return lines.join('\n');
}

export async function statusCommand(ctx: CommandContext, opts: { json?: boolean }): Promise<number> {
  const check = checkConfig(ctx.paths.configFile);
  let config: FactoryConfig | null = null;
  let configState: StatusView['configState'] = 'missing';
  let configMessage: string | null = null;
  if (check.state === 'ok') {
    config = check.config;
    configState = 'ok';
  } else if (check.state === 'invalid') {
    configState = 'invalid';
    configMessage = check.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
  } else if (check.state === 'unreadable') {
    configState = 'invalid';
    configMessage = check.message;
  }

  // Don't create state as a side effect of looking at it: use an empty in-memory DB when none exists.
  const dbExists = existsSync(ctx.paths.dbFile);
  const db = ctx.openDb(dbExists ? ctx.paths.dbFile : ':memory:');
  let snapshot: StatusSnapshot;
  try {
    snapshot = getStatusSnapshot(db, config ?? emptyConfig(), ctx.now);
  } finally {
    db.close();
  }

  const view = buildStatusView({
    configPath: ctx.paths.configFile,
    configState,
    configMessage,
    config,
    dbFile: ctx.paths.dbFile,
    dbExists,
    snapshot,
  });
  if (opts.json) println(ctx.out, JSON.stringify(view, null, 2));
  else println(ctx.out, renderStatus(view));
  return EXIT.OK;
}
