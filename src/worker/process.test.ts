import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { checkPidIdentity, defaultProcessControl, isPidAlive, processStartTime, terminateIfSameProcess, terminateProcessTree } from './process.js';

function sleeper() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
  });
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  return { pid: child.pid!, exited, kill: () => child.kill('SIGKILL') };
}

// PowerShell (Windows) is slow to start.
describe('process control', { timeout: 60_000 }, () => {
  it('detects live and dead pids', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-5)).toBe(false);
  });

  it('terminates a real child process tree', async () => {
    const s = sleeper();
    expect(isPidAlive(s.pid)).toBe(true);
    await terminateProcessTree(s.pid, { graceMs: 2_000 });
    await s.exited;
    await vi.waitFor(() => expect(isPidAlive(s.pid)).toBe(false));
  });

  it('reads a stable, platform-tagged start time for a live process', async () => {
    const a = sleeper();
    const b = sleeper();
    try {
      const [a1, a2, b1] = await Promise.all([processStartTime(a.pid), processStartTime(a.pid), processStartTime(b.pid)]);
      expect(a1).toMatch(new RegExp(`^${process.platform}:.+`));
      expect(b1).toMatch(new RegExp(`^${process.platform}:.+`));
      expect(a2).toBe(a1);
      // Start times alone don't tell processes apart: the resolution is one second for macOS
      // `ps lstart` and one clock tick on Linux, so processes started back to back can share one.
      // Identity is pid + start time; the next test checks that a different recorded start time
      // for the same pid blocks signalling.
      expect(await processStartTime(0)).toBeNull();
    } finally {
      a.kill();
      b.kill();
      await Promise.all([a.exited, b.exited]);
    }
    expect(await processStartTime(a.pid)).toBeNull();
  });

  it('only terminates a pid whose start time still matches the recorded one', async () => {
    const s = sleeper();
    try {
      const recorded = await processStartTime(s.pid);
      expect(await checkPidIdentity(defaultProcessControl, s.pid, recorded)).toBe('match');
      expect(await checkPidIdentity(defaultProcessControl, s.pid, null)).toBe('unrecorded');
      const reused = await terminateIfSameProcess(defaultProcessControl, s.pid, `${process.platform}:another process`);
      expect(reused).toEqual({ terminated: false, note: `agent pid ${s.pid} was not signalled (it now belongs to a different process)` });
      expect(isPidAlive(s.pid)).toBe(true);
      expect(await terminateIfSameProcess(defaultProcessControl, s.pid, recorded)).toEqual({
        terminated: true,
        note: `terminated leftover agent process ${s.pid}`,
      });
      await s.exited;
      expect(await checkPidIdentity(defaultProcessControl, s.pid, recorded)).toBe('gone');
    } finally {
      s.kill();
    }
  });
});
