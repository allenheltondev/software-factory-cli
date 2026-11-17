import { kiroV3Problem } from '../agents/adapters/kiro.js';
import type { AgentReport } from '../agents/discovery.js';
import { println, type CommandContext } from './context.js';
import { EXIT } from './errors.js';

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

/** `factory agents [--json] [--deep]`: exit 0 when at least one agent is usable. */
export async function agentsCommand(ctx: CommandContext, opts: AgentsOptions = {}): Promise<number> {
  if (opts.deep) {
    println(ctx.err, 'warning: --deep sends one short prompt to each usable agent. This uses tokens or plan quota.');
  }
  const reports = await ctx.discoverAgents({ deep: Boolean(opts.deep) });
  if (opts.json) println(ctx.out, JSON.stringify({ platform: process.platform, arch: process.arch, agents: reports }, null, 2));
  else println(ctx.out, renderAgents(reports, opts.deep));
  return reports.some((r) => r.usable) ? EXIT.OK : EXIT.FAILURE;
}
