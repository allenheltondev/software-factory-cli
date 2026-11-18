// The container boundary's pure parts: the runtime argv and the mount list. The executor's use
// of them, against a fake runtime, is in live-container.test.ts.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitFixture, type GitFixture } from '../../test/git-fixtures.js';
import { containerSchema } from '../config/schema.js';
import {
  buildContainerRunArgs,
  CONTAINER_HOME,
  containerLaunch,
  containerName,
  containInvocation,
  ContainerSetupError,
  gitMounts,
  readWorktreeLayout,
  resolveRuntime,
  worktreeMounts,
  type ContainerMount,
  type ContainerRunOptions,
} from './container.js';

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

const WT = '/data/worktrees/42/job_1';
const COMMON = '/src/widgets/.git';
const ADMIN = `${COMMON}/worktrees/job_1`;
const LAYOUT = { pointer: `${WT}/.git`, adminDir: ADMIN, commonDir: COMMON };
const everything = () => true;

const base: ContainerRunOptions = {
  image: 'my-org/claude-runner:latest',
  name: 'updraft-run_abc',
  mounts: gitMounts(WT, LAYOUT, everything),
  workdir: WT,
  user: '1000:1000',
  envNames: ['ANTHROPIC_API_KEY'],
  runLabel: 'run_abc',
};
const AGENT = { file: 'claude', args: ['-p', '--output-format', 'stream-json'] };

/** Values of every occurrence of a flag that takes a value. */
const valuesOf = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []));

describe('containerName', () => {
  it('is derived from the run id alone, so a later worker can name the container without having started it', () => {
    expect(containerName('run_0mabc123deadbeef')).toBe('updraft-run_0mabc123deadbeef');
    expect(containerName('run_1', 'verify')).toBe('updraft-run_1-verify');
  });

  it('only ever contains characters a runtime accepts in a name', () => {
    expect(containerName('run/../x y;rm')).toBe('updraft-run-..-x-y-rm');
  });
});

describe('buildContainerRunArgs', () => {
  it('runs the command in a named, removable container, as the given user, in the worktree', () => {
    const args = buildContainerRunArgs(AGENT, base);
    expect(args.slice(0, 7)).toEqual(['run', '--rm', '-i', '--name', 'updraft-run_abc', '--pull', 'never']);
    expect(valuesOf(args, '--user')).toEqual(['1000:1000']);
    expect(valuesOf(args, '--workdir')).toEqual([WT]);
    expect(valuesOf(args, '--label')).toEqual(['updraft.run=run_abc']);
    // No terminal: output must be exactly what the agent wrote.
    expect(args).not.toContain('-t');
    expect(args).not.toContain('-it');
  });

  it('ends with the image and then the command exactly as given', () => {
    const args = buildContainerRunArgs(AGENT, base);
    const image = args.indexOf('my-org/claude-runner:latest');
    expect(args.slice(image)).toEqual(['my-org/claude-runner:latest', 'claude', '-p', '--output-format', 'stream-json']);
  });

  it('mounts each path at the same path, read-only where asked, in the order given', () => {
    const mounts: ContainerMount[] = [
      { path: '/a/work tree', readOnly: false },
      { path: '/a/work tree/.git', readOnly: true },
    ];
    const args = buildContainerRunArgs(AGENT, { ...base, mounts });
    expect(valuesOf(args, '--mount')).toEqual([
      'type=bind,source=/a/work tree,target=/a/work tree',
      'type=bind,source=/a/work tree/.git,target=/a/work tree/.git,readonly',
    ]);
    expect(args).not.toContain('-v');
    expect(args).not.toContain('--volume');
  });

  it('mounts nothing but what it was given: no home directory, no agent or runtime socket', () => {
    const args = buildContainerRunArgs(AGENT, base);
    const sources = valuesOf(args, '--mount').map((m) => /source=([^,]*)/.exec(m)![1]!);
    expect(sources).toEqual(base.mounts.map((m) => m.path));
    const joined = args.join('\n');
    expect(joined).not.toMatch(/docker\.sock|podman\.sock|SSH_AUTH_SOCK|\.ssh|\.config\/gh|\.gitconfig/);
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('--volumes-from');
  });

  it('passes environment variables by name only, so no value is ever on the command line', () => {
    const args = buildContainerRunArgs(AGENT, { ...base, envNames: ['ANTHROPIC_API_KEY', 'GIT_AUTHOR_NAME', 'ANTHROPIC_API_KEY'] });
    // HOME is the one literal: a path inside the container, not a secret and not the host's.
    expect(valuesOf(args, '-e')).toEqual([`HOME=${CONTAINER_HOME}`, 'ANTHROPIC_API_KEY', 'GIT_AUTHOR_NAME']);
    expect(args).not.toContain('--env-file');
  });

  it('refuses anything that is not a plain variable name, which could smuggle a value or an option', () => {
    for (const bad of ['KEY=value', '--privileged', 'A B', '']) {
      expect(() => buildContainerRunArgs(AGENT, { ...base, envNames: [bad] })).toThrow(ContainerSetupError);
    }
  });

  it('gives an arbitrary uid a writable HOME on a tmpfs', () => {
    const args = buildContainerRunArgs(AGENT, base);
    expect(valuesOf(args, '--tmpfs')).toEqual([`${CONTAINER_HOME}:rw,exec,mode=1777`]);
    expect(base.mounts.some((m) => m.path.startsWith(CONTAINER_HOME))).toBe(false);
  });

  it('drops capabilities and forbids privilege escalation', () => {
    const args = buildContainerRunArgs(AGENT, base);
    expect(valuesOf(args, '--cap-drop')).toEqual(['ALL']);
    expect(valuesOf(args, '--security-opt')).toEqual(['no-new-privileges']);
  });

  it('sets --network only when configured, and puts container.args last before the image', () => {
    expect(buildContainerRunArgs(AGENT, base)).not.toContain('--network');
    const args = buildContainerRunArgs(AGENT, { ...base, network: 'none', extraArgs: ['--memory', '4g'] });
    expect(valuesOf(args, '--network')).toEqual(['none']);
    const image = args.indexOf(base.image);
    expect(args.slice(image - 2, image)).toEqual(['--memory', '4g']);
  });

  it('leaves user, workdir and label out when not given (a check that only runs `--version`)', () => {
    const args = buildContainerRunArgs({ file: 'claude', args: ['--version'] }, { image: 'img', name: 'updraft-doctor-1', mounts: [] });
    for (const flag of ['--user', '--workdir', '--label', '--mount', '--network']) expect(args).not.toContain(flag);
    expect(args.slice(-3)).toEqual(['img', 'claude', '--version']);
  });

  it('refuses a mount path it cannot pass safely, a relative path, an option-like image and a bad name', () => {
    const one = (path: string) => ({ ...base, mounts: [{ path, readOnly: false }] });
    expect(() => buildContainerRunArgs(AGENT, one('/a,readonly=false'))).toThrow(/comma/);
    expect(() => buildContainerRunArgs(AGENT, one('/a"b'))).toThrow(ContainerSetupError);
    expect(() => buildContainerRunArgs(AGENT, one('relative/path'))).toThrow(/not an absolute path/);
    expect(() => buildContainerRunArgs(AGENT, { ...base, image: '--privileged' })).toThrow(/not an image reference/);
    expect(() => buildContainerRunArgs(AGENT, { ...base, name: '-rf' })).toThrow(/not a container name/);
  });

  it('is pure: the same input gives the same argv, and the input is not modified', () => {
    const frozen = Object.freeze({ ...base, mounts: Object.freeze([...base.mounts]), envNames: Object.freeze(['A']) });
    expect(buildContainerRunArgs(AGENT, frozen)).toEqual(buildContainerRunArgs(AGENT, frozen));
  });
});

describe('gitMounts', () => {
  const byPath = (mounts: ContainerMount[]) => Object.fromEntries(mounts.map((m) => [m.path, m.readOnly ? 'ro' : 'rw']));

  it('for a reviewer run opens nothing of the clone: the worktree and its own index are writable, objects and refs are not', () => {
    expect(byPath(gitMounts(WT, LAYOUT, everything, ['/shared/objects'], true))).toEqual({
      [WT]: 'rw',
      [`${WT}/.git`]: 'ro',
      [COMMON]: 'ro',
      [ADMIN]: 'rw',
      [`${ADMIN}/commondir`]: 'ro',
      [`${ADMIN}/gitdir`]: 'ro',
      [`${ADMIN}/config.worktree`]: 'ro',
      '/shared/objects': 'ro',
    });
    // The ordinary mounts do open what a commit writes.
    expect(byPath(gitMounts(WT, LAYOUT, everything))).toMatchObject({ [`${COMMON}/objects`]: 'rw', [`${COMMON}/refs`]: 'rw' });
  });

  it('opens the worktree and only what a commit writes; everything host git obeys stays read-only', () => {
    expect(byPath(gitMounts(WT, LAYOUT, everything))).toEqual({
      [WT]: 'rw',
      [`${WT}/.git`]: 'ro',
      [COMMON]: 'ro',
      [`${COMMON}/objects`]: 'rw',
      [`${COMMON}/refs`]: 'rw',
      [`${COMMON}/logs`]: 'rw',
      [`${COMMON}/reftable`]: 'rw',
      [`${COMMON}/lfs`]: 'rw',
      [ADMIN]: 'rw',
      [`${ADMIN}/commondir`]: 'ro',
      [`${ADMIN}/gitdir`]: 'ro',
      [`${ADMIN}/config.worktree`]: 'ro',
    });
  });

  it('never opens hooks, config or info for writing, whatever exists', () => {
    const mounts = gitMounts(WT, LAYOUT, everything);
    for (const name of ['hooks', 'config', 'info', 'info/attributes', 'packed-refs', 'HEAD', 'index', 'worktrees']) {
      // Not mounted on its own, so it has the common dir's read-only mount.
      expect(mounts.find((m) => m.path === `${COMMON}/${name}`)).toBeUndefined();
    }
    expect(mounts.filter((m) => !m.readOnly).map((m) => m.path).filter((p) => p.startsWith(COMMON) && !p.startsWith(ADMIN))).toEqual(
      ['objects', 'refs', 'logs', 'reftable', 'lfs'].map((d) => `${COMMON}/${d}`),
    );
  });

  it('lists a parent before anything mounted over it', () => {
    const paths = gitMounts(WT, LAYOUT, everything).map((m) => m.path);
    paths.forEach((p, i) => {
      for (const later of paths.slice(i + 1)) expect(p.startsWith(`${later}/`)).toBe(false);
    });
  });

  it('skips directories the clone does not have (a bind mount needs an existing source)', () => {
    const present = new Set([`${COMMON}/objects`, `${COMMON}/refs`, `${ADMIN}/commondir`, `${ADMIN}/gitdir`]);
    const paths = gitMounts(WT, LAYOUT, (p) => present.has(p)).map((m) => m.path);
    expect(paths).toEqual([WT, `${WT}/.git`, COMMON, `${COMMON}/objects`, `${COMMON}/refs`, ADMIN, `${ADMIN}/commondir`, `${ADMIN}/gitdir`]);
  });

  it('mounts borrowed object stores read-only', () => {
    const mounts = gitMounts(WT, LAYOUT, everything, ['/mirrors/widgets.git/objects']);
    expect(mounts[mounts.length - 1]).toEqual({ path: '/mirrors/widgets.git/objects', readOnly: true });
  });
});

describe.skipIf(process.platform === 'win32')('worktreeMounts (real git worktree)', { timeout: 60_000 }, () => {
  function worktree() {
    const f = createGitFixture('octo/widgets');
    fixtures.push(f);
    const wt = join(f.root, 'job worktrees', 'job 1');
    mkdirSync(join(f.root, 'job worktrees'));
    f.git(f.clone, 'worktree', 'add', '--quiet', '-b', 'updraft/issue-1', wt, 'HEAD');
    return { f, wt, common: realpathSync(join(f.clone, '.git')) };
  }

  it('reads the admin and common directories from the pointer files git wrote', () => {
    const { f, wt, common } = worktree();
    const layout = readWorktreeLayout(wt);
    expect(layout.commonDir).toBe(f.git(f.clone, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    expect(layout.adminDir).toBe(f.git(wt, 'rev-parse', '--path-format=absolute', '--git-dir'));
    expect(layout.pointer).toBe(join(wt, '.git'));
    expect(layout.commonDir).toBe(common);
  });

  it('every mount exists, the per-worktree config is created so it can be pinned, and nothing outside the worktree and the git dir is listed', () => {
    const { f, wt, common } = worktree();
    const mounts = worktreeMounts(wt);
    for (const m of mounts) expect(existsSync(m.path), m.path).toBe(true);
    const admin = readWorktreeLayout(wt).adminDir;
    expect(readFileSync(join(admin, 'config.worktree'), 'utf8')).toBe('');
    expect(mounts).toContainEqual({ path: join(admin, 'config.worktree'), readOnly: true });
    for (const m of mounts) expect(m.path === wt || m.path.startsWith(`${wt}/`) || m.path === common || m.path.startsWith(`${common}/`), m.path).toBe(true);
    expect(mounts).toContainEqual({ path: join(common, 'objects'), readOnly: false });
    expect(mounts).toContainEqual({ path: common, readOnly: true });
    // The empty per-worktree config changes nothing for git in the worktree.
    expect(f.git(wt, 'status', '--porcelain')).toBe('');
  });

  it('refuses a directory that is not a linked worktree: there would be no narrow view of git to give', () => {
    const { f } = worktree();
    expect(() => worktreeMounts(f.clone)).toThrow(/is not a linked git worktree/);
    const plain = join(f.root, 'plain dir');
    mkdirSync(plain);
    expect(() => worktreeMounts(plain)).toThrow(ContainerSetupError);
    writeFileSync(join(plain, '.git'), 'not a pointer\n');
    expect(() => worktreeMounts(plain)).toThrow(/does not hold a "gitdir:" line/);
  });

  it('refuses a pointer that leads outside <common>/worktrees', () => {
    const { f } = worktree();
    const fake = join(f.root, 'forged');
    mkdirSync(join(fake, 'admin'), { recursive: true });
    writeFileSync(join(fake, 'admin', 'commondir'), '/\n');
    writeFileSync(join(fake, '.git'), `gitdir: ${join(fake, 'admin')}\n`);
    expect(() => worktreeMounts(fake)).toThrow(/unexpected worktree layout/);
  });
});

describe('containInvocation', () => {
  it.skipIf(process.platform === 'win32')('wraps what the adapter built: same prompt delivery and env, the runtime as the executable, no host CLI path', () => {
    const f = createGitFixture('octo/widgets');
    fixtures.push(f);
    const wt = join(f.root, 'wt');
    f.git(f.clone, 'worktree', 'add', '--quiet', '-b', 'updraft/issue-2', wt, 'HEAD');
    const promptFile = join(f.root, 'runs', 'run_1', 'prompt.md');
    const container = containerSchema.parse({ image: 'runner:1', env: ['ANTHROPIC_API_KEY'], network: 'bridge', args: ['--memory', '4g'] });
    const stdin = containInvocation({
      invocation: { file: 'claude', args: ['-p'], promptVia: 'stdin', env: { ADAPTER_VAR: 'a' } },
      runtime: '/usr/bin/docker',
      container,
      runId: 'run_1',
      worktree: wt,
      promptFile,
      agentEnv: { GIT_AUTHOR_NAME: 'Agent' },
      user: '501:20',
    });
    expect(stdin.name).toBe('updraft-run_1');
    expect(stdin.invocation).toMatchObject({ file: '/usr/bin/docker', promptVia: 'stdin', env: { ADAPTER_VAR: 'a' } });
    const args = stdin.invocation.args;
    expect(args.slice(args.indexOf('runner:1'))).toEqual(['runner:1', 'claude', '-p']);
    expect(valuesOf(args, '-e').slice(1)).toEqual(['ANTHROPIC_API_KEY', 'ADAPTER_VAR', 'GIT_AUTHOR_NAME']);
    expect(stdin.envNames).toEqual(['ANTHROPIC_API_KEY', 'ADAPTER_VAR', 'GIT_AUTHOR_NAME']);
    expect(args.join('\n')).not.toContain('Agent');
    expect(valuesOf(args, '--user')).toEqual(['501:20']);
    expect(valuesOf(args, '--network')).toEqual(['bridge']);
    expect(valuesOf(args, '--workdir')).toEqual([wt]);
    // A prompt on stdin needs no mount; the run directory (run.log) is never mounted.
    expect(stdin.mounts.some((m) => m.path.startsWith(join(f.root, 'runs')))).toBe(false);

    const byPath = containInvocation({
      invocation: { file: 'agent', args: ['--prompt-file', promptFile], promptVia: 'file-arg' },
      runtime: '/usr/bin/docker',
      container,
      runId: 'run_2',
      worktree: wt,
      promptFile,
    });
    expect(byPath.mounts[byPath.mounts.length - 1]).toEqual({ path: promptFile, readOnly: true });
    expect(byPath.mounts.filter((m) => m.path.startsWith(join(f.root, 'runs')))).toHaveLength(1);
  });
});

describe('containerLaunch', () => {
  it('uses agents.<name>.command as written, else the adapter CLI name; never a host path', () => {
    expect(containerLaunch('claude', {})).toEqual({ file: 'claude', args: [] });
    expect(containerLaunch('kiro', {})).toEqual({ file: 'kiro-cli', args: [] });
    expect(containerLaunch('claude', { command: '/opt/tools/claude' })).toEqual({ file: '/opt/tools/claude', args: [] });
    expect(containerLaunch('claude', { command: 'claude-nightly' })).toEqual({ file: 'claude-nightly', args: [] });
  });
});

describe('resolveRuntime', () => {
  const found = (known: string[]) => (c: string) => (known.includes(c) ? (c.includes('/') ? c : `/usr/bin/${c}`) : null);

  it('looks a bare name up on PATH and resolves a path against the config directory', () => {
    expect(resolveRuntime('docker', { env: {}, configDir: '/cfg', which: found(['docker']) })).toBe('/usr/bin/docker');
    expect(resolveRuntime('podman', { env: {}, configDir: '/cfg', which: found(['docker']) })).toBeNull();
    expect(resolveRuntime('./bin/nerdctl', { env: {}, configDir: '/cfg', which: found(['/cfg/bin/nerdctl']) })).toBe('/cfg/bin/nerdctl');
    expect(resolveRuntime('/opt/podman', { env: {}, configDir: '/cfg', which: found(['/opt/podman']) })).toBe('/opt/podman');
  });
});

// The mount list applied for real, without a container runtime: the same bind mounts, with the
// same read-only flags, in a private mount namespace (`unshare -m`), then git as an agent would
// use it. Needs Linux and root, so it is skipped elsewhere (including most CI).
const canBindMount = process.platform === 'linux' && process.getuid?.() === 0 && spawnSync('unshare', ['-m', 'true']).status === 0;

describe.runIf(canBindMount)('the worktree mounts, applied as bind mounts in a private mount namespace', { timeout: 60_000 }, () => {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

  /** Run `script` (sh) in `cwd` with `mounts` in effect. Returns one "<label>=<exit code>" line per `try` call, plus output. */
  function inMounts(mounts: ContainerMount[], cwd: string, script: string, env: NodeJS.ProcessEnv) {
    const setup = mounts.map((m) => `mount --bind ${q(m.path)} ${q(m.path)} && mount -o remount,bind,${m.readOnly ? 'ro' : 'rw'} ${q(m.path)}`).join(' && ');
    const helpers = 'try() { label=$1; shift; "$@" >/dev/null 2>&1; echo "$label=$?"; }; write() { { printf "%s\\n" "$2" >> "$1"; } 2>/dev/null; }';
    const r = spawnSync('unshare', ['-m', 'sh', '-c', `${setup} && cd ${q(cwd)} && ${helpers}\n${script}`], { env, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    return Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split('=') as [string, string]));
  }

  it('an agent can add, commit, branch, stash and rebase; it cannot touch what host git obeys', () => {
    const f = createGitFixture('octo/widgets');
    fixtures.push(f);
    const wt = join(f.root, 'job worktrees', 'job 1');
    mkdirSync(join(f.root, 'job worktrees'));
    f.git(f.clone, 'worktree', 'add', '--quiet', '-b', 'updraft/issue-1', wt, 'HEAD');
    // Git records the clone's git directory by its real path (macOS temp dirs sit behind a symlink).
    const common = realpathSync(join(f.clone, '.git'));
    const admin = readWorktreeLayout(wt).adminDir;
    const emptyConfig = join(f.root, 'agent gitconfig');
    writeFileSync(emptyConfig, '');
    const env = {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_AUTHOR_NAME: 'Agent',
      GIT_AUTHOR_EMAIL: 'agent@example.com',
      GIT_COMMITTER_NAME: 'Agent',
      GIT_COMMITTER_EMAIL: 'agent@example.com',
    };
    const results = inMounts(
      worktreeMounts(wt),
      wt,
      [
        'echo more >> README.md; echo new > added.txt',
        'try add git add -A',
        'try commit git commit -q -m "agent commit"',
        'try branch git checkout -q -b side',
        'try back git checkout -q updraft/issue-1',
        'echo wip >> README.md',
        'try stash git stash',
        'try pop git stash pop',
        'try commit2 git commit -qam second',
        'try rebase git rebase HEAD~1',
        'try tag git tag agent-tag',
        // What must fail: everything host git executes or obeys.
        `try hook write ${q(join(common, 'hooks', 'post-checkout'))} '#!/bin/sh'`,
        `try config write ${q(join(common, 'config'))} '[core]'`,
        'try gitconfig git config core.fsmonitor /tmp/evil',
        `try attributes write ${q(join(common, 'info', 'attributes'))} '* filter=x'`,
        `try mainhead write ${q(join(common, 'HEAD'))} x`,
        `try pointer write ${q(join(wt, '.git'))} 'gitdir: /nowhere'`,
        `try pointermv mv ${q(join(wt, '.git'))} ${q(join(wt, 'dotgit'))}`,
        `try pointerrm rm -f ${q(join(wt, '.git'))}`,
        `try commondir write ${q(join(admin, 'commondir'))} /nowhere`,
        `try commondirrm rm -f ${q(join(admin, 'commondir'))}`,
        `try wtconfig write ${q(join(admin, 'config.worktree'))} '[core]'`,
        `try otherworktree mkdir ${q(join(common, 'worktrees', 'forged'))}`,
      ].join('\n'),
      env,
    );
    expect(results).toEqual({
      add: '0',
      commit: '0',
      branch: '0',
      back: '0',
      stash: '0',
      pop: '0',
      commit2: '0',
      rebase: '0',
      tag: '0',
      hook: expect.not.stringMatching(/^0$/),
      config: expect.not.stringMatching(/^0$/),
      gitconfig: expect.not.stringMatching(/^0$/),
      attributes: expect.not.stringMatching(/^0$/),
      mainhead: expect.not.stringMatching(/^0$/),
      pointer: expect.not.stringMatching(/^0$/),
      pointermv: expect.not.stringMatching(/^0$/),
      pointerrm: expect.not.stringMatching(/^0$/),
      commondir: expect.not.stringMatching(/^0$/),
      commondirrm: expect.not.stringMatching(/^0$/),
      wtconfig: expect.not.stringMatching(/^0$/),
      otherworktree: expect.not.stringMatching(/^0$/),
    });
    // The host sees the agent's commits on the job branch, and the clone itself is untouched.
    expect(f.git(f.clone, 'log', '--format=%s', '-2', 'updraft/issue-1')).toBe('second\nagent commit');
    expect(f.git(f.clone, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(common, 'hooks', 'post-checkout'))).toBe(false);
    expect(readFileSync(join(wt, '.git'), 'utf8')).toBe(`gitdir: ${admin}\n`);
  });
});
