// The sandbox runtime, started for real. Needs Linux with bubblewrap installed and
// unprivileged user namespaces allowed; everywhere else the suite is skipped and says why.
// What is tested is the boundary itself: what a command inside can read, write, see and
// inherit, and that a sandbox can be stopped and removed by name from another process.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTAINER_HOME, buildContainerRunArgs, removeContainer, runRuntime, stopContainer } from '../../../src/worker/container.ts';
import { EXIT_NOT_FOUND, EXIT_RUNTIME_FAILED, IMAGE_NAME, imageId, processStart } from '../image/sandbox/updraft-sandbox.mjs';
import { installRuntime, networkNamespaceAvailability, sandboxAvailability } from './sandbox-host.mjs';

const availability = sandboxAvailability();
const SECRET = 'TOP-SECRET-0f3a9c';

let root;
let runtime;
let counter = 0;
const started = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'updraft-sandbox-exec-'));
  runtime = installRuntime(path.join(root, 'runtime'));
});

afterEach(async () => {
  for (const child of started.splice(0)) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // gone, as expected
    }
  }
  // Whatever a failed test left running: remove every sandbox this runtime still knows.
  if (fs.existsSync(runtime.runtimeDir)) {
    for (const file of fs.readdirSync(runtime.runtimeDir)) {
      if (file.endsWith('.json')) spawnSync(runtime.path, ['rm', '-f', file.slice(0, -'.json'.length)], { timeout: 15_000 });
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const nextName = () => `updraft-test-${process.pid}-${(counter += 1)}`;

/** The `run` arguments exactly as Updraft builds them, for a command with these mounts. */
function runArgs(command, { name = nextName(), mounts = [], workdir, envNames, network } = {}) {
  const [file, ...args] = command;
  return buildContainerRunArgs({ file, args }, { image: IMAGE_NAME, name, mounts, workdir, user: `${process.getuid()}:${process.getgid()}`, envNames, network, runLabel: 'test' });
}

/** Run to the end. */
function run(command, options = {}, { env = process.env, input = '', stdio } = {}) {
  return spawnSync(runtime.path, runArgs(command, options), { env, input, encoding: 'utf8', timeout: 60_000, ...(stdio ? { stdio } : {}) });
}

const sh = (script, options, extra) => run(['/bin/sh', '-c', script], options, extra);

/** Start without waiting; resolves `done` with { code, signal, stdout }. */
function start(command, options = {}) {
  const name = options.name ?? nextName();
  const child = spawn(runtime.path, runArgs(command, { ...options, name }), { stdio: ['ignore', 'pipe', 'pipe'] });
  started.push(child);
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout })));
  return { child, name, done, output: () => stdout };
}

const stateOf = (name) => JSON.parse(fs.readFileSync(path.join(runtime.runtimeDir, `${name}.json`), 'utf8'));

/** Wait until the sandbox's init is known and its command has printed `ready`. */
async function ready(job) {
  await vi.waitFor(() => expect(job.output()).toContain('ready'), { timeout: 30_000, interval: 50 });
  return vi.waitFor(() => {
    const state = stateOf(job.name);
    expect(state.initPid).toBeGreaterThan(0);
    return state;
  }, { timeout: 30_000, interval: 50 });
}

/** Every process below `pid`, by /proc of this (the outer) PID namespace. */
function descendants(pid) {
  const parents = new Map();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      parents.set(Number(entry), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
    } catch {
      // gone
    }
  }
  const found = [];
  const walk = (parent) => {
    for (const [child, its] of parents) {
      if (its === parent) {
        found.push(child);
        walk(child);
      }
    }
  };
  walk(pid);
  return found;
}

const running = (pids) => pids.filter((pid) => processStart(pid) !== null);

describe.skipIf(!availability.usable)(`updraft-sandbox, started for real${availability.usable ? '' : ` (SKIPPED: ${availability.reason})`}`, { timeout: 120_000 }, () => {
  it('answers image inspect and info the way Updraft asks', async () => {
    expect(await runRuntime(runtime.path, ['image', 'inspect', '--format', '{{.Id}}', IMAGE_NAME])).toMatchObject({ code: 0, stdout: `${imageId(IMAGE_NAME)}\n` });
    const other = await runRuntime(runtime.path, ['image', 'inspect', '--format', '{{.Id}}', 'my-org/runner:latest']);
    expect(other.code).toBe(1);
    expect(other.stderr).toMatch(/No such image: my-org\/runner:latest/);
    expect((await runRuntime(runtime.path, ['info'])).code).toBe(0);
  });

  it('passes stdin, stdout, stderr and the exit code through', () => {
    const result = sh('cat; echo to-stderr >&2; exit 7', {}, { input: 'the prompt\nsecond line\n' });
    expect(result.status).toBe(7);
    expect(result.stdout).toBe('the prompt\nsecond line\n');
    expect(result.stderr).toBe('to-stderr\n');
    expect(sh('exit 0').status).toBe(0);
    // Killed by a signal inside: 128 + the signal, as docker reports it.
    expect(sh('kill -KILL $$').status).toBe(137);
    // A megabyte in and out, to see that the relay neither truncates nor stalls.
    const big = 'x'.repeat(1024 * 1024);
    const echoed = sh('cat', {}, { input: big });
    expect(echoed.status).toBe(0);
    expect(echoed.stdout.length).toBe(big.length);
  });

  it('exits 125 when it refuses or cannot build the sandbox, 127 when the command does not exist', () => {
    const unknown = spawnSync(runtime.path, ['run', '--rm', '--name', nextName(), '--privileged', IMAGE_NAME, 'true'], { encoding: 'utf8' });
    expect(unknown.status).toBe(EXIT_RUNTIME_FAILED);
    expect(unknown.stderr).toMatch(/unsupported option for run: --privileged/);

    const wrongImage = spawnSync(runtime.path, ['run', '--rm', '--name', nextName(), 'ubuntu:24.04', 'true'], { encoding: 'utf8' });
    expect(wrongImage.status).toBe(EXIT_RUNTIME_FAILED);
    expect(wrongImage.stderr).toMatch(/no such image/);

    const missingMount = run(['true'], { mounts: [{ path: path.join(root, 'does-not-exist'), readOnly: false }] });
    expect(missingMount.status).toBe(EXIT_RUNTIME_FAILED);
    expect(missingMount.stderr).toMatch(/could not be set up/);

    const otherUser = spawnSync(runtime.path, ['run', '--rm', '--name', nextName(), '--user', '4242:4242', IMAGE_NAME, 'true'], { encoding: 'utf8' });
    expect(otherUser.status).toBe(EXIT_RUNTIME_FAILED);
    expect(otherUser.stderr).toMatch(/can only run as its caller/);

    expect(run(['/no/such/command']).status).toBe(EXIT_NOT_FOUND);
    // Nothing is left behind by any of them.
    expect(fs.existsSync(runtime.runtimeDir) ? fs.readdirSync(runtime.runtimeDir) : []).toEqual([]);
  });

  it('hides a secret next to the bound worktree: not readable, not writable, not listed', () => {
    // Laid out like a job: the key and the database in the state directory, the worktree below it.
    const stateDir = path.join(root, 'job-1');
    const worktree = path.join(stateDir, 'worktrees', 'w1');
    fs.mkdirSync(worktree, { recursive: true });
    const key = path.join(stateDir, 'github-app.pem');
    const db = path.join(stateDir, 'state.db');
    fs.writeFileSync(key, SECRET);
    fs.writeFileSync(db, `SQLite format 3 ${SECRET}`);
    fs.writeFileSync(path.join(worktree, 'README.md'), 'hello\n');

    const result = sh(
      `cat ${key}; echo "read-key=$?"; cat ${db}; echo "read-db=$?"
       echo "listing=$(ls -A ${stateDir} | tr '\\n' ' ')"
       echo "worktrees=$(ls -A ${stateDir}/worktrees | tr '\\n' ' ')"
       echo tampered >> ${key}; echo tampered > ${db}
       cat README.md; echo from-inside > made-inside; echo "write-worktree=$?"
       ls /root /home /var/lib 2>&1 | head -5
       touch /made-at-root; echo "write-root=$?"`,
      { mounts: [{ path: worktree, readOnly: false }], workdir: worktree },
    );
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stderr).not.toContain(SECRET);
    expect(result.stdout).toContain('read-key=1');
    expect(result.stdout).toContain('read-db=1');
    expect(result.stdout).toContain('listing=worktrees \n');
    expect(result.stdout).toContain('worktrees=w1 \n');
    expect(result.stdout).toContain('hello\n');
    expect(result.stdout).toContain('write-worktree=0');
    // The sandbox's root is read-only: nothing can be created outside what was mounted.
    expect(result.stdout).toContain('write-root=1');
    // Seen from outside: the worktree got the file, the secrets are untouched. (The state
    // directory lies under /tmp here, which is a tmpfs of the sandbox's own, so the two
    // "writes" above may have succeeded inside without reaching these files.)
    expect(fs.readFileSync(path.join(worktree, 'made-inside'), 'utf8')).toBe('from-inside\n');
    expect(fs.readFileSync(key, 'utf8')).toBe(SECRET);
    expect(fs.readFileSync(db, 'utf8')).toBe(`SQLite format 3 ${SECRET}`);
    expect(fs.readdirSync(stateDir).sort()).toEqual(['github-app.pem', 'state.db', 'worktrees']);
  });

  it('keeps a read-only bind read-only, also below a writable one', () => {
    const tree = path.join(root, 'tree');
    fs.mkdirSync(path.join(tree, 'pinned'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'pinned', 'config'), 'original\n');
    fs.writeFileSync(path.join(tree, 'pointer'), 'gitdir: somewhere\n');
    const result = sh(
      `try() { if ( "$@" ) 2>/dev/null; then echo "$1=done"; else echo "$1=refused"; fi; }
       dir() { echo changed > pinned/config; }; file() { echo changed > pointer; }; unlink() { rm -f pointer; }; move() { mv pinned moved; }; free() { echo fine > free; }
       try dir; try file; try unlink; try move; try free`,
      { mounts: [{ path: tree, readOnly: false }, { path: path.join(tree, 'pinned'), readOnly: true }, { path: path.join(tree, 'pointer'), readOnly: true }], workdir: tree },
    );
    expect(result.stdout.trim().split('\n')).toEqual(['dir=refused', 'file=refused', 'unlink=refused', 'move=refused', 'free=done']);
    expect(fs.readFileSync(path.join(tree, 'pinned', 'config'), 'utf8')).toBe('original\n');
    expect(fs.readFileSync(path.join(tree, 'pointer'), 'utf8')).toBe('gitdir: somewhere\n');
  });

  it('shows no process of the outside, and cannot signal one', async () => {
    const outside = spawn('sleep', ['300'], { stdio: 'ignore' });
    started.push(outside);
    const result = sh(`echo "pids=$(ls /proc | grep -c '^[0-9][0-9]*$')"; echo "self=$$"; kill -0 ${outside.pid} 2>/dev/null; echo "signal=$?"; cat /proc/1/comm; grep -c sleep /proc/[0-9]*/comm 2>/dev/null | grep -v ':0' ; echo "end"; hostname`);
    const pids = Number(/pids=(\d+)/.exec(result.stdout)[1]);
    // bwrap's init, the shell, and the handful of commands of the script itself.
    expect(pids).toBeLessThan(8);
    expect(Number(/self=(\d+)/.exec(result.stdout)[1])).toBeLessThan(8);
    // Unless a process of the sandbox happens to have that number, there is nothing to signal.
    if (outside.pid > 8) expect(result.stdout).toContain('signal=1');
    expect(result.stdout).toContain('bwrap\n');
    expect(result.stdout).toContain('updraft-sandbox\n');
    expect(processStart(outside.pid)).not.toBeNull();
  });

  it('passes on only the variables named, and none of the caller\'s file descriptors', () => {
    const env = { ...process.env, NAMED: 'named-value', NOT_NAMED: SECRET, AWS_SECRET_ACCESS_KEY: SECRET, GH_TOKEN: SECRET, UPDRAFT_HOME: '/somewhere' };
    const listed = run(['/usr/bin/env'], { envNames: ['NAMED', 'UNSET_IN_CALLER'] }, { env });
    expect(listed.status).toBe(0);
    expect(listed.stdout.trim().split('\n').sort()).toEqual([`HOME=${CONTAINER_HOME}`, 'LANG=C.UTF-8', 'NAMED=named-value', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'PWD=/']);

    // A file the caller has open, handed to the runtime as descriptors 3 and 6 (as a worker's
    // database or log file would be if it were inheritable).
    const secretFile = path.join(root, 'open-secret');
    fs.writeFileSync(secretFile, SECRET);
    const fd = fs.openSync(secretFile, 'r');
    try {
      const result = sh(
        'for fd in 3 4 5 6 7 8 9; do eval "cat <&$fd" 2>/dev/null; done; echo "fds=$(ls /proc/self/fd | tr "\\n" " ")"; echo done',
        {},
        { env, stdio: ['pipe', 'pipe', 'pipe', fd, 'ignore', 'ignore', fd] },
      );
      expect(result.stdout).not.toContain(SECRET);
      expect(result.stdout).toContain('done');
      // 0, 1, 2 and the descriptor `ls` itself holds on the directory.
      expect(/fds=([0-9 ]+)/.exec(result.stdout)[1].trim().split(' ')).toEqual(['0', '1', '2', '3']);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('does not hand the command the file its output goes to', () => {
    // Updraft gives the runtime client the run log as stdout. A command that had that file
    // itself could read the log back, or empty it, through /proc/self/fd.
    const log = path.join(root, 'run.log');
    fs.writeFileSync(log, 'header written by the worker\n');
    const fd = fs.openSync(log, 'a');
    try {
      const result = sh(
        'echo before; if (head -c 1 < /proc/self/fd/1 > /dev/null) 2>/dev/null; then echo read-back; else echo no-read-back; fi; if (: > /proc/self/fd/1) 2>/dev/null; then echo truncated; else echo not-truncated; fi; echo after',
        {},
        { stdio: ['pipe', fd, fd] },
      );
      expect(result.status).toBe(0);
    } finally {
      fs.closeSync(fd);
    }
    expect(fs.readFileSync(log, 'utf8')).toBe('header written by the worker\nbefore\nno-read-back\nnot-truncated\nafter\n');
  });

  it('has no capabilities and no way to get any, and its own private scratch space', () => {
    const result = sh(`grep -E '^(CapEff|CapPrm|CapBnd|NoNewPrivs)' /proc/self/status; echo "home=$HOME"; echo scratch > $HOME/x && echo "home-writable"; echo scratch > /tmp/x && echo "tmp-writable"; echo "tmp=$(ls -A /tmp | tr '\\n' ' ')"`);
    expect(result.stdout).toMatch(/CapEff:\s+0000000000000000/);
    expect(result.stdout).toMatch(/CapPrm:\s+0000000000000000/);
    expect(result.stdout).toMatch(/CapBnd:\s+0000000000000000/);
    expect(result.stdout).toMatch(/NoNewPrivs:\s+1/);
    expect(result.stdout).toContain(`home=${CONTAINER_HOME}`);
    expect(result.stdout).toContain('home-writable');
    expect(result.stdout).toContain('tmp-writable');
    // /tmp is the sandbox's own: none of the caller's temporary files (this test's directory included).
    expect(result.stdout).toContain('tmp=x \n');
    expect(result.stdout).not.toContain(path.basename(root));
  });

  const network = networkNamespaceAvailability();
  it.skipIf(!network.usable)(`--network none takes the network away; without it the caller's loopback is reachable${network.usable ? '' : ` (SKIPPED: ${network.reason})`}`, () => {
    const isolated = sh('cat /proc/net/dev | grep -c -v -E "lo:|Inter|face"', { network: 'none' });
    expect(isolated.stdout.trim()).toBe('0');
  });

  it('is reported as running, and stop ends it and its children from another process', async () => {
    const job = start(['/bin/sh', '-c', 'trap "echo got-term; exit 9" TERM; sleep 300 & sleep 301 & echo ready; while :; do sleep 0.1; done']);
    const state = await ready(job);
    expect(state).toMatchObject({ name: job.name, labels: { 'updraft.run': 'test' } });
    const inside = descendants(state.initPid);
    expect(inside.length).toBeGreaterThanOrEqual(3);

    expect(await runRuntime(runtime.path, ['container', 'inspect', '--format', '{{.State.Status}}', job.name])).toMatchObject({ code: 0, stdout: 'running\n' });
    // A second run under the same name is refused while this one lives.
    const conflict = spawnSync(runtime.path, runArgs(['true'], { name: job.name }), { encoding: 'utf8' });
    expect(conflict.status).toBe(EXIT_RUNTIME_FAILED);
    expect(conflict.stderr).toMatch(/already in use/);

    // Updraft's own stop: `stop -t <grace>`, then `rm -f`. SIGTERM reaches the command.
    await stopContainer(runtime.path, job.name, 10_000);
    const ended = await job.done;
    expect(ended.code).toBe(9);
    expect(ended.stdout).toContain('got-term');
    expect(running([state.initPid, ...inside])).toEqual([]);
    expect(fs.existsSync(path.join(runtime.runtimeDir, `${job.name}.json`))).toBe(false);
    const gone = await runRuntime(runtime.path, ['container', 'inspect', '--format', '{{.State.Status}}', job.name]);
    expect(gone.code).toBe(1);
    // The words removeContainer (src/worker/container.ts) looks for.
    expect(gone.stderr).toMatch(/no such (container|object)/i);
    expect(await removeContainer(runtime.path, job.name)).toEqual({ removed: false, note: '' });
  });

  it('stop kills a command that ignores SIGTERM once the grace period is over', async () => {
    const job = start(['/bin/sh', '-c', 'trap "" TERM; sleep 300 & echo ready; while :; do sleep 0.1; done']);
    const state = await ready(job);
    const inside = descendants(state.initPid);
    const before = Date.now();
    await stopContainer(runtime.path, job.name, 1000);
    expect(Date.now() - before).toBeGreaterThanOrEqual(900);
    expect((await job.done).code).toBe(137);
    expect(running([state.initPid, ...inside])).toEqual([]);
  });

  it('rm -f ends a running sandbox and everything in it, as a later worker does for a leftover', async () => {
    const job = start(['/bin/sh', '-c', 'trap "" TERM; (sleep 300 &) ; sleep 301 & echo ready; while :; do sleep 0.1; done']);
    const state = await ready(job);
    const inside = descendants(state.initPid);
    expect(await removeContainer(runtime.path, job.name)).toEqual({ removed: true, note: `removed leftover container ${job.name}` });
    expect((await job.done).code).toBe(137);
    expect(running([state.initPid, state.bwrapPid, ...inside])).toEqual([]);
    expect(fs.readdirSync(runtime.runtimeDir)).toEqual([]);
    // Removing what is not there is not an error.
    expect((await runRuntime(runtime.path, ['rm', '-f', job.name])).code).toBe(0);
  });

  it('dies with its runtime client: killing the client outright leaves nothing running', async () => {
    const job = start(['/bin/sh', '-c', 'sleep 300 & echo ready; while :; do sleep 0.1; done']);
    const state = await ready(job);
    const inside = descendants(state.initPid);
    process.kill(state.supervisorPid, 'SIGKILL');
    await vi.waitFor(() => expect(running([state.bwrapPid, state.initPid, ...inside])).toEqual([]), { timeout: 15_000, interval: 100 });
    // The stale record does not count as a container, and its name can be used again.
    expect((await runRuntime(runtime.path, ['container', 'inspect', '--format', '{{.State.Status}}', job.name])).code).toBe(1);
    expect(spawnSync(runtime.path, runArgs(['true'], { name: job.name }), { encoding: 'utf8' }).status).toBe(0);
  });

  it('forwards SIGTERM sent to the client to the command', async () => {
    const job = start(['/bin/sh', '-c', 'trap "echo got-term; exit 5" TERM; echo ready; while :; do sleep 0.1; done']);
    await ready(job);
    job.child.kill('SIGTERM');
    expect(await job.done).toMatchObject({ code: 5 });
  });

  it('refuses a config file that others can write', () => {
    fs.chmodSync(runtime.configFile, 0o666);
    const result = spawnSync(runtime.path, runArgs(['true']), { encoding: 'utf8' });
    expect(result.status).toBe(EXIT_RUNTIME_FAILED);
    expect(result.stderr).toMatch(/writable by its group or by everyone/);
  });
});

// As a user that is not root, where this process is root and can become one: the uid the
// command runs as is that user's, and root's files stay root's.
const NOBODY = 65534;
const canDropPrivileges = availability.usable && process.getuid?.() === 0;

describe.skipIf(!canDropPrivileges)(`updraft-sandbox as an unprivileged user${canDropPrivileges ? '' : ' (SKIPPED: needs root to switch user, and a usable sandbox)'}`, { timeout: 120_000 }, () => {
  it('runs as that user, without root\'s files and without a way back', () => {
    // The runtime directory and the bound directory must be the user's own.
    fs.chmodSync(root, 0o755);
    const home = path.join(root, 'job');
    const work = path.join(home, 'work');
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(home, 'root-secret'), SECRET, { mode: 0o600 });
    fs.chownSync(work, NOBODY, NOBODY);
    fs.mkdirSync(runtime.runtimeDir, { recursive: true });
    fs.chownSync(runtime.runtimeDir, NOBODY, NOBODY);
    const args = buildContainerRunArgs(
      { file: '/bin/sh', args: ['-c', `id -u; cat ${home}/root-secret 2>&1; cat /etc/shadow 2>&1; echo mine > made; ls -ln made | awk '{print $3}'; grep -E '^CapEff' /proc/self/status`] },
      { image: IMAGE_NAME, name: nextName(), mounts: [{ path: work, readOnly: false }], workdir: work, user: `${NOBODY}:${NOBODY}` },
    );
    const result = spawnSync(runtime.path, args, { uid: NOBODY, gid: NOBODY, encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stdout.split('\n')[0]).toBe(String(NOBODY));
    expect(result.stdout).toMatch(/CapEff:\s+0000000000000000/);
    expect(fs.statSync(path.join(work, 'made')).uid).toBe(NOBODY);
  });
});
