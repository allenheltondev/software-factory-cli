import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { resolvePaths } from '../paths.js';
import { buildWorkflow, seedConfig, upsertRepoWorkflow } from './config-edit.js';
import type { AdapterName } from '../config/schema.js';
import { agentChecks, agentProblemSeverity, doctorCommand, nodeVersionOk, renderDoctor, runDoctor, type DoctorProbes } from './doctor.js';
import { fakeAgentReport, fakeApi, fakeContext, fakeRepo, missingAgentReport, tempHome } from './fakes.js';

function setup(o: { labels?: string[]; repoId?: number; kiro?: boolean } = {}) {
  const home = tempHome();
  const paths = resolvePaths({ env: { FACTORY_HOME: home } });
  let cfg = upsertRepoWorkflow(
    seedConfig('allen'),
    { id: 10, fullName: 'o/r' },
    buildWorkflow({ label: 'factory:ready', action: 'implement-issue', pool: 'general', routes: [{ hasLabel: 'art', use: 'general' }] }),
  ).config;
  if (o.kiro === false) cfg = { ...cfg, agents: { ...cfg.agents, kiro: { maxConcurrent: 1, enabled: false } } };
  writeFileSync(paths.configFile, stringify(cfg));
  const api = fakeApi({
    login: 'allen',
    repos: [fakeRepo('o/r', o.repoId ?? 10)],
    labels: { 'o/r': o.labels ?? ['factory:ready', 'art'] },
  });
  const probes: DoctorProbes = {
    nodeVersion: '22.13.0',
    platform: 'linux',
    cwd: '/work',
    user: 'allen',
    env: { PATH: '/usr/bin:/bin:/opt/bin', KIRO_API_KEY: 'x' },
    which: (cmd) => (['git', 'gh', 'codex', 'claude', 'kiro-cli'].includes(cmd) ? `/usr/bin/${cmd}` : null),
    run: async (file) => ({ code: 0, stdout: file.endsWith('git') ? 'git version 2.50.0\n' : '', stderr: '' }),
    discoverAgents: async (adapters) => adapters.map((a) => fakeAgentReport(a as AdapterName)),
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
    expect(status(r.checks, /trigger label "factory:ready" exists/)).toBe('ok');
    expect(status(r.checks, /agent kiro: kiro-cli 1\.0\.0: \/usr\/bin\/kiro-cli/)).toBe('ok');
    expect(status(r.checks, /agent claude: signed in: test/)).toBe('ok');
    const text = renderDoctor(r);
    expect(text).toContain('✓ node: v22.13.0');
    expect(text).toContain('All checks passed.');
  });

  it('fails on old node, missing config, missing git, and unauthenticated gh', async () => {
    const { probes } = setup();
    const paths = resolvePaths({ env: { FACTORY_HOME: tempHome() } });
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
    expect(status(r2.checks, /trigger label "factory:ready" is missing/)).toBe('fail');
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
    const asked: string[][] = [];
    const r = await runDoctor(paths, {
      ...probes,
      discoverAgents: async (adapters) => {
        asked.push(adapters);
        return [
          missingAgentReport('codex'),
          fakeAgentReport('claude', { signedIn: 'no', auth: 'not signed in; run "claude auth login"', usable: false }),
          { ...missingAgentReport('kiro'), signedIn: 'no', auth: 'KIRO_API_KEY is not set; headless Kiro requires it' },
        ];
      },
    });
    expect(asked).toEqual([['codex', 'claude', 'kiro']]);
    expect(status(r.checks, /agent codex: codex not found on PATH or in common install locations/)).toBe('warn');
    expect(status(r.checks, /agent claude: not signed in/)).toBe('warn');
    expect(status(r.checks, /agent kiro: kiro-cli not found/)).toBe('warn');
    expect(status(r.checks, /agent kiro: not signed in: KIRO_API_KEY is not set/)).toBe('warn');
    expect(r.ok).toBe(true);

    const noKiro = setup({ kiro: false });
    const r2 = await runDoctor(noKiro.paths, { ...noKiro.probes, env: { PATH: '/bin' } });
    expect(r2.checks.some((c) => c.name === 'agent kiro')).toBe(false);
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

describe('factory doctor', () => {
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
