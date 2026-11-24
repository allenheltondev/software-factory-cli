// Containerized live runs (agents.<name>.container) against a fake runtime client
// (test/fake-runtime.mjs): real git, real processes, no real container. The fake models what the
// stop logic depends on: killing the client leaves the "container" running, and only a stop or
// removal by name ends it.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_AGENT, fakeAdapter } from '../../test/fake-adapter.js';
import { installFakeRuntime } from '../../test/fake-runtime.js';
import { createGitFixture, type GitFixture } from '../../test/git-fixtures.js';
import { insertQueuedJob } from '../../test/queue-fixtures.js';
import { registerAdapter } from '../agents/adapters/registry.js';
import { configSchema, type UpdraftConfig } from '../config/schema.js';
import { openDatabase, type Db } from '../db/database.js';
import { claimNextJob, getJob, getRun, markExecutionStarted, setRunProcess, type Claim } from '../db/queue.js';
import { worktreesRoot } from '../git/worktree.js';
import { resolvePaths, type UpdraftPaths } from '../paths.js';
import { silentLogger } from '../util/log.js';
import { CONTAINER_HOME } from './container.js';
import { runDaemon } from './daemon.js';
import { StartFailedError, type ExecutionContext } from './executor.js';
import { LiveExecutor } from './live.js';
import { acquireWorkerLock } from './lock.js';
import { createExecutor } from './prepare-only.js';
import { isPidAlive } from './process.js';
import { reconcileInterruptedRuns } from './reconcile.js';
import { removeContainer } from './container.js';
import { countUncommitted, hasSubmodules, summarizeRun } from './run-summary.js';

const fixtures: GitFixture[] = [];
const dbs: Db[] = [];
const restores: Array<() => void> = [];
const strays: number[] = [];

beforeEach(() => {
  restores.push(registerAdapter(fakeAdapter({ name: 'claude' })));
});
afterEach(() => {
  for (const pid of strays.splice(0)) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // gone, as expected
      }
    }
  }
  for (const r of restores.splice(0).reverse()) r();
  for (const db of dbs.splice(0)) db.close();
  for (const f of fixtures.splice(0)) f.cleanup();
});

const SECRET = 'sk-test-0123456789';

function setup(o: { timeoutMinutes?: number; args?: string[]; container?: Record<string, unknown> } = {}) {
  const f = createGitFixture('octo/widgets');
  fixtures.push(f);
  const runtime = installFakeRuntime(join(f.root, 'runtime bin'));
  const paths: UpdraftPaths = resolvePaths({ env: { UPDRAFT_HOME: join(f.root, 'updraft home') } });
  mkdirSync(join(paths.configDir, 'prompts'), { recursive: true });
  writeFileSync(join(paths.configDir, 'prompts', 'implement.md'), 'Implement the issue below. Commit your work.\n');
  const emptyGitConfig = join(f.root, 'agent gitconfig');
  writeFileSync(emptyGitConfig, '');
  const config: UpdraftConfig = configSchema.parse({
    version: 1,
    maxConcurrent: 4,
    execution: { mode: 'live' },
    agents: {
      claude: {
        // With `container`, a path inside the image. The fake runtime runs it on the host, so node works.
        command: process.execPath,
        args: o.args ?? ['--mode', 'success'],
        maxConcurrent: 2,
        // The agent's git identity. In a container run these are set inside the container, by name.
        env: {
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: emptyGitConfig,
          GIT_AUTHOR_NAME: 'Fake Agent',
          GIT_AUTHOR_EMAIL: 'agent@example.com',
          GIT_COMMITTER_NAME: 'Fake Agent',
          GIT_COMMITTER_EMAIL: 'agent@example.com',
        },
        container: { image: 'runner:test', runtime: runtime.path, env: ['FAKE_API_KEY'], ...o.container },
      },
    },
    pools: { general: { agents: ['claude'] } },
    actions: { 'implement-issue': { prompt: './prompts/implement.md', timeoutMinutes: o.timeoutMinutes ?? 2 } },
    dispatch: { allowedActors: ['allen'] },
    repositories: {
      'octo/widgets': {
        id: 42,
        checkoutPath: relative(paths.configDir, f.clone),
        remote: 'origin',
        workflows: [{ trigger: { event: 'issue.labeled', label: 'updraft:ready' }, action: 'implement-issue', pool: 'general' }],
      },
    },
  });
  const db = openDatabase(':memory:');
  dbs.push(db);
  return { f, paths, config, db, runtime };
}

function claim(db: Db, config: UpdraftConfig, paths: UpdraftPaths, workerId = 'wrk_test'): Claim {
  insertQueuedJob(db, { repoId: 42, fullName: 'octo/widgets', issue: 7 });
  const c = claimNextJob(db, config, { workerId, hostname: hostname(), leaseSeconds: 60, runsDir: paths.runsDir });
  if (!c) throw new Error('nothing to claim');
  return c;
}

function context(db: Db, config: UpdraftConfig, paths: UpdraftPaths, runId: string, o: { stopping?: AbortSignal } = {}): ExecutionContext {
  return {
    config,
    paths,
    log: silentLogger,
    signal: new AbortController().signal,
    ...(o.stopping ? { workerStopping: o.stopping } : {}),
    now: Date.now,
    recordProcess: (info) => setRunProcess(db, runId, info),
  };
}

/** The worker's environment: an API key the agent may have, and things it may not. */
const workerEnv = (): NodeJS.ProcessEnv => ({ ...process.env, FAKE_API_KEY: SECRET, GH_TOKEN: 'gh-secret', GITHUB_TOKEN: 'gh-secret', WORKER_ONLY: 'not for the agent' });

/** Never called for a containerized agent: host discovery says nothing about the image. */
const noHostLookup = () => {
  throw new Error('host discovery was used for a containerized agent');
};

async function readPids(file: string): Promise<{ agent: number; child: number }> {
  // The file appears before its content does: wait until it parses, not just until it exists.
  const pids = await vi.waitFor(() => JSON.parse(readFileSync(file, 'utf8')) as { agent: number; child: number }, { timeout: 30_000, interval: 50 });
  strays.push(pids.agent, pids.child);
  return pids;
}

async function expectDead(...pids: number[]) {
  await vi.waitFor(() => expect(pids.filter(isPidAlive)).toEqual([]), { timeout: 15_000, interval: 100 });
}

const valuesOf = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []));

describe.skipIf(process.platform === 'win32')('LiveExecutor with agents.<name>.container (fake runtime)', { timeout: 120_000 }, () => {
  it('collects a contained Vibe export and keeps it out of successful verification', async () => {
    const { paths, config, db, runtime } = setup();
    config.agents.claude!.adapter = 'vibe';
    config.actions['implement-issue']!.verify = [['true']];
    const script = [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const report = process.argv[process.argv.indexOf('--output-dir') + 1];",
      "fs.writeFileSync(path.join(report, 'export.json'), JSON.stringify({ schema_version: 1, steps: 1 }));",
    ].join('\n');
    restores.push(registerAdapter({
      name: 'vibe',
      buildInvocation: ({ launch }) => ({ file: launch.file, args: ['-e', script, '--', '--prompt'], promptVia: 'stdin' }),
    }));

    const c = claim(db, config, paths);
    const result = await new LiveExecutor({ env: workerEnv(), locate: noHostLookup }).execute(c, context(db, config, paths, c.run.id));

    expect(result.outcome).toBe('succeeded');
    const [agent, verify] = runtime.callsOf('run');
    const report = valuesOf(agent!.argv, '--output-dir')[0]!;
    expect(valuesOf(agent!.argv, '--mount')).toContain(`type=bind,source=${report},target=${report}`);
    expect(valuesOf(verify!.argv, '--mount').join('\n')).not.toContain(report);
    expect(existsSync(report)).toBe(false);
    const log = readFileSync(c.run.logPath!, 'utf8');
    expect(log).toContain('vibe usage: {"modelSteps":1}');
    expect(log).toMatch(/---- verify 1\/1:[\s\S]*exit: code 0/);
  });

  it('starts the agent through the runtime, in the worktree, with only the named variables; the commit lands on the job branch', async () => {
    const { f, paths, config, db, runtime } = setup();
    const c = claim(db, config, paths);
    const result = await new LiveExecutor({ env: workerEnv(), locate: noHostLookup }).execute(c, context(db, config, paths, c.run.id));

    expect(result).toMatchObject({ outcome: 'succeeded', summary: { commitCount: 1, filesChanged: 1 } });
    const worktree = join(worktreesRoot(paths), '42', c.job.id);
    expect(f.git(worktree, 'log', '-1', '--format=%s %an')).toBe('fake agent: implement the issue Fake Agent');
    expect(f.git(f.clone, 'status', '--porcelain')).toBe('');

    const name = `updraft-${c.run.id}`;
    const [started] = runtime.callsOf('run');
    expect(started!.started).toBe(name);
    const argv = started!.argv;
    expect(argv.slice(0, 5)).toEqual(['run', '--rm', '-i', '--name', name]);
    expect(valuesOf(argv, '--workdir')).toEqual([worktree]);
    expect(valuesOf(argv, '--user')).toEqual([`${process.getuid!()}:${process.getgid!()}`]);
    // The image, then the configured command as written (not looked up on the host), then the adapter's arguments.
    expect(argv.slice(argv.indexOf('runner:test'))).toEqual(['runner:test', process.execPath, FAKE_AGENT, '--mode', 'success']);

    // Mounts: the worktree, and the clone's git directory read-only except what a commit writes.
    const mounts = Object.fromEntries(valuesOf(argv, '--mount').map((m) => [/source=([^,]*)/.exec(m)![1]!, m.endsWith(',readonly') ? 'ro' : 'rw']));
    // Git records the clone's git directory by its real path (macOS temp dirs sit behind a symlink).
    const common = realpathSync(join(f.clone, '.git'));
    expect(mounts).toMatchObject({
      [worktree]: 'rw',
      [join(worktree, '.git')]: 'ro',
      [common]: 'ro',
      [join(common, 'objects')]: 'rw',
      [join(common, 'refs')]: 'rw',
      [join(common, 'worktrees', c.job.id)]: 'rw',
      [join(common, 'worktrees', c.job.id, 'commondir')]: 'ro',
    });
    for (const p of Object.keys(mounts)) expect(p === worktree || p.startsWith(`${worktree}/`) || p === common || p.startsWith(`${common}/`), p).toBe(true);
    expect(mounts[join(common, 'hooks')]).toBeUndefined();
    expect(mounts[join(common, 'config')]).toBeUndefined();

    // Environment: names on the command line, values only in the container.
    expect(valuesOf(argv, '-e')).toEqual([
      `HOME=${CONTAINER_HOME}`,
      'FAKE_API_KEY',
      'FAKE_ADAPTER_ENV',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_CONFIG_GLOBAL',
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_COMMITTER_EMAIL',
    ]);
    expect(started!.env).toMatchObject({ FAKE_API_KEY: SECRET, FAKE_ADAPTER_ENV: 'from-adapter', GIT_AUTHOR_NAME: 'Fake Agent', HOME: CONTAINER_HOME });
    for (const withheld of ['GH_TOKEN', 'GITHUB_TOKEN', 'WORKER_ONLY', 'USER', 'SSH_AUTH_SOCK']) expect(started!.env).not.toHaveProperty(withheld);
    const log = readFileSync(c.run.logPath!, 'utf8');
    for (const text of [argv.join('\n'), log]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('gh-secret');
    }

    // run.log says what was started and where; output still lands there directly.
    expect(log).toContain(`agent cli: ${process.execPath} (inside image runner:test)`);
    expect(log).toContain(`container: ${name} (runtime ${runtime.path})`);
    expect(log).toContain(`mount (read-only): ${common}`);
    expect(log).toContain('env passed by name: FAKE_API_KEY, FAKE_ADAPTER_ENV, GIT_CONFIG_NOSYSTEM');
    expect(log).toContain('fake agent: all done');

    // The container is recorded for a later worker, and removed by name once the run is over.
    expect(getRun(db, c.run.id)?.container).toEqual({ runtime: runtime.path, name });
    expect(runtime.callsOf('rm').map((x) => x.argv)).toContainEqual(['rm', '-f', name]);
    expect(runtime.containerPid(name)).toBeNull();
  });

  it('mounts the prompt file read-only when the adapter passes the prompt by path', async () => {
    const { f, paths, config, db, runtime } = setup();
    restores.push(registerAdapter(fakeAdapter({ name: 'claude', promptVia: 'file-arg' })));
    const received = join(f.root, 'received.md');
    config.agents.claude!.args = ['--mode', 'success', '--received', received];
    const c = claim(db, config, paths);
    const result = await new LiveExecutor({ env: workerEnv(), locate: noHostLookup }).execute(c, context(db, config, paths, c.run.id));
    expect(result.outcome).toBe('succeeded');
    const promptFile = join(paths.runsDir, c.run.id, 'prompt.md');
    const mounts = valuesOf(runtime.callsOf('run')[0]!.argv, '--mount');
    expect(mounts).toContain(`type=bind,source=${promptFile},target=${promptFile},readonly`);
    // Only that file: run.log and the rest of the run directory stay out of the container.
    expect(mounts.filter((m) => m.includes(paths.runsDir))).toHaveLength(1);
    expect(readFileSync(received, 'utf8')).toBe(readFileSync(promptFile, 'utf8'));
  });

  it('passes container.network and container.args through', async () => {
    const { paths, config, db, runtime } = setup({ container: { network: 'none', args: ['--memory', '4g'] } });
    const c = claim(db, config, paths);
    const result = await new LiveExecutor({ env: workerEnv() }).execute(c, context(db, config, paths, c.run.id));
    expect(result.outcome).toBe('succeeded');
    const argv = runtime.callsOf('run')[0]!.argv;
    expect(valuesOf(argv, '--network')).toEqual(['none']);
    expect(valuesOf(argv, '--memory')).toEqual(['4g']);
  });

  it('a missing image is a start failure before any worktree exists', async () => {
    const { paths, config, db, runtime } = setup({ container: { image: 'missing:latest' } });
    const c = claim(db, config, paths);
    const run = new LiveExecutor({ env: workerEnv() }).execute(c, context(db, config, paths, c.run.id));
    await expect(run).rejects.toThrow(StartFailedError);
    await expect(run).rejects.toThrow(/container image missing:latest is not available .*No such image.*a run never pulls/);
    expect(existsSync(join(worktreesRoot(paths), '42', c.job.id))).toBe(false);
    expect(runtime.callsOf('run')).toEqual([]);
    expect(getRun(db, c.run.id)?.container).toBeNull();
  });

  it('a runtime that is not installed is a start failure', async () => {
    const { paths, config, db } = setup({ container: { runtime: 'no-such-container-runtime' } });
    const c = claim(db, config, paths);
    await expect(new LiveExecutor({ env: workerEnv() }).execute(c, context(db, config, paths, c.run.id))).rejects.toThrow(
      /claude cannot start: container runtime "no-such-container-runtime" was not found on PATH/,
    );
  });

  it('fails the run with the runtime\'s own error when the container cannot be created', async () => {
    const { paths, config, db } = setup({ container: { args: ['--no-such-option'] } });
    const c = claim(db, config, paths);
    const result = await new LiveExecutor({ env: workerEnv() }).execute(c, context(db, config, paths, c.run.id));
    expect(result.outcome).toBe('failed');
    expect(result.error).toMatch(/could not start the container \(exit 125\): unknown flag: --no-such-option/);
  });

  it('at the timeout, stops the container by name; the runtime client alone would have left it running', async () => {
    const { f, paths, config, db, runtime } = setup({ timeoutMinutes: 0.05 });
    const pidsFile = join(f.root, 'hang pids.json');
    config.agents.claude!.args = ['--mode', 'stubborn', '--pids-file', pidsFile];
    const c = claim(db, config, paths);
    const running = new LiveExecutor({ env: workerEnv(), killGraceMs: 500 }).execute(c, context(db, config, paths, c.run.id));
    const pids = await readPids(pidsFile);
    const name = `updraft-${c.run.id}`;
    // The agent is not in the client's process group, as a real container's processes are not.
    expect(runtime.containerPid(name)).toBe(pids.agent);
    expect(getRun(db, c.run.id)?.pid).not.toBe(pids.agent);

    const result = await running;
    expect(result).toMatchObject({ outcome: 'failed', error: 'agent timed out after 0.05 min; its process tree was stopped' });
    await expectDead(pids.agent, pids.child);
    expect(runtime.callsOf('stop').map((x) => x.argv)).toEqual([['stop', '-t', '1', name]]);
    expect(runtime.callsOf('rm').map((x) => x.argv)).toContainEqual(['rm', '-f', name]);
    expect(readFileSync(c.run.logPath!, 'utf8')).toMatch(/exit: .* \(stopped by the worker: timeout\)/);
  });

  it('on worker shutdown, stops the container by name and records the run interrupted', async () => {
    const { f, paths, config, db, runtime } = setup();
    const pidsFile = join(f.root, 'shutdown pids.json');
    config.agents.claude!.args = ['--mode', 'hang', '--pids-file', pidsFile];
    const c = claim(db, config, paths);
    const stopping = new AbortController();
    const running = new LiveExecutor({ env: workerEnv(), killGraceMs: 2_000 }).execute(c, context(db, config, paths, c.run.id, { stopping: stopping.signal }));
    const pids = await readPids(pidsFile);
    stopping.abort();
    const result = await running;
    expect(result).toMatchObject({ outcome: 'interrupted', error: expect.stringMatching(/worker stopped before the run finished/) });
    await expectDead(pids.agent, pids.child);
    expect(runtime.callsOf('stop').map((x) => x.argv)).toEqual([['stop', '-t', '2', `updraft-${c.run.id}`]]);
  });

  it('stops the container when the started client cannot be recorded', async () => {
    const { f, paths, config, db, runtime } = setup();
    const pidsFile = join(f.root, 'unrecorded pids.json');
    config.agents.claude!.args = ['--mode', 'hang', '--pids-file', pidsFile];
    const c = claim(db, config, paths);
    const ctx = context(db, config, paths, c.run.id);
    ctx.recordProcess = (info) => {
      if (typeof info.pid === 'number') {
        strays.push(info.pid);
        throw new Error('database is locked');
      }
      setRunProcess(db, c.run.id, info);
    };
    const result = await new LiveExecutor({ env: workerEnv(), killGraceMs: 500 }).execute(c, ctx);
    expect(result.outcome).toBe('failed');
    expect(runtime.containerPid(`updraft-${c.run.id}`)).toBeNull();
    // The agent may or may not have got as far as writing its pids; either way nothing is left.
    if (existsSync(pidsFile)) await expectDead(...Object.values(await readPids(pidsFile)));
  });
});

describe.skipIf(process.platform === 'win32')('worker crash during a containerized run (fake runtime)', { timeout: 120_000 }, () => {
  /** Worker A claims and starts a hanging containerized run, then is treated as crashed. */
  async function crashedRun() {
    const s = setup();
    const pidsFile = join(s.f.root, 'crash pids.json');
    s.config.agents.claude!.args = ['--mode', 'hang', '--pids-file', pidsFile];
    const host = hostname();
    acquireWorkerLock(s.db, { workerId: 'wrk_crashed', pid: 999_999, hostname: host }, { now: () => Date.now() - 600_000, isPidAlive: () => false });
    const c = claim(s.db, s.config, s.paths, 'wrk_crashed');
    expect(markExecutionStarted(s.db, c.run.id, { workerId: 'wrk_crashed' })).not.toBeNull();
    const orphaned = new LiveExecutor({ env: workerEnv() }).execute(c, context(s.db, s.config, s.paths, c.run.id));
    const pids = await readPids(pidsFile);
    await vi.waitFor(() => expect(getRun(s.db, c.run.id)?.pidStartTime).toBeTruthy(), { timeout: 30_000, interval: 50 });
    return { ...s, c, host, pids, orphaned, name: `updraft-${c.run.id}` };
  }

  it('the restarted worker removes the container by its recorded name and runtime, and marks the run interrupted', async () => {
    const { db, config, paths, runtime, c, host, pids, orphaned, name } = await crashedRun();
    expect(getRun(db, c.run.id)?.container).toEqual({ runtime: runtime.path, name });
    expect(runtime.containerPid(name)).toBe(pids.agent);

    // Worker B starts on the same host with the real process and container control, reconciles, and stops.
    const controller = new AbortController();
    controller.abort();
    await runDaemon({
      db,
      config,
      paths,
      log: silentLogger,
      signal: controller.signal,
      executor: createExecutor(config),
      poll: async () => undefined,
      checkDispatchable: async () => ({ ok: true }),
      hostname: host,
      pid: process.pid,
    });

    await expectDead(pids.agent, pids.child);
    const run = getRun(db, c.run.id)!;
    expect(run.outcome).toBe('interrupted');
    expect(run.error).toContain(`removed leftover container ${name}`);
    expect(getJob(db, c.job.id)?.status).toBe('interrupted');
    expect(runtime.callsOf('container').map((x) => x.argv)).toContainEqual(['container', 'inspect', '--format', '{{.State.Status}}', name]);
    expect(existsSync(run.checkoutPath!)).toBe(true);
    await orphaned;
  });

  it('removing the container is what stops the agent: with the client left alone it still dies', async () => {
    const { db, runtime, host, pids, orphaned, name } = await crashedRun();
    const left: number[] = [];
    const result = await reconcileInterruptedRuns(db, {
      hostname: host,
      // A process control that never signals anything.
      processControl: { isAlive: () => true, startTime: async () => 'never matches', terminate: async (pid) => void left.push(pid) },
      log: silentLogger,
    });
    expect(result.interrupted).toHaveLength(1);
    expect(left).toEqual([]);
    await expectDead(pids.agent, pids.child);
    expect(runtime.containerPid(name)).toBeNull();
    await orphaned;
  });

  it('a container recorded on another host is never touched', async () => {
    const { db, c, runtime, pids, orphaned, name } = await crashedRun();
    const before = runtime.calls().length;
    await reconcileInterruptedRuns(db, { hostname: 'some-other-host', processControl: { isAlive: () => true, startTime: async () => null, terminate: async () => undefined }, log: silentLogger });
    const run = getRun(db, c.run.id)!;
    expect(run.outcome).toBe('interrupted');
    expect(run.error).toMatch(new RegExp(`container ${name} was not removed \\(recorded on host ${hostname()}\\)`));
    expect(run.error).toMatch(/agent pid \d+ was not signalled/);
    expect(runtime.calls().length).toBe(before);
    expect(isPidAlive(pids.agent)).toBe(true);
    // Clean up what the "other host" left running.
    process.kill(-pids.agent, 'SIGKILL');
    await orphaned;
  });
});

describe.skipIf(process.platform === 'win32')('removeContainer (fake runtime)', { timeout: 60_000 }, () => {
  it('has nothing to say when there is no such container, and says how to clean up when the runtime does not answer', async () => {
    const f = createGitFixture('octo/widgets');
    fixtures.push(f);
    const runtime = installFakeRuntime(join(f.root, 'bin'));
    expect(await removeContainer(runtime.path, 'updraft-run_gone')).toEqual({ removed: false, note: '' });
    expect(runtime.callsOf('rm')).toEqual([]);

    runtime.stopDaemon();
    const r = await removeContainer(runtime.path, 'updraft-run_x');
    expect(r.removed).toBe(false);
    expect(r.note).toMatch(/could not check for leftover container updraft-run_x .*Cannot connect to the Docker daemon.*remove it with "docker rm -f updraft-run_x"/);

    const missing = await removeContainer(join(f.root, 'no such runtime'), 'updraft-run_y');
    expect(missing).toMatchObject({ removed: false, note: expect.stringMatching(/could not check for leftover container updraft-run_y/) });
  });
});

describe.skipIf(process.platform === 'win32')('run summary of a worktree a contained agent wrote', { timeout: 60_000 }, () => {
  it('does not run git inside a nested repository the agent left behind, whose config is the agent\'s', async () => {
    const f = createGitFixture('octo/widgets');
    fixtures.push(f);
    const wt = join(f.root, 'wt');
    f.git(f.clone, 'worktree', 'add', '--quiet', '-b', 'updraft/issue-3', wt, 'HEAD');
    const baseSha = f.git(wt, 'rev-parse', 'HEAD');
    // What an agent could leave: a nested repository staged as a submodule, whose config names a
    // command (core.fsmonitor) that git runs on `git status` in it.
    const sub = join(wt, 'vendor');
    const marker = join(f.root, 'ran on the host');
    const hook = join(f.root, 'hook.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    mkdirSync(sub);
    f.git(sub, 'init', '--quiet');
    writeFileSync(join(sub, 'file'), 'one\n');
    f.git(sub, 'add', 'file');
    f.git(sub, 'commit', '--quiet', '-m', 'nested');
    f.git(wt, 'add', 'vendor');
    f.git(wt, 'commit', '--quiet', '-m', 'add vendor');
    f.git(sub, 'config', 'core.fsmonitor', `'${hook}'`);
    writeFileSync(join(sub, 'file'), 'two\n');

    const contained = await summarizeRun({ worktree: wt, branch: 'updraft/issue-3', baseSha, lastOutput: [], untrustedWorktree: true });
    expect(existsSync(marker)).toBe(false);
    // The submodule's commit still counts as a change.
    expect(contained.summary).toMatchObject({ commitCount: 1, filesChanged: 1, notes: [] });

    // The verification step's own look at the worktree obeys the same rule: it does not enter the
    // submodule, reports the superproject as clean, and says there is a submodule it did not inspect.
    expect(await countUncommitted(wt, undefined, true)).toBe(0);
    expect(await hasSubmodules(wt)).toBe(true);
    expect(await hasSubmodules(f.clone)).toBe(false);
    expect(existsSync(marker)).toBe(false);

    // The same summary without the flag is what the flag is for: host git runs the nested config's command.
    await summarizeRun({ worktree: wt, branch: 'updraft/issue-3', baseSha, lastOutput: [] });
    expect(existsSync(marker)).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('verify commands of a containerized agent (fake runtime)', { timeout: 120_000 }, () => {
  it('run in their own containers, with the agent mounts and none of its credentials', async () => {
    const { paths, config, db, runtime } = setup();
    // The commands execute code the agent wrote, so they must not run on the host.
    config.actions['implement-issue']!.verify = [[process.execPath, '-e', 'process.exit(0)'], 'exit 3'];
    const c = claim(db, config, paths);
    const result = await new LiveExecutor({ env: workerEnv(), locate: noHostLookup }).execute(c, context(db, config, paths, c.run.id));

    expect(result).toMatchObject({ outcome: 'failed', error: 'verification failed: "exit 3" exited 3' });
    expect(result.summary?.verification).toMatchObject({ passed: false, commands: [{ status: 'passed' }, { status: 'failed', exitCode: 3 }] });

    const [agent, first, second] = runtime.callsOf('run');
    const worktree = join(worktreesRoot(paths), '42', c.job.id);
    expect(first!.started).toBe(`updraft-${c.run.id}-verify-1`);
    expect(second!.started).toBe(`updraft-${c.run.id}-verify-2`);
    expect(first!.argv.slice(first!.argv.indexOf('runner:test'))).toEqual(['runner:test', process.execPath, '-e', 'process.exit(0)']);
    // A string command goes to the shell inside the container.
    expect(second!.argv.slice(second!.argv.indexOf('runner:test'))).toEqual(['runner:test', '/bin/sh', '-c', 'exit 3']);
    for (const call of [first!, second!]) {
      expect(valuesOf(call.argv, '--workdir')).toEqual([worktree]);
      expect(valuesOf(call.argv, '--mount')).toEqual(valuesOf(agent!.argv, '--mount'));
      // Only the runtime's own options: the first command has a `-e` of its own after the image.
      expect(valuesOf(call.argv.slice(0, call.argv.indexOf('runner:test')), '-e')).toEqual([`HOME=${CONTAINER_HOME}`]);
      expect(call.env).not.toHaveProperty('FAKE_API_KEY');
      expect(call.env).not.toHaveProperty('GH_TOKEN');
    }
    // Nothing is left behind, and the last container recorded for the run is the last one started.
    for (const name of [agent!.started!, first!.started!, second!.started!]) expect(runtime.containerPid(name)).toBeNull();
    expect(getRun(db, c.run.id)?.container?.name).toBe(`updraft-${c.run.id}-verify-2`);
  });
});
