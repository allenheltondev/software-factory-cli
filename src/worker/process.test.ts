import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { isPidAlive, terminateProcessTree } from './process.js';

describe('process control', () => {
  it('detects live and dead pids', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-5)).toBe(false);
  });

  it('terminates a real child process tree', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
      windowsHide: true,
    });
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    const pid = child.pid!;
    expect(isPidAlive(pid)).toBe(true);
    await terminateProcessTree(pid, { graceMs: 2_000 });
    await exited;
    await vi.waitFor(() => expect(isPidAlive(pid)).toBe(false));
  });
});
