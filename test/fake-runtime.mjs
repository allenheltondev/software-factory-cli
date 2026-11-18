#!/usr/bin/env node
// Test-only stand-in for a container runtime client (docker / podman). Never used at runtime.
//
// It isolates nothing. It understands the subcommands the worker uses, records every call, and
// models the one property the worker's stop logic depends on: the "container" is NOT a child the
// client's death takes with it. `run` starts the command in its own process group and, when the
// client is signalled, the client exits and leaves the command running. Only `stop`, `kill` or
// `rm -f` by name end it.
//
//   FAKE_RUNTIME_STATE  directory for calls.jsonl (one JSON object per call: {argv, ...}) and
//                       <name>.pid files of running "containers". Required.
//
//   run [options] <image> <command> [args...]   options as `docker run`; unknown ones exit 125
//   stop -t <seconds> <name> | kill <name> | rm -f <name>
//   container inspect --format <f> <name>       prints "running", or exits 1 "No such container"
//   image inspect --format <f> <image>          exits 1 for images named missing*
//   info                                        exits 1 when <state>/daemon-down exists
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const state = process.env.FAKE_RUNTIME_STATE;
if (!state) {
  process.stderr.write('fake runtime: FAKE_RUNTIME_STATE is not set\n');
  process.exit(2);
}
const record = (extra = {}) => appendFileSync(join(state, 'calls.jsonl'), `${JSON.stringify({ argv, ...extra })}\n`);
const fail = (code, msg) => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};
const pidFile = (name) => join(state, `${name}.pid`);
const containerPid = (name) => {
  try {
    return Number(readFileSync(pidFile(name), 'utf8'));
  } catch {
    return null;
  }
};
const groupAlive = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};
const signalGroup = (pid, sig) => {
  try {
    process.kill(-pid, sig);
  } catch {
    // already gone
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WITH_VALUE = new Set(['--name', '--pull', '--label', '--user', '--cap-drop', '--security-opt', '--tmpfs', '-e', '--mount', '--workdir', '--network', '--memory']);
const BARE = new Set(['--rm', '-i']);

async function run(args) {
  const opts = {};
  let i = 0;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    const flag = args[i];
    if (BARE.has(flag)) continue;
    if (!WITH_VALUE.has(flag)) fail(125, `unknown flag: ${flag}`);
    (opts[flag] ??= []).push(args[++i]);
  }
  const [image, file, ...rest] = args.slice(i);
  if (!image || !file) fail(125, 'fake runtime: run needs an image and a command');
  const name = opts['--name']?.[0];
  if (!name) fail(125, 'fake runtime: run needs --name');
  if (image.startsWith('missing')) fail(125, `Unable to find image '${image}' locally`);
  if (containerPid(name) !== null) fail(125, `Conflict. The container name "/${name}" is already in use`);
  for (const m of opts['--mount'] ?? []) {
    const source = /(?:^|,)source=([^,]*)/.exec(m)?.[1];
    if (!source || !existsSync(source)) fail(125, `invalid mount config for type "bind": bind source path does not exist: ${source}`);
  }
  // Only what was passed with -e reaches the command (plus a PATH, which a real image brings itself).
  const env = { PATH: process.env.PATH };
  for (const e of opts['-e'] ?? []) {
    const eq = e.indexOf('=');
    if (eq >= 0) env[e.slice(0, eq)] = e.slice(eq + 1);
    else if (process.env[e] !== undefined) env[e] = process.env[e];
  }
  const child = spawn(file, rest, { cwd: opts['--workdir']?.[0], env, detached: true, stdio: 'inherit' });
  child.once('error', (err) => fail(127, `fake runtime: cannot run ${file}: ${err.message}`));
  child.once('spawn', () => {
    writeFileSync(pidFile(name), String(child.pid));
    record({ started: name, env });
  });
  // The client dying does not stop the container.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => process.exit(143));
  child.once('exit', (code, signal) => {
    rmSync(pidFile(name), { force: true });
    process.exit(signal ? 137 : (code ?? 1));
  });
}

async function stop(name, seconds) {
  const pid = containerPid(name);
  if (pid === null) fail(1, `Error response from daemon: No such container: ${name}`);
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline && groupAlive(pid)) await sleep(25);
  signalGroup(pid, 'SIGKILL');
  process.stdout.write(`${name}\n`);
}

async function remove(name) {
  const pid = containerPid(name);
  if (pid !== null) {
    signalGroup(pid, 'SIGKILL');
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && groupAlive(pid)) await sleep(25);
    rmSync(pidFile(name), { force: true });
    process.stdout.write(`${name}\n`);
  }
}

const [cmd, ...rest] = argv;
if (cmd !== 'run') record();
if (existsSync(join(state, 'daemon-down'))) fail(1, 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
switch (cmd) {
  case 'run':
    await run(rest);
    break;
  case 'stop':
    await stop(rest[2], Number(rest[1]));
    break;
  case 'kill':
    await stop(rest[0], 0);
    break;
  case 'rm':
    await remove(rest[1]);
    break;
  case 'container': {
    const name = rest[rest.length - 1];
    const pid = containerPid(name);
    if (pid === null || !groupAlive(pid)) fail(1, `Error response from daemon: No such container: ${name}`);
    process.stdout.write('running\n');
    break;
  }
  case 'image': {
    const image = rest[rest.length - 1];
    if (image.startsWith('missing')) fail(1, `Error response from daemon: No such image: ${image}`);
    process.stdout.write('sha256:0000\n');
    break;
  }
  case 'info':
    process.stdout.write('Server Version: fake\n');
    break;
  default:
    fail(125, `fake runtime: unknown command ${cmd}`);
}
