// AgentIsolation: the packet filter, the config check and the per-job self-test
// (image/runner/isolation.mjs), and what runJob does with them.
//
// The pure parts run on every OS. The self-test starts processes: it runs on POSIX hosts, and
// the cases that need the real sandbox runtime run where bwrap can build one (sandbox-host.mjs
// says why when it cannot). The packet filter itself needs root and nftables; here it is a
// stand-in, and a local listener plays the credential endpoint so that the probe's own
// network check is exercised for real.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTAINER_HOME as UPDRAFT_CONTAINER_HOME, buildContainerRunArgs } from '../../../src/worker/container.ts';
import {
  CONTAINER_HOME,
  DEFAULT_CREDENTIAL_ENDPOINTS,
  IPV6_NOT_FILTERED,
  IsolationError,
  NO_NET_ADMIN_PROBLEM,
  SANDBOX_IMAGE,
  SANDBOX_RUNTIME,
  checkAgentConfig,
  createNftFilter,
  hasNetAdmin,
  credentialEndpoints,
  filterRules,
  filterRuleset,
  isolationMode,
  judgeProbe,
  missingRules,
  parseEndpoint,
  probeRunArgs,
  selfTest,
} from '../image/runner/isolation.mjs';
import { ISOLATION_CHECK_MARKER, checkImageIsolation, runJob } from '../image/runner/job.mjs';
import { checkConfig } from '../../../src/commands/validate.ts';
import { installRuntime, requireUnlessAllowedToSkip, sandboxAvailability } from './sandbox-host.mjs';

const onLinuxLikeHost = process.platform !== 'win32';
const sandbox = requireUnlessAllowedToSkip(onLinuxLikeHost ? sandboxAvailability() : { usable: false, reason: 'needs Linux' });
const FAKE_UPDRAFT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-updraft.mjs');

const contained = (extra = {}) => ({ enabled: true, container: { image: SANDBOX_IMAGE, runtime: SANDBOX_RUNTIME, env: ['ANTHROPIC_API_KEY'], ...extra } });

describe('credential endpoints', () => {
  it('parses addresses with and without a port, and refuses host names', () => {
    expect(parseEndpoint('169.254.169.254')).toEqual({ address: '169.254.169.254', family: 4 });
    expect(parseEndpoint('169.254.170.2:80')).toEqual({ address: '169.254.170.2', family: 4, port: 80 });
    expect(parseEndpoint('[FD00:EC2::254]:80')).toEqual({ address: 'fd00:ec2::254', family: 6, port: 80 });
    expect(parseEndpoint('fd00:ec2::23')).toEqual({ address: 'fd00:ec2::23', family: 6 });
    expect(() => parseEndpoint('metadata.internal')).toThrow('not an IP address');
    expect(() => parseEndpoint('10.0.0.1:99999')).toThrow('unusable port');
  });

  it('blocks the metadata service and the container-credential addresses by default, plus what the environment names', () => {
    const plain = credentialEndpoints({}).map((e) => e.address);
    expect(plain).toEqual(DEFAULT_CREDENTIAL_ENDPOINTS);
    const more = credentialEndpoints({
      UPDRAFT_CREDENTIAL_ENDPOINTS: '10.1.2.3:8080, ',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://localhost:1338/creds',
      AWS_LAMBDA_RUNTIME_API: '127.0.0.1:9001',
    });
    expect(more).toEqual(
      expect.arrayContaining([
        { address: '10.1.2.3', family: 4, port: 8080 },
        { address: '127.0.0.1', family: 4, port: 1338 },
        { address: '::1', family: 6, port: 1338 },
        { address: '127.0.0.1', family: 4, port: 9001 },
      ]),
    );
    // A name cannot be matched by a packet filter: refusing is better than leaving it open.
    expect(() => credentialEndpoints({ AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://creds.example/x' })).toThrow('not an IP address');
  });
});

describe('the packet filter', () => {
  const endpoints = [parseEndpoint('169.254.169.254'), parseEndpoint('[fd00:ec2::254]:80')];

  it('drops for every user but root, one table per address family, each endpoint in its own family', () => {
    const v4 = filterRuleset({ table: 'updraft_isolation', endpoints, hookPort: 9000, family: 4 });
    expect(v4).toContain('type filter hook output priority 0; policy accept;');
    expect(v4).toContain('meta skuid != 0 ip daddr 169.254.169.254 counter drop');
    expect(v4).toContain('meta skuid != 0 oifname "lo" tcp dport 9000 counter drop');
    expect(v4).not.toContain('fd00:ec2::254');
    // What a MicroVM's kernel lacks: the inet family and a reject module.
    expect(v4).not.toMatch(/\binet\b|reject/);
    const v6 = filterRuleset({ table: 'updraft_isolation', endpoints, hookPort: 9000, family: 6 });
    expect(v6).toContain('table ip6 updraft_isolation {');
    expect(v6).toContain('meta skuid != 0 ip6 daddr fd00:ec2::254 tcp dport 80 counter drop');
    expect(v6).toContain('meta skuid != 0 oifname "lo" tcp dport 9000 counter drop');
    expect(v6).not.toContain('169.254.169.254');
    // Replaced as a whole, so a second job in the same microVM does not stack rules.
    expect(v4.indexOf('delete table ip updraft_isolation')).toBeLessThan(v4.indexOf('table ip updraft_isolation {'));
    expect(() => filterRuleset({ table: 'x; flush ruleset', endpoints, hookPort: 9000 })).toThrow('table name');
    expect(() => filterRules({ endpoints, family: 5 })).toThrow('address family');
  });

  it('reads back what nft lists, and names each missing rule', () => {
    const listing = filterRuleset({ table: 't', endpoints, hookPort: 9000, family: 4 });
    expect(missingRules(listing, { endpoints, hookPort: 9000, family: 4 })).toEqual([]);
    const withoutHook = listing.split('\n').filter((line) => !line.includes('dport 9000')).join('\n');
    expect(missingRules(withoutHook, { endpoints, hookPort: 9000, family: 4 })).toEqual(['no rule drops non-root traffic to local port 9000 (lifecycle hooks)']);
    expect(missingRules('table ip t {\n}', { endpoints, hookPort: 9000, family: 4 })).toEqual(['the ip table has no chain on the output hook']);
    // What nft lists for a rule (priority by name, the counter's numbers) still matches.
    const real = 'table ip t {\n\tchain output {\n\t\ttype filter hook output priority filter; policy accept;\n\t\tmeta skuid != 0 ip daddr 169.254.169.254 counter packets 2 bytes 120 drop\n\t\tmeta skuid != 0 oifname "lo" tcp dport 9000 counter packets 2 bytes 120 drop\n\t}\n}\n';
    expect(missingRules(real, { endpoints, hookPort: 9000, family: 4 })).toEqual([]);
  });

  /** nft as a MicroVM has it: the ip family; ip6 and inet "Operation not supported". */
  function fakeNft({ ip6 = false } = {}) {
    const calls = [];
    const tables = {};
    const spawnSync = (cmd, args) => {
      calls.push(args.join(' '));
      if (args[0] === '-f') {
        const script = fs.readFileSync(args[1], 'utf8');
        const family = /^table (\S+) /.exec(script)[1];
        if (family !== 'ip' && !(family === 'ip6' && ip6)) return { status: 1, stdout: '', stderr: `${args[1]}:1:1-29: Error: Could not process rule: Operation not supported\nmore` };
        tables[family] = script;
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'list') return tables[args[2]] ? { status: 0, stdout: tables[args[2]], stderr: '' } : { status: 1, stdout: '', stderr: 'Error: No such file or directory' };
      if (args[0] === 'delete') delete tables[args[2]];
      return { status: 0, stdout: '', stderr: '' };
    };
    return { spawnSync, calls, tables };
  }

  it('installs the ip table, and the ip6 one where the kernel has that family', () => {
    const both = fakeNft({ ip6: true });
    const filter = createNftFilter({ endpoints, hookPort: 9000, spawnSync: both.spawnSync });
    expect(filter.install()).toEqual({ ok: true });
    expect(filter.check()).toEqual({ ok: true, problems: [] });
    expect(filter.describe()).toMatchObject({ kind: 'nftables', ipv6: 'filtered' });
    expect(both.calls.filter((c) => c.startsWith('list'))).toEqual(['list table ip updraft_isolation', 'list table ip6 updraft_isolation']);
    // The ruleset files are gone again.
    for (const call of both.calls.filter((c) => c.startsWith('-f'))) expect(fs.existsSync(call.slice(3))).toBe(false);
    filter.remove();
    expect(both.tables).toEqual({});
  });

  it('on a kernel without ip6 (a MicroVM), installs the ip table and says IPv6 is left to the self-test', () => {
    const v4only = fakeNft();
    const filter = createNftFilter({ endpoints, hookPort: 9000, spawnSync: v4only.spawnSync });
    expect(filter.install()).toEqual({ ok: true });
    expect(filter.check()).toEqual({ ok: true, problems: [] });
    expect(filter.describe().ipv6).toBe(IPV6_NOT_FILTERED);
    expect(v4only.calls.filter((c) => c.startsWith('list'))).toEqual(['list table ip updraft_isolation']);
    // A missing ip table is still a missing filter.
    delete v4only.tables.ip;
    expect(filter.check()).toMatchObject({ ok: false, problems: [expect.stringMatching(/^the packet filter's ip table is not there/)] });
  });

  it('fails when the ip table cannot be installed, or the ip6 one fails for another reason', () => {
    const broken = createNftFilter({ endpoints, hookPort: 9000, readStatus: () => '', spawnSync: () => ({ status: 1, stdout: '', stderr: 'Error: Could not process rule: No such file or directory\nmore' }) });
    expect(broken.install()).toEqual({ ok: false, problem: 'the packet filter could not be installed: Error: Could not process rule: No such file or directory' });
    expect(broken.check().ok).toBe(false);

    const v6broken = createNftFilter({
      endpoints,
      hookPort: 9000,
      spawnSync: (cmd, args) => (args[0] === '-f' && fs.readFileSync(args[1], 'utf8').startsWith('table ip6') ? { status: 1, stdout: '', stderr: 'Error: syntax error' } : { status: 0, stdout: '', stderr: '' }),
    });
    expect(v6broken.install()).toEqual({ ok: false, problem: 'the IPv6 packet filter could not be installed: Error: syntax error' });
  });

  // What a MicroVM image built without additionalOsCapabilities showed: root, the
  // container-default capability set, and `nft -f` exiting 1 with nothing on stderr.
  const MICROVM_DEFAULT_STATUS = 'Name:\tnode\nUid:\t0\t0\t0\t0\nCapInh:\t0000000000000000\nCapPrm:\t00000000a80425fb\nCapEff:\t00000000a80425fb\nCapBnd:\t00000000a80425fb\n';

  it('reads CAP_NET_ADMIN from a /proc status text', () => {
    expect(hasNetAdmin(MICROVM_DEFAULT_STATUS)).toBe(false);
    expect(hasNetAdmin('CapEff:\t000001ffffffffff\n')).toBe(true);
    expect(hasNetAdmin('CapEff:\t0000000000001000\n')).toBe(true);
    expect(hasNetAdmin('Name:\tnode\n')).toBeUndefined();
  });

  it('says CAP_NET_ADMIN is missing when nft fails silently without it', () => {
    const silent = () => ({ status: 1, stdout: '', stderr: '' });
    const filter = createNftFilter({ endpoints, hookPort: 9000, spawnSync: silent, readStatus: () => MICROVM_DEFAULT_STATUS });
    expect(filter.install()).toEqual({ ok: false, problem: `the packet filter could not be installed: nft exited 1 (${NO_NET_ADMIN_PROBLEM})` });
    // With the capability, or with no status to read, the failure is reported as it came.
    for (const readStatus of [() => 'CapEff:\t000001ffffffffff\n', () => { throw new Error('no /proc'); }]) {
      expect(createNftFilter({ endpoints, hookPort: 9000, spawnSync: silent, readStatus }).install()).toEqual({ ok: false, problem: 'the packet filter could not be installed: nft exited 1' });
    }
  });

  it('falls back to what nft printed on stdout when stderr is empty', () => {
    const filter = createNftFilter({ endpoints, hookPort: 9000, readStatus: () => '', spawnSync: () => ({ status: 1, stdout: 'Operation not permitted (you must be root)\n', stderr: '' }) });
    expect(filter.install()).toEqual({ ok: false, problem: 'the packet filter could not be installed: Operation not permitted (you must be root)' });
  });
});

describe('the config check', () => {
  it('accepts a config whose every enabled agent runs in the sandbox runtime', () => {
    expect(checkAgentConfig({ agents: { claude: contained(), codex: contained({ network: 'host' }), kiro: { enabled: false } } })).toEqual([]);
  });

  it('refuses an agent outside the sandbox, a different runtime or image, extra arguments, and triage', () => {
    const problems = checkAgentConfig({
      agents: {
        claude: { enabled: true },
        codex: contained({ runtime: 'docker' }),
        kiro: contained({ image: 'ubuntu' }),
        other: contained({ args: ['--mount', 'type=bind,source=/var/lib/updraft-jobs,target=/x'] }),
        net: contained({ network: 'bridge' }),
      },
      triage: { agent: 'claude' },
    });
    expect(problems).toEqual([
      expect.stringMatching(/^agents\.claude has no container block/),
      'agents.codex.container.runtime is "docker", not /opt/updraft/bin/updraft-sandbox',
      'agents.kiro.container.image is "ubuntu", not microvm',
      expect.stringMatching(/^agents\.other\.container\.args is set/),
      expect.stringMatching(/^agents\.net\.container\.network is "bridge"/),
      expect.stringMatching(/^triage is configured/),
    ]);
    expect(checkAgentConfig({ agents: { claude: { enabled: false } } })).toEqual(['no agent is enabled']);
    expect(checkAgentConfig(null)).toEqual(['the validated config is missing']);
  });
});

describe('the example config', () => {
  // Its agents are containerized, which validate refuses on native Windows by design: the
  // deployment's config is for the Linux image only.
  it.skipIf(process.platform === 'win32')('is valid, and is what an enforced job accepts', () => {
    const example = fileURLToPath(new URL('../config/config.example.yaml', import.meta.url));
    const check = checkConfig(example);
    expect(check.state).toBe('ok');
    expect(checkAgentConfig(check.config)).toEqual([]);
  });
});

describe('the probe report', () => {
  const clean = {
    uid: 1000,
    protected: [{ path: '/s/github-app.pem', exists: false, read: 'ENOENT', write: 'ENOENT' }],
    listing: ['isolation-selftest-abc'],
    canary: 'ENOENT',
    work: 'ok',
    leakedFds: [],
    outside: { visible: false, signal: 'ESRCH' },
    env: ['HOME', 'PATH', 'LANG'],
    endpoints: [{ address: '169.254.169.254', port: 80, result: 'ECONNREFUSED' }],
  };
  const expectInside = { sandboxed: true, allowedEntries: ['isolation-selftest-abc'], canaryName: 'CANARY' };

  it('finds nothing wrong in a sandbox that holds', () => {
    expect(judgeProbe(clean, expectInside)).toEqual([]);
    expect(judgeProbe({ endpoints: clean.endpoints, environ: 'EACCES' }, { sandboxed: false })).toEqual([]);
  });

  it('names each way the boundary can fail', () => {
    const broken = {
      ...clean,
      protected: [{ path: '/s/github-app.pem', exists: true, read: 'ok', write: 'ok' }],
      listing: ['isolation-selftest-abc', 'github-app.pem', 'state.db'],
      canary: 'ok',
      work: 'EROFS',
      leakedFds: [3],
      outside: { visible: true, signal: 'ok' },
      env: ['PATH', 'CANARY', 'AWS_SECRET_ACCESS_KEY', 'UPDRAFT_HOME'],
      endpoints: [{ address: '169.254.169.254', port: 80, result: 'connected' }],
    };
    expect(judgeProbe(broken, expectInside)).toEqual([
      '/s/github-app.pem can be read inside the sandbox',
      '/s/github-app.pem can be opened for writing inside the sandbox',
      "the job's state directory is visible inside the sandbox (github-app.pem, state.db)",
      'the directory bound into the sandbox is not writable there (EROFS): the sandbox does not apply the binds it is given',
      "a file descriptor of the caller reached the command inside the sandbox (fd 3)",
      "the runner's process is visible inside the sandbox",
      "the runner's process can be addressed with a signal inside the sandbox",
      "variables of the caller's environment reached the command inside the sandbox (CANARY, AWS_SECRET_ACCESS_KEY, UPDRAFT_HOME)",
      '169.254.169.254 port 80 accepts a connection inside the sandbox',
    ]);
    expect(judgeProbe({ environ: 'ok', endpoints: [] }, { sandboxed: false })).toEqual(["the runner's environment (/proc/<pid>/environ) can be read by the job user"]);
    expect(judgeProbe(null, expectInside)).toEqual(['the probe inside the sandbox printed no report']);
  });

  it('starts the probe with the same arguments Updraft starts an agent with', () => {
    expect(CONTAINER_HOME).toBe(UPDRAFT_CONTAINER_HOME);
    const workdir = '/var/lib/updraft-jobs/job-1/isolation-selftest-abc';
    const command = ['/usr/local/bin/node', '-e', 'probe', '{}'];
    const updraft = buildContainerRunArgs(
      { file: command[0], args: command.slice(1) },
      { image: SANDBOX_IMAGE, name: 'updraft-selftest-abc', user: '1000:1000', mounts: [{ path: workdir, readOnly: false }], workdir },
    );
    expect(probeRunArgs({ name: 'updraft-selftest-abc', image: SANDBOX_IMAGE, user: '1000:1000', workdir, command })).toEqual(updraft);
  });

  it('is enforced unless the launcher says disabled', () => {
    expect(isolationMode({})).toBe('enforced');
    expect(isolationMode({ agentIsolation: 'enforced' })).toBe('enforced');
    expect(isolationMode({ agentIsolation: 'disabled' })).toBe('disabled');
  });
});

// ---------------------------------------------------------------------------
// The self-test, run for real
// ---------------------------------------------------------------------------

let root;
let servers = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'updraft-isolation-test-'));
});

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  servers = [];
  fs.rmSync(root, { recursive: true, force: true });
});

/** A TCP listener on loopback that stands in for a credential endpoint the filter failed to block. */
async function listener() {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return server.address().port;
}

/** A job's state directory as the runner leaves it before run-event: the key, the state, the config. */
function stateDirectory() {
  const stateRoot = path.join(root, 'jobs');
  const stateDir = path.join(stateRoot, 'job-1');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const protectedFiles = ['github-app.pem', 'state.db', 'config.yaml', 'event.json'].map((name) => path.join(stateDir, name));
  for (const file of protectedFiles) fs.writeFileSync(file, `secret ${path.basename(file)}\n`, { mode: 0o600 });
  return { stateRoot, stateDir, protectedFiles };
}

/**
 * A "runtime" that is not a sandbox: it skips the docker options and runs the command on the
 * host, as the caller. What the self-test must catch, whatever else is configured.
 */
function passthroughRuntime() {
  const file = path.join(root, 'passthrough-runtime.mjs');
  fs.writeFileSync(
    file,
    `#!${process.execPath}
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] !== 'run') process.exit(0);
const at = args.indexOf('${SANDBOX_IMAGE}');
const done = spawnSync(args[at + 1], args.slice(at + 2), { stdio: 'inherit', env: process.env });
process.exit(done.status ?? 1);
`,
    { mode: 0o755 },
  );
  return file;
}

const okFilter = { install: () => ({ ok: true }), check: () => ({ ok: true, problems: [] }), describe: () => 'stand-in' };

function isolationDeps({ runtime, endpoints = [], filter = okFilter, runtimeEnv }) {
  const { stateRoot, stateDir, protectedFiles } = stateDirectory();
  return {
    target: { stateDir, protectedFiles },
    deps: {
      stateRoot,
      jobUser: { home: path.join(root, 'home'), name: 'updraft' },
      baseEnv: { PATH: process.env.PATH },
      log: () => {},
      isolation: { runtime, image: SANDBOX_IMAGE, nodePath: process.execPath, endpoints, filter, runtimeEnv, connectTimeoutMs: 500, allowRunnerUser: true },
    },
  };
}

describe.runIf(onLinuxLikeHost)('the self-test, against a runtime that is not a sandbox', () => {
  it('fails: the key, the state and the job directory are all within reach', async () => {
    const { target, deps } = isolationDeps({ runtime: passthroughRuntime() });
    const tested = await selfTest(target, deps);
    expect(tested.ok).toBe(false);
    for (const file of target.protectedFiles) {
      expect(tested.problems).toContain(`${file} can be read inside the sandbox`);
      expect(tested.problems).toContain(`${file} can be opened for writing inside the sandbox`);
    }
    expect(tested.problems.some((p) => p.startsWith('the probe created ') && p.endsWith("in the job's state directory"))).toBe(true);
    expect(tested.problems.some((p) => p.startsWith("the job's state directory is visible inside the sandbox"))).toBe(true);
    // Seen through /proc, so only where there is one.
    if (process.platform === 'linux') expect(tested.problems.some((p) => p.startsWith("the runner's process is visible inside the sandbox"))).toBe(true);
    // Nothing the probe tried changed the files themselves.
    for (const file of target.protectedFiles) expect(fs.readFileSync(file, 'utf8')).toBe(`secret ${path.basename(file)}\n`);
  });

  it('fails when the packet filter is not in place, before anything else is believed', async () => {
    const filter = { ...okFilter, check: () => ({ ok: false, problems: ['no rule drops non-root traffic to 169.254.169.254'] }) };
    const { target, deps } = isolationDeps({ runtime: passthroughRuntime(), filter });
    const tested = await selfTest(target, deps);
    expect(tested.problems[0]).toBe('no rule drops non-root traffic to 169.254.169.254');
    expect(tested.checks.packetFilter).toBe('missing');
  });
});

describe.runIf(onLinuxLikeHost && sandbox.usable)('the self-test, against the sandbox runtime', { timeout: 60_000 }, () => {
  it('passes when the boundary holds', async () => {
    const runtime = installRuntime(path.join(root, 'runtime'));
    const { target, deps } = isolationDeps({ runtime: runtime.path });
    const tested = await selfTest(target, deps);
    expect(tested.problems).toEqual([]);
    expect(tested.ok).toBe(true);
    expect(tested.checks.sandboxStarts).toBe(true);
    for (const file of tested.checks.inside.protected) expect(file).toMatchObject({ exists: false });
    // Only the bound directory is there; the key, the state and the config are not.
    expect(tested.checks.inside.listing).toEqual([expect.stringMatching(/^isolation-selftest-/)]);
    expect(fs.readdirSync(target.stateDir).sort()).toEqual(['config.yaml', 'event.json', 'github-app.pem', 'state.db']);
  });

  it('fails when the sandbox is configured to show the state directory', async () => {
    const { target, deps } = isolationDeps({ runtime: 'set below' });
    deps.isolation.runtime = installRuntime(path.join(root, 'runtime'), { readOnlyBinds: [target.stateDir] }).path;
    const tested = await selfTest(target, deps);
    expect(tested.ok).toBe(false);
    expect(tested.problems).toContain(`${path.join(target.stateDir, 'github-app.pem')} can be read inside the sandbox`);
    expect(tested.problems.some((p) => p.startsWith("the job's state directory is visible inside the sandbox"))).toBe(true);
  });

  it('fails when a credential endpoint answers, inside the sandbox and as the plain job user', async () => {
    // The stand-in filter says all is well; the endpoint answers anyway. The probe must notice.
    const port = await listener();
    const runtime = installRuntime(path.join(root, 'runtime'));
    const { target, deps } = isolationDeps({ runtime: runtime.path, endpoints: [{ address: '127.0.0.1', family: 4, port }] });
    const tested = await selfTest(target, deps);
    expect(tested.ok).toBe(false);
    expect(tested.problems).toEqual([`127.0.0.1 port ${port} accepts a connection inside the sandbox`, `127.0.0.1 port ${port} accepts a connection as the job user`]);
  });

  it('fails when the runtime cannot start a command', async () => {
    const { target, deps } = isolationDeps({ runtime: path.join(root, 'no-such-runtime') });
    const tested = await selfTest(target, deps);
    expect(tested.ok).toBe(false);
    expect(tested.problems[0]).toMatch(/^the sandbox runtime could not run a command as the job user/);
  });
});

if (onLinuxLikeHost && !sandbox.usable) {
  describe('the self-test, against the sandbox runtime', () => {
    it.skip(`skipped: ${sandbox.reason}`, () => {});
  });
}

// ---------------------------------------------------------------------------
// runJob with isolation enforced
// ---------------------------------------------------------------------------

const KEY_ARN = 'arn:aws:secretsmanager:eu-test-1:000000000000:secret:key';
const ENV_ARN = 'arn:aws:secretsmanager:eu-test-1:000000000000:secret:env';
const START = Date.parse('2026-01-02T03:04:05.000Z');

function jobHarness({ isolation, objects = {}, agentIsolation } = {}) {
  const recordFile = path.join(root, 'record.json');
  const calls = [];
  const logs = [];
  const store = {
    'events/delivery-1/event.json': '{"action":"labeled","issue":{"number":12}}',
    'config/config.yaml': 'version: 1\n',
    'config/prompts/implement-issue.md': '# Implement the issue\n',
    ...objects,
  };
  const request = {
    microvmId: 'mvm-01234567-abcd-ef01-2345-6789abcdef01',
    payload: {
      version: 1,
      deliveryId: 'delivery-1',
      eventName: 'issues',
      region: 'eu-test-1',
      bucket: 'job-bucket',
      eventKey: 'events/delivery-1/event.json',
      resultKeyPrefix: 'results/delivery-1/',
      configPrefix: 'config/',
      secrets: { githubAppPrivateKey: KEY_ARN, agentEnv: ENV_ARN },
      maximumDurationSeconds: 7200,
      watchdogReserveSeconds: 300,
      launchedAt: new Date(START).toISOString(),
      dedupeTable: 'deliveries',
      ...(agentIsolation ? { agentIsolation } : {}),
    },
  };
  const deps = {
    s3Get: async (bucket, key) => {
      if (!(key in store)) throw new Error(`NoSuchKey: ${key}`);
      return Buffer.from(store[key]);
    },
    s3List: async (bucket, prefix) => Object.keys(store).filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: store[key].length })),
    s3Put: async (bucket, key, body) => calls.push(['s3Put', key, body]),
    getSecret: async (id) => (id === KEY_ARN ? '-----BEGIN RSA PRIVATE KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----' : JSON.stringify({ ANTHROPIC_API_KEY: 'sk-test', FAKE_UPDRAFT_RECORD: recordFile })),
    terminate: async () => calls.push(['terminate']),
    releaseDelivery: async () => calls.push(['releaseDelivery']),
    stateRoot: path.join(root, 'jobs'),
    updraftCommand: [process.execPath, FAKE_UPDRAFT],
    jobUser: { home: path.join(root, 'home'), name: 'updraft' },
    baseEnv: { PATH: process.env.PATH, AWS_SECRET_ACCESS_KEY: 'runner-secret' },
    log: (message) => logs.push(message),
    logStream: { write: () => {} },
    onStop: () => {},
    now: () => START + 1000,
    killGraceMs: 300,
    retryDelayMs: 1,
    ...(isolation === undefined ? {} : { isolation }),
  };
  const result = () => {
    const put = calls.find(([name, key]) => name === 's3Put' && key.endsWith('result.json'));
    return put ? JSON.parse(put[2]) : undefined;
  };
  return { request, deps, calls, logs, result, ranUpdraft: () => fs.existsSync(recordFile) };
}

describe.runIf(onLinuxLikeHost)('runJob with AgentIsolation enforced', { timeout: 60_000 }, () => {
  const isolationFor = (runtime) => ({ runtime, image: SANDBOX_IMAGE, nodePath: process.execPath, endpoints: [], filter: okFilter, connectTimeoutMs: 500, allowRunnerUser: true });
  /** What `updraft validate --json` prints for a config whose one agent runs in `runtime`. */
  const validated = (runtime) => ({ 'config/fake-validate.json': JSON.stringify({ ok: true, errors: [], warnings: [], config: { agents: { claude: contained({ runtime }) } } }) });

  it('starts nothing when the runner has no sandbox runtime, and releases the delivery', async () => {
    const h = jobHarness();
    const doc = await runJob(h.request, h.deps);
    expect(doc).toMatchObject({ outcome: 'runner_error', errorCode: 'isolation-not-enforced', isolation: { mode: 'enforced', enforced: false } });
    expect(doc.error).toMatch(/started without the sandbox runtime/);
    expect(h.ranUpdraft()).toBe(false);
    expect(h.calls.map(([name]) => name)).toContain('releaseDelivery');
    expect(h.calls.map(([name]) => name)).toContain('terminate');
    expect(h.logs.some((line) => line.startsWith('ISOLATION NOT ENFORCED: the job was NOT started.'))).toBe(true);
  });

  it('starts nothing when the packet filter cannot be installed', async () => {
    const filter = { ...okFilter, install: () => ({ ok: false, problem: 'the packet filter could not be installed: nft: not found' }) };
    const h = jobHarness({ isolation: { ...isolationFor(SANDBOX_RUNTIME), filter } });
    const doc = await runJob(h.request, h.deps);
    expect(doc).toMatchObject({ outcome: 'runner_error', errorCode: 'isolation-not-enforced', isolation: { failedStep: 'packet filter', problems: ['the packet filter could not be installed: nft: not found'] } });
    expect(h.ranUpdraft()).toBe(false);
  });

  it('starts nothing when an agent of the config would run outside the sandbox', async () => {
    const report = { ok: true, errors: [], warnings: [], config: { agents: { claude: { enabled: true } } } };
    const h = jobHarness({ isolation: isolationFor(passthroughRuntime()), objects: { 'config/fake-validate.json': JSON.stringify(report) } });
    const doc = await runJob(h.request, h.deps);
    expect(doc).toMatchObject({ outcome: 'runner_error', errorCode: 'isolation-not-enforced', isolation: { failedStep: 'config' } });
    expect(doc.isolation.problems[0]).toMatch(/^agents\.claude has no container block/);
    expect(h.ranUpdraft()).toBe(false);
    expect(h.calls.map(([name]) => name)).toContain('releaseDelivery');
  });

  it('starts nothing when the self-test reaches the key', async () => {
    const runtime = passthroughRuntime();
    const h = jobHarness({ isolation: isolationFor(runtime), objects: validated(runtime) });
    const doc = await runJob(h.request, h.deps);
    expect(doc).toMatchObject({ outcome: 'runner_error', errorCode: 'isolation-not-enforced', isolation: { failedStep: 'self-test', enforced: false } });
    expect(doc.isolation.problems.some((p) => /github-app\.pem can be read inside the sandbox$/.test(p))).toBe(true);
    expect(h.ranUpdraft()).toBe(false);
  });

  it.runIf(sandbox.usable)('runs the job once the self-test has passed in the sandbox runtime', async () => {
    const runtime = installRuntime(path.join(root, 'runtime'));
    const h = jobHarness({ isolation: isolationFor(runtime.path), objects: validated(runtime.path) });
    const doc = await runJob(h.request, h.deps);
    expect(doc.isolation).toMatchObject({ mode: 'enforced', enforced: true, warning: null });
    expect(doc.isolation.checks.config).toEqual({ agents: ['claude'], runtime: runtime.path });
    expect(doc.errorCode).toBeNull();
    expect(doc.outcome).toBe('succeeded');
    expect(h.ranUpdraft()).toBe(true);
  });

  it('with AgentIsolation disabled, runs the job as before and says what that gives up', async () => {
    const h = jobHarness({ agentIsolation: 'disabled' });
    const doc = await runJob(h.request, h.deps);
    expect(doc.outcome).toBe('succeeded');
    expect(doc.isolation).toMatchObject({ mode: 'disabled', enforced: false, warning: expect.stringMatching(/^AgentIsolation is disabled: agents and verify commands run as the job user/) });
    expect(h.logs.some((line) => line.startsWith('WARNING: AgentIsolation is disabled'))).toBe(true);
    expect(h.ranUpdraft()).toBe(true);
  });
});

it('IsolationError carries the step and the problems', () => {
  const error = new IsolationError('config', ['a', 'b']);
  expect(error).toMatchObject({ step: 'config', problems: ['a', 'b'], message: 'ISOLATION NOT ENFORCED (config): a; b' });
});

// ---------------------------------------------------------------------------
// The image check (run-hook payload version 3): the build's proof before it activates a version
// ---------------------------------------------------------------------------

describe('checkImageIsolation', { timeout: 60_000 }, () => {
  const checkDeps = (isolation) => {
    const logs = [];
    const stateRoot = path.join(root, 'jobs');
    fs.mkdirSync(stateRoot, { recursive: true });
    const removed = [];
    const filter = { ...okFilter, ...(isolation.filter ?? {}), remove: () => removed.push('remove') };
    return {
      deps: { isolation: { ...isolation, filter }, stateRoot, jobUser: { home: path.join(root, 'home'), name: 'updraft' }, baseEnv: { PATH: process.env.PATH }, log: (line) => logs.push(line) },
      logs,
      removed,
      stateRoot,
    };
  };
  const base = (runtime) => ({ runtime, image: SANDBOX_IMAGE, nodePath: process.execPath, endpoints: [], connectTimeoutMs: 500, allowRunnerUser: true });
  const logged = (logs) => {
    const line = logs.find((l) => l.startsWith(ISOLATION_CHECK_MARKER));
    return line ? JSON.parse(line.slice(ISOLATION_CHECK_MARKER.length)) : undefined;
  };

  it('fails at the packet filter, logs the reasons, and leaves nothing behind', async () => {
    const h = checkDeps({ ...base(SANDBOX_RUNTIME), filter: { install: () => ({ ok: false, problem: `the packet filter could not be installed: nft exited 1 (${NO_NET_ADMIN_PROBLEM})` }) } });
    const report = await checkImageIsolation(h.deps);
    expect(report).toMatchObject({ ok: false, failedStep: 'packet filter', problems: [expect.stringContaining('CAP_NET_ADMIN')] });
    expect(logged(h.logs)).toEqual(report);
    expect(h.removed).toEqual(['remove']);
    expect(fs.readdirSync(h.stateRoot)).toEqual([]);
  });

  it('fails when the runner was started without the sandbox runtime', async () => {
    const logs = [];
    const report = await checkImageIsolation({ stateRoot: root, jobUser: { home: root, name: 'updraft' }, log: (line) => logs.push(line) });
    expect(report).toMatchObject({ ok: false, failedStep: 'setup' });
    expect(logged(logs)).toEqual(report);
  });

  it.runIf(onLinuxLikeHost)('fails the self-test when the runtime is not a sandbox: the stand-in files can be read', async () => {
    const h = checkDeps(base(passthroughRuntime()));
    const report = await checkImageIsolation(h.deps);
    expect(report).toMatchObject({ ok: false, failedStep: 'self-test' });
    expect(report.problems.some((p) => /app-token\.json can be read inside the sandbox$/.test(p))).toBe(true);
    expect(fs.readdirSync(h.stateRoot)).toEqual([]);
  });

  it.runIf(sandbox.usable)('passes in the sandbox runtime', async () => {
    const runtime = installRuntime(path.join(root, 'runtime'));
    const h = checkDeps(base(runtime.path));
    const report = await checkImageIsolation(h.deps);
    expect(report).toMatchObject({ ok: true, failedStep: null, problems: [] });
    expect(report.checks.selfTest).toMatchObject({ sandboxStarts: true, packetFilter: 'in place' });
    expect(logged(h.logs)).toEqual(report);
    expect(fs.readdirSync(h.stateRoot)).toEqual([]);
  });
});
