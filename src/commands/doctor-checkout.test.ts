import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitFixture, type GitFixture } from '../../test/git-fixtures.js';
import { configSchema } from '../config/schema.js';
import { checkRepoCheckouts } from './doctor-checkout.js';
import type { DoctorProbes } from './doctor.js';

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

const probes = (f: GitFixture): Pick<DoctorProbes, 'which' | 'run' | 'fileExists'> => ({
  which: (cmd) => (cmd === 'git' ? 'git' : null),
  run: (file, args) =>
    new Promise((resolve) => {
      // Keep git from walking up into an enclosing repository for the non-repo case.
      const env = { ...process.env, GIT_CEILING_DIRECTORIES: f.root };
      execFile(file, args, { windowsHide: true, env }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: String(stdout), stderr: String(stderr) });
      });
    }),
  fileExists: existsSync,
});

type Checkout = { checkoutPath?: string; remote?: string };

function config(mode: 'log-only' | 'prepare-only', checkouts: Record<string, Checkout>) {
  return configSchema.parse({
    version: 1,
    execution: { mode },
    agents: { claude: {} },
    pools: { general: { agents: ['claude'] } },
    actions: { 'implement-issue': {} },
    dispatch: { allowedActors: ['allen'] },
    repositories: Object.fromEntries(
      Object.entries(checkouts).map(([name, c], i) => [
        name,
        {
          id: i + 1,
          ...c,
          workflows: [{ trigger: { event: 'issue.labeled', label: 'go' }, action: 'implement-issue', pool: 'general' }],
        },
      ]),
    ),
  });
}

function fixture(): GitFixture {
  const f = createGitFixture('octo/widgets');
  fixtures.push(f);
  return f;
}

// Real git is slow to spawn on Windows runners.
describe('doctor: repo checkouts', { timeout: 60_000 }, () => {
  it('checks each checkoutPath exists, is a git repo, and has the configured remote', async () => {
    const f = fixture();
    const configDir = join(f.root, 'factory home');
    const plain = join(f.root, 'plain dir');
    mkdirSync(plain);
    const cfg = config('prepare-only', {
      'octo/widgets': { checkoutPath: relative(configDir, f.clone), remote: 'origin' },
      'octo/gadgets': { checkoutPath: f.clone, remote: 'origin' },
      'octo/missing': { checkoutPath: join(f.root, 'not here') },
      'octo/plain': { checkoutPath: plain },
      'octo/unset': {},
    });
    const checks = await checkRepoCheckouts(cfg, { configDir }, probes(f));
    expect(checks.map((c) => [c.status, c.name])).toEqual([
      ['ok', 'checkout octo/widgets'],
      ['fail', 'checkout octo/gadgets'],
      ['fail', 'checkout octo/missing'],
      ['fail', 'checkout octo/plain'],
    ]);
    expect(checks[0]!.detail).toBe(
      `${f.clone}: using remote origin (${f.remoteDir}); set in repositories.octo/widgets.remote`,
    );
    expect(checks[1]!.detail).toMatch(/remote "origin" set in repositories\.octo\/gadgets\.remote points at .*, not octo\/gadgets/);
    expect(checks[2]!.detail).toMatch(/does not exist/);
    expect(checks[3]!.detail).toMatch(/is not a git repository/);
  });

  it('selects a github.com upstream over a non-GitHub origin and says why', async () => {
    const f = fixture();
    f.git(f.clone, 'remote', 'set-url', 'origin', 'https://gitlab.example.com/octo/widgets.git');
    f.git(f.clone, 'remote', 'add', 'upstream', 'git@github.com:octo/widgets.git');
    const checks = await checkRepoCheckouts(config('prepare-only', { 'octo/widgets': { checkoutPath: f.clone } }), { configDir: f.root }, probes(f));
    expect(checks).toEqual([
      {
        status: 'ok',
        name: 'checkout octo/widgets',
        detail: `${f.clone}: using remote upstream (git@github.com:octo/widgets.git); github.com URL for octo/widgets; origin is not one`,
      },
    ]);
  });

  it('fails when the only matching remote is not on github.com, suggesting remote:', async () => {
    const f = fixture();
    f.git(f.clone, 'remote', 'set-url', 'origin', 'git@github-work:octo/widgets.git');
    const checks = await checkRepoCheckouts(config('prepare-only', { 'octo/widgets': { checkoutPath: f.clone } }), { configDir: f.root }, probes(f));
    expect(checks.map((c) => c.status)).toEqual(['fail']);
    expect(checks[0]!.detail).toContain('set repositories.octo/widgets.remote: origin');

    const aliased = await checkRepoCheckouts(
      config('prepare-only', { 'octo/widgets': { checkoutPath: f.clone, remote: 'origin' } }),
      { configDir: f.root },
      probes(f),
    );
    expect(aliased.map((c) => c.status)).toEqual(['ok']);
  });

  it('only warns when the mode does not need a checkout', async () => {
    const f = fixture();
    const checks = await checkRepoCheckouts(config('log-only', { 'octo/gadgets': { checkoutPath: f.clone } }), { configDir: f.root }, probes(f));
    expect(checks.map((c) => c.status)).toEqual(['warn']);
  });
});
