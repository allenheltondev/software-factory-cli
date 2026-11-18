import { agentProfile } from '../agents/profile.js';
import { kiroV3Problem } from '../agents/adapters/kiro.js';
import type { AgentReport } from '../agents/discovery.js';
import { agentAdapter } from '../config/schema.js';
import { agentLookupEnv } from '../worker/live.js';
import { println, type CommandContext } from './context.js';
import { defaultDoctorProbes, type CheckResult, type DoctorProbes } from './doctor.js';
import { containerAgentChecks } from './doctor-container.js';
import { EXIT } from './errors.js';
import { checkConfig } from './validate.js';

export interface AgentsOptions {
  json?: boolean;
  deep?: boolean;
}

/** One-word state for an agent, most fundamental problem first. */
export function agentStatus(r: AgentReport): string {
  if (!r.installed) return 'missing';
  if (r.runnable !== 'yes') return 'not runnable';
  if (r.platform.supported === 'no') return 'unsupported here';
  if (r.signedIn === 'no') return 'not signed in';
  if (r.deep && !r.deep.ok) return 'prompt test failed';
  return 'ready';
}

/** Short hint for pickers: "ready · 2.1.0 · claude.ai", "missing", "not signed in · …". */
export function agentHint(r: AgentReport): string {
  const status = agentStatus(r);
  const parts = [status === 'ready' && r.signedIn === 'unknown' ? 'found, sign-in unknown' : status];
  if (r.version) parts.push(r.version);
  if (r.installed && !r.onPath) parts.push('not on PATH');
  return parts.join(' · ');
}

const triText = (t: string, detail: string | null) => `${t}${detail ? ` (${detail})` : ''}`;

export function renderAgents(reports: AgentReport[], deep = false): string {
  const lines: string[] = [];
  for (const r of reports) {
    const symbol = r.usable ? '✓' : r.installed ? '!' : '✗';
    lines.push(`${symbol} ${r.adapter} (${r.name}): ${agentStatus(r)}`);
    const row = (k: string, v: string) => lines.push(`    ${k.padEnd(10)}${v}`);
    row('command', r.command);
    if (r.path) row('path', `${r.path}${r.onPath ? '' : ' (not on PATH)'}`);
    if (r.launch && (r.launch.file !== r.path || r.launch.args.length)) {
      row('launch', [r.launch.file, ...r.launch.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '));
    }
    if (r.installed) row('version', r.version ?? 'unknown');
    row('signed in', triText(r.signedIn, r.auth));
    row('platform', triText(r.platform.supported, r.platform.detail));
    if (deep) row('prompt', r.deep ? triText(r.deep.ok ? 'ok' : 'failed', r.deep.detail) : 'skipped');
    for (const n of r.notes) row('note', n);
    const kiro = r.kiroV3 ? kiroV3Problem(r.version, r.kiroV3) : null;
    if (kiro) row('note', kiro);
  }
  const usable = reports.filter((r) => r.usable).length;
  lines.push('', `${usable} of ${reports.length} agent(s) usable here.`);
  return lines.join('\n');
}

/** A configured agent that runs in a container: checked in its image, not on this host. */
export interface ContainerAgentReport {
  agent: string;
  adapter: string;
  image: string;
  runtime: string;
  /** No check failed: the runtime answers, the image is present and the CLI runs in it. */
  usable: boolean;
  checks: Array<Omit<CheckResult, 'name'>>;
}

/**
 * The config's enabled containerized agents (agents.<name>.container), checked the way doctor
 * checks them. Empty when there is no valid config or none is containerized: discovery above is
 * about this host's CLIs and needs no config.
 */
export async function containerAgentReports(ctx: CommandContext, probes: Pick<DoctorProbes, 'platform' | 'env' | 'which' | 'run'>): Promise<ContainerAgentReport[]> {
  const cfg = checkConfig(ctx.paths.configFile);
  if (cfg.state !== 'ok') return [];
  const contained = Object.entries(cfg.config.agents).filter(([, a]) => a.enabled && a.container);
  return Promise.all(
    contained.map(async ([name, agent]) => {
      const adapter = agentAdapter(name, agent);
      const checks = await containerAgentChecks(name, adapter, agent, ctx.paths.configDir, { ...probes, env: agentLookupEnv(probes.env, agent) }, 'fail');
      return { agent: name, adapter, image: agent.container!.image, runtime: agent.container!.runtime, usable: !checks.some((c) => c.status === 'fail'), checks };
    }),
  );
}

export function renderContainerAgents(reports: ContainerAgentReport[]): string {
  const symbol = { ok: '✓', warn: '!', fail: '✗' } as const;
  const lines = ['', 'Containerized agents in the config (checked in their image, not on this host):'];
  for (const r of reports) {
    lines.push(`${r.usable ? '✓' : '✗'} ${r.agent} (adapter ${r.adapter}, image ${r.image}): ${r.usable ? 'ready' : 'not ready'}`);
    for (const c of r.checks) lines.push(`    ${symbol[c.status]} ${c.detail}`);
  }
  return lines.join('\n');
}

/** `updraft agents [--json] [--deep]`: exit 0 when at least one agent is usable. */
export async function agentsCommand(
  ctx: CommandContext,
  opts: AgentsOptions = {},
  probes: Pick<DoctorProbes, 'platform' | 'env' | 'which' | 'run'> = defaultDoctorProbes(ctx),
): Promise<number> {
  if (opts.deep) {
    println(ctx.err, 'warning: --deep sends one short prompt to each usable agent. This uses tokens or plan quota.');
  }
  const reports = await ctx.discoverAgents({ deep: Boolean(opts.deep) });
  const containers = await containerAgentReports(ctx, probes);
  const profiles = profileReports(ctx);
  if (opts.json) {
    println(ctx.out, JSON.stringify({ platform: process.platform, arch: process.arch, agents: reports, ...(containers.length ? { containers } : {}), ...(profiles.length ? { profiles } : {}) }, null, 2));
  } else {
    println(ctx.out, renderAgents(reports, opts.deep));
    if (containers.length) println(ctx.out, renderContainerAgents(containers));
    if (profiles.length) println(ctx.out, renderProfiles(profiles));
  }
  return reports.some((r) => r.usable) || containers.some((c) => c.usable) ? EXIT.OK : EXIT.FAILURE;
}

/** A configured agent entry (profile) and the model/effort it asks its CLI for. Read from the config; nothing is probed. */
export interface ProfileReport {
  agent: string;
  adapter: string;
  enabled: boolean;
  model: string | null;
  modelSource: string;
  effort: string | null;
  effortSource: string;
  /** Always the configured value: none of the CLIs reports which model a run resolved. */
  note: string;
  problems: string[];
}

/** The config's agent entries with their model/effort, empty when there is no valid config. */
export function profileReports(ctx: CommandContext): ProfileReport[] {
  const cfg = checkConfig(ctx.paths.configFile);
  if (cfg.state !== 'ok') return [];
  return Object.entries(cfg.config.agents).map(([name, agent]) => {
    const adapter = agentAdapter(name, agent);
    const p = agentProfile(adapter, agent);
    return {
      agent: name,
      adapter,
      enabled: agent.enabled,
      model: p.model.value,
      modelSource: p.model.source,
      effort: p.effort.value,
      effortSource: p.effort.source,
      note: 'configured values; the CLI decides the model it actually uses unless one is set here',
      problems: p.problems,
    };
  });
}

export function renderProfiles(reports: ProfileReport[]): string {
  const lines = ['', 'Agent profiles in the config (configured model/effort; not verified against the CLI):'];
  for (const r of reports) {
    const show = (v: string | null, src: string) => (v === null ? 'CLI default' : `${v} (${src})`);
    lines.push(`  ${r.agent} (adapter ${r.adapter}${r.enabled ? '' : ', disabled'}): model ${show(r.model, r.modelSource)}, effort ${show(r.effort, r.effortSource)}`);
    for (const p of r.problems) lines.push(`    ! ${p}`);
  }
  return lines.join('\n');
}
