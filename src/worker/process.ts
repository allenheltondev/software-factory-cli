// OWNER: queue/worker workstream. Cross-platform process liveness and termination.
import { execFile } from 'node:child_process';

/** Injectable so tests (and reconcile) never touch real processes. */
export interface ProcessControl {
  isAlive(pid: number): boolean;
  /** Best effort: stop the process and its children. Never rejects. */
  terminate(pid: number): Promise<void>;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Terminate a process tree, best effort.
 * - Windows: `taskkill /pid N /t /f` (kills the tree).
 * - POSIX: SIGTERM to the process group (adapters should spawn agents detached so
 *   the agent leads its own group), falling back to the pid; SIGKILL after graceMs.
 */
export async function terminateProcessTree(
  pid: number,
  opts: { platform?: NodeJS.Platform; graceMs?: number; isAlive?: (pid: number) => boolean } = {},
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const platform = opts.platform ?? process.platform;
  const alive = opts.isAlive ?? isPidAlive;
  if (platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, () => resolve());
    });
    return;
  }
  const send = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
      return;
    } catch {
      // not a group leader (or already gone); fall back to the single process
    }
    try {
      process.kill(pid, sig);
    } catch {
      // already gone
    }
  };
  send('SIGTERM');
  const deadline = Date.now() + (opts.graceMs ?? 5_000);
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await delay(100);
  }
  if (alive(pid)) send('SIGKILL');
}

export const defaultProcessControl: ProcessControl = {
  isAlive: isPidAlive,
  terminate: (pid) => terminateProcessTree(pid).catch(() => undefined),
};
