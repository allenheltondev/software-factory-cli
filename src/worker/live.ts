// Live executor (execution.mode: live): prepare the job's worktree, run the routed agent in it
// through its adapter, and record what it left behind.
//
// Process lifecycle, identical for every adapter:
// - spawned directly (never a shell), with the resolved launch target, so Windows npm `.cmd`
//   shims run as node + script; prompt text never appears on a command line
// - POSIX: the agent leads its own process group (detached), so a timeout or shutdown reaches its
//   descendants. Terminal Ctrl-C then no longer reaches the agent directly; instead the worker
//   forwards its own SIGINT/SIGTERM shutdown to the group (SIGTERM, then SIGKILL after a grace
//   period). Windows: `taskkill /t /f` stops the tree while the agent is alive.
// - pid recorded the moment the process exists, then its OS start time, so a later worker can
//   reap it after a crash without ever signalling a reused pid
// - stdout and stderr go straight to run.log (file descriptors, not pipes), so output survives a
//   worker crash and a descendant holding a pipe open can't stall the run
//
// After an agent succeeded, the action's verify commands (if any) run in the same worktree with
// the same lifecycle; only a string command differs, in that it is handed to a shell (verify.ts).
// - with agents.<name>.container, the process is the container runtime's client and the agent
//   runs in a container (container.ts); stopping then removes the container by name first
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  getAdapter,
  defaultVerdict,
  RAW_OUTPUT_BYTES,
  type AgentAdapter,
  type AgentInvocation,
} from '../agents/adapters/registry.js';
import { agentProfile, describeProfile, effectiveArgs } from '../agents/profile.js';
import { defaultDiscoveryProbes, locateLaunch, type LocatedLaunch } from '../agents/discovery.js';
import { renderPrompt, renderRevisionPrompt, type IssueContext } from '../agents/prompt.js';
import { dependencyMergedSection, dependencyProtocolSection, MAX_DEPENDENCY_WAITS, readDependency } from '../agents/dependency.js';
import type { DeclaredDependency } from '../db/dependency-waits.js';
import { renderReviewPrompt } from '../agents/review-prompt.js';
import {
  agentAdapter,
  dependencySettings,
  DEFAULT_TIMEOUT_MINUTES,
  DEFAULT_VERIFY_TIMEOUT_MINUTES,
  type AdapterName,
  type AgentConfig,
  type VerifyCommand,
} from '../config/schema.js';
import { ownEntry, type Claim } from '../db/queue.js';
import { jobBranchName, jobWorktreePath, prepareJobWorktree, type PreparedWorktree } from '../git/worktree.js';
import { resumeOf, reviewOf, revisionOf, type ReviewResult, type RunOutcome, type RunSummary, type VerificationCommandResult, type VerificationSummary } from '../types.js';
import {
  canceledByUser,
  findRepoConfig,
  resolvePromptPath,
  StartFailedError,
  type ExecutionContext,
  type ExecutionResult,
  type Executor,
} from './executor.js';
import {
  buildContainerRunArgs,
  checkContainerReady,
  CONTAINER_RUN_FAILED,
  containerLaunch,
  containerName,
  containerStopBudgetMs,
  containInvocation,
  forceRemoveContainer,
  hostUser,
  stopContainer,
  trackContainer,
  untrackContainer,
  type ContainedInvocation,
} from './container.js';
import { APP_KEY_PATH_ENV, APP_TOKEN_FILE_ENV } from '../github/app-auth.js';
import { commitIdentityEnv, type CommitIdentity } from '../github/credentials.js';
import { processStartTime, taskkillPath } from './process.js';
import { discardReviewWorktree, readReviewVerdict, reviewBase, type ReviewRunState } from './review-run.js';
import { cleanSummaryLines, countUncommitted, hasSubmodules, headCommit, readOutput, renderSummary, summarizeRun, tailLines } from './run-summary.js';
import { ESCALATION_MARKER } from '../escalation/escalation.js';
import { displayVerifyCommand, verifyInvocation, type VerifyInvocation } from './verify.js';

const isWindows = process.platform === 'win32';
const DEFAULT_KILL_GRACE_MS = 5_000;
/** After SIGKILL / taskkill, how long to wait for the exit event before giving up on it. */
const EXIT_WAIT_MS = 10_000;
/**
 * Variables the worker may hold for its own GitHub access (its token, or where its GitHub App's
 * private key or token file is); an agent working on untrusted input doesn't get them.
 */
const WITHHELD_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', APP_KEY_PATH_ENV, APP_TOKEN_FILE_ENV];

export interface LiveExecutorOptions {
  /** git executable for worktree preparation and the summary. */
  git?: string;
  /** Environment the agent's environment is built from. Defaults to the worker's. */
  env?: NodeJS.ProcessEnv;
  /** Find the agent CLI. Defaults to discovery's lookup (or agents.<name>.command). */
  locate?: (adapter: string, agent: AgentConfig, opts: { env: NodeJS.ProcessEnv; configDir: string }) => LocatedLaunch;
  /** POSIX: SIGTERM-to-SIGKILL grace when stopping the agent's process group. */
  killGraceMs?: number;
  /** Reads a pid's OS start time (see processStartTime). */
  startTime?: (pid: number) => Promise<string | null>;
  /**
   * github.app.commitAsApp: who the agent's commits in a run for `repoFullName` are authored and
   * committed by (the App's bot), set through GIT_AUTHOR_* and GIT_COMMITTER_*. Absent or null:
   * the local git identity, as git is configured.
   */
  commitIdentity?: (repoFullName: string) => Promise<CommitIdentity | null>;
  /**
   * How the fetch that prepares a run's worktree authenticates, for a machine that has no git
   * credentials of its own (`updraft run-event`; src/git/clone.ts). The environment is given to
   * the worker's own ls-remote and fetch and to nothing else: never to the agent. `redact`
   * removes the credential from an error before it is logged. Absent or null: the machine's own
   * git credentials, as always.
   */
  networkGit?: (o: { repoFullName: string; checkoutPath: string }) => Promise<{ env: NodeJS.ProcessEnv; redact: (text: string) => string } | null>;
}

function defaultLocate(adapter: string, agent: AgentConfig, opts: { env: NodeJS.ProcessEnv; configDir: string }): LocatedLaunch {
  return locateLaunch(adapter as AdapterName, defaultDiscoveryProbes(opts.env), {
    ...(agent.command ? { command: agent.command } : {}),
    baseDir: opts.configDir,
  });
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Apply each layer over `base` in order, replacing keys case-insensitively on Windows (Path vs PATH). */
export function mergeEnv(base: NodeJS.ProcessEnv, ...layers: Array<Record<string, string> | undefined>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer ?? {})) {
      if (isWindows) {
        for (const existing of Object.keys(out)) if (existing.toUpperCase() === k.toUpperCase()) delete out[existing];
      }
      out[k] = v;
    }
  }
  return out;
}

/**
 * The environment an agent's CLI is looked up and checked in: the worker's, minus the GitHub
 * tokens it withholds, plus agents.<name>.env. `updraft doctor` uses the same rule, so it checks
 * what a live run will see.
 */
export function agentLookupEnv(base: NodeJS.ProcessEnv, agent: Pick<AgentConfig, 'env'>): NodeJS.ProcessEnv {
  return mergeEnv(withoutKeys(base, WITHHELD_ENV), agent.env);
}

function withoutKeys(env: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  const drop = new Set(keys.map((k) => k.toUpperCase()));
  return Object.fromEntries(Object.entries(env).filter(([k]) => !(isWindows ? drop.has(k.toUpperCase()) : keys.includes(k))));
}

// ---------------------------------------------------------------------------
// Agent processes still running in this worker. If the worker exits without stopping them
// (a second Ctrl-C, a fatal error), they are killed on the way out. A worker killed outright
// can't do this; the next worker's reconcile reaps them by pid and start time instead.
// ---------------------------------------------------------------------------

const running = new Set<ChildProcess>();
let exitHookInstalled = false;

function killTreeNow(pid: number): void {
  if (isWindows) {
    spawnSync(taskkillPath(), ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', timeout: 5_000 });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // group already gone
  }
}

function track(child: ChildProcess): void {
  running.add(child);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      for (const c of running) if (c.pid && c.exitCode === null && c.signalCode === null) killTreeNow(c.pid);
    });
  }
}

/** Is any member of process group `pgid` alive? POSIX only. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalGroup(pgid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    return false;
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Like delay, but never keeps the process alive on its own. */
const idle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

/** POSIX: SIGTERM the group, wait up to graceMs for it to empty, then SIGKILL what's left. */
async function stopGroup(pgid: number, graceMs: number): Promise<void> {
  if (!signalGroup(pgid, 'SIGTERM')) return;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return;
    await delay(50);
  }
  signalGroup(pgid, 'SIGKILL');
  const gone = Date.now() + 2_000;
  while (Date.now() < gone && groupAlive(pgid)) await delay(50);
}

/** Windows: kill the agent's tree while the agent itself is still alive (taskkill follows live parents). */
function taskkillTree(child: ChildProcess): Promise<void> {
  return new Promise((resolveKill) => {
    try {
      execFile(taskkillPath(), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 15_000 }, (err) => {
        if (err && child.exitCode === null && child.signalCode === null) child.kill();
        resolveKill();
      });
    } catch {
      child.kill();
      resolveKill();
    }
  });
}

/** The agent started, then the worker stopped it before the run could proceed. Not a start failure. */
class AgentStoppedError extends Error {
  constructor(msg: string, opts?: ErrorOptions) {
    super(msg, opts);
    this.name = 'AgentStoppedError';
  }
}

interface AgentRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Why the worker stopped the agent, if it did. */
  stopped: 'timeout' | 'shutdown' | null;
  /** POSIX: processes left in the agent's group after it exited, which were then stopped. */
  leftovers: boolean;
}

/**
 * Spawn the agent (or a verify command) and wait for it. Rejects with StartFailedError when the
 * process can't be started; once it has started, always resolves.
 */
async function runAgent(o: {
  /** `verbatim` (Windows): the arguments are a finished command line for cmd.exe; don't re-quote them. */
  invocation: Pick<AgentInvocation, 'file' | 'args'> & { promptVia?: AgentInvocation['promptVia']; verbatim?: boolean };
  /** What the process is, for error messages. Default "agent". */
  what?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  /** Stderr goes here instead of logPath (AgentInvocation.separateStderr). Appended to, never truncated. */
  stderrPath?: string;
  /** Read on stdin when the invocation asks for the prompt there. */
  promptFile?: string;
  timeoutMs: number;
  stop: AbortSignal;
  killGraceMs: number;
  /** Containerized run: stops the container by name. Called before the process tree is stopped. */
  stopContainer?: () => Promise<void>;
  onSpawn: (pid: number) => void;
}): Promise<AgentRun> {
  const inv = o.invocation;
  // Stopping the runtime client does not reliably stop its container, so that goes first.
  const containerBudget = o.stopContainer ? containerStopBudgetMs(o.killGraceMs) : 0;
  const stopProcesses = async (child: ChildProcess, pid: number) => {
    if (o.stopContainer) await Promise.race([o.stopContainer(), idle(containerBudget)]);
    await (isWindows ? taskkillTree(child) : stopGroup(pid, o.killGraceMs));
  };
  let child: ChildProcess;
  const out = openSync(o.logPath, 'a');
  let err: number = out;
  let stdin: number | 'ignore' = 'ignore';
  try {
    if (o.stderrPath) err = openSync(o.stderrPath, 'a');
    if (inv.promptVia === 'stdin' && o.promptFile) stdin = openSync(o.promptFile, 'r');
    child = spawn(inv.file, inv.args, {
      cwd: o.cwd,
      env: o.env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: inv.verbatim === true,
      detached: !isWindows,
      stdio: [stdin, out, err],
    });
  } catch (e) {
    throw new StartFailedError(`could not start ${inv.file}: ${message(e)}`, { cause: e });
  } finally {
    // The child has its own copies now.
    closeSync(out);
    if (err !== out) closeSync(err);
    if (typeof stdin === 'number') closeSync(stdin);
  }

  let exited = false;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
    child.once('exit', (code, signal) => {
      exited = true;
      running.delete(child);
      r({ code, signal });
    }),
  );
  try {
    await new Promise<void>((ok, fail) => {
      child.once('spawn', ok);
      child.once('error', fail);
    });
  } catch (err) {
    throw new StartFailedError(`could not start ${inv.file}: ${message(err)}`, { cause: err });
  }
  // Late errors (e.g. from kill) must never be unhandled.
  child.on('error', () => undefined);
  const pid = child.pid!;
  track(child);
  try {
    o.onSpawn(pid);
  } catch (err) {
    // The agent is running but the worker couldn't record it, so nothing else would stop it.
    // Stop it now and wait, and report a started run that failed: a start_failed outcome would
    // let the queue try another agent while this one might still be working in the worktree.
    await Promise.race([stopProcesses(child, pid), idle(containerBudget + o.killGraceMs + EXIT_WAIT_MS)]);
    await Promise.race([exit, idle(EXIT_WAIT_MS)]);
    if (!isWindows && groupAlive(pid)) await stopGroup(pid, Math.min(o.killGraceMs, 2_000));
    if (!exited) running.delete(child);
    throw new AgentStoppedError(`could not record the started ${o.what ?? 'agent'} process (${message(err)}); it was stopped`, { cause: err });
  }

  let stopped: AgentRun['stopped'] = null;
  let killing: Promise<void> | null = null;
  // Once a stop begins, the wait for 'exit' is bounded: SIGKILL/taskkill should end it well within this.
  let giveUp!: () => void;
  const gaveUp = new Promise<null>((r) => (giveUp = () => r(null)));
  let giveUpTimer: NodeJS.Timeout | undefined;
  const stopTree = (why: 'timeout' | 'shutdown') => {
    if (stopped || exited) return;
    stopped = why;
    killing = stopProcesses(child, pid);
    giveUpTimer = setTimeout(giveUp, containerBudget + o.killGraceMs + EXIT_WAIT_MS);
  };
  const timer = setTimeout(() => stopTree('timeout'), o.timeoutMs);
  const onStop = () => stopTree('shutdown');
  if (o.stop.aborted) onStop();
  else o.stop.addEventListener('abort', onStop, { once: true });

  let result: { code: number | null; signal: NodeJS.Signals | null } | null;
  try {
    result = await Promise.race([exit, gaveUp]);
  } finally {
    clearTimeout(timer);
    clearTimeout(giveUpTimer);
    o.stop.removeEventListener('abort', onStop);
  }
  if (killing) await Promise.race([killing as Promise<void>, idle(containerBudget + o.killGraceMs + EXIT_WAIT_MS)]);
  if (result === null) {
    // Still no exit event. Report it as killed rather than hang the worker.
    running.delete(child);
    result = { code: null, signal: 'SIGKILL' };
  }

  // POSIX: anything still in the agent's group (a background process it started, or a member
  // that ignored SIGTERM) is stopped too. Windows can't find descendants once the agent exited.
  let leftovers = false;
  if (!isWindows && groupAlive(pid)) {
    leftovers = true;
    await stopGroup(pid, Math.min(o.killGraceMs, 2_000));
  }
  return { ...result, stopped, leftovers };
}

interface VerificationRun {
  summary: VerificationSummary;
  /** Set when the step did not pass: what the run's outcome and error become. */
  failure: { outcome: 'failed' | 'interrupted'; error: string } | null;
}

/**
 * Run an action's verify commands in the worktree, in order, until one does not pass. Each is a
 * process like the agent's (runAgent): own group, killed at the time limit and on shutdown, pid
 * recorded for a later worker's reconcile, output straight into run.log. Never throws.
 *
 * `contain`, for a containerized agent, turns a command into the runtime client's command line
 * and the container it will start. The commands execute code the agent wrote, so when the agent
 * was kept in a container they must be too; each gets its own container, with the agent's
 * lifecycle (name recorded before it can exist, stopped by name, removed afterwards).
 */
async function runVerification(o: {
  commands: readonly VerifyCommand[];
  contain?: (command: VerifyCommand, index: number) => { invocation: VerifyInvocation; box: { runtime: string; name: string } };
  /** Record a container before it can exist, so a crash leaves a name for the next worker to remove. */
  onContainer?: (box: { runtime: string; name: string }) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  log: (lines: string[]) => Promise<void>;
  timeoutMinutes: number;
  stop: AbortSignal;
  killGraceMs: number;
  now: () => number;
  git?: string;
  /** Record a started command's pid; hand `recording` the promise that settles once its start time is recorded too. */
  onSpawn: (pid: number, recording: (done: Promise<void>) => void) => void;
}): Promise<VerificationRun> {
  // Quoted without escaping: the command is shown as the user wrote it in the config.
  const quoted = (c: VerifyCommand) => `"${displayVerifyCommand(c)}"`;
  const deadline = o.now() + Math.round(o.timeoutMinutes * 60_000);
  const results: VerificationCommandResult[] = [];
  let failure: VerificationRun['failure'] = null;
  // The commit these commands are about to test, and whether the tree is exactly that commit.
  const sha = await headCommit(o.cwd, o.git);
  const untrusted = Boolean(o.contain);
  const uncommittedBefore = await countUncommitted(o.cwd, o.git, untrusted);
  await o.log(['', `---- verification (run by the worker: ${o.commands.length} command(s), ${o.timeoutMinutes} min in total) ----`]);

  for (const [i, command] of o.commands.entries()) {
    const shown = displayVerifyCommand(command);
    if (failure) {
      results.push({ command: shown, status: 'not_run', exitCode: null, seconds: 0 });
      continue;
    }
    if (o.stop.aborted) {
      results.push({ command: shown, status: 'not_run', exitCode: null, seconds: 0 });
      failure = { outcome: 'interrupted', error: `worker stopped during verification, before ${quoted(command)} started` };
      continue;
    }
    let invocation: VerifyInvocation;
    let box: { runtime: string; name: string } | null = null;
    try {
      if (o.contain) ({ invocation, box } = o.contain(command, i));
      else invocation = verifyInvocation(command);
    } catch (err) {
      results.push({ command: shown, status: 'failed', exitCode: null, seconds: 0 });
      failure = { outcome: 'failed', error: `verification failed: ${quoted(command)}: ${message(err)}` };
      await o.log([`---- verify ${i + 1}/${o.commands.length}: ${shown} ----`, `error: ${message(err)}`]);
      continue;
    }
    if (box) {
      o.onContainer?.(box);
      trackContainer(box.runtime, box.name, o.env);
    }
    const held = box;
    await o.log([`---- verify ${i + 1}/${o.commands.length}: ${shown} ----`, `command: ${JSON.stringify([invocation.file, ...invocation.args])}`]);
    const startedAt = o.now();
    let identity: Promise<void> = Promise.resolve();
    let ran: AgentRun;
    try {
      ran = await runAgent({
        invocation,
        what: 'verify command',
        cwd: o.cwd,
        env: o.env,
        logPath: o.logPath,
        // Past the limit already: the command still starts, so the failure is reported as its timeout.
        timeoutMs: Math.max(1, deadline - startedAt),
        stop: o.stop,
        killGraceMs: o.killGraceMs,
        ...(held ? { stopContainer: () => stopContainer(held.runtime, held.name, o.killGraceMs, o.env) } : {}),
        onSpawn: (pid) =>
          o.onSpawn(pid, (done) => {
            identity = done;
          }),
      });
    } catch (err) {
      if (held) {
        await forceRemoveContainer(held.runtime, held.name, o.env);
        untrackContainer(held.name);
      }
      // Not started (no such executable), or started and stopped because it could not be recorded.
      await identity;
      results.push({ command: shown, status: 'failed', exitCode: null, seconds: Math.round((o.now() - startedAt) / 1000) });
      failure = { outcome: 'failed', error: `verification failed: ${quoted(command)}: ${message(err)}` };
      await o.log([`error: ${message(err)}`]);
      continue;
    }
    await identity; // never record anything for a command after it is finished
    if (held) {
      // As for the agent: --rm normally removed it already; make sure nothing is left.
      await forceRemoveContainer(held.runtime, held.name, o.env);
      untrackContainer(held.name);
    }
    const seconds = Math.round((o.now() - startedAt) / 1000);
    const exit = ran.code !== null ? `code ${ran.code}` : `signal ${ran.signal ?? 'unknown'}`;
    await o.log([
      `exit: ${exit} after ${seconds}s${ran.stopped ? ` (stopped by the worker: ${ran.stopped})` : ''}`,
      ...(ran.leftovers ? ['note: processes the command left running in its process group were stopped'] : []),
    ]);
    if (ran.stopped === 'shutdown') {
      results.push({ command: shown, status: 'interrupted', exitCode: null, seconds });
      failure = { outcome: 'interrupted', error: `worker stopped during verification; the process tree of ${quoted(command)} was stopped` };
    } else if (ran.stopped === 'timeout') {
      results.push({ command: shown, status: 'timed_out', exitCode: null, seconds });
      failure = {
        outcome: 'failed',
        error: `verification failed: ${quoted(command)} timed out (the verify commands have ${o.timeoutMinutes} min in total); its process tree was stopped`,
      };
    } else if (ran.code === 0) {
      results.push({ command: shown, status: 'passed', exitCode: 0, seconds });
    } else {
      results.push({ command: shown, status: 'failed', exitCode: ran.code, seconds });
      failure = {
        outcome: 'failed',
        error: `verification failed: ${quoted(command)} ${ran.code !== null ? `exited ${ran.code}` : `was killed by ${ran.signal ?? 'a signal'}`}`,
      };
    }
  }

  const uncommittedAfter = await countUncommitted(o.cwd, o.git, untrusted);
  await o.log([`---- end of verification: ${failure ? (failure.outcome === 'interrupted' ? 'interrupted' : 'failed') : 'passed'} ----`]);
  // Exact only if nothing but the commit was there to test, and the commands did not move HEAD.
  // For a contained agent the counts above did not look inside submodules (host git must not),
  // so with any submodule in the tree it is unknown whether only the commit was there.
  const uninspected = untrusted ? (await hasSubmodules(o.cwd, o.git)) !== false : false;
  const exact = sha !== null && uncommittedBefore === 0 && !uninspected && (await headCommit(o.cwd, o.git)) === sha;
  return { summary: { passed: failure === null, commands: results, uncommittedBefore, uncommittedAfter, sha, exact, ...(uninspected ? { submodulesNotInspected: true } : {}) }, failure };
}

/** Byte size of a file, 0 if it doesn't exist. */
async function sizeOf(p: string): Promise<number> {
  try {
    return (await stat(p)).size;
  } catch {
    return 0;
  }
}

export class LiveExecutor implements Executor {
  readonly name = 'live';

  constructor(private readonly opts: LiveExecutorOptions = {}) {}

  async execute(claim: Claim, ctx: ExecutionContext): Promise<ExecutionResult> {
    const request = reviewOf(claim.job);
    if (!request) return this.run(claim, ctx, null);
    // A reviewer run (review-run.ts) publishes nothing: its worktree and branch are removed
    // whatever the outcome, including a failure, a timeout, a cancel and a worker shutdown.
    const review: ReviewRunState = { request, worktree: null };
    try {
      return await this.run(claim, ctx, review);
    } finally {
      await discardReviewWorktree(review, { git: this.opts.git, logPath: claim.run.logPath ?? join(ctx.paths.runsDir, claim.run.id, 'run.log') });
      if (review.worktree) {
        try {
          ctx.recordProcess({ checkoutPath: null });
        } catch {
          // the run row keeps a path that no longer exists; `updraft clean` copes with that
        }
      }
    }
  }

  private async run(claim: Claim, ctx: ExecutionContext, review: ReviewRunState | null): Promise<ExecutionResult> {
    const { job, run } = claim;
    const logPath = run.logPath ?? join(ctx.paths.runsDir, run.id, 'run.log');
    const runDir = dirname(logPath);
    await mkdir(runDir, { recursive: true });
    const log = (lines: string[]) => appendFile(logPath, `${lines.join('\n')}\n`, 'utf8');

    const action = ownEntry(ctx.config.actions, job.action);
    const agentCfg = ownEntry(ctx.config.agents, run.agent);
    const adapterName = agentCfg ? agentAdapter(run.agent, agentCfg) : null;
    const found = findRepoConfig(ctx.config, job);
    const checkoutSource = found?.repo.checkoutPath ? resolve(ctx.paths.configDir, found.repo.checkoutPath) : null;
    // A revision job (repositories.<repo>.revise) differs in three places only: its prompt is the
    // action's revisePrompt plus the review, its worktree starts at the PR branch's remote head
    // instead of the base branch, and what is pushed afterwards (src/publish/revision.ts).
    const revision = revisionOf(job);
    const promptKey = review ? 'reviewPrompt' : revision ? 'revisePrompt' : 'prompt';
    const promptSource = resolvePromptPath(ctx.config, ctx.paths, job.action, promptKey);
    const env = job.envelope;
    const timeoutMinutes = action?.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
    // An implementation run of a repository with dependencies may wait on another repository's
    // pull request (docs/dependencies.md); a follow-up run is told what it waited on.
    const resume = resumeOf(job);
    const dependencies = !review && !revision && env.type === 'issue.labeled' && found ? dependencySettings(ctx.config, found.repo) : null;
    const waitsLeft = MAX_DEPENDENCY_WAITS - (resume?.waits ?? 0);

    await writeFile(
      logPath,
      [
        `updraft run ${run.id}`,
        `written: ${new Date(ctx.now()).toISOString()}`,
        'mode: live. The routed agent runs in the job worktree.',
        '',
        `job: ${job.id} (attempt ${run.attempt})`,
        `repository: ${job.repoFullName} (id ${job.repoId})`,
        `issue: #${env.issue.number} ${env.issue.title}`,
        `issue url: ${env.issue.url}`,
        `workflow: ${job.workflowId}`,
        ...(revision
          ? [
              `trigger: ${env.type} (${revision.trigger}) by ${revision.review.author} at ${revision.review.submittedAt}`,
              `pull request: #${revision.pullRequest.number} ${revision.pullRequest.url}`,
              `review: ${revision.review.url} (${revision.review.comments.length} inline comment(s), as read when it was ingested)`,
            ]
          : review
            ? [
                `trigger: ${env.type} of head ${review.request.headSha}`,
                `pull request: #${review.request.pullRequest.number} ${review.request.pullRequest.url}`,
                `code written by agent: ${review.request.authorAgent ?? '(unknown)'}; this run reviews it and publishes nothing`,
              ]
            : [
                `trigger: ${env.type} label "${env.label}" by ${env.actor ?? '(unknown actor)'} at ${env.createdAt}`,
                ...(resume
                  ? [
                      `continues: job ${resume.waitingJobId} (run ${resume.waitingRunId}), which waited on ${resume.pullRequest.repo}#${resume.pullRequest.number}; ` +
                        `merged ${resume.pullRequest.mergedAt ?? '(time unknown)'}`,
                    ]
                  : []),
              ]),
        '',
        `pool: ${run.pool}`,
        `agent: ${run.agent}${adapterName ? ` (adapter ${adapterName})` : ' (no longer configured)'}`,
        ...(agentCfg && adapterName ? [describeProfile(run.agent, adapterName, agentProfile(adapterName, agentCfg))] : []),
        `action: ${job.action}${action ? ` (output ${action.output}, timeout ${timeoutMinutes} min)` : ' (no longer configured)'}`,
        `prompt: ${promptSource ?? '(none configured)'}`,
        `run log: ${logPath}`,
        '',
      ].join('\n'),
      'utf8',
    );

    const fail = async (outcome: RunOutcome, error: string): Promise<ExecutionResult> => {
      await log([`error: ${error}`, `outcome: ${outcome}`]);
      ctx.log.warn('live run did not start an agent', { outcome, error, logPath });
      return { outcome, error };
    };

    if (!action) return fail('failed', `action "${job.action}" is no longer configured`);
    if (action.output !== 'local-branch') {
      await log([`agent: not started (action output is ${action.output}; live mode runs agents only for local-branch actions)`]);
      return { outcome: 'succeeded' };
    }
    if (!agentCfg || !adapterName) return fail('start_failed', `agent "${run.agent}" is no longer configured`);
    const adapter: AgentAdapter | null = getAdapter(adapterName);
    if (!adapter) {
      const why = `no live adapter is implemented for "${adapterName}"`;
      await log([`error: ${why}`, 'outcome: start_failed']);
      throw new StartFailedError(why);
    }
    if (!found || !checkoutSource) {
      return fail('failed', `repositories.${found?.fullName ?? job.repoFullName}.checkoutPath is not set; live mode needs a local clone`);
    }
    if (!promptSource) {
      return fail('failed', `actions.${job.action}.${promptKey} is not set; ${review ? 'a reviewer run' : revision ? 'a revision run' : 'live mode'} needs a prompt`);
    }
    const stopping = () => ctx.signal.aborted || Boolean(ctx.workerStopping?.aborted);
    // Who stopped the run, for run.log and the error. A user cancel is still reported as
    // 'interrupted' here; the daemon records it as canceled.
    const stopper = () => (canceledByUser(ctx.signal) ? 'canceled by user' : 'worker stopped');
    if (stopping()) return fail('interrupted', `${stopper()} before the agent started`);

    // 1. Prompt: the action's prompt plus the issue, as untrusted input, in a file.
    let actionPrompt: string;
    try {
      actionPrompt = await readFile(promptSource, 'utf8');
    } catch (err) {
      return fail('failed', `could not read prompt file ${promptSource}: ${message(err)}`);
    }
    const issue: IssueContext = {
      repoFullName: job.repoFullName,
      number: env.issue.number,
      title: ctx.issue?.title ?? env.issue.title,
      body: ctx.issue && !ctx.issue.withheld ? ctx.issue.body : null,
      labels: ctx.issue?.labels ?? env.labelsAtEnqueue,
      url: ctx.issue?.url ?? env.issue.url,
    };
    const promptFile = join(runDir, 'prompt.md');
    // A reviewer's prompt names the base commit, which is only known once the clone was fetched (step 3).
    const reviewPrompt = (r: ReviewRunState, base: { baseBranch: string | null; baseSha: string | null }) =>
      renderReviewPrompt(actionPrompt, issue, r.request, { headSha: r.request.headSha, baseBranch: base.baseBranch, baseSha: base.baseSha });
    await writeFile(
      promptFile,
      review
        ? reviewPrompt(review, { baseBranch: review.request.pullRequest.baseBranch, baseSha: null })
        : revision
          ? renderRevisionPrompt(actionPrompt, issue, revision)
          : renderPrompt(actionPrompt, issue, [
              ...(resume ? dependencyMergedSection(resume) : []),
              ...(dependencies ? dependencyProtocolSection(dependencies.repositories, { waitsLeft }) : []),
            ]),
      'utf8',
    );
    if (ctx.issue?.withheld) await log([`issue body: withheld from the agent (${ctx.issue.withheld})`]);

    // 2. Find the CLI before touching the clone, so a missing binary leaves no worktree behind.
    const baseEnv = withoutKeys(this.opts.env ?? process.env, WITHHELD_ENV);
    const lookup = { env: agentLookupEnv(this.opts.env ?? process.env, agentCfg), configDir: ctx.paths.configDir };
    // Containerized: the CLI is a name inside the image, so host discovery doesn't apply; what
    // must be on the host is the runtime and the image.
    const containerReady = agentCfg.container ? await checkContainerReady(agentCfg.container, lookup) : null;
    const located: LocatedLaunch = containerReady
      ? containerReady.runtime
        ? { path: null, launch: containerLaunch(adapterName, agentCfg) }
        : { path: null, launch: null, problem: containerReady.problem }
      : (this.opts.locate ?? defaultLocate)(adapterName, agentCfg, lookup);
    if (!located.launch) {
      const why = `${run.agent} cannot start: ${located.problem ?? 'agent CLI not found'}`;
      await log([`error: ${why}`, 'outcome: start_failed']);
      throw new StartFailedError(why);
    }

    // Who the agent commits as, when that is the GitHub App's bot. Asked before the worktree
    // exists, so a failure leaves nothing behind; commits are never rewritten afterwards.
    let commitEnv: Record<string, string> | undefined;
    let committer: CommitIdentity | null = null;
    if (this.opts.commitIdentity) {
      try {
        committer = await this.opts.commitIdentity(found.fullName);
      } catch (err) {
        return fail('failed', `could not find the GitHub App's commit identity (github.app.commitAsApp): ${message(err)}`);
      }
      if (committer) commitEnv = commitIdentityEnv(committer);
    }

    // 3. Worktree. A failure here is the job's problem, not the agent's: failed, not start_failed.
    const branch = jobBranchName(job, run.attempt);
    const worktreePath = jobWorktreePath(ctx.paths, job, run.attempt);
    let prepared: PreparedWorktree;
    let checkout: string | null = null;
    let networkGit: Awaited<ReturnType<NonNullable<LiveExecutorOptions['networkGit']>>> = null;
    if (this.opts.networkGit) {
      try {
        networkGit = await this.opts.networkGit({ repoFullName: found.fullName, checkoutPath: checkoutSource });
      } catch (err) {
        return fail('failed', `could not get the worker's GitHub credentials for the fetch: ${message(err)}`);
      }
    }
    try {
      prepared = await prepareJobWorktree({
        checkoutPath: checkoutSource,
        repoFullName: found.fullName,
        remote: found.repo.remote,
        // A revision builds on whatever the PR branch holds on the remote now, including commits
        // a person pushed to it; its own branch and worktree are new, like any attempt's.
        // A reviewer run gets exactly the commit it was queued for, on a branch nobody keeps.
        baseBranch: review ? review.request.pullRequest.branch : revision ? revision.pullRequest.branch : found.repo.baseBranch,
        ...(review ? { atSha: review.request.headSha } : {}),
        branch,
        worktreePath,
        git: this.opts.git,
        networkEnv: networkGit?.env,
        signal: ctx.workerStopping ? AbortSignal.any([ctx.signal, ctx.workerStopping]) : ctx.signal,
        onCheckout: (path) => {
          checkout = path;
          if (review) review.worktree = { checkoutPath: checkoutSource, worktreePath: path, branch };
          ctx.recordProcess({ checkoutPath: path });
        },
      });
    } catch (err) {
      await log([
        `source clone: ${checkoutSource}`,
        checkout ? `checkout: ${checkout} (left by the failed preparation; kept for inspection)` : 'checkout: none (preparation failed)',
      ]);
      return fail(stopping() ? 'interrupted' : 'failed', `could not prepare the worktree: ${networkGit ? networkGit.redact(message(err)) : message(err)}`);
    }
    if (stopping()) {
      await log([`checkout: ${prepared.worktreePath}`]);
      return fail('interrupted', `${stopper()} before the agent started`);
    }
    let reviewedBase: { baseBranch: string | null; baseSha: string | null; note?: string } | null = null;
    if (review) {
      reviewedBase = await reviewBase({
        checkoutPath: checkoutSource,
        remote: prepared.remote,
        baseBranch: review.request.pullRequest.baseBranch ?? found.repo.baseBranch,
        headSha: prepared.baseSha,
        git: this.opts.git,
        signal: ctx.workerStopping ? AbortSignal.any([ctx.signal, ctx.workerStopping]) : ctx.signal,
      });
      await writeFile(promptFile, reviewPrompt(review, reviewedBase), 'utf8');
    }

    // 4. Invocation.
    let invocation: AgentInvocation;
    try {
      invocation = adapter.buildInvocation({
        launch: located.launch,
        promptFile,
        worktree: prepared.worktreePath,
        runDir,
        extraArgs: effectiveArgs(adapterName, agentCfg),
        platform: process.platform,
      });
    } catch (err) {
      throw new StartFailedError(`adapter ${adapterName} could not build the agent command: ${message(err)}`, { cause: err });
    }
    const agentEnv = mergeEnv(baseEnv, invocation.env, commitEnv, agentCfg.env);
    const timeoutMs = Math.round(timeoutMinutes * 60_000);
    // Containerized: the same command, started by the runtime client inside a container that
    // sees only the worktree and what git needs. agentEnv stays the client's environment; the
    // container gets the variables named on its command line and nothing else.
    let contained: (ContainedInvocation & { runtime: string }) | null = null;
    // What the adapter asked for, which is what it later interprets the exit against.
    const agentArgs = invocation.args;
    // AgentInvocation.separateStderr: stderr is written apart while the agent runs and appended to
    // run.log afterwards, so what the verdict is read from is stdout alone. Decided before a
    // container wraps the invocation; the runtime client passes the two streams through.
    const stderrPath = invocation.separateStderr === true ? join(runDir, 'agent-stderr.log') : undefined;
    let stderrMoved: Promise<string> | null = null;
    /** Append the agent's stderr to run.log under its own header (once) and return it. '' without separateStderr. */
    const moveStderr = (): Promise<string> =>
      (stderrMoved ??= (async () => {
        if (!stderrPath) return '';
        const text = await readOutput(stderrPath, 0, RAW_OUTPUT_BYTES);
        // A leading empty line: the agent's stdout may not have ended with a newline.
        if (text.trim()) await log(['', '---- agent stderr ----', text.replace(/\r?\n$/, '')]);
        return text;
      })());
    if (agentCfg.container && containerReady?.runtime) {
      try {
        contained = {
          runtime: containerReady.runtime,
          ...containInvocation({
            invocation,
            runtime: containerReady.runtime,
            container: agentCfg.container,
            runId: run.id,
            worktree: prepared.worktreePath,
            promptFile,
            agentEnv: commitEnv ? { ...commitEnv, ...agentCfg.env } : agentCfg.env,
            readOnlyGit: review !== null,
          }),
        };
      } catch (err) {
        await log([`checkout: ${prepared.worktreePath}`]);
        return fail('failed', `could not set up the container for ${run.agent}: ${message(err)}`);
      }
      invocation = contained.invocation;
    }
    await log([
      `source clone: ${checkoutSource}`,
      `remote: ${prepared.remote} (${prepared.remoteUrl})`,
      `base: ${prepared.baseBranch} at ${prepared.baseSha}${revision ? ` (the head of pull request #${revision.pullRequest.number}; only a fast-forward from this commit is pushed)` : ''}${review ? ' (the commit under review; nothing from this run is pushed)' : ''}`,
      ...(reviewedBase ? [`review base: ${reviewedBase.baseBranch ?? '(unknown branch)'} at ${reviewedBase.baseSha ?? '(unknown)'}${reviewedBase.note ? ` (${reviewedBase.note})` : ''}`] : []),
      `branch: ${prepared.branch}`,
      `checkout: ${prepared.worktreePath}`,
      '',
      `agent cli: ${located.path ?? located.launch.file}${contained ? ` (inside image ${agentCfg.container!.image})` : ''}`,
      ...(contained
        ? [
            `container: ${contained.name} (runtime ${contained.runtime})`,
            `  env passed by name: ${contained.envNames.length ? contained.envNames.join(', ') : '(none)'}`,
            ...contained.mounts.map((m) => `  mount (${m.readOnly ? 'read-only' : 'read-write'}): ${m.path}`),
          ]
        : []),
      `command: ${JSON.stringify([invocation.file, ...invocation.args])}`,
      `prompt file: ${promptFile} (${invocation.promptVia === 'stdin' ? 'on stdin' : 'passed by path'})`,
      ...(agentCfg.env && Object.keys(agentCfg.env).length ? [`env from config: ${Object.keys(agentCfg.env).join(', ')}`] : []),
      ...(committer ? [`commit identity: ${committer.name} <${committer.email}> (github.app.commitAsApp)`] : []),
      `timeout: ${timeoutMinutes} min`,
      '',
      stderrPath ? '---- agent output (stdout; stderr follows once the agent has exited) ----' : '---- agent output (stdout and stderr) ----',
    ]);
    const outputStart = await sizeOf(logPath);

    // 5. Run. The pid is recorded at once; its start time follows (reading it can take a moment).
    const startedAt = ctx.now();
    let identity: Promise<void> = Promise.resolve();
    let agentRun: AgentRun;
    const killGraceMs = this.opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const box = contained;
    if (box) {
      // Recorded before the container can exist, so a crash at any later point leaves a name to remove.
      ctx.recordProcess({ container: { runtime: box.runtime, name: box.name } });
      trackContainer(box.runtime, box.name, agentEnv);
    }
    try {
      agentRun = await runAgent({
        invocation,
        cwd: prepared.worktreePath,
        env: agentEnv,
        logPath,
        ...(stderrPath ? { stderrPath } : {}),
        promptFile,
        timeoutMs,
        stop: ctx.workerStopping ? AbortSignal.any([ctx.signal, ctx.workerStopping]) : ctx.signal,
        killGraceMs,
        ...(box ? { stopContainer: () => stopContainer(box.runtime, box.name, killGraceMs, agentEnv) } : {}),
        onSpawn: (pid) => {
          ctx.recordProcess({ pid });
          ctx.log.info('agent started', { pid, worktree: prepared.worktreePath });
          identity = (this.opts.startTime ?? processStartTime)(pid)
            .then((startTime) => {
              if (startTime) ctx.recordProcess({ pidStartTime: startTime });
              else ctx.log.warn('could not read the agent process start time; a later worker will not signal it', { pid });
            })
            .catch((err: unknown) => ctx.log.warn('could not record the agent process start time', { pid, error: message(err) }));
        },
      });
    } catch (err) {
      const why = message(err);
      await moveStderr();
      if (err instanceof AgentStoppedError) {
        await log(['---- end of agent output ----', `error: ${why}`, 'outcome: failed', ...(review ? [] : [`The worktree is kept for inspection: ${prepared.worktreePath}`])]);
        ctx.log.warn('agent stopped after it started', { error: why, logPath });
        return { outcome: 'failed', error: why };
      }
      await log(['---- end of agent output ----', `error: ${why}`, 'outcome: start_failed']);
      ctx.log.warn('agent could not start', { error: why, logPath });
      throw err instanceof StartFailedError ? err : new StartFailedError(why, { cause: err });
    } finally {
      if (box) {
        // --rm removes the container when its command exits. If the client died first (killed
        // from outside, a runtime restart) the container may still be there: make sure it isn't.
        await forceRemoveContainer(box.runtime, box.name, agentEnv);
        untrackContainer(box.name);
      }
    }
    const seconds = Math.round((ctx.now() - startedAt) / 1000);
    await identity; // never record anything for this run after it is finished

    // 6. Outcome.
    // Read before the stderr is appended: with separateStderr this is the agent's stdout alone.
    const outputTail = await tailLines(logPath, outputStart);
    const agentOutput = adapter.interpretExit || adapter.summarizeOutput || review || dependencies ? await readOutput(logPath, outputStart, RAW_OUTPUT_BYTES) : '';
    const stderrText = await moveStderr();
    // What exit interpretation and summaries see: stdout, then stderr (an error is often only there).
    const rawOutput = stderrText.trim() ? (agentOutput ? `${agentOutput.replace(/\r?\n$/, '')}\n${stderrText}` : stderrText) : agentOutput;
    let lastOutput = outputTail;
    if (adapter.summarizeOutput) {
      try {
        const lines = adapter.summarizeOutput(rawOutput);
        if (lines?.length) lastOutput = cleanSummaryLines(lines);
      } catch (err) {
        ctx.log.warn('adapter could not summarize the agent output; using its last lines', { adapter: adapterName, error: message(err) });
      }
    }
    let outcome: RunOutcome;
    let error: string | undefined;
    let cliFailureOutput: string | undefined;
    if (agentRun.stopped === 'timeout') {
      outcome = 'failed';
      error = `agent timed out after ${timeoutMinutes} min; its process tree was stopped`;
    } else if (agentRun.stopped === 'shutdown') {
      outcome = 'interrupted';
      error = `${stopper()} before the run finished; the agent process tree was stopped`;
    } else {
      const exit = { code: agentRun.code, signal: agentRun.signal, outputTail, output: rawOutput, args: agentArgs };
      let verdict = defaultVerdict(exit);
      if (adapter.interpretExit) {
        try {
          verdict = adapter.interpretExit(exit);
        } catch (err) {
          ctx.log.warn('adapter could not interpret the agent exit; judging by exit code', { adapter: adapterName, error: message(err) });
        }
      }
      outcome = verdict.outcome;
      error = verdict.error ?? (outcome === 'failed' ? defaultVerdict(exit).error : undefined);
      if (outcome === 'failed') cliFailureOutput = rawOutput || outputTail.join('\n');
      if (box && agentRun.code === CONTAINER_RUN_FAILED) {
        // The code the runtime exits with when it fails itself (bad option, daemon gone, name in use).
        outcome = 'failed';
        error = `${box.runtime} could not start the container (exit ${CONTAINER_RUN_FAILED})${outputTail.length ? `: ${outputTail[outputTail.length - 1]}` : ''}`;
      }
    }

    await log([
      '---- end of agent output ----',
      `exit: ${agentRun.code !== null ? `code ${agentRun.code}` : `signal ${agentRun.signal ?? 'unknown'}`} after ${seconds}s` +
        (agentRun.stopped ? ` (stopped by the worker: ${agentRun.stopped})` : ''),
      ...(agentRun.leftovers ? ['note: processes the agent left running in its process group were stopped'] : []),
    ]);

    // 6a. A declared wait (docs/dependencies.md): read from the agent's own final message, and only
    // honored for a pull request the config allows. A valid one means nothing of this run is
    // published, so there is nothing for the verify commands to check.
    let dependency: DeclaredDependency | undefined;
    if (dependencies && outcome === 'succeeded') {
      const declared = readDependency(adapter, agentOutput || outputTail.join('\n'), dependencies, waitsLeft);
      if (declared.ok) {
        dependency = declared.dependency;
        await log([
          `waiting on: ${declared.dependency.repo}#${declared.dependency.number} (UPDRAFT-WAITING-ON); nothing from this run is published, ` +
            'and the issue runs again once that pull request is merged',
        ]);
      } else if (declared.problem) {
        await log([`waiting on: none (${declared.problem}); the run ends as it would without the line`]);
      }
    }

    // 6b. Verification: the worker's own check of what a successful agent left, before the run
    // counts as succeeded (and so before anything can be published). The commands run code the
    // agent wrote, so they get the worker's environment without the GitHub tokens, like the agent;
    // agents.<name>.env is the agent's own configuration and is not passed on.
    // A containerized agent's commands run in containers from the same image with the same
    // mounts, network and extra arguments, but none of the variables named in container.env:
    // those are the agent's credentials, and checking its work does not need them.
    let verification: VerificationSummary | undefined;
    // Not for a reviewer run: the commands ran for the code run that produced the commit under review.
    if (outcome === 'succeeded' && action.verify?.length && !review && dependency) {
      await log(['verification: skipped (the run is waiting on another pull request; nothing from it is published)']);
    } else if (outcome === 'succeeded' && action.verify?.length && !review) {
      const verified = await runVerification({
        commands: action.verify,
        ...(box && agentCfg.container
          ? {
              contain: (command: VerifyCommand, index: number) => {
                const verifyMounts = box.mounts.filter((m) => m.path !== promptFile);
                // Inside the container it is always a POSIX shell, whatever the host is.
                const inner = verifyInvocation(command, 'linux');
                const name = containerName(run.id, `verify-${index + 1}`);
                const args = buildContainerRunArgs(
                  { file: inner.file, args: inner.args },
                  {
                    image: agentCfg.container!.image,
                    name,
                    // The plan made before the agent started, not a new one: the object store it
                    // would be read from has been the agent's to write since.
                    mounts: verifyMounts,
                    workdir: prepared.worktreePath,
                    user: hostUser(),
                    network: agentCfg.container!.network,
                    runLabel: run.id,
                    extraArgs: agentCfg.container!.args,
                  },
                );
                return { invocation: { file: box.runtime, args, verbatim: false }, box: { runtime: box.runtime, name } };
              },
              onContainer: (c: { runtime: string; name: string }) => ctx.recordProcess({ container: c }),
            }
          : {}),
        cwd: prepared.worktreePath,
        env: baseEnv,
        logPath,
        log,
        timeoutMinutes: action.verifyTimeoutMinutes ?? DEFAULT_VERIFY_TIMEOUT_MINUTES,
        stop: ctx.workerStopping ? AbortSignal.any([ctx.signal, ctx.workerStopping]) : ctx.signal,
        killGraceMs: this.opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
        now: ctx.now,
        git: this.opts.git,
        onSpawn: (pid, recording) => {
          // Replaces the agent's pid (it has exited): from here this is the process to reap after a crash.
          ctx.recordProcess({ pid });
          ctx.log.info('verify command started', { pid, worktree: prepared.worktreePath });
          recording(
            (this.opts.startTime ?? processStartTime)(pid)
              .then((startTime) => {
                if (startTime) ctx.recordProcess({ pidStartTime: startTime });
                else ctx.log.warn('could not read the verify command start time; a later worker will not signal it', { pid });
              })
              .catch((err: unknown) => ctx.log.warn('could not record the verify command start time', { pid, error: message(err) })),
          );
        },
      });
      verification = verified.summary;
      if (verified.failure) ({ outcome, error } = verified.failure);
    }

    // 6c. A reviewer run succeeded only if its final message carries a verdict that can be read.
    // Anything else (no line, two lines, another value) fails the run; it is never an approval.
    let reviewResult: ReviewResult | undefined;
    if (review && outcome === 'succeeded') {
      // The agent's own output: with separateStderr, stdout alone, so nothing it logged can land on the verdict line.
      const parsed = readReviewVerdict(adapter, agentOutput);
      if (parsed.ok) {
        reviewResult = {
          headSha: prepared.baseSha,
          baseSha: reviewedBase?.baseSha ?? null,
          verdict: parsed.verdict,
          findings: parsed.findings,
          findingsCount: parsed.findingsCount,
        };
        await log([`review verdict for ${prepared.baseSha}: ${parsed.verdict}`]);
        // Telemetry only: a missing or malformed count says so here and changes nothing else.
        if (parsed.findingsCount === null) await log([`review findings count: none (${parsed.findingsCountProblem}); the verdict is unaffected`]);
      } else {
        outcome = 'failed';
        error = `no verdict: ${parsed.problem}`;
        await log([`review verdict for ${prepared.baseSha}: none (${parsed.problem})`]);
      }
    }

    // 7. Summary.
    let summary: RunSummary | null = null;
    const tail: string[] = ['', 'summary:'];
    try {
      const detail = await summarizeRun({
        worktree: prepared.worktreePath,
        branch: prepared.branch,
        baseSha: prepared.baseSha,
        lastOutput,
        git: this.opts.git,
        untrustedWorktree: Boolean(box),
      });
      summary = detail.summary;
      if (verification) summary.verification = verification;
      if (reviewResult) summary.review = reviewResult;
      tail.push(...renderSummary(detail).map((l) => `  ${l}`));
    } catch (err) {
      tail.push(`  could not summarize the run: ${message(err)}`);
    }
    if (reviewResult && !summary) {
      // The verdict travels in the summary; without one there is nothing to post or act on.
      outcome = 'failed';
      error = 'the review result could not be recorded';
    }
    tail.push('', `outcome: ${outcome}${error ? ` (${error})` : ''}`);
    if (outcome !== 'succeeded' && !review) tail.push(`The worktree is kept for inspection: ${prepared.worktreePath}`);
    await log(tail);
    ctx.log.info('agent finished', { outcome, ...(error ? { error } : {}), seconds, logPath });
    const escalationRequest = !review && agentOutput.toLowerCase().includes(ESCALATION_MARKER) ? agentOutput : undefined;
    return {
      outcome,
      ...(error ? { error } : {}),
      summary,
      ...(cliFailureOutput && outcome === 'failed' ? { cliOutput: cliFailureOutput.slice(-RAW_OUTPUT_BYTES) } : {}),
      ...(escalationRequest ? { escalationRequest } : {}),
      ...(dependency && outcome === 'succeeded' ? { dependency } : {}),
    };
  }
}
