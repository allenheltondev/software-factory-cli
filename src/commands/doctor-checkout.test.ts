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

function config(mode: 'log-only' | 'prepare-only', checkouts: Record<string, string | undefined>) {
  return configSchema.parse({
    version: 1,
    execution: { mode },
    agents: { claude: {} },
    pools: { general: { agents: ['claude'] } },
    actions: { 'implement-issue': {} },
    dispatch: { allowedActors: ['allen'] },
    repositories: Object.fromEntries(
      Object.entries(checkouts).map(([name, checkoutPath], i) => [
        name,
        {
          id: i + 1,
          checkoutPath,
          workflows: [{ trigger: { event: 'issue.labeled', label: 'go' }, action: 'implement-issue', pool: 'general' }],
        },
      ]),
    ),
  });
}

// Real git is slow to spawn on Windows runners.
describe('doctor: repo checkouts', { timeout: 60_000 }, () => {
  it('checks each checkoutPath exists, is a git repo, and has a remote for the repo', async () => {
    const f = createGitFixture('octo/widgets');
    fixtures.push(f);
    const configDir = join(f.root, 'factory home');
    const plain = join(f.root, 'plain dir');
    mkdirSync(plain);
    const cfg = config('prepare-only', {
      'octo/widgets': relative(configDir, f.clone),
      'octo/gadgets': f.clone,
      'octo/missing': join(f.root, 'not here'),
      'octo/plain': plain,
      'octo/unset': undefined,
    });
    const checks = await checkRepoCheckouts(cfg, { configDir }, probes(f));
    expect(checks.map((c) => [c.status, c.name])).toEqual([
      ['ok', 'checkout octo/widgets'],
      ['fail', 'checkout octo/gadgets'],
      ['fail', 'checkout octo/missing'],
      ['fail', 'checkout octo/plain'],
    ]);
    expect(checks[0]!.detail).toBe(`${f.clone} (remote origin -> ${f.remoteDir})`);
    expect(checks[1]!.detail).toMatch(/no remote points at octo\/gadgets \(remotes: origin -> /);
    expect(checks[2]!.detail).toMatch(/does not exist/);
    expect(checks[3]!.detail).toMatch(/is not a git repository/);
  });

  it('only warns when the mode does not need a checkout', async () => {
    const f = createGitFixture('octo/widgets');
    fixtures.push(f);
    const checks = await checkRepoCheckouts(config('log-only', { 'octo/gadgets': f.clone }), { configDir: f.root }, probes(f));
    expect(checks.map((c) => c.status)).toEqual(['warn']);
  });
});
