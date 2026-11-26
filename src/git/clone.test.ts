import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitFixture, type GitFixture } from '../../test/git-fixtures.js';
import { CloneError, ensureClone, GC_INTERVAL_MS, githubCloneUrl, housekeepManagedClone, LAST_GC_KEY, MANAGED_CLONE_KEY, workerNetworkGit } from './clone.js';
import { runGit, type GitOptions } from './git.js';
import { prepareJobWorktree } from './worktree.js';

const FULL = 'octo/widgets';
const TOKEN = `ghs_${'Zx9'.repeat(12)}`;
const HEADER = Buffer.from(`x-access-token:${TOKEN}`, 'utf8').toString('base64');

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});
function fixture(): GitFixture {
  const f = createGitFixture(FULL);
  fixtures.push(f);
  return f;
}

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

// Real git, several commands a test: well under a second on Linux, up to ten on a loaded Windows
// runner, so the default 5 s per test is too tight there.
describe('ensureClone', { timeout: 60_000 }, () => {
  it('creates an empty repository with the remote and nothing else, and marks it as its own', async () => {
    const f = fixture();
    const checkoutPath = join(f.root, 'state dir', 'checkouts', 'widgets');
    const seen: Array<{ args: readonly string[]; opts: GitOptions }> = [];
    const recording = (args: readonly string[], opts: GitOptions) => {
      seen.push({ args, opts });
      return runGit(args, opts);
    };
    expect(await ensureClone({ checkoutPath, cloneUrl: githubCloneUrl(FULL), runGit: recording, now: () => 1_000 })).toEqual({ created: true, managed: true });

    expect(seen.map((s) => s.args.join(' '))).toEqual([
      'init --quiet',
      `remote add origin https://github.com/${FULL}.git`,
      `config --local ${MANAGED_CLONE_KEY} true`,
      'config --local gc.auto 0',
      'config --local maintenance.auto false',
      `config --local ${LAST_GC_KEY} 1000`,
    ]);
    // No automatic gc, whose ref packing a contained agent's commit would trigger in a read-only git directory.
    expect(f.git(checkoutPath, 'config', '--get', 'gc.auto')).toBe('0');
    expect(f.git(checkoutPath, 'config', '--get', 'maintenance.auto')).toBe('false');
    // No credentials are involved in creating it: none in argv, none in the environment, none in a file.
    expect(seen.every((s) => s.opts.env === undefined)).toBe(true);
    expect(f.git(checkoutPath, 'remote', 'get-url', 'origin')).toBe(`https://github.com/${FULL}.git`);
    expect(f.git(checkoutPath, 'count-objects')).toMatch(/^0 objects/);
    expect(f.git(checkoutPath, 'rev-parse', '--is-shallow-repository')).toBe('false');

    // Again: it is there, and still the worker's own.
    seen.length = 0;
    expect(await ensureClone({ checkoutPath, cloneUrl: 'https://example.invalid/other.git', runGit: recording })).toEqual({ created: false, managed: true });
    expect(seen.map((s) => s.args[0])).toEqual(['config']);
    expect(f.git(checkoutPath, 'remote', 'get-url', 'origin')).toBe(`https://github.com/${FULL}.git`);
  });

  it('uses an empty directory that already exists', async () => {
    const f = fixture();
    const checkoutPath = join(f.root, 'empty');
    mkdirSync(checkoutPath);
    expect(await ensureClone({ checkoutPath, cloneUrl: f.remoteDir })).toEqual({ created: true, managed: true });
  });

  it("leaves a person's clone exactly as it is, and does not call it its own", async () => {
    const f = fixture();
    const before = readFileSync(join(f.clone, '.git', 'config'), 'utf8');
    expect(await ensureClone({ checkoutPath: f.clone, cloneUrl: githubCloneUrl(FULL) })).toEqual({ created: false, managed: false });
    expect(readFileSync(join(f.clone, '.git', 'config'), 'utf8')).toBe(before);
  });

  it('refuses a directory that has content and is not a repository', async () => {
    const f = fixture();
    const checkoutPath = join(f.root, 'not a repo');
    mkdirSync(checkoutPath);
    writeFileSync(join(checkoutPath, 'notes.txt'), 'mine\n');
    // Outside any repository: the fixture root is not one either.
    await expect(ensureClone({ checkoutPath, cloneUrl: f.remoteDir })).rejects.toBeInstanceOf(CloneError);
    expect(readdirSync(checkoutPath)).toEqual(['notes.txt']);
  });
});

describe('housekeepManagedClone', { timeout: 60_000 }, () => {
  it('runs git gc --auto itself in a clone it made, at most once per interval, with git\'s threshold and no hooks', async () => {
    const f = fixture();
    const checkoutPath = join(f.root, 'managed');
    await ensureClone({ checkoutPath, cloneUrl: githubCloneUrl(FULL), now: () => 0 });
    const seen: string[] = [];
    const recording = (args: readonly string[], opts: GitOptions) => {
      seen.push(args.join(' '));
      return runGit(args, opts);
    };
    const hooksPath = join(f.root, 'no hooks');
    // Made just now: not due.
    expect(await housekeepManagedClone({ checkoutPath, hooksPath, runGit: recording, now: () => GC_INTERVAL_MS - 1 })).toEqual({ ran: false, why: 'collected recently' });
    expect(seen.some((a) => a.includes(' gc '))).toBe(false);
    // A day later: due, and recorded.
    expect(await housekeepManagedClone({ checkoutPath, hooksPath, runGit: recording, now: () => GC_INTERVAL_MS })).toEqual({ ran: true, why: 'git gc --auto' });
    expect(seen).toContain(`-c gc.auto=6700 -c gc.autoDetach=false -c maintenance.auto=false -c core.hooksPath=${hooksPath} gc --auto --quiet`);
    expect(f.git(checkoutPath, 'config', '--get', LAST_GC_KEY)).toBe(String(GC_INTERVAL_MS));
    // Agents still get no automatic gc.
    expect(f.git(checkoutPath, 'config', '--get', 'gc.auto')).toBe('0');
    // updraft clean asks with no interval: it runs whenever asked.
    expect((await housekeepManagedClone({ checkoutPath, hooksPath, intervalMs: 0, now: () => GC_INTERVAL_MS + 1 })).ran).toBe(true);
  });

  it("leaves a person's clone to its own gc", async () => {
    const f = fixture();
    const before = readFileSync(join(f.clone, '.git', 'config'), 'utf8');
    expect(await housekeepManagedClone({ checkoutPath: f.clone, hooksPath: join(f.root, 'no hooks'), intervalMs: 0 })).toEqual({ ran: false, why: 'not a clone the worker made' });
    expect(readFileSync(join(f.clone, '.git', 'config'), 'utf8')).toBe(before);
  });
});

describe('workerNetworkGit', () => {
  const base = { PATH: '/usr/bin', GIT_TRACE: '1', GIT_CURL_VERBOSE: '1' };

  it('passes the token as a header scoped to https://github.com/, in the environment only, with hooks and tracing off', async () => {
    const token = vi.fn(async () => TOKEN);
    const net = await workerNetworkGit({ base, remoteUrl: `https://github.com/${FULL}.git`, repoFullName: FULL, token, hooksPath: '/nonexistent/hooks' });
    expect(token).toHaveBeenCalledExactlyOnceWith(FULL);
    const n = Number(net.env.GIT_CONFIG_COUNT);
    const pairs = Array.from({ length: n }, (_, i) => [net.env[`GIT_CONFIG_KEY_${i}`], net.env[`GIT_CONFIG_VALUE_${i}`]]);
    expect(pairs).toEqual([
      ['core.hooksPath', '/nonexistent/hooks'],
      ['http.https://github.com/.extraheader', ''],
      ['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${HEADER}`],
    ]);
    expect(net.env.GIT_TRACE).toBeUndefined();
    expect(net.env.GIT_CURL_VERBOSE).toBeUndefined();
    // Whatever git or a caller might echo back is cleaned before it is logged.
    expect(net.redact(`fatal: bad header AUTHORIZATION: basic ${HEADER} for token ${TOKEN}`)).toBe('fatal: bad header AUTHORIZATION: basic *** for token ***');
  });

  it('reads no token for a remote that is not https://github.com (SSH, a host alias, a local path)', async () => {
    for (const remoteUrl of [`git@github.com:${FULL}.git`, `github-work:${FULL}.git`, '/srv/git/octo/widgets.git', `https://github.example.com/${FULL}.git`]) {
      const token = vi.fn(async () => TOKEN);
      const net = await workerNetworkGit({ base, remoteUrl, repoFullName: FULL, token, hooksPath: '/nonexistent/hooks' });
      expect(token).not.toHaveBeenCalled();
      expect(JSON.stringify(net.env)).not.toContain('extraheader');
      expect(net.env.GIT_CONFIG_COUNT).toBe('1');
    }
  });
});

describe('a created clone, fetched with a network environment', { timeout: 60_000 }, () => {
  it('gives the environment to the fetch, so a clone with no usable credentials of its own can be prepared', async () => {
    const f = fixture();
    const checkoutPath = join(f.root, 'checkouts', 'widgets');
    // The clone's own remote URL leads nowhere. Only the environment can make the fetch work,
    // here by rewriting the URL, as a credential header would by authenticating it.
    const unreachable = `https://example.invalid/${FULL}.git`;
    await ensureClone({ checkoutPath, cloneUrl: unreachable });
    const request = {
      checkoutPath,
      repoFullName: FULL,
      remote: 'origin',
      baseBranch: 'main',
      branch: 'updraft/issue-7-job_ev1x0',
      worktreePath: join(f.root, 'worktrees', 'job'),
    };
    await expect(prepareJobWorktree(request)).rejects.toThrow(/fetch/);

    const networkEnv = {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${f.remoteDir}.insteadOf`,
      GIT_CONFIG_VALUE_0: unreachable,
    };
    const prepared = await prepareJobWorktree({ ...request, networkEnv });
    expect(prepared.baseSha).toBe(f.git(f.clone, 'rev-parse', 'origin/main'));
    // Git for Windows checks text out with CRLF line endings by default.
    expect(readFileSync(join(prepared.worktreePath, 'README.md'), 'utf8').replace(/\r\n/g, '\n')).toBe('# widgets\n');

    // One branch, whole history, no tags; and the environment's settings were not written down.
    expect(f.git(checkoutPath, 'for-each-ref', '--format=%(refname)')).toBe(['refs/heads/updraft/issue-7-job_ev1x0', 'refs/remotes/origin/main'].join('\n'));
    expect(f.git(checkoutPath, 'rev-parse', '--is-shallow-repository')).toBe('false');
    expect(f.git(checkoutPath, 'remote', 'get-url', 'origin')).toBe(unreachable);
    for (const file of allFiles(join(checkoutPath, '.git')).filter((p) => /config$/.test(p))) expect(readFileSync(file, 'utf8')).not.toContain('insteadOf');
  });
});
