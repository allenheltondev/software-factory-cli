import { AGENT_KEY_ENV, SUPPORTED_AGENT_KEY_ENV, type CloudAgent } from './agents.js';
import { CEILINGS, type ConfigIssue, type TenantSubmission } from './config.js';
import { DEFAULT_PROMPTS } from './default-prompts.js';

/**
 * A tenant's settings as the console edits them (#69): repositories and workflows, in the terms
 * the browser shows, not the CLI's. `toTenantSubmission` turns them into an ordinary tenant config
 * (config.ts), which is compiled and validated with the worker's own `validateConfig` like any
 * other, so nothing here is a second definition of what a valid config is. What this file adds:
 *
 *   - the shape of the console's settings, checked strictly (an unknown field is an error);
 *   - Updraft Cloud's own rules: counts and sizes (CONSOLE_LIMITS), allowed actors never empty,
 *     auto-merge only with review, and an agent only when the tenant has set its API key;
 *   - mapping a compiled config's error paths back to the field the person edited.
 *
 * Compiled, one workflow `W` is:
 *
 *   agents.W            the workflow's agent (adapter, model, effort)
 *   agents.W.review     its reviewer, when a repository that runs it has review on
 *   pools.W, pools.W.review   one agent each
 *   actions.W           prompt ./prompts/W.md, verify commands and timeouts, and
 *                       reviewPrompt ./prompts/W.review.md, revisePrompt ./prompts/W.revise.md
 *                       when a repository that runs it reviews or revises
 *
 * and each repository's triggers become its `workflows`, each with the repository's allowed
 * actors. A workflow name has no "." in it, so `W.review` can never be another workflow's name.
 */

export const CONSOLE_VERSION = 1;
export const CONSOLE_AGENTS = Object.keys(AGENT_KEY_ENV) as CloudAgent[];
export const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];
export const PUBLISH_MODES = ['draft-pr', 'pr'] as const;

/** Updraft Cloud's limits on what one tenant configures (the quotas on a config, not on jobs). */
export const CONSOLE_LIMITS = {
  workflows: 20,
  repositories: 100,
  triggersPerRepository: 10,
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
}

export interface ConsoleWorkflow {
  agent: ConsoleAgent;
  /** Markdown: what the agent does with the issue. */
  prompt: string;
  /** The agent that reviews the pull request, in repositories with review on, and how. */
  reviewer: ConsoleAgent & { prompt: string };
  /** Markdown: what the agent does with a review that requested changes, in repositories with revise on. */
  revisePrompt: string;
  /** Shell commands run in the sandbox after the agent, in order; the first that fails fails the run. */
  verify: string[];
  /** Agent time limit, minutes (CLI default 60). */
  timeoutMinutes?: number;
  /** All verify commands together, minutes (CLI default 15). */
  verifyTimeoutMinutes?: number;
}

export interface ConsoleTrigger {
  /** The issue label that starts the workflow. */
  label: string;
  workflow: string;
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
  triggers: ConsoleTrigger[];
  /** GitHub logins whose labels start work, and whose change requests are acted on. Never empty. */
  allowedActors: string[];
  baseBranch?: string;
  publish: (typeof PUBLISH_MODES)[number];
  commentOnFailure: boolean;
  /** A second agent reviews every pull request Updraft opens. */
  review: boolean;
  /** Changes requested by an allowed actor are made by the agent. */
  revise: boolean;
  maxRevisions?: number;
  /** Absent: off. Turning it on takes an explicit confirmation (config-service.ts). */
  autoMerge?: ConsoleAutoMerge;
}

export interface ConsoleConfig {
  version: typeof CONSOLE_VERSION;
  workflows: Record<string, ConsoleWorkflow>;
  /** By OWNER/REPO. */
  repositories: Record<string, ConsoleRepository>;
}

export const WORKFLOW_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REPO_NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
/** A GitHub login, or an App's bot (`name[bot]`). */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const BRANCH = /^[^\s~^:?*[\\]+$/;
const TOKEN = /^[A-Za-z0-9._:/-]+$/;

/** What a new tenant starts from: one workflow with the packaged prompts, and no repositories. */
export function defaultConsoleConfig(): ConsoleConfig {
  return {
    version: CONSOLE_VERSION,
    workflows: {
      implement: {
        agent: { adapter: 'claude' },
        prompt: DEFAULT_PROMPTS.implement,
        reviewer: { adapter: 'codex', prompt: DEFAULT_PROMPTS.review },
        revisePrompt: DEFAULT_PROMPTS.revise,
        verify: [],
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

function prompt(c: Check, path: string, v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') {
    c.err(path, 'required: the prompt tells the agent what to do');
    return '';
  }
  if (Buffer.byteLength(v, 'utf8') > CONSOLE_LIMITS.promptBytes) c.err(path, `larger than ${CONSOLE_LIMITS.promptBytes / 1024} KiB`);
  return v;
}

function agent(c: Check, path: string, v: unknown): ConsoleAgent {
  if (!isObject(v)) {
    c.err(path, 'must be a mapping');
    return { adapter: 'claude' };
  }
  only(c, path, v, path.endsWith('reviewer') ? ['adapter', 'model', 'effort', 'prompt'] : ['adapter', 'model', 'effort']);
  const adapter = v.adapter;
  if (typeof adapter !== 'string' || !(CONSOLE_AGENTS as string[]).includes(adapter)) c.err(`${path}.adapter`, `one of ${CONSOLE_AGENTS.join(', ')}`);
  const model = text(c, `${path}.model`, v.model, { pattern: TOKEN, what: 'a model name: letters, digits, ".", "_", ":", "/" or "-"' });
  const effort = text(c, `${path}.effort`, v.effort, { pattern: TOKEN, what: 'an effort level, such as low, medium or high' });
  return { adapter: (CONSOLE_AGENTS as string[]).includes(adapter as string) ? (adapter as CloudAgent) : 'claude', ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
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
  return out;
}

/**
 * Checks the shape of the console's settings, and returns them normalized (trimmed, defaults
 * filled, duplicates dropped). Every problem is reported, with the path of the field.
 */
export function parseConsoleConfig(raw: unknown): { ok: true; config: ConsoleConfig } | { ok: false; errors: ConfigIssue[] } {
  const c: Check = { errors: [], err: (path, message) => c.errors.push({ path, message }) };
  if (!isObject(raw)) return { ok: false, errors: [{ path: '(root)', message: 'the settings must be a mapping' }] };
  only(c, '', raw, ['version', 'workflows', 'repositories']);
  if (raw.version !== CONSOLE_VERSION) c.err('version', `must be ${CONSOLE_VERSION}`);

  const workflows: Record<string, ConsoleWorkflow> = {};
  if (!isObject(raw.workflows)) c.err('workflows', 'must be a mapping');
  else {
    const names = Object.keys(raw.workflows);
    if (names.length === 0) c.err('workflows', 'add at least one workflow');
    if (names.length > CONSOLE_LIMITS.workflows) c.err('workflows', `at most ${CONSOLE_LIMITS.workflows} workflows`);
    for (const [name, w] of Object.entries(raw.workflows)) {
      const path = `workflows.${name}`;
      if (!WORKFLOW_NAME.test(name)) c.err(path, 'a workflow name is lower-case letters, digits and "-", at most 40');
      if (!isObject(w)) {
        c.err(path, 'must be a mapping');
        continue;
      }
      only(c, path, w, ['agent', 'prompt', 'reviewer', 'revisePrompt', 'verify', 'timeoutMinutes', 'verifyTimeoutMinutes']);
      const reviewer = isObject(w.reviewer) ? w.reviewer : undefined;
      const verify: string[] = [];
      if (w.verify !== undefined && !Array.isArray(w.verify)) c.err(`${path}.verify`, 'must be a list of commands');
      else if (Array.isArray(w.verify)) {
        if (w.verify.length > CONSOLE_LIMITS.verifyCommands) c.err(`${path}.verify`, `at most ${CONSOLE_LIMITS.verifyCommands} commands`);
        w.verify.forEach((cmd, i) => {
          if (typeof cmd !== 'string' || cmd.trim() === '') return void c.err(`${path}.verify.${i}`, 'a command must not be empty');
          if (/[\r\n\0]/.test(cmd)) return void c.err(`${path}.verify.${i}`, 'one line per command');
          if (cmd.length > CONSOLE_LIMITS.verifyCommandLength) return void c.err(`${path}.verify.${i}`, `at most ${CONSOLE_LIMITS.verifyCommandLength} characters`);
          verify.push(cmd.trim());
        });
      }
      const timeoutMinutes = minutes(c, `${path}.timeoutMinutes`, w.timeoutMinutes, CEILINGS.timeoutMinutes);
      const verifyTimeoutMinutes = minutes(c, `${path}.verifyTimeoutMinutes`, w.verifyTimeoutMinutes, CEILINGS.verifyTimeoutMinutes);
      workflows[name] = {
        agent: agent(c, `${path}.agent`, w.agent),
        prompt: prompt(c, `${path}.prompt`, w.prompt),
        reviewer: { ...agent(c, `${path}.reviewer`, w.reviewer), prompt: prompt(c, `${path}.reviewer.prompt`, reviewer?.prompt) },
        revisePrompt: prompt(c, `${path}.revisePrompt`, w.revisePrompt),
        verify,
        ...(timeoutMinutes !== undefined ? { timeoutMinutes } : {}),
        ...(verifyTimeoutMinutes !== undefined ? { verifyTimeoutMinutes } : {}),
      };
    }
  }

  const repositories: Record<string, ConsoleRepository> = {};
  if (!isObject(raw.repositories)) c.err('repositories', 'must be a mapping');
  else {
    const names = Object.keys(raw.repositories);
    if (names.length > CONSOLE_LIMITS.repositories) c.err('repositories', `at most ${CONSOLE_LIMITS.repositories} repositories`);
    const seenRepos = new Set<string>();
    for (const [fullName, r] of Object.entries(raw.repositories)) {
      const path = `repositories.${fullName}`;
      if (!REPO_NAME.test(fullName)) c.err(path, 'expected OWNER/REPO');
      if (seenRepos.has(fullName.toLowerCase())) c.err(path, 'listed twice');
      seenRepos.add(fullName.toLowerCase());
      if (!isObject(r)) {
        c.err(path, 'must be a mapping');
        continue;
      }
      only(c, path, r, ['enabled', 'triggers', 'allowedActors', 'baseBranch', 'publish', 'commentOnFailure', 'review', 'revise', 'maxRevisions', 'autoMerge']);

      const triggers: ConsoleTrigger[] = [];
      if (!Array.isArray(r.triggers)) c.err(`${path}.triggers`, 'must be a list');
      else {
        if (r.triggers.length === 0) c.err(`${path}.triggers`, 'add a trigger label: it is how an issue starts a workflow');
        if (r.triggers.length > CONSOLE_LIMITS.triggersPerRepository) c.err(`${path}.triggers`, `at most ${CONSOLE_LIMITS.triggersPerRepository} triggers`);
        const labels = new Set<string>();
        r.triggers.forEach((t, i) => {
          const tp = `${path}.triggers.${i}`;
          if (!isObject(t)) return void c.err(tp, 'must be a mapping');
          only(c, tp, t, ['label', 'workflow']);
          const label = text(c, `${tp}.label`, t.label, { required: true, max: CONSOLE_LIMITS.labelLength });
          const workflow = text(c, `${tp}.workflow`, t.workflow, { required: true });
          if (label && labels.has(label.toLowerCase())) c.err(`${tp}.label`, 'another trigger of this repository has this label');
          if (label) labels.add(label.toLowerCase());
          if (workflow && isObject(raw.workflows) && !Object.hasOwn(raw.workflows, workflow)) c.err(`${tp}.workflow`, `there is no workflow "${workflow}"`);
          if (label && workflow) triggers.push({ label, workflow });
        });
      }

      const allowedActors = logins(c, `${path}.allowedActors`, r.allowedActors);
      if (Array.isArray(r.allowedActors) && allowedActors.length === 0) c.err(`${path}.allowedActors`, 'name at least one GitHub login who may start work by labeling an issue');
      if (allowedActors.length > CONSOLE_LIMITS.allowedActors) c.err(`${path}.allowedActors`, `at most ${CONSOLE_LIMITS.allowedActors} logins`);

      const publish = r.publish ?? 'draft-pr';
      if (!(PUBLISH_MODES as readonly unknown[]).includes(publish)) c.err(`${path}.publish`, 'draft-pr or pr');
      const baseBranch = text(c, `${path}.baseBranch`, r.baseBranch, { max: 255, pattern: BRANCH, what: 'a branch name' });
      const review = bool(c, `${path}.review`, r.review, false);
      const revise = bool(c, `${path}.revise`, r.revise, false);
      const maxRevisions = r.maxRevisions === undefined || r.maxRevisions === null || r.maxRevisions === '' ? undefined : r.maxRevisions;
      if (maxRevisions !== undefined && (typeof maxRevisions !== 'number' || !Number.isInteger(maxRevisions) || maxRevisions < 1 || maxRevisions > CEILINGS.maxRevisions)) {
        c.err(`${path}.maxRevisions`, `a whole number from 1 to ${CEILINGS.maxRevisions}`);
      }

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
          if (!review) c.err(ap, 'turn on review first: Updraft only merges a pull request its own reviewer found ready');
          autoMerge = {
            method: method as MergeMethod,
            ...(waitMinutes !== undefined ? { waitMinutes } : {}),
            ...(requiredChecks && requiredChecks.length ? { requiredChecks } : {}),
          };
        }
      }

      repositories[fullName] = {
        enabled: bool(c, `${path}.enabled`, r.enabled, true),
        triggers,
        allowedActors,
        ...(baseBranch ? { baseBranch } : {}),
        publish: publish as ConsoleRepository['publish'],
        commentOnFailure: bool(c, `${path}.commentOnFailure`, r.commentOnFailure, true),
        review,
        revise,
        ...(revise && maxRevisions !== undefined ? { maxRevisions: maxRevisions as number } : {}),
        ...(autoMerge ? { autoMerge } : {}),
      };
    }
    if (names.length === 0) c.err('repositories', 'add at least one repository');
  }

  if (c.errors.length) return { ok: false, errors: c.errors };
  return { ok: true, config: { version: CONSOLE_VERSION, workflows, repositories } };
}

/** Which workflows each role of an agent is needed for: by an enabled repository, reviewing or revising. */
function usage(config: ConsoleConfig, which: 'all' | 'enabled') {
  const used = new Map<string, { runs: boolean; review: boolean; revise: boolean }>();
  for (const repo of Object.values(config.repositories)) {
    if (which === 'enabled' && !repo.enabled) continue;
    for (const t of repo.triggers) {
      const u = used.get(t.workflow) ?? { runs: false, review: false, revise: false };
      used.set(t.workflow, { runs: true, review: u.review || repo.review, revise: u.revise || repo.revise });
    }
  }
  return used;
}

/**
 * Updraft Cloud's rule for agents: every agent an enabled repository can start needs its API key
 * set first (bring your own key, #64), or the job would fail in the microVM. `keys` are the names
 * of the tenant's keys that are set (never their values).
 */
export function missingKeys(config: ConsoleConfig, keys: ReadonlySet<string>): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  const need = (path: string, adapter: CloudAgent) => {
    const name = SUPPORTED_AGENT_KEY_ENV[adapter];
    if (!keys.has(name)) out.push({ path, message: `set the tenant's ${name} first: jobs run ${adapter} with your own key` });
  };
  for (const [name, u] of usage(config, 'enabled')) {
    const w = config.workflows[name];
    if (!w) continue;
    need(`workflows.${name}.agent.adapter`, w.agent.adapter);
    if (u.review) need(`workflows.${name}.reviewer.adapter`, w.reviewer.adapter);
  }
  return out;
}

/** The console's settings as an ordinary tenant config document and its prompt files (config.ts). */
export function toTenantSubmission(config: ConsoleConfig): TenantSubmission {
  const used = usage(config, 'all');
  const agents: Record<string, unknown> = {};
  const pools: Record<string, unknown> = {};
  const actions: Record<string, unknown> = {};
  const prompts: Record<string, string> = {};
  const profile = (a: ConsoleAgent) => ({ adapter: a.adapter, ...(a.model ? { model: a.model } : {}), ...(a.effort ? { effort: a.effort } : {}) });

  for (const [name, w] of Object.entries(config.workflows)) {
    const u = used.get(name) ?? { runs: false, review: false, revise: false };
    agents[name] = profile(w.agent);
    pools[name] = { agents: [name] };
    prompts[`${name}.md`] = w.prompt;
    const action: Record<string, unknown> = { prompt: `./prompts/${name}.md` };
    if (w.verify.length) action.verify = [...w.verify];
    if (w.timeoutMinutes !== undefined) action.timeoutMinutes = w.timeoutMinutes;
    if (w.verify.length && w.verifyTimeoutMinutes !== undefined) action.verifyTimeoutMinutes = w.verifyTimeoutMinutes;
    if (u.review) {
      agents[`${name}.review`] = profile(w.reviewer);
      pools[`${name}.review`] = { agents: [`${name}.review`] };
      prompts[`${name}.review.md`] = w.reviewer.prompt;
      action.reviewPrompt = `./prompts/${name}.review.md`;
    }
    if (u.revise) {
      prompts[`${name}.revise.md`] = w.revisePrompt;
      action.revisePrompt = `./prompts/${name}.revise.md`;
    }
    actions[name] = action;
  }

  const repositories: Record<string, unknown> = {};
  const everyone = new Map<string, string>();
  for (const [fullName, r] of Object.entries(config.repositories)) {
    for (const a of r.allowedActors) if (!everyone.has(a.toLowerCase())) everyone.set(a.toLowerCase(), a);
    repositories[fullName] = {
      ...(r.enabled ? {} : { paused: true }),
      ...(r.baseBranch ? { baseBranch: r.baseBranch } : {}),
      publish: r.publish,
      commentOnFailure: r.commentOnFailure,
      ...(r.review ? { review: true } : {}),
      ...(r.revise ? { revise: true, ...(r.maxRevisions !== undefined ? { maxRevisions: r.maxRevisions } : {}) } : {}),
      ...(r.autoMerge
        ? {
            autoMerge: r.autoMerge.method,
            ...(r.autoMerge.waitMinutes !== undefined ? { autoMergeWaitMinutes: r.autoMerge.waitMinutes } : {}),
            ...(r.autoMerge.requiredChecks?.length ? { autoMergeRequiredChecks: [...r.autoMerge.requiredChecks] } : {}),
          }
        : {}),
      workflows: r.triggers.map((t) => ({
        trigger: { event: 'issue.labeled', label: t.label },
        action: t.workflow,
        pool: t.workflow,
        allowedActors: [...r.allowedActors],
        ...(r.review ? { reviewPool: `${t.workflow}.review` } : {}),
      })),
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
  const workflows = Object.keys(config.workflows).sort((a, b) => b.length - a.length);
  const repos = Object.keys(config.repositories).sort((a, b) => b.length - a.length);
  const rest = (p: string, prefix: string) => (p === prefix ? '' : p.startsWith(`${prefix}.`) ? p.slice(prefix.length + 1) : null);
  const join = (...parts: string[]) => parts.filter((p) => p !== '').join('.');

  for (const w of workflows) {
    const base = `workflows.${w}`;
    let r: string | null;
    if ((r = rest(path, `agents.${w}.review`)) !== null) return join(base, 'reviewer', r);
    if ((r = rest(path, `agents.${w}`)) !== null) return join(base, 'agent', r);
    if (rest(path, `pools.${w}.review`) !== null) return join(base, 'reviewer');
    if (rest(path, `pools.${w}`) !== null) return join(base, 'agent');
    if ((r = rest(path, `actions.${w}`)) !== null) {
      if (r === 'reviewPrompt') return join(base, 'reviewer', 'prompt');
      return join(base, r);
    }
    if (path === `prompts/${w}.md` || path === `prompts.${w}.md`) return join(base, 'prompt');
    if (path === `prompts/${w}.review.md` || path === `prompts.${w}.review.md`) return join(base, 'reviewer', 'prompt');
    if (path === `prompts/${w}.revise.md` || path === `prompts.${w}.revise.md`) return join(base, 'revisePrompt');
  }
  for (const repo of repos) {
    const r = rest(path, `repositories.${repo}`);
    if (r === null) continue;
    const base = `repositories.${repo}`;
    const m = /^workflows\.(\d+)(?:\.(.*))?$/.exec(r);
    if (m) {
      const tail = m[2] ?? '';
      if (tail.startsWith('allowedActors')) return join(base, tail);
      if (tail.startsWith('trigger.label')) return join(base, 'triggers', m[1]!, 'label');
      if (tail === 'action' || tail === 'pool') return join(base, 'triggers', m[1]!, 'workflow');
      return join(base, 'triggers', m[1]!);
    }
    if (r.startsWith('autoMergeWaitMinutes')) return join(base, 'autoMerge', 'waitMinutes');
    if (r.startsWith('autoMergeRequiredChecks')) return join(base, 'autoMerge', r.replace(/^autoMergeRequiredChecks/, 'requiredChecks'));
    if (r === 'paused') return join(base, 'enabled');
    return join(base, r);
  }
  if (path.startsWith('dispatch.allowedActors')) return 'repositories';
  return path;
}
