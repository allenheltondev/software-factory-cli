// The boundary between the job's trusted part and what it runs (AgentIsolation, README
// "Security model").
//
// Trusted: this runner (root, holds the execution role) and `updraft run-event` (the job
// user, holds the GitHub App key and the state database). Not trusted: the agent CLIs and
// the repository's verify commands, which run text from an issue and code from a branch.
// With isolation enforced those run only inside the sandbox runtime (../sandbox/), started
// by Updraft's own container mode, and the runner refuses to start a job unless it has seen,
// in this microVM, that the boundary holds:
//
//   1. a packet filter keeps every user but root away from the addresses that hand out the
//      execution role's credentials, and from the runner's hook port (createNftFilter);
//   2. every agent the config enables is contained by the sandbox runtime, with nothing that
//      widens it (checkAgentConfig, on what `updraft validate --json` printed);
//   3. a probe run as the job user inside the sandbox cannot read or write the App key, the
//      state database or the job's state directory, cannot see this process, got none of the
//      caller's file descriptors or environment, and cannot connect to those addresses; the
//      plain job user cannot connect to them either (selfTest).
//
// Any of it failing ends the job before `run-event` starts (IsolationError). Everything that
// touches the system comes in through `deps.isolation`, so the logic is tested without root.
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Where the image installs the sandbox runtime, and the "image" name it answers to. */
export const SANDBOX_RUNTIME = '/opt/updraft/bin/updraft-sandbox';
export const SANDBOX_IMAGE = 'microvm';
/** The home directory Updraft's container mode gives a contained command (src/worker/container.ts, CONTAINER_HOME). */
export const CONTAINER_HOME = '/updraft-home';

/**
 * Addresses that hand out AWS credentials to whoever asks from inside a machine. The
 * MicroVMs documentation says only "IAM through IMDSv2": the instance metadata service,
 * 169.254.169.254 (fd00:ec2::254 over IPv6). The container-credential addresses of ECS and
 * EKS (169.254.170.2, 169.254.170.23, fd00:ec2::23) are not named there; they are blocked
 * as well because the SDK's default chain uses them when the environment says so, and
 * nothing else lives at them.
 */
export const DEFAULT_CREDENTIAL_ENDPOINTS = ['169.254.169.254', 'fd00:ec2::254', '169.254.170.2', '169.254.170.23', 'fd00:ec2::23'];

export class IsolationError extends Error {
  /** @param {string} step  @param {string[]} problems */
  constructor(step, problems) {
    super(`ISOLATION NOT ENFORCED (${step}): ${problems.join('; ')}`);
    this.name = 'IsolationError';
    this.step = step;
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Credential endpoints and the packet filter
// ---------------------------------------------------------------------------

/** `ip`, `ip:port` or `[ipv6]:port` as { address, family, port? }. Names are refused: a filter matches addresses. */
export function parseEndpoint(text) {
  let host = String(text).trim();
  let port;
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(host);
  if (bracket) {
    host = bracket[1];
    if (bracket[2] !== undefined) port = Number(bracket[2]);
  } else if (net.isIP(host) === 0) {
    const m = /^(.*):(\d+)$/.exec(host);
    if (m) {
      host = m[1];
      port = Number(m[2]);
    }
  }
  const family = net.isIP(host);
  if (family === 0) throw new Error(`"${text}" is not an IP address (with an optional port); a packet filter cannot match a host name`);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error(`"${text}" has an unusable port`);
  return { address: host.toLowerCase(), family, ...(port === undefined ? {} : { port }) };
}

/**
 * The endpoints to keep non-root users away from: the defaults, what the image's
 * UPDRAFT_CREDENTIAL_ENDPOINTS adds (comma-separated), and wherever the runner's own
 * environment says credentials or the Lambda runtime API live (the variables the AWS SDK's
 * default chain reads). Throws when one of those names a host that is not an address.
 */
export function credentialEndpoints(env = {}) {
  const found = new Map();
  const add = (endpoint) => found.set(`${endpoint.address}|${endpoint.port ?? ''}`, endpoint);
  for (const address of DEFAULT_CREDENTIAL_ENDPOINTS) add(parseEndpoint(address));
  for (const entry of String(env.UPDRAFT_CREDENTIAL_ENDPOINTS ?? '').split(',')) if (entry.trim() !== '') add(parseEndpoint(entry));
  const fromUrl = (name, value) => {
    let url;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
    } catch {
      throw new Error(`${name} is set and is not a URL; cannot tell which address to keep the job away from`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    const hosts = host === 'localhost' ? ['127.0.0.1', '::1'] : [host];
    for (const one of hosts) {
      if (net.isIP(one) === 0) throw new Error(`${name} names the host "${host}", which is not an IP address; cannot keep the job away from it with a packet filter`);
      add({ address: one.toLowerCase(), family: net.isIP(one), port });
    }
  };
  for (const name of ['AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_EC2_METADATA_SERVICE_ENDPOINT', 'AWS_LAMBDA_RUNTIME_API']) {
    if (typeof env[name] === 'string' && env[name] !== '') fromUrl(name, env[name]);
  }
  return [...found.values()];
}

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,60}$/;

/** One nftables rule per endpoint, and one for the hook port: reject for every uid but 0. */
export function filterRules({ endpoints, hookPort }) {
  const rules = endpoints.map((e) => ({
    what: `${e.address}${e.port === undefined ? '' : ` port ${e.port}`}`,
    // What `nft list` must show for the rule to count as present.
    match: ['skuid != 0', `${e.family === 4 ? 'ip' : 'ip6'} daddr ${e.address}`, ...(e.port === undefined ? [] : [`dport ${e.port}`]), 'reject'],
    text: `meta skuid != 0 ${e.family === 4 ? 'ip' : 'ip6'} daddr ${e.address}${e.port === undefined ? '' : ` tcp dport ${e.port}`} counter reject with icmpx type admin-prohibited`,
  }));
  if (hookPort !== undefined) {
    if (!Number.isInteger(hookPort) || hookPort < 1 || hookPort > 65535) throw new Error('the hook port is not a port number');
    // The lifecycle hooks are Lambda's to call (from outside); a local process that is not
    // root has no business there. /terminate would let a job stop itself.
    rules.push({
      what: `local port ${hookPort} (lifecycle hooks)`,
      match: ['skuid != 0', 'oifname "lo"', `dport ${hookPort}`, 'reject'],
      text: `meta skuid != 0 oifname "lo" tcp dport ${hookPort} counter reject with tcp reset`,
    });
  }
  return rules;
}

/** The whole table as one `nft -f` script: created, emptied and filled in one transaction. */
export function filterRuleset({ table, endpoints, hookPort }) {
  if (!TABLE_NAME.test(table)) throw new Error('the nftables table name is not usable');
  const rules = filterRules({ endpoints, hookPort });
  return [
    `table inet ${table}`,
    `delete table inet ${table}`,
    `table inet ${table} {`,
    '  chain output {',
    '    type filter hook output priority 0; policy accept;',
    ...rules.map((rule) => `    ${rule.text}`),
    '  }',
    '}',
    '',
  ].join('\n');
}

/** Which of the rules `nft list table` output does not show. Pure. */
export function missingRules(listing, { endpoints, hookPort }) {
  const text = String(listing);
  if (!/hook output/.test(text)) return ['the table has no chain on the output hook'];
  const lines = text.split('\n');
  return filterRules({ endpoints, hookPort })
    .filter((rule) => !lines.some((line) => rule.match.every((part) => line.includes(part))))
    .map((rule) => `no rule rejects non-root traffic to ${rule.what}`);
}

const CAP_NET_ADMIN = 12n;

/**
 * Whether the effective capabilities in a `/proc/<pid>/status` text include CAP_NET_ADMIN:
 * true or false, or undefined when the text has no CapEff line. Pure.
 */
export function hasNetAdmin(statusText) {
  const match = /^CapEff:\s*([0-9a-fA-F]+)\s*$/m.exec(String(statusText ?? ''));
  if (!match) return undefined;
  return ((BigInt(`0x${match[1]}`) >> CAP_NET_ADMIN) & 1n) === 1n;
}

/** Said when the runner is root but may not change the packet filter (seen in a MicroVM). */
export const NO_NET_ADMIN_PROBLEM =
  'the runner has no CAP_NET_ADMIN, so nftables refuses every change even as root; build the image with additionalOsCapabilities ["ALL"] (deploy.sh and build-job-image.ts send it; an image version built before that lacks it)';

const readOwnStatus = () => readFileSync('/proc/self/status', 'utf8');

/**
 * The packet filter, with nftables (`nft`, package nftables): an owner match (`meta skuid`)
 * on locally generated packets. A process in a user namespace keeps its real uid for this
 * match, so the sandbox's uid mapping changes nothing.
 *
 * @param {object} options
 * @param {() => string} [options.readStatus] this process's /proc status, read only to explain a
 *   failed install (nft -f without CAP_NET_ADMIN exits 1 and prints nothing)
 * @returns {{ install(): { ok: boolean, problem?: string }, check(): { ok: boolean, problems: string[] }, remove(): void, describe(): object }}
 */
export function createNftFilter({ endpoints, hookPort, table = 'updraft_isolation', nft = 'nft', spawnSync = nodeSpawnSync, readStatus = readOwnStatus }) {
  const run = (args) => {
    const result = spawnSync(nft, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
    // nft's message comes first; the lines after it only point into the input.
    const firstLine = (text) => `${text ?? ''}`.trim().split('\n').filter(Boolean)[0];
    const said = firstLine(result.stderr) || firstLine(result.stdout);
    return { ok: result.status === 0, stdout: result.stdout ?? '', problem: result.error ? `cannot run ${nft}: ${result.error.message}` : said || `${nft} exited ${result.status ?? result.signal}` };
  };
  const capabilityProblem = () => {
    try {
      return hasNetAdmin(readStatus()) === false ? NO_NET_ADMIN_PROBLEM : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    install() {
      // From a file only this user can read: nft does not take a script from a pipe it was
      // handed as standard input by another program.
      let dir;
      try {
        dir = mkdtempSync(path.join(tmpdir(), 'updraft-nft-'));
        const file = path.join(dir, 'ruleset.nft');
        writeFileSync(file, filterRuleset({ table, endpoints, hookPort }), { mode: 0o600 });
        const done = run(['-f', file]);
        if (done.ok) return { ok: true };
        const why = capabilityProblem();
        return { ok: false, problem: `the packet filter could not be installed: ${done.problem}${why ? ` (${why})` : ''}` };
      } catch (error) {
        return { ok: false, problem: `the packet filter could not be installed: ${error?.message ?? error}` };
      } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    },
    check() {
      const listed = run(['list', 'table', 'inet', table]);
      if (!listed.ok) return { ok: false, problems: [`the packet filter table is not there: ${listed.problem}`] };
      const problems = missingRules(listed.stdout, { endpoints, hookPort });
      return { ok: problems.length === 0, problems };
    },
    remove() {
      run(['delete', 'table', 'inet', table]);
    },
    describe: () => ({ kind: 'nftables', table, endpoints: endpoints.map((e) => `${e.address}${e.port === undefined ? '' : `:${e.port}`}`), hookPort: hookPort ?? null }),
  };
}

// ---------------------------------------------------------------------------
// The config: every enabled agent contained by the sandbox
// ---------------------------------------------------------------------------

/**
 * Why this config would let an agent or a verify command run outside the sandbox. `config`
 * is the `config` member of `updraft validate --json`: validated, defaults filled in.
 * Returns problems; none means every way Updraft starts an agent goes through the runtime.
 *
 * Checked for every enabled agent, not only those a workflow names today: pools, routing and
 * escalation can all pick agents, and an enabled agent without a container is one edit away
 * from running on the host.
 */
export function checkAgentConfig(config, { runtime = SANDBOX_RUNTIME, image = SANDBOX_IMAGE } = {}) {
  const problems = [];
  if (config === null || typeof config !== 'object') return ['the validated config is missing'];
  const agents = config.agents && typeof config.agents === 'object' ? config.agents : {};
  let enabled = 0;
  for (const [name, agent] of Object.entries(agents)) {
    if (agent === null || typeof agent !== 'object' || agent.enabled === false) continue;
    enabled += 1;
    const at = `agents.${name}`;
    const container = agent.container;
    if (container === undefined || container === null) {
      problems.push(`${at} has no container block: it would run as the job user, next to the GitHub App key and the state database (give it container: { image: ${image}, runtime: ${runtime}, env: [<its key variable>] }, or enabled: false)`);
      continue;
    }
    if (container.runtime !== runtime) problems.push(`${at}.container.runtime is ${JSON.stringify(container.runtime)}, not ${runtime}`);
    if (container.image !== image) problems.push(`${at}.container.image is ${JSON.stringify(container.image)}, not ${image}`);
    // The runtime refuses what it does not know, but --mount and -e are flags it knows:
    // extra arguments could bind the state directory in or pass the caller's variables on.
    if (Array.isArray(container.args) && container.args.length > 0) problems.push(`${at}.container.args is set; extra runtime arguments can widen the sandbox and are not allowed here`);
    if (container.network !== undefined && container.network !== 'host' && container.network !== 'none') problems.push(`${at}.container.network is ${JSON.stringify(container.network)}; the sandbox runtime knows "host" and "none"`);
  }
  if (enabled === 0) problems.push('no agent is enabled');
  // Triage starts the agent CLI directly, never through a container (src/triage/triage.ts).
  if (config.triage !== undefined && config.triage !== null) problems.push('triage is configured; it runs an agent CLI as the job user, outside the sandbox (remove the triage block)');
  return problems;
}

// ---------------------------------------------------------------------------
// The self-test
// ---------------------------------------------------------------------------

/**
 * Runs inside the sandbox (and, for the network part, as the plain job user): `node -e
 * PROBE_SOURCE <json>`. It only tries things and reports what happened as one JSON line; the
 * runner judges (judgeProbe). Written against Node's CommonJS built-ins, nothing else.
 */
export const PROBE_SOURCE = `
const fs = require('fs');
const net = require('net');
const spec = JSON.parse(process.argv[1]);
const attempt = (f) => { try { f(); return 'ok'; } catch (e) { return e && e.code ? e.code : String(e && e.message); } };
const out = { uid: typeof process.getuid === 'function' ? process.getuid() : null, protected: [], listing: null, canary: null, work: null, leakedFds: [], outside: null, environ: null, env: Object.keys(process.env), endpoints: [] };
for (const file of spec.protectedFiles || []) {
  out.protected.push({
    path: file,
    exists: fs.existsSync(file),
    read: attempt(() => fs.readFileSync(file)),
    // Opened for writing (never created) and closed again: nothing is written even where this succeeds.
    write: attempt(() => fs.closeSync(fs.openSync(file, 'r+'))),
  });
}
if (spec.hiddenDir) { try { out.listing = fs.readdirSync(spec.hiddenDir); } catch (e) { out.listing = e.code || 'error'; } }
if (spec.canaryFile) out.canary = attempt(() => fs.writeFileSync(spec.canaryFile, 'written from inside the sandbox'));
if (spec.workFile) out.work = attempt(() => fs.writeFileSync(spec.workFile, spec.token));
if (spec.fdMarker) {
  for (let fd = 3; fd < 64; fd += 1) {
    try {
      const buffer = Buffer.alloc(256);
      const n = fs.readSync(fd, buffer, 0, 256, 0);
      if (buffer.subarray(0, n).toString('latin1').includes(spec.fdMarker)) out.leakedFds.push(fd);
    } catch (e) { /* not open, or not a file */ }
  }
}
if (spec.outside) {
  let start = null;
  try { const stat = fs.readFileSync('/proc/' + spec.outside.pid + '/stat', 'utf8'); start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]; } catch (e) { /* not visible */ }
  out.outside = { visible: start !== null && start === spec.outside.start, signal: start !== null && start === spec.outside.start ? attempt(() => process.kill(spec.outside.pid, 0)) : 'ESRCH' };
}
if (spec.environOf) out.environ = attempt(() => fs.readFileSync('/proc/' + spec.environOf + '/environ'));
const connect = (endpoint) => new Promise((resolve) => {
  const socket = net.connect({ host: endpoint.address, port: endpoint.port, family: endpoint.family });
  const done = (result) => { socket.destroy(); resolve({ address: endpoint.address, port: endpoint.port, result }); };
  socket.setTimeout(spec.connectTimeoutMs || 1500, () => done('timeout'));
  socket.on('connect', () => done('connected'));
  socket.on('error', (e) => done(e.code || 'error'));
});
Promise.all((spec.endpoints || []).map(connect)).then((results) => { out.endpoints = results; process.stdout.write(JSON.stringify(out) + '\\n'); });
`;

/**
 * What a probe report says is wrong. Pure. `expect` is what the runner knows:
 * { sandboxed, allowedEntries, canaryName }.
 */
export function judgeProbe(report, expect) {
  const problems = [];
  const where = expect.sandboxed ? 'inside the sandbox' : 'as the job user';
  if (report === null || typeof report !== 'object') return [`the probe ${where} printed no report`];
  if (expect.sandboxed) {
    for (const file of report.protected ?? []) {
      if (file.read === 'ok') problems.push(`${file.path} can be read ${where}`);
      if (file.write === 'ok') problems.push(`${file.path} can be opened for writing ${where}`);
    }
    if (Array.isArray(report.listing)) {
      const extra = report.listing.filter((name) => !(expect.allowedEntries ?? []).includes(name));
      if (extra.length) problems.push(`the job's state directory is visible ${where} (${extra.slice(0, 8).join(', ')})`);
    }
    // report.canary is not judged here. Inside a sandbox that holds, the state directory exists
    // only as the parent bwrap creates for the bound directory, on the sandbox's own tmpfs, so
    // a write there succeeds and goes nowhere. Whether it reached the real directory is checked
    // from outside, by selfTest.
    if (report.work !== 'ok') problems.push(`the directory bound into the sandbox is not writable there (${report.work}): the sandbox does not apply the binds it is given`);
    if ((report.leakedFds ?? []).length) problems.push(`a file descriptor of the caller reached the command ${where} (fd ${report.leakedFds.join(', ')})`);
    if (report.outside?.visible) problems.push(`the runner's process is visible ${where}`);
    if (report.outside?.signal === 'ok' || report.outside?.signal === 'EPERM') problems.push(`the runner's process can be addressed with a signal ${where}`);
    const leaked = (report.env ?? []).filter((name) => name === expect.canaryName || /^AWS_/.test(name) || name === 'UPDRAFT_HOME');
    if (leaked.length) problems.push(`variables of the caller's environment reached the command ${where} (${leaked.join(', ')})`);
  } else if (report.environ === 'ok') {
    problems.push("the runner's environment (/proc/<pid>/environ) can be read by the job user");
  }
  for (const endpoint of report.endpoints ?? []) {
    if (endpoint.result === 'connected') problems.push(`${endpoint.address} port ${endpoint.port} accepts a connection ${where}`);
  }
  return problems;
}

/**
 * The docker-style arguments of the probe's `run`, the same ones Updraft's container mode
 * builds for an agent (buildContainerRunArgs in src/worker/container.ts; a test compares the
 * two), so that what is tested is what a job will use.
 */
export function probeRunArgs({ name, image, user, workdir, command }) {
  return [
    'run', '--rm', '-i', '--name', name, '--pull', 'never',
    ...(user ? ['--user', user] : []),
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--tmpfs', `${CONTAINER_HOME}:rw,exec,mode=1777`, '-e', `HOME=${CONTAINER_HOME}`,
    '--mount', `type=bind,source=${workdir},target=${workdir}`,
    '--workdir', workdir,
    image, ...command,
  ];
}

/** Run a command to its end as the job user, with a time limit. Never rejects. */
function runAs(deps, command, args, { env, cwd, timeoutMs = 60_000, extraFds = [] } = {}) {
  const spawn = deps.spawn ?? nodeSpawn;
  return new Promise((resolve) => {
    const options = { env, cwd, stdio: ['ignore', 'pipe', 'pipe', ...extraFds], detached: true };
    if (deps.jobUser.uid !== undefined) options.uid = deps.jobUser.uid;
    if (deps.jobUser.gid !== undefined) options.gid = deps.jobUser.gid;
    let child;
    try {
      child = spawn(command, args, options);
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // gone
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout = (stdout + chunk).slice(-1024 * 1024)));
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-16 * 1024)));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, signal, stdout, stderr: timedOut ? `${stderr}\n(timed out after ${timeoutMs} ms)` : stderr });
    });
  });
}

function lastJsonLine(text) {
  const lines = String(text).trim().split('\n').filter((line) => line.trim() !== '');
  try {
    const parsed = JSON.parse(lines.at(-1) ?? '');
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

const lastLine = (text) => String(text).trim().split('\n').filter(Boolean).pop() ?? '';

/** The environment of a process the runner starts as the job user for its own checks: built from nothing. */
function plainEnv(deps, extra = {}) {
  return { PATH: deps.baseEnv?.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: deps.jobUser.home, USER: deps.jobUser.name, LOGNAME: deps.jobUser.name, LANG: deps.baseEnv?.LANG ?? 'C.UTF-8', ...extra };
}

async function digest(file) {
  try {
    const stat = await fs.lstat(file);
    const body = stat.isFile() ? await fs.readFile(file) : Buffer.alloc(0);
    return `${stat.size}:${createHash('sha256').update(body).digest('hex')}`;
  } catch (error) {
    return `absent:${error.code}`;
  }
}

/**
 * The per-job proof. Starts the sandbox runtime as the job user with the arguments Updraft
 * will use, with a directory inside the job's state directory bound in (as a worktree is),
 * and has a probe try everything the boundary is there to stop. Then has the plain job user
 * try the credential endpoints. Returns { ok, problems, checks }.
 */
export async function selfTest({ stateDir, protectedFiles }, deps) {
  const iso = deps.isolation;
  const problems = [];
  const checks = {};
  const separateUser = deps.jobUser.uid !== undefined && deps.jobUser.uid !== process.getuid?.();

  // (d) The packet filter is in place.
  const filter = iso.filter.check();
  checks.packetFilter = filter.ok ? 'in place' : 'missing';
  if (!filter.ok) problems.push(...filter.problems);

  // The runtime is not something the job user could have replaced.
  if (separateUser) {
    try {
      const stat = await fs.stat(iso.runtime);
      if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) problems.push(`the sandbox runtime ${iso.runtime} is not root's alone to write (owner ${stat.uid}, mode ${(stat.mode & 0o777).toString(8)})`);
    } catch (error) {
      problems.push(`the sandbox runtime ${iso.runtime} is not there: ${error.message}`);
    }
  }

  const endpoints = [...iso.endpoints.map((e) => ({ address: e.address, family: e.family, port: e.port ?? 80 })), ...(iso.hookPort === undefined ? [] : [{ address: '127.0.0.1', family: 4, port: iso.hookPort }])];
  const tag = randomBytes(6).toString('hex');
  const workdir = path.join(stateDir, `isolation-selftest-${tag}`);
  const workFile = path.join(workdir, 'written-inside');
  const canaryFile = path.join(stateDir, `isolation-canary-${tag}`);
  const canaryName = 'UPDRAFT_ISOLATION_CANARY';
  const token = randomBytes(16).toString('hex');
  // A file only this process can read, handed to the runtime as an open descriptor: the
  // command must not receive it. Kept outside the state directory.
  const fdMarker = `fd-marker-${randomBytes(16).toString('hex')}`;
  let fdDir;
  let fdHandle;
  const before = {};
  try {
    await fs.mkdir(workdir, { mode: 0o700 });
    if (deps.jobUser.uid !== undefined && deps.jobUser.gid !== undefined) await fs.chown(workdir, deps.jobUser.uid, deps.jobUser.gid);
    fdDir = await fs.mkdtemp(path.join(deps.stateRoot, 'selftest-fd-'));
    await fs.writeFile(path.join(fdDir, 'marker'), fdMarker, { mode: 0o600 });
    fdHandle = await fs.open(path.join(fdDir, 'marker'), 'r');
    for (const file of protectedFiles) before[file] = await digest(file);

    const spec = {
      protectedFiles,
      hiddenDir: stateDir,
      canaryFile,
      workFile,
      token,
      fdMarker,
      outside: { pid: process.pid, start: ownStartTime() },
      endpoints,
      connectTimeoutMs: iso.connectTimeoutMs ?? 1500,
    };
    const user = deps.jobUser.uid !== undefined && deps.jobUser.gid !== undefined ? `${deps.jobUser.uid}:${deps.jobUser.gid}` : hostUser();
    const args = probeRunArgs({ name: `updraft-selftest-${tag}`, image: iso.image, user, workdir, command: [iso.nodePath, '-e', PROBE_SOURCE, JSON.stringify(spec)] });
    // (a) The runtime starts a command as the job user. The canary variable and AWS_ names
    // are in the caller's environment on purpose: they must not arrive.
    const ran = await runAs(deps, iso.runtime, args, {
      env: plainEnv(deps, { ...iso.runtimeEnv, UPDRAFT_HOME: stateDir, [canaryName]: token, AWS_ISOLATION_CANARY: token }),
      cwd: stateDir,
      timeoutMs: iso.probeTimeoutMs ?? 60_000,
      // Twice, the second after a gap: a runtime that only looked at the first few would miss it.
      extraFds: [fdHandle.fd, 'ignore', 'ignore', fdHandle.fd],
    });
    const inside = lastJsonLine(ran.stdout);
    checks.sandboxStarts = ran.code === 0 && inside !== null;
    if (!checks.sandboxStarts) {
      problems.push(`the sandbox runtime could not run a command as the job user (${ran.code === null ? 'no exit code' : `exit ${ran.code}`}${lastLine(ran.stderr) ? `: ${lastLine(ran.stderr)}` : ''})`);
    } else {
      // (b), (c) and the rest of what the probe tried.
      const found = judgeProbe(inside, { sandboxed: true, allowedEntries: [path.basename(workdir)], canaryName });
      problems.push(...found);
      checks.inside = { uid: inside.uid, protected: inside.protected, listing: inside.listing, endpoints: inside.endpoints };
      if (deps.jobUser.uid !== undefined && inside.uid !== deps.jobUser.uid) problems.push(`the command in the sandbox ran as uid ${inside.uid}, not as the job user`);
      // The bind is the real directory: what was written inside is here, with the token.
      let wrote = null;
      try {
        wrote = await fs.readFile(workFile, 'utf8');
      } catch {
        // judged below
      }
      if (inside.work === 'ok' && wrote !== token) problems.push('what the probe wrote in its bound directory did not arrive outside: the command did not run on this file system');
    }
    // Seen from outside: nothing protected changed and nothing appeared.
    for (const file of protectedFiles) {
      if ((await digest(file)) !== before[file]) problems.push(`${file} changed while the probe ran`);
    }
    try {
      await fs.lstat(canaryFile);
      problems.push(`the probe created ${canaryFile} in the job's state directory`);
    } catch {
      // absent, as it must be
    }

    // (c) for the plain job user, outside the sandbox (where `run-event` itself runs).
    const plain = await runAs(deps, iso.nodePath, ['-e', PROBE_SOURCE, JSON.stringify({ endpoints, connectTimeoutMs: spec.connectTimeoutMs, ...(separateUser ? { environOf: process.pid } : {}) })], {
      env: plainEnv(deps),
      cwd: stateDir,
      timeoutMs: iso.probeTimeoutMs ?? 60_000,
    });
    const outside = lastJsonLine(plain.stdout);
    if (plain.code !== 0 || outside === null) problems.push(`the probe could not run as the job user (${plain.code === null ? 'no exit code' : `exit ${plain.code}`}${lastLine(plain.stderr) ? `: ${lastLine(plain.stderr)}` : ''})`);
    else {
      problems.push(...judgeProbe(outside, { sandboxed: false }));
      checks.jobUser = { uid: outside.uid, endpoints: outside.endpoints };
    }
  } catch (error) {
    problems.push(`the self-test itself failed: ${error?.message ?? error}`);
  } finally {
    await fdHandle?.close().catch(() => {});
    if (fdDir) await fs.rm(fdDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(canaryFile, { force: true }).catch(() => {});
  }
  return { ok: problems.length === 0, problems, checks };
}

function ownStartTime() {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

function hostUser() {
  return typeof process.getuid === 'function' && typeof process.getgid === 'function' ? `${process.getuid()}:${process.getgid()}` : undefined;
}

// ---------------------------------------------------------------------------
// What runJob calls
// ---------------------------------------------------------------------------

export const ISOLATION_DISABLED_WARNING =
  'AgentIsolation is disabled: agents and verify commands run as the job user, which can read the GitHub App private key, read and write the state database that is uploaded for later jobs, and reach the execution role\'s credentials';

/** `enforced` unless the launcher says `disabled`: a payload from a launcher that predates the setting is enforced. */
export function isolationMode(payload) {
  return payload.agentIsolation === 'disabled' ? 'disabled' : 'enforced';
}

/**
 * Before anything of the job exists: install the packet filter. Returns the `isolation` entry
 * of the result document. Throws IsolationError when the boundary cannot be set up.
 */
export async function beginIsolation(payload, deps) {
  const mode = isolationMode(payload);
  if (mode === 'disabled') {
    deps.log(`WARNING: ${ISOLATION_DISABLED_WARNING}`);
    return { mode, enforced: false, warning: ISOLATION_DISABLED_WARNING, checks: null, problems: [] };
  }
  const report = { mode, enforced: false, warning: null, checks: {}, problems: [] };
  const iso = deps.isolation;
  if (!iso) throw new IsolationError('setup', ['this runner was started without the sandbox runtime and the packet filter; rebuild the image, or deploy with AgentIsolation=disabled']);
  if (iso.setupProblem) throw new IsolationError('setup', [iso.setupProblem]);
  if (deps.jobUser.uid === undefined && !iso.allowRunnerUser) {
    throw new IsolationError('setup', ['the runner is not root, so it cannot start the job as a separate user or install the packet filter']);
  }
  const installed = iso.filter.install();
  if (!installed.ok) throw new IsolationError('packet filter', [installed.problem]);
  const checked = iso.filter.check();
  if (!checked.ok) throw new IsolationError('packet filter', checked.problems);
  report.checks.packetFilter = iso.filter.describe?.() ?? 'installed';
  deps.log(`isolation: packet filter installed (${iso.endpoints.length} credential endpoint(s)${iso.hookPort === undefined ? '' : `, hook port ${iso.hookPort}`}: rejected for every user but root)`);
  return report;
}

/**
 * After the state directory is filled and before `run-event` starts: the config check and the
 * self-test. Fills `report` (the result document's `isolation`); throws IsolationError.
 */
export async function verifyIsolation(report, { stateDir, protectedFiles }, deps) {
  if (report.mode !== 'enforced') return report;
  const iso = deps.isolation;
  const fail = (step, problems) => {
    report.problems = problems;
    throw new IsolationError(step, problems);
  };

  // Ask Updraft what its config means, as the job user, with nothing in the environment.
  const [command, ...leading] = deps.updraftCommand;
  const validated = await runAs(deps, command, [...leading, 'validate', '--json'], { env: plainEnv(deps, { UPDRAFT_HOME: stateDir }), cwd: stateDir, timeoutMs: iso.validateTimeoutMs ?? 60_000 });
  const answer = lastJsonLine(validated.stdout);
  if (answer === null || typeof answer.ok !== 'boolean') {
    fail('config', [`"updraft validate --json" did not print a report (${validated.code === null ? 'no exit code' : `exit ${validated.code}`}${lastLine(validated.stderr) ? `: ${lastLine(validated.stderr)}` : ''}); the image needs an Updraft that has it`]);
  }
  if (!answer.ok) {
    const errors = Array.isArray(answer.errors) ? answer.errors.map((e) => `${e?.path ? `${e.path}: ` : ''}${e?.message ?? ''}`).slice(0, 10) : [];
    fail('config', [`the config is not valid${errors.length ? `: ${errors.join('; ')}` : ''}`]);
  }
  const configProblems = checkAgentConfig(answer.config, { runtime: iso.runtime, image: iso.image });
  if (configProblems.length) fail('config', configProblems);
  report.checks.config = { agents: Object.entries(answer.config.agents ?? {}).filter(([, agent]) => agent?.enabled !== false).map(([name]) => name), runtime: iso.runtime };

  const tested = await selfTest({ stateDir, protectedFiles }, deps);
  report.checks.selfTest = tested.checks;
  if (!tested.ok) fail('self-test', tested.problems);
  report.enforced = true;
  deps.log(`isolation: enforced (agents ${report.checks.config.agents.join(', ')} run in ${iso.runtime}; the self-test passed)`);
  return report;
}
