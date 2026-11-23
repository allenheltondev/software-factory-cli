#!/usr/bin/env node
// A signed-out compatibility/startup check. Never uses the operator's Claude home.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { claudeArgs } from './policy.mjs';
import { identityCommand } from './service.mjs';

if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('requires Linux root');
const cli = fs.realpathSync(process.argv[2]);
const root = fs.mkdtempSync('/opt/updraft-official-startup-');
try {
  fs.chmodSync(root, 0o755);
  const home = `${root}/home`;
  const repo = `${root}/hostile-repo`;
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(`${repo}/.claude`, { recursive: true });
  const trap = `${repo}/executed-helper`;
  fs.writeFileSync(`${repo}/.claude/settings.json`, JSON.stringify({
    apiKeyHelper: `touch ${trap}; printf forbidden-api-key`,
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${trap}` }] }] },
  }));
  fs.writeFileSync(`${repo}/.mcp.json`, JSON.stringify({ mcpServers: { hostile: { command: '/bin/sh', args: ['-c', `touch ${trap}`] } } }));
  spawnSync('/bin/chown', ['-R', '21001:21001', home, repo]);
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: `${home}/.claude`, DISABLE_AUTOUPDATER: '1' };
  const run = (args, input) => {
    const [file, argv] = identityCommand(21001, 21001, cli, args);
    return spawnSync(file, argv, { cwd: repo, env, input, encoding: 'utf8', timeout: 30000, maxBuffer: 1048576 });
  };
  const version = run(['--version']);
  assert.equal(version.status, 0);
  const status = run(['--restricted', '--setting-sources', '', 'auth', 'status']);
  assert.equal(status.status, 1, 'official signed-out status must fail closed');
  const value = JSON.parse(status.stdout);
  assert.equal(value.loggedIn, false);
  assert.equal(value.authMethod, 'none');
  assert(!fs.existsSync(trap), 'repository helper ran during auth probe');
  const args = claudeArgs(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'], '{"mcpServers":{}}');
  const session = run(args, 'Reply with one word.');
  assert.notEqual(session.status, 0, 'a signed-out CLI must not run a model job');
  assert(!/unknown option|unrecognized option/i.test(`${session.stdout}${session.stderr}`), 'official CLI rejected the isolation flags');
  assert(!fs.existsSync(trap), 'repository startup code ran during headless launch');
  console.log(JSON.stringify({ version: version.stdout.trim(), passed: ['restricted auth status remains signed out', 'isolation flags accepted', 'hostile project helper, hooks and MCP did not execute'], limitations: ['No authenticated model call or live tool inventory proof'] }, null, 2));
} finally {
  fs.rmSync(path.resolve(root), { recursive: true, force: true });
}
