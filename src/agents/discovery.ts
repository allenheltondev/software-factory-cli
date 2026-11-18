/**
 * Coding-agent discovery: which agent CLIs are installed and usable on this machine.
 *
 * Checks run in tiers, cheapest first, and later tiers are skipped when an earlier one fails:
 *   1. installed  — PATH, then common install locations a background launcher's PATH may lack
 *   2. runnable   — `<cli> --version`, spawned directly (no shell) with a timeout
 *   3. signed in  — each CLI's own non-interactive status check, or its documented env var
 *   4. supported  — the agent's documented OS/CPU support (independent of this CLI's support)
 * plus an opt-in `deep` tier that sends one trivial headless prompt (uses tokens).
 *
 * Everything that touches the machine goes through {@link DiscoveryProbes} so the logic is
 * unit-testable on any OS. The resolved {@link LaunchSpec} is what live execution (#8) should
 * spawn: on Windows it follows npm `.cmd` shims to the real executable or Node entry point,
 * because Node refuses to spawn `.cmd`/`.bat` files without a shell
 * (https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows).
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { homedir, release, tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';
import { KNOWN_ADAPTERS, type AdapterName } from '../config/schema.js';
import { kiroSupportsV3 } from './adapters/kiro.js';
import { failureLine, firstMeaningfulLine } from './failure-line.js';
import { which } from '../util/which.js';

export type Tri = 'yes' | 'no' | 'unknown';

export interface ProcessResult {
  /** Exit code; null when the process could not start, was killed or timed out. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** Spawn error (e.g. ENOENT, EINVAL), when the process never ran. */
  error?: string;
}

export interface RunOptions {
  timeoutMs: number;
  cwd?: string;
}

/** Everything discovery touches, injectable for tests. */
export interface DiscoveryProbes {
  platform: NodeJS.Platform;
  arch: string;
  /** `os.release()`: the Windows build ("10.0.26100") or Darwin kernel version ("23.4.0"). */
  osRelease: string;
  /** glibc runtime version on Linux ("2.35"); null for musl or other OSes. */
  glibcVersion: string | null;
  env: NodeJS.ProcessEnv;
  /**
   * The directory lookups run from (the process's working directory). A relative PATH entry such
   * as `./bin` resolves against it, and every path discovery returns is made absolute with it,
   * because live execution spawns the CLI from the job worktree, not from here.
   */
  cwd?: string;
  homedir: string;
  /** The Node binary running updraft, used when a shim says plain `node` and none is on PATH. */
  execPath: string;
  /** Is this a regular file (and executable on POSIX)? */
  isExecutable(path: string): boolean;
  /** File contents, or null if unreadable. */
  readFile(path: string): string | null;
  /** Spawn an executable directly: never `shell: true`, stdin closed, killed after timeoutMs. */
  run(file: string, args: string[], opts: RunOptions): Promise<ProcessResult>;
}

/** How to start an agent without a shell: `file` with `args` prepended to the agent's own arguments. */
export interface LaunchSpec {
  file: string;
  args: string[];
}

export interface PlatformSupport {
  supported: Tri;
  detail: string;
}

export interface AgentReport {
  adapter: AdapterName;
  /** Product name, e.g. "Claude Code". */
  name: string;
  /** Binary name looked up, e.g. "kiro-cli". */
  command: string;
  installed: boolean;
  /** Where the command was found (may be a `.cmd` shim on Windows). */
  path: string | null;
  /** False when found only in a common install location outside this process's PATH. */
  onPath: boolean;
  /** Direct spawn target (shim resolved); null when not installed or the shim could not be resolved. */
  launch: LaunchSpec | null;
  runnable: Tri;
  version: string | null;
  signedIn: Tri;
  /** How it is signed in (e.g. "claude.ai", "KIRO_API_KEY"), or why not. */
  auth: string | null;
  platform: PlatformSupport;
  /** Result of the opt-in `--deep` prompt test. */
  deep?: { ok: boolean; detail: string };
  /** Installed, runnable, not known to be signed out, and not known to be unsupported here. */
  usable: boolean;
  /** True when `command` came from agents.<name>.command rather than the adapter's default. */
  configuredCommand?: boolean;
  /**
   * Kiro only, when it ran: whether this Kiro CLI is at the 3.0.0 baseline the adapter is written
   * against ('no': older, unverified); 'unknown' when the version could not be read. Not in `notes`, because
   * agents.<name>.args can pick another harness (doctor checks it with the args).
   */
  kiroV3?: Tri;
  notes: string[];
}

export interface DiscoverOptions {
  /** Defaults to every known adapter. */
  adapters?: readonly string[];
  /** Send one trivial headless prompt to each otherwise-usable agent. Uses tokens. */
  deep?: boolean;
  /**
   * agents.<name>.command: use this CLI instead of looking the adapter's command up (an absolute
   * path, a path relative to `baseDir`, or a name on PATH), as live execution does.
   */
  command?: string;
  baseDir?: string;
}

// ---------------------------------------------------------------------------
// Agent specs
// ---------------------------------------------------------------------------

interface PlatformRule {
  /** Supported OSes; per-OS minimums are checked when the probe can see them. */
  os: Partial<Record<NodeJS.Platform, { label: string; minWindowsBuild?: number; minDarwinMajor?: number; minGlibc?: string }>>;
  /** Supported CPU architectures (Node `process.arch` names); null when the vendor doesn't document it. */
  arch: string[] | null;
  source: string;
}

interface AuthResult {
  signedIn: Tri;
  auth: string | null;
  notes?: string[];
}

interface AuthContext {
  probes: DiscoveryProbes;
  /** Present when the CLI is runnable. */
  launch: LaunchSpec | null;
}

interface AgentSpec {
  adapter: AdapterName;
  name: string;
  command: string;
  /** Extra per-agent install locations (relative to home) beyond the shared list. */
  extraDirs?: (home: string, path: typeof posix) => string[];
  /** Whether the auth check needs to run the CLI (skipped when it isn't runnable). */
  authRunsCli: boolean;
  auth(ctx: AuthContext): Promise<AuthResult>;
  platform: PlatformRule;
  /** Arguments for a trivial headless prompt (deep mode only). */
  deepArgs: string[];
}

const VERSION_TIMEOUT_MS = 15_000;
const AUTH_TIMEOUT_MS = 20_000;
const DEEP_TIMEOUT_MS = 180_000;
const DEEP_PROMPT = 'Reply with the single word OK and nothing else.';

const firstLine = (s: string): string => s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';

/**
 * Why a probe command failed, from its output: the line that reads as the error, not merely the
 * first one (Codex prints a stdin banner and config warnings ahead of it). stderr comes after
 * stdout, so its lines win ties.
 */
const failureDetail = (r: ProcessResult): string => failureLine(`${r.stdout}\n${r.stderr}`);

function runLaunch(ctx: AuthContext, args: string[], timeoutMs: number, cwd?: string): Promise<ProcessResult> {
  const l = ctx.launch!;
  return ctx.probes.run(l.file, [...l.args, ...args], { timeoutMs, cwd });
}

/**
 * Claude Code: `claude auth status` prints JSON by default (`--text` for prose) and exits 0 when
 * signed in, 1 when not; fields include `loggedIn` and `authMethod` (none, claude.ai, oauth_token,
 * api_key, api_key_helper, third_party). Source: https://code.claude.com/docs/en/cli-reference and
 * `claude auth status --help` (v2.1.289). Verified locally: with ANTHROPIC_API_KEY set and no login,
 * it reports `loggedIn: true, authMethod: "api_key", apiKeySource: "ANTHROPIC_API_KEY"`, so env-var
 * auth for `-p` (https://code.claude.com/docs/en/authentication) is covered. We only read
 * loggedIn/authMethod/apiKeySource; the output also has account details we deliberately drop.
 */
async function claudeAuth(ctx: AuthContext): Promise<AuthResult> {
  const r = await runLaunch(ctx, ['auth', 'status'], AUTH_TIMEOUT_MS);
  type Status = { loggedIn?: unknown; authMethod?: unknown; apiKeySource?: unknown };
  let parsed: Status | null;
  try {
    parsed = JSON.parse(r.stdout) as Status | null;
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed.loggedIn === 'boolean') {
    const method = typeof parsed.authMethod === 'string' ? parsed.authMethod : null;
    const source = typeof parsed.apiKeySource === 'string' ? ` via ${parsed.apiKeySource}` : '';
    return parsed.loggedIn
      ? { signedIn: 'yes', auth: `${method ?? 'signed in'}${source}` }
      : { signedIn: 'no', auth: 'not signed in; run "claude auth login" or set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN' };
  }
  // Older Claude Code builds have no `auth status`; don't guess.
  const why = failureDetail(r) || (r.error ?? '');
  return { signedIn: 'unknown', auth: null, notes: [`"claude auth status" gave no status${why ? ` (${why})` : ''}; update Claude Code`] };
}

/**
 * Codex: `codex login status` exits 0 when credentials are present
 * (https://learn.chatgpt.com/docs/developer-commands?surface=cli). Verified locally (codex-cli
 * 0.104.0): it prints "Logged in using ChatGPT" / "Not logged in" on stderr and exits 1 when signed
 * out. It does NOT see OPENAI_API_KEY in the environment (still "Not logged in"); `codex exec` does
 * accept CODEX_API_KEY (https://learn.chatgpt.com/docs/non-interactive-mode), so that counts.
 */
async function codexAuth(ctx: AuthContext): Promise<AuthResult> {
  const r = await runLaunch(ctx, ['login', 'status'], AUTH_TIMEOUT_MS);
  const text = firstMeaningfulLine(r.stderr) || firstMeaningfulLine(r.stdout);
  if (r.code === 0) return { signedIn: 'yes', auth: text || 'logged in' };
  if (ctx.probes.env.CODEX_API_KEY) {
    return { signedIn: 'yes', auth: 'CODEX_API_KEY (codex exec only)' };
  }
  if (r.code !== null && /not logged in/i.test(`${r.stdout}\n${r.stderr}`)) {
    return { signedIn: 'no', auth: 'not logged in; run "codex login" or set CODEX_API_KEY' };
  }
  return { signedIn: 'unknown', auth: null, notes: [`"codex login status" gave no status${text || r.error ? ` (${text || r.error})` : ''}`] };
}

/**
 * Kiro: two ways to be signed in for headless runs.
 *
 * - `KIRO_API_KEY` in the environment. Kiro's docs say "Headless mode requires an API key set as
 *   the KIRO_API_KEY environment variable" (https://kiro.dev/docs/cli/headless/). We can't
 *   validate the key without a prompt (see --deep). The check reads the worker's own
 *   environment, not agents.<name>.env: the key belongs in the launcher's environment, not the
 *   config file.
 * - A login session (`kiro-cli login`: a Builder ID or IAM Identity Center browser sign-in).
 *   Despite the docs, headless `chat --no-interactive` works with one: verified with
 *   kiro-cli 3.5.0 signed in through IAM Identity Center, no key set. `kiro-cli whoami` exits 0
 *   and prints "Logged in with ..." for such a session, which is the check. An active login
 *   takes precedence over the key when both exist
 *   (https://kiro.dev/docs/getting-started/authentication/).
 *
 * With the key set, the CLI is not run for auth. Without it and without a runnable CLI, there is
 * nothing to ask, so it is "no" as before.
 */
async function kiroAuth(ctx: AuthContext): Promise<AuthResult> {
  if (ctx.probes.env.KIRO_API_KEY) return { signedIn: 'yes', auth: 'KIRO_API_KEY is set' };
  const notSignedIn = 'not logged in; run "kiro-cli login" or set KIRO_API_KEY';
  if (!ctx.launch) return { signedIn: 'no', auth: notSignedIn };
  const r = await runLaunch(ctx, ['whoami'], AUTH_TIMEOUT_MS);
  const out = `${r.stdout}\n${r.stderr}`;
  const loggedIn = out.split(/\r?\n/).map((l) => l.trim()).find((l) => /^logged in\b/i.test(l));
  if (r.code === 0 && loggedIn) {
    return {
      signedIn: 'yes',
      auth: loggedIn,
      notes: ['signed in with a kiro-cli login session, which expires: runs fail until "kiro-cli login" again. KIRO_API_KEY does not'],
    };
  }
  if (r.code !== null && /not logged in|log ?in required|please log ?in|kiro-cli login/i.test(out)) {
    return { signedIn: 'no', auth: notSignedIn };
  }
  const why = r.timedOut ? `timed out after ${AUTH_TIMEOUT_MS / 1000}s` : failureDetail(r) || r.error || `exit ${r.code}`;
  return { signedIn: 'unknown', auth: null, notes: [`"kiro-cli whoami" gave no status (${why}); set KIRO_API_KEY or run "kiro-cli login"`] };
}

export const AGENT_SPECS: Record<AdapterName, AgentSpec> = {
  claude: {
    adapter: 'claude',
    name: 'Claude Code',
    command: 'claude',
    // Legacy "local" installs lived in ~/.claude/local.
    extraDirs: (home, p) => [p.join(home, '.claude', 'local')],
    authRunsCli: true,
    auth: claudeAuth,
    // https://code.claude.com/docs/en/setup#system-requirements: macOS 13.0+, Windows 10 1809+ /
    // Server 2019+, Ubuntu 20.04+, Debian 10+, Alpine 3.19+; x64 or ARM64.
    platform: {
      os: {
        darwin: { label: 'macOS 13+', minDarwinMajor: 22 },
        win32: { label: 'Windows 10 1809+', minWindowsBuild: 17763 },
        linux: { label: 'Linux (Ubuntu 20.04+, Debian 10+, Alpine 3.19+)' },
      },
      arch: ['x64', 'arm64'],
      source: 'https://code.claude.com/docs/en/setup#system-requirements',
    },
    // https://code.claude.com/docs/en/headless; --max-turns caps agentic turns in print mode.
    deepArgs: ['-p', DEEP_PROMPT, '--max-turns', '1', '--output-format', 'json'],
  },
  codex: {
    adapter: 'codex',
    name: 'Codex',
    command: 'codex',
    authRunsCli: true,
    auth: codexAuth,
    // The Codex docs don't list platforms; the @openai/codex npm launcher (bin/codex.js) ships
    // native binaries for linux, darwin and win32 on x64 and arm64 and throws otherwise.
    platform: {
      os: { darwin: { label: 'macOS' }, win32: { label: 'Windows' }, linux: { label: 'Linux' } },
      arch: ['x64', 'arm64'],
      source: '@openai/codex npm package (bin/codex.js platform table)',
    },
    // https://learn.chatgpt.com/docs/non-interactive-mode
    deepArgs: ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', DEEP_PROMPT],
  },
  kiro: {
    adapter: 'kiro',
    name: 'Kiro',
    command: 'kiro-cli',
    authRunsCli: false,
    auth: kiroAuth,
    // https://kiro.dev/docs/getting-started/installation/: "macOS, Windows 11 (PowerShell), or Linux
    // (glibc 2.34+ or musl variant)". CPU architectures for the CLI are not documented.
    platform: {
      os: {
        darwin: { label: 'macOS' },
        win32: { label: 'Windows 11', minWindowsBuild: 22000 },
        linux: { label: 'Linux (glibc 2.34+ or musl)', minGlibc: '2.34' },
      },
      arch: null,
      source: 'https://kiro.dev/docs/getting-started/installation/',
    },
    // https://kiro.dev/docs/cli/headless/
    deepArgs: ['chat', '--no-interactive', DEEP_PROMPT],
  },
};

export function isKnownAdapter(name: string): name is AdapterName {
  return (KNOWN_ADAPTERS as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Tier 1: installed
// ---------------------------------------------------------------------------

function pathFor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

/** Case-insensitive on Windows (Path vs PATH, AppData vs APPDATA). */
function getEnv(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key ? env[key] : undefined;
}

/**
 * Common install locations that may be missing from a background launcher's PATH:
 * npm's global prefix, ~/.local/bin (Claude Code's native installer on every OS, Kiro's Linux
 * installer), Homebrew, WinGet's Links directory, and %LOCALAPPDATA%\Kiro-Cli (where Kiro's
 * Windows installer puts kiro-cli.exe, seen with 3.5.0).
 */
export function commonInstallDirs(probes: Pick<DiscoveryProbes, 'platform' | 'env' | 'homedir' | 'execPath'>): string[] {
  const { platform, env, homedir: home } = probes;
  const p = pathFor(platform);
  const dirs: string[] = [];
  const npmPrefix = getEnv(env, 'NPM_CONFIG_PREFIX', platform) ?? env.npm_config_prefix;
  if (platform === 'win32') {
    // npm on Windows puts global bins directly in the prefix (default %APPDATA%\npm).
    if (npmPrefix) dirs.push(npmPrefix);
    const appData = getEnv(env, 'APPDATA', platform) ?? p.join(home, 'AppData', 'Roaming');
    dirs.push(p.join(appData, 'npm'));
    // Node's own install dir doubles as the prefix for some setups.
    dirs.push(p.dirname(probes.execPath));
    dirs.push(p.join(home, '.local', 'bin'));
    const localAppData = getEnv(env, 'LOCALAPPDATA', platform) ?? p.join(home, 'AppData', 'Local');
    dirs.push(p.join(localAppData, 'Microsoft', 'WinGet', 'Links'));
    dirs.push(p.join(localAppData, 'Kiro-Cli'));
  } else {
    if (npmPrefix) dirs.push(p.join(npmPrefix, 'bin'));
    // Default prefix is the Node install root (bin/node -> ../), plus the common user prefix.
    dirs.push(p.dirname(probes.execPath));
    dirs.push(p.join(home, '.npm-global', 'bin'));
    dirs.push(p.join(home, '.local', 'bin'));
    if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
    if (platform === 'linux') dirs.push('/home/linuxbrew/.linuxbrew/bin', p.join(home, '.linuxbrew', 'bin'), '/usr/local/bin');
  }
  return [...new Set(dirs)];
}

/**
 * `which`, with the result made absolute against the directory the lookup ran from. A relative
 * PATH entry (`./bin`) or command (`bin/codex`) yields a relative path, which would point
 * somewhere else once the CLI is spawned with the job worktree as its working directory.
 */
function findExecutable(command: string, probes: DiscoveryProbes, opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): string | null {
  const platform = opts.platform ?? probes.platform;
  const found = which(command, { env: opts.env ?? probes.env, platform, isExecutable: probes.isExecutable });
  if (!found) return null;
  const p = pathFor(platform);
  return p.isAbsolute(found) ? found : p.resolve(probes.cwd ?? process.cwd(), found);
}

function locate(spec: AgentSpec, probes: DiscoveryProbes): { path: string | null; onPath: boolean } {
  const { platform, env } = probes;
  const onPath = findExecutable(spec.command, probes);
  if (onPath) return { path: onPath, onPath: true };
  const p = pathFor(platform);
  const dirs = [...commonInstallDirs(probes), ...(spec.extraDirs?.(probes.homedir, p) ?? [])];
  const pathext = getEnv(env, 'PATHEXT', platform);
  const offEnv: NodeJS.ProcessEnv = { PATH: dirs.join(p.delimiter), ...(pathext ? { PATHEXT: pathext } : {}) };
  return { path: findExecutable(spec.command, probes, { env: offEnv }), onPath: false };
}

// ---------------------------------------------------------------------------
// Windows command shims
// ---------------------------------------------------------------------------

export type CmdShim =
  | { kind: 'exe'; file: string }
  /** `interpreters` in preference order: absolute paths (next to the shim) or bare names to look up. */
  | { kind: 'script'; interpreters: string[]; script: string };

/**
 * Parse an npm `.cmd` shim (cmd-shim) into its target. Handles the current format
 *   `"%dp0%\node_modules\pkg\bin\tool.exe"   %*`                              (native binary)
 *   `... & "%_prog%"  "%dp0%\node_modules\pkg\bin\tool.js" %*` with `SET "_prog=node"`  (Node script)
 * and the older `%~dp0` format (`"%~dp0\node.exe" "%~dp0\..\tool.js" %*` / `node "%~dp0\..." %*`).
 * Returns null when the shim doesn't look like either.
 */
export function parseCmdShim(content: string, shimPath: string): CmdShim | null {
  const dir = win32.dirname(shimPath);
  const DP0 = /%~dp0|%dp0%/i;
  const expand = (s: string) => win32.normalize(s.replace(/%~dp0|%dp0%/gi, `${dir}\\`));
  const lines = content.split(/\r?\n/);
  const execLine = [...lines].reverse().find((l) => l.includes('%*'));
  if (!execLine) return null;

  const quoted = [...execLine.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  const dp0Tokens = quoted.filter((q) => DP0.test(q)).map(expand);
  const isExe = (f: string) => /\.(exe|com)$/i.test(f);
  // A node.exe shipped next to the shim wins, as in the shim itself.
  const localNode = /"(?:%~dp0|%dp0%)\\node\.exe"/i.test(content) ? [win32.join(dir, 'node.exe')] : [];

  if (/%_prog%/i.test(execLine)) {
    const script = dp0Tokens[0];
    if (!script) return null;
    const progs = [...content.matchAll(/SET\s+"_prog=([^"]+)"/gi)].map((m) => (DP0.test(m[1]!) ? expand(m[1]!) : m[1]!));
    return { kind: 'script', interpreters: [...new Set([...localNode, ...progs])], script };
  }

  const trimmed = execLine.trim().replace(/^@/, '');
  if (trimmed.startsWith('"')) {
    const first = quoted[0];
    if (!first || !DP0.test(first)) return null;
    const file = expand(first);
    const rest = dp0Tokens.slice(1);
    if (isExe(file) && rest.length === 0) return { kind: 'exe', file };
    if (rest[0]) return { kind: 'script', interpreters: [file], script: rest[0] };
    return null;
  }
  // Unquoted interpreter, e.g. `node  "%~dp0\node_modules\pkg\cli.js" %*`.
  const interp = trimmed.split(/\s+/)[0];
  const script = dp0Tokens[0];
  if (!interp || !script || interp.includes('%')) return null;
  return { kind: 'script', interpreters: [...localNode, interp], script };
}

/** Resolve a found command to something Node can spawn without a shell. */
export function resolveLaunch(found: string, probes: DiscoveryProbes): { launch: LaunchSpec | null; note?: string } {
  if (probes.platform !== 'win32' || !/\.(cmd|bat)$/i.test(found)) return { launch: { file: found, args: [] } };
  const content = probes.readFile(found);
  const shim = content === null ? null : parseCmdShim(content, found);
  if (!shim) return { launch: null, note: `${found} is a command script Node cannot run without a shell, and it is not a recognized npm shim` };
  if (shim.kind === 'exe') {
    return probes.isExecutable(shim.file)
      ? { launch: { file: shim.file, args: [] } }
      : { launch: null, note: `shim ${found} points to a missing file: ${shim.file}` };
  }
  if (!probes.isExecutable(shim.script)) {
    return { launch: null, note: `shim ${found} points to a missing script: ${shim.script}` };
  }
  for (const interp of shim.interpreters) {
    let file: string | null = null;
    if (win32.isAbsolute(interp)) file = probes.isExecutable(interp) ? interp : null;
    else {
      file = findExecutable(interp, probes, { platform: 'win32' });
      if (!file && /^node(\.exe)?$/i.test(interp)) file = probes.execPath;
    }
    if (file) return { launch: { file, args: [shim.script] } };
  }
  return { launch: null, note: `shim ${found} needs ${shim.interpreters.join(' or ')}, which was not found` };
}

export interface LocatedLaunch {
  /** Where the command was found (may be a `.cmd` shim on Windows); null when not found. */
  path: string | null;
  /** Direct spawn target; null when not found or the shim could not be resolved. */
  launch: LaunchSpec | null;
  /** Why there is no launch, when there isn't one. */
  problem?: string;
}

/**
 * Tier 1 only, for live execution: where an agent's CLI is and how to spawn it without a shell,
 * without running it. `command` (agents.<name>.command) replaces the lookup: an absolute path, a
 * path relative to `baseDir`, or a name looked up on PATH. Shims are resolved as in discovery.
 */
/** Find agents.<name>.command: an absolute path, a path relative to `baseDir`, or a name on PATH. */
function findConfigured(command: string, baseDir: string | undefined, probes: DiscoveryProbes): { target: string; path: string | null; problem: string } {
  const p = pathFor(probes.platform);
  const hasSep = probes.platform === 'win32' ? /[\\/]/.test(command) : command.includes('/');
  const target = hasSep && !p.isAbsolute(command) && baseDir ? p.resolve(baseDir, command) : command;
  const path = findExecutable(target, probes);
  return { target, path, problem: `configured command ${target} was not found${hasSep ? '' : ' on PATH'} or is not executable` };
}

export function locateLaunch(adapter: AdapterName, probes: DiscoveryProbes, opts: { command?: string; baseDir?: string } = {}): LocatedLaunch {
  const spec = AGENT_SPECS[adapter];
  let path: string | null;
  if (opts.command) {
    const found = findConfigured(opts.command, opts.baseDir, probes);
    path = found.path;
    if (!path) return { path: null, launch: null, problem: found.problem };
  } else {
    path = locate(spec, probes).path;
    if (!path) return { path: null, launch: null, problem: `${spec.command} not found on PATH or in common install locations` };
  }
  const resolved = resolveLaunch(path, probes);
  return resolved.launch ? { path, launch: resolved.launch } : { path, launch: null, problem: resolved.note ?? `cannot start ${path}` };
}

// ---------------------------------------------------------------------------
// Tier 4: platform
// ---------------------------------------------------------------------------

function versionAtLeast(actual: string, min: string): boolean {
  const a = actual.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export function checkPlatform(rule: PlatformRule, probes: Pick<DiscoveryProbes, 'platform' | 'arch' | 'osRelease' | 'glibcVersion'>): PlatformSupport {
  const here = `${probes.platform} ${probes.arch}`;
  const os = rule.os[probes.platform];
  if (!os) return { supported: 'no', detail: `${probes.platform} is not supported (${rule.source})` };
  if (os.minWindowsBuild !== undefined) {
    const build = Number(probes.osRelease.split('.')[2]);
    if (Number.isFinite(build) && build < os.minWindowsBuild) {
      return { supported: 'no', detail: `needs ${os.label}; this is Windows build ${build}` };
    }
  }
  if (os.minDarwinMajor !== undefined) {
    const major = Number(probes.osRelease.split('.')[0]);
    if (Number.isFinite(major) && major < os.minDarwinMajor) {
      return { supported: 'no', detail: `needs ${os.label}; this is Darwin ${probes.osRelease}` };
    }
  }
  if (os.minGlibc !== undefined && probes.glibcVersion && !versionAtLeast(probes.glibcVersion, os.minGlibc)) {
    return { supported: 'no', detail: `needs glibc ${os.minGlibc}+; this has glibc ${probes.glibcVersion}` };
  }
  if (rule.arch === null) return { supported: 'unknown', detail: `${here}: ${os.label} is supported; CPU architectures are not documented` };
  if (!rule.arch.includes(probes.arch)) return { supported: 'no', detail: `${probes.arch} is not supported (needs ${rule.arch.join(' or ')})` };
  return { supported: 'yes', detail: `${here}: ${os.label} on ${rule.arch.join(' or ')}` };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export function parseVersion(output: string): string | null {
  const line = firstLine(output);
  if (!line) return null;
  return line.match(/\d+\.\d+\.\d+[\w.+-]*/)?.[0] ?? line;
}

async function discoverOne(
  spec: AgentSpec,
  probes: DiscoveryProbes,
  deep: boolean,
  configured?: { command: string; baseDir?: string },
): Promise<AgentReport> {
  const notes: string[] = [];
  const platform = checkPlatform(spec.platform, probes);
  const report: AgentReport = {
    adapter: spec.adapter,
    name: spec.name,
    command: spec.command,
    installed: false,
    path: null,
    onPath: false,
    launch: null,
    runnable: 'no',
    version: null,
    signedIn: 'unknown',
    auth: null,
    platform,
    usable: false,
    notes,
  };
  if (platform.supported === 'no') notes.push(`not supported here: ${platform.detail}`);

  // Tier 1
  let found: { path: string | null; onPath: boolean };
  if (configured) {
    const c = findConfigured(configured.command, configured.baseDir, probes);
    report.command = c.target;
    report.configuredCommand = true;
    found = { path: c.path, onPath: true };
    if (!c.path) notes.push(c.problem);
  } else {
    found = locate(spec, probes);
    if (!found.path) notes.push(`${spec.command} not found on PATH or in common install locations`);
  }
  if (!found.path) {
    if (!spec.authRunsCli) Object.assign(report, pick(await spec.auth({ probes, launch: null }), notes));
    return report;
  }
  report.installed = true;
  report.path = found.path;
  report.onPath = found.onPath;
  if (!found.onPath) {
    const dir = pathFor(probes.platform).dirname(found.path);
    notes.push(`found outside PATH; add ${dir} to PATH (including the background launcher's) or it may not be found`);
  }

  // Tier 2
  const resolved = resolveLaunch(found.path, probes);
  if (resolved.note) notes.push(resolved.note);
  report.launch = resolved.launch;
  if (resolved.launch) {
    const r = await probes.run(resolved.launch.file, [...resolved.launch.args, '--version'], { timeoutMs: VERSION_TIMEOUT_MS });
    if (r.code === 0) {
      report.runnable = 'yes';
      report.version = parseVersion(r.stdout) ?? parseVersion(r.stderr);
      if (spec.adapter === 'kiro') report.kiroV3 = kiroSupportsV3(report.version);
    } else {
      const why = r.timedOut ? `timed out after ${VERSION_TIMEOUT_MS / 1000}s` : r.error ?? (failureDetail(r) || `exit ${r.code}`);
      notes.push(`"${spec.command} --version" failed: ${why}`);
    }
  }

  // Tier 3
  if (!spec.authRunsCli || report.runnable === 'yes') {
    Object.assign(report, pick(await spec.auth({ probes, launch: report.launch }), notes));
  }

  report.usable = report.runnable === 'yes' && report.signedIn !== 'no' && platform.supported !== 'no';

  // Opt-in: one trivial prompt (uses tokens).
  if (deep && report.usable && report.launch) {
    const r = await probes.run(report.launch.file, [...report.launch.args, ...spec.deepArgs], {
      timeoutMs: DEEP_TIMEOUT_MS,
      cwd: tmpdir(),
    });
    report.deep =
      r.code === 0
        ? { ok: true, detail: 'headless prompt succeeded' }
        : { ok: false, detail: r.timedOut ? `timed out after ${DEEP_TIMEOUT_MS / 1000}s` : r.error ?? (failureDetail(r) || `exit ${r.code}`) };
    if (report.deep.ok) report.signedIn = 'yes';
    else report.usable = false;
  }
  return report;
}

function pick(a: AuthResult, notes: string[]): Pick<AgentReport, 'signedIn' | 'auth'> {
  if (a.notes) notes.push(...a.notes);
  return { signedIn: a.signedIn, auth: a.auth };
}

/** Report for an agent name updraft has no adapter for. */
function unknownAdapter(name: string): AgentReport {
  return {
    adapter: name as AdapterName,
    name,
    command: name,
    installed: false,
    path: null,
    onPath: false,
    launch: null,
    runnable: 'no',
    version: null,
    signedIn: 'unknown',
    auth: null,
    platform: { supported: 'unknown', detail: 'unknown adapter' },
    usable: false,
    notes: [`"${name}" is not a known adapter (${KNOWN_ADAPTERS.join(', ')})`],
  };
}

/** Run the discovery tiers for each adapter, in parallel. Never throws for a single agent. */
export async function discoverAgents(probes: DiscoveryProbes, opts: DiscoverOptions = {}): Promise<AgentReport[]> {
  const adapters = [...new Set(opts.adapters ?? KNOWN_ADAPTERS)];
  return Promise.all(
    adapters.map((a) =>
      isKnownAdapter(a)
        ? discoverOne(AGENT_SPECS[a], probes, Boolean(opts.deep), opts.command ? { command: opts.command, baseDir: opts.baseDir } : undefined).catch((err: unknown) => ({
            ...unknownAdapter(a),
            name: AGENT_SPECS[a].name,
            command: AGENT_SPECS[a].command,
            platform: checkPlatform(AGENT_SPECS[a].platform, probes),
            notes: [`discovery failed: ${err instanceof Error ? err.message : String(err)}`],
          }))
        : Promise.resolve(unknownAdapter(a)),
    ),
  );
}

// ---------------------------------------------------------------------------
// Real probes
// ---------------------------------------------------------------------------

const MAX_OUTPUT = 1024 * 1024;

/** After `exit`, how long to wait for `close` (a descendant may hold the pipes open forever). */
const EXIT_DRAIN_MS = 200;
/** After SIGTERM, how long before SIGKILL. */
const KILL_GRACE_MS = 1_500;

export interface RunProcessOptions extends RunOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides the SIGTERM-to-SIGKILL grace period (tests). */
  killGraceMs?: number;
}

/** A timer that never keeps the event loop alive on its own. */
function unrefTimer(ms: number, fn: () => void): NodeJS.Timeout {
  const t = setTimeout(fn, ms);
  t.unref();
  return t;
}

/**
 * Kill a process and its descendants. POSIX: the child leads its own process group (spawned
 * detached), so signal the group, escalating SIGTERM to SIGKILL after a grace period; a CLI can
 * ignore SIGTERM. Windows: signals don't reach descendants, so `taskkill /t /f` the tree.
 */
function killTree(child: ChildProcess, graceMs: number, exited: () => boolean): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    // Limitation: once the direct child has exited, `taskkill /t` can't find its descendants
    // (they're matched through the live parent), and the pid may already belong to an unrelated
    // process, so we don't kill by pid then. Orphans are left to finish on their own.
    if (exited()) return;
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    const taskkill = systemRoot ? win32.join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
    try {
      const tk = execFile(taskkill, ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, (err) => {
        if (err && !exited()) child.kill();
      });
      tk.unref();
    } catch {
      child.kill();
    }
    return;
  }
  // The group outlives its leader: members that ignore SIGTERM keep it alive after the direct child
  // exits, so escalation checks the group, not the child. ESRCH (empty group) and EPERM count as done.
  const group = (sig: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      return false;
    }
  };
  if (!group('SIGTERM') && !exited()) child.kill('SIGTERM');
  unrefTimer(graceMs, () => {
    if (group(0)) group('SIGKILL');
    else if (!exited()) child.kill('SIGKILL');
  });
}

/**
 * Spawn without a shell, stdin closed (so `-p` modes don't wait on it). Settles no later than
 * `timeoutMs` even if the child ignores SIGTERM or a descendant holds the pipes: on timeout it
 * resolves `timedOut`, closes the pipes and kills the process tree in the background; after a
 * normal `exit` it waits at most EXIT_DRAIN_MS for `close`.
 */
export function runProcess(file: string, args: string[], opts: RunProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let exited = false;
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        shell: false,
        windowsHide: true,
        // Own process group on POSIX so a timeout can kill descendants too.
        detached: process.platform !== 'win32',
        env: opts.env,
        cwd: opts.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const settleTimers: NodeJS.Timeout[] = [];
    const finish = (r: ProcessResult) => {
      if (settled) return;
      settled = true;
      for (const t of settleTimers) clearTimeout(t);
      for (const s of [child.stdout, child.stderr]) {
        s?.removeAllListeners('data');
        s?.destroy();
      }
      resolve(r);
    };
    settleTimers.push(
      unrefTimer(opts.timeoutMs, () => {
        // Even if the direct child already exited: on POSIX its process group may still be live.
        killTree(child, opts.killGraceMs ?? KILL_GRACE_MS, () => exited);
        finish({ code: null, stdout, stderr, timedOut: true });
      }),
    );
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
    });
    // Handlers stay attached after settling (guarded by `settled`) so a late 'error' is never unhandled.
    child.on('error', (err) => finish({ code: null, stdout, stderr, error: err.message }));
    child.on('exit', (code) => {
      exited = true;
      settleTimers.push(unrefTimer(EXIT_DRAIN_MS, () => finish({ code, stdout, stderr })));
    });
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

function glibcRuntime(): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return report?.header?.glibcVersionRuntime ?? null;
  } catch {
    return null;
  }
}

export function defaultDiscoveryProbes(env: NodeJS.ProcessEnv = process.env): DiscoveryProbes {
  const platform = process.platform;
  return {
    platform,
    arch: process.arch,
    osRelease: release(),
    glibcVersion: glibcRuntime(),
    env,
    cwd: process.cwd(),
    homedir: homedir(),
    execPath: process.execPath,
    isExecutable: (p) => {
      try {
        if (!statSync(p).isFile()) return false;
        if (platform !== 'win32') accessSync(p, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    run: (file, args, opts) => runProcess(file, args, { ...opts, env }),
  };
}
