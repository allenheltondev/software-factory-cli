// This prototype deliberately exposes one MCP tool and no built-in agent tools (Claude or Codex).
import fs from 'node:fs';
import path from 'node:path';
import { parseRunArgs } from '../image/sandbox/updraft-sandbox.mjs';
import { parseEgressConfig } from '../image/sandbox/egress-proxy.mjs';

export const IMAGE = 'native-claude-worker';
export const TOOL = 'mcp__updraft__exec';
export const MAX_FRAME = 2 * 1024 * 1024;
export const DEFAULT_SOCKET = '/run/updraft-native/worker.sock';
export const GIT_IDENTITY = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
/**
 * The run's base checkout (src/worker/base-check.ts): where the base commit's files and the
 * scratch directory are. Paths, not secrets; validateRun accepts each only when it names a
 * directory the run mounts, so it can point the agent at nothing else.
 */
export const BASE_CHECK_PATHS = ['UPDRAFT_BASE_DIR', 'UPDRAFT_SCRATCH_DIR'];
/** Variables resolved by name from the runtime client's environment (resolveRunEnvironment). */
const BY_NAME = [...GIT_IDENTITY, ...BASE_CHECK_PATHS];
/** Where the egress proxy's socket directory appears inside the sandbox (#147). */
export const EGRESS_TARGET = '/updraft-egress';
export const EGRESS_SOCKET = 'proxy.sock';
export const DEFAULT_TOOL_TIMEOUT_SECONDS = 120;

/**
 * The run arguments for one sandboxed command with registry egress: the proxy's socket
 * directory bound in, and the command started behind the in-sandbox shim. The network stays
 * `none`; the only way out is the proxy, which allows registry hosts only. Pure.
 * `egress` is { dir, shim, node }; without it the arguments are returned unchanged.
 */
export function withEgress(runArgs, run, command, egress) {
  const imageIndex = runArgs.length - run.command.length - 1;
  if (runArgs[imageIndex] !== IMAGE) throw new Error('unexpected runtime arguments');
  const options = runArgs.slice(0, imageIndex);
  if (!egress) return [...options, IMAGE, ...command];
  return [...options, '--mount', `type=bind,source=${egress.dir},target=${EGRESS_TARGET},readonly`, IMAGE,
    egress.node, egress.shim, `${EGRESS_TARGET}/${EGRESS_SOCKET}`, '--', ...command];
}

/** The system prompt sentence about the network, for the agent and the exec tool description. */
export function networkNote(egress) {
  if (!egress) return 'Network access is disabled.';
  return 'Network access is limited to package registries through a proxy that every command already uses (npm, pnpm, Yarn, pip, uv, cargo, go and gem read it): install the locked dependencies with the repository\'s own package manager and lockfile (for example npm ci in each package directory) before running its tests, lint, typecheck and build. Every other host is refused; a refusal is printed as an "updraft-egress:" line. If installation or a check cannot run, report the exact command and error and say the check was not run; never describe unrun checks as passing.';
}

function checkEnvironment(entry) {
  if (entry.name === 'HOME' && entry.value === '/updraft-home') return;
  if (GIT_IDENTITY.includes(entry.name) && typeof entry.value === 'string' && entry.value.length <= 1024 && !/[\0\r\n]/.test(entry.value)) return;
  if (BASE_CHECK_PATHS.includes(entry.name) && typeof entry.value === 'string' && entry.value.startsWith('/') && entry.value.length <= 4096 && !/[\0-\x1f\x7f]/.test(entry.value)) return;
  throw new Error('agent environment overrides are forbidden or unresolved');
}

// Updraft forwards App commit identity by NAME. Resolve only these non-secret fields in
// the runtime client; the root service must never inherit the worker's whole environment.
export function resolveRunEnvironment(argv, env) {
  if (argv[0] !== 'run') return argv;
  const run = parseRunArgs(argv.slice(1));
  const out = [...argv];
  const imageIndex = argv.length - run.command.length - 1;
  for (let i = 1; i < imageIndex; i++) {
    let index;
    let prefix = '';
    if (out[i] === '-e' || out[i] === '--env') index = ++i;
    else if (out[i].startsWith('--env=')) { index = i; prefix = '--env='; }
    else continue;
    const text = out[index].slice(prefix.length);
    const equals = text.indexOf('=');
    const name = equals < 0 ? text : text.slice(0, equals);
    const value = equals < 0 && BY_NAME.includes(name) ? env[name] : equals < 0 ? undefined : text.slice(equals + 1);
    checkEnvironment({ name, value });
    out[index] = `${prefix}${name}=${value}`;
  }
  return out;
}

export function inside(child, parent) {
  return child.startsWith(`${parent}/`);
}

export function validateRun(argv, config) {
  if (!Array.isArray(argv) || argv.some((v) => typeof v !== 'string')) throw new Error('invalid runtime arguments');
  const run = parseRunArgs(argv);
  if (run.image !== IMAGE || run.network !== 'none') throw new Error('native worker requires its image and network: none');
  if (run.user !== `${config.workerUid}:${config.workerGid}`) throw new Error('unexpected job identity');
  run.env.forEach(checkEnvironment);
  if (run.tmpfs.length !== 1 || run.tmpfs[0].path !== '/updraft-home') throw new Error('unexpected temporary mounts');
  // `updraft doctor` probes the executable without a repository mount or working directory.
  if (run.command.length === 2 && ['claude', 'codex'].includes(run.command[0]) && run.command[1] === '--version' && !run.workdir && !run.mounts.length) return run;
  if (!run.workdir || !inside(fs.realpathSync(run.workdir), config.workRoot)) throw new Error('worktree is outside workRoot');
  for (const mount of run.mounts) {
    if (mount.source !== mount.target || !inside(fs.realpathSync(mount.source), config.workRoot)) throw new Error('mount is outside workRoot');
  }
  if (!run.mounts.some((m) => m.target === run.workdir && !m.readOnly)) throw new Error('missing worktree mount');
  // The base checkout's variables name its mounts: the base read-only, the scratch directory read-write.
  for (const entry of run.env) {
    if (!BASE_CHECK_PATHS.includes(entry.name)) continue;
    const readOnly = entry.name === 'UPDRAFT_BASE_DIR';
    if (!run.mounts.some((m) => m.target === entry.value && m.readOnly === readOnly && m.target !== run.workdir)) throw new Error('base checkout variable does not name its mount');
  }
  return run;
}

// Do not forward arbitrary flags, permission rules, configuration, resume paths or plugins.
// Updraft's default bypassPermissions is consumed, then replaced with a narrow MCP allow rule.
export function claudeArgs(input, mcpConfig, { egress = false } = {}) {
  const safe = [];
  let print = false;
  let format;
  for (let i = 0; i < input.length; i++) {
    const flag = input[i];
    if (flag === '-p' || flag === '--print') { print = true; continue; }
    if (flag === '--verbose') continue;
    if (flag === '--permission-mode') {
      if (!['bypassPermissions', 'default'].includes(input[++i])) throw new Error('unsupported permission mode');
      continue;
    }
    if (flag === '--output-format') {
      format = input[++i];
      if (format !== 'stream-json') throw new Error('native worker requires stream-json');
      continue;
    }
    if (['--model', '--effort', '--max-turns'].includes(flag)) {
      const value = input[++i];
      if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error('invalid profile value');
      safe.push(flag, value);
      continue;
    }
    throw new Error('unsupported Claude option in isolated worker');
  }
  if (!print || format !== 'stream-json') throw new Error('only headless streamed runs are supported');
  return ['-p', '--output-format', 'stream-json', '--verbose', '--restricted', '--tools', '',
    '--setting-sources', '', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', mcpConfig,
    '--settings', JSON.stringify({ disableAllHooks: true }), '--permission-mode', 'default',
    '--allowedTools', TOOL, '--append-system-prompt',
    `Use only mcp__updraft__exec for repository work, including reading, editing, git and tests. The tool starts each command in the job worktree. ${networkNote(egress)} Commit changes when the task requires it.`, ...safe];
}

/**
 * Codex features switched off for every isolated session (codex-rs/features/src/lib.rs at
 * openai/codex rust-v0.172.0, 3d86e43, the release the image pins: NATIVE_CODEX_VERSION in
 * cloud/server/scripts/job-image-context.ts). Every key here is a FeatureSpec of that release:
 * `--strict-config` rejects any other, and the image build runs the real pinned binary with these
 * arguments to prove it (native-claude-image-check.ts, codex-config-check.mjs). Audit: every feature that is on by default and adds a model-visible tool,
 * a tool or MCP call path, an extra MCP server (the ChatGPT `codex_apps` connectors, plugins),
 * sub-agents, hooks, browser or computer use, image generation or an approval reviewer; plus the
 * off-by-default ones that would add such a tool if a later release turned them on. Infrastructure
 * flags (MCP startup, compression, retries, TUI) stay as they are. `--strict-config` makes a key the
 * pinned CLI does not know fail the run instead of being ignored, so a renamed feature fails closed.
 */
export const CODEX_DISABLED_FEATURES = [
  // On by default.
  'shell_tool', 'unified_exec', 'unified_exec_tty', 'shell_snapshot', 'view_image', 'sleep_tool', 'code_mode_host', 'hooks',
  'multi_agent', 'apps', 'tool_suggest', 'plugins', 'remote_plugin', 'plugin_sharing', 'in_app_browser', 'in_app_local_automation',
  'browser_use', 'browser_use_full_cdp_access', 'browser_use_external', 'computer_use', 'image_generation', 'skill_mcp_dependency_install',
  'goals', 'tool_call_mcp_elicitation', 'auth_elicitation', 'guardian_approval', 'workspace_dependencies',
  // Off by default, pinned off.
  'multi_agent_v2', 'code_mode', 'code_mode_only', 'standalone_web_search', 'web_search_request', 'web_search_cached',
  // With web_search="disabled", this one would let a host-requested search mode win (core/src/model_search.rs).
  'hosted_search_policy', 'request_permissions_tool', 'exec_permission_approvals', 'memories', 'recommended_plugins',
  'agent_message_board', 'agent_message_board_mcp', 'enable_mcp_apps', 'deferred_executor', 'send_message_to_user_async',
  'artifact',
];

/**
 * The official Codex CLI (docs/codex-subscription.md), restricted the way claudeArgs restricts
 * Claude. Prevention first: started outside the repository with none of its own configuration,
 * rules or project files (`--ignore-user-config --ignore-rules`, private cwd), every tool-adding
 * feature off (CODEX_DISABLED_FEATURES, under `--strict-config`), no web search, no updates, and
 * one MCP server limited to its one tool, which runs every repository command in the job sandbox.
 * Second layer: its own sandbox read-only with no approvals, so a built-in tool that remained
 * could neither write nor reach the network. Third: checkCodexEvent ends the session on any other
 * item. Only the CLI-owned ChatGPT login on the OpenAI provider and the official backend are used.
 * Codex models are still offered `apply_patch` (it comes from model metadata, with no supported
 * switch): the read-only sandbox refuses it and the gate ends the session, so the instructions
 * tell the model to change files only through the tool. Option names are those of codex-rs
 * (exec/src/cli.rs, config/src/config_toml.rs, config/src/mcp_types.rs, features/src/lib.rs).
 * `mcp` is { command, args }. Updraft's adapter flags (--json, the bypass default, the subscription
 * overrides) are consumed; only a model and a reasoning effort pass through. Anything else is refused.
 */
export const CODEX_SERVER = 'updraft';
export const CODEX_TOOL = 'exec';
export const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/';
const toml = (value) => JSON.stringify(value);
const PROFILE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The provider and login pins every Codex command on the worker gets (status, sign-in and runs). */
export const CODEX_LOGIN_PINS = ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"', '-c', `chatgpt_base_url=${toml(CHATGPT_BASE_URL)}`];
export function codexInstructions(egress = false) {
  return `Use only the ${CODEX_SERVER} MCP server's ${CODEX_TOOL} tool for repository work: reading, searching, editing and creating files (write them with shell commands such as cat, printf, sed or a script), git and tests. Never use apply_patch or any other built-in tool; they are disabled, and trying one ends the session. The tool starts each command in the job worktree. ${networkNote(egress)} Commit changes when the task requires it.`;
}
/**
 * Models the isolated session can use. A model the bundled catalog marks `tool_mode:
 * code_mode_only` (codex-rs/models-manager/models.json at openai/codex rust-v0.172.0: the gpt-5.6, gpt-6.x
 * and daybreak models, codex-auto-review) reaches MCP tools only through code mode, which is
 * switched off here, so it would have no usable tool. At rust-v0.172.0 the only listed direct-mode model
 * is gpt-5.5, which is also the default. Unknown models are refused rather than guessed. Re-check
 * against models.json for every pinned Codex version; src/agents/native-codex-args.ts holds the
 * same list for `updraft validate`.
 */
export const CODEX_DIRECT_MODELS = ['gpt-5.5'];
export const CODEX_DEFAULT_MODEL = 'gpt-5.5';
export function codexArgs(input, mcp, { egress = false } = {}) {
  if (input[0] !== 'exec') throw new Error('native worker runs only codex exec');
  const safe = [];
  let model;
  let json = false;
  for (let i = 1; i < input.length; i++) {
    const flag = input[i];
    if (flag === '--json' || flag === '--experimental-json') { json = true; continue; }
    if (flag === '--dangerously-bypass-approvals-and-sandbox') continue;
    if (flag === '--model' || flag === '-m') {
      const value = input[++i];
      if (typeof value !== 'string' || !PROFILE_VALUE.test(value)) throw new Error('invalid profile value');
      if (!CODEX_DIRECT_MODELS.includes(value)) throw new Error('model needs code mode, which the isolated worker switches off');
      model = value;
      continue;
    }
    if (flag === '-c' || flag === '--config') {
      const spec = input[++i];
      if (['model_provider="openai"', 'forced_login_method="chatgpt"', `chatgpt_base_url=${toml(CHATGPT_BASE_URL)}`].includes(spec)) continue;
      const effort = /^model_reasoning_effort="([a-z]{1,16})"$/.exec(spec ?? '');
      if (!effort) throw new Error('unsupported Codex configuration in isolated worker');
      safe.push('-c', `model_reasoning_effort=${toml(effort[1])}`);
      continue;
    }
    throw new Error('unsupported Codex option in isolated worker');
  }
  if (!json) throw new Error('only headless JSONL runs are supported');
  safe.unshift('--model', model ?? CODEX_DEFAULT_MODEL);
  return ['exec', '--json', '--strict-config', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only',
    '-c', 'approval_policy="never"', '-c', 'model_provider="openai"', ...CODEX_LOGIN_PINS,
    ...CODEX_DISABLED_FEATURES.flatMap((name) => ['-c', `features.${name}=false`]),
    // Sub-agents: the model catalog's multi_agent_version (v2 for most models) wins over both
    // multi_agent features; only agents.enabled=false turns them off (core/src/config/mod.rs).
    '-c', 'agents.enabled=false',
    '-c', 'web_search="disabled"', '-c', 'check_for_update_on_startup=false',
    '-c', `mcp_servers.${CODEX_SERVER}.command=${toml(mcp.command)}`, '-c', `mcp_servers.${CODEX_SERVER}.args=${toml(mcp.args)}`,
    '-c', `mcp_servers.${CODEX_SERVER}.required=true`, '-c', `mcp_servers.${CODEX_SERVER}.enabled_tools=${toml([CODEX_TOOL])}`,
    '-c', `mcp_servers.${CODEX_SERVER}.default_tools_approval_mode="approve"`,
    '-c', `developer_instructions=${toml(codexInstructions(egress))}`, ...safe];
}

/**
 * The Codex counterpart of checkInventory, and the second line behind the switches above.
 * `codex exec --json` announces no tool list up front, so the supervisor judges every event: a
 * turn may only think, talk, keep its to-do list and call the one Updraft tool. Any other item (a
 * built-in command, file change, web search, collaboration call, or a type this code does not know)
 * ends the whole session before it is relayed. This sees only what exec reports: it cannot catch an
 * item kind exec drops or a sub-agent's events, which is why the features are switched off first.
 * Returns true once the thread has started (tool calls are served only after that).
 */
const CODEX_EVENTS = ['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error'];
const CODEX_ITEMS = ['agent_message', 'reasoning', 'todo_list', 'error'];
export function checkCodexEvent(event) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new Error('unexpected Codex output; isolation rejected');
  if (CODEX_EVENTS.includes(event.type)) return event.type === 'thread.started';
  if (!['item.started', 'item.updated', 'item.completed'].includes(event.type)) throw new Error('unexpected Codex event; isolation rejected');
  const item = event.item;
  if (item && CODEX_ITEMS.includes(item.type)) return false;
  if (item?.type === 'mcp_tool_call' && item.server === CODEX_SERVER && item.tool === CODEX_TOOL) return false;
  throw new Error('Codex used a tool other than the isolated one; isolation rejected');
}

/**
 * Error text as it leaves the worker: the CLI's error messages can quote a URL, an account or a
 * token-like value, so only a bounded first line with those replaced is relayed (stderr never is).
 * Enough is kept for Updraft to recognize a usage limit (src/capacity/usage-limit.ts).
 */
export function sanitizeCodexText(text) {
  if (typeof text !== 'string') return '';
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  const clean = line
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/[A-Za-z0-9_\-+/=.]{24,}/g, '<redacted>')
    .replace(/[^\x20-\x7e]/g, '');
  return clean.length > 300 ? `${clean.slice(0, 299)}…` : clean;
}
export function sanitizeCodexEvent(event) {
  if (event.type === 'error') return { type: 'error', message: sanitizeCodexText(event.message) };
  if (event.type === 'turn.failed') return { type: 'turn.failed', error: { message: sanitizeCodexText(event.error?.message) } };
  if (event.item?.type === 'error') return { ...event, item: { id: event.item.id, type: 'error', message: sanitizeCodexText(event.item.message) } };
  return event;
}

export function checkInventory(event) {
  if (event.type !== 'system' || event.subtype !== 'init') return false;
  if (!Array.isArray(event.tools) || !event.tools.includes(TOOL) || event.tools.some((t) => ![TOOL, 'EndConversation'].includes(t))) {
    throw new Error('Claude exposed unexpected tools; isolation rejected');
  }
  return true;
}

export function trustedFile(file) {
  let current = path.resolve(file);
  while (true) {
    const s = fs.lstatSync(current);
    if (s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022)) {
      // Installation paths/permissions only, never auth-file contents. Public entrypoints
      // still return a fixed startup error; this detail makes test/install failures actionable.
      throw new Error(`worker installation must be root-owned and not writable by other users: ${current} (uid ${s.uid}, mode ${(s.mode & 0o777).toString(8)})`);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function loadConfig(file) {
  trustedFile(file);
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = ['workerUid', 'workerGid', 'claudeUid', 'claudeGid', 'credentialHome', 'workRoot', 'claude', 'sandboxConfig', 'authModule'];
  // Codex is optional: `codex` (the official executable) and `codexAuthModule` (Updraft's
  // dist/agents/native-codex-auth.js) come together, or the worker refuses Codex runs.
  const optional = ['egress', 'toolTimeoutSeconds', 'codex', 'codexAuthModule'];
  if (Object.keys(c).some((k) => !keys.includes(k) && !optional.includes(k)) || keys.some((k) => c[k] === undefined)) throw new Error('invalid worker configuration');
  if (c.toolTimeoutSeconds !== undefined && (!Number.isInteger(c.toolTimeoutSeconds) || c.toolTimeoutSeconds < 10 || c.toolTimeoutSeconds > 1800)) {
    throw new Error('toolTimeoutSeconds must be 10 to 1800');
  }
  // Validated here so a bad allowlist stops the supervisor before it listens.
  if (c.egress !== undefined) {
    parseEgressConfig(c.egress);
    trustedFile(c.egress.shim);
  }
  for (const key of ['workerUid', 'workerGid', 'claudeUid', 'claudeGid']) {
    if (!Number.isInteger(c[key]) || c[key] < 1000) throw new Error('worker identities must be unprivileged');
  }
  if (c.workerUid === c.claudeUid || c.workerGid === c.claudeGid) throw new Error('Claude and job identities must differ');
  for (const key of keys.slice(4)) {
    if (typeof c[key] !== 'string' || !path.isAbsolute(c[key]) || fs.realpathSync(c[key]) !== c[key]) throw new Error('worker paths must be canonical absolute paths');
  }
  if ((c.codex === undefined) !== (c.codexAuthModule === undefined)) throw new Error('codex and codexAuthModule are configured together');
  for (const key of ['codex', 'codexAuthModule']) {
    if (c[key] !== undefined && (typeof c[key] !== 'string' || !path.isAbsolute(c[key]) || fs.realpathSync(c[key]) !== c[key])) throw new Error('worker paths must be canonical absolute paths');
  }
  // The native binary itself (install.sh resolves it from the platform package), not the npm
  // wrapper script, which would pick the binary from module resolution at every launch.
  if (c.codex !== undefined && /\.[cm]?js$/.test(c.codex)) throw new Error('codex must be the official native executable, not the npm wrapper');
  for (const key of ['claude', 'sandboxConfig', 'authModule', ...(c.codex ? ['codex', 'codexAuthModule'] : [])]) trustedFile(c[key]);
  const home = fs.statSync(c.credentialHome);
  if (!home.isDirectory() || home.uid !== c.claudeUid || (home.mode & 0o077)) throw new Error('credential home must be private to the Claude account');
  // EFS access points replace the client's UID. The NFS root's mode alone is insufficient:
  // a private LOCAL ancestor must deny traversal before any NFS request can happen.
  const parent = fs.statSync(path.dirname(c.credentialHome));
  if (!parent.isDirectory() || parent.uid !== c.claudeUid || (parent.mode & 0o077)) throw new Error('credential mount needs a private local parent directory');
  if (c.credentialHome === c.workRoot || inside(c.credentialHome, c.workRoot) || inside(c.workRoot, c.credentialHome)) throw new Error('credential and job storage must be separate');
  return c;
}

export function claudeEnv(c) {
  return { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: c.credentialHome,
    CLAUDE_CONFIG_DIR: `${c.credentialHome}/.claude`, DISABLE_AUTOUPDATER: '1' };
}

/**
 * The Codex CLI's environment: its own 0700 home inside the credential storage, used as both
 * HOME and CODEX_HOME (its ChatGPT login is auth.json there, which only the CLI reads and
 * refreshes), so Codex never starts in Claude's home. Both CLIs still run as the one credential
 * identity; a separate identity per CLI is a follow-up (docs/codex-subscription.md). Nothing is
 * inherited, so no API key, token, CA, proxy or endpoint override can reach it.
 */
export const codexHome = (c) => `${c.credentialHome}/codex`;
export function codexEnv(c) {
  return { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: codexHome(c), CODEX_HOME: codexHome(c) };
}
