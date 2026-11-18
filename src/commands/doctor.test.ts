import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { resolvePaths } from '../paths.js';
import { buildWorkflow, seedConfig, upsertRepoWorkflow } from './config-edit.js';
import type { AdapterName } from '../config/schema.js';
import { agentChecks, agentProblemSeverity, doctorCommand, nodeVersionOk, renderDoctor, runDoctor, type DoctorProbes } from './doctor.js';
import type { AgentReport } from '../agents/discovery.js';
import { fakeAgentReport, fakeApi, fakeContext, fakeRepo, missingAgentReport, tempHome } from './fakes.js';
import { registerAdapter } from '../agents/adapters/registry.js';
import { fakeAdapter } from '../../test/fake-adapter.js';

function setup(o: { labels?: string[]; repoId?: number; kiro?: boolean } = {}) {
  const home = tempHome();
  const paths = resolvePaths({ env: { UPDRAFT_HOME: home } });
  let cfg = upsertRepoWorkflow(
    seedConfig('allen'),
    { id: 10, fullName: 'o/r' },
    buildWorkflow({ label: 'updraft:ready', action: 'implement-issue', pool: 'general', routes: [{ hasLabel: 'art', use: 'general' }] }),
  ).config;
  if (o.kiro === false) cfg = { ...cfg, agents: { ...cfg.agents, kiro: { maxConcurrent: 1, enabled: false } } };
  writeFileSync(paths.configFile, stringify(cfg));
  const api = fakeApi({
    login: 'allen',
    repos: [fakeRepo('o/r', o.repoId ?? 10)],
    labels: { 'o/r': o.labels ?? ['updraft:ready', 'art'] },
  });
  const probes: DoctorProbes = {
    nodeVersion: '22.13.0',
    platform: 'linux',
    cwd: '/work',
    user: 'allen',
    env: { PATH: '/usr/bin:/bin:/opt/bin', KIRO_API_KEY: 'x' },
    which: (cmd) => (['git', 'gh', 'codex', 'claude', 'kiro-cli'].includes(cmd) ? `/usr/bin/${cmd}` : null),
    run: async (file) => ({ code: 0, stdout: file.endsWith('git') ? 'git version 2.50.0\n' : '', stderr: '' }),
    discoverAgent: async (adapter) => fakeAgentReport(adapter as AdapterName),
    checkWritable: () => {},
    checkDb: () => {},
    createApi: async () => api,
    fileExists: () => true,
  };
  return { paths, probes, home };
}

const status = (checks: { status: string; name: string; detail: string }[], re: RegExp) =>
  checks.find((c) => re.test(`${c.name}: ${c.detail}`))?.status;

describe('nodeVersionOk', () => {
  it('compares major.minor', () => {
    expect(nodeVersionOk('22.13.0')).toBe(true);
    expect(nodeVersionOk('v24.1.0')).toBe(true);
    expect(nodeVersionOk('22.12.9')).toBe(false);
    expect(nodeVersionOk('20.19.0')).toBe(false);
  });
});

describe('runDoctor', () => {
  it('passes when everything is in place', async () => {
    const { paths, probes } = setup();
    const r = await runDoctor(paths, probes);
    expect(r.checks.filter((c) => c.status !== 'ok')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.environment.pathEntries).toBe(3);
    expect(status(r.checks, /git: \/usr\/bin\/git \(git version 2\.50\.0\)/)).toBe('ok');
    expect(status(r.checks, /github: token works; authenticated as allen/)).toBe('ok');
    expect(status(r.checks, /trigger label "updraft:ready" exists/)).toBe('ok');
    expect(status(r.checks, /agent kiro: kiro-cli 1\.0\.0: \/usr\/bin\/kiro-cli/)).toBe('ok');
    expect(status(r.checks, /agent claude: signed in: test/)).toBe('ok');
    const text = renderDoctor(r);
    expect(text).toContain('✓ node: v22.13.0');
    expect(text).toContain('All checks passed.');
  });

  it('fails on old node, missing config, missing git, and unauthenticated gh', async () => {
    const { probes } = setup();
    const paths = resolvePaths({ env: { UPDRAFT_HOME: tempHome() } });
    const r = await runDoctor(paths, {
      ...probes,
      nodeVersion: '20.0.0',
      which: (cmd) => (cmd === 'gh' ? '/usr/bin/gh' : null),
      run: async () => ({ code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.\n' }),
    });
    expect(r.ok).toBe(false);
    expect(status(r.checks, /^node/)).toBe('fail');
    expect(status(r.checks, /^config: not found/)).toBe('fail');
    expect(status(r.checks, /^git: not found/)).toBe('fail');
    expect(status(r.checks, /^gh: .*not authenticated.*not logged into/)).toBe('fail');
    expect(renderDoctor(r)).toMatch(/✗ git: not found on PATH/);
  });

  it('treats a missing gh as a warning when GH_TOKEN is set', async () => {
    const { paths, probes } = setup();
    const r = await runDoctor(paths, { ...probes, env: { ...probes.env, GH_TOKEN: 't' }, which: (c) => (c === 'gh' ? null : `/bin/${c}`) });
    expect(status(r.checks, /^gh:/)).toBe('warn');
    expect(r.ok).toBe(true);
  });

  it('fails on a repo ID mismatch, and on a missing trigger label', async () => {
    const mismatch = setup({ repoId: 11 });
    const r1 = await runDoctor(mismatch.paths, mismatch.probes);
    expect(status(r1.checks, /repo o\/r: ID mismatch: config has 10, GitHub has 11/)).toBe('fail');

    const nolabel = setup({ labels: [] });
    const r2 = await runDoctor(nolabel.paths, nolabel.probes);
    expect(status(r2.checks, /trigger label "updraft:ready" is missing/)).toBe('fail');
    expect(status(r2.checks, /routing label "art" does not exist/)).toBe('warn');
    expect(r2.ok).toBe(false);
  });

  it('fails when the GitHub API cannot be used and skips repo checks', async () => {
    const { paths, probes } = setup();
    const r = await runDoctor(paths, {
      ...probes,
      createApi: async () => {
        throw new Error('no GitHub token: run "gh auth login"');
      },
    });
    expect(status(r.checks, /^github: cannot use the GitHub API: no GitHub token/)).toBe('fail');
    expect(r.checks.some((c) => c.name.startsWith('repo '))).toBe(false);
  });

  it('only warns about agent problems in log-only mode, using discovery for enabled agents', async () => {
    const { paths, probes } = setup();
    const asked: string[] = [];
    const reports: Record<string, AgentReport> = {
      codex: missingAgentReport('codex'),
      claude: fakeAgentReport('claude', { signedIn: 'no', auth: 'not signed in; run "claude auth login"', usable: false }),
      kiro: { ...missingAgentReport('kiro'), signedIn: 'no', auth: 'KIRO_API_KEY is not set; headless Kiro requires it' },
    };
    const r = await runDoctor(paths, {
      ...probes,
      discoverAgent: async (adapter) => {
        asked.push(adapter);
        return reports[adapter];
      },
    });
    expect(asked.sort()).toEqual(['claude', 'codex', 'kiro']);
    expect(status(r.checks, /agent codex: codex not found on PATH or in common install locations/)).toBe('warn');
    expect(status(r.checks, /agent claude: not signed in/)).toBe('warn');
    expect(status(r.checks, /agent kiro: kiro-cli not found/)).toBe('warn');
    expect(status(r.checks, /agent kiro: not signed in: KIRO_API_KEY is not set/)).toBe('warn');
    expect(r.ok).toBe(true);

    const noKiro = setup({ kiro: false });
    const r2 = await runDoctor(noKiro.paths, { ...noKiro.probes, env: { PATH: '/bin' } });
    expect(r2.checks.some((c) => c.name === 'agent kiro')).toBe(false);
  });

  it('checks each agent as a live run starts it: its command, and its env without the GitHub tokens', async () => {
    const home = tempHome();
    const paths = resolvePaths({ env: { UPDRAFT_HOME: home } });
    const cfg = upsertRepoWorkflow(
      seedConfig('allen'),
      { id: 10, fullName: 'o/r' },
      buildWorkflow({ label: 'updraft:ready', action: 'implement-issue', pool: 'general', routes: [] }),
    ).config;
    cfg.agents = {
      ...cfg.agents,
      codex: { maxConcurrent: 1, command: './bin/codex', env: { CODEX_API_KEY: 'from-config' } },
      'claude-2': { adapter: 'claude', maxConcurrent: 1, command: 'claude-nightly' },
    };
    writeFileSync(paths.configFile, stringify(cfg));
    const { probes } = setup();
    const asked: Array<{ adapter: string; command?: string; baseDir: string; env: NodeJS.ProcessEnv }> = [];
    const r = await runDoctor(paths, {
      ...probes,
      env: { PATH: '/usr/bin', GH_TOKEN: 'gh-secret', GITHUB_TOKEN: 'gh-secret-2', KIRO_API_KEY: 'k' },
      discoverAgent: async (adapter, opts) => {
        asked.push({ adapter, ...opts });
        return opts.command
          ? { ...missingAgentReport(adapter as AdapterName), command: opts.command, configuredCommand: true }
          : fakeAgentReport(adapter as AdapterName);
      },
    });

    const codex = asked.find((a) => a.adapter === 'codex')!;
    expect(codex).toMatchObject({ command: './bin/codex', baseDir: paths.configDir });
    expect(codex.env).toMatchObject({ PATH: '/usr/bin', CODEX_API_KEY: 'from-config', KIRO_API_KEY: 'k' });
    expect(codex.env.GH_TOKEN).toBeUndefined();
    expect(codex.env.GITHUB_TOKEN).toBeUndefined();
    expect(asked.find((a) => a.adapter === 'kiro')).toMatchObject({ baseDir: paths.configDir });
    expect(asked.find((a) => a.adapter === 'kiro')!.command).toBeUndefined();
    // Two agents on the same adapter are checked separately.
    expect(asked.filter((a) => a.adapter === 'claude').map((a) => a.command ?? null).sort()).toEqual(['claude-nightly', null].sort());
    expect(status(r.checks, /agent codex: configured command \.\/bin\/codex was not found or is not executable/)).toBe('warn');
    expect(status(r.checks, /agent claude-2: configured command claude-nightly was not found/)).toBe('warn');
  });

  it('fails on agent problems for enabled agents in live mode', async () => {
    const restore = (['codex', 'claude', 'kiro'] as const).map((name) => registerAdapter(fakeAdapter({ name })));
    try {
      const home = tempHome();
      const paths = resolvePaths({ env: { UPDRAFT_HOME: home } });
      const cfg = upsertRepoWorkflow(
        seedConfig('allen'),
        { id: 10, fullName: 'o/r' },
        buildWorkflow({ label: 'updraft:ready', action: 'implement-issue', pool: 'general', routes: [] }),
      ).config;
      cfg.execution = { mode: 'live' };
      cfg.repositories!['o/r']!.checkoutPath = 'clones/r';
      writeFileSync(paths.configFile, stringify(cfg));
      const { probes } = setup();
      const r = await runDoctor(paths, {
        ...probes,
        discoverAgent: async (adapter) =>
          ({
            codex: missingAgentReport('codex'),
            claude: fakeAgentReport('claude', { signedIn: 'no', auth: 'not signed in; run "claude auth login"', usable: false }),
            kiro: fakeAgentReport('kiro'),
          })[adapter],
      });
      expect(status(r.checks, /^config: valid/)).toBe('ok');
      expect(status(r.checks, /agent codex: codex not found on PATH/)).toBe('fail');
      expect(status(r.checks, /agent claude: not signed in/)).toBe('fail');
      expect(status(r.checks, /agent kiro: kiro-cli 1\.0\.0/)).toBe('ok');
      expect(r.ok).toBe(false);
    } finally {
      for (const r of restore) r();
    }
  });

  it('checks push access for repos that publish: a failure in live mode, a warning otherwise', async () => {
    const restore = (['codex', 'claude', 'kiro'] as const).map((name) => registerAdapter(fakeAdapter({ name })));
    try {
      const run = async (mode: 'live' | 'log-only', push: boolean | null) => {
        const home = tempHome();
        const paths = resolvePaths({ env: { UPDRAFT_HOME: home } });
        const cfg = upsertRepoWorkflow(
          seedConfig('allen'),
          { id: 10, fullName: 'o/r' },
          buildWorkflow({ label: 'updraft:ready', action: 'implement-issue', pool: 'general', routes: [] }),
        ).config;
        cfg.execution = { mode };
        cfg.repositories!['o/r']!.checkoutPath = 'clones/r';
        (cfg.repositories!['o/r'] as { publish?: string }).publish = 'draft-pr';
        writeFileSync(paths.configFile, stringify(cfg));
        const { probes } = setup();
        const repo = fakeRepo('o/r', 10, {
          private: true,
          permissions: push === null ? null : { admin: false, push, pull: true },
        });
        const api = fakeApi({ login: 'allen', repos: [repo], labels: { 'o/r': ['updraft:ready'] } });
        return runDoctor(paths, { ...probes, createApi: async () => api });
      };
      const denied = await run('live', false);
      expect(status(denied.checks, /repo o\/r: publish: draft-pr, but the active GitHub account has no push access.*"repo" scope/)).toBe('fail');
      expect(denied.ok).toBe(false);
      expect(status((await run('log-only', false)).checks, /no push access/)).toBe('warn');
      const ok = await run('live', true);
      expect(status(ok.checks, /repo o\/r: publish: draft-pr; the active GitHub account can push.*use publish: pr/)).toBe('ok');
      expect(status((await run('live', null)).checks, /push access is unverified/)).toBe('warn');
    } finally {
      for (const r of restore) r();
    }
  });

  it('checks what a failure comment needs for repos with commentOnFailure: read access and a repository that is not archived', async () => {
    const restore = (['codex', 'claude', 'kiro'] as const).map((name) => registerAdapter(fakeAdapter({ name })));
    try {
      const run = async (mode: 'live' | 'log-only', extra: Parameters<typeof fakeRepo>[2], commentOnFailure = true) => {
        const home = tempHome();
        const paths = resolvePaths({ env: { UPDRAFT_HOME: home } });
        const cfg = upsertRepoWorkflow(
          seedConfig('allen'),
          { id: 10, fullName: 'o/r' },
          buildWorkflow({ label: 'updraft:ready', action: 'implement-issue', pool: 'general', routes: [] }),
        ).config;
        cfg.execution = { mode };
        cfg.repositories!['o/r']!.checkoutPath = 'clones/r';
        if (commentOnFailure) (cfg.repositories!['o/r'] as { commentOnFailure?: boolean }).commentOnFailure = true;
        writeFileSync(paths.configFile, stringify(cfg));
        const { probes } = setup();
        const api = fakeApi({ login: 'allen', repos: [fakeRepo('o/r', 10, extra)], labels: { 'o/r': ['updraft:ready'] } });
        return runDoctor(paths, { ...probes, createApi: async () => api });
      };
      // Read access is enough: no push access is needed to comment.
      const readOnly = await run('live', { permissions: { admin: false, push: false, pull: true } });
      expect(status(readOnly.checks, /repo o\/r: commentOnFailure: the active GitHub account can read the repository/)).toBe('ok');
      expect(readOnly.checks.some((c) => /push access/.test(c.detail))).toBe(false);

      const archived = await run('live', { archived: true });
      expect(status(archived.checks, /repo o\/r: commentOnFailure: o\/r is archived \(read-only\)/)).toBe('fail');
      expect(archived.ok).toBe(false);
      expect(status((await run('log-only', { archived: true })).checks, /commentOnFailure: o\/r is archived/)).toBe('warn');

      const noRead = await run('live', { permissions: { admin: false, push: false, pull: false } });
      expect(status(noRead.checks, /commentOnFailure: the active GitHub account has no read access to o\/r.*Issues set to read and write/)).toBe('fail');
      expect(status((await run('live', { permissions: null })).checks, /commentOnFailure: .*read access is unverified/)).toBe('warn');

      const off = await run('live', { archived: true }, false);
      expect(off.checks.some((c) => /commentOnFailure/.test(c.detail))).toBe(false);
    } finally {
      for (const r of restore) r();
    }
  });

  it('agentChecks: off-PATH and unknown sign-in warn; problems are failures only in live mode', () => {
    expect(agentProblemSeverity('log-only')).toBe('warn');
    expect(agentProblemSeverity('prepare-only')).toBe('warn');
    expect(agentProblemSeverity('live')).toBe('fail');
    const offPath = agentChecks(fakeAgentReport('codex', { onPath: false, signedIn: 'unknown', notes: ['found outside PATH'] }), 'fail');
    expect(offPath.map((c) => c.status)).toEqual(['ok', 'warn', 'warn']);
    expect(offPath[1]?.detail).toMatch(/not on this PATH/);
    const broken = agentChecks(
      fakeAgentReport('claude', { runnable: 'no', version: null, signedIn: 'unknown', platform: { supported: 'no', detail: 'ppc64 is not supported' } }),
      'fail',
    );
    expect(broken).toEqual([
      { status: 'fail', detail: expect.stringMatching(/found at \/usr\/bin\/claude but did not run/) },
      { status: 'fail', detail: 'not supported on this machine: ppc64 is not supported' },
    ]);
    expect(agentChecks(undefined, 'warn')).toEqual([{ status: 'warn', detail: 'unknown adapter; not checked' }]);
  });

  it('agentChecks: a Kiro CLI older than 3.0 is a warning, even in live mode, unless the args pick a harness', () => {
    const older =
      'Kiro CLI 2.4.1 is older than 3.0.0, the release Updraft is written against. Updraft starts Kiro with --v3; earlier releases that have the V3 harness may work but are not verified. If live runs fail to start, upgrade Kiro CLI or add --v2 to agents.kiro.args';
    const old = fakeAgentReport('kiro', { version: '2.4.1', kiroV3: 'no' });
    // Older than the baseline is unverified, not known broken (--v3 shipped before 3.0): never a failure.
    expect(agentChecks(old, 'fail', { name: 'kiro' })).toContainEqual({ status: 'warn', detail: older });
    expect(agentChecks(old, 'fail', { name: 'kiro' }).map((c) => c.status)).not.toContain('fail');
    expect(agentChecks(old, 'warn', { name: 'kiro', args: [] })).toContainEqual({ status: 'warn', detail: older });
    // --v2 (or --v3 / --agent-engine, as the adapter reads them) means the adapter adds no --v3.
    for (const args of [['--v2'], ['--agent-engine=v2'], ['--v3']]) {
      expect(agentChecks(old, 'fail', { name: 'kiro', args }).map((c) => c.status)).toEqual(['ok', 'ok']);
    }
    expect(agentChecks(fakeAgentReport('kiro', { version: '3.0.0', kiroV3: 'yes' }), 'fail', { name: 'kiro' }).map((c) => c.status)).toEqual(['ok', 'ok']);
    // An unreadable version is a warning, never a failure.
    const unknown = agentChecks(fakeAgentReport('kiro', { version: 'nightly', kiroV3: 'unknown' }), 'fail', { name: 'kiro' });
    expect(unknown).toEqual([
      { status: 'ok', detail: 'kiro-cli nightly: /usr/bin/kiro-cli' },
      { status: 'warn', detail: 'could not read a Kiro CLI version from "nightly", so it is unknown whether it is 3.0.0 or later. Updraft starts Kiro with --v3. If live runs fail to start, upgrade Kiro CLI or add --v2 to agents.kiro.args' },
      { status: 'ok', detail: 'signed in: test' },
    ]);
  });

  it('checks the Kiro version against each agent\'s configured args in live mode', async () => {
    const restore = (['codex', 'claude', 'kiro'] as const).map((name) => registerAdapter(fakeAdapter({ name })));
    try {
      const run = async (args?: string[]) => {
        const home = tempHome();
        const paths = resolvePaths({ env: { UPDRAFT_HOME: home } });
        const cfg = upsertRepoWorkflow(
          seedConfig('allen'),
          { id: 10, fullName: 'o/r' },
          buildWorkflow({ label: 'updraft:ready', action: 'implement-issue', pool: 'general', routes: [] }),
        ).config;
        cfg.execution = { mode: 'live' };
        cfg.repositories!['o/r']!.checkoutPath = 'clones/r';
        cfg.agents = { ...cfg.agents, kiro: { ...cfg.agents!.kiro!, ...(args ? { args } : {}) } };
        writeFileSync(paths.configFile, stringify(cfg));
        const { probes } = setup();
        return runDoctor(paths, {
          ...probes,
          discoverAgent: async (adapter) =>
            fakeAgentReport(adapter as AdapterName, adapter === 'kiro' ? { version: '2.4.1', kiroV3: 'no' } : {}),
        });
      };
      const old = await run();
      // A warning that names this agent's own args key, and doctor still passes.
      expect(status(old.checks, /^agent kiro: Kiro CLI 2\.4\.1 is older than 3\.0\.0.*add --v2 to agents\.kiro\.args$/)).toBe('warn');
      expect(old.checks.filter((c) => c.name === 'agent kiro').map((c) => c.status)).not.toContain('fail');
      const v2 = await run(['--v2']);
      expect(v2.checks.filter((c) => c.name === 'agent kiro').map((c) => c.status)).toEqual(['ok', 'ok']);
    } finally {
      for (const r of restore) r();
    }
  });

  it('reports state dir and DB failures', async () => {
    const { paths, probes } = setup();
    const r = await runDoctor(paths, {
      ...probes,
      checkWritable: () => {
        throw new Error('EACCES');
      },
      checkDb: () => {
        throw new Error('database is locked');
      },
    });
    expect(status(r.checks, /^state dir: not writable.*EACCES/)).toBe('fail');
    expect(status(r.checks, /^state db: cannot open.*locked/)).toBe('fail');
  });
});

describe('updraft doctor', () => {
  it('exits 1 on failure and prints JSON with --json', async () => {
    const { probes, home } = setup({ labels: [] });
    const ctx = fakeContext({ home });
    expect(await doctorCommand(ctx, { json: true }, probes)).toBe(1);
    const json = JSON.parse(ctx.out.text);
    expect(json.ok).toBe(false);
    expect(json.environment.user).toBe('allen');

    const ok = setup();
    const ctx2 = fakeContext({ home: ok.home });
    expect(await doctorCommand(ctx2, {}, ok.probes)).toBe(0);
  });
});

describe('runDoctor profile capability check', () => {
  function withKiroProfile(extra: Record<string, unknown>) {
    const s = setup();
    const cfg = parse(readFileSync(s.paths.configFile, 'utf8'));
    cfg.agents.kiro = { ...cfg.agents.kiro, ...extra };
    writeFileSync(s.paths.configFile, stringify(cfg));
    return s;
  }
  const helpRun = (help: string, seen: string[][] = []): DoctorProbes['run'] => async (file, args) => {
    seen.push([file, ...args]);
    return args.includes('--help') ? { code: 0, stdout: help, stderr: '' } : { code: 0, stdout: file.endsWith('git') ? 'git version 2.50.0\n' : '', stderr: '' };
  };

  it('reports the profile and passes when the CLI help advertises the options', async () => {
    const { paths, probes } = withKiroProfile({ model: 'm 1', effort: 'high' });
    const seen: string[][] = [];
    const r = await runDoctor(paths, { ...probes, run: helpRun('--model <M>\n--effort <L>\n', seen) });
    expect(status(r.checks, /agent kiro profile: .*model "m 1".*effort "high"/)).toBe('ok');
    expect(r.checks.some((c) => /does not advertise/.test(c.detail))).toBe(false);
    expect(seen.filter((c) => c.includes('--help')).every((c) => c.includes('chat'))).toBe(true);
  });

  it('fails in live mode, with a remedy, when the CLI does not advertise --effort', async () => {
    const { paths, probes } = withKiroProfile({ effort: 'high' });
    const r = await runDoctor(paths, { ...probes, run: helpRun('--model <M>\n') });
    const c = r.checks.find((x) => /does not advertise --effort/.test(x.detail));
    expect(c?.name).toBe('agent kiro');
    expect(c?.detail).toMatch(/remove effort/);
    expect(c?.status).not.toBe('ok');
  });

  it('warns that it is unverified when help cannot be read', async () => {
    const { paths, probes } = withKiroProfile({ model: 'x' });
    const r = await runDoctor(paths, { ...probes, run: async () => ({ code: 1, stdout: '', stderr: '' }) });
    expect(status(r.checks, /agent kiro: could not read Kiro CLI's help text.*unverified/)).toBe('warn');
  });

  it('shows the profile line for CLI-default profiles too', async () => {
    const { paths, probes } = setup();
    const r = await runDoctor(paths, probes);
    expect(status(r.checks, /agent kiro profile: .*model CLI default/)).toBe('ok');
  });
});