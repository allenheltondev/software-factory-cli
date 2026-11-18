// Doctor checks for a containerized agent (agents.<name>.container). The agent CLI lives in the
// image, so host discovery says nothing about it: what must be on the host is a runtime that
// answers and the image, and the CLI is checked by running it in the image the way a live run
// starts it (same user, same scratch HOME, same container.args), without mounts or network.
import { parseVersion } from '../agents/discovery.js';
import type { AgentConfig } from '../config/schema.js';
import { buildContainerRunArgs, containerLaunch, hostUser, resolveRuntime } from '../worker/container.js';
import type { CheckResult, CheckStatus, RunResult } from './doctor.js';

export interface ContainerCheckProbes {
  platform: NodeJS.Platform;
  /** The environment a live run's runtime client gets (see agentLookupEnv). */
  env: NodeJS.ProcessEnv;
  which(command: string): string | null;
  /** Run an executable directly (no shell). */
  run(file: string, args: string[]): Promise<RunResult>;
  /** `uid:gid` the container runs as. Defaults to this process's. */
  user?: string;
}

const firstLine = (r: RunResult) => (r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? '';

/**
 * Checks for one enabled containerized agent. `sev` is the status for a problem that would stop a
 * live run (fail in live mode, warn otherwise). Nothing is pulled and nothing is mounted.
 */
export async function containerAgentChecks(
  agentName: string,
  adapter: string,
  agent: AgentConfig,
  configDir: string,
  probes: ContainerCheckProbes,
  sev: CheckStatus,
): Promise<Array<Omit<CheckResult, 'name'>>> {
  const container = agent.container!;
  if (probes.platform === 'win32') {
    return [{ status: sev, detail: 'containerized agents are not supported on native Windows; run the worker inside WSL2' }];
  }
  const out: Array<Omit<CheckResult, 'name'>> = [];
  const runtime = resolveRuntime(container.runtime, { env: probes.env, configDir, which: probes.which });
  if (!runtime) {
    return [{ status: sev, detail: `container runtime "${container.runtime}" not found${container.runtime.includes('/') ? '' : ' on PATH'} (agents.${agentName}.container.runtime)` }];
  }
  const info = await probes.run(runtime, ['info']).catch((err: unknown) => ({ code: null, stdout: '', stderr: String(err) }));
  if (info.code !== 0) {
    return [{ status: sev, detail: `container runtime ${runtime} is installed but not responding${firstLine(info) ? ` (${firstLine(info)})` : ''}` }];
  }
  out.push({ status: 'ok', detail: `container runtime: ${runtime}` });

  const image = await probes.run(runtime, ['image', 'inspect', '--format', '{{.Id}}', container.image]).catch(() => null);
  if (image?.code !== 0) {
    out.push({ status: sev, detail: `image ${container.image} is not present locally; build or pull it (a live run never pulls)` });
    return out;
  }
  out.push({ status: 'ok', detail: `image ${container.image} is present` });

  const cli = containerLaunch(adapter, agent).file;
  const user = probes.user ?? hostUser();
  const name = `factory-doctor-${process.pid}-${agentName}`;
  const version = await probes
    .run(runtime, buildContainerRunArgs({ file: cli, args: ['--version'] }, { image: container.image, name, mounts: [], user, network: 'none', extraArgs: container.args }))
    .catch((err: unknown) => ({ code: null, stdout: '', stderr: String(err) }));
  // A check that timed out may have left its container behind.
  if (version.code === null) await probes.run(runtime, ['rm', '-f', name]).catch(() => undefined);
  if (version.code === 0) {
    out.push({ status: 'ok', detail: `${cli} ${parseVersion(version.stdout) ?? '(unknown version)'} runs in the image${user ? ` as ${user}` : ''}` });
  } else {
    out.push({
      status: sev,
      detail: `"${cli} --version" did not run in image ${container.image}${user ? ` as ${user}` : ''}${firstLine(version) ? ` (${firstLine(version)})` : ''}`,
    });
  }

  const unset = container.env.filter((n) => !probes.env[n]);
  if (unset.length) {
    out.push({ status: 'warn', detail: `container.env names ${unset.join(', ')}, not set in this environment; the agent will start without ${unset.length > 1 ? 'them' : 'it'}` });
  }
  // Whether the agent is signed in depends on those variables inside the container; not checked here.
  return out;
}
