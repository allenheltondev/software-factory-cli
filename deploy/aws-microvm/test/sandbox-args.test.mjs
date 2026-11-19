// The sandbox runtime's translation from the docker command lines Updraft produces to a
// bubblewrap command line. Pure logic: runs on every OS, starts nothing. The docker side is
// built with the real functions of src/worker/container.ts, so a flag added there that the
// runtime does not handle fails here.
import { describe, expect, it } from 'vitest';
import { CONTAINER_HOME, RUN_LABEL, buildContainerRunArgs, containerName, gitMounts } from '../../../src/worker/container.ts';
import {
  ETC_DENY,
  EXIT_RUNTIME_FAILED,
  IMAGE_NAME,
  SandboxError,
  buildBwrapArgs,
  checkUser,
  etcArgs,
  imageId,
  main,
  parseConfig,
  parseMountSpec,
  parseRunArgs,
  parseTmpfsSpec,
  sandboxEnv,
} from '../image/sandbox/updraft-sandbox.mjs';

const WORKTREE = '/var/lib/updraft-jobs/job-abc/worktrees/42/job_1';
const COMMON = '/var/lib/updraft-jobs/job-abc/clones/widgets/.git';
const LAYOUT = { pointer: `${WORKTREE}/.git`, adminDir: `${COMMON}/worktrees/job_1`, commonDir: COMMON };
const everything = () => true;

/** The `run` arguments Updraft builds for an agent in a worktree, as live.ts does. */
function agentArgs(overrides = {}) {
  return buildContainerRunArgs(
    { file: 'claude', args: ['-p', '--output-format', 'stream-json'] },
    {
      image: IMAGE_NAME,
      name: containerName('run_01'),
      mounts: gitMounts(WORKTREE, LAYOUT, everything),
      workdir: WORKTREE,
      user: '1000:1000',
      envNames: ['ANTHROPIC_API_KEY', 'GIT_AUTHOR_NAME'],
      runLabel: 'run_01',
      ...overrides,
    },
  );
}

/** A host as the image is expected to look: merged /usr, a few /etc entries. */
function host(overrides = {}) {
  const config = parseConfig(JSON.stringify({ readOnlyBinds: ['/opt/ms-playwright'], env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/ms-playwright' } }));
  return {
    uid: 1000,
    gid: 1000,
    env: { ANTHROPIC_API_KEY: 'sk-ant-secret', GIT_AUTHOR_NAME: 'Agent', AWS_SECRET_ACCESS_KEY: 'never', UPDRAFT_HOME: '/var/lib/updraft-jobs/job-abc', PATH: '/caller/bin' },
    config,
    layout: {
      system: [
        { path: '/usr', type: 'dir' },
        { path: '/bin', type: 'symlink', target: 'usr/bin' },
        { path: '/lib64', type: 'symlink', target: 'usr/lib64' },
      ],
      etc: [
        { name: 'passwd', type: 'file', mode: 0o100644 },
        { name: 'shadow', type: 'file', mode: 0o100000 },
        { name: 'sudoers', type: 'file', mode: 0o100440 },
        { name: 'ssl', type: 'dir', mode: 0o40755 },
        { name: 'resolv.conf', type: 'symlink', target: '../run/systemd/resolve/stub-resolv.conf', resolved: '/run/systemd/resolve/stub-resolv.conf' },
      ],
      sys: ['/sys/devices/system/cpu'],
      readOnlyBinds: ['/opt/ms-playwright'],
    },
    statusFd: 3,
    ...overrides,
  };
}

const pairs = (args, flag) => args.flatMap((a, i) => (a === flag ? [[args[i + 1], args[i + 2]]] : []));
const after = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

describe('updraft-sandbox: parsing the run arguments Updraft produces', () => {
  it('understands every argument of an agent run', () => {
    const argv = agentArgs();
    expect(argv[0]).toBe('run');
    const run = parseRunArgs(argv.slice(1));
    expect(run).toMatchObject({
      remove: true,
      interactive: true,
      name: 'updraft-run_01',
      labels: { [RUN_LABEL]: 'run_01' },
      user: '1000:1000',
      workdir: WORKTREE,
      image: IMAGE_NAME,
      command: ['claude', '-p', '--output-format', 'stream-json'],
      tmpfs: [{ path: CONTAINER_HOME, mode: '1777' }],
      env: [{ name: 'HOME', value: CONTAINER_HOME }, { name: 'ANTHROPIC_API_KEY' }, { name: 'GIT_AUTHOR_NAME' }],
    });
    // Every mount of the plan, in order, each at its own path with its read-only flag.
    const plan = gitMounts(WORKTREE, LAYOUT, everything);
    expect(run.mounts).toEqual(plan.map((m) => ({ source: m.path, target: m.path, readOnly: m.readOnly })));
    expect(run.mounts.length).toBeGreaterThan(8);
  });

  it('understands a reviewer run, a verify command and the doctor check', () => {
    const reviewer = parseRunArgs(agentArgs({ mounts: gitMounts(WORKTREE, LAYOUT, everything, [], true) }).slice(1));
    expect(reviewer.mounts.find((m) => m.source === COMMON)).toMatchObject({ readOnly: true });
    expect(reviewer.mounts.some((m) => m.source === `${COMMON}/objects`)).toBe(false);

    // live.ts: a verify command runs through /bin/sh -c, with no variable passed by name.
    const verify = parseRunArgs(
      buildContainerRunArgs(
        { file: '/bin/sh', args: ['-c', 'npm ci && npm test'] },
        { image: IMAGE_NAME, name: containerName('run_01', 'verify-1'), mounts: gitMounts(WORKTREE, LAYOUT, everything), workdir: WORKTREE, user: '1000:1000', runLabel: 'run_01' },
      ).slice(1),
    );
    expect(verify.name).toBe('updraft-run_01-verify-1');
    expect(verify.env).toEqual([{ name: 'HOME', value: CONTAINER_HOME }]);
    expect(verify.command).toEqual(['/bin/sh', '-c', 'npm ci && npm test']);

    // doctor-container.ts: `<cli> --version`, no mounts, no network.
    const doctor = parseRunArgs(buildContainerRunArgs({ file: 'claude', args: ['--version'] }, { image: IMAGE_NAME, name: 'updraft-doctor-1-claude', mounts: [], user: '1000:1000', network: 'none' }).slice(1));
    expect(doctor).toMatchObject({ network: 'none', mounts: [], workdir: undefined });
  });

  it('refuses what it cannot honour instead of ignoring it', () => {
    const base = ['--rm', '--name', 'x', IMAGE_NAME, 'true'];
    const refused = (extra, pattern) => expect(() => parseRunArgs([...extra, ...base])).toThrow(pattern);
    for (const flag of ['--privileged', '--cap-add', '-v', '--volume', '-t', '--tty', '-d', '--pid', '--ipc', '--userns', '--device', '--volumes-from', '--env-file', '--entrypoint', '--memory', '--init', '-p']) {
      refused([flag, 'x'], /unsupported option for run/);
    }
    refused(['--pull', 'always'], /--pull always/);
    refused(['--pull=missing'], /--pull missing/);
    refused(['--cap-drop', 'NET_RAW'], /only "ALL"/);
    refused(['--security-opt', 'seccomp=unconfined'], /--security-opt/);
    refused(['--security-opt', 'label=disable'], /--security-opt/);
    refused(['--network', 'bridge'], /--network bridge/);
    refused(['--network', 'container:other'], /--network/);
    refused(['--tmpfs', '/scratch:noexec'], /"noexec" is not supported/);
    refused(['--tmpfs', '/scratch:size=1g'], /not supported/);
    refused(['--tmpfs', '/etc/x'], /sandbox's own/);
    refused(['--mount', 'type=volume,source=v,target=/x'], /only type=bind/);
    refused(['--mount', 'type=bind,source=/a,target=/b,bind-propagation=shared'], /"bind-propagation" is not supported/);
    refused(['--mount', 'type=bind,source=/,target=/host'], /may not bind \//);
    refused(['--mount', 'type=bind,source=/a,target=/'], /may not target \//);
    refused(['--mount', 'type=bind,source=/a,target=/proc/1'], /sandbox's own/);
    refused(['--mount', 'type=bind,source=/a,target=/usr/bin'], /sandbox's own/);
    refused(['--mount', 'type=bind,source=/a/../b,target=/b'], /not a normalized path/);
    refused(['--mount', 'type=bind,source=relative,target=/b'], /not an absolute path/);
    refused(['--mount', 'type=bind,target=/b'], /source and target are required/);
    refused(['-e', '1BAD=x'], /not an environment variable name/);
    refused(['--workdir', 'relative'], /not an absolute path/);
    // A sandbox is stopped and removed by name, and nothing of it is kept.
    expect(() => parseRunArgs(['--rm', IMAGE_NAME, 'true'])).toThrow(/needs --name/);
    expect(() => parseRunArgs(['--name', 'x', IMAGE_NAME, 'true'])).toThrow(/needs --rm/);
    expect(() => parseRunArgs(['--rm', '--name', '../x', IMAGE_NAME, 'true'])).toThrow(/not a container name/);
    expect(() => parseRunArgs(['--rm', '--name', 'x', IMAGE_NAME])).toThrow(/an image and a command/);
    for (const error of [() => parseRunArgs(['--privileged', ...base])]) expect(error).toThrow(SandboxError);
  });

  it('accepts the harmless spellings, and stops parsing options at the image', () => {
    const run = parseRunArgs(['--rm', '-i', '--name=n', '--pull=never', '--cap-drop=all', '--security-opt=no-new-privileges', '--network=host', '-w', '/w', '-e', 'A=b=c', '--env', 'B', IMAGE_NAME, 'cmd', '--privileged', '-v', '/:/host']);
    expect(run).toMatchObject({ name: 'n', network: 'host', workdir: '/w', command: ['cmd', '--privileged', '-v', '/:/host'], env: [{ name: 'A', value: 'b=c' }, { name: 'B' }] });
    expect(parseMountSpec('type=bind,src=/a,dst=/b,ro')).toEqual({ source: '/a', target: '/b', readOnly: true });
    expect(parseMountSpec('type=bind,source=/a,destination=/b,readonly=false')).toEqual({ source: '/a', target: '/b', readOnly: false });
    expect(parseTmpfsSpec('/scratch')).toEqual({ path: '/scratch', mode: undefined });
    expect(parseTmpfsSpec('/scratch:rw,exec,nosuid,nodev,mode=0700')).toEqual({ path: '/scratch', mode: '0700' });
  });
});

describe('updraft-sandbox: the bwrap command line', () => {
  it('builds the sandbox from an allowlist and exactly the binds asked for', () => {
    const run = parseRunArgs(agentArgs().slice(1));
    const { args, env } = buildBwrapArgs(run, host());

    // Namespaces and privileges. The network is not unshared.
    for (const flag of ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session']) expect(args).toContain(flag);
    expect(args).not.toContain('--unshare-net');
    expect(args).not.toContain('--unshare-all');
    expect(pairs(args, '--cap-drop').map(([cap]) => cap)).toEqual(['ALL']);
    expect(after(args, '--json-status-fd')).toEqual(['3']);
    for (const widening of ['--cap-add', '--dev-bind', '--share-net', '--uid', '--gid']) expect(args).not.toContain(widening);

    // Never the host's root, home directories or /var: only these.
    const ro = pairs(args, '--ro-bind');
    const rw = pairs(args, '--bind');
    const plan = gitMounts(WORKTREE, LAYOUT, everything);
    expect(ro).toEqual([
      ['/usr', '/usr'],
      ['/etc/passwd', '/etc/passwd'],
      ['/etc/ssl', '/etc/ssl'],
      ['/sys/devices/system/cpu', '/sys/devices/system/cpu'],
      ['/opt/ms-playwright', '/opt/ms-playwright'],
      ...plan.filter((m) => m.readOnly).map((m) => [m.path, m.path]),
    ]);
    expect(rw).toEqual(plan.filter((m) => !m.readOnly).map((m) => [m.path, m.path]));
    expect(pairs(args, '--ro-bind-try')).toEqual([['/run/systemd/resolve/stub-resolv.conf', '/etc/resolv.conf']]);
    expect(pairs(args, '--symlink')).toEqual([['usr/bin', '/bin'], ['usr/lib64', '/lib64']]);
    for (const [source] of [...ro, ...rw]) {
      expect(source).not.toBe('/');
      expect(['/var/lib/updraft-jobs/job-abc', '/var/lib/updraft-jobs', '/root', '/home', '/opt/updraft', '/etc']).not.toContain(source);
    }
    // The binds keep their order (a parent before what is mounted over it), after the system view.
    const order = args.flatMap((a, i) => (a === '--bind' || a === '--ro-bind' ? [args[i + 1]] : [])).filter((p) => p.startsWith('/var/lib/updraft-jobs/'));
    expect(order).toEqual(plan.map((m) => m.path));

    expect(after(args, '--proc')).toEqual(['/proc']);
    expect(after(args, '--dev')).toEqual(['/dev']);
    expect(after(args, '--tmpfs')).toEqual(['/tmp', '/run', '/var/tmp', CONTAINER_HOME]);
    expect(after(args, '--remount-ro')).toEqual(['/']);
    expect(after(args, '--chdir')).toEqual([WORKTREE]);
    expect(args.slice(args.indexOf('--'))).toEqual(['--', 'claude', '-p', '--output-format', 'stream-json']);

    // The environment: what -e named, the config file's settings, PATH and LANG. Nothing else.
    expect(env).toEqual({
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8',
      PLAYWRIGHT_BROWSERS_PATH: '/opt/ms-playwright',
      HOME: CONTAINER_HOME,
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      GIT_AUTHOR_NAME: 'Agent',
    });
    // No value on the command line.
    expect(args.join('\n')).not.toContain('sk-ant-secret');
  });

  it('gives a verify command none of the caller\'s variables, and --network none an empty network', () => {
    const verify = parseRunArgs(buildContainerRunArgs({ file: '/bin/sh', args: ['-c', 'npm test'] }, { image: IMAGE_NAME, name: 'updraft-r-verify-1', mounts: [], user: '1000:1000' }).slice(1));
    expect(buildBwrapArgs(verify, host()).env).toEqual({ PATH: expect.any(String), LANG: 'C.UTF-8', PLAYWRIGHT_BROWSERS_PATH: '/opt/ms-playwright', HOME: CONTAINER_HOME });
    const offline = parseRunArgs(buildContainerRunArgs({ file: 'true', args: [] }, { image: IMAGE_NAME, name: 'n', mounts: [], network: 'none' }).slice(1));
    expect(buildBwrapArgs(offline, host()).args).toContain('--unshare-net');
    expect(after(buildBwrapArgs(offline, host()).args, '--chdir')).toEqual(['/']);
  });

  it('refuses another image and another user', () => {
    const other = parseRunArgs(agentArgs({ image: 'my-org/claude-runner:latest' }).slice(1));
    expect(() => buildBwrapArgs(other, host())).toThrow(/no such image: my-org\/claude-runner:latest/);
    const root = parseRunArgs(agentArgs({ user: '0:0' }).slice(1));
    expect(() => buildBwrapArgs(root, host())).toThrow(/can only run as its caller \(1000:1000\)/);
    expect(() => checkUser('updraft', 1000, 1000)).toThrow(/numeric/);
    expect(() => checkUser('1000:5', 1000, 1000)).toThrow(/caller/);
    expect(checkUser('1000', 1000, 1000)).toBeUndefined();
    expect(checkUser(undefined, 1000, 1000)).toBeUndefined();
  });

  it('shows /etc without what is secret or private to root', () => {
    const args = etcArgs([
      { name: 'passwd', type: 'file', mode: 0o100644 },
      { name: 'shadow', type: 'file', mode: 0o100644 }, // denied by name even when readable
      { name: 'gshadow-', type: 'file', mode: 0o100000 },
      { name: 'sudoers.d', type: 'dir', mode: 0o40755 },
      { name: 'ssh', type: 'dir', mode: 0o40755 },
      { name: 'security', type: 'dir', mode: 0o40755 },
      { name: 'updraft-sandbox.json', type: 'file', mode: 0o100644 },
      { name: 'private.key', type: 'file', mode: 0o100600 }, // not readable by others: absent
      { name: 'root-only', type: 'dir', mode: 0o40700 },
      { name: 'pki', type: 'dir', mode: 0o40755 },
      { name: 'mtab', type: 'symlink', target: '../proc/self/mounts', resolved: '/proc/42/mounts' },
      { name: 'localtime', type: 'symlink', target: '/usr/share/zoneinfo/UTC', resolved: '/usr/share/zoneinfo/UTC' },
      { name: 'to-shadow', type: 'symlink', target: 'shadow', resolved: '/etc/shadow' },
      { name: 'to-home', type: 'symlink', target: '/home/someone/.netrc', resolved: '/home/someone/.netrc' },
      { name: 'dangling', type: 'symlink', target: 'nowhere', resolved: null },
    ]);
    expect(pairs(args, '--ro-bind')).toEqual([['/etc/passwd', '/etc/passwd'], ['/etc/pki', '/etc/pki']]);
    expect(pairs(args, '--symlink')).toEqual([['../proc/self/mounts', '/etc/mtab']]);
    expect(pairs(args, '--ro-bind-try')).toEqual([['/usr/share/zoneinfo/UTC', '/etc/localtime']]);
    for (const name of ['shadow', 'gshadow', 'sudoers', 'sudoers.d', 'ssh']) expect(ETC_DENY.has(name)).toBe(true);
  });

  it('takes -e values from the caller only by name, and lets -e win over the config', () => {
    const run = parseRunArgs(['--rm', '--name', 'n', '-e', 'A', '-e', 'MISSING', '-e', 'B=explicit', '-e', 'PATH=/custom', IMAGE_NAME, 'true']);
    expect(sandboxEnv(run, { A: 'from-caller', B: 'ignored', SECRET: 'x' }, parseConfig('{"env":{"B":"config","C":"config"}}'))).toEqual({ PATH: '/custom', LANG: 'C.UTF-8', A: 'from-caller', B: 'explicit', C: 'config' });
  });

  it('validates its config file', () => {
    expect(parseConfig('{}')).toMatchObject({ image: IMAGE_NAME, readOnlyBinds: [], env: {} });
    expect(() => parseConfig('nope')).toThrow(/not JSON/);
    expect(() => parseConfig('{"binds":["/x"]}')).toThrow(/unknown key "binds"/);
    expect(() => parseConfig('{"readOnlyBinds":["/"]}')).toThrow(/may not contain \//);
    expect(() => parseConfig('{"readOnlyBinds":["/etc/shadow"]}')).toThrow(/may not contain \/etc\/shadow/);
    expect(() => parseConfig('{"readOnlyBinds":["relative"]}')).toThrow(/not an absolute path/);
    expect(() => parseConfig('{"env":{"A":1}}')).toThrow(/env\.A/);
    expect(() => parseConfig('{"bwrap":"bwrap"}')).toThrow(/absolute path/);
  });

  it('answers for one image name only, with a stable id', () => {
    expect(imageId(IMAGE_NAME)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(imageId(IMAGE_NAME)).toBe(imageId(IMAGE_NAME));
    expect(IMAGE_NAME).toBe('microvm');
  });

  it('exits 125 for an unknown command or option, before touching the system', async () => {
    const write = process.stderr.write;
    let said = '';
    process.stderr.write = (chunk) => {
      said += chunk;
      return true;
    };
    try {
      expect(await main(['exec', 'x'])).toBe(EXIT_RUNTIME_FAILED);
      expect(await main(['run', '--rm', '--name', 'x', '--privileged', IMAGE_NAME, 'true'])).toBe(EXIT_RUNTIME_FAILED);
      expect(await main(['image', 'pull', 'x'])).toBe(EXIT_RUNTIME_FAILED);
      expect(await main(['stop', '--signal', 'KILL', 'x'])).toBe(EXIT_RUNTIME_FAILED);
      expect(await main(['rm', '-v', 'x'])).toBe(EXIT_RUNTIME_FAILED);
    } finally {
      process.stderr.write = write;
    }
    expect(said).toMatch(/unsupported command: exec/);
    expect(said).toMatch(/unsupported option for run: --privileged/);
  });
});
