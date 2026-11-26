// `updraft doctor`, `updraft agents` and `updraft validate` for a containerized agent
// (agents.<name>.container): the runtime, the image and the CLI inside the image are checked,
// not a CLI on the host.
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { validateConfig } from '../config/validate.js';
import { agentSchema } from '../config/schema.js';
import { resolvePaths } from '../paths.js';
import { CONTAINER_HOME } from '../worker/container.js';
import { agentsCommand } from './agents.js';
import { buildWorkflow, seedConfig, upsertRepoWorkflow } from './config-edit.js';
import { runDoctor, type DoctorProbes, type RunResult } from './doctor.js';
import { containerAgentChecks, type ContainerCheckProbes } from './doctor-container.js';
import { EXIT } from './errors.js';
import { fakeAgentReport, fakeApi, fakeContext, fakeRepo, missingAgentReport, tempHome } from './fakes.js';

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string, code: number | null = 1): RunResult => ({ code, stdout: '', stderr });

/** A scripted runtime client: answers by subcommand and records what it was asked. */
function runtimeProbes(answers: Partial<Record<'info' | 'image' | 'run', RunResult>> = {}, env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'k' }) {
  const calls: string[][] = [];
  const probes: ContainerCheckProbes = {
    platform: 'linux',
    env,
    which: (c) => (c === 'docker' ? '/usr/bin/docker' : null),
    run: async (file, args) => {
      calls.push([file, ...args]);
      const sub = args[0] as 'info' | 'image' | 'run';
      return answers[sub] ?? (sub === 'run' ? ok('2.1.0 (Claude Code)\n') : ok());
    },
    user: '1000:1000',
  };
  return { probes, calls };
}

const claude = (container: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  agentSchema.parse({ ...extra, container: { image: 'my-org/claude-runner:latest', env: ['ANTHROPIC_API_KEY'], ...container } });

describe('containerAgentChecks', () => {
  it('passes when the runtime answers, the image is present and the CLI runs in it', async () => {
    const { probes, calls } = runtimeProbes();
    const checks = await containerAgentChecks('claude', 'claude', claude(), '/cfg', probes, 'fail');
    expect(checks).toEqual([
      { status: 'ok', detail: 'container runtime: /usr/bin/docker' },
      { status: 'ok', detail: 'image my-org/claude-runner:latest is present' },
      { status: 'ok', detail: 'claude 2.1.0 runs in the image as 1000:1000' },
    ]);
    expect(calls[0]).toEqual(['/usr/bin/docker', 'info']);
    expect(calls[1]).toEqual(['/usr/bin/docker', 'image', 'inspect', '--format', '{{.Id}}', 'my-org/claude-runner:latest']);
  });

  it('warns when the image\'s git is too old for a reftable clone the agent would work in', async () => {
    const answer = (git: RunResult) => {
      const calls: string[][] = [];
      const probes: ContainerCheckProbes = {
        platform: 'linux',
        env: { ANTHROPIC_API_KEY: 'k' },
        which: (c) => (c === 'docker' ? '/usr/bin/docker' : null),
        run: async (file, args) => {
          calls.push([file, ...args]);
          if (args[0] !== 'run') return ok();
          return args.at(-2) === 'git' ? git : ok('2.1.0 (Claude Code)\n');
        },
        user: '1000:1000',
      };
      return { probes, calls };
    };
    const clones = ['/work/widgets'];
    const old = answer(ok('git version 2.39.5\n'));
    const warned = await containerAgentChecks('claude', 'claude', claude(), '/cfg', old.probes, 'fail', clones);
    expect(warned.at(-1)).toEqual({ status: 'warn', detail: expect.stringMatching(/^git 2\.39 in image my-org\/claude-runner:latest, but \/work\/widgets uses the reftable ref store, which needs git 2\.45 or later/) });
    // It is asked the way the CLI is: in the image, no mounts, no network.
    const gitRun = old.calls.find((c) => c.at(-2) === 'git')!;
    expect(gitRun.slice(-3)).toEqual(['my-org/claude-runner:latest', 'git', '--version']);
    expect(gitRun).not.toContain('--mount');
    expect((await containerAgentChecks('claude', 'claude', claude(), '/cfg', answer(failed('not found', 127)).probes, 'fail', clones)).at(-1)?.detail).toMatch(/^no git in image/);
    // New enough, no reftable clone, or the host's git (the sandbox runtime): no warning, and no extra run.
    expect((await containerAgentChecks('claude', 'claude', claude(), '/cfg', answer(ok('git version 2.45.0\n')).probes, 'fail', clones)).map((c) => c.status)).not.toContain('warn');
    const none = answer(ok('git version 2.39.5\n'));
    expect((await containerAgentChecks('claude', 'claude', claude(), '/cfg', none.probes, 'fail', [])).map((c) => c.status)).not.toContain('warn');
    expect(none.calls.some((c) => c.at(-2) === 'git')).toBe(false);
    const host = answer(ok('git version 2.39.5\n'));
    host.probes.which = (c) => (c === '/opt/updraft/bin/updraft-sandbox' ? c : null);
    const sandboxed = claude({ runtime: '/opt/updraft/bin/updraft-sandbox', image: 'microvm' });
    expect((await containerAgentChecks('claude', 'claude', sandboxed, '/cfg', host.probes, 'fail', clones)).map((c) => c.status)).not.toContain('warn');
    expect(host.calls.some((c) => c.at(-2) === 'git')).toBe(false);
  });

  it('runs the CLI in the image as a live run would start it, with no mounts, no network and no credentials', async () => {
    const { probes, calls } = runtimeProbes();
    await containerAgentChecks('claude', 'claude', claude({ args: ['--memory', '4g'] }), '/cfg', probes, 'fail');
    const run = calls[2]!;
    expect(run.slice(0, 5)).toEqual(['/usr/bin/docker', 'run', '--rm', '-i', '--name']);
    expect(run[5]).toMatch(/^updraft-doctor-\d+-claude$/);
    expect(run.slice(-5)).toEqual(['--memory', '4g', 'my-org/claude-runner:latest', 'claude', '--version']);
    expect(run[run.indexOf('--user') + 1]).toBe('1000:1000');
    expect(run[run.indexOf('--network') + 1]).toBe('none');
    expect(run).not.toContain('--mount');
    // Only the scratch HOME: checking a version needs no API key.
    expect(run.flatMap((a, i) => (a === '-e' ? [run[i + 1]] : []))).toEqual([`HOME=${CONTAINER_HOME}`]);
  });

  it('checks agents.<name>.command inside the image, as written', async () => {
    const { probes, calls } = runtimeProbes({ run: ok('kiro-cli 3.1.0\n') });
    const checks = await containerAgentChecks('kiro', 'kiro', claude({}, { command: '/opt/kiro/bin/kiro-cli' }), '/cfg', probes, 'fail');
    expect(calls[2]!.slice(-2)).toEqual(['/opt/kiro/bin/kiro-cli', '--version']);
    expect(checks[2]).toEqual({ status: 'ok', detail: '/opt/kiro/bin/kiro-cli 3.1.0 runs in the image as 1000:1000' });
    // Without it, the adapter's CLI name.
    const second = runtimeProbes();
    await containerAgentChecks('kiro', 'kiro', claude(), '/cfg', second.probes, 'fail');
    expect(second.calls[2]!.slice(-2)).toEqual(['kiro-cli', '--version']);
  });

  it('reports a runtime that is not installed, and stops there', async () => {
    const { probes, calls } = runtimeProbes();
    const checks = await containerAgentChecks('claude', 'claude', claude({ runtime: 'podman' }), '/cfg', probes, 'fail');
    expect(checks).toEqual([{ status: 'fail', detail: 'container runtime "podman" not found on PATH (agents.claude.container.runtime)' }]);
    expect(calls).toEqual([]);
  });

  it('reports a runtime that is installed but not responding', async () => {
    const { probes, calls } = runtimeProbes({ info: failed('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?') });
    const checks = await containerAgentChecks('claude', 'claude', claude(), '/cfg', probes, 'warn');
    expect(checks).toEqual([
      { status: 'warn', detail: expect.stringMatching(/^container runtime \/usr\/bin\/docker is installed but not responding \(Cannot connect to the Docker daemon/) },
    ]);
    expect(calls).toHaveLength(1);
  });

  it('reports a missing image without trying to run (or pull) it', async () => {
    const { probes, calls } = runtimeProbes({ image: failed('Error response from daemon: No such image: my-org/claude-runner:latest') });
    const checks = await containerAgentChecks('claude', 'claude', claude(), '/cfg', probes, 'fail');
    expect(checks[1]).toEqual({ status: 'fail', detail: 'image my-org/claude-runner:latest is not present locally; build or pull it (a live run never pulls)' });
    expect(calls.map((c) => c[1])).toEqual(['info', 'image']);
  });

  it('reports a CLI that does not run in the image, and removes a check container that timed out', async () => {
    const missing = runtimeProbes({ run: failed('exec: "claude": executable file not found in $PATH', 127) });
    const checks = await containerAgentChecks('claude', 'claude', claude(), '/cfg', missing.probes, 'fail');
    expect(checks[2]).toEqual({
      status: 'fail',
      detail: '"claude --version" did not run in image my-org/claude-runner:latest as 1000:1000 (exec: "claude": executable file not found in $PATH)',
    });
    expect(missing.calls.map((c) => c[1])).toEqual(['info', 'image', 'run']);

    const hung = runtimeProbes({ run: failed('timed out', null) });
    await containerAgentChecks('claude', 'claude', claude(), '/cfg', hung.probes, 'fail');
    expect(hung.calls[3]!.slice(1, 3)).toEqual(['rm', '-f']);
    expect(hung.calls[3]![3]).toBe(hung.calls[2]![5]);
  });

  it('warns about a named variable this environment does not have', async () => {
    const { probes } = runtimeProbes({}, { PATH: '/usr/bin' });
    const checks = await containerAgentChecks('claude', 'claude', claude({ env: ['ANTHROPIC_API_KEY', 'NPM_TOKEN'] }), '/cfg', probes, 'fail');
    expect(checks[3]).toEqual({ status: 'warn', detail: 'container.env names ANTHROPIC_API_KEY, NPM_TOKEN, not set in this environment; the agent will start without them' });
  });

  it('is a failure on native Windows, pointing at WSL2', async () => {
    const { probes, calls } = runtimeProbes();
    const checks = await containerAgentChecks('claude', 'claude', claude(), '/cfg', { ...probes, platform: 'win32' }, 'fail');
    expect(checks).toEqual([{ status: 'fail', detail: expect.stringMatching(/not supported on native Windows.*WSL2/) }]);
    expect(calls).toEqual([]);
  });
});

function configWithContainer(home: string) {
  const paths = resolvePaths({ env: { UPDRAFT_HOME: home } });
  const cfg = upsertRepoWorkflow(
    seedConfig('allen'),
    { id: 10, fullName: 'o/r' },
    buildWorkflow({ label: 'updraft:ready', action: 'implement-issue', pool: 'general', routes: [] }),
  ).config;
  cfg.agents = { ...cfg.agents, claude: { maxConcurrent: 1, container: { image: 'runner:1', env: ['ANTHROPIC_API_KEY'] } } };
  writeFileSync(paths.configFile, stringify(cfg));
  return paths;
}

// These two run the whole command, which loads the config for the host it runs on, and on native
// Windows a config with `container` is invalid by design (covered above with platform: 'win32').
describe.skipIf(process.platform === 'win32')('updraft doctor with a containerized agent', () => {
  it('checks the runtime, image and in-image CLI for that agent and host discovery for the others', async () => {
    const paths = configWithContainer(tempHome());
    const discovered: string[] = [];
    const ran: string[][] = [];
    const probes: DoctorProbes = {
      nodeVersion: '22.13.0',
      platform: 'linux',
      cwd: '/work',
      user: 'allen',
      env: { PATH: '/usr/bin', KIRO_API_KEY: 'x', ANTHROPIC_API_KEY: 'k' },
      which: (cmd) => (['git', 'gh', 'docker'].includes(cmd) ? `/usr/bin/${cmd}` : null),
      run: async (file, args) => {
        ran.push([file, ...args]);
        return ok(file.endsWith('docker') && args[0] === 'run' ? '2.1.0 (Claude Code)\n' : '');
      },
      discoverAgent: async (adapter) => {
        discovered.push(adapter);
        return adapter === 'claude' ? missingAgentReport('claude') : fakeAgentReport(adapter as 'codex' | 'kiro');
      },
      checkWritable: () => {},
      checkDb: () => {},
      createApi: async () => fakeApi({ login: 'allen', repos: [fakeRepo('o/r', 10)], labels: { 'o/r': ['updraft:ready'] } }),
      fileExists: () => true,
    };
    const r = await runDoctor(paths, probes);
    const claudeChecks = r.checks.filter((c) => c.name === 'agent claude').map((c) => `${c.status} ${c.detail}`);
    expect(claudeChecks).toEqual([
      'ok container runtime: /usr/bin/docker',
      'ok image runner:1 is present',
      expect.stringMatching(/^ok claude 2\.1\.0 runs in the image/),
    ]);
    // The host has no claude CLI, and that is not a problem: it was never looked for.
    expect(discovered.sort()).toEqual(['codex', 'kiro']);
    expect(ran.filter((c) => c[0] === '/usr/bin/docker').map((c) => c[1])).toEqual(['info', 'image', 'run']);
    expect(r.ok).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('updraft agents with a containerized agent in the config', () => {
  it('lists it after the host CLIs, and counts it as usable', async () => {
    const home = tempHome();
    configWithContainer(home);
    const ctx = fakeContext({ home, agents: [missingAgentReport('claude')] });
    const { probes } = runtimeProbes();
    expect(await agentsCommand(ctx, {}, probes)).toBe(EXIT.OK);
    expect(ctx.out.text).toContain('✗ claude (claude): missing');
    expect(ctx.out.text).toContain('Containerized agents in the config (checked in their image, not on this host):');
    expect(ctx.out.text).toContain('✓ claude (adapter claude, image runner:1): ready');
    expect(ctx.out.text).toContain('    ✓ claude 2.1.0 runs in the image as 1000:1000');

    const json = fakeContext({ home, agents: [missingAgentReport('claude')] });
    const down = runtimeProbes({ info: failed('Cannot connect to the Docker daemon') });
    expect(await agentsCommand(json, { json: true }, down.probes)).toBe(EXIT.FAILURE);
    expect(JSON.parse(json.out.text).containers).toEqual([
      expect.objectContaining({ agent: 'claude', adapter: 'claude', image: 'runner:1', runtime: 'docker', usable: false }),
    ]);
  });

  it('says nothing about containers when there is no config or none is containerized', async () => {
    const ctx = fakeContext({ agents: [fakeAgentReport('claude')] });
    const { probes, calls } = runtimeProbes();
    expect(await agentsCommand(ctx, { json: true }, probes)).toBe(EXIT.OK);
    expect(JSON.parse(ctx.out.text)).not.toHaveProperty('containers');
    expect(calls).toEqual([]);
  });
});

describe('validateConfig: agents.<name>.container', () => {
  const config = (container: unknown, mode = 'log-only') => ({
    version: 1,
    execution: { mode },
    agents: { claude: { container } },
    pools: { general: { agents: ['claude'] } },
    actions: { 'implement-issue': { prompt: './p.md' } },
    dispatch: { allowedActors: ['allen'] },
  });

  it('accepts the documented shape and applies defaults', () => {
    const r = validateConfig(
      config({ image: 'my-org/claude-runner:latest', runtime: 'podman', env: ['ANTHROPIC_API_KEY'], network: 'bridge', args: ['--memory', '4g'] }),
      { platform: 'linux' },
    );
    expect(r.ok).toBe(true);
    const minimal = validateConfig(config({ image: 'runner' }), { platform: 'darwin' });
    expect(minimal.ok && minimal.config.agents.claude?.container).toEqual({ image: 'runner', runtime: 'docker', env: [] });
  });

  it('requires an image, and rejects option-like values, unknown keys and variable assignments', () => {
    const errorsFor = (container: unknown) => {
      const r = validateConfig(config(container), { platform: 'linux' });
      return r.ok ? [] : r.errors.map((e) => e.path);
    };
    expect(errorsFor({})).toEqual(['agents.claude.container.image']);
    expect(errorsFor({ image: '--privileged' })).toEqual(['agents.claude.container.image']);
    expect(errorsFor({ image: 'two words' })).toEqual(['agents.claude.container.image']);
    expect(errorsFor({ image: 'r', runtime: '-x' })).toEqual(['agents.claude.container.runtime']);
    expect(errorsFor({ image: 'r', network: '--net=host' })).toEqual(['agents.claude.container.network']);
    expect(errorsFor({ image: 'r', env: ['ANTHROPIC_API_KEY=sk-123'] })).toEqual(['agents.claude.container.env.0']);
    expect(errorsFor({ image: 'r', volumes: ['/:/host'] })).toEqual(['agents.claude.container']);
  });

  it('is an error on native Windows, pointing at WSL2', () => {
    const r = validateConfig(config({ image: 'runner' }), { platform: 'win32' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors).toEqual([{ path: 'agents.claude.container', message: expect.stringMatching(/not supported on native Windows yet; run the worker inside WSL2/) }]);
  });

  it('warns that the worker\'s GitHub tokens are withheld, and that a container only applies in live mode', () => {
    const r = validateConfig(config({ image: 'runner', env: ['GH_TOKEN', 'ANTHROPIC_API_KEY'] }), { platform: 'linux' });
    expect(r.ok).toBe(true);
    expect(r.warnings).toContainEqual({ path: 'agents.claude.container.env', message: expect.stringMatching(/GH_TOKEN is withheld from every agent/) });
    expect(r.warnings).toContainEqual({ path: 'agents.claude.container', message: 'only applies in live mode; in log-only mode no agent is started' });
  });
});
