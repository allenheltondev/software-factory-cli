import { writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { ConfigError } from '../config/io.js';
import type { Job } from '../types.js';
import { silentLogger } from '../util/log.js';
import { WorkerLockedError, type DaemonDeps } from '../worker/daemon.js';
import { buildWorkflow, seedConfig, upsertRepoWorkflow } from './config-edit.js';
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

function writeConfig(path: string) {
  const cfg = upsertRepoWorkflow(seedConfig('me'), { id: 1, fullName: 'o/r' }, buildWorkflow({ label: 'go', action: 'implement-issue', pool: 'general' })).config;
  writeFileSync(path, stringify(cfg));
}

describe('factory start', () => {
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
    expect(s.deps.createLogger).toHaveBeenCalledWith(expect.objectContaining({ file: expect.stringMatching(/factory\.log$/) }));
    expect(s.closed).toEqual([s.ctx.paths.dbFile]);
    expect(s.uninstall).toHaveBeenCalledOnce();
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
});
