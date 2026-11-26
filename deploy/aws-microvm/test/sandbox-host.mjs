// Shared by the tests that start the sandbox runtime for real: whether this host can (Linux,
// bwrap installed, unprivileged user namespaces allowed), and a runtime "installation" in a
// temporary directory: a wrapper script that Updraft (or a test) can use as
// agents.<name>.container.runtime, with its own config file and runtime directory.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SANDBOX_SCRIPT = fileURLToPath(new URL('../image/sandbox/updraft-sandbox.mjs', import.meta.url));

/** Directories outside the sandbox's system view that hold this Node.js (for example /opt/node22). */
export function nodeBinds() {
  const prefix = path.dirname(path.dirname(fs.realpathSync(process.execPath)));
  return prefix === '/usr' || prefix.startsWith('/usr/') || prefix === '/' ? [] : [prefix];
}

const quote = (text) => `'${String(text).replaceAll("'", `'\\''`)}'`;

/**
 * Write a runtime into `dir` and return how to call it. `readOnlyBinds` and `env` go into its
 * config file, next to what this Node.js needs. `copyScript` puts a copy of the runtime's script
 * in `dir` and runs that one instead of the checkout's: for a caller (another user) who may not
 * be able to read the checkout at all. The script imports Node.js built-ins only.
 */
export function installRuntime(dir, { readOnlyBinds = [], env = {}, image, copyScript = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const configFile = path.join(dir, 'sandbox.json');
  const runtimeDir = path.join(dir, 'state');
  fs.writeFileSync(configFile, JSON.stringify({ ...(image ? { image } : {}), readOnlyBinds: [...nodeBinds(), ...readOnlyBinds], env }), { mode: 0o644 });
  const file = path.join(dir, 'updraft-sandbox');
  let script = SANDBOX_SCRIPT;
  if (copyScript) {
    script = path.join(dir, 'updraft-sandbox.mjs');
    fs.copyFileSync(SANDBOX_SCRIPT, script);
    fs.chmodSync(script, 0o644);
  }
  fs.writeFileSync(
    file,
    `#!/bin/sh\nUPDRAFT_SANDBOX_CONFIG=${quote(configFile)} UPDRAFT_SANDBOX_RUNTIME_DIR=${quote(runtimeDir)} exec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
    { mode: 0o755 },
  );
  return { path: file, configFile, runtimeDir };
}

/**
 * Set UPDRAFT_SANDBOX_TESTS=required where these suites must run (the CI job that installs
 * bubblewrap, .github/workflows/ci.yml): there, a host that cannot start the sandbox is a test
 * failure with its reason, never a skip.
 */
export const REQUIRED = process.env.UPDRAFT_SANDBOX_TESTS === 'required';

/**
 * `availability` for describe.skipIf: unchanged where skipping is allowed; where the sandbox
 * tests are required, an unusable host throws, so the suite fails instead of being skipped.
 */
export function requireUnlessAllowedToSkip(availability) {
  if (REQUIRED && !availability.usable) {
    throw new Error(`UPDRAFT_SANDBOX_TESTS=required, but the sandbox cannot run here: ${availability.reason}`);
  }
  return availability;
}

/**
 * Why the current user cannot read `file`: the first ancestor directory it may not search, or
 * the file itself. Null when it can. A checkout under a directory the test user cannot traverse
 * (another account's home, a 0700 job directory) is an environment problem, not a sandbox one.
 */
export function unreadablePath(file) {
  const parts = path.resolve(file).split(path.sep).filter(Boolean);
  let current = path.sep;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try {
      fs.accessSync(current, fs.constants.X_OK);
    } catch {
      return `${current} is not searchable by uid ${process.getuid?.() ?? '?'}`;
    }
  }
  try {
    fs.accessSync(file, fs.constants.R_OK);
  } catch {
    return `${file} is not readable by uid ${process.getuid?.() ?? '?'}`;
  }
  return null;
}

let cached;
/** { usable: true } or { usable: false, reason }: can this host start the sandbox at all? */
export function sandboxAvailability() {
  if (cached) return cached;
  if (process.platform !== 'linux') return (cached = { usable: false, reason: `needs Linux (this is ${process.platform})` });
  const unreadable = unreadablePath(SANDBOX_SCRIPT);
  if (unreadable) return (cached = { usable: false, reason: `the checkout cannot be read by this user (${unreadable})` });
  try {
    fs.accessSync(os.tmpdir(), fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    return (cached = { usable: false, reason: `the temporary directory ${os.tmpdir()} is not writable by this user` });
  }
  const which = spawnSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' });
  if (which.status !== 0) return (cached = { usable: false, reason: 'bwrap (bubblewrap) is not installed' });
  // The runtime's own check: `true` in a sandbox built the way a run builds it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updraft-sandbox-probe-'));
  let probe;
  try {
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ readOnlyBinds: nodeBinds() }));
    probe = spawnSync(process.execPath, [SANDBOX_SCRIPT, 'info'], { env: { ...process.env, UPDRAFT_SANDBOX_CONFIG: path.join(dir, 'c.json') }, encoding: 'utf8', timeout: 30_000 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (probe.status !== 0) {
    const said = (probe.stderr ?? '').trim().split('\n').pop() ?? '';
    return (cached = { usable: false, reason: `bwrap cannot build a sandbox here (${said || 'unprivileged user namespaces are not allowed'})` });
  }
  return (cached = { usable: true });
}

let cachedNet;
/**
 * { usable, reason }: can bwrap also give a sandbox its own, empty network namespace here? Some
 * hosts allow user namespaces and refuse network namespaces (Operation not permitted).
 */
export function networkNamespaceAvailability() {
  if (cachedNet) return cachedNet;
  const base = sandboxAvailability();
  if (!base.usable) return (cachedNet = base);
  const probe = spawnSync('bwrap', ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', 'true'], { encoding: 'utf8', timeout: 30_000 });
  if (probe.status === 0) return (cachedNet = { usable: true });
  const said = (probe.stderr ?? '').trim().split('\n').pop() ?? '';
  return (cachedNet = { usable: false, reason: `bwrap cannot create a network namespace here (${said || 'refused'})` });
}
