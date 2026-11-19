import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { AdapterName } from '../config/schema.js';
import { APP_KEY_PATH_ENV, GitHubAppError, type AppAuth, type AppInstallation } from '../github/app-auth.js';
import { appIdentity, createAppCredentials } from '../github/credentials.js';
import { resolvePaths } from '../paths.js';
import { buildWorkflow, seedConfig, upsertRepoWorkflow } from './config-edit.js';
import { appKeyChecks, appRepoChecks } from './doctor-app.js';
import { runDoctor, type DoctorProbes } from './doctor.js';
import { EXIT } from './errors.js';
import { fakeAgentReport, fakeApi, fakeContext, fakeRepo, tempHome } from './fakes.js';
import { validateCommand } from './validate.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createTokenFileAuth } from '../github/token-file-auth.js';

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const FULL_ACCESS = { metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'write' };

interface FakeApp {
  installation?: Partial<AppInstallation> | Error;
  permissions?: Record<string, string>;
  tokenError?: Error;
  appError?: Error;
}

function fakeAppAuth(o: FakeApp = {}): AppAuth & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    appId: 12345,
    privateKeyPath: '/keys/app.pem',
    async app() {
      if (o.appError) throw o.appError;
      return { id: 4242, slug: 'updraft-bot', name: 'Updraft Bot', permissions: {} };
    },
    async installation(repoFullName) {
      asked.push(`installation ${repoFullName}`);
      if (o.installation instanceof Error) throw o.installation;
      return { id: 11, suspendedAt: null, permissions: {}, repositorySelection: 'selected', ...o.installation };
    },
    async installationToken(repoFullName) {
      asked.push(`token ${repoFullName}`);
      if (o.tokenError) throw o.tokenError;
      return { token: 'ghs_doctorDoctorDoctorDoctor', installationId: 11, expiresAt: Date.now() + 3_600_000, permissions: o.permissions ?? FULL_ACCESS, repositorySelection: 'selected' };
    },
    reject() {},
    async botUser() {
      return { id: 987654, login: 'updraft-bot[bot]' };
    },
  };
}

function setup(
  o: FakeApp & {
    app?: Record<string, unknown>;
    repo?: Record<string, unknown>;
    allowedActors?: string[];
    keyMode?: number;
    writeKey?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const home = tempHome();
  const paths = resolvePaths({ env: { UPDRAFT_HOME: home } });
  const base = upsertRepoWorkflow(seedConfig('allen'), { id: 10, fullName: 'o/r' }, buildWorkflow({ label: 'updraft:ready', action: 'implement-issue', pool: 'general' })).config;
  const cfg = {
    ...base,
    dispatch: { allowedActors: o.allowedActors ?? ['allen'] },
    github: { app: { appId: 12345, privateKeyPath: 'app.pem', ...o.app } },
    repositories: { 'o/r': { ...base.repositories!['o/r']!, ...o.repo } },
  };
  writeFileSync(paths.configFile, stringify(cfg));
  const keyPath = join(paths.configDir, 'app.pem');
  if (o.writeKey !== false) writeFileSync(keyPath, PEM, { mode: 0o600 });
  const api = fakeApi({ login: 'allen', repos: [fakeRepo('o/r', 10)], labels: { 'o/r': ['updraft:ready'] } });
  const auth = fakeAppAuth(o);
  const probes: DoctorProbes = {
    nodeVersion: '22.13.0',
    platform: 'linux',
    cwd: '/work',
    user: 'allen',
    env: { PATH: '/usr/bin', KIRO_API_KEY: 'x', ...o.env },
    which: (cmd) => (['git', 'codex', 'claude', 'kiro-cli'].includes(cmd) ? `/usr/bin/${cmd}` : null),
    run: async () => ({ code: 0, stdout: 'git version 2.50.0\n', stderr: '' }),
    discoverAgent: async (adapter) => fakeAgentReport(adapter as AdapterName),
    checkWritable: () => {},
    checkDb: () => {},
    createCredentials: () => createAppCredentials(auth),
    createApi: async (credentials) => ({
      ...api,
      getWorkerIdentity: async () => appIdentity(await credentials!.app!.app()),
      getViewer: async () => {
        throw new Error('GET /user is not available to a GitHub App');
      },
    }),
    fileMode: () => o.keyMode ?? 0o600,
    fileExists: () => true,
  };
  return { paths, probes, home, api, auth, keyPath };
}

const status = (checks: { status: string; name: string; detail: string }[], re: RegExp) => checks.find((c) => re.test(`${c.name}: ${c.detail}`))?.status;

describe('updraft doctor with a GitHub App (github.app)', () => {
  it('checks the key, the App, and each repository\'s installation and permissions', async () => {
    const { paths, probes, auth, keyPath } = setup({ repo: { publish: 'draft-pr' } });
    const r = await runDoctor(paths, probes);
    expect(status(r.checks, new RegExp(`^github app: private key loads: ${keyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))).toBe('ok');
    expect(status(r.checks, /^github: the GitHub App authenticates; the worker acts as updraft-bot\[bot\] \(app id 4242\)/)).toBe('ok');
    expect(status(r.checks, /^repo o\/r: GitHub App installation 11 \(selected repositories\): its permissions cover polling, publish: draft-pr$/)).toBe('ok');
    expect(status(r.checks, /trigger label "updraft:ready" exists/)).toBe('ok');
    expect(auth.asked).toEqual(['installation o/r', 'token o/r']);
    // gh is not what the worker uses, so its absence is not a failure; nothing speaks of a gh account.
    expect(status(r.checks, /^gh: not found on PATH \(a GitHub App is configured, so gh is needed only by "updraft configure" and "updraft add"\)/)).toBe('warn');
    expect(r.checks.some((c) => /active GitHub account/.test(c.detail))).toBe(false);
    expect(r.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('fails with what to change when the key is missing, and checks nothing that needs it', async () => {
    const { paths, probes, auth } = setup({ writeKey: false });
    const r = await runDoctor(paths, probes);
    expect(status(r.checks, /^github app: the GitHub App private key .*app\.pem does not exist\. Set github\.app\.privateKeyPath/)).toBe('fail');
    expect(status(r.checks, /^github: cannot use the GitHub API: the GitHub App's private key cannot be used/)).toBe('fail');
    expect(r.checks.some((c) => c.name.startsWith('repo '))).toBe(false);
    expect(auth.asked).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('fails for a file that is not an RSA private key', async () => {
    const { paths, probes, keyPath } = setup();
    writeFileSync(keyPath, 'not a key\n');
    const r = await runDoctor(paths, probes);
    expect(status(r.checks, /^github app: .*is not a PEM private key/)).toBe('fail');
  });

  it('uses the key the environment variable names', async () => {
    const elsewhere = join(tempHome(), 'other.pem');
    writeFileSync(elsewhere, PEM, { mode: 0o600 });
    const { paths, probes } = setup({ writeKey: false, env: { [APP_KEY_PATH_ENV]: elsewhere } });
    const r = await runDoctor(paths, probes);
    expect(status(r.checks, /^github app: private key loads: .*other\.pem \(from UPDRAFT_GITHUB_APP_PRIVATE_KEY_PATH\)/)).toBe('ok');
  });

  it('warns when other users can read the key on POSIX, and not on Windows', async () => {
    const { paths, probes } = setup({ keyMode: 0o644 });
    const r = await runDoctor(paths, probes);
    expect(status(r.checks, /^github app: .*app\.pem has mode 644, so other users on this machine can read the App's private key.*chmod 600/)).toBe('warn');
    expect(r.ok).toBe(true);
    const win = await runDoctor(paths, { ...probes, platform: 'win32' });
    expect(win.checks.some((c) => /has mode/.test(c.detail))).toBe(false);
    const group = await runDoctor(paths, { ...probes, fileMode: () => 0o640 });
    expect(status(group.checks, /has mode 640/)).toBe('warn');
  });

  it.skipIf(process.platform === 'win32')('reads the real file mode by default', () => {
    const { paths, keyPath } = setup();
    const app = { appId: 1, privateKeyPath: 'app.pem' };
    const o = { configDir: paths.configDir, env: {}, platform: 'linux' as const };
    expect(appKeyChecks(app, o).checks.map((c) => c.status)).toEqual(['ok']);
    chmodSync(keyPath, 0o644);
    expect(appKeyChecks(app, o).checks.map((c) => c.status)).toEqual(['ok', 'warn']);
  });

  it('reports an App that does not authenticate with the App\'s own advice, not gh\'s', async () => {
    const { paths, probes } = setup({ appError: new GitHubAppError("GitHub rejected the App's JWT because of its timestamps. This machine's clock reads 2031-01-01; correct it", 'clock') });
    const r = await runDoctor(paths, probes);
    const github = r.checks.find((c) => c.name === 'github')!;
    expect(github.status).toBe('fail');
    expect(github.detail).toMatch(/cannot use the GitHub API: GitHub rejected the App's JWT because of its timestamps.*correct it/);
    expect(github.detail).not.toMatch(/gh auth login/);
    expect(r.checks.some((c) => c.name.startsWith('repo '))).toBe(false);
  });

  it('fails for a repository the App is not installed on, or whose installation is suspended', async () => {
    const missing = setup({ installation: new GitHubAppError('the GitHub App updraft-bot is not installed on o/r. Install it there', 'not-installed') });
    const r1 = await runDoctor(missing.paths, missing.probes);
    expect(status(r1.checks, /^repo o\/r: the GitHub App updraft-bot is not installed on o\/r\. Install it there/)).toBe('fail');
    expect(r1.ok).toBe(false);

    const suspended = setup({ installation: { suspendedAt: '2026-11-01T00:00:00Z' } });
    const r2 = await runDoctor(suspended.paths, suspended.probes);
    expect(status(r2.checks, /^repo o\/r: the GitHub App's installation 11 is suspended \(since 2026-11-01T00:00:00Z\).*unsuspend it/)).toBe('fail');
    expect(suspended.auth.asked).toEqual(['installation o/r']); // no token is asked for a suspended installation
  });

  it('fails when the configured installation is not the one that covers the repository', async () => {
    const { paths, probes } = setup({ app: { installationId: 99 } });
    const r = await runDoctor(paths, probes);
    expect(status(r.checks, /^repo o\/r: github\.app\.installationId is 99, but the App's installation that covers o\/r is 11/)).toBe('fail');
  });

  it('names each permission the configuration uses and the installation lacks', async () => {
    const { paths, probes } = setup({
      repo: { publish: 'draft-pr', commentOnFailure: true },
      permissions: { metadata: 'read', contents: 'read', issues: 'read' },
    });
    const r = await runDoctor(paths, probes);
    const gaps = r.checks.filter((c) => /GitHub App permission missing/.test(c.detail));
    expect(gaps.map((c) => c.detail.replace(/; change it under.*$/, ''))).toEqual([
      'GitHub App permission missing for polling, publish: draft-pr, commentOnFailure: Contents: needs "Read and write", the installation has "read"',
      'GitHub App permission missing for polling, publish: draft-pr, commentOnFailure: Pull requests: needs "Read and write", the installation has no access',
      'GitHub App permission missing for polling, publish: draft-pr, commentOnFailure: Issues: needs "Read and write", the installation has "read"',
    ]);
    expect(gaps[0]!.detail).toMatch(/"Permissions & events", then accept the new permissions on the installation/);
    // Nothing is published outside live mode, so there these are warnings; in live mode they are failures.
    expect(gaps.every((c) => c.status === 'warn')).toBe(true);
    const live = await appRepoChecks(
      fakeAppAuth({ permissions: { metadata: 'read', contents: 'read', issues: 'read' } }),
      { execution: { mode: 'live' }, github: undefined },
      'o/r',
      { publish: 'draft-pr', commentOnFailure: true, revise: true },
    );
    expect(live.map((c) => c.status)).toEqual(['fail', 'fail', 'fail']);
    expect(live[0]!.detail).toMatch(/for polling, publish: draft-pr, revise, commentOnFailure:/);
  });

  it('fails in every mode when the installation cannot even read issues', async () => {
    const { paths, probes } = setup({ permissions: { metadata: 'read', contents: 'write' } });
    const r = await runDoctor(paths, probes);
    expect(status(r.checks, /^repo o\/r: GitHub App permission missing for polling: Issues: needs "Read-only", the installation has no access/)).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('asks for no more than read access when nothing is published', async () => {
    const { paths, probes } = setup({ permissions: { metadata: 'read', issues: 'read' } });
    const r = await runDoctor(paths, probes);
    expect(status(r.checks, /^repo o\/r: GitHub App installation 11 \(selected repositories\): its permissions cover polling$/)).toBe('ok');
  });

  it('reports a token GitHub will not issue', async () => {
    const { paths, probes } = setup({ tokenError: new GitHubAppError('GitHub refused an installation token for the GitHub App updraft-bot on o/r', 'permissions') });
    const r = await runDoctor(paths, probes);
    expect(status(r.checks, /^repo o\/r: GitHub refused an installation token/)).toBe('fail');
  });

  it('warns when the bot itself is allowed to dispatch, and not about the person being absent from the list', async () => {
    const listed = setup({ allowedActors: ['allen', 'Updraft-Bot[bot]'] });
    const r1 = await runDoctor(listed.paths, listed.probes);
    expect(status(r1.checks, /^github: updraft-bot\[bot\] is in dispatch\.allowedActors, so a label applied by the worker's own bot would dispatch work/)).toBe('warn');

    const unlisted = setup({ allowedActors: ['someone-else'] });
    const r2 = await runDoctor(unlisted.paths, unlisted.probes);
    expect(r2.checks.some((c) => /allowedActors/.test(c.detail))).toBe(false);
  });
});

describe('updraft doctor with a GitHub App token file', () => {
  it('warns that permissions are not checked when the token file states none, instead of failing', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'updraft-doctor-token-')), 'app-token.json');
    const file = { app: { id: 4242, slug: 'updraft' }, installationId: 55, token: 'ghs_aaaaaaaaaaaaaaaaaaaa', expiresAt: '2099-01-01T00:00:00Z' };
    writeFileSync(path, JSON.stringify(file));
    const repo = { publish: 'draft-pr' as const, commentOnFailure: true, revise: true };
    const unstated = await appRepoChecks(createTokenFileAuth({ path, appId: 4242 }), { execution: { mode: 'live' }, github: undefined }, 'acme/web', repo);
    expect(unstated).toEqual([{ status: 'warn', detail: expect.stringMatching(/states no permissions, so whether they cover .* is not checked/) }]);

    writeFileSync(path, JSON.stringify({ ...file, permissions: { metadata: 'read', contents: 'write', issues: 'write', pull_requests: 'write' } }));
    const stated = await appRepoChecks(createTokenFileAuth({ path, appId: 4242 }), { execution: { mode: 'live' }, github: undefined }, 'acme/web', repo);
    expect(stated.map((c) => c.status)).toEqual(['ok']);
  });
});

describe('updraft validate with a GitHub App', () => {
  it('checks offline that the key file exists and is an RSA private key', async () => {
    const { home, keyPath } = setup();
    const ok = fakeContext({ home });
    expect(await validateCommand(ok)).toBe(EXIT.OK);

    writeFileSync(keyPath, 'garbage');
    const bad = fakeContext({ home });
    expect(await validateCommand(bad)).toBe(EXIT.FAILURE);
    expect(bad.err.text).toMatch(/✗ github\.app\.privateKeyPath: the GitHub App private key .* is not a PEM private key/);

    const missing = setup({ writeKey: false });
    const ctx = fakeContext({ home: missing.home });
    expect(await validateCommand(ctx)).toBe(EXIT.FAILURE);
    expect(ctx.err.text).toMatch(/github\.app\.privateKeyPath: .* does not exist/);
  });

  it('rejects a key in the config file itself, and other malformed settings', async () => {
    const { home, paths } = setup();
    for (const app of [
      { appId: 12345, privateKeyPath: 'app.pem', privateKey: PEM },
      { appId: 12345 },
      { appId: -1, privateKeyPath: 'app.pem' },
      { appId: 'not an id!', privateKeyPath: 'app.pem' },
      { appId: 12345, privateKeyPath: 'app.pem', installationId: 'eleven' },
    ]) {
      const base = upsertRepoWorkflow(seedConfig('allen'), { id: 10, fullName: 'o/r' }, buildWorkflow({ label: 'go', action: 'implement-issue', pool: 'general' })).config;
      writeFileSync(paths.configFile, stringify({ ...base, github: { app } }));
      const ctx = fakeContext({ home });
      expect(await validateCommand(ctx)).toBe(EXIT.FAILURE);
      expect(ctx.err.text).toMatch(/github\.app/);
      expect(ctx.err.text).not.toContain(PEM.split('\n')[1]!);
    }
  });
});
