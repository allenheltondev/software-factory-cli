import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
// The CLI's own schema and validator (the `@allenheltondev/updraft/config` entry point), from this
// repository's source: a tenant's config is checked exactly as the worker in the microVM will.
import { validateConfig } from '../../../../src/config/public.js';

/**
 * A tenant's Updraft config, compiled from what the tenant wrote plus what the platform enforces
 * (#68, "Platform-enforced config").
 *
 * Tenants write an ordinary Updraft config (`agents`, `pools`, `actions`, `repositories`,
 * `dispatch`, `review`), minus everything that decides where and how a job runs. Tenant input
 * for any of those is rejected with the path, never silently overridden, and then the platform
 * writes them:
 *
 *   - `version: 1`, `execution.mode: live`, `maxConcurrent: 1`
 *   - `github.app`: the platform App, read from a token file the runner keeps current
 *     (`tokenFile`, #77), committing as the App's bot. The App's private key never enters a job.
 *   - every agent: one at a time, in the microVM's sandbox runtime (the #63 `container` block,
 *     AgentIsolation=enforced), with only its own API key's variable passed in
 *   - every repository: cloned under `./clones/`, published as a draft PR (or a PR), never
 *     anything else
 *   - timeouts within ceilings
 *
 * And the result is validated with the worker's own `validateConfig`, so a config that passes
 * here is one the job accepts.
 */

/** Agents the job image ships, and the variable each one's API key is passed in as. */
export const AGENT_KEY_ENV = { claude: 'ANTHROPIC_API_KEY', codex: 'CODEX_API_KEY' } as const;
export type CloudAgent = keyof typeof AGENT_KEY_ENV;

/** The #63 sandbox runtime every agent and verify command runs in. */
export const SANDBOX_CONTAINER = { image: 'microvm', runtime: '/opt/updraft/bin/updraft-sandbox' } as const;
/** Where the runner writes the job's installation token (token-file-auth.ts in the CLI). */
export const TOKEN_FILE = './app-token.json';

export const CEILINGS = {
  /** An action's agent run. */
  timeoutMinutes: 120,
  /** One verify command. */
  verifyTimeoutMinutes: 30,
  autoMergeWaitMinutes: 120,
  maxRevisions: 5,
} as const;

export interface ConfigIssue {
  path: string;
  message: string;
}

export interface PlatformSettings {
  /** The platform App's numeric id. */
  appId: number;
}

/** A tenant's submission: the config document, and the prompt files it references by `./prompts/<name>`. */
export interface TenantSubmission {
  config: unknown;
  prompts: Record<string, string>;
}

export type CompileResult =
  | { ok: true; files: Record<string, string>; sha256: string; warnings: ConfigIssue[] }
  | { ok: false; errors: ConfigIssue[] };

const TOP_LEVEL = new Set(['agents', 'pools', 'actions', 'repositories', 'dispatch', 'review']);
const PLATFORM_TOP_LEVEL: Record<string, string> = {
  version: 'set by the platform (1)',
  execution: 'jobs always run live in the platform runtime',
  github: 'jobs act as the platform GitHub App',
  maxConcurrent: 'one job runs at a time per tenant (quotas)',
  pollIntervalSeconds: 'jobs start from webhooks, not polling',
  capacity: 'capacity groups describe local subscriptions, which a hosted job does not have',
};
const AGENT_KEYS = new Set(['adapter', 'enabled', 'model', 'effort']);
const PLATFORM_AGENT_KEYS: Record<string, string> = {
  command: 'the job image provides the agent CLI',
  args: 'arguments could change how the agent runs outside the platform defaults',
  env: 'API keys are set as agent keys, never in the config',
  container: 'every agent runs in the platform sandbox',
  capacityGroup: 'capacity groups describe local subscriptions',
  maxConcurrent: 'one agent run at a time',
};
const PLATFORM_REPO_KEYS: Record<string, string> = {
  checkoutPath: 'set by the platform (./clones/<name>)',
  remote: 'set by the platform',
  dependencies: "a job's GitHub token reaches only its own repository, so it cannot watch another",
  id: 'set by the platform from the installation',
};
const PROMPT_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.md$/;
const PROMPT_REF = /^\.\/prompts\/([A-Za-z0-9][A-Za-z0-9_.-]*\.md)$/;
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_PROMPTS = 50;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Compiles and validates a tenant's submission. `repositoryIds` maps each repository the tenant
 * names (OWNER/REPO, any case) to its GitHub id, as the installation reports it; a repository
 * missing from it is not one the installation can reach and is refused.
 */
export function compileTenantConfig(submission: TenantSubmission, platform: PlatformSettings, repositoryIds: ReadonlyMap<string, number>): CompileResult {
  const errors: ConfigIssue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const input = submission.config;
  if (!isObject(input)) return { ok: false, errors: [{ path: '(root)', message: 'the config must be a mapping' }] };

  for (const key of Object.keys(input)) {
    if (key in PLATFORM_TOP_LEVEL) err(key, `not set by tenants: ${PLATFORM_TOP_LEVEL[key]}`);
    else if (!TOP_LEVEL.has(key)) err(key, 'not a setting Updraft Cloud accepts');
  }

  // Agents: only the ones the image ships, only the keys that choose a model.
  const agents: Record<string, Record<string, unknown>> = {};
  if (input.agents !== undefined) {
    if (!isObject(input.agents)) err('agents', 'must be a mapping');
    else {
      for (const [name, value] of Object.entries(input.agents)) {
        const path = `agents.${name}`;
        if (!isObject(value)) {
          err(path, 'must be a mapping');
          continue;
        }
        const adapter = (value.adapter ?? name) as string;
        if (!(adapter in AGENT_KEY_ENV)) {
          err(value.adapter !== undefined ? `${path}.adapter` : path, `not an agent Updraft Cloud runs (${Object.keys(AGENT_KEY_ENV).join(', ')})`);
          continue;
        }
        for (const key of Object.keys(value)) {
          if (key in PLATFORM_AGENT_KEYS) err(`${path}.${key}`, `not set by tenants: ${PLATFORM_AGENT_KEYS[key]}`);
          else if (!AGENT_KEYS.has(key)) err(`${path}.${key}`, 'not a setting Updraft Cloud accepts for an agent');
        }
        agents[name] = {
          ...value,
          maxConcurrent: 1,
          container: { ...SANDBOX_CONTAINER, env: [AGENT_KEY_ENV[adapter as CloudAgent]] },
        };
      }
    }
  }

  // Actions: prompts from the submitted files only, timeouts within ceilings.
  const prompts: Record<string, string> = {};
  const promptNames = Object.keys(submission.prompts);
  if (promptNames.length > MAX_PROMPTS) err('prompts', `at most ${MAX_PROMPTS} prompt files`);
  for (const [file, text] of Object.entries(submission.prompts)) {
    if (!PROMPT_FILE.test(file)) err(`prompts.${file}`, 'a prompt file is a plain name ending in .md');
    else if (Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) err(`prompts.${file}`, `larger than ${MAX_PROMPT_BYTES / 1024} KiB`);
    else prompts[`prompts/${file}`] = text;
  }
  const usedPrompts = new Set<string>();
  if (isObject(input.actions)) {
    for (const [name, action] of Object.entries(input.actions)) {
      if (!isObject(action)) continue;
      const path = `actions.${name}`;
      for (const field of ['prompt', 'revisePrompt', 'reviewPrompt'] as const) {
        const ref = action[field];
        if (ref === undefined) continue;
        const m = typeof ref === 'string' ? PROMPT_REF.exec(ref) : null;
        if (!m) err(`${path}.${field}`, 'must be ./prompts/<name>.md, one of the prompt files you submit');
        else if (!(`prompts/${m[1]}` in prompts)) err(`${path}.${field}`, `${ref} is not among the submitted prompt files`);
        else usedPrompts.add(`prompts/${m[1]}`);
      }
      const ceiling = (field: 'timeoutMinutes' | 'verifyTimeoutMinutes') => {
        const v = action[field];
        if (typeof v === 'number' && v > CEILINGS[field]) err(`${path}.${field}`, `at most ${CEILINGS[field]} minutes on Updraft Cloud`);
      };
      ceiling('timeoutMinutes');
      ceiling('verifyTimeoutMinutes');
      if (action.output !== undefined && action.output !== 'local-branch') err(`${path}.output`, 'must be local-branch: a hosted job publishes its branch');
    }
  }

  // Repositories: ones the installation reaches, cloned and published the platform's way.
  const repositories: Record<string, Record<string, unknown>> = {};
  if (input.repositories !== undefined && !isObject(input.repositories)) err('repositories', 'must be a mapping');
  else if (isObject(input.repositories)) {
    for (const [fullName, repo] of Object.entries(input.repositories)) {
      const path = `repositories.${fullName}`;
      if (!isObject(repo)) {
        err(path, 'must be a mapping');
        continue;
      }
      const id = repositoryIds.get(fullName.toLowerCase());
      if (id === undefined) err(path, 'the Updraft App installation cannot access this repository');
      for (const key of Object.keys(repo)) if (key in PLATFORM_REPO_KEYS) err(`${path}.${key}`, `not set by tenants: ${PLATFORM_REPO_KEYS[key]}`);
      const publish = repo.publish ?? 'draft-pr';
      if (publish !== 'draft-pr' && publish !== 'pr') err(`${path}.publish`, 'must be draft-pr or pr on Updraft Cloud');
      if (typeof repo.autoMergeWaitMinutes === 'number' && repo.autoMergeWaitMinutes > CEILINGS.autoMergeWaitMinutes) {
        err(`${path}.autoMergeWaitMinutes`, `at most ${CEILINGS.autoMergeWaitMinutes} minutes on Updraft Cloud`);
      }
      if (typeof repo.maxRevisions === 'number' && repo.maxRevisions > CEILINGS.maxRevisions) err(`${path}.maxRevisions`, `at most ${CEILINGS.maxRevisions} on Updraft Cloud`);
      if (Array.isArray(repo.workflows)) {
        repo.workflows.forEach((w, i) => {
          // Triage starts an agent CLI outside any container, which an enforced job refuses (#63).
          if (isObject(w) && isObject(w.tiers) && w.tiers.triage !== undefined) err(`${path}.workflows.${i}.tiers.triage`, 'not available on Updraft Cloud: triage runs outside the sandbox');
        });
      }
      if (isObject(repo.tiers) && repo.tiers.triage !== undefined) err(`${path}.tiers.triage`, 'not available on Updraft Cloud: triage runs outside the sandbox');
      const name = fullName.split('/')[1] ?? fullName;
      repositories[fullName] = { ...repo, ...(id !== undefined ? { id } : {}), checkoutPath: `./clones/${name}`, publish };
    }
  }

  const dispatch = isObject(input.dispatch) ? input.dispatch : {};
  if (!Array.isArray(dispatch.allowedActors) || dispatch.allowedActors.length === 0) {
    err('dispatch.allowedActors', 'name at least one GitHub login who may start work by labeling an issue');
  }

  if (errors.length) return { ok: false, errors };

  const compiled = {
    version: 1,
    execution: { mode: 'live' },
    maxConcurrent: 1,
    github: { app: { appId: platform.appId, tokenFile: TOKEN_FILE, commitAsApp: true } },
    dispatch,
    ...(input.review !== undefined ? { review: input.review } : {}),
    agents,
    pools: input.pools ?? {},
    actions: input.actions ?? {},
    repositories,
  };
  // As the job will: in the Linux microVM, whatever this process runs on.
  const result = validateConfig(compiled, { platform: 'linux' });
  if (!result.ok) return { ok: false, errors: result.errors };

  const warnings = [...result.warnings];
  for (const file of Object.keys(prompts)) if (!usedPrompts.has(file)) warnings.push({ path: file, message: 'not referenced by any action; it is stored anyway' });

  const files: Record<string, string> = { 'config.yaml': stringify(compiled), ...prompts };
  return { ok: true, files, sha256: bundleHash(files), warnings };
}

/** A stable hash of a bundle: every file's path and content, in path order. */
export function bundleHash(files: Record<string, string>): string {
  const h = createHash('sha256');
  for (const path of Object.keys(files).sort()) h.update(`${path}\0${files[path]}\0`);
  return h.digest('hex');
}
