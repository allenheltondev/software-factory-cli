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
import { defaultDiscoveryProbes, locateLaunch, type LocatedLaunch } from '../agents/discovery.js';
import { renderPrompt, type IssueContext } from '../agents/prompt.js';
import { agentAdapter, DEFAULT_TIMEOUT_MINUTES, type AdapterName, type AgentConfig } from '../config/schema.js';
import { ownEntry, type Claim } from '../db/queue.js';
import { jobBranchName, jobWorktreePath, prepareJobWorktree, type PreparedWorktree } from '../git/worktree.js';
import type { RunOutcome, RunSummary } from '../types.js';
import {
  canceledByUser,
  findRepoConfig,
  resolvePromptPath,
  StartFailedError,
  type ExecutionContext,
  type ExecutionResult,
  type Executor,
} from './executor.js';
import { processStartTime, taskkillPath } from './process.js';
import { cleanSummaryLines, readOutput, renderSummary, summarizeRun, tailLines } from './run-summary.js';

const isWindows = process.platform === 'win32';
const DEFAULT_KILL_GRACE_MS = 5_000;
/** After SIGKILL / taskkill, how long to wait for the exit event before giving up on it. */
const EXIT_WAIT_MS = 10_000;
/** Variables the worker may hold for its own GitHub access; an agent working on untrusted input doesn't get them. */
const WITHHELD_ENV = ['GH_TOKEN', 'GITHUB_TOKEN'];

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
 * tokens it withholds, plus agents.<name>.env. `factory doctor` uses the same rule, so it checks
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
 * Spawn the agent and wait for it. Rejects with StartFailedError when the process can't be
 * started; once it has started, always resolves.
 */
async function runAgent(o: {
  invocation: AgentInvocation;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  promptFile: string;
  timeoutMs: number;
  stop: AbortSignal;
  killGraceMs: number;
  onSpawn: (pid: number) => void;
}): Promise<AgentRun> {
  const inv = o.invocation;
  let child: ChildProcess;
  const out = openSync(o.logPath, 'a');
  let stdin: number | 'ignore' = 'ignore';
  try {
    if (inv.promptVia === 'stdin') stdin = openSync(o.promptFile, 'r');
    child = spawn(inv.file, inv.args, {
      cwd: o.cwd,
      env: o.env,
      shell: false,
      windowsHide: true,
      detached: !isWindows,
      stdio: [stdin, out, out],
    });
  } catch (err) {
    throw new StartFailedError(`could not start ${inv.file}: ${message(err)}`, { cause: err });
  } finally {
    // The child has its own copies now.
    closeSync(out);
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
    await Promise.race([isWindows ? taskkillTree(child) : stopGroup(pid, o.killGraceMs), idle(o.killGraceMs + EXIT_WAIT_MS)]);
    await Promise.race([exit, idle(EXIT_WAIT_MS)]);
    if (!isWindows && groupAlive(pid)) await stopGroup(pid, Math.min(o.killGraceMs, 2_000));
    if (!exited) running.delete(child);
    throw new AgentStoppedError(`could not record the started agent process (${message(err)}); it was stopped`, { cause: err });
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
    killing = isWindows ? taskkillTree(child) : stopGroup(pid, o.killGraceMs);
    giveUpTimer = setTimeout(giveUp, o.killGraceMs + EXIT_WAIT_MS);
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
  if (killing) await Promise.race([killing, idle(o.killGraceMs + EXIT_WAIT_MS)]);
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
    const promptSource = resolvePromptPath(ctx.config, ctx.paths, job.action);
    const env = job.envelope;
    const timeoutMinutes = action?.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;

    await writeFile(
      logPath,
      [
        `software-factory run ${run.id}`,
        `written: ${new Date(ctx.now()).toISOString()}`,
        'mode: live. The routed agent runs in the job worktree.',
        '',
        `job: ${job.id} (attempt ${run.attempt})`,
        `repository: ${job.repoFullName} (id ${job.repoId})`,
        `issue: #${env.issue.number} ${env.issue.title}`,
        `issue url: ${env.issue.url}`,
        `workflow: ${job.workflowId}`,
        `trigger: ${env.type} label "${env.label}" by ${env.actor ?? '(unknown actor)'} at ${env.createdAt}`,
        '',
        `pool: ${run.pool}`,
        `agent: ${run.agent}${adapterName ? ` (adapter ${adapterName})` : ' (no longer configured)'}`,
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
    if (!promptSource) return fail('failed', `actions.${job.action}.prompt is not set; live mode needs a prompt`);
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
      body: ctx.issue ? ctx.issue.body : null,
      labels: ctx.issue?.labels ?? env.labelsAtEnqueue,
      url: ctx.issue?.url ?? env.issue.url,
    };
    const promptFile = join(runDir, 'prompt.md');
    await writeFile(promptFile, renderPrompt(actionPrompt, issue), 'utf8');

    // 2. Find the CLI before touching the clone, so a missing binary leaves no worktree behind.
    const baseEnv = withoutKeys(this.opts.env ?? process.env, WITHHELD_ENV);
    const located = (this.opts.locate ?? defaultLocate)(adapterName, agentCfg, {
      env: agentLookupEnv(this.opts.env ?? process.env, agentCfg),
      configDir: ctx.paths.configDir,
    });
    if (!located.launch) {
      const why = `${run.agent} cannot start: ${located.problem ?? 'agent CLI not found'}`;
      await log([`error: ${why}`, 'outcome: start_failed']);
      throw new StartFailedError(why);
    }

    // 3. Worktree. A failure here is the job's problem, not the agent's: failed, not start_failed.
    const branch = jobBranchName(job, run.attempt);
    const worktreePath = jobWorktreePath(ctx.paths, job, run.attempt);
    let prepared: PreparedWorktree;
    let checkout: string | null = null;
    try {
      prepared = await prepareJobWorktree({
        checkoutPath: checkoutSource,
        repoFullName: found.fullName,
        remote: found.repo.remote,
        baseBranch: found.repo.baseBranch,
        branch,
        worktreePath,
        git: this.opts.git,
        signal: ctx.workerStopping ? AbortSignal.any([ctx.signal, ctx.workerStopping]) : ctx.signal,
        onCheckout: (path) => {
          checkout = path;
          ctx.recordProcess({ checkoutPath: path });
        },
      });
    } catch (err) {
      await log([
        `source clone: ${checkoutSource}`,
        checkout ? `checkout: ${checkout} (left by the failed preparation; kept for inspection)` : 'checkout: none (preparation failed)',
      ]);
      return fail(stopping() ? 'interrupted' : 'failed', `could not prepare the worktree: ${message(err)}`);
    }
    if (stopping()) {
      await log([`checkout: ${prepared.worktreePath}`]);
      return fail('interrupted', `${stopper()} before the agent started`);
    }

    // 4. Invocation.
    let invocation: AgentInvocation;
    try {
      invocation = adapter.buildInvocation({
        launch: located.launch,
        promptFile,
        worktree: prepared.worktreePath,
        runDir,
        extraArgs: agentCfg.args ?? [],
        platform: process.platform,
      });
    } catch (err) {
      throw new StartFailedError(`adapter ${adapterName} could not build the agent command: ${message(err)}`, { cause: err });
    }
    const agentEnv = mergeEnv(baseEnv, invocation.env, agentCfg.env);
    const timeoutMs = Math.round(timeoutMinutes * 60_000);
    await log([
      `source clone: ${checkoutSource}`,
      `remote: ${prepared.remote} (${prepared.remoteUrl})`,
      `base: ${prepared.baseBranch} at ${prepared.baseSha}`,
      `branch: ${prepared.branch}`,
      `checkout: ${prepared.worktreePath}`,
      '',
      `agent cli: ${located.path ?? located.launch.file}`,
      `command: ${JSON.stringify([invocation.file, ...invocation.args])}`,
      `prompt file: ${promptFile} (${invocation.promptVia === 'stdin' ? 'on stdin' : 'passed by path'})`,
      ...(agentCfg.env && Object.keys(agentCfg.env).length ? [`env from config: ${Object.keys(agentCfg.env).join(', ')}`] : []),
      `timeout: ${timeoutMinutes} min`,
      '',
      '---- agent output (stdout and stderr) ----',
    ]);
    const outputStart = await sizeOf(logPath);

    // 5. Run. The pid is recorded at once; its start time follows (reading it can take a moment).
    const startedAt = ctx.now();
    let identity: Promise<void> = Promise.resolve();
    let agentRun: AgentRun;
    try {
      agentRun = await runAgent({
        invocation,
        cwd: prepared.worktreePath,
        env: agentEnv,
        logPath,
        promptFile,
        timeoutMs,
        stop: ctx.workerStopping ? AbortSignal.any([ctx.signal, ctx.workerStopping]) : ctx.signal,
        killGraceMs: this.opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
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
      if (err instanceof AgentStoppedError) {
        await log(['---- end of agent output ----', `error: ${why}`, 'outcome: failed', `The worktree is kept for inspection: ${prepared.worktreePath}`]);
        ctx.log.warn('agent stopped after it started', { error: why, logPath });
        return { outcome: 'failed', error: why };
      }
      await log(['---- end of agent output ----', `error: ${why}`, 'outcome: start_failed']);
      ctx.log.warn('agent could not start', { error: why, logPath });
      throw err instanceof StartFailedError ? err : new StartFailedError(why, { cause: err });
    }
    const seconds = Math.round((ctx.now() - startedAt) / 1000);
    await identity; // never record anything for this run after it is finished

    // 6. Outcome.
    const outputTail = await tailLines(logPath, outputStart);
    const rawOutput = adapter.interpretExit || adapter.summarizeOutput ? await readOutput(logPath, outputStart, RAW_OUTPUT_BYTES) : '';
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
    if (agentRun.stopped === 'timeout') {
      outcome = 'failed';
      error = `agent timed out after ${timeoutMinutes} min; its process tree was stopped`;
    } else if (agentRun.stopped === 'shutdown') {
      outcome = 'interrupted';
      error = `${stopper()} before the run finished; the agent process tree was stopped`;
    } else {
      const exit = { code: agentRun.code, signal: agentRun.signal, outputTail, output: rawOutput, args: invocation.args };
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
    }

    // 7. Summary.
    let summary: RunSummary | null = null;
    const tail: string[] = [
      '---- end of agent output ----',
      `exit: ${agentRun.code !== null ? `code ${agentRun.code}` : `signal ${agentRun.signal ?? 'unknown'}`} after ${seconds}s` +
        (agentRun.stopped ? ` (stopped by the worker: ${agentRun.stopped})` : ''),
      ...(agentRun.leftovers ? ['note: processes the agent left running in its process group were stopped'] : []),
      '',
      'summary:',
    ];
    try {
      const detail = await summarizeRun({
        worktree: prepared.worktreePath,
        branch: prepared.branch,
        baseSha: prepared.baseSha,
        lastOutput,
        git: this.opts.git,
      });
      summary = detail.summary;
      tail.push(...renderSummary(detail).map((l) => `  ${l}`));
    } catch (err) {
      tail.push(`  could not summarize the run: ${message(err)}`);
    }
    tail.push('', `outcome: ${outcome}${error ? ` (${error})` : ''}`);
    if (outcome !== 'succeeded') tail.push(`The worktree is kept for inspection: ${prepared.worktreePath}`);
    await log(tail);
    ctx.log.info('agent finished', { outcome, ...(error ? { error } : {}), seconds, logPath });
    return { outcome, ...(error ? { error } : {}), summary };
  }
}
