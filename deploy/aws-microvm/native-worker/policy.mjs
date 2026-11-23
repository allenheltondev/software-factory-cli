// This prototype deliberately exposes one MCP tool and no built-in Claude tools.
import fs from 'node:fs';
import path from 'node:path';
import { parseRunArgs } from '../image/sandbox/updraft-sandbox.mjs';

export const IMAGE = 'native-claude-worker';
export const TOOL = 'mcp__updraft__exec';
export const MAX_FRAME = 2 * 1024 * 1024;
export const DEFAULT_SOCKET = '/run/updraft-native/worker.sock';

export function inside(child, parent) {
  return child.startsWith(`${parent}/`);
}

export function validateRun(argv, config) {
  if (!Array.isArray(argv) || argv.some((v) => typeof v !== 'string')) throw new Error('invalid runtime arguments');
  const run = parseRunArgs(argv);
  if (run.image !== IMAGE || run.network !== 'none') throw new Error('native worker requires its image and network: none');
  if (run.user !== `${config.workerUid}:${config.workerGid}`) throw new Error('unexpected job identity');
  if (run.env.some((e) => e.name !== 'HOME' || e.value !== '/updraft-home')) throw new Error('agent environment overrides are forbidden');
  if (run.tmpfs.length !== 1 || run.tmpfs[0].path !== '/updraft-home') throw new Error('unexpected temporary mounts');
  // `updraft doctor` probes the executable without a repository mount or working directory.
  if (run.command.length === 2 && run.command[0] === 'claude' && run.command[1] === '--version' && !run.workdir && !run.mounts.length) return run;
  if (!run.workdir || !inside(fs.realpathSync(run.workdir), config.workRoot)) throw new Error('worktree is outside workRoot');
  for (const mount of run.mounts) {
    if (mount.source !== mount.target || !inside(fs.realpathSync(mount.source), config.workRoot)) throw new Error('mount is outside workRoot');
  }
  if (!run.mounts.some((m) => m.target === run.workdir && !m.readOnly)) throw new Error('missing worktree mount');
  return run;
}

// Do not forward arbitrary flags, permission rules, configuration, resume paths or plugins.
// Updraft's default bypassPermissions is consumed, then replaced with a narrow MCP allow rule.
export function claudeArgs(input, mcpConfig) {
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
    'Use only mcp__updraft__exec for repository work, including reading, editing, git and tests. The tool starts each command in the job worktree. Network access is disabled. Commit changes when the task requires it.', ...safe];
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
    if (s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022)) throw new Error('worker installation must be root-owned and not writable by other users');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function loadConfig(file) {
  trustedFile(file);
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = ['workerUid', 'workerGid', 'claudeUid', 'claudeGid', 'credentialHome', 'workRoot', 'claude', 'sandboxConfig', 'authModule'];
  if (Object.keys(c).some((k) => !keys.includes(k)) || keys.some((k) => c[k] === undefined)) throw new Error('invalid worker configuration');
  for (const key of ['workerUid', 'workerGid', 'claudeUid', 'claudeGid']) {
    if (!Number.isInteger(c[key]) || c[key] < 1000) throw new Error('worker identities must be unprivileged');
  }
  if (c.workerUid === c.claudeUid || c.workerGid === c.claudeGid) throw new Error('Claude and job identities must differ');
  for (const key of keys.slice(4)) {
    if (typeof c[key] !== 'string' || !path.isAbsolute(c[key]) || fs.realpathSync(c[key]) !== c[key]) throw new Error('worker paths must be canonical absolute paths');
  }
  for (const key of ['claude', 'sandboxConfig', 'authModule']) trustedFile(c[key]);
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
