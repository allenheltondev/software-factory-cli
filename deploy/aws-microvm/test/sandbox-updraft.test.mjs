// Updraft's own container mode (src/worker/live.ts, container.ts) driving the sandbox runtime
// for real: the mount plan Updraft builds for a git worktree, an agent that commits inside the
// sandbox, and a verify command in a sandbox of its own. The layout is the microVM's: the
// worktree lives under the job's Updraft home, next to the App key and the state database,
// which the agent and the verify command try to reach.
//
// Runs where bwrap can build a sandbox (sandbox-host.mjs says why when it cannot).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os, { hostname } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeAdapter } from '../../../test/fake-adapter.ts';
import { createGitFixture } from '../../../test/git-fixtures.ts';
import { insertQueuedJob } from '../../../test/queue-fixtures.ts';
import { registerAdapter } from '../../../src/agents/adapters/registry.ts';
import { configSchema } from '../../../src/config/schema.ts';
import { openDatabase } from '../../../src/db/database.ts';
import { claimNextJob, setRunProcess } from '../../../src/db/queue.ts';
import { worktreesRoot } from '../../../src/git/worktree.ts';
import { resolvePaths } from '../../../src/paths.ts';
import { silentLogger } from '../../../src/util/log.ts';
import { LiveExecutor } from '../../../src/worker/live.ts';
import { baseCheckRoot } from '../../../src/worker/base-check.ts';
import { buildContainerRunArgs, worktreeMounts } from '../../../src/worker/container.ts';
import { cloneRefFormat, ensureClone } from '../../../src/git/clone.ts';
import { SANDBOX_IMAGE } from '../image/runner/isolation.mjs';
import { installRuntime, requireUnlessAllowedToSkip, sandboxAvailability } from './sandbox-host.mjs';

const sandbox = requireUnlessAllowedToSkip(process.platform === 'win32' ? { usable: false, reason: 'needs Linux' } : sandboxAvailability());
const API_KEY = 'sk-test-0123456789';

/**
 * The "agent": reports what it can reach as report.json in the worktree, then commits that.
 * argv: <paths to try> as JSON.
 */
const PROBE_AGENT = `
const fs = require('fs');
const { execFileSync } = require('child_process');
const targets = JSON.parse(process.argv[2]);
const attempt = (f) => { try { f(); return 'ok'; } catch (e) { return e.code || String(e.message); } };
let prompt = '';
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  const report = {
    prompt: prompt.length > 0,
    read: Object.fromEntries(targets.map((t) => [t, attempt(() => fs.readFileSync(t))])),
    write: Object.fromEntries(targets.map((t) => [t, attempt(() => fs.closeSync(fs.openSync(t, 'r+')))])),
    apiKey: process.env.FAKE_API_KEY === '${API_KEY}',
    env: Object.keys(process.env).sort(),
    ppidVisible: fs.existsSync('/proc/' + process.ppid + '/cmdline') && process.ppid > 1,
  };
  fs.writeFileSync('report.json', JSON.stringify(report, null, 2) + '\\n');
  execFileSync('git', ['add', 'report.json']);
  execFileSync('git', ['commit', '--quiet', '-m', 'probe: what the sandbox can reach']);
  console.log('probe agent: done');
});
`;

let fixture;
let db;
let restore;

beforeEach(() => {
  restore = registerAdapter(fakeAdapter({ name: 'claude', addScript: false }));
});

afterEach(() => {
  restore?.();
  db?.close();
  db = undefined;
  fixture?.cleanup();
  fixture = undefined;
});

describe.runIf(sandbox.usable)('Updraft container mode with the sandbox runtime', { timeout: 120_000 }, () => {
  it('runs the agent and a verify command in the sandbox: the commit lands, the key and the state database stay out of reach', async () => {
    fixture = createGitFixture('octo/widgets');
    const f = fixture;
    // The job's Updraft home, as the runner lays it out: the key, the state, the config.
    const paths = resolvePaths({ env: { UPDRAFT_HOME: path.join(f.root, 'job home') } });
    fs.mkdirSync(path.join(paths.configDir, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(paths.configDir, 'prompts', 'implement.md'), 'Implement the issue below. Commit your work.\n');
    const keyFile = path.join(paths.configDir, 'github-app.pem');
    const stateFile = path.join(paths.configDir, 'state.db');
    fs.writeFileSync(keyFile, '-----BEGIN RSA PRIVATE KEY-----\nMIIsecret\n-----END RSA PRIVATE KEY-----\n', { mode: 0o600 });
    fs.writeFileSync(stateFile, 'state the agent must not change', { mode: 0o600 });

    // The agent script sits in a directory the sandbox config shows, as the image's tools do.
    const tools = path.join(f.root, 'tools');
    fs.mkdirSync(tools);
    fs.writeFileSync(path.join(tools, 'probe-agent.cjs'), PROBE_AGENT);
    const runtime = installRuntime(path.join(f.root, 'runtime'), { readOnlyBinds: [tools] });

    const verifyScript = `test ! -e '${keyFile}' && test ! -e '${stateFile}' && ! ls '${paths.configDir}/config.yaml' 2>/dev/null && test -f report.json`;
    const config = configSchema.parse({
      version: 1,
      execution: { mode: 'live' },
      agents: {
        claude: {
          command: process.execPath,
          args: [path.join(tools, 'probe-agent.cjs'), JSON.stringify([keyFile, stateFile, path.join(paths.configDir, 'config.yaml')])],
          env: {
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_AUTHOR_NAME: 'Probe Agent',
            GIT_AUTHOR_EMAIL: 'agent@example.com',
            GIT_COMMITTER_NAME: 'Probe Agent',
            GIT_COMMITTER_EMAIL: 'agent@example.com',
          },
          container: { image: SANDBOX_IMAGE, runtime: runtime.path, env: ['FAKE_API_KEY'] },
        },
      },
      pools: { general: { agents: ['claude'] } },
      actions: { 'implement-issue': { prompt: './prompts/implement.md', timeoutMinutes: 2, verify: [verifyScript] } },
      dispatch: { allowedActors: ['allen'] },
      repositories: {
        'octo/widgets': {
          id: 42,
          checkoutPath: path.relative(paths.configDir, f.clone),
          remote: 'origin',
          workflows: [{ trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general' }],
        },
      },
    });
    fs.writeFileSync(path.join(paths.configDir, 'config.yaml'), 'version: 1\n');

    db = openDatabase(':memory:');
    insertQueuedJob(db, { repoId: 42, fullName: 'octo/widgets', issue: 7 });
    const c = claimNextJob(db, config, { workerId: 'wrk_test', hostname: hostname(), leaseSeconds: 60, runsDir: paths.runsDir });
    const env = { ...process.env, FAKE_API_KEY: API_KEY, GH_TOKEN: 'gh-secret', AWS_SECRET_ACCESS_KEY: 'aws-secret' };
    const result = await new LiveExecutor({ env, locate: () => { throw new Error('host discovery for a contained agent'); } }).execute(c, {
      config,
      paths,
      log: silentLogger,
      signal: new globalThis.AbortController().signal,
      now: Date.now,
      recordProcess: (info) => setRunProcess(db, c.run.id, info),
    });

    const log = fs.readFileSync(c.run.logPath, 'utf8');
    expect(result, log).toMatchObject({ outcome: 'succeeded', summary: { commitCount: 1, verification: { passed: true } } });

    const worktree = path.join(worktreesRoot(paths), '42', c.job.id);
    expect(f.git(worktree, 'log', '-1', '--format=%s %an')).toBe('probe: what the sandbox can reach Probe Agent');
    const report = JSON.parse(fs.readFileSync(path.join(worktree, 'report.json'), 'utf8'));
    expect(report.prompt).toBe(true);
    expect(report.apiKey).toBe(true);
    for (const target of [keyFile, stateFile, path.join(paths.configDir, 'config.yaml')]) {
      expect(report.read[target]).toBe('ENOENT');
      expect(report.write[target]).toBe('ENOENT');
    }
    for (const withheld of ['GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'UPDRAFT_HOME', 'USER']) expect(report.env).not.toContain(withheld);
    expect(report.ppidVisible).toBe(false);
    // Outside, nothing changed.
    expect(fs.readFileSync(stateFile, 'utf8')).toBe('state the agent must not change');
  });
});

/**
 * The "agent" of the base checkout test: changes README.md and commits, then does what the
 * prompt says to check a failure against the base, and reports what it could and could not do.
 */
const BASE_CHECK_AGENT = `
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const attempt = (f) => { try { f(); return 'ok'; } catch (e) { return e.code || String(e.message); } };
process.stdin.resume();
process.stdin.on('end', () => {
  fs.writeFileSync('README.md', 'changed by the agent\\n');
  const commit = execFileSync('git', ['commit', '--quiet', '-am', 'agent: change the readme'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const base = process.env.UPDRAFT_BASE_DIR;
  const scratch = process.env.UPDRAFT_SCRATCH_DIR;
  const copy = path.join(scratch, 'base');
  const report = {
    base, scratch,
    baseFiles: fs.readdirSync(base).sort(),
    baseReadme: fs.readFileSync(path.join(base, 'README.md'), 'utf8'),
    writeBase: attempt(() => fs.writeFileSync(path.join(base, 'README.md'), 'tampered')),
    createInBase: attempt(() => fs.writeFileSync(path.join(base, 'new-file'), 'x')),
    copy: attempt(() => fs.cpSync(base, copy, { recursive: true })),
    writeCopy: attempt(() => fs.writeFileSync(path.join(copy, 'node_modules-stand-in'), 'installed')),
    commitOutput: commit,
  };
  console.log('base-check report: ' + JSON.stringify(report));
});
`;

describe.runIf(sandbox.usable)('the base checkout, in the sandbox', { timeout: 120_000 }, () => {
  it('lets the agent read the base commit and work on a copy in scratch, never write the base, and leaves the job branch alone', async () => {
    fixture = createGitFixture('octo/widgets');
    const f = fixture;
    const paths = resolvePaths({ env: { UPDRAFT_HOME: path.join(f.root, 'job home') } });
    fs.mkdirSync(path.join(paths.configDir, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(paths.configDir, 'prompts', 'implement.md'), 'Implement the issue below. Commit your work.\n');
    const tools = path.join(f.root, 'tools');
    fs.mkdirSync(tools);
    fs.writeFileSync(path.join(tools, 'base-check-agent.cjs'), BASE_CHECK_AGENT);
    const runtime = installRuntime(path.join(f.root, 'runtime'), { readOnlyBinds: [tools] });
    const config = configSchema.parse({
      version: 1,
      execution: { mode: 'live' },
      agents: {
        claude: {
          command: process.execPath,
          args: [path.join(tools, 'base-check-agent.cjs')],
          env: { GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' },
          container: { image: SANDBOX_IMAGE, runtime: runtime.path },
        },
      },
      pools: { general: { agents: ['claude'] } },
      actions: { 'implement-issue': { prompt: './prompts/implement.md', timeoutMinutes: 2 } },
      dispatch: { allowedActors: ['allen'] },
      repositories: {
        'octo/widgets': {
          id: 42,
          checkoutPath: path.relative(paths.configDir, f.clone),
          remote: 'origin',
          workflows: [{ trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general' }],
        },
      },
    });
    db = openDatabase(':memory:');
    insertQueuedJob(db, { repoId: 42, fullName: 'octo/widgets', issue: 8 });
    const c = claimNextJob(db, config, { workerId: 'wrk_test', hostname: hostname(), leaseSeconds: 60, runsDir: paths.runsDir });
    const result = await new LiveExecutor({ env: process.env, locate: () => { throw new Error('host discovery for a contained agent'); } }).execute(c, {
      config,
      paths,
      log: silentLogger,
      signal: new globalThis.AbortController().signal,
      now: Date.now,
      recordProcess: (info) => setRunProcess(db, c.run.id, info),
    });
    const log = fs.readFileSync(c.run.logPath, 'utf8');
    expect(result, log).toMatchObject({ outcome: 'succeeded', summary: { commitCount: 1 } });
    const report = JSON.parse(/base-check report: (.*)/.exec(log)[1]);
    const root = baseCheckRoot(paths.dataDir, c.run.id);
    expect(report).toMatchObject({
      base: path.join(root, 'base'),
      scratch: path.join(root, 'scratch'),
      // The base commit's files, without git metadata, and not the agent's change.
      baseFiles: ['README.md'],
      baseReadme: '# widgets\n',
      writeBase: 'EROFS',
      createInBase: 'EROFS',
      copy: 'ok',
      writeCopy: 'ok',
      commitOutput: '',
    });
    // The commit printed no read-only git warning, and nothing else did either.
    expect(log).not.toMatch(/Read-only file system|packed-refs\.lock/);
    // The job branch got the agent's commit; the base checkout is gone with the run.
    const worktree = path.join(worktreesRoot(paths), '42', c.job.id);
    expect(fs.readFileSync(path.join(worktree, 'README.md'), 'utf8')).toBe('changed by the agent\n');
    expect(f.git(worktree, 'status', '--porcelain')).toBe('');
    expect(fs.existsSync(root)).toBe(false);
  });
});

describe.runIf(sandbox.usable)('git in the sandbox, in a clone the worker made', { timeout: 120_000 }, () => {
  /**
   * A clone made the way `updraft run-event` makes one (ensureClone, then the fetch), with a job
   * worktree; `config` is set on top. Runs `script` in that worktree in the sandbox, with the
   * mounts a contained agent gets. The result carries git's version and trace for a failure.
   */
  async function inSandbox(f, script, config = []) {
    const clone = path.join(f.root, 'worker clone');
    const runtime = installRuntime(path.join(f.root, 'runtime'));
    // As run-event picks it: this runtime runs the host's git, so the clone may use reftable.
    const refFormat = cloneRefFormat({ claude: { container: { runtime: runtime.path, image: SANDBOX_IMAGE } } });
    expect(refFormat).toBe('reftable');
    await ensureClone({ checkoutPath: clone, cloneUrl: f.remoteDir, refFormat });
    for (const [key, value] of config) f.git(clone, 'config', '--local', key, value);
    f.git(clone, 'fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    const worktree = path.join(f.root, 'job');
    f.git(clone, 'worktree', 'add', '--quiet', '-b', 'updraft/issue-1-job_t1', worktree, 'origin/main');
    // Git's own trace of what it ran, for the failure message: which command touched what.
    const traceDir = path.join(f.root, 'trace');
    fs.mkdirSync(traceDir);
    const names = ['GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_TRACE2_PERF'];
    const args = buildContainerRunArgs(
      { file: '/bin/sh', args: ['-c', script] },
      { image: SANDBOX_IMAGE, name: `git-${process.pid}-${Date.now()}`, mounts: [...worktreeMounts(worktree), { path: traceDir, readOnly: false }], workdir: worktree, user: `${process.getuid()}:${process.getgid()}`, envNames: names, network: 'none' },
    );
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com', GIT_TRACE2_PERF: path.join(traceDir, 'perf') };
    const result = spawnSync(runtime.path, args, { env, encoding: 'utf8', timeout: 90_000 });
    let trace = '';
    try {
      trace = fs.readFileSync(path.join(traceDir, 'perf'), 'utf8').split('\n').filter((l) => /\| (start|child_start|cmd_name|region_enter|error) /.test(l)).slice(0, 200).join('\n');
    } catch {
      // no trace
    }
    const format = spawnSync('git', ['rev-parse', '--show-ref-format'], { cwd: clone, encoding: 'utf8' }).stdout.trim() || 'files (git without --show-ref-format)';
    return { ...result, diagnosis: `stderr:\n${result.stderr}\ngit version: ${f.git(f.root, '--version')}; ref store: ${format}\ntrace:\n${trace}` };
  }
  const COMMIT_MANY = 'i=0; while [ $i -lt 3000 ]; do echo $i > f$i; i=$((i+1)); done; git add . && git commit -qm many && echo committed';
  /** Can this git make a reftable repository (2.45 and later)? */
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'updraft reftable probe '));
  const reftable = spawnSync('git', ['init', '--quiet', '--ref-format=reftable', probe], { encoding: 'utf8' }).status === 0;
  fs.rmSync(probe, { recursive: true, force: true });

  it('commits without a read-only git warning: nothing the commit does needs the read-only top of the git directory', async () => {
    fixture = createGitFixture('octo/widgets');
    const result = await inSandbox(fixture, COMMIT_MANY);
    expect(result.stdout, result.diagnosis).toContain('committed');
    expect(result.stderr, result.diagnosis).toBe('');
  });

  it.skipIf(!reftable)(`deletes refs too, with a git that has reftable${reftable ? '' : ' (SKIPPED: this git has no reftable)'}`, async () => {
    fixture = createGitFixture('octo/widgets');
    // Ref updates only: `git branch -d` and `git stash` also rewrite the clone's config, which stays read-only.
    const result = await inSandbox(fixture, 'git update-ref refs/heads/scratch HEAD && git update-ref -d refs/heads/scratch && git update-ref refs/tags/t HEAD && git update-ref -d refs/tags/t && git show-ref --verify --quiet refs/heads/scratch; echo "branch=$?"; git show-ref --verify --quiet refs/tags/t; echo "tag=$?"');
    expect(result.stdout, result.diagnosis).toBe('branch=1\ntag=1\n');
    expect(result.stderr, result.diagnosis).toBe('');
  });
});

if (!sandbox.usable) {
  describe('Updraft container mode with the sandbox runtime', () => {
    it.skip(`skipped: ${sandbox.reason}`, () => {});
  });
}
