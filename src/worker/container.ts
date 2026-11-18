// Container boundary for live runs (agents.<name>.container; docs/isolation.md).
//
// A containerized run replaces `<agent cli> <args>` with
//
//   <runtime> run --rm -i --name updraft-<run id> ... <image> <agent cli> <args>
//
// and nothing else about the run changes: the runtime client is the process the executor spawns,
// records and waits for, its stdin is the prompt and its stdout/stderr are run.log. Adapters never
// see any of this; their AgentInvocation is wrapped after they build it. Any other command that
// should run in the job worktree under the same boundary (for example a verification step) can be
// wrapped with the same buildContainerRunArgs.
//
// What the container gets, and why:
// - Mounts, each at its host path so git's absolute pointers stay valid (worktreeMounts):
//   the job worktree read-write, and of the source clone's git directory only what a commit
//   writes (objects, refs, logs, this worktree's admin directory). The rest of the git directory
//   is read-only, in particular everything host git would later execute or obey: hooks, config,
//   info/attributes, the worktree's `.git` pointer and its `commondir`. Nothing else of the host
//   is mounted: no home directory, no SSH agent socket, no runtime socket.
// - The worker's uid:gid, so files in the worktree stay owned by the user, and a scratch HOME on
//   a tmpfs, since that uid usually has no home (or passwd entry) in the image.
// - Environment variables by name only (`-e NAME`): the runtime client copies each value from its
//   own environment, so no value is ever on a command line or in run.log.
// - A deterministic name, so a timeout, a shutdown or a later worker's reconcile can stop the
//   container itself. Killing the runtime client does not reliably stop the container.
import { execFile, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';

// POSIX path rules throughout, whatever the host: a containerized agent is only supported on
// Linux and macOS (it is a validation error on native Windows), and every path here is mounted
// at the same path inside a Linux container. On those hosts this is exactly node:path.
const { basename, dirname, isAbsolute, join, resolve } = posix;
import type { AgentInvocation } from '../agents/adapters/registry.js';
import { AGENT_SPECS, isKnownAdapter, type LaunchSpec } from '../agents/discovery.js';
import type { AgentConfig, ContainerConfig } from '../config/schema.js';
import { which } from '../util/which.js';

/** HOME inside the container: a tmpfs any uid can write. Not a path a host mount would use. */
export const CONTAINER_HOME = '/updraft-home';
/** Label on every container the worker starts: `docker ps --filter label=updraft.run`. */
export const RUN_LABEL = 'updraft.run';

/** Exit code of `docker run` / `podman run` when the runtime itself failed and the command never ran. */
export const CONTAINER_RUN_FAILED = 125;

const RUNTIME_TIMEOUT_MS = 20_000;

/** A host path bind-mounted into the container at the same path. */
export interface ContainerMount {
  path: string;
  readOnly: boolean;
}

/** The command to run inside the container: a name or path in the image, never a host path. */
export interface ContainerCommand {
  file: string;
  args: readonly string[];
}

export interface ContainerRunOptions {
  image: string;
  /** Container name; see {@link containerName}. */
  name: string;
  /** Bind mounts, parents before the paths mounted over them. */
  mounts: readonly ContainerMount[];
  /** Working directory inside the container (the job worktree). Omitted: the image's. */
  workdir?: string;
  /** `uid:gid` to run as. Omitted: the image's user. */
  user?: string;
  /** Names of variables the runtime client passes on from its own environment. */
  envNames?: readonly string[];
  /** --network value. Omitted: the runtime's default. */
  network?: string;
  /** Value of the {@link RUN_LABEL} label (the run id). */
  runLabel?: string;
  /** container.args from the config, placed last before the image so they can override the defaults. */
  extraArgs?: readonly string[];
}

/** The container of a run: `updraft-<run id>`, restricted to what a container name may contain. */
export function containerName(runId: string, suffix?: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '-');
  return `updraft-${clean(runId)}${suffix ? `-${clean(suffix)}` : ''}`;
}

export class ContainerSetupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContainerSetupError';
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function mountSpec(m: ContainerMount): string {
  if (!isAbsolute(m.path)) throw new ContainerSetupError(`cannot mount ${m.path}: not an absolute path`);
  // --mount takes comma-separated key=value fields; a path with these characters can't be passed safely.
  if (/[,"\r\n]/.test(m.path)) {
    throw new ContainerSetupError(`cannot mount ${m.path}: the path contains a comma, a double quote or a line break, which a --mount argument cannot carry`);
  }
  return `type=bind,source=${m.path},target=${m.path}${m.readOnly ? ',readonly' : ''}`;
}

/**
 * The arguments for `<runtime> run` (everything after the runtime executable) that run `command`
 * in a container. Pure: the same input always gives the same argv, and nothing is read from the
 * host. Works for docker and podman.
 */
export function buildContainerRunArgs(command: ContainerCommand, o: ContainerRunOptions): string[] {
  if (!/^[^-\s][^\s]*$/.test(o.image)) throw new ContainerSetupError(`"${o.image}" is not an image reference`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(o.name)) throw new ContainerSetupError(`"${o.name}" is not a container name`);
  const args = [
    'run',
    '--rm',
    // Keep stdin open for a prompt on stdin; no TTY, so output is exactly what the agent wrote.
    '-i',
    '--name',
    o.name,
    // The image must already be there (doctor checks it); a run never waits on a registry.
    '--pull',
    'never',
  ];
  if (o.runLabel) args.push('--label', `${RUN_LABEL}=${o.runLabel}`);
  if (o.user) args.push('--user', o.user);
  // No capabilities and no setuid escalation: the agent is an ordinary user inside the container.
  args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');
  // A HOME that exists and is writable for whatever uid this is. exec: tools install into it.
  args.push('--tmpfs', `${CONTAINER_HOME}:rw,exec,mode=1777`, '-e', `HOME=${CONTAINER_HOME}`);
  for (const m of o.mounts) args.push('--mount', mountSpec(m));
  if (o.workdir) args.push('--workdir', o.workdir);
  if (o.network) args.push('--network', o.network);
  for (const name of new Set(o.envNames ?? [])) {
    if (!ENV_NAME.test(name)) throw new ContainerSetupError(`"${name}" is not an environment variable name`);
    // By name: the client takes the value from its own environment (and sets nothing when it has none).
    args.push('-e', name);
  }
  args.push(...(o.extraArgs ?? []), o.image, command.file, ...command.args);
  return args;
}

// ---------------------------------------------------------------------------
// Mounts for a job worktree
// ---------------------------------------------------------------------------

/** Where a linked worktree's git data lives, read from its pointer files. */
export interface WorktreeGitLayout {
  /** `<worktree>/.git`: a file holding `gitdir: <adminDir>`. */
  pointer: string;
  /** `<commonDir>/worktrees/<id>`: this worktree's HEAD, index and logs. */
  adminDir: string;
  /** The clone's shared git directory (objects, refs, config, hooks). */
  commonDir: string;
}

/**
 * Read a linked worktree's layout from its pointer files (no git is run). Throws when `worktree`
 * is not a linked worktree, since then there is no way to give the container a narrow view of git.
 */
export function readWorktreeLayout(worktree: string): WorktreeGitLayout {
  const pointer = join(worktree, '.git');
  let text: string;
  try {
    if (!statSync(pointer).isFile()) throw new Error('it is a directory, not a worktree pointer file');
    text = readFileSync(pointer, 'utf8');
  } catch (err) {
    throw new ContainerSetupError(`${worktree} is not a linked git worktree (${pointer}: ${(err as Error).message})`, { cause: err });
  }
  const m = /^gitdir: (.+)$/m.exec(text.trim());
  if (!m) throw new ContainerSetupError(`${pointer} does not hold a "gitdir:" line`);
  const adminDir = resolve(worktree, m[1]!);
  let commonDir: string;
  try {
    commonDir = resolve(adminDir, readFileSync(join(adminDir, 'commondir'), 'utf8').trim());
  } catch (err) {
    throw new ContainerSetupError(`cannot read ${join(adminDir, 'commondir')}: ${(err as Error).message}`, { cause: err });
  }
  if (dirname(adminDir) !== join(commonDir, 'worktrees')) {
    throw new ContainerSetupError(`unexpected worktree layout: ${adminDir} is not directly under ${join(commonDir, 'worktrees')}`);
  }
  return { pointer, adminDir, commonDir };
}

/** Directories of the common git dir a commit writes to. Everything else in it stays read-only. */
const WRITABLE_COMMON = ['objects', 'refs', 'logs', 'reftable', 'lfs'] as const;
/**
 * Inside the writable `objects/`: `info/alternates` names other object stores by host path, and
 * the worker mounts whatever it lists into later containers. A commit never writes `objects/info`,
 * so it stays read-only and an agent cannot use it to have host paths of its choosing mounted.
 */
const PINNED_OBJECTS = 'info';
/** Files in the worktree's admin dir that decide which config and hooks host git uses there. */
const PINNED_ADMIN = ['commondir', 'gitdir', 'config.worktree'] as const;

/**
 * The mounts for an agent working in `layout`'s worktree. Pure given `exists`.
 *
 * The common git dir is mounted read-only and only what a commit writes is opened up inside it.
 * That keeps the agent away from everything host git executes or obeys the next time the worker
 * (or the user) runs git in the clone: `hooks/`, `config`, `info/attributes`, `info/exclude`,
 * `packed-refs`, the main worktree's `HEAD` and `index`, and other worktrees' admin directories.
 * Within the writable object store, `objects/info` stays read-only (see PINNED_OBJECTS).
 * The worktree's own `.git` pointer and its admin `commondir` are pinned read-only too: either
 * could otherwise be repointed at a directory the agent controls, whose `config` host git would
 * then obey when it runs in the worktree (the run summary does). `config.worktree` is pinned
 * because git obeys it when the clone has extensions.worktreeConfig.
 *
 * The cost: git commands that rewrite files directly in the common dir fail inside the container
 * (`git gc`, `git pack-refs`, deleting a packed ref, `git config` without --global). Ordinary
 * add, commit, checkout, stash, rebase, tag and branch creation work.
 *
 * `readOnlyGit` (a reviewer run) leaves the whole common git dir read-only: nothing the agent does
 * can add an object, move a ref or create a branch in the clone, so `git commit` fails. Reading
 * history (`git diff`, `git log`, `git show`) works. The worktree and its admin directory (its
 * index and HEAD) stay writable so tests can be run and files staged; both are deleted after the run.
 */
export function gitMounts(
  worktree: string,
  layout: WorktreeGitLayout,
  exists: (path: string) => boolean,
  alternates: readonly string[] = [],
  readOnlyGit = false,
): ContainerMount[] {
  const ro = (path: string): ContainerMount => ({ path, readOnly: true });
  const rw = (path: string): ContainerMount => ({ path, readOnly: false });
  return [
    rw(worktree),
    ro(layout.pointer),
    ro(layout.commonDir),
    ...(readOnlyGit ? [] : WRITABLE_COMMON.map((d) => join(layout.commonDir, d)).filter(exists).map(rw)),
    ...(readOnlyGit ? [] : [join(layout.commonDir, 'objects', PINNED_OBJECTS)].filter(exists).map(ro)),
    rw(layout.adminDir),
    ...PINNED_ADMIN.map((f) => join(layout.adminDir, f)).filter(exists).map(ro),
    // Object stores the clone borrows from (git clone --reference/--shared): readable, never writable.
    ...alternates.filter(exists).map(ro),
  ];
}

/** Absolute paths listed in `<commonDir>/objects/info/alternates`, if any. */
function readAlternates(commonDir: string): string[] {
  const objects = join(commonDir, 'objects');
  let text: string;
  try {
    text = readFileSync(join(objects, 'info', 'alternates'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => resolve(objects, l));
}

/**
 * Mounts for an agent in `worktree` (see {@link gitMounts}), read from the worktree as the worker
 * just created it. Call it once, before the agent runs, and reuse the result for anything that
 * runs in the worktree afterwards (the verify commands): by then the worktree's contents and the
 * clone's object store are the agent's, and a plan read from them would be the agent's too. Creates an empty `config.worktree` in the worktree's admin dir when there is none, so
 * that it can be pinned read-only (a bind mount needs an existing file).
 */
export function worktreeMounts(worktree: string, opts: { readOnlyGit?: boolean } = {}): ContainerMount[] {
  const layout = readWorktreeLayout(worktree);
  const perWorktreeConfig = join(layout.adminDir, 'config.worktree');
  if (!existsSync(perWorktreeConfig)) {
    try {
      closeSync(openSync(perWorktreeConfig, 'a'));
    } catch (err) {
      throw new ContainerSetupError(`cannot create ${perWorktreeConfig}: ${(err as Error).message}`, { cause: err });
    }
  }
  // objects/info exists in every repository git made; make sure, so that it can be pinned.
  const objectsInfo = join(layout.commonDir, 'objects', PINNED_OBJECTS);
  if (existsSync(join(layout.commonDir, 'objects')) && !existsSync(objectsInfo)) {
    try {
      mkdirSync(objectsInfo);
    } catch (err) {
      throw new ContainerSetupError(`cannot create ${objectsInfo}: ${(err as Error).message}`, { cause: err });
    }
  }
  return gitMounts(worktree, layout, existsSync, readAlternates(layout.commonDir), opts.readOnlyGit === true);
}

// ---------------------------------------------------------------------------
// The runtime client
// ---------------------------------------------------------------------------

export interface RuntimeResult {
  /** Exit code; null when the client could not be run or timed out. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the runtime client with an argument list (no shell). Never rejects. */
export function runRuntime(runtime: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<RuntimeResult> {
  return new Promise((done) => {
    try {
      execFile(runtime, [...args], { env: opts.env, timeout: opts.timeoutMs ?? RUNTIME_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        done({ code, stdout: String(stdout), stderr: String(stderr || (err && code === null ? err.message : '')) });
      });
    } catch (err) {
      done({ code: null, stdout: '', stderr: (err as Error).message });
    }
  });
}

const lastLine = (s: string) => s.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';

/**
 * agents.<name>.container.runtime as an executable path: a bare name is looked up on PATH, a
 * path is resolved against the config file's directory. Null when there is no such executable.
 */
export function resolveRuntime(runtime: string, opts: { env: NodeJS.ProcessEnv; configDir: string; which?: (command: string) => string | null }): string | null {
  const find = opts.which ?? ((c: string) => which(c, { env: opts.env }));
  const target = runtime.includes('/') && !isAbsolute(runtime) ? resolve(opts.configDir, runtime) : runtime;
  const found = find(target);
  return found ? resolve(found) : null;
}

/**
 * The agent CLI as it is started inside the image: agents.<name>.command as written, else the
 * adapter's CLI name. Host discovery (PATH lookup, Windows shim resolution) says nothing about
 * what is in the image, so it is not applied.
 */
export function containerLaunch(adapter: string, agent: Pick<AgentConfig, 'command'>): LaunchSpec {
  return { file: agent.command ?? (isKnownAdapter(adapter) ? AGENT_SPECS[adapter].command : adapter), args: [] };
}

/**
 * Before a containerized run touches the clone: is the runtime there, and the image present
 * locally? Returns the runtime's path, or why the agent cannot start (a start failure: nothing
 * has run yet, so the queue may try another agent).
 */
export async function checkContainerReady(
  container: ContainerConfig,
  opts: { env: NodeJS.ProcessEnv; configDir: string },
): Promise<{ runtime: string; problem?: undefined } | { runtime: null; problem: string }> {
  const runtime = resolveRuntime(container.runtime, opts);
  if (!runtime) {
    return { runtime: null, problem: `container runtime "${container.runtime}" was not found${container.runtime.includes('/') ? '' : ' on PATH'} or is not executable` };
  }
  const image = await runRuntime(runtime, ['image', 'inspect', '--format', '{{.Id}}', container.image], { env: opts.env });
  if (image.code !== 0) {
    const said = lastLine(image.stderr);
    return {
      runtime: null,
      problem:
        `container image ${container.image} is not available to ${runtime}${said ? ` (${said})` : ''}; ` +
        'build or pull it first (a run never pulls), and check that the runtime is running',
    };
  }
  return { runtime };
}

export interface ContainedInvocation {
  /** The invocation to spawn: the runtime client running the original command in a container. */
  invocation: AgentInvocation;
  name: string;
  mounts: ContainerMount[];
  /** Variables passed into the container by name. */
  envNames: string[];
}

/**
 * Wrap the invocation an adapter built so that it runs in a container. The adapter's and the
 * config's variables (invocation.env, agents.<name>.env) stay in the client's environment and
 * are passed on by name, like container.env.
 */
export function containInvocation(o: {
  invocation: AgentInvocation;
  runtime: string;
  container: ContainerConfig;
  runId: string;
  worktree: string;
  /** Mounted read-only when the adapter passes the prompt by path. */
  promptFile: string;
  /** agents.<name>.env */
  agentEnv?: Record<string, string>;
  /** `uid:gid`; defaults to the worker's own. */
  user?: string;
  /** A reviewer run: the clone's git directory is mounted read-only (see {@link gitMounts}). */
  readOnlyGit?: boolean;
}): ContainedInvocation {
  const inv = o.invocation;
  const name = containerName(o.runId);
  const mounts = worktreeMounts(o.worktree, { readOnlyGit: o.readOnlyGit === true });
  if (inv.promptVia === 'file-arg') mounts.push({ path: o.promptFile, readOnly: true });
  const envNames = [...new Set([...o.container.env, ...Object.keys(inv.env ?? {}), ...Object.keys(o.agentEnv ?? {})])];
  const args = buildContainerRunArgs(
    { file: inv.file, args: inv.args },
    {
      image: o.container.image,
      name,
      mounts,
      workdir: o.worktree,
      user: o.user ?? hostUser(),
      envNames,
      network: o.container.network,
      runLabel: o.runId,
      extraArgs: o.container.args,
    },
  );
  return { invocation: { ...inv, file: o.runtime, args }, name, mounts, envNames };
}

/** The worker's `uid:gid` (POSIX). Undefined where there is none, leaving the image's user. */
export function hostUser(): string | undefined {
  return typeof process.getuid === 'function' && typeof process.getgid === 'function' ? `${process.getuid()}:${process.getgid()}` : undefined;
}

// ---------------------------------------------------------------------------
// Stopping
// ---------------------------------------------------------------------------

/** How long {@link stopContainer} may take for a given grace period. */
export function containerStopBudgetMs(graceMs: number): number {
  return graceMs + 3_000 + RUNTIME_TIMEOUT_MS;
}

/**
 * Stop a run's container by name: SIGTERM, SIGKILL after the grace period, then remove it.
 * Best effort and bounded; never rejects. A container that is already gone is fine.
 */
export async function stopContainer(runtime: string, name: string, graceMs: number, env?: NodeJS.ProcessEnv): Promise<void> {
  const seconds = Math.max(1, Math.ceil(graceMs / 1000));
  await runRuntime(runtime, ['stop', '-t', String(seconds), name], { env, timeoutMs: graceMs + 3_000 });
  await forceRemoveContainer(runtime, name, env);
}

/** `rm -f`: kill the named container if it is running and remove it. Best effort; never rejects. */
export async function forceRemoveContainer(runtime: string, name: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await runRuntime(runtime, ['rm', '-f', name], { env });
}

/** Injectable so reconcile's tests never touch a real runtime. */
export interface ContainerControl {
  /** Remove (killing if needed) the named container if it exists. Never rejects. */
  remove(runtime: string, name: string): Promise<{ removed: boolean; note: string }>;
}

/**
 * Kill and remove a container left by an earlier worker. Returns a note for the run's error text
 * ('' when there was no such container).
 */
export async function removeContainer(runtime: string, name: string, env?: NodeJS.ProcessEnv): Promise<{ removed: boolean; note: string }> {
  const seen = await runRuntime(runtime, ['container', 'inspect', '--format', '{{.State.Status}}', name], { env });
  if (seen.code !== 0) {
    if (/no such (container|object)/i.test(seen.stderr)) return { removed: false, note: '' };
    return {
      removed: false,
      note: `could not check for leftover container ${name} with ${runtime} (${lastLine(seen.stderr) || 'no answer'}); if it is still running, remove it with "${basename(runtime)} rm -f ${name}"`,
    };
  }
  const rm = await runRuntime(runtime, ['rm', '-f', name], { env });
  if (rm.code === 0) return { removed: true, note: `removed leftover container ${name}` };
  return { removed: false, note: `could not remove leftover container ${name}: ${lastLine(rm.stderr) || `${basename(runtime)} rm failed`}` };
}

export const defaultContainerControl: ContainerControl = {
  remove: (runtime, name) => removeContainer(runtime, name),
};

// Containers of runs in progress in this worker. Like the agent processes live.ts tracks: if the
// worker exits without stopping them (a second Ctrl-C, a fatal error) they are removed on the way
// out. A worker killed outright can't; the next worker's reconcile removes them by name.
const active = new Map<string, { runtime: string; env?: NodeJS.ProcessEnv }>();
let exitHookInstalled = false;

export function trackContainer(runtime: string, name: string, env?: NodeJS.ProcessEnv): void {
  active.set(name, { runtime, env });
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const [n, c] of active) spawnSync(c.runtime, ['rm', '-f', n], { env: c.env, stdio: 'ignore', windowsHide: true, timeout: 5_000 });
  });
}

export function untrackContainer(name: string): void {
  active.delete(name);
}
