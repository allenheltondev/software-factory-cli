// OWNER: queue/worker workstream. Cross-platform process liveness, identity and termination.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { win32 } from 'node:path';

/** Injectable so tests (and reconcile) never touch real processes. */
export interface ProcessControl {
  isAlive(pid: number): boolean;
  /** The OS start time of a live pid (see {@link processStartTime}); null when it can't be read. */
  startTime(pid: number): Promise<string | null>;
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

const IDENTITY_TIMEOUT_MS = 15_000;

function execText(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { windowsHide: true, timeout: IDENTITY_TIMEOUT_MS, env, encoding: 'utf8' }, (err, stdout) => {
        resolve(err ? null : String(stdout));
      });
    } catch {
      resolve(null);
    }
  });
}

export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  return root ? win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
}

/**
 * The OS start time of a process, as a platform-tagged string that is equal for the same process
 * and (in practice) different for any later process that reuses its pid. Null when the process
 * is gone or the time can't be read (e.g. another user's process on Windows).
 *
 * - Linux: `starttime` (clock ticks since boot, field 22 of /proc/<pid>/stat) plus the boot ID,
 *   so a pid reused after a reboot doesn't match.
 * - macOS and other POSIX: `ps -o lstart= -p <pid>` (one-second resolution) in the C locale and UTC.
 * - Windows: `(Get-Process -Id <pid>).StartTime` in UTC ticks, via powershell.exe started directly
 *   (execFile with an argument list; the pid is a validated integer).
 */
export async function processStartTime(pid: number, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'linux') {
    let stat: string;
    try {
      stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return null;
    }
    // The command name (field 2) is in parentheses and may contain spaces or ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = fields[19]; // field 22 overall; fields[0] is field 3 (state)
    if (!ticks || !/^\d+$/.test(ticks)) return null;
    let bootId = '';
    try {
      bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    } catch {
      // still unique within this boot
    }
    return `linux:${bootId}:${ticks}`;
  }
  if (platform === 'win32') {
    const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().Ticks }`;
    const out = await execText(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
    const ticks = out?.trim();
    return ticks && /^\d+$/.test(ticks) ? `win32:${ticks}` : null;
  }
  const out = await execText(platform === 'darwin' ? '/bin/ps' : 'ps', ['-o', 'lstart=', '-p', String(pid)], {
    ...process.env,
    LC_ALL: 'C',
    TZ: 'UTC',
  });
  const lstart = out?.trim().replace(/\s+/g, ' ');
  return lstart ? `${platform}:${lstart}` : null;
}

/** What a recorded (pid, start time) pair refers to now. */
export type PidIdentity =
  /** The same process is still running. */
  | 'match'
  /** No process has that pid. */
  | 'gone'
  /** A different process has the pid now. */
  | 'reused'
  /** No start time was recorded (a run from before v5, or a crash before it was read). */
  | 'unrecorded'
  /** The pid is live but its start time can't be read, so it can't be verified. */
  | 'unreadable';

export async function checkPidIdentity(pc: ProcessControl, pid: number, recordedStartTime: string | null): Promise<PidIdentity> {
  if (!pc.isAlive(pid)) return 'gone';
  if (!recordedStartTime) return 'unrecorded';
  const current = await pc.startTime(pid);
  if (current === null) return pc.isAlive(pid) ? 'unreadable' : 'gone';
  return current === recordedStartTime ? 'match' : 'reused';
}

/**
 * Terminate a recorded agent process only if it is still the same process (pid and start time).
 * Returns a note for the run's error text ('' when there was nothing to do).
 */
export async function terminateIfSameProcess(pc: ProcessControl, pid: number, recordedStartTime: string | null): Promise<{ terminated: boolean; note: string }> {
  const identity = await checkPidIdentity(pc, pid, recordedStartTime);
  switch (identity) {
    case 'gone':
      return { terminated: false, note: '' };
    case 'unrecorded':
      return { terminated: false, note: `agent pid ${pid} was not signalled (no process start time was recorded to verify it)` };
    case 'unreadable':
      return { terminated: false, note: `agent pid ${pid} was not signalled (its start time could not be read to verify it)` };
    case 'reused':
      return { terminated: false, note: `agent pid ${pid} was not signalled (it now belongs to a different process)` };
    case 'match':
      try {
        await pc.terminate(pid);
        return { terminated: true, note: `terminated leftover agent process ${pid}` };
      } catch (err) {
        return { terminated: false, note: `could not terminate agent process ${pid}: ${(err as Error).message}` };
      }
  }
}

/**
 * Terminate a process tree, best effort.
 * - Windows: `taskkill /pid N /t /f` (kills the tree).
 * - POSIX: SIGTERM to the process group (live execution spawns agents detached, so the agent
 *   leads its own group), falling back to the pid; SIGKILL after graceMs.
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
      execFile(taskkillPath(), ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, () => resolve());
    });
    return;
  }
  // A process group ID can't be reused while any member is alive, so signalling the group is
  // safe even after its leader exited. The bare pid is only signalled while it is alive.
  const group = (sig: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      return false; // not a group leader, or the group is empty
    }
  };
  const single = (sig: NodeJS.Signals) => {
    try {
      process.kill(pid, sig);
    } catch {
      // already gone
    }
  };
  if (!group('SIGTERM')) single('SIGTERM');
  const deadline = Date.now() + (opts.graceMs ?? 5_000);
  while (Date.now() < deadline) {
    if (!group(0) && !alive(pid)) return;
    await delay(100);
  }
  // SIGKILL whatever is left of the group (members that ignored SIGTERM may outlive the leader).
  if (!group('SIGKILL') && alive(pid)) single('SIGKILL');
}

export function taskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  return root ? win32.join(root, 'System32', 'taskkill.exe') : 'taskkill.exe';
}

export const defaultProcessControl: ProcessControl = {
  isAlive: isPidAlive,
  startTime: (pid) => processStartTime(pid),
  terminate: (pid) => terminateProcessTree(pid).catch(() => undefined),
};
