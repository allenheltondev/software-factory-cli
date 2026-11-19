// Updraft's own container mode (src/worker/live.ts, container.ts) driving the sandbox runtime
// for real: the mount plan Updraft builds for a git worktree, an agent that commits inside the
// sandbox, and a verify command in a sandbox of its own. The layout is the microVM's: the
// worktree lives under the job's Updraft home, next to the App key and the state database,
// which the agent and the verify command try to reach.
//
// Runs where bwrap can build a sandbox (sandbox-host.mjs says why when it cannot).
import fs from 'node:fs';
import { hostname } from 'node:os';
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
import { SANDBOX_IMAGE } from '../image/runner/isolation.mjs';
import { installRuntime, sandboxAvailability } from './sandbox-host.mjs';

const sandbox = process.platform === 'win32' ? { usable: false, reason: 'needs Linux' } : sandboxAvailability();
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

if (!sandbox.usable) {
  describe('Updraft container mode with the sandbox runtime', () => {
    it.skip(`skipped: ${sandbox.reason}`, () => {});
  });
}
