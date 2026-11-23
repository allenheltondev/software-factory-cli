import { AGENT_KEY_ENV, SUPPORTED_AGENT_KEY_ENV, type CloudAgent } from './agents.js';
import { CEILINGS, type ConfigIssue, type TenantSubmission } from './config.js';
import { DEFAULT_PROMPTS } from './default-prompts.js';

/**
 * A tenant's settings as the console edits them (#69), in the terms the browser shows, not the
 * CLI's. `toTenantSubmission` turns them into an ordinary tenant config (config.ts), which is
 * compiled and validated with the worker's own `validateConfig` like any other, so nothing here
 * is a second definition of what a valid config is.
 *
 * The model (version 2):
 *
 *   agents          the installation's roster: a provider, a model and an effort, on or off
 *   pools           named groups of agents that take turns (round robin); a new installation
 *                   starts with `builders` and `reviewers`, each holding every agent offered
 *   allowedActors   who may start work by labeling an issue, for every repository that names
 *                   no list of its own
 *   workflows       a label starts the workflow's builder pool with its prompt; its pull
 *                   requests are reviewed by a reviewer pool (or not), and revised (or not)
 *   repositories    which workflows run where, and what is the repository's own: its verify
 *                   commands, base branch, how it publishes, auto-merge
 *
 * Compiled:
 *
 *   agents.A, pools.P            as written (only agents some pool holds)
 *   actions.W                    the workflow's prompt and time limit, with reviewPrompt
 *                                ./prompts/W.review.md and revisePrompt ./prompts/W.revise.md
 *                                when it reviews or revises
 *   actions.W.2, W.3, ...        the same, with a repository's verify commands (one per distinct
 *                                set of commands)
 *   repositories.R.workflows     one per workflow it runs: its label, pool, reviewPool and the
 *                                repository's (or the installation's) allowed actors
 *   repositories.R.review/revise from its workflows, which must agree: the CLI reviews and revises
 *                                per repository
 *
 * Names have no "." in them, so `W.2` can never be another workflow's action.
 *
 * Version 1 settings (one agent and one reviewer per workflow, labels and actors per repository)
 * are upgraded on read (`upgradeV1`) for the editor. Re-activating a version published with them
 * compiles them with the version 1 compiler instead (console-v1.ts), exactly as they ran.
 *
 * Jobs and pull requests already in flight keep references into the config they started under:
 * a job and a pull request store their workflow id (`<action>:<label>` unless set), action and
 * pool, and a revision runs with the action and pool of the job that opened the pull request.
 * So an upgraded configuration stays compatible with them once published (`legacy`): each
 * repository workflow keeps its version 1 id, each workflow's own action keeps its name and, for
 * the first repository that runs it, its verify commands, and the version 1 pool names resolve
 * to the pools that replaced them.
 */

export const CONSOLE_VERSION = 2;
/** The agents this deployment runs. */
export const CONSOLE_AGENTS = Object.keys(AGENT_KEY_ENV) as CloudAgent[];
export const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];
export const PUBLISH_MODES = ['draft-pr', 'pr'] as const;

/** Updraft Cloud's limits on what one tenant configures (the quotas on a config, not on jobs). */
export const CONSOLE_LIMITS = {
  agents: 12,
  pools: 20,
  agentsPerPool: 12,
  workflows: 20,
  repositories: 100,
  workflowsPerRepository: 10,
  allowedActors: 50,
  verifyCommands: 20,
  verifyCommandLength: 2000,
  requiredChecks: 20,
  labelLength: 50,
  textLength: 100,
  /** Per prompt, as config.ts allows. */
  promptBytes: 64 * 1024,
} as const;

export interface ConsoleAgent {
  adapter: CloudAgent;
  /** Passed to the agent CLI as its --model; empty: the CLI's default. */
  model?: string;
  /** Reasoning effort, checked against the CLI's profile rules. */
  effort?: string;
  /** false: never chosen, and its key is not needed. */
  enabled: boolean;
}

export interface ConsolePool {
  /** Names of roster agents, taken in turn. */
  agents: string[];
}

export interface ConsoleReview {
  enabled: boolean;
  /** The pool reviewer runs are taken from. */
  pool: string;
  /** Markdown: what the reviewer does with the pull request. */
  prompt: string;
  /** Let the agent that wrote the code review it when the pool has no other agent. */
  allowSameAgent: boolean;
}

export interface ConsoleRevise {
  enabled: boolean;
  /** Markdown: what the agent does with a review that requested changes. */
  prompt: string;
  /** Revision rounds per pull request (CLI default 3). */
  maxRevisions?: number;
}

export interface ConsoleWorkflow {
  /** The issue label that starts it. */
  label: string;
  /** The pool the work is taken from. */
  pool: string;
  /** Markdown: what the agent does with the issue. */
  prompt: string;
  /** Agent time limit, minutes (CLI default 60). */
  timeoutMinutes?: number;
  review: ConsoleReview;
  revise: ConsoleRevise;
}

export interface ConsoleAutoMerge {
  method: MergeMethod;
  /** How long to wait for pending checks, minutes (CLI default 60). */
  waitMinutes?: number;
  /** Checks that must each pass; absent: any one successful check. */
  requiredChecks?: string[];
}

export interface ConsoleRepository {
  /** false: paused. It stays configured, and no labeled issue starts a job. */
  enabled: boolean;
  /** The workflows whose labels start work here. */
  workflows: string[];
  /** Absent: the installation's allowedActors. */
  allowedActors?: string[];
  baseBranch?: string;
  publish: (typeof PUBLISH_MODES)[number];
  commentOnFailure: boolean;
  /** Shell commands run in the sandbox after the agent, in order; the first that fails fails the run. */
  verify: string[];
  /** All verify commands together, minutes (CLI default 15). */
  verifyTimeoutMinutes?: number;
  /** Absent: off. Turning it on takes an explicit confirmation (config-service.ts). */
  autoMerge?: ConsoleAutoMerge;
}

/** What an upgrade from version 1 keeps resolvable for work in flight (see the top of this file). */
export interface ConsoleLegacy {
  /** A version 1 pool name (`W`, `W.review`) -> the pool that replaced it. */
  pools: Record<string, string>;
  /** A workflow -> the version 1 workflow (action) it came from: its workflow ids are `<that>:<label>`. */
  workflows: Record<string, string>;
}

export interface ConsoleConfig {
  version: typeof CONSOLE_VERSION;
  agents: Record<string, ConsoleAgent>;
  pools: Record<string, ConsolePool>;
  /** GitHub logins whose labels start work, and whose change requests are acted on. */
  allowedActors: string[];
  workflows: Record<string, ConsoleWorkflow>;
  /** By OWNER/REPO. */
  repositories: Record<string, ConsoleRepository>;
  /** Present only on settings upgraded from version 1. */
  legacy?: ConsoleLegacy;
}

/**
 * The roster and pools an upgrade from version 1 can need: v1 allowed 20 workflows, each with its
 * own agent and reviewer (so up to 40 distinct profiles, each in a pool of one). Settings that
 * carry `legacy` get these limits, so a valid v1 configuration always loads and publishes.
 */
export const LEGACY_LIMITS = { agents: 2 * CONSOLE_LIMITS.workflows, pools: 2 * CONSOLE_LIMITS.workflows } as const;

/** Agent, pool and workflow names. */
export const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const WORKFLOW_NAME = NAME;
const NAME_RULE = 'lower-case letters, digits and "-", at most 40';
const REPO_NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
/** A GitHub login, or an App's bot (`name[bot]`). */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const BRANCH = /^[^\s~^:?*[\\]+$/;
const TOKEN = /^[A-Za-z0-9._:/-]+$/;
/** A CLI pool, agent or action name (version 1 names have "." in them). */
const CLI_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const BUILDERS = 'builders';
export const REVIEWERS = 'reviewers';

/**
 * What a new tenant starts from: an agent for every one this deployment offers, a `builders`
 * and a `reviewers` pool that each hold all of them, and one workflow, `implement`, on the label
 * `updraft`, whose pull requests the reviewers review and the builders revise. With a single
 * agent, it may review its own work (there is no other).
 */
export function defaultConsoleConfig(options: { offered?: readonly CloudAgent[]; login?: string; keys?: ReadonlySet<string> } = {}): ConsoleConfig {
  const offered = options.offered?.length ? options.offered : CONSOLE_AGENTS.length ? CONSOLE_AGENTS : (['claude'] as CloudAgent[]);
  // With the tenant's keys known, the pools start with the agents that can run: one without its
  // key is on the roster, off, until the key is added.
  const runs = (a: CloudAgent) => !options.keys || options.keys.has(SUPPORTED_AGENT_KEY_ENV[a]);
  const names = offered.filter(runs);
  return {
    version: CONSOLE_VERSION,
    agents: Object.fromEntries(offered.map((a) => [a, { adapter: a, enabled: runs(a) }])),
    pools: { [BUILDERS]: { agents: [...names] }, [REVIEWERS]: { agents: [...names] } },
    allowedActors: options.login ? [options.login] : [],
    workflows: {
      implement: {
        label: 'updraft',
        pool: BUILDERS,
        prompt: DEFAULT_PROMPTS.implement,
        review: { enabled: true, pool: REVIEWERS, prompt: DEFAULT_PROMPTS.review, allowSameAgent: names.length < 2 },
        revise: { enabled: true, prompt: DEFAULT_PROMPTS.revise },
      },
    },
    repositories: {},
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type Check = { errors: ConfigIssue[]; err: (path: string, message: string) => void };

function only(c: Check, path: string, value: Record<string, unknown>, keys: readonly string[]) {
  for (const k of Object.keys(value)) if (!keys.includes(k)) c.err(path ? `${path}.${k}` : k, 'not a setting the console has');
}

function text(c: Check, path: string, v: unknown, o: { required?: boolean; max?: number; pattern?: RegExp; what?: string } = {}): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (o.required) c.err(path, 'required');
    return undefined;
  }
  if (typeof v !== 'string') {
    c.err(path, 'must be text');
    return undefined;
  }
  const s = v.trim();
  if (s === '' && o.required) c.err(path, 'required');
  else if (s.length > (o.max ?? CONSOLE_LIMITS.textLength)) c.err(path, `at most ${o.max ?? CONSOLE_LIMITS.textLength} characters`);
  else if (o.pattern && s !== '' && !o.pattern.test(s)) c.err(path, o.what ?? 'not a valid value');
  return s === '' ? undefined : s;
}

function bool(c: Check, path: string, v: unknown, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') c.err(path, 'must be true or false');
  return v === true;
}

function minutes(c: Check, path: string, v: unknown, max: number): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) {
    c.err(path, `a whole number of minutes from 1 to ${max}`);
    return undefined;
  }
  return v;
}

function count(c: Check, path: string, v: unknown, max: number): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) {
    c.err(path, `a whole number from 1 to ${max}`);
    return undefined;
  }
  return v;
}

function prompt(c: Check, path: string, v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') {
    c.err(path, 'required: the prompt tells the agent what to do');
    return '';
  }
  if (Buffer.byteLength(v, 'utf8') > CONSOLE_LIMITS.promptBytes) c.err(path, `larger than ${CONSOLE_LIMITS.promptBytes / 1024} KiB`);
  return v;
}

function logins(c: Check, path: string, v: unknown): string[] {
  if (!Array.isArray(v)) {
    c.err(path, 'must be a list of GitHub logins');
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  v.forEach((raw, i) => {
    const login = text(c, `${path}.${i}`, raw, { required: true, max: 50, pattern: LOGIN, what: 'a GitHub login' });
    if (login && !seen.has(login.toLowerCase())) {
      seen.add(login.toLowerCase());
      out.push(login);
    }
  });
  if (out.length > CONSOLE_LIMITS.allowedActors) c.err(path, `at most ${CONSOLE_LIMITS.allowedActors} logins`);
  return out;
}

function names(c: Check, path: string, v: unknown, known: Record<string, unknown> | undefined, what: string, max: number): string[] {
  if (!Array.isArray(v)) {
    c.err(path, `must be a list of ${what} names`);
    return [];
  }
  if (v.length > max) c.err(path, `at most ${max}`);
  const out: string[] = [];
  v.forEach((n, i) => {
    if (typeof n !== 'string' || n === '') return void c.err(`${path}.${i}`, `a ${what} name`);
    if (known && !Object.hasOwn(known, n)) return void c.err(`${path}.${i}`, `there is no ${what} "${n}"`);
    if (!out.includes(n)) out.push(n);
  });
  return out;
}

/**
 * Checks the shape of the console's settings, and returns them normalized (trimmed, defaults
 * filled, duplicates dropped). Every problem is reported, with the path of the field. Version 1
 * settings are upgraded first.
 */
export function parseConsoleConfig(input: unknown): { ok: true; config: ConsoleConfig } | { ok: false; errors: ConfigIssue[] } {
  const c: Check = { errors: [], err: (path, message) => c.errors.push({ path, message }) };
  if (!isObject(input)) return { ok: false, errors: [{ path: '(root)', message: 'the settings must be a mapping' }] };
  const raw = input.version === 1 ? upgradeV1(input) : input;
  only(c, '', raw, ['version', 'agents', 'pools', 'allowedActors', 'workflows', 'repositories', 'legacy']);
  let legacy: ConsoleLegacy | undefined;
  if (raw.legacy !== undefined) {
    const l = isObject(raw.legacy) ? raw.legacy : {};
    if (!isObject(raw.legacy)) c.err('legacy', 'must be a mapping');
    only(c, 'legacy', l, ['pools', 'workflows']);
    const map = (key: 'pools' | 'workflows') => {
      const v = l[key];
      if (v === undefined) return {};
      if (!isObject(v)) {
        c.err(`legacy.${key}`, 'must be a mapping');
        return {};
      }
      const out: Record<string, string> = {};
      for (const [k, to] of Object.entries(v)) {
        if (!CLI_NAME.test(k) || typeof to !== 'string' || !CLI_NAME.test(to)) c.err(`legacy.${key}.${k}`, 'not a name');
        else out[k] = to;
      }
      return out;
    };
    legacy = { pools: map('pools'), workflows: map('workflows') };
  }
  if (raw.version !== CONSOLE_VERSION) c.err('version', `must be ${CONSOLE_VERSION}`);

  // Agents.
  const agents: Record<string, ConsoleAgent> = {};
  if (!isObject(raw.agents)) c.err('agents', 'must be a mapping');
  else {
    const list = Object.entries(raw.agents);
    if (list.length === 0) c.err('agents', 'add at least one agent');
    const max = legacy ? LEGACY_LIMITS.agents : CONSOLE_LIMITS.agents;
    if (list.length > max) c.err('agents', `at most ${max} agents`);
    for (const [name, v] of list) {
      const path = `agents.${name}`;
      if (!NAME.test(name)) c.err(path, `an agent name is ${NAME_RULE}`);
      if (!isObject(v)) {
        c.err(path, 'must be a mapping');
        continue;
      }
      only(c, path, v, ['adapter', 'model', 'effort', 'enabled']);
      // Any agent Updraft Cloud knows: a saved config that names one this deployment no longer
      // runs still loads. Whether it is offered is checked where it would run (config.ts).
      const known = typeof v.adapter === 'string' && Object.hasOwn(SUPPORTED_AGENT_KEY_ENV, v.adapter);
      if (!known) c.err(`${path}.adapter`, `one of ${Object.keys(SUPPORTED_AGENT_KEY_ENV).join(', ')}`);
      const model = text(c, `${path}.model`, v.model, { pattern: TOKEN, what: 'a model name: letters, digits, ".", "_", ":", "/" or "-"' });
      const effort = text(c, `${path}.effort`, v.effort, { pattern: TOKEN, what: 'an effort level, such as low, medium or high' });
      agents[name] = {
        adapter: known ? (v.adapter as CloudAgent) : 'claude',
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        enabled: bool(c, `${path}.enabled`, v.enabled, true),
      };
    }
  }

  // Pools.
  const pools: Record<string, ConsolePool> = {};
  if (!isObject(raw.pools)) c.err('pools', 'must be a mapping');
  else {
    const list = Object.entries(raw.pools);
    if (list.length === 0) c.err('pools', 'add at least one pool');
    const max = legacy ? LEGACY_LIMITS.pools : CONSOLE_LIMITS.pools;
    if (list.length > max) c.err('pools', `at most ${max} pools`);
    for (const [name, v] of list) {
      const path = `pools.${name}`;
      if (!NAME.test(name)) c.err(path, `a pool name is ${NAME_RULE}`);
      if (!isObject(v)) {
        c.err(path, 'must be a mapping');
        continue;
      }
      only(c, path, v, ['agents']);
      const members = names(c, `${path}.agents`, v.agents, isObject(raw.agents) ? raw.agents : undefined, 'agent', CONSOLE_LIMITS.agentsPerPool);
      if (Array.isArray(v.agents) && v.agents.length === 0) c.err(`${path}.agents`, 'add at least one agent');
      pools[name] = { agents: members };
    }
  }

  const allowedActors = raw.allowedActors === undefined ? [] : logins(c, 'allowedActors', raw.allowedActors);

  // Workflows.
  const workflows: Record<string, ConsoleWorkflow> = {};
  const poolKnown = (path: string, v: unknown, required: boolean): string => {
    const p = text(c, path, v, { required, max: 40 });
    if (p && required && isObject(raw.pools) && !Object.hasOwn(raw.pools, p)) c.err(path, `there is no pool "${p}"`);
    return p ?? '';
  };
  if (!isObject(raw.workflows)) c.err('workflows', 'must be a mapping');
  else {
    const list = Object.entries(raw.workflows);
    if (list.length === 0) c.err('workflows', 'add at least one workflow');
    // A workflow an upgrade split off a version 1 one (on another label, or with other review
    // settings) does not count: the version 1 settings were within their own limits.
    const split = (n: string) => legacy?.workflows[n] !== undefined && legacy.workflows[n] !== n;
    if (list.filter(([n]) => !split(n)).length > CONSOLE_LIMITS.workflows) c.err('workflows', `at most ${CONSOLE_LIMITS.workflows} workflows`);
    for (const [name, w] of list) {
      const path = `workflows.${name}`;
      if (!NAME.test(name)) c.err(path, `a workflow name is ${NAME_RULE}`);
      if (!isObject(w)) {
        c.err(path, 'must be a mapping');
        continue;
      }
      only(c, path, w, ['label', 'pool', 'prompt', 'timeoutMinutes', 'review', 'revise']);
      const label = text(c, `${path}.label`, w.label, { required: true, max: CONSOLE_LIMITS.labelLength }) ?? '';
      const pool = poolKnown(`${path}.pool`, w.pool, true);
      const timeoutMinutes = minutes(c, `${path}.timeoutMinutes`, w.timeoutMinutes, CEILINGS.timeoutMinutes);

      const rv = isObject(w.review) ? w.review : {};
      if (!isObject(w.review)) c.err(`${path}.review`, 'must be a mapping');
      only(c, `${path}.review`, rv, ['enabled', 'pool', 'prompt', 'allowSameAgent']);
      const reviewOn = bool(c, `${path}.review.enabled`, rv.enabled, false);
      const review: ConsoleReview = {
        enabled: reviewOn,
        pool: poolKnown(`${path}.review.pool`, rv.pool, reviewOn),
        prompt: reviewOn ? prompt(c, `${path}.review.prompt`, rv.prompt) : typeof rv.prompt === 'string' && rv.prompt.trim() ? rv.prompt : DEFAULT_PROMPTS.review,
        allowSameAgent: bool(c, `${path}.review.allowSameAgent`, rv.allowSameAgent, false),
      };

      const rs = isObject(w.revise) ? w.revise : {};
      if (!isObject(w.revise)) c.err(`${path}.revise`, 'must be a mapping');
      only(c, `${path}.revise`, rs, ['enabled', 'prompt', 'maxRevisions']);
      const reviseOn = bool(c, `${path}.revise.enabled`, rs.enabled, false);
      const maxRevisions = count(c, `${path}.revise.maxRevisions`, rs.maxRevisions, CEILINGS.maxRevisions);
      const revise: ConsoleRevise = {
        enabled: reviseOn,
        prompt: reviseOn ? prompt(c, `${path}.revise.prompt`, rs.prompt) : typeof rs.prompt === 'string' && rs.prompt.trim() ? rs.prompt : DEFAULT_PROMPTS.revise,
        ...(maxRevisions !== undefined ? { maxRevisions } : {}),
      };

      workflows[name] = { label, pool, prompt: prompt(c, `${path}.prompt`, w.prompt), ...(timeoutMinutes !== undefined ? { timeoutMinutes } : {}), review, revise };
    }
  }

  // Repositories.
  const repositories: Record<string, ConsoleRepository> = {};
  if (!isObject(raw.repositories)) c.err('repositories', 'must be a mapping');
  else {
    const list = Object.entries(raw.repositories);
    if (list.length > CONSOLE_LIMITS.repositories) c.err('repositories', `at most ${CONSOLE_LIMITS.repositories} repositories`);
    const seen = new Set<string>();
    for (const [fullName, r] of list) {
      const path = `repositories.${fullName}`;
      if (!REPO_NAME.test(fullName)) c.err(path, 'expected OWNER/REPO');
      if (seen.has(fullName.toLowerCase())) c.err(path, 'listed twice');
      seen.add(fullName.toLowerCase());
      if (!isObject(r)) {
        c.err(path, 'must be a mapping');
        continue;
      }
      only(c, path, r, ['enabled', 'workflows', 'allowedActors', 'baseBranch', 'publish', 'commentOnFailure', 'verify', 'verifyTimeoutMinutes', 'autoMerge']);

      const runs = names(c, `${path}.workflows`, r.workflows, isObject(raw.workflows) ? raw.workflows : undefined, 'workflow', CONSOLE_LIMITS.workflowsPerRepository);
      if (Array.isArray(r.workflows) && r.workflows.length === 0) c.err(`${path}.workflows`, 'choose at least one workflow: its label is how an issue starts work here');

      let actors: string[] | undefined;
      if (r.allowedActors !== undefined && r.allowedActors !== null) {
        actors = logins(c, `${path}.allowedActors`, r.allowedActors);
        if (Array.isArray(r.allowedActors) && actors.length === 0) c.err(`${path}.allowedActors`, 'name at least one GitHub login, or use the installation\'s list');
      }

      const publish = r.publish ?? 'draft-pr';
      if (!(PUBLISH_MODES as readonly unknown[]).includes(publish)) c.err(`${path}.publish`, 'draft-pr or pr');
      const baseBranch = text(c, `${path}.baseBranch`, r.baseBranch, { max: 255, pattern: BRANCH, what: 'a branch name' });

      const verify: string[] = [];
      if (r.verify !== undefined && !Array.isArray(r.verify)) c.err(`${path}.verify`, 'must be a list of commands');
      else if (Array.isArray(r.verify)) {
        if (r.verify.length > CONSOLE_LIMITS.verifyCommands) c.err(`${path}.verify`, `at most ${CONSOLE_LIMITS.verifyCommands} commands`);
        r.verify.forEach((cmd, i) => {
          if (typeof cmd !== 'string' || cmd.trim() === '') return void c.err(`${path}.verify.${i}`, 'a command must not be empty');
          if (/[\r\n\0]/.test(cmd)) return void c.err(`${path}.verify.${i}`, 'one line per command');
          if (cmd.length > CONSOLE_LIMITS.verifyCommandLength) return void c.err(`${path}.verify.${i}`, `at most ${CONSOLE_LIMITS.verifyCommandLength} characters`);
          verify.push(cmd.trim());
        });
      }
      const verifyTimeoutMinutes = minutes(c, `${path}.verifyTimeoutMinutes`, r.verifyTimeoutMinutes, CEILINGS.verifyTimeoutMinutes);

      let autoMerge: ConsoleAutoMerge | undefined;
      if (r.autoMerge !== undefined && r.autoMerge !== null) {
        const ap = `${path}.autoMerge`;
        if (!isObject(r.autoMerge)) c.err(ap, 'must be a mapping, or absent for off');
        else {
          only(c, ap, r.autoMerge, ['method', 'waitMinutes', 'requiredChecks']);
          const method = r.autoMerge.method;
          if (!(MERGE_METHODS as readonly unknown[]).includes(method)) c.err(`${ap}.method`, MERGE_METHODS.join(', '));
          const waitMinutes = minutes(c, `${ap}.waitMinutes`, r.autoMerge.waitMinutes, CEILINGS.autoMergeWaitMinutes);
          let requiredChecks: string[] | undefined;
          if (r.autoMerge.requiredChecks !== undefined) {
            if (!Array.isArray(r.autoMerge.requiredChecks)) c.err(`${ap}.requiredChecks`, 'must be a list of check names');
            else {
              if (r.autoMerge.requiredChecks.length > CONSOLE_LIMITS.requiredChecks) c.err(`${ap}.requiredChecks`, `at most ${CONSOLE_LIMITS.requiredChecks} checks`);
              requiredChecks = r.autoMerge.requiredChecks.map((n, i) => text(c, `${ap}.requiredChecks.${i}`, n, { required: true, max: 255 })).filter((n): n is string => n !== undefined);
            }
          }
          autoMerge = {
            method: method as MergeMethod,
            ...(waitMinutes !== undefined ? { waitMinutes } : {}),
            ...(requiredChecks && requiredChecks.length ? { requiredChecks } : {}),
          };
        }
      }

      repositories[fullName] = {
        enabled: bool(c, `${path}.enabled`, r.enabled, true),
        workflows: runs,
        ...(actors ? { allowedActors: actors } : {}),
        ...(baseBranch ? { baseBranch } : {}),
        publish: publish as ConsoleRepository['publish'],
        commentOnFailure: bool(c, `${path}.commentOnFailure`, r.commentOnFailure, true),
        verify,
        ...(verify.length && verifyTimeoutMinutes !== undefined ? { verifyTimeoutMinutes } : {}),
        ...(autoMerge ? { autoMerge } : {}),
      };
    }
    if (list.length === 0) c.err('repositories', 'add at least one repository');
  }

  if (c.errors.length) return { ok: false, errors: c.errors };
  const config: ConsoleConfig = { version: CONSOLE_VERSION, agents, pools, allowedActors, workflows, repositories, ...(legacy ? { legacy } : {}) };
  checkMeaning(config, c);
  if (c.errors.length) return { ok: false, errors: c.errors };
  return { ok: true, config };
}

/** The rules that read across sections: what a repository's workflows share, and pools that can run. */
function checkMeaning(config: ConsoleConfig, c: Check) {
  const enabledIn = (pool: string) => (config.pools[pool]?.agents ?? []).filter((a) => config.agents[a]?.enabled);
  const running = new Set<string>();
  let needActors = false;

  for (const [fullName, r] of Object.entries(config.repositories)) {
    const path = `repositories.${fullName}`;
    const wfs = r.workflows.map((n) => [n, config.workflows[n]!] as const);
    if (!r.allowedActors && config.allowedActors.length === 0) needActors = true;

    const labels = new Map<string, string>();
    for (const [n, w] of wfs) {
      const prior = labels.get(w.label.toLowerCase());
      if (prior) c.err(`${path}.workflows`, `${prior} and ${n} both start on the label "${w.label}": a repository's workflows need labels of their own`);
      labels.set(w.label.toLowerCase(), n);
    }

    // The CLI reviews and revises per repository, so the workflows that run here must agree.
    const policy = ([, w]: (typeof wfs)[number]) =>
      JSON.stringify([w.review.enabled, w.review.enabled && w.review.allowSameAgent, w.revise.enabled, w.revise.enabled ? (w.revise.maxRevisions ?? null) : null]);
    const differs = wfs.find((x) => policy(x) !== policy(wfs[0]!));
    if (differs) {
      c.err(`${path}.workflows`, `${wfs[0]![0]} and ${differs[0]} handle pull requests differently: the workflows of one repository must agree on review, revision and revision rounds`);
    }
    const reviewed = wfs.some(([, w]) => w.review.enabled);
    if (r.autoMerge && !reviewed) c.err(`${path}.autoMerge`, 'turn on review in its workflow first: Updraft only merges a pull request its own reviewer found ready');

    if (r.enabled) {
      for (const [, w] of wfs) {
        running.add(w.pool);
        if (w.review.enabled) running.add(w.review.pool);
      }
    }
  }

  if (needActors) c.err('allowedActors', 'name at least one GitHub login who may start work by labeling an issue');
  for (const pool of running) {
    if (config.pools[pool] && enabledIn(pool).length === 0) c.err(`pools.${pool}`, 'every agent in this pool is off: turn one on, or add another');
  }

  for (const [name, w] of Object.entries(config.workflows)) {
    if (!w.review.enabled || w.review.allowSameAgent) continue;
    const builders = enabledIn(w.pool);
    const reviewers = enabledIn(w.review.pool);
    // A reviewer is never the agent that wrote the code: some builder must have another reviewer.
    if (reviewers.length && builders.some((b) => reviewers.every((r) => r === b))) {
      c.err(
        `workflows.${name}.review.pool`,
        reviewers.length === 1
          ? `${reviewers[0]} would review its own work: add another agent to ${w.review.pool}, or allow an agent to review its own work`
          : `an agent of ${w.pool} has no one else in ${w.review.pool} to review it`,
      );
    }
  }
}

/** Agents and pools a version 1 setting used, under readable names. */
function upgradeV1(raw: Record<string, unknown>): Record<string, unknown> {
  const v1Workflows = isObject(raw.workflows) ? raw.workflows : {};
  const v1Repos = isObject(raw.repositories) ? raw.repositories : {};
  const agents: Record<string, Record<string, unknown>> = {};
  // Per role: v1 gave every workflow a builder (`W`) and a reviewer (`W.review`) of its own, so
  // a reviewer with the builder's very profile was still another agent. Keeping the roles apart
  // keeps that: such a reviewer is a second agent with the same profile, and nobody gains a
  // self-review v1 did not allow (allowSameAgent stays off).
  const byProfile = new Map<string, string>();
  const unique = (base: string, taken: (n: string) => boolean) => {
    const stem = base.slice(0, 36) || 'x';
    if (!taken(stem)) return stem;
    for (let i = 2; ; i++) if (!taken(`${stem}-${i}`)) return `${stem}-${i}`;
  };
  const agentFor = (a: unknown, role: 'builder' | 'reviewer'): string => {
    const o = isObject(a) ? a : {};
    const adapter = typeof o.adapter === 'string' ? o.adapter : 'claude';
    const key = JSON.stringify([role, adapter, o.model ?? null, o.effort ?? null]);
    const hit = byProfile.get(key);
    if (hit) return hit;
    const name = unique(adapter.toLowerCase().replace(/[^a-z0-9-]/g, '-'), (n) => Object.hasOwn(agents, n));
    agents[name] = { adapter, ...(o.model !== undefined ? { model: o.model } : {}), ...(o.effort !== undefined ? { effort: o.effort } : {}), enabled: true };
    byProfile.set(key, name);
    return name;
  };
  const pools: Record<string, { agents: string[] }> = {};
  const byPool = new Map<string, string>();
  const legacyPools: Record<string, string> = {};
  const legacyWorkflows: Record<string, string> = {};
  const poolFor = (role: 'builders' | 'reviewers', agent: string) => {
    const key = `${role}\0${agent}`;
    const hit = byPool.get(key);
    if (hit) return hit;
    const name = unique(role, (n) => Object.hasOwn(pools, n));
    pools[name] = { agents: [agent] };
    byPool.set(key, name);
    return name;
  };

  // A v1 workflow becomes one v2 workflow per label and pull-request handling the repositories gave it.
  const workflows: Record<string, Record<string, unknown>> = {};
  const groups = new Map<string, string>();
  const taken = (n: string) => Object.hasOwn(workflows, n) || Object.hasOwn(v1Workflows, n);
  const build = (v1Name: string, name: string, w: Record<string, unknown>, label: string, review: boolean, revise: boolean, maxRevisions: unknown) => {
    const builder = agentFor(w.agent, 'builder');
    const reviewerAgent = agentFor(w.reviewer, 'reviewer');
    const reviewer = isObject(w.reviewer) ? w.reviewer : {};
    // The version 1 pools of this workflow, as stored by its jobs and pull requests.
    legacyPools[v1Name] = poolFor('builders', builder);
    legacyPools[`${v1Name}.review`] = poolFor('reviewers', reviewerAgent);
    legacyWorkflows[name] = v1Name;
    return {
      label,
      pool: poolFor('builders', builder),
      prompt: w.prompt,
      ...(w.timeoutMinutes !== undefined ? { timeoutMinutes: w.timeoutMinutes } : {}),
      review: { enabled: review, pool: poolFor('reviewers', reviewerAgent), prompt: reviewer.prompt ?? DEFAULT_PROMPTS.review, allowSameAgent: false },
      revise: { enabled: revise, prompt: w.revisePrompt ?? DEFAULT_PROMPTS.revise, ...(revise && maxRevisions !== undefined ? { maxRevisions } : {}) },
    };
  };

  const repositories: Record<string, Record<string, unknown>> = {};
  let actors: unknown[] | undefined;
  for (const [fullName, r] of Object.entries(v1Repos)) {
    if (!isObject(r)) {
      repositories[fullName] = r as Record<string, unknown>;
      continue;
    }
    const runs: string[] = [];
    let verifyFrom: Record<string, unknown> | undefined;
    for (const t of Array.isArray(r.triggers) ? r.triggers : []) {
      if (!isObject(t) || typeof t.workflow !== 'string') continue;
      const w = v1Workflows[t.workflow];
      if (!isObject(w)) {
        runs.push(t.workflow);
        continue;
      }
      verifyFrom ??= w;
      const key = JSON.stringify([t.workflow, t.label, r.review === true, r.revise === true, r.revise === true ? (r.maxRevisions ?? null) : null]);
      let name = groups.get(key);
      if (!name) {
        name = [...groups.keys()].some((k) => JSON.parse(k)[0] === t.workflow) ? unique(t.workflow, taken) : t.workflow;
        groups.set(key, name);
        workflows[name] = build(t.workflow, name, w, typeof t.label === 'string' ? t.label : '', r.review === true, r.revise === true, r.maxRevisions);
      }
      if (!runs.includes(name)) runs.push(name);
    }
    const repoActors = Array.isArray(r.allowedActors) ? r.allowedActors : [];
    actors ??= repoActors;
    const same = repoActors.length === actors.length && repoActors.every((a, i) => String(a).toLowerCase() === String(actors![i]).toLowerCase());
    repositories[fullName] = {
      ...(r.enabled !== undefined ? { enabled: r.enabled } : {}),
      workflows: runs,
      ...(same ? {} : { allowedActors: repoActors }),
      ...(r.baseBranch !== undefined ? { baseBranch: r.baseBranch } : {}),
      ...(r.publish !== undefined ? { publish: r.publish } : {}),
      ...(r.commentOnFailure !== undefined ? { commentOnFailure: r.commentOnFailure } : {}),
      // Verify commands move to the repository; one that ran two workflows keeps the first one's.
      verify: Array.isArray(verifyFrom?.verify) ? verifyFrom.verify : [],
      ...(verifyFrom?.verifyTimeoutMinutes !== undefined ? { verifyTimeoutMinutes: verifyFrom.verifyTimeoutMinutes } : {}),
      ...(r.autoMerge !== undefined ? { autoMerge: r.autoMerge } : {}),
    };
  }
  // Workflows no repository ran: kept, on a label of their own.
  for (const [name, w] of Object.entries(v1Workflows)) {
    if (Object.hasOwn(workflows, name) || !isObject(w)) continue;
    if ([...groups.keys()].some((k) => JSON.parse(k)[0] === name)) continue;
    const labels = new Set(Object.values(workflows).map((x) => String(x.label).toLowerCase()));
    workflows[name] = build(name, name, w, labels.has('updraft') ? name : 'updraft', false, false, undefined);
  }
  return { version: CONSOLE_VERSION, agents, pools, allowedActors: actors ?? [], workflows, repositories, legacy: { pools: legacyPools, workflows: legacyWorkflows } };
}

/** What each enabled repository's workflows can start: pools, and whether they review. */
function usedPools(config: ConsoleConfig): Set<string> {
  const out = new Set<string>();
  for (const r of Object.values(config.repositories)) {
    if (!r.enabled) continue;
    for (const n of r.workflows) {
      const w = config.workflows[n];
      if (!w) continue;
      out.add(w.pool);
      if (w.review.enabled) out.add(w.review.pool);
    }
  }
  return out;
}

/**
 * Updraft Cloud's rule for agents: every agent an enabled repository can start needs its API key
 * set first (bring your own key, #64), or the job would fail in the microVM. An agent that is off
 * needs none. `keys` are the names of the tenant's keys that are set (never their values).
 */
export function missingKeys(config: ConsoleConfig, keys: ReadonlySet<string>): ConfigIssue[] {
  const agents = new Set<string>();
  for (const p of usedPools(config)) for (const a of config.pools[p]?.agents ?? []) if (config.agents[a]?.enabled) agents.add(a);
  const out: ConfigIssue[] = [];
  for (const name of [...agents].sort()) {
    const { adapter } = config.agents[name]!;
    // An agent this deployment does not run: compiling it says so, with what to do instead.
    if (!CONSOLE_AGENTS.includes(adapter)) continue;
    const key = SUPPORTED_AGENT_KEY_ENV[adapter];
    if (!keys.has(key)) out.push({ path: `agents.${name}`, message: `add your ${key}, or turn this agent off: jobs run ${adapter} with your own key` });
  }
  return out;
}

/** One compiled action: whose prompts it runs, the repository whose verify commands it carries. */
interface ActionSpec {
  /** The workflow it belongs to: its prompt and time limit, and where an issue about it is shown. */
  workflow: string;
  /** The first repository whose verify commands it carries; absent when none does. */
  repo?: string;
  verify: string[];
  verifyTimeoutMinutes?: number;
  /** The workflow whose review prompt it carries, when one that uses it reviews. */
  reviewFrom?: string;
  /** The workflow whose revision prompt it carries, when one that uses it revises. */
  reviseFrom?: string;
  /** The version 1 name it shares with the workflows split from it (legacy), else the workflow's. */
  base: string;
}

/**
 * The compiled actions, and which one each repository's workflow runs. A workflow's action is
 * named after it; a repository whose verify commands differ from the first one's gets an action
 * of its own (`W.2`, ...).
 *
 * An upgraded workflow runs the action named after the version 1 workflow it came from (its
 * `base`), and so do the workflows split from it, as long as what they run is the same (prompts,
 * time limit, verify commands): the version 1 workflow id is `<action>:<label>`, and the jobs and
 * pull requests opened under it stored that id and that action. Review and revision prompts only
 * need to agree among the workflows that use them.
 */
function actionLayout(config: ConsoleConfig) {
  const actions = new Map<string, ActionSpec>();
  const of = new Map<string, string>();
  const baseOf = (n: string) => config.legacy?.workflows[n] ?? n;

  const fits = (a: ActionSpec, n: string, verify: string[], verifyTimeoutMinutes: number | undefined) => {
    const w = config.workflows[n]!;
    const owner = config.workflows[a.workflow]!;
    if (a.base !== baseOf(n) || owner.prompt !== w.prompt || owner.timeoutMinutes !== w.timeoutMinutes) return false;
    if (JSON.stringify(a.verify) !== JSON.stringify(verify) || a.verifyTimeoutMinutes !== verifyTimeoutMinutes) return false;
    if (w.review.enabled && a.reviewFrom && config.workflows[a.reviewFrom]!.review.prompt !== w.review.prompt) return false;
    if (w.revise.enabled && a.reviseFrom && config.workflows[a.reviseFrom]!.revise.prompt !== w.revise.prompt) return false;
    return true;
  };
  const place = (n: string, repo: string | undefined, verify: string[], verifyTimeoutMinutes: number | undefined): string => {
    const w = config.workflows[n]!;
    let name = [...actions.keys()].find((k) => fits(actions.get(k)!, n, verify, verifyTimeoutMinutes));
    if (!name) {
      const base = baseOf(n);
      if (!actions.has(base)) name = base;
      else if (!actions.has(n)) name = n;
      else {
        let i = 2;
        while (actions.has(`${n}.${i}`)) i++;
        name = `${n}.${i}`;
      }
      actions.set(name, { workflow: n, ...(repo && verify.length ? { repo } : {}), verify, ...(verify.length && verifyTimeoutMinutes !== undefined ? { verifyTimeoutMinutes } : {}), base });
    }
    const a = actions.get(name)!;
    if (w.review.enabled) a.reviewFrom ??= n;
    if (w.revise.enabled) a.reviseFrom ??= n;
    return name;
  };

  for (const [fullName, r] of Object.entries(config.repositories)) {
    for (const n of r.workflows) if (config.workflows[n]) of.set(`${fullName}\0${n}`, place(n, fullName, r.verify, r.verifyTimeoutMinutes));
  }
  // A workflow no repository runs still has its action (an unused one, as before).
  for (const n of Object.keys(config.workflows)) if (![...actions.values()].some((a) => a.workflow === n)) place(n, undefined, [], undefined);
  return { actions, actionOf: (repo: string, workflow: string) => of.get(`${repo}\0${workflow}`) ?? workflow };
}

/** The console's settings as an ordinary tenant config document and its prompt files (config.ts). */
export function toTenantSubmission(config: ConsoleConfig): TenantSubmission {
  const agents: Record<string, unknown> = {};
  const pools: Record<string, unknown> = {};
  const actions: Record<string, unknown> = {};
  const prompts: Record<string, string> = {};

  // Only the pools a workflow routes to, and the agents they hold: what no job can start is not
  // compiled, so it is not checked either (a saved agent this deployment no longer runs, say).
  const routed = new Set<string>();
  for (const w of Object.values(config.workflows)) {
    routed.add(w.pool);
    if (w.review.enabled) routed.add(w.review.pool);
  }
  for (const [name, p] of Object.entries(config.pools)) if (routed.has(name)) pools[name] = { agents: [...p.agents] };
  // The version 1 pool names, for jobs and pull requests that stored them: each resolves to the
  // agents of the pool that replaced it (when that pool is still there and nothing took its name).
  for (const [old, now] of Object.entries(config.legacy?.pools ?? {})) {
    if (!Object.hasOwn(pools, old) && !Object.hasOwn(config.pools, old) && config.pools[now]) pools[old] = { agents: [...config.pools[now]!.agents] };
  }
  const pooled = new Set(Object.values(pools as Record<string, { agents: string[] }>).flatMap((p) => p.agents));
  for (const [name, a] of Object.entries(config.agents)) {
    if (!pooled.has(name)) continue;
    agents[name] = { adapter: a.adapter, ...(a.model ? { model: a.model } : {}), ...(a.effort ? { effort: a.effort } : {}), ...(a.enabled ? {} : { enabled: false }) };
  }

  // Only the prompt files an action references, and one file for identical text (a workflow
  // split by an upgrade shares its prompts with the others), so the file count stays what it was.
  const byText = new Map<string, string>();
  const file = (kind: '' | '.review' | '.revise', workflow: string, text: string) => {
    const key = `${kind}\0${text}`;
    let name = byText.get(key);
    if (!name) {
      name = `${workflow}${kind}.md`;
      byText.set(key, name);
      prompts[name] = text;
    }
    return `./prompts/${name}`;
  };
  const layout = actionLayout(config);
  for (const [action, a] of layout.actions) {
    const w = config.workflows[a.workflow]!;
    actions[action] = {
      prompt: file('', a.workflow, w.prompt),
      ...(a.verify.length ? { verify: [...a.verify] } : {}),
      ...(w.timeoutMinutes !== undefined ? { timeoutMinutes: w.timeoutMinutes } : {}),
      ...(a.verify.length && a.verifyTimeoutMinutes !== undefined ? { verifyTimeoutMinutes: a.verifyTimeoutMinutes } : {}),
      ...(a.reviewFrom ? { reviewPrompt: file('.review', a.reviewFrom, config.workflows[a.reviewFrom]!.review.prompt) } : {}),
      ...(a.reviseFrom ? { revisePrompt: file('.revise', a.reviseFrom, config.workflows[a.reviseFrom]!.revise.prompt) } : {}),
    };
  }

  const repositories: Record<string, unknown> = {};
  const everyone = new Map<string, string>();
  for (const a of config.allowedActors) everyone.set(a.toLowerCase(), a);
  for (const [fullName, r] of Object.entries(config.repositories)) {
    const actors = r.allowedActors ?? config.allowedActors;
    for (const a of actors) if (!everyone.has(a.toLowerCase())) everyone.set(a.toLowerCase(), a);
    // The workflows of a repository agree on these (checkMeaning): the first one speaks for all.
    const first = config.workflows[r.workflows[0] ?? ''];
    const review = first?.review.enabled ? (first.review.allowSameAgent ? { allowSameAgent: true } : true) : undefined;
    const revise = first?.revise.enabled ? { revise: true, ...(first.revise.maxRevisions !== undefined ? { maxRevisions: first.revise.maxRevisions } : {}) } : {};
    repositories[fullName] = {
      ...(r.enabled ? {} : { paused: true }),
      ...(r.baseBranch ? { baseBranch: r.baseBranch } : {}),
      publish: r.publish,
      commentOnFailure: r.commentOnFailure,
      ...(review !== undefined ? { review } : {}),
      ...revise,
      ...(r.autoMerge
        ? {
            autoMerge: r.autoMerge.method,
            ...(r.autoMerge.waitMinutes !== undefined ? { autoMergeWaitMinutes: r.autoMerge.waitMinutes } : {}),
            ...(r.autoMerge.requiredChecks?.length ? { autoMergeRequiredChecks: [...r.autoMerge.requiredChecks] } : {}),
          }
        : {}),
      workflows: r.workflows.map((n) => {
        const w = config.workflows[n]!;
        return {
          // A workflow of its own has a stable id (its name), so a job or pull request finds it
          // whatever action the repository's verify commands put it in. An upgraded one keeps the
          // version 1 id, `<action>:<label>`, which its action name preserves (actionLayout).
          ...(config.legacy?.workflows[n] === undefined ? { id: n } : {}),
          trigger: { event: 'issue.labeled', label: w.label },
          action: layout.actionOf(fullName, n),
          pool: w.pool,
          allowedActors: [...actors],
          ...(w.review.enabled ? { reviewPool: w.review.pool } : {}),
        };
      }),
    };
  }

  return {
    // Every workflow names its own actors; this is only the CLI's fallback, which nothing uses.
    config: { dispatch: { allowedActors: [...everyone.values()] }, agents, pools, actions, repositories },
    prompts,
  };
}

/**
 * The console field a compiled config's issue is about (see the layout above), so the editor can
 * show it where the person typed. A path it does not recognize is returned as it is.
 */
export function toConsolePath(path: string, config: ConsoleConfig): string {
  const rest = (p: string, prefix: string) => (p === prefix ? '' : p.startsWith(`${prefix}.`) ? p.slice(prefix.length + 1) : null);
  const join = (...parts: string[]) => parts.filter((p) => p !== '').join('.');
  let r: string | null;

  const layout = actionLayout(config);
  const actionNames = [...layout.actions.keys()].sort((a, b) => b.length - a.length);
  for (const action of actionNames) {
    if ((r = rest(path, `actions.${action}`)) === null) continue;
    const a = layout.actions.get(action)!;
    const base = `workflows.${a.workflow}`;
    if (a.repo && (r.startsWith('verify') || r.startsWith('verifyTimeoutMinutes'))) return join(`repositories.${a.repo}`, r);
    if (r === 'reviewPrompt') return join(base, 'review', 'prompt');
    if (r === 'revisePrompt') return join(base, 'revise', 'prompt');
    return join(base, r);
  }
  const workflows = Object.keys(config.workflows).sort((a, b) => b.length - a.length);
  for (const w of workflows) {
    const file = /^prompts[/.](.*)$/.exec(path)?.[1];
    if (file === `${w}.md`) return `workflows.${w}.prompt`;
    if (file === `${w}.review.md`) return `workflows.${w}.review.prompt`;
    if (file === `${w}.revise.md`) return `workflows.${w}.revise.prompt`;
  }

  const repos = Object.keys(config.repositories).sort((a, b) => b.length - a.length);
  for (const repo of repos) {
    if ((r = rest(path, `repositories.${repo}`)) === null) continue;
    const base = `repositories.${repo}`;
    const settings = config.repositories[repo]!;
    const m = /^workflows\.(\d+)(?:\.(.*))?$/.exec(r);
    if (m) {
      const wf = settings.workflows[Number(m[1])];
      const tail = m[2] ?? '';
      if (tail.startsWith('allowedActors')) return settings.allowedActors ? join(base, tail) : tail;
      if (wf && tail.startsWith('trigger.label')) return `workflows.${wf}.label`;
      if (wf && tail === 'pool') return `workflows.${wf}.pool`;
      if (wf && tail === 'reviewPool') return `workflows.${wf}.review.pool`;
      return join(base, 'workflows');
    }
    if (r.startsWith('review') || r.startsWith('revise') || r.startsWith('maxRevisions')) return join(base, 'workflows');
    if (r.startsWith('autoMergeWaitMinutes')) return join(base, 'autoMerge', 'waitMinutes');
    if (r.startsWith('autoMergeRequiredChecks')) return join(base, 'autoMerge', r.replace(/^autoMergeRequiredChecks/, 'requiredChecks'));
    if (r === 'paused') return join(base, 'enabled');
    return join(base, r);
  }
  if (path.startsWith('dispatch.allowedActors')) return 'allowedActors';
  return path;
}

/**
 * What upgrading version 1 settings cannot keep as it was, in words for the editor: a repository
 * that ran workflows with different verify commands now has one list, the first workflow's.
 * (Re-activating the version itself keeps them: it compiles with the version 1 compiler.)
 */
export function upgradeNotes(raw: unknown): string[] {
  if (!isObject(raw) || raw.version !== 1 || !isObject(raw.repositories) || !isObject(raw.workflows)) return [];
  const wfs = raw.workflows;
  const out: string[] = [];
  for (const [fullName, r] of Object.entries(raw.repositories)) {
    if (!isObject(r) || !Array.isArray(r.triggers)) continue;
    const used = [...new Set(r.triggers.map((t) => (isObject(t) && typeof t.workflow === 'string' ? t.workflow : '')).filter((n) => isObject(wfs[n])))];
    const verify = (n: string) => JSON.stringify([(wfs[n] as Record<string, unknown>).verify ?? [], (wfs[n] as Record<string, unknown>).verifyTimeoutMinutes ?? null]);
    const differs = used.filter((n) => verify(n) !== verify(used[0]!));
    if (differs.length) out.push(`${fullName} ran ${[used[0], ...differs].join(' and ')} with different checks. It now has one list, ${used[0]}'s: check it before you publish.`);
  }
  return out;
}
