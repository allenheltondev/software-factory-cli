#!/usr/bin/env node
// Packed-install smoke test. Runs the same steps on Windows, macOS and Linux:
//
//   1. npm pack (runs the prepack build) into a directory whose path contains spaces
//   2. npm install -g the tarball into a temporary prefix whose path contains spaces
//   3. updraft --version through the installed entry point
//   4. updraft validate --config <copied example config in a directory with spaces>
//   5. updraft status with UPDRAFT_HOME pointing at a fresh directory with spaces
//
// Updraft commands run offline; only `npm install` may reach the npm registry for
// dependencies. On Windows the global `updraft` is a .cmd shim, which Node cannot spawn
// without a shell, so the commands run as `node <pkg>/dist/cli.js` and the shim is checked
// separately through cmd.exe.
//
// Usage: node scripts/pack-smoke.mjs [--keep]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const isWindows = process.platform === 'win32';
const keep = process.argv.includes('--keep');
const TIMEOUT_MS = 5 * 60_000;

let failed = false;
const tmp = mkdtempSync(join(tmpdir(), 'updraft smoke '));

function step(msg) {
  console.log(`\n== ${msg}`);
}
function ok(msg) {
  console.log(`   ok: ${msg}`);
}
function fail(msg) {
  failed = true;
  throw new Error(msg);
}
function check(cond, msg) {
  if (!cond) fail(msg);
  ok(msg);
}

/** Environment without npm-run leftovers or updraft overrides from the caller. */
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    const key = k.toLowerCase();
    if (key.startsWith('npm_') || key === 'updraft_home' || key === 'updraft_config' || key === 'init_cwd') continue;
    env[k] = v;
  }
  // Keep `gh` from prompting if anything unexpectedly calls it.
  env.GH_PROMPT_DISABLED = '1';
  return { ...env, ...extra };
}

function run(file, args, opts = {}) {
  const res = spawnSync(file, args, {
    cwd: opts.cwd ?? tmp,
    env: opts.env ?? cleanEnv(),
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    windowsVerbatimArguments: opts.verbatim ?? false,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.error) fail(`${file} ${args.join(' ')}: ${res.error.message}`);
  if (opts.expectStatus !== null && res.status !== (opts.expectStatus ?? 0)) {
    console.log(out);
    fail(`${[file, ...args].join(' ')} exited with ${res.status ?? res.signal}`);
  }
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', out };
}

/** npm's JS entry point, run with this node so no shell or .cmd shim is needed. */
function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) {
    if (c && /\.c?js$/.test(c) && existsSync(c)) return c;
  }
  fail(`could not locate npm-cli.js next to ${process.execPath}; set npm_execpath`);
}

const npmCli = findNpmCli();
const npm = (args, opts) => run(process.execPath, [npmCli, ...args], opts);

try {
  console.log(`node ${process.version} on ${process.platform}/${process.arch}; npm ${npm(['--version']).stdout.trim()}`);
  console.log(`temp root: ${tmp}`);

  step('npm pack');
  const packDir = join(tmp, 'pack out');
  mkdirSync(packDir);
  npm(['pack', '--pack-destination', packDir], { cwd: repoRoot });
  const tarballs = readdirSync(packDir).filter((f) => f.endsWith('.tgz'));
  check(tarballs.length === 1, `one tarball produced (${tarballs.join(', ')})`);
  const tarball = join(packDir, tarballs[0]);

  step('npm install -g into a prefix with spaces');
  const prefix = join(tmp, 'global prefix');
  npm(['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', '--prefer-offline', tarball]);
  const pkgDir = isWindows ? join(prefix, 'node_modules', pkg.name) : join(prefix, 'lib', 'node_modules', pkg.name);
  const cliJs = join(pkgDir, 'dist', 'cli.js');
  check(existsSync(cliJs), `installed ${cliJs}`);
  for (const rel of [
    'README.md',
    'docs/live-execution.md',
    'docs/agents/claude.md',
    'examples/config.yaml',
    'examples/prompts/implement-issue.md',
    'examples/prompts/revise-pr.md',
    'examples/launchers/windows/register-task.ps1',
    'examples/launchers/macos/updraft.plist.template',
    'examples/launchers/linux/updraft.service.template',
  ]) {
    check(existsSync(join(pkgDir, ...rel.split('/'))), `package includes ${rel}`);
  }
  check(!existsSync(join(pkgDir, 'src')), 'package does not include src/');

  let updraft;
  if (isWindows) {
    const shim = join(prefix, 'updraft.cmd');
    check(existsSync(shim), `bin shim exists: ${shim}`);
    const shimText = readFileSync(shim, 'utf8');
    // A scoped name (@scope/name) is a directory under node_modules, so its slash is a backslash here.
    check(shimText.includes(`node_modules\\${pkg.name.replaceAll('/', '\\')}\\dist\\cli.js`), 'shim points at dist\\cli.js');
    // cmd.exe /s /c strips the outer quotes and keeps the quoted shim path intact.
    const viaShim = run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${shim}" --version"`], {
      verbatim: true,
    });
    check(viaShim.stdout.trim() === pkg.version, `updraft.cmd --version prints ${pkg.version}`);
    updraft = (args, opts) => run(process.execPath, [cliJs, ...args], opts);
  } else {
    const bin = join(prefix, 'bin', 'updraft');
    check(existsSync(bin), `bin link exists: ${bin}`);
    check(realpathSync(bin) === realpathSync(cliJs), 'bin link resolves to dist/cli.js');
    updraft = (args, opts) => run(bin, args, opts);
  }

  step('updraft --version');
  const version = updraft(['--version']).stdout.trim();
  check(version === pkg.version, `--version prints ${pkg.version} (got "${version}")`);

  step('updraft validate --config <dir with spaces>');
  const configDir = join(tmp, 'config dir with spaces');
  mkdirSync(configDir);
  const configFile = join(configDir, 'config.yaml');
  cpSync(join(pkgDir, 'examples', 'config.yaml'), configFile);
  cpSync(join(pkgDir, 'examples', 'prompts'), join(configDir, 'prompts'), { recursive: true });
  const validateHome = join(tmp, 'validate home');
  const validate = updraft(['validate', '--config', configFile], { env: cleanEnv({ UPDRAFT_HOME: validateHome }) });
  check(validate.status === 0, 'example config is valid');
  check(!/prompt file not found/i.test(validate.out), 'example prompt file resolves relative to the config');

  step('updraft status with a fresh UPDRAFT_HOME');
  const home = join(tmp, 'updraft home with spaces');
  mkdirSync(home);
  const homeEnv = cleanEnv({ UPDRAFT_HOME: home });
  updraft(['status'], { env: homeEnv });
  ok('status exits 0 with no config and no state DB');
  const json = updraft(['status', '--json'], { env: homeEnv });
  let view;
  try {
    view = JSON.parse(json.stdout);
  } catch {
    fail(`status --json did not print JSON:\n${json.out}`);
  }
  check(
    typeof view.dbFile === 'string' && resolve(view.dbFile).startsWith(resolve(home) + sep),
    `state DB resolves under UPDRAFT_HOME (${view.dbFile})`,
  );
  updraft(['status', '--config', configFile], { env: homeEnv });
  ok('status exits 0 with an explicit --config in a directory with spaces');

  console.log('\nPack smoke test passed.');
} catch (err) {
  failed = true;
  console.error(`\nPack smoke test FAILED: ${err instanceof Error ? err.message : err}`);
} finally {
  if (keep || failed) {
    console.log(`Kept ${tmp}`);
  } else {
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      console.warn(`could not remove ${tmp}: ${err.message}`);
    }
  }
}
process.exitCode = failed ? 1 : 0;
