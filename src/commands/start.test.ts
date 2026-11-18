import { writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { ConfigError } from '../config/io.js';
import type { Job } from '../types.js';
import { createLogger, silentLogger } from '../util/log.js';
import { WorkerLockedError, type DaemonDeps } from '../worker/daemon.js';
import { LogOnlyExecutor } from '../worker/executor.js';
import { PrepareOnlyExecutor } from '../worker/prepare-only.js';
import { GitHubAppError } from '../github/app-auth.js';
import { createUserCredentials } from '../github/credentials.js';
import { buildWorkflow, seedConfig, upsertRepoWorkflow } from './config-edit.js';
import { describeError } from './errors.js';
import { fakeApi, fakeContext } from './fakes.js';
import { startCommand, type StartDeps } from './start.js';

function setup(runDaemon: StartDeps['runDaemon']) {
  const api = fakeApi();
  const ctx = fakeContext({ api });
  const closed: string[] = [];
  ctx.openDb = (file) => ({ close: () => closed.push(file) }) as never;
  let abortFn: ((s: string) => void) | undefined;
  const uninstall = vi.fn();
  const deps: StartDeps = {
    runDaemon,
    pollOnce: vi.fn(async () => ({ repos: [], jobsCanceled: 0 })),
    checkJobDispatchable: vi.fn(async () => ({ ok: true }) as const),
    createLogger: vi.fn(() => silentLogger),
    onShutdownSignal: (abort) => {
      abortFn = abort;
      return uninstall;
    },
  };
  return { ctx, api, deps, closed, uninstall, abort: (s: string) => abortFn?.(s) };
}

function writeConfig(path: string, mode: 'log-only' | 'prepare-only' = 'log-only') {
  const cfg = upsertRepoWorkflow(seedConfig('me'), { id: 1, fullName: 'o/r' }, buildWorkflow({ label: 'go', action: 'implement-issue', pool: 'general' })).config;
  cfg.execution = { mode };
  if (mode === 'prepare-only') cfg.repositories!['o/r']!.checkoutPath = '../clones/o r';
  writeFileSync(path, stringify(cfg));
}

describe('updraft start', () => {
  it('fails with a ConfigError when there is no config', async () => {
    const s = setup(async () => {});
    await expect(startCommand(s.ctx, s.deps)).rejects.toBeInstanceOf(ConfigError);
  });

  it('wires the DB, poller and dispatch check into the daemon and stops on a signal', async () => {
    let seen: DaemonDeps | undefined;
    const s = setup(async (d) => {
      seen = d;
      await d.poll();
      await d.checkDispatchable({ id: 'job_1' } as Job);
      s.abort('SIGINT');
      expect(d.signal.aborted).toBe(true);
    });
    writeConfig(s.ctx.paths.configFile);
    expect(await startCommand(s.ctx, s.deps)).toBe(0);
    expect(seen?.paths).toBe(s.ctx.paths);
    expect(Object.keys(seen!.config.repositories)).toEqual(['o/r']);
    expect(s.deps.pollOnce).toHaveBeenCalledWith(expect.objectContaining({ api: s.api, config: seen!.config }));
    expect(s.deps.checkJobDispatchable).toHaveBeenCalledWith({ api: s.api, config: seen!.config }, { id: 'job_1' });
    expect(s.deps.createLogger).toHaveBeenCalledWith(expect.objectContaining({ file: expect.stringMatching(/updraft\.log$/) }));
    expect(s.closed).toEqual([s.ctx.paths.dbFile]);
    expect(s.uninstall).toHaveBeenCalledOnce();
  });

  it('selects the executor from execution.mode', async () => {
    const executors: unknown[] = [];
    for (const mode of ['log-only', 'prepare-only'] as const) {
      const s = setup(async (d) => {
        executors.push(d.executor);
      });
      writeConfig(s.ctx.paths.configFile, mode);
      expect(await startCommand(s.ctx, s.deps)).toBe(0);
    }
    expect(executors[0]).toBeInstanceOf(LogOnlyExecutor);
    expect(executors[1]).toBeInstanceOf(PrepareOnlyExecutor);
  });

  it('gives the daemon a failure commenter only in live mode with commentOnFailure set', async () => {
    const wired = async (mode: 'log-only' | 'live', commentOnFailure: boolean) => {
      let seen: DaemonDeps | undefined;
      const s = setup(async (d) => {
        seen = d;
      });
      const cfg = upsertRepoWorkflow(seedConfig('me'), { id: 1, fullName: 'o/r' }, buildWorkflow({ label: 'go', action: 'implement-issue', pool: 'general' })).config;
      cfg.execution = { mode };
      cfg.agents = { claude: {} };
      cfg.pools = { general: { agents: ['claude'] } };
      cfg.repositories!['o/r']!.checkoutPath = '../clones/o r';
      if (commentOnFailure) (cfg.repositories!['o/r'] as { commentOnFailure?: boolean }).commentOnFailure = true;
      writeFileSync(s.ctx.paths.configFile, stringify(cfg));
      expect(await startCommand(s.ctx, s.deps)).toBe(0);
      return { commenter: seen?.failureCommenter, publisher: seen?.publisher };
    };
    expect((await wired('live', true)).commenter).toMatchObject({ afterRun: expect.any(Function), retryDue: expect.any(Function) });
    // Its own switch: it does not need publish, and publish does not turn it on.
    expect((await wired('live', true)).publisher).toBeUndefined();
    expect((await wired('live', false)).commenter).toBeUndefined();
    expect((await wired('log-only', true)).commenter).toBeUndefined();
  });

  it('propagates WorkerLockedError and still closes the DB', async () => {
    const s = setup(async () => {
      throw new WorkerLockedError({ workerId: 'w', pid: 1, hostname: 'h', heartbeatAt: 't' });
    });
    writeConfig(s.ctx.paths.configFile);
    await expect(startCommand(s.ctx, s.deps)).rejects.toBeInstanceOf(WorkerLockedError);
    expect(s.closed).toHaveLength(1);
    expect(s.uninstall).toHaveBeenCalledOnce();
  });

  it('warns, without stopping, when the CLI runs from the npx cache', async () => {
    for (const [cliFile, warned] of [
      ['C:\\Users\\jane\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\@allenheltondev\\updraft\\dist\\commands\\start.js', true],
      ['/usr/local/lib/node_modules/@allenheltondev/updraft/dist/commands/start.js', false],
    ] as const) {
      const ran = vi.fn(async () => {});
      const s = setup(ran);
      const lines: string[] = [];
      s.deps.createLogger = () => createLogger({ stream: { write: (l: string) => lines.push(l) } as never });
      writeConfig(s.ctx.paths.configFile);
      expect(await startCommand(s.ctx, { ...s.deps, cliFile })).toBe(0);
      expect(ran).toHaveBeenCalledOnce();
      expect(lines.some((l) => /npx cache.*npm install -g @allenheltondev\/updraft/.test(l))).toBe(warned);
    }
  });
});

describe('updraft start with a GitHub App (github.app)', () => {
  function writeAppConfig(path: string) {
    const cfg = upsertRepoWorkflow(seedConfig('me'), { id: 1, fullName: 'o/r' }, buildWorkflow({ label: 'go', action: 'implement-issue', pool: 'general' })).config;
    writeFileSync(path, stringify({ ...cfg, github: { app: { appId: 12345, privateKeyPath: 'app.pem' } } }));
  }

  it("creates the API with the worker's credentials, built from the config", async () => {
    let ran = false;
    const s = setup(async () => {
      ran = true;
    });
    writeAppConfig(s.ctx.paths.configFile);
    const credentials = createUserCredentials(async () => 'tok');
    const asked: unknown[] = [];
    s.ctx.createCredentials = (config) => {
      asked.push(config?.github);
      return credentials;
    };
    const given: unknown[] = [];
    s.ctx.createApi = async (opts) => {
      given.push(opts?.credentials);
      return s.api;
    };
    expect(await startCommand(s.ctx, s.deps)).toBe(0);
    expect(ran).toBe(true);
    expect(asked).toEqual([{ app: { appId: 12345, privateKeyPath: 'app.pem' } }]);
    expect(given).toEqual([credentials]);
  });

  it('does not start the worker when the key cannot be used', async () => {
    let ran = false;
    const s = setup(async () => {
      ran = true;
    });
    writeAppConfig(s.ctx.paths.configFile);
    s.ctx.createCredentials = () => {
      throw new GitHubAppError('the GitHub App private key /cfg/app.pem does not exist. Set github.app.privateKeyPath', 'key');
    };
    await expect(startCommand(s.ctx, s.deps)).rejects.toThrow(/private key .* does not exist/);
    expect(ran).toBe(false);
    expect(s.closed).toHaveLength(1);
    // The message is the App's own, not advice about gh.
    expect(describeError(new GitHubAppError('the GitHub App private key /cfg/app.pem does not exist', 'key')).message).toBe('the GitHub App private key /cfg/app.pem does not exist');
  });
});
