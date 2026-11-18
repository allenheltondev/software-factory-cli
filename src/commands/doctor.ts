import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentReport } from '../agents/discovery.js';
import { agentAdapter, autoMergeMethod, DEFAULT_MAX_REVISIONS, publishMode, reviewActive, reviewSettings, reviseActive, workflowId, type RepositoryConfig, type UpdraftConfig } from '../config/schema.js';
import { COMMENT_SCOPES_HINT } from '../publish/failure-comment.js';
import { TOKEN_SCOPES_HINT } from '../publish/publish.js';
import { GitHubError, type GitHubApi } from '../github/api.js';
import type { UpdraftPaths } from '../paths.js';
import { labelEquals } from '../routing.js';
import { agentLookupEnv } from '../worker/live.js';
import { pathEntries, which } from '../util/which.js';
import { println, type CommandContext } from './context.js';
import { checkRepoCheckouts } from './doctor-checkout.js';
import { containerAgentChecks } from './doctor-container.js';
import { EXIT, describeGitHubError } from './errors.js';
import { checkConfig } from './validate.js';

export const MIN_NODE = [22, 13] as const;

/**
 * Severity for agent problems. Only live execution (#8) starts agents, so problems are failures
 * there and warnings in every other mode (log-only, prepare-only, ...).
 */
export function agentProblemSeverity(mode: string): CheckStatus {
  return mode === 'live' ? 'fail' : 'warn';
}

/** Doctor checks for one enabled agent's discovery report. */
export function agentChecks(r: AgentReport | undefined, sev: CheckStatus): Array<Omit<CheckResult, 'name'>> {
  if (!r) return [{ status: sev, detail: 'unknown adapter; not checked' }];
  const out: Array<Omit<CheckResult, 'name'>> = [];
  const notes = r.notes.length ? ` (${r.notes.join('; ')})` : '';
  if (!r.installed) {
    const where = r.configuredCommand ? 'configured command ' + r.command + ' was not found or is not executable' : `${r.command} not found on PATH or in common install locations`;
    out.push({ status: sev, detail: `${where}${sev === 'fail' ? '' : ' (needed in live mode)'}` });
  } else if (r.runnable !== 'yes') {
    out.push({ status: sev, detail: `${r.command} found at ${r.path} but did not run${notes}` });
  } else {
    out.push({ status: 'ok', detail: `${r.command} ${r.version ?? '(unknown version)'}: ${r.path}` });
    if (!r.onPath) out.push({ status: 'warn', detail: `${r.command} is not on this PATH; the worker may not find it${notes}` });
  }
  if (r.signedIn === 'yes') out.push({ status: 'ok', detail: `signed in: ${r.auth ?? 'yes'}` });
  else if (r.signedIn === 'no') out.push({ status: sev, detail: `not signed in: ${r.auth ?? 'no'}` });
  else if (r.runnable === 'yes') out.push({ status: 'warn', detail: `sign-in status unknown${notes}` });
  if (r.platform.supported === 'no') out.push({ status: sev, detail: `not supported on this machine: ${r.platform.detail}` });
  return out;
}

export type CheckStatus = 'ok' | 'warn' | 'fail';

/**
 * Doctor checks for one repository's revision loop and review loop (revise, review), from the
 * config and the prompt files alone: no request. Nothing when both are off.
 */
export function loopChecks(config: UpdraftConfig, fullName: string, repo: RepositoryConfig, configDir: string, fileExists: (path: string) => boolean): Array<Omit<CheckResult, 'name'>> {
  const out: Array<Omit<CheckResult, 'name'>> = [];
  const actions = [...new Set(repo.workflows.map((wf) => wf.action))].filter((a) => config.actions[a]?.output === 'local-branch');
  const promptCheck = (option: 'revise' | 'review', key: 'revisePrompt' | 'reviewPrompt') => {
    for (const a of actions) {
      const file = config.actions[a]?.[key];
      if (!file) out.push({ status: 'fail', detail: `${option}: actions.${a}.${key} is not set` });
      else if (!fileExists(resolve(configDir, file))) out.push({ status: 'fail', detail: `${option}: prompt file ${resolve(configDir, file)} (actions.${a}.${key}) does not exist` });
      else out.push({ status: 'ok', detail: `${option}: prompt ${resolve(configDir, file)} (actions.${a}.${key})` });
    }
  };
  if (repo.revise) {
    if (!reviseActive(config, repo)) out.push({ status: 'warn', detail: 'revise is set but does nothing here: it needs execution.mode live and publish' });
    else {
      promptCheck('revise', 'revisePrompt');
      out.push({ status: 'ok', detail: `revise: up to ${repo.maxRevisions ?? DEFAULT_MAX_REVISIONS} revision(s) per pull request; they are pushed with the same access as publish` });
    }
  }
  const review = reviewSettings(repo);
  if (review.enabled) {
    if (!reviewActive(config, repo)) out.push({ status: 'warn', detail: 'review is set but does nothing here: it needs execution.mode live and publish' });
    else {
      promptCheck('review', 'reviewPrompt');
      const enabledIn = (pool: string) => (config.pools[pool]?.agents ?? []).filter((a) => config.agents[a]?.enabled);
      for (const wf of repo.workflows) {
        const pools = typeof wf.pool === 'string' ? [wf.pool] : [...wf.pool.rules.map((r) => r.use), wf.pool.default];
        for (const p of new Set(pools)) {
          const reviewPool = wf.reviewPool ?? p;
          const reviewers = enabledIn(reviewPool);
          const alone = enabledIn(p).find((author) => reviewers.every((r) => r === author));
          const where = `review: workflow ${workflowId(wf)}, code from pool ${p}, reviewers from pool ${reviewPool}`;
          if (reviewers.length === 0) out.push({ status: 'fail', detail: `${where}: no enabled agent in the review pool` });
          else if (alone === undefined) out.push({ status: 'ok', detail: `${where}: a reviewer other than the author is always available (${reviewers.join(', ')})` });
          else if (review.allowSameAgent) out.push({ status: 'warn', detail: `${where}: ${alone} reviews its own work (review.allowSameAgent)` });
          else out.push({ status: 'fail', detail: `${where}: ${alone} is the only enabled reviewer and also writes the code` });
        }
      }
      if (!repo.revise) out.push({ status: 'warn', detail: 'review: revise is off, so a "changes requested" verdict is only posted' });
    }
  }
  return out;
}

export interface CheckResult {
  status: CheckStatus;
  name: string;
  detail: string;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Everything doctor inspects, injectable for tests. */
export interface DoctorProbes {
  nodeVersion: string;
  platform: NodeJS.Platform;
  cwd: string;
  user: string;
  env: NodeJS.ProcessEnv;
  which(command: string): string | null;
  /** Run an executable directly (no shell). */
  run(file: string, args: string[]): Promise<RunResult>;
  /**
   * Agent discovery (see src/agents/discovery.ts) for one configured agent: its adapter, in `env`,
   * with agents.<name>.command when set. Undefined for an unknown adapter.
   */
  discoverAgent(adapter: string, opts: { env: NodeJS.ProcessEnv; command?: string; baseDir: string }): Promise<AgentReport | undefined>;
  /** Throws if the directory can't be created or written. */
  checkWritable(dir: string): void;
  /** Open (creating/migrating if needed) and close the state DB; throws on failure. */
  checkDb(file: string): void;
  createApi(): Promise<GitHubApi>;
  fileExists(path: string): boolean;
}

export interface EnvironmentSummary {
  cwd: string;
  user: string;
  platform: string;
  node: string;
  configFile: string;
  dataDir: string;
  logDir: string;
  pathEntries: number;
  overrides: Record<string, string>;
}

export interface DoctorReport {
  checks: CheckResult[];
  environment: EnvironmentSummary;
  ok: boolean;
}

export function nodeVersionOk(version: string, min: readonly [number, number] = MIN_NODE): boolean {
  const [maj = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return maj > min[0] || (maj === min[0] && minor >= min[1]);
}

function errMessage(err: unknown): string {
  if (err instanceof GitHubError) return describeGitHubError(err);
  return err instanceof Error ? err.message : String(err);
}

export async function runDoctor(paths: UpdraftPaths, probes: DoctorProbes): Promise<DoctorReport> {
  const checks: CheckResult[] = [];
  const add = (status: CheckStatus, name: string, detail: string) => checks.push({ status, name, detail });

  // Node
  add(
    nodeVersionOk(probes.nodeVersion) ? 'ok' : 'fail',
    'node',
    `v${probes.nodeVersion.replace(/^v/, '')}${nodeVersionOk(probes.nodeVersion) ? '' : ` (need >= ${MIN_NODE.join('.')})`}`,
  );

  // Config
  const cfg = checkConfig(paths.configFile, probes.fileExists);
  let config: UpdraftConfig | null = null;
  if (cfg.state === 'missing') add('fail', 'config', `not found at ${paths.configFile}; run "updraft configure"`);
  else if (cfg.state === 'unreadable') add('fail', 'config', cfg.message);
  else if (cfg.state === 'invalid') {
    add('fail', 'config', `invalid: ${paths.configFile}`);
    for (const e of cfg.errors) add('fail', 'config', `${e.path}: ${e.message}`);
  } else {
    config = cfg.config;
    add('ok', 'config', `valid: ${paths.configFile}`);
    for (const w of cfg.warnings) add('warn', 'config', `${w.path}: ${w.message}`);
  }

  // State directories and DB
  for (const [label, dir] of [
    ['state dir', paths.dataDir],
    ['log dir', paths.logDir],
  ] as const) {
    try {
      probes.checkWritable(dir);
      add('ok', label, `writable: ${dir}`);
    } catch (err) {
      add('fail', label, `not writable: ${dir} (${errMessage(err)})`);
    }
  }
  try {
    probes.checkDb(paths.dbFile);
    add('ok', 'state db', `opens: ${paths.dbFile}`);
  } catch (err) {
    add('fail', 'state db', `cannot open ${paths.dbFile}: ${errMessage(err)}`);
  }

  // git
  const git = probes.which('git');
  if (!git) add('fail', 'git', 'not found on PATH');
  else {
    const v = await probes.run(git, ['--version']).catch(() => null);
    add('ok', 'git', `${git}${v?.code === 0 ? ` (${v.stdout.trim()})` : ''}`);
  }

  // gh and token
  const envToken = Boolean(probes.env.GH_TOKEN || probes.env.GITHUB_TOKEN);
  const gh = probes.which('gh');
  if (!gh) {
    add(envToken ? 'warn' : 'fail', 'gh', `not found on PATH${envToken ? ' (GH_TOKEN/GITHUB_TOKEN is set, so it is optional)' : ''}`);
  } else {
    const auth = await probes.run(gh, ['auth', 'status', '--hostname', 'github.com']).catch((err: unknown) => ({
      code: null,
      stdout: '',
      stderr: errMessage(err),
    }));
    if (auth.code === 0) add('ok', 'gh', `${gh} (authenticated)`);
    else {
      const why = (auth.stderr || auth.stdout).trim().split(/\r?\n/)[0] ?? '';
      add(envToken ? 'warn' : 'fail', 'gh', `${gh} is not authenticated; run "gh auth login"${why ? ` (${why})` : ''}`);
    }
  }

  let api: GitHubApi | null = null;
  try {
    api = await probes.createApi();
    const viewer = await api.getViewer();
    add('ok', 'github', `token works; authenticated as ${viewer.login}`);
    if (config) {
      const actors = new Set(config.dispatch.allowedActors.map((a) => a.toLowerCase()));
      if (actors.size && !actors.has(viewer.login.toLowerCase())) {
        add('warn', 'github', `${viewer.login} is not in dispatch.allowedActors`);
      }
    }
  } catch (err) {
    api = null;
    add('fail', 'github', `cannot use the GitHub API: ${errMessage(err)}`);
  }

  // Repos and labels
  if (config && api) {
    for (const [fullName, repo] of Object.entries(config.repositories)) {
      const name = `repo ${fullName}`;
      try {
        const gr = await api.getRepo(fullName);
        if (gr.id !== repo.id) {
          add('fail', name, `ID mismatch: config has ${repo.id}, GitHub has ${gr.id}; re-run "updraft add ${fullName}"`);
          continue;
        }
        if (gr.fullName.toLowerCase() !== fullName.toLowerCase()) {
          add('warn', name, `renamed to ${gr.fullName} on GitHub; update the config key`);
        }
        add(gr.archived ? 'warn' : 'ok', name, `accessible (id ${gr.id})${gr.archived ? '; archived' : ''}`);
        const publish = publishMode(repo);
        if (publish !== 'none') {
          // Publication pushes and opens PRs as this account; a miss here is a failure only when it would run.
          const sev: CheckStatus = config.execution.mode === 'live' ? 'fail' : 'warn';
          if (gr.permissions === null) {
            add('warn', name, `publish: ${publish}, but GitHub did not report this account's permissions; push access is unverified`);
          } else if (!gr.permissions.push) {
            add(sev, name, `publish: ${publish}, but the active GitHub account has no push access to ${fullName}. ${TOKEN_SCOPES_HINT}`);
          } else {
            add('ok', name, `publish: ${publish}; the active GitHub account can push${gr.private && publish === 'draft-pr' ? ' (private repo: if GitHub refuses draft PRs on your plan, use publish: pr)' : ''}`);
          }
        }
        if (repo.commentOnFailure) {
          // Commenting on an issue needs only read access, but GitHub refuses comments on an
          // archived repository. Whether the token may write issue comments shows only on a write.
          const sev: CheckStatus = config.execution.mode === 'live' ? 'fail' : 'warn';
          if (gr.archived) {
            add(sev, name, `commentOnFailure: ${fullName} is archived (read-only), so GitHub will refuse the failure comment`);
          } else if (gr.permissions === null) {
            add('warn', name, "commentOnFailure: GitHub did not report this account's permissions; read access is unverified");
          } else if (!gr.permissions.pull) {
            add(sev, name, `commentOnFailure: the active GitHub account has no read access to ${fullName}. ${COMMENT_SCOPES_HINT}`);
          } else {
            add('ok', name, 'commentOnFailure: the active GitHub account can read the repository (the token must also allow issue comments, which is not checked: doctor does not write)');
          }
        }
        const autoMerge = autoMergeMethod(config, repo);
        if (repo.autoMerge && !autoMerge) {
          add('warn', name, `autoMerge: ${repo.autoMerge} is set but does nothing here: it needs execution.mode live, publish and review`);
        } else if (autoMerge) {
          // Merging needs write access; GitHub applies branch protection when the merge is asked for.
          if (gr.archived) add('fail', name, `autoMerge: ${fullName} is archived (read-only), so nothing can be merged`);
          else if (gr.permissions === null) add('warn', name, "autoMerge: GitHub did not report this account's permissions; whether it can merge is unverified");
          else if (!gr.permissions.push) add('fail', name, `autoMerge: the active GitHub account has no write access to ${fullName}, so it cannot merge. ${TOKEN_SCOPES_HINT}`);
          else if (gr.mergeMethods && !gr.mergeMethods[autoMerge]) add('fail', name, `autoMerge: ${autoMerge} merges are turned off in the settings of ${fullName}`);
          else {
            add(
              'ok',
              name,
              `autoMerge: ${autoMerge}; the active GitHub account can merge${gr.mergeMethods ? '' : ' (whether the repository allows this merge method is unverified)'}. ` +
                'Branch protection is not checked here: GitHub applies it when Updraft asks for the merge',
            );
          }
        }
        const labels = await api.listLabels({ id: repo.id, fullName });
        const has = (l: string) => labels.some((x) => labelEquals(x.name, l));
        for (const wf of repo.workflows) {
          const l = wf.trigger.label;
          add(has(l) ? 'ok' : 'fail', name, `trigger label "${l}" ${has(l) ? 'exists' : 'is missing; create it on GitHub'}`);
          if (typeof wf.pool !== 'string') {
            for (const r of wf.pool.rules) {
              if (!has(r.hasLabel)) add('warn', name, `routing label "${r.hasLabel}" does not exist`);
            }
          }
        }
      } catch (err) {
        add('fail', name, errMessage(err));
      }
    }
  }

  // The revision loop and the review loop: prompts and who can review whom.
  if (config) {
    for (const [fullName, repo] of Object.entries(config.repositories)) {
      for (const c of loopChecks(config, fullName, repo, paths.configDir, probes.fileExists)) add(c.status, `repo ${fullName}`, c.detail);
    }
  }

  // Local clones that per-job worktrees are created from.
  if (config) checks.push(...(await checkRepoCheckouts(config, paths, probes)));

  // Agents: the same discovery as "updraft agents", for each enabled agent as a live run starts it:
  // its agents.<name>.command, in this process's environment minus the GitHub tokens plus its
  // agents.<name>.env. Running doctor under the background launcher shows what the worker will see.
  // A containerized agent's CLI is in its image, so the runtime, the image and the CLI inside it
  // are checked instead of anything on the host.
  if (config) {
    const sev = agentProblemSeverity(config.execution.mode);
    const enabled = Object.entries(config.agents).filter(([, a]) => a.enabled);
    const results = await Promise.all(
      enabled.map(async ([agentName, agent]) => {
        const adapter = agentAdapter(agentName, agent);
        const env = agentLookupEnv(probes.env, agent);
        if (agent.container) {
          return containerAgentChecks(agentName, adapter, agent, paths.configDir, { platform: probes.platform, env, which: probes.which, run: probes.run }, sev);
        }
        const report = await probes.discoverAgent(adapter, { env, ...(agent.command ? { command: agent.command } : {}), baseDir: paths.configDir });
        return agentChecks(report, sev);
      }),
    );
    enabled.forEach(([agentName], i) => {
      for (const c of results[i]!) add(c.status, `agent ${agentName}`, c.detail);
    });
  }

  const overrides: Record<string, string> = {};
  for (const k of ['UPDRAFT_HOME', 'UPDRAFT_CONFIG']) {
    const v = probes.env[k];
    if (v) overrides[k] = v;
  }
  const environment: EnvironmentSummary = {
    cwd: probes.cwd,
    user: probes.user,
    platform: probes.platform,
    node: probes.nodeVersion,
    configFile: paths.configFile,
    dataDir: paths.dataDir,
    logDir: paths.logDir,
    pathEntries: pathEntries({ env: probes.env, platform: probes.platform }).length,
    overrides,
  };
  return { checks, environment, ok: !checks.some((c) => c.status === 'fail') };
}

const SYMBOL: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗' };

export function renderDoctor(r: DoctorReport): string {
  const e = r.environment;
  const lines = [
    'Environment:',
    `  user ${e.user}, cwd ${e.cwd}`,
    `  ${e.platform}, node v${e.node.replace(/^v/, '')}, ${e.pathEntries} PATH entries`,
    `  config ${e.configFile}`,
    `  state  ${e.dataDir}`,
    `  logs   ${e.logDir}`,
    ...Object.entries(e.overrides).map(([k, v]) => `  ${k}=${v}`),
    '',
    ...r.checks.map((c) => `${SYMBOL[c.status]} ${c.name}: ${c.detail}`),
    '',
  ];
  const fails = r.checks.filter((c) => c.status === 'fail').length;
  const warns = r.checks.filter((c) => c.status === 'warn').length;
  lines.push(fails ? `${fails} problem(s), ${warns} warning(s).` : `All checks passed${warns ? ` with ${warns} warning(s)` : ''}.`);
  return lines.join('\n');
}

export function defaultDoctorProbes(ctx: CommandContext): DoctorProbes {
  const env = ctx.env;
  let user = 'unknown';
  try {
    user = userInfo().username;
  } catch {
    user = env.USER ?? env.USERNAME ?? 'unknown';
  }
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    cwd: process.cwd(),
    user,
    env,
    which: (cmd) => which(cmd, { env }),
    run: (file, args) =>
      new Promise((resolve) => {
        execFile(file, args, { timeout: 15_000, windowsHide: true, env }, (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && code === null ? err.message : '')) });
        });
      }),
    checkWritable: (dir) => {
      mkdirSync(dir, { recursive: true });
      const probe = join(dir, `.updraft-doctor-${process.pid}.tmp`);
      writeFileSync(probe, 'ok');
      rmSync(probe, { force: true });
    },
    discoverAgent: async (adapter, opts) => (await ctx.discoverAgents({ adapters: [adapter], ...opts }))[0],
    checkDb: (file) => ctx.openDb(file).close(),
    createApi: () => ctx.createApi(),
    fileExists: existsSync,
  };
}

export async function doctorCommand(
  ctx: CommandContext,
  opts: { json?: boolean },
  probes: DoctorProbes = defaultDoctorProbes(ctx),
): Promise<number> {
  const report = await runDoctor(ctx.paths, probes);
  println(ctx.out, opts.json ? JSON.stringify(report, null, 2) : renderDoctor(report));
  return report.ok ? EXIT.OK : EXIT.FAILURE;
}
