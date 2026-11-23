#!/usr/bin/env node
// Destructive only to a fresh /var/lib test fixture. Requires Linux root + bubblewrap.
// Exercises the real supervisor, MCP transport, Unix accounts and namespace sandbox.
// The Claude stand-in uses ONLY synthetic credentials. No user auth files are read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Run this security check as Linux root; it must not be skipped');
const source = path.dirname(fileURLToPath(import.meta.url));
// Hosted CI runners make /opt writable to the runner. Keep the installation beneath a
// genuinely root-owned ancestor instead of weakening the production ownership check.
const fixture = fs.mkdtempSync('/var/lib/updraft-native-security-');
const marker = `synthetic-secret-${randomUUID()}`;
const results = [];
let service;
let networkTrap;
const workerUid = 21000;
const claudeUid = 21001;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
try {
  fs.chmodSync(fixture, 0o755);
  fs.cpSync(source, `${fixture}/native-worker`, { recursive: true });
  fs.mkdirSync(`${fixture}/image/sandbox`, { recursive: true });
  fs.copyFileSync(path.resolve(source, '../image/sandbox/updraft-sandbox.mjs'), `${fixture}/image/sandbox/updraft-sandbox.mjs`);
  fs.copyFileSync(path.resolve(source, '../../../dist/agents/native-claude-auth.js'), `${fixture}/auth.mjs`);
  // Copies may retain checkout ownership as well as group-writable modes. Model a real
  // root installation explicitly, before creating the separately owned data directories.
  execFileSync('/bin/chown', ['-R', 'root:root', fixture]);
  execFileSync('/bin/chmod', ['-R', 'go-w', fixture]);
  const { startService, assertEfsMount, identityCommand } = await import(pathToFileURL(`${fixture}/native-worker/service.mjs`).href);
  const { frames, send } = await import(pathToFileURL(`${fixture}/native-worker/protocol.mjs`).href);
  const credentialParent = `${fixture}/credential-parent`;
  const credentialHome = `${credentialParent}/home`;
  const workRoot = `${fixture}/jobs`;
  const work = `${workRoot}/repo`;
  for (const dir of [credentialHome, `${credentialHome}/.claude`, workRoot, work]) fs.mkdirSync(dir, { recursive: true });
  fs.chownSync(credentialParent, claudeUid, claudeUid);
  fs.chmodSync(credentialParent, 0o700);
  execFileSync('/bin/chown', ['-R', `${claudeUid}:${claudeUid}`, credentialHome]);
  execFileSync('/bin/chmod', ['-R', '0700', credentialHome]);
  fs.writeFileSync(`${credentialHome}/.claude/.credentials.json`, marker, { mode: 0o600 });
  fs.chownSync(`${credentialHome}/.claude/.credentials.json`, claudeUid, claudeUid);
  const state = `${credentialHome}/status.json`;
  const setStatus = (status) => { fs.writeFileSync(state, JSON.stringify(status), { mode: 0o600 }); fs.chownSync(state, claudeUid, claudeUid); };
  setStatus({ loggedIn: true, authMethod: 'claude.ai' });
  execFileSync('/bin/chown', ['-R', `${workerUid}:${workerUid}`, workRoot]);
  const config = { workerUid, workerGid: workerUid, claudeUid, claudeGid: claudeUid,
    credentialHome, workRoot, claude: `${fixture}/claude`, sandboxConfig: `${fixture}/sandbox.json`, authModule: `${fixture}/auth.mjs` };
  fs.writeFileSync(config.sandboxConfig, JSON.stringify({ image: 'native-claude-worker' }), { mode: 0o644 });
  // This fake verifies the CLI launch contract and drives the REAL MCP tool bridge.
  fs.writeFileSync(config.claude, `#!${process.execPath}
const fs = require('fs'), cp = require('child_process'), rl = require('readline');
const args = process.argv.slice(2);
function required(flag, value) { const i=args.indexOf(flag); if(i<0 || (value!==undefined && args[i+1]!==value)) process.exit(91); }
required('--restricted'); required('--setting-sources','');
if(args.includes('--version')) { console.log('2.1.330 (Claude Code)'); process.exit(0); }
if(args.includes('auth')) {
  const status = fs.readFileSync(process.env.HOME+'/status.json','utf8');
  process.stdout.write(status); process.exit(JSON.parse(status).loggedIn ? 0 : 1);
}
required('--tools',''); required('--strict-mcp-config'); required('--disable-slash-commands');
required('--settings','{"disableAllHooks":true}'); required('--permission-mode','default');
if(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.NODE_OPTIONS ||
  ['GIT_AUTHOR_NAME','GIT_AUTHOR_EMAIL','GIT_COMMITTER_NAME','GIT_COMMITTER_EMAIL'].some(name=>process.env[name]!==undefined)) process.exit(92);
fs.writeFileSync(process.env.HOME+'/session-launched','synthetic launch marker');
let prompt=''; process.stdin.on('data',x=>prompt+=x); process.stdin.on('end',async()=>{
  const spec=JSON.parse(prompt);
  console.log(JSON.stringify({type:'system',subtype:'init',tools: spec.badInventory ? ['mcp__updraft__exec','Read'] : ['mcp__updraft__exec']}));
  if(spec.badInventory) { setTimeout(()=>process.exit(0),5000); return; }
  const mcp=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.updraft;
  const child=cp.spawn(mcp.command,mcp.args,{stdio:['pipe','pipe','inherit']});
  let next=0; const pending=new Map();
  rl.createInterface({input:child.stdout}).on('line',line=>{const r=JSON.parse(line);pending.get(r.id)?.(r);pending.delete(r.id);});
  const rpc=(method,params)=>new Promise(resolve=>{const id=++next;pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\\n');});
  await rpc('initialize',{}); await rpc('tools/list',{});
  const output=[];
  for(const command of spec.commands||[]) {
    const r=await rpc('tools/call',{name:'exec',arguments:{command}});
    output.push(r.result?.content?.map(c=>c.text).join('\\n')||JSON.stringify(r.error));
  }
  console.log(JSON.stringify({type:'result',subtype:'success',result:output.join('\\n')}));
  child.stdin.end();
});
`, { mode: 0o755 });
  const { loadConfig } = await import(pathToFileURL(`${fixture}/native-worker/policy.mjs`).href);
  const configFile = `${fixture}/worker.json`;
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o644 });
  assert.deepEqual(loadConfig(configFile), config);
  fs.chmodSync(credentialParent, 0o755);
  assert.throws(() => loadConfig(configFile), /private local parent/);
  fs.chmodSync(credentialParent, 0o700);
  results.push('private local mount ancestor is mandatory');
  // A bind mount is not EFS. Production must refuse the local test fixture by default.
  assert.throws(() => assertEfsMount(config));
  results.push('missing EFS mount rejected');
  const socketPath = '/run/updraft-native/worker.sock';
  // Only this in-process test injects storage validation. The production CLI has no bypass flag.
  service = await startService(config, socketPath, () => {});
  await assert.rejects(startService(config, `${fixture}/second-worker/worker.sock`, () => {}), /leased|lock/);
  results.push('a second supervisor cannot lease the same durable login');
  function argv(command = ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'], name = `job-${randomUUID()}`) {
    return ['run', '--rm', '-i', '--name', name, '--user', `${workerUid}:${workerUid}`, '--network', 'none',
      '--tmpfs', '/updraft-home:rw,exec,mode=1777', '-e', 'HOME=/updraft-home',
      '--mount', `type=bind,source=${work},target=${work}`, '--workdir', work, 'native-claude-worker', ...command];
  }
  function request(args, prompt = '', onOutput, onClient) {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath);
      onClient?.(client);
      let output = '';
      let done = false;
      client.on('error', reject);
      client.on('connect', () => send(client, { args, prompt }));
      frames(client, (frame) => {
        if (frame.stream) { output += Buffer.from(frame.data, 'base64').toString('utf8'); onOutput?.(output, client); }
        if (frame.exitCode !== undefined) { done = true; client.end(); resolve({ code: frame.exitCode, output }); }
      });
      client.on('close', () => { if (!done) resolve({ code: 125, output }); });
    });
  }
  const native = (commands, other = {}) => request(argv(), JSON.stringify({ commands, ...other }));
  const [runtimeFile, runtimeArgs] = identityCommand(workerUid, workerUid, process.execPath,
    [`${fixture}/native-worker/runtime.mjs`, ...argv()]);
  const runtimeResult = await new Promise((resolve, reject) => {
    const child = spawn(runtimeFile, runtimeArgs, { env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
    child.stdin.end(JSON.stringify({ commands: ['echo real-runtime-client'] }));
  });
  assert.equal(runtimeResult.code, 0, runtimeResult.output);
  assert(runtimeResult.output.includes('real-runtime-client'), runtimeResult.output);
  results.push('real unprivileged runtime client relays prompt, model/tool output and exit status');
  assert.equal((await request(['info'])).code, 0);
  assert.equal((await request(['image', 'inspect', '--format', '{{.Id}}', 'native-claude-worker'])).code, 0);
  const doctorArgs = ['run', '--rm', '--name', 'doctor', '--user', `${workerUid}:${workerUid}`, '--network', 'none',
    '--tmpfs', '/updraft-home:rw,exec,mode=1777', '-e', 'HOME=/updraft-home', 'native-claude-worker', 'claude', '--version'];
  assert.equal((await request(doctorArgs)).code, 0);
  results.push('Updraft doctor runtime/image/executable probes are supported');
  // Ensure the Claude account can read the synthetic fixture; denied access must be meaningful.
  const readable = execFileSync('/usr/bin/setpriv', ['--reuid', String(claudeUid), '--regid', String(claudeUid), '--clear-groups', 'cat', `${credentialHome}/.claude/.credentials.json`], { encoding: 'utf8' });
  assert.equal(readable, marker);
  const attacks = [
    `cat ${quote(`${credentialHome}/.claude/.credentials.json`)}`,
    `cat /proc/${process.pid}/environ`,
    `cat /proc/${process.pid}/root${credentialHome}/.claude/.credentials.json`,
    `ln -s ${quote(credentialHome)} stolen-home; cat stolen-home/.claude/.credentials.json`,
    `node -e 'require("fs").readFileSync(${JSON.stringify(`${credentialHome}/.claude/.credentials.json`)})'`,
    `mount --bind / /tmp/escape`,
  ];
  for (const attack of attacks) {
    const reply = await native([attack]);
    assert.equal(reply.code, 0, reply.output);
    assert(!reply.output.includes(marker));
    assert(!reply.output.includes('exit=0'), reply.output);
  }
  results.push('credential file, parent process, symlink, Node subprocess and mount attacks blocked through real MCP');
  networkTrap = net.createServer((s) => s.end(marker));
  await new Promise((resolve) => networkTrap.listen(0, '127.0.0.1', resolve));
  const port = networkTrap.address().port;
  const network = await native([
    `node -e 'const net=require("net");const s=net.connect(${port},"127.0.0.1");s.on("error",()=>process.exit(1));s.on("data",x=>process.stdout.write(x));s.setTimeout(1000,()=>process.exit(1))'`,
    `node -e 'const net=require("net");const s=net.connect(80,"169.254.169.254");s.on("error",()=>process.exit(1));s.on("connect",()=>process.exit(0));s.setTimeout(1000,()=>process.exit(1))'`,
    `node -e 'require("net").connect(${JSON.stringify(socketPath)}).on("error",()=>process.exit(1))'`,
  ]);
  assert.equal(network.code, 0, network.output);
  assert(!network.output.includes(marker));
  assert(!network.output.includes('exit=0'), network.output);
  results.push('host loopback, metadata endpoint and supervisor socket blocked');
  const verify = await request(argv(['/bin/sh', '-c', attacks.join('; ')]));
  assert.notEqual(verify.code, 0);
  assert(!verify.output.includes(marker));
  results.push('verification uses the same credential boundary');
  const good = await native(['printf "export const answer = 42;\\n" > answer.js',
    'git init -q; git -c user.name=Proof -c user.email=proof@example.invalid add answer.js; git -c user.name=Proof -c user.email=proof@example.invalid commit -qm proof',
    'node -e \'if(!require("fs").readFileSync("answer.js","utf8").includes("42"))process.exit(1)\'']);
  assert.equal(good.code, 0, good.output);
  assert.equal((good.output.match(/exit=0/g) ?? []).length, 3, good.output);
  results.push('normal source editing, git commit and verification work');
  // Real client invocation with the by-name identity fields generated by commitAsApp.
  // The fake CLI rejects these fields in its own environment; only MCP commands get them.
  const identity = { GIT_AUTHOR_NAME: 'updraft[bot]', GIT_AUTHOR_EMAIL: '42+updraft[bot]@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'updraft[bot]', GIT_COMMITTER_EMAIL: '42+updraft[bot]@users.noreply.github.com' };
  const identityArgs = argv();
  identityArgs.splice(identityArgs.indexOf('native-claude-worker'), 0, ...Object.keys(identity).flatMap((name) => ['-e', name]));
  const [identityFile, identityCommandArgs] = identityCommand(workerUid, workerUid, process.execPath,
    [`${fixture}/native-worker/runtime.mjs`, ...identityArgs]);
  const attributed = await new Promise((resolve, reject) => {
    const child = spawn(identityFile, identityCommandArgs, { env: { PATH: '/usr/local/bin:/usr/bin:/bin', ...identity, ANTHROPIC_API_KEY: 'not-forwarded' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
    child.stdin.end(JSON.stringify({ commands: ['git commit --allow-empty -qm attributed; git log -1 --format="%an <%ae> %cn <%ce>"'] }));
  });
  assert.equal(attributed.code, 0, attributed.output);
  assert(attributed.output.includes('updraft[bot] <42+updraft[bot]@users.noreply.github.com> updraft[bot] <42+updraft[bot]@users.noreply.github.com>'), attributed.output);
  assert(!attributed.output.includes('not-forwarded'));
  const badIdentity = argv();
  badIdentity.splice(badIdentity.indexOf('native-claude-worker'), 0, '-e', 'GIT_CONFIG_COUNT=1');
  assert.equal((await request(badIdentity, JSON.stringify({ commands: [] }))).code, 125);
  results.push('App git identity reaches sandbox commits, never Claude; other Git environment overrides are refused');
  assert.equal((await native([], { badInventory: true })).code, 125);
  results.push('unexpected built-in tool inventory rejected');
  for (const status of [{ loggedIn: true, authMethod: 'api_key', secret: marker },
    { loggedIn: false, authMethod: 'none', secret: marker },
    { loggedIn: true, authMethod: 'claude.ai', loginExpiresAt: '2000-01-01T00:00:00Z', secret: marker }]) {
    setStatus(status);
    const refused = await native(['touch should-not-exist']);
    assert.equal(refused.code, 125);
    assert(!refused.output.includes(marker));
    assert(!fs.existsSync(`${work}/should-not-exist`));
  }
  results.push('API auth, signed-out and expired login fail closed without raw status output');
  setStatus({ loggedIn: true, authMethod: 'claude.ai' });
  const later = `${work}/orphan-ran`;
  await request(argv(['/bin/sh', '-c', `echo started; sleep 2; touch ${quote(later)}`]), '', (text, socket) => { if (text.includes('started')) socket.destroy(); });
  await pause(2500);
  assert(!fs.existsSync(later));
  results.push('disconnected client cancels sandbox descendants');
  // Hold the actual Unix socket's listen callback across cancellation. Observe the
  // server-side close event, rather than sleeping and hoping the race was exercised.
  for (const mode of ['disconnect', 'stop']) {
    const name = `cancel-startup-${mode}`;
    const launchMarker = `${credentialHome}/session-launched`;
    const commandMarker = `${work}/canceled-${mode}-ran`;
    fs.rmSync(launchMarker, { force: true });
    const originalListen = net.Server.prototype.listen;
    const originalEmit = net.Server.prototype.emit;
    let ready;
    let resume;
    let serverClosed;
    let serverClient;
    let client;
    const listening = new Promise((resolve) => { ready = resolve; });
    const gate = new Promise((resolve) => { resume = resolve; });
    const closed = new Promise((resolve) => { serverClosed = resolve; });
    const bounded = async (promise) => {
      let timer;
      try {
        return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('startup cancellation regression timed out')), 5000); })]);
      } finally { clearTimeout(timer); }
    };
    net.Server.prototype.listen = function (...args) {
      if (typeof args[0] === 'string' && args[0].endsWith('/tools.sock')) {
        const callback = args.pop();
        args.push(() => { ready(); void gate.then(callback); });
      }
      return originalListen.apply(this, args);
    };
    net.Server.prototype.emit = function (event, ...args) {
      if (event === 'connection' && this.address() === socketPath && !serverClient) {
        serverClient = args[0];
        serverClient.once('close', serverClosed);
      }
      return originalEmit.call(this, event, ...args);
    };
    const pending = request(argv(undefined, name), JSON.stringify({ commands: [`touch ${quote(commandMarker)}`] }), undefined, (socket) => { client = socket; });
    try {
      await bounded(listening);
      if (mode === 'disconnect') { client.destroy(); await bounded(closed); }
      else assert.equal((await request(['stop', name])).code, 0);
      resume();
      assert.equal((await bounded(pending)).code, 125);
      await bounded((async () => {
        while ((await request(['container', 'inspect', name])).code === 0) await pause(10);
      })());
      assert(!fs.existsSync(launchMarker), 'Claude launched after cancellation during socket startup');
      assert(!fs.existsSync(commandMarker), 'repository command executed after startup cancellation');
    } finally {
      resume();
      net.Server.prototype.listen = originalListen;
      net.Server.prototype.emit = originalEmit;
      client?.destroy();
    }
  }
  results.push('disconnect and stop during MCP socket startup prevent Claude launch and repository execution');
  await service.close(); service = undefined;
  service = await startService(config, socketPath, () => {});
  assert.equal((await native(['test -f answer.js'])).code, 0);
  assert.equal(fs.readFileSync(`${credentialHome}/.claude/.credentials.json`, 'utf8'), marker);
  results.push('supervisor replacement reuses the same synthetic CLI home');
  console.log(JSON.stringify({ passed: results, limitations: ['Synthetic Claude CLI, not a model call', 'Local durable directory, not a deployed EFS mount', 'No AWS replacement or subscription end-to-end proof'] }, null, 2));
} finally {
  await service?.close();
  if (networkTrap) await new Promise((resolve) => networkTrap.close(resolve));
  // Only the exact mkdtemp fixture is removed; no user directories are involved.
  fs.rmSync(fixture, { recursive: true, force: true });
}
