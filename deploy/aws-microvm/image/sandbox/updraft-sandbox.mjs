#!/usr/bin/env node
// updraft-sandbox: a container "runtime client" for Updraft's agents.<name>.container, built
// on bubblewrap (bwrap) instead of a container daemon. It speaks the subset of the docker
// command line that Updraft uses (src/worker/container.ts, src/commands/doctor-container.ts):
//
//   run --rm -i --name N --pull never [--label k=v] [--user uid:gid] --cap-drop ALL
//       --security-opt no-new-privileges [--tmpfs path:opts] [-e NAME | -e NAME=value]
//       [--mount type=bind,source=S,target=T[,readonly]] [--workdir D] [--network host|none]
//       IMAGE COMMAND [ARG...]
//   image inspect [--format {{.Id}}] IMAGE
//   container inspect [--format {{.State.Status}}] NAME
//   stop [-t SECONDS] NAME
//   rm [-f] NAME
//   info
//
// What a `run` gets: a mount namespace whose root is an empty tmpfs populated from an
// allowlist (read-only system directories, a filtered /etc, the read-only binds of the
// config file, a new /proc and /dev, tmpfs /tmp, /run and /var/tmp, the --tmpfs paths and
// exactly the --mount binds), new PID, IPC and UTS namespaces, a user namespace in which the
// caller's uid is the only one, no capabilities, no_new_privs, a new session, and an
// environment that holds only what `-e` named plus PATH and LANG (and, set by the microVM
// runner for agent telemetry, the loopback OTLP settings of TELEMETRY_ENV). The network is shared with
// the caller unless --network none is given. Nothing else of the caller reaches the command:
// not its other file descriptors (the three standard streams are relayed through pipes), not
// its environment, not its working directory.
//
// "Image": there is none. The machine this runs on is the image; one fixed name is accepted
// (IMAGE_NAME, or `image` in the config file) and every other name is refused.
//
// Exit codes follow docker's: the command's own code; 128+N when it was killed by signal N;
// 125 when the sandbox could not be set up or an argument is refused; 126/127 when the
// command could not be executed or was not found.
//
// Dependency-free on purpose: Node.js built-ins only. The translation from a docker command
// line to a bwrap command line is pure (parseRunArgs, buildBwrapArgs) and tested on every OS;
// see deploy/aws-microvm/test/sandbox-args.test.mjs.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The only "image" this runtime knows: the machine it runs on. */
export const IMAGE_NAME = 'microvm';
/** docker's exit code for "the runtime failed, the command never ran". */
export const EXIT_RUNTIME_FAILED = 125;
export const EXIT_NOT_EXECUTABLE = 126;
export const EXIT_NOT_FOUND = 127;

export const DEFAULT_CONFIG_FILE = '/etc/updraft-sandbox.json';
export const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
export const DEFAULT_LANG = 'C.UTF-8';

/** System directories bound read-only when they exist (a symbolic link is recreated as one). */
export const SYSTEM_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32', '/libx32'];
/**
 * Top-level /etc entries that are never shown, whatever their permissions: password hashes,
 * sudo's policy, SSH host keys and client configuration, PAM's password history, and this
 * runtime's own configuration.
 */
export const ETC_DENY = new Set([
  'shadow', 'shadow-', 'gshadow', 'gshadow-', 'sudoers', 'sudoers.d', 'sudo.conf', 'sudo-ldap.conf', 'doas.conf',
  'ssh', 'security', 'krb5.keytab', 'updraft-sandbox.json', 'machine-id',
]);
/** Read-only binds from /sys: only what a browser or a runtime reads to count CPUs. */
export const SYS_PATHS = ['/sys/devices/system/cpu'];
/** Paths a --mount or --tmpfs may not target (or lie under): they would replace the sandbox's own system view. */
const RESERVED_TARGETS = ['/proc', '/dev', '/sys', '/etc', ...SYSTEM_PATHS];

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** An argument this runtime refuses, or a sandbox it cannot build. Always exit code 125. */
export class SandboxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SandboxError';
  }
}

// ---------------------------------------------------------------------------
// Parsing `run` (pure)
// ---------------------------------------------------------------------------

function absolutePath(value, what) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) throw new SandboxError(`${what} "${value}" is not an absolute path`);
  const normal = path.posix.normalize(value);
  // No "..", no trailing slash games: the path is used as written.
  if (normal !== value && `${normal}/` !== value) throw new SandboxError(`${what} "${value}" is not a normalized path`);
  return normal;
}

function underOrEqual(child, parent) {
  return child === parent || child.startsWith(parent === '/' ? '/' : `${parent}/`);
}

function refuseReservedTarget(target, what) {
  if (target === '/') throw new SandboxError(`${what} may not target /`);
  for (const reserved of RESERVED_TARGETS) {
    if (underOrEqual(target, reserved)) throw new SandboxError(`${what} may not target ${target}: ${reserved} is the sandbox's own`);
  }
}

/** `--mount type=bind,source=S,target=T[,readonly]` as { source, target, readOnly }. */
export function parseMountSpec(spec) {
  const fields = {};
  for (const part of String(spec).split(',')) {
    const eq = part.indexOf('=');
    const key = eq === -1 ? part : part.slice(0, eq);
    const value = eq === -1 ? true : part.slice(eq + 1);
    if (key in fields) throw new SandboxError(`--mount ${spec}: "${key}" is given twice`);
    fields[key] = value;
  }
  let type;
  let source;
  let target;
  let readOnly = false;
  for (const [key, value] of Object.entries(fields)) {
    switch (key) {
      case 'type':
        type = value;
        break;
      case 'source':
      case 'src':
        if (source !== undefined) throw new SandboxError(`--mount ${spec}: the source is given twice`);
        source = value;
        break;
      case 'target':
      case 'destination':
      case 'dst':
        if (target !== undefined) throw new SandboxError(`--mount ${spec}: the target is given twice`);
        target = value;
        break;
      case 'readonly':
      case 'ro':
        if (value !== true && value !== 'true' && value !== 'false' && value !== '1' && value !== '0') throw new SandboxError(`--mount ${spec}: "${key}=${value}" is not understood`);
        readOnly = value === true || value === 'true' || value === '1';
        break;
      default:
        // bind-propagation, consistency, volume options...: none can be honoured here.
        throw new SandboxError(`--mount ${spec}: the option "${key}" is not supported`);
    }
  }
  if (type !== 'bind') throw new SandboxError(`--mount ${spec}: only type=bind is supported`);
  if (source === undefined || source === true || target === undefined || target === true) throw new SandboxError(`--mount ${spec}: source and target are required`);
  source = absolutePath(source, '--mount source');
  target = absolutePath(target, '--mount target');
  if (source === '/') throw new SandboxError('--mount may not bind /');
  refuseReservedTarget(target, '--mount');
  return { source, target, readOnly };
}

/** `--tmpfs path[:opt,opt]` as { path, mode }. Options that cannot be honoured are refused. */
export function parseTmpfsSpec(spec) {
  const text = String(spec);
  const colon = text.indexOf(':');
  const target = absolutePath(colon === -1 ? text : text.slice(0, colon), '--tmpfs path');
  refuseReservedTarget(target, '--tmpfs');
  let mode;
  for (const option of colon === -1 ? [] : text.slice(colon + 1).split(',')) {
    if (option === '' || option === 'rw' || option === 'exec' || option === 'nosuid' || option === 'nodev') continue; // what a bwrap tmpfs is anyway
    const m = /^mode=([0-7]{3,4})$/.exec(option);
    if (m) {
      mode = m[1];
      continue;
    }
    // ro, noexec, size=, uid=, gid=: bwrap's --tmpfs cannot be given these on every version in use.
    throw new SandboxError(`--tmpfs ${spec}: the option "${option}" is not supported`);
  }
  return { path: target, mode };
}

/**
 * Parse the arguments after `run`. Every flag Updraft can emit is handled; a flag that has no
 * meaning here is accepted only with the value that is true of this sandbox anyway, and
 * everything else is refused (SandboxError), never ignored.
 */
export function parseRunArgs(argv) {
  const run = { remove: false, interactive: false, name: undefined, labels: {}, user: undefined, env: [], tmpfs: [], mounts: [], workdir: undefined, network: undefined, image: undefined, command: [] };
  let i = 0;
  const value = (flag, inline) => {
    if (inline !== undefined) return inline;
    i += 1;
    if (i >= argv.length) throw new SandboxError(`${flag} needs a value`);
    return argv[i];
  };
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      i += 1;
      break;
    }
    if (!arg.startsWith('-') || arg === '-') break;
    let flag = arg;
    let inline;
    if (arg.startsWith('--') && arg.includes('=')) {
      flag = arg.slice(0, arg.indexOf('='));
      inline = arg.slice(arg.indexOf('=') + 1);
    }
    switch (flag) {
      case '--rm':
        if (inline !== undefined) throw new SandboxError('--rm takes no value');
        run.remove = true;
        break;
      case '-i':
      case '--interactive':
        if (inline !== undefined) throw new SandboxError(`${flag} takes no value`);
        run.interactive = true;
        break;
      case '--name':
        run.name = value(flag, inline);
        break;
      case '--pull': {
        const policy = value(flag, inline);
        if (policy !== 'never') throw new SandboxError(`--pull ${policy}: there is no registry to pull from; only "never" is accepted`);
        break;
      }
      case '-l':
      case '--label': {
        const label = value(flag, inline);
        const eq = label.indexOf('=');
        run.labels[eq === -1 ? label : label.slice(0, eq)] = eq === -1 ? '' : label.slice(eq + 1);
        break;
      }
      case '-u':
      case '--user':
        run.user = value(flag, inline);
        break;
      case '--cap-drop': {
        const cap = value(flag, inline);
        if (cap.toUpperCase() !== 'ALL') throw new SandboxError(`--cap-drop ${cap}: every capability is always dropped; only "ALL" is accepted`);
        break;
      }
      case '--security-opt': {
        const opt = value(flag, inline);
        if (opt !== 'no-new-privileges' && opt !== 'no-new-privileges=true' && opt !== 'no-new-privileges:true') {
          throw new SandboxError(`--security-opt ${opt}: only "no-new-privileges" (always in effect) is accepted`);
        }
        break;
      }
      case '--tmpfs':
        run.tmpfs.push(parseTmpfsSpec(value(flag, inline)));
        break;
      case '-e':
      case '--env': {
        const entry = value(flag, inline);
        const eq = entry.indexOf('=');
        const name = eq === -1 ? entry : entry.slice(0, eq);
        if (!ENV_NAME.test(name)) throw new SandboxError(`-e ${name}: not an environment variable name`);
        run.env.push(eq === -1 ? { name } : { name, value: entry.slice(eq + 1) });
        break;
      }
      case '--mount':
        run.mounts.push(parseMountSpec(value(flag, inline)));
        break;
      case '-w':
      case '--workdir':
        run.workdir = absolutePath(value(flag, inline), '--workdir');
        break;
      case '--network':
      case '--net': {
        const network = value(flag, inline);
        // host: what this sandbox has without the flag. none: honoured with a new, empty
        // network namespace. A bridge or a named network cannot be provided.
        if (network !== 'host' && network !== 'none') throw new SandboxError(`--network ${network}: only "host" (the default here: the caller's network) and "none" are supported`);
        run.network = network;
        break;
      }
      default:
        throw new SandboxError(`unsupported option for run: ${flag}`);
    }
  }
  const rest = argv.slice(i);
  if (rest.length < 2) throw new SandboxError('run needs an image and a command');
  [run.image, ...run.command] = rest;
  if (run.name === undefined) throw new SandboxError('run needs --name: a sandbox is stopped and removed by name');
  if (!NAME_PATTERN.test(run.name)) throw new SandboxError(`"${run.name}" is not a container name`);
  if (!run.remove) throw new SandboxError('run needs --rm: nothing of a sandbox is kept after its command has exited');
  return run;
}

// ---------------------------------------------------------------------------
// Config and the host's layout
// ---------------------------------------------------------------------------

/**
 * The config file (JSON), validated:
 *   image          the image name to accept (default "microvm")
 *   readOnlyBinds  absolute paths bound read-only at the same path, for toolchains outside
 *                  the system directories (for example /opt/ms-playwright)
 *   env            variables set for every command (non-secret settings such as
 *                  PLAYWRIGHT_BROWSERS_PATH); `-e` wins over them
 *   path           PATH inside the sandbox
 *   bwrap          the bwrap executable (default: bwrap on the caller's PATH)
 */
export function parseConfig(text, file = 'the config') {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new SandboxError(`${file} is not JSON: ${error.message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new SandboxError(`${file} is not a JSON object`);
  const known = new Set(['image', 'readOnlyBinds', 'env', 'path', 'bwrap']);
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new SandboxError(`${file}: unknown key "${key}"`);
  const config = { image: IMAGE_NAME, readOnlyBinds: [], env: {}, path: DEFAULT_PATH, bwrap: undefined };
  if (raw.image !== undefined) {
    if (typeof raw.image !== 'string' || !/^[^-\s][^\s]*$/.test(raw.image)) throw new SandboxError(`${file}: image is not an image name`);
    config.image = raw.image;
  }
  if (raw.readOnlyBinds !== undefined) {
    if (!Array.isArray(raw.readOnlyBinds)) throw new SandboxError(`${file}: readOnlyBinds is not a list`);
    for (const entry of raw.readOnlyBinds) {
      const bind = absolutePath(entry, `${file}: readOnlyBinds entry`);
      if (bind === '/') throw new SandboxError(`${file}: readOnlyBinds may not contain /`);
      for (const reserved of ['/proc', '/dev', '/etc']) {
        if (underOrEqual(bind, reserved)) throw new SandboxError(`${file}: readOnlyBinds may not contain ${bind}`);
      }
      config.readOnlyBinds.push(bind);
    }
  }
  if (raw.env !== undefined) {
    if (raw.env === null || typeof raw.env !== 'object' || Array.isArray(raw.env)) throw new SandboxError(`${file}: env is not an object`);
    for (const [name, value] of Object.entries(raw.env)) {
      if (!ENV_NAME.test(name) || typeof value !== 'string') throw new SandboxError(`${file}: env.${name} is not a variable with a string value`);
      config.env[name] = value;
    }
  }
  if (raw.path !== undefined) {
    if (typeof raw.path !== 'string' || raw.path === '') throw new SandboxError(`${file}: path is not a string`);
    config.path = raw.path;
  }
  if (raw.bwrap !== undefined) {
    if (typeof raw.bwrap !== 'string' || !raw.bwrap.startsWith('/')) throw new SandboxError(`${file}: bwrap is not an absolute path`);
    config.bwrap = raw.bwrap;
  }
  return config;
}

/**
 * Load the config: $UPDRAFT_SANDBOX_CONFIG, else /etc/updraft-sandbox.json when it exists,
 * else the defaults. The file decides what the sandbox can see, so one that anybody but its
 * owner can write is refused.
 */
export function loadConfig(env = process.env) {
  const explicit = env.UPDRAFT_SANDBOX_CONFIG;
  const file = explicit || DEFAULT_CONFIG_FILE;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (!explicit && error.code === 'ENOENT') return parseConfig('{}');
    throw new SandboxError(`cannot read the sandbox config ${file}: ${error.message}`);
  }
  if ((stat.mode & 0o022) !== 0) throw new SandboxError(`the sandbox config ${file} is writable by its group or by everyone; refusing to use it`);
  const uid = process.getuid?.();
  if (stat.uid !== 0 && stat.uid !== uid) throw new SandboxError(`the sandbox config ${file} is owned by uid ${stat.uid}, not by root or the caller; refusing to use it`);
  return parseConfig(fs.readFileSync(file, 'utf8'), file);
}

/**
 * What of the host the allowlist is built from: for each system path whether it is a
 * directory or a symbolic link, the top-level entries of /etc, and which configured binds
 * exist. Read once per run; buildBwrapArgs itself reads nothing.
 */
export function probeHost(config, io = fs) {
  const kind = (p) => {
    try {
      const stat = io.lstatSync(p);
      if (stat.isSymbolicLink()) return { type: 'symlink', target: io.readlinkSync(p) };
      return { type: stat.isDirectory() ? 'dir' : 'file', mode: stat.mode };
    } catch {
      return { type: 'missing' };
    }
  };
  const system = SYSTEM_PATHS.map((p) => ({ path: p, ...kind(p) })).filter((e) => e.type !== 'missing');
  const etc = [];
  let names = [];
  try {
    names = io.readdirSync('/etc').sort();
  } catch {
    // no /etc: nothing to show
  }
  for (const name of names) {
    const entry = { name, ...kind(`/etc/${name}`) };
    if (entry.type === 'symlink') {
      try {
        entry.resolved = io.realpathSync(`/etc/${name}`);
      } catch {
        entry.resolved = null; // dangling
      }
    }
    etc.push(entry);
  }
  const exists = (p) => kind(p).type !== 'missing';
  return { system, etc, sys: SYS_PATHS.filter(exists), readOnlyBinds: config.readOnlyBinds.filter(exists) };
}

/**
 * The bwrap arguments for /etc: every top-level entry bound read-only on its own, except the
 * denied names and anything "other" may not read (a file without o+r, a directory without
 * o+rx): what is private to root on the host is simply absent. A symbolic link that points
 * into /proc or /dev is recreated (it then refers to the sandbox's own); any other link is
 * replaced by a read-only bind of what it resolves to, when that lies in /etc, /usr, /run or
 * /var (resolv.conf, localtime, alternatives), and is dropped otherwise.
 */
export function etcArgs(etc) {
  const args = [];
  for (const entry of etc) {
    if (ETC_DENY.has(entry.name) || /[\0]/.test(entry.name)) continue;
    const target = `/etc/${entry.name}`;
    if (entry.type === 'symlink') {
      const resolved = entry.resolved;
      const literal = path.posix.resolve('/etc', entry.target ?? '');
      if (underOrEqual(literal, '/proc') || underOrEqual(literal, '/dev')) args.push('--symlink', entry.target, target);
      else if (typeof resolved === 'string' && ['/etc', '/usr', '/run', '/var/lib', '/var/run'].some((root) => underOrEqual(resolved, root)) && !ETC_DENY.has(path.posix.relative('/etc', resolved).split('/')[0])) {
        args.push('--ro-bind-try', resolved, target);
      }
      continue;
    }
    const mode = entry.mode ?? 0;
    if (entry.type === 'dir' ? (mode & 0o005) !== 0o005 : (mode & 0o004) === 0) continue;
    args.push('--ro-bind', target, target);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Translation (pure)
// ---------------------------------------------------------------------------

/**
 * The one exception to "nothing of the caller's environment unless `-e` names it": the
 * settings that make Claude Code send its own log events to the microVM runner's loopback
 * relay (runner/otlp-relay.mjs, claudeTelemetryEnv), set by the runner only when the job has
 * agent telemetry. None of them can hold a secret (no headers variable is among them), each
 * value must be exactly of its expected form, and the endpoint must be http on 127.0.0.1, so
 * the events can only go to this machine. If any is set but not of its form, none is passed.
 */
export const TELEMETRY_ENV = {
  CLAUDE_CODE_ENABLE_TELEMETRY: /^1$/,
  OTEL_LOGS_EXPORTER: /^otlp$/,
  OTEL_METRICS_EXPORTER: /^none$/,
  OTEL_TRACES_EXPORTER: /^none$/,
  OTEL_EXPORTER_OTLP_PROTOCOL: /^http\/json$/,
  OTEL_EXPORTER_OTLP_ENDPOINT: /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/,
  OTEL_LOGS_EXPORT_INTERVAL: /^[1-9]\d{2,5}$/,
};

/** The caller's telemetry settings (TELEMETRY_ENV), when all of them are there and of their form; else none. */
export function telemetryEnv(callerEnv) {
  const out = {};
  for (const [name, form] of Object.entries(TELEMETRY_ENV)) {
    const value = callerEnv[name];
    if (typeof value !== 'string' || !form.test(value)) return {};
    out[name] = value;
  }
  return out;
}

/**
 * The environment of the sandboxed command: PATH and LANG, the config file's settings, the
 * runner's agent telemetry settings (TELEMETRY_ENV) and what `-e` named (a bare name is copied
 * from the caller's environment when it is set there). Nothing else of the caller's environment.
 */
export function sandboxEnv(run, callerEnv, config) {
  const env = { PATH: config.path, LANG: DEFAULT_LANG, ...config.env, ...telemetryEnv(callerEnv) };
  for (const entry of run.env) {
    if (entry.value !== undefined) env[entry.name] = entry.value;
    else if (typeof callerEnv[entry.name] === 'string') env[entry.name] = callerEnv[entry.name];
  }
  return env;
}

/** `--user uid[:gid]` must name the caller: an unprivileged user namespace has no other user to offer. */
export function checkUser(user, uid, gid) {
  if (user === undefined) return;
  const m = /^(\d+)(?::(\d+))?$/.exec(user);
  if (!m) throw new SandboxError(`--user ${user}: only a numeric uid[:gid] is supported`);
  if (Number(m[1]) !== uid || (m[2] !== undefined && Number(m[2]) !== gid)) {
    throw new SandboxError(`--user ${user}: the sandbox can only run as its caller (${uid}:${gid}); start the caller as the user the command should run as`);
  }
}

/**
 * The bwrap command line (everything after the executable) and the environment for a parsed
 * `run`. Pure: `host` (probeHost) is all it knows about the machine.
 *
 * @param {ReturnType<typeof parseRunArgs>} run
 * @param {{ uid: number, gid: number, env: Record<string, string | undefined>, config: ReturnType<typeof parseConfig>, layout: ReturnType<typeof probeHost>, statusFd?: number }} host
 */
export function buildBwrapArgs(run, host) {
  const { config, layout } = host;
  if (run.image !== config.image) {
    throw new SandboxError(`no such image: ${run.image} (this runtime has no images; the machine itself is the image, named "${config.image}")`);
  }
  checkUser(run.user, host.uid, host.gid);
  const args = [
    // Namespaces: the caller's uid in a user namespace of its own (which is also what lets an
    // unprivileged caller create the others), and nothing of the caller's processes, System V
    // IPC or hostname. The network stays shared unless --network none.
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    ...(run.network === 'none' ? ['--unshare-net'] : []),
    '--hostname',
    'updraft-sandbox',
    // The sandbox dies with this runtime client, has no controlling terminal to inject
    // keystrokes into, and holds no capability inside its user namespace.
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
  ];
  if (host.statusFd !== undefined) args.push('--json-status-fd', String(host.statusFd));
  // The root is bwrap's empty tmpfs; everything below is the allowlist.
  for (const entry of layout.system) {
    if (entry.type === 'symlink') args.push('--symlink', entry.target, entry.path);
    else if (entry.type === 'dir') args.push('--ro-bind', entry.path, entry.path);
  }
  args.push('--dir', '/etc', ...etcArgs(layout.etc));
  for (const p of layout.sys) args.push('--ro-bind', p, p);
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/var/tmp');
  // After the scratch tmpfs mounts, so that a configured bind below /tmp, /run or /var/tmp is
  // not hidden again by them.
  for (const p of layout.readOnlyBinds) args.push('--ro-bind', p, p);
  // A --tmpfs is owned by the sandbox's only user, so a mode such as 1777 adds nothing; it is
  // accepted and not applied (bwrap's --perms is newer than the oldest bwrap this runs on).
  for (const t of run.tmpfs) args.push('--tmpfs', t.path);
  // Exactly the binds asked for, in the order given (parents before what is mounted over them).
  for (const m of run.mounts) args.push(m.readOnly ? '--ro-bind' : '--bind', m.source, m.target);
  args.push('--remount-ro', '/');
  if (run.workdir) args.push('--chdir', run.workdir);
  else args.push('--chdir', '/');
  args.push('--', ...run.command);
  return { args, env: sandboxEnv(run, host.env, config) };
}

/** A stable id for the one "image": docker prints `sha256:<hex>` for `{{.Id}}`. */
export function imageId(name) {
  return `sha256:${createHash('sha256').update(`updraft-sandbox image ${name}`).digest('hex')}`;
}

// ---------------------------------------------------------------------------
// State: one file per name, so that another process can stop or remove a sandbox
// ---------------------------------------------------------------------------

export function runtimeDir(env = process.env) {
  if (env.UPDRAFT_SANDBOX_RUNTIME_DIR) return env.UPDRAFT_SANDBOX_RUNTIME_DIR;
  return path.join('/tmp', `updraft-sandbox-${process.getuid?.() ?? 'user'}`);
}

/** Create the runtime directory if needed and insist that it is ours alone. */
function ensureRuntimeDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new SandboxError(`${dir} is not a directory`);
  if (stat.uid !== process.getuid?.()) throw new SandboxError(`${dir} belongs to uid ${stat.uid}; refusing to keep sandbox state there`);
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  return dir;
}

const stateFile = (dir, name) => path.join(dir, `${name}.json`);

/** The kernel's start time of a process (clock ticks since boot), or null when it is gone. With the pid it identifies one process. */
export function processStart(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name (field 2) may contain spaces and parentheses; fields resume after the last ")".
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return null; // a zombie is not running
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

const sameProcess = (pid, start) => typeof pid === 'number' && pid > 0 && start != null && processStart(pid) === start;

function readState(dir, name) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(dir, name), 'utf8'));
    return state !== null && typeof state === 'object' ? state : null;
  } catch {
    return null;
  }
}

function writeState(dir, state, exclusive = false) {
  const file = stateFile(dir, state.name);
  if (exclusive) {
    fs.writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' });
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function removeState(dir, name) {
  fs.rmSync(stateFile(dir, name), { force: true });
}

/** Is anything of this sandbox still running: its supervisor (this script), bwrap, or the namespace's init? */
function alive(state) {
  return sameProcess(state.supervisorPid, state.supervisorStart) || sameProcess(state.bwrapPid, state.bwrapStart) || sameProcess(state.initPid, state.initStart);
}

/** Pids whose parent is `pid`, read from /proc (the caller's PID namespace). */
function childrenOf(pid) {
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[1]) === pid) found.push(Number(entry));
    } catch {
      // gone in the meantime
    }
  }
  return found.sort((a, b) => a - b);
}

function signal(pid, sig) {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM for the sandboxed command, as `docker stop` sends it to a container's first
 * process. The namespace's init is bwrap's own reaper, which a SIGTERM from outside does not
 * reach (the kernel drops signals an init has no handler for); the command is its child.
 */
function signalCommand(state, sig) {
  if (!sameProcess(state.initPid, state.initStart)) return false;
  const [command] = childrenOf(state.initPid);
  return command !== undefined && signal(command, sig);
}

/** SIGKILL for everything: the namespace's init (the kernel then kills every process in it) and bwrap. */
function killSandbox(state) {
  if (sameProcess(state.initPid, state.initStart)) signal(state.initPid, 'SIGKILL');
  if (sameProcess(state.bwrapPid, state.bwrapStart)) signal(state.bwrapPid, 'SIGKILL');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition, timeoutMs, stepMs = 50) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return true;
    if (Date.now() >= end) return false;
    await sleep(Math.min(stepMs, Math.max(1, end - Date.now())));
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Close every file descriptor above 2 that this process inherited and would pass on. Node
 * marks its own descriptors close-on-exec, so one without that flag came from the caller (a
 * database, a log file, a socket): the sandboxed command must not get it. Reads the flags
 * from /proc/self/fdinfo; if that cannot be read the run is refused.
 */
export function closeInheritedFds() {
  const O_CLOEXEC = 0o2000000;
  const closed = [];
  for (const entry of fs.readdirSync('/proc/self/fd')) {
    const fd = Number(entry);
    if (!Number.isInteger(fd) || fd <= 2) continue;
    let info;
    try {
      info = fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8');
    } catch {
      continue; // the descriptor readdir itself used
    }
    const m = /^flags:\s*([0-7]+)/m.exec(info);
    if (!m) throw new SandboxError(`cannot read the flags of inherited file descriptor ${fd}`);
    if ((parseInt(m[1], 8) & O_CLOEXEC) === 0) {
      fs.closeSync(fd);
      closed.push(fd);
    }
  }
  return closed;
}

function findBwrap(config, env) {
  if (config.bwrap) return config.bwrap;
  for (const dir of (env.PATH || DEFAULT_PATH).split(':')) {
    if (!dir.startsWith('/')) continue;
    const candidate = path.join(dir, 'bwrap');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  throw new SandboxError('bwrap (bubblewrap) was not found on PATH; the sandbox cannot be built');
}

function context(env = process.env) {
  if (process.platform !== 'linux') throw new SandboxError('updraft-sandbox needs Linux (namespaces and bubblewrap)');
  const config = loadConfig(env);
  return { env, config, bwrap: findBwrap(config, env), uid: process.getuid(), gid: process.getgid() };
}

/** Can this user build a sandbox at all? Runs `true` in one. Returns null, or what bwrap said. */
function probeSandbox(ctx) {
  const run = { ...parseRunArgs(['--rm', '--name', 'probe', ctx.config.image, 'true']), network: undefined };
  const { args, env } = buildBwrapArgs(run, { uid: ctx.uid, gid: ctx.gid, env: {}, config: ctx.config, layout: probeHost(ctx.config) });
  const result = spawnSync(ctx.bwrap, args, { env, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 15_000 });
  if (result.status === 0) return null;
  const said = (result.stderr || result.error?.message || '').trim().split('\n').pop() || `exit ${result.status ?? result.signal}`;
  return `${ctx.bwrap} cannot build a sandbox as uid ${ctx.uid}: ${said} (unprivileged user namespaces must be allowed)`;
}

function cmdInfo() {
  const ctx = context();
  const problem = probeSandbox(ctx);
  if (problem) throw new SandboxError(problem);
  const version = spawnSync(ctx.bwrap, ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? '';
  process.stdout.write(`updraft-sandbox: ${version || 'bubblewrap'} at ${ctx.bwrap}\nimage: ${ctx.config.image}\nruntime directory: ${runtimeDir()}\n`);
  return 0;
}

function formatFlag(argv, allowed) {
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let format;
    if (arg === '--format' || arg === '-f') {
      i += 1;
      format = argv[i];
    } else if (arg.startsWith('--format=')) format = arg.slice('--format='.length);
    else if (arg.startsWith('-')) throw new SandboxError(`unsupported option: ${arg}`);
    else {
      rest.push(arg);
      continue;
    }
    if (format !== allowed) throw new SandboxError(`--format ${format}: only ${allowed} is supported`);
  }
  if (rest.length !== 1) throw new SandboxError('exactly one name is expected');
  return rest[0];
}

function cmdImageInspect(argv) {
  const image = formatFlag(argv, '{{.Id}}');
  const ctx = context();
  if (image !== ctx.config.image) {
    process.stderr.write(`Error response from daemon: No such image: ${image} (updraft-sandbox has no images; the machine itself is the image, named "${ctx.config.image}")\n`);
    return 1;
  }
  // "The image is present" means here: a sandbox can be built. Said before a run touches a clone.
  const problem = probeSandbox(ctx);
  if (problem) {
    process.stderr.write(`Error: ${problem}\n`);
    return 1;
  }
  process.stdout.write(`${imageId(image)}\n`);
  return 0;
}

function cmdContainerInspect(argv) {
  const name = formatFlag(argv, '{{.State.Status}}');
  const dir = runtimeDir();
  const state = NAME_PATTERN.test(name) ? readState(dir, name) : null;
  if (!state || !alive(state)) {
    if (state) removeState(dir, name);
    process.stderr.write(`Error response from daemon: No such container: ${name}\n`);
    return 1;
  }
  process.stdout.write('running\n');
  return 0;
}

async function cmdStop(argv) {
  let seconds = 10;
  const names = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-t' || arg === '--time' || arg === '--timeout') {
      i += 1;
      seconds = Number(argv[i]);
    } else if (/^--(time|timeout)=/.test(arg)) seconds = Number(arg.slice(arg.indexOf('=') + 1));
    else if (arg.startsWith('-')) throw new SandboxError(`unsupported option for stop: ${arg}`);
    else names.push(arg);
  }
  if (!Number.isFinite(seconds) || seconds < 0) throw new SandboxError('stop -t needs a number of seconds');
  if (names.length !== 1 || !NAME_PATTERN.test(names[0])) throw new SandboxError('stop needs one container name');
  const [name] = names;
  const dir = runtimeDir();
  const state = readState(dir, name);
  if (!state || !alive(state)) {
    if (state) removeState(dir, name);
    process.stderr.write(`Error response from daemon: No such container: ${name}\n`);
    return 1;
  }
  // SIGTERM to the command; if the sandbox is still being set up, to its supervisor, which
  // passes it on as soon as there is a command.
  if (!signalCommand(state, 'SIGTERM') && sameProcess(state.supervisorPid, state.supervisorStart)) signal(state.supervisorPid, 'SIGTERM');
  const gone = () => {
    const now = readState(dir, name) ?? state;
    return !alive(now);
  };
  if (!(await waitUntil(gone, seconds * 1000))) {
    killSandbox(readState(dir, name) ?? state);
    await waitUntil(gone, 3000);
  }
  process.stdout.write(`${name}\n`);
  return 0;
}

async function cmdRm(argv) {
  let force = false;
  const names = [];
  for (const arg of argv) {
    if (arg === '-f' || arg === '--force') force = true;
    else if (arg.startsWith('-')) throw new SandboxError(`unsupported option for rm: ${arg}`);
    else names.push(arg);
  }
  if (names.length !== 1 || !NAME_PATTERN.test(names[0])) throw new SandboxError('rm needs one container name');
  const [name] = names;
  const dir = runtimeDir();
  let state = readState(dir, name);
  if (!state) {
    if (force) return 0; // as docker: removing what is not there is not an error with -f
    process.stderr.write(`Error response from daemon: No such container: ${name}\n`);
    return 1;
  }
  if (alive(state)) {
    if (!force) {
      process.stderr.write(`Error response from daemon: cannot remove container "${name}": container is running: stop the container before removing or force remove\n`);
      return 1;
    }
    const gone = () => {
      state = readState(dir, name) ?? state;
      return !alive(state);
    };
    killSandbox(state);
    // The pids may only just have been recorded: look again until nothing is left.
    if (!(await waitUntil(() => (gone() ? true : (killSandbox(state), false)), 5000))) {
      if (sameProcess(state.supervisorPid, state.supervisorStart)) signal(state.supervisorPid, 'SIGKILL');
      await waitUntil(gone, 2000);
    }
  }
  removeState(dir, name);
  process.stdout.write(`${name}\n`);
  return 0;
}

/** `run`: build the sandbox, relay the three standard streams, pass signals and the exit code on. */
async function cmdRun(argv) {
  const run = parseRunArgs(argv);
  const ctx = context();
  const built = buildBwrapArgs(run, { uid: ctx.uid, gid: ctx.gid, env: ctx.env, config: ctx.config, layout: probeHost(ctx.config), statusFd: 3 });
  closeInheritedFds();

  const dir = ensureRuntimeDir(runtimeDir());
  const state = { name: run.name, labels: run.labels, createdAt: new Date().toISOString(), supervisorPid: process.pid, supervisorStart: processStart(process.pid), bwrapPid: null, bwrapStart: null, initPid: null, initStart: null };
  const existing = readState(dir, run.name);
  if (existing && alive(existing)) {
    throw new SandboxError(`Conflict. The container name "${run.name}" is already in use by a running sandbox; remove it with "rm -f ${run.name}"`);
  }
  removeState(dir, run.name);
  try {
    writeState(dir, state, true);
  } catch (error) {
    throw new SandboxError(`Conflict. The container name "${run.name}" is already in use (${error.code ?? error.message})`);
  }

  let pendingSignal = null;
  let exiting = false;
  const forward = (sig) => {
    if (exiting) return;
    if (!signalCommand(state, sig)) pendingSignal = sig;
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) process.on(sig, () => forward(sig));

  return new Promise((resolve) => {
    let child;
    try {
      // Pipes, not the caller's own descriptors: a file handed down as stdout (the run log)
      // could be reopened for reading or truncated through /proc/self/fd by the command.
      child = spawn(ctx.bwrap, built.args, { env: built.env, cwd: '/', stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    } catch (error) {
      removeState(dir, run.name);
      process.stderr.write(`updraft-sandbox: cannot start ${ctx.bwrap}: ${error.message}\n`);
      resolve(EXIT_RUNTIME_FAILED);
      return;
    }
    let status = '';
    let stderrTail = '';
    let commandExit = null;
    let spawnFailed = false;

    child.on('error', (error) => {
      spawnFailed = true;
      process.stderr.write(`updraft-sandbox: cannot start ${ctx.bwrap}: ${error.message}\n`);
    });
    if (child.pid !== undefined) {
      state.bwrapPid = child.pid;
      state.bwrapStart = processStart(child.pid);
      writeState(dir, state);
    }

    // bwrap reports the pid of the namespace's init, and later the command's exit code, as
    // JSON lines on descriptor 3. An exit code is only reported when the command was started.
    child.stdio[3].setEncoding('utf8');
    child.stdio[3].on('data', (chunk) => {
      status += chunk;
      if (state.initPid === null) {
        const m = /"child-pid"\s*:\s*(\d+)/.exec(status);
        if (m) {
          state.initPid = Number(m[1]);
          state.initStart = processStart(state.initPid);
          try {
            writeState(dir, state);
          } catch {
            // removed by an `rm -f` in the meantime; the kill follows
          }
        }
      }
      const exit = /"exit-code"\s*:\s*(\d+)/.exec(status);
      if (exit) commandExit = Number(exit[1]);
    });
    child.stdio[3].on('error', () => {});

    // A signal that arrived before there was a command to give it to.
    const deliverPending = setInterval(() => {
      if (pendingSignal && signalCommand(state, pendingSignal)) pendingSignal = null;
    }, 50);

    const ignore = () => {};
    child.stdin.on('error', ignore);
    process.stdin.on('error', ignore);
    process.stdout.on('error', ignore);
    process.stderr.on('error', ignore);
    process.stdin.pipe(child.stdin);
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
      process.stderr.write(chunk);
    });

    child.on('close', (code, sig) => {
      exiting = true;
      clearInterval(deliverPending);
      process.stdin.unpipe(child.stdin);
      process.stdin.destroy();
      // Nothing may be left of the namespace whatever ended bwrap.
      killSandbox(state);
      removeState(dir, run.name);
      let exitCode;
      if (spawnFailed || code === null && sig === null) exitCode = EXIT_RUNTIME_FAILED;
      else if (commandExit !== null) exitCode = commandExit;
      else if (sig) exitCode = 128 + (osSignalNumber(sig) ?? 9);
      else if (code === 0) exitCode = 0;
      else if (/execvp [^\n]*: No such file or directory/.test(stderrTail)) exitCode = EXIT_NOT_FOUND;
      else if (/execvp [^\n]*: Permission denied/.test(stderrTail)) exitCode = EXIT_NOT_EXECUTABLE;
      else {
        // bwrap failed before the command started: a missing bind source, no user namespaces...
        process.stderr.write(`updraft-sandbox: the sandbox could not be set up (bwrap exited ${code})\n`);
        exitCode = EXIT_RUNTIME_FAILED;
      }
      resolve(exitCode);
    });
  });
}

function osSignalNumber(name) {
  return { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15 }[name];
}

export async function main(argv) {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'run':
        return await cmdRun(rest);
      case 'info':
        if (rest.length) throw new SandboxError(`unsupported option for info: ${rest[0]}`);
        return cmdInfo();
      case 'image':
        if (rest[0] !== 'inspect') throw new SandboxError(`unsupported command: image ${rest[0] ?? ''}`);
        return cmdImageInspect(rest.slice(1));
      case 'container':
        if (rest[0] !== 'inspect') throw new SandboxError(`unsupported command: container ${rest[0] ?? ''}`);
        return cmdContainerInspect(rest.slice(1));
      case 'stop':
        return await cmdStop(rest);
      case 'rm':
        return await cmdRm(rest);
      case '--version':
      case 'version':
        process.stdout.write('updraft-sandbox 1 (bubblewrap)\n');
        return 0;
      default:
        throw new SandboxError(`unsupported command: ${command ?? '(none)'}`);
    }
  } catch (error) {
    process.stderr.write(`updraft-sandbox: ${error instanceof SandboxError ? error.message : (error?.stack ?? error)}\n`);
    return EXIT_RUNTIME_FAILED;
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const code = await main(process.argv.slice(2));
  // Let what was written to the caller's stdout and stderr drain, then leave with the code.
  process.exitCode = code;
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}
