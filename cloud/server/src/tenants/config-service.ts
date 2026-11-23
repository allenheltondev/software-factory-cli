import type { Caller } from '../caller.js';
import { FlowError, type ConfigContext, type GitHubFlows, type TenantSummary } from '../flows/github.js';
import type { GitHubRepository } from '../github/client.js';
import type { ConfigVersion, Store } from '../store/store.js';
import { AGENT_KEY_NAMES } from './agent-keys.js';
import { CEILINGS, compileTenantConfig, type ConfigIssue, type TenantSubmission } from './config.js';
import { CONSOLE_AGENTS, CONSOLE_LIMITS, defaultConsoleConfig, missingKeys, parseConsoleConfig, toConsolePath, toTenantSubmission, upgradeNotes, type ConsoleConfig } from './console.js';
import * as v1 from './console-v1.js';
import type { CloudAgent } from './agents.js';
import { DEFAULT_PROMPTS } from './default-prompts.js';
import { configPrefix, SOURCE_FILE } from './paths.js';
import { publishTenantConfig, type ConfigSource } from './publish.js';

/**
 * A tenant's configuration in the console (#69), for its members only: what the editor loads,
 * a preview of the compiled config, publishing, the version history and re-activating a version.
 *
 * - **Validation** is the worker's own (`validateConfig`, through config.ts) plus Updraft Cloud's
 *   rules (console.ts): platform-enforced fields, limits, and agents whose keys are set. A preview
 *   and a publish check exactly the same things.
 * - **Publishing** is publish.ts: the bundle is uploaded to `config/<n+1>/` first, and only then
 *   does the tenant's `activeConfigVersion` move, in a conditional write. Anything that fails
 *   leaves the active version as it was.
 * - **Two people editing at once:** a publish names the version it was edited from
 *   (`baseVersion`); if another was activated since, it is refused (`config_changed`), never
 *   silently overwritten.
 * - **Auto-merge** that the active version had off is turned on only with `confirmAutoMerge`.
 * - **Re-activating** an earlier version publishes a copy of it as a new version (versions only
 *   grow), checked against today's rules: repositories the installation still reaches, keys that
 *   are still set.
 * - A running job keeps the version it pinned (jobs/launch.ts), whatever is published meanwhile.
 */

export interface ObjectStore {
  /** The object's text, or null when there is none (only listed files are ever asked for). */
  get(key: string): Promise<string | null>;
  put(key: string, body: string, contentType: string): Promise<void>;
}

export interface ConfigServiceDeps {
  store: Store;
  github: Pick<GitHubFlows, 'configContext'>;
  objects: ObjectStore;
  now?: () => number;
}

export interface VersionSummary {
  version: number;
  status: ConfigVersion['status'];
  publishedAt: string;
  publishedBy: string;
  sha256: string;
  active: boolean;
  copiedFrom?: number;
}

export interface ConfigView {
  tenant: TenantSummary;
  /** The caller's GitHub login: the allowed actor a new configuration starts with. */
  githubLogin: string;
  /** What the installation reaches: the repositories that can be configured. */
  repositories: GitHubRepository[];
  /** Which agent keys are set (never their values). */
  agentKeys: Record<string, boolean>;
  /** The agents this deployment runs (CLOUD_AGENTS): what the editor offers. */
  agents: CloudAgent[];
  activeVersion: number | null;
  /**
   * What the active version was written as: `console` (its settings are `config`), `tenant` (a
   * config document from tenant-admin, which the editor cannot show: `config` is the defaults),
   * or `none` (nothing published yet, or published before versions kept their source).
   */
  source: 'console' | 'tenant' | 'none';
  config: ConsoleConfig;
  /** What upgrading the active version's settings to the current editor could not keep as it was. */
  notices: string[];
  defaults: { prompts: typeof DEFAULT_PROMPTS };
  limits: { ceilings: typeof CEILINGS; console: typeof CONSOLE_LIMITS };
}

export type CheckResult =
  | { ok: true; yaml: string; warnings: ConfigIssue[]; autoMergeTurnedOn: string[] }
  | { ok: false; errors: ConfigIssue[]; warnings: ConfigIssue[] };

export type PublishOutcome =
  | { ok: true; version: number; yaml: string; warnings: ConfigIssue[] }
  | { ok: false; errors: ConfigIssue[]; warnings: ConfigIssue[] };

interface Compiled {
  submission: TenantSubmission;
  source: ConfigSource;
  yaml: string;
  warnings: ConfigIssue[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Repositories (lower-case) whose auto-merge a version's source turns on. */
function autoMergeRepositories(source: ConfigSource | null): Map<string, string> {
  const out = new Map<string, string>();
  const repos = source && isObject(source.config) && isObject(source.config.repositories) ? source.config.repositories : {};
  for (const [name, r] of Object.entries(repos)) {
    if (isObject(r) && r.autoMerge !== undefined && r.autoMerge !== null && r.autoMerge !== false) out.set(name.toLowerCase(), name);
  }
  return out;
}

export function createConfigService({ store, github, objects, now = () => Date.now() }: ConfigServiceDeps) {
  /** What a version was written as; null for one published before versions kept it. */
  async function readSource(v: ConfigVersion): Promise<ConfigSource | null> {
    // Only files the version lists are read, so a missing object is never asked for.
    if (!v.files.includes(SOURCE_FILE)) return null;
    const text = await objects.get(`${configPrefix(v.installationId, v.version)}${SOURCE_FILE}`);
    if (text === null) return null;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isObject(parsed) && (parsed.format === 'console' || parsed.format === 'tenant')) return parsed as ConfigSource;
    } catch {
      // Unreadable: treated as none.
    }
    return null;
  }

  async function keysSet(installationId: number): Promise<Set<string>> {
    return new Set((await store.listAgentKeyMeta(installationId)).map((k) => k.name));
  }

  const repositoryIds = (ctx: ConfigContext) => new Map(ctx.repositories.map((r) => [r.fullName.toLowerCase(), r.id]));

  /** Everything a publish checks, without storing anything. */
  async function compile(ctx: ConfigContext, source: ConfigSource, prompts: Record<string, string> | null): Promise<{ ok: true; compiled: Compiled } | { ok: false; errors: ConfigIssue[]; warnings: ConfigIssue[] }> {
    let submission: TenantSubmission;
    let consoleConfig: ConsoleConfig | null = null;
    let v1Config: v1.ConsoleConfig | null = null;
    if (source.format === 'console' && isObject(source.config) && source.config.version === 1) {
      // A version the first console published, being re-activated: compiled by the compiler it was
      // published with, so its actions, pools and workflow ids are exactly what its jobs stored.
      const parsed = v1.parseConsoleConfig(source.config);
      if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: [] };
      v1Config = parsed.config;
      const keyErrors = v1.missingKeys(parsed.config, await keysSet(ctx.tenant.installationId));
      if (keyErrors.length) return { ok: false, errors: keyErrors, warnings: [] };
      submission = v1.toTenantSubmission(parsed.config);
      source = { format: 'console', config: parsed.config };
    } else if (source.format === 'console') {
      const parsed = parseConsoleConfig(source.config);
      if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: [] };
      consoleConfig = parsed.config;
      const keyErrors = missingKeys(parsed.config, await keysSet(ctx.tenant.installationId));
      if (keyErrors.length) return { ok: false, errors: keyErrors, warnings: [] };
      submission = toTenantSubmission(parsed.config);
      source = { format: 'console', config: parsed.config };
    } else {
      submission = { config: source.config, prompts: prompts ?? {} };
    }
    const result = compileTenantConfig(submission, { appId: ctx.appId }, repositoryIds(ctx));
    const map = (issues: ConfigIssue[]) =>
      consoleConfig ? issues.map((i) => ({ ...i, path: toConsolePath(i.path, consoleConfig) })) : v1Config ? issues.map((i) => ({ ...i, path: v1.toConsolePath(i.path, v1Config) })) : issues;
    if (!result.ok) return { ok: false, errors: map(result.errors), warnings: [] };
    // Whatever it was written as (a tenant-admin version being re-activated included): every agent
    // an enabled repository can start needs its key set now, or its jobs would fail.
    const keys = await keysSet(ctx.tenant.installationId);
    const unset = result.keys.filter((k) => !keys.has(k.key)).map((k) => ({ path: k.path, message: `set the tenant's ${k.key} first: jobs run this agent with your own key` }));
    if (unset.length) return { ok: false, errors: map(unset), warnings: [] };
    return { ok: true, compiled: { submission, source, yaml: result.files['config.yaml']!, warnings: map(result.warnings) } };
  }

  async function activeSource(installationId: number, active: number | undefined): Promise<ConfigSource | null> {
    if (active === undefined) return null;
    const v = await store.getConfigVersion(installationId, active, { consistent: true });
    return v ? readSource(v) : null;
  }

  function requireActive(ctx: ConfigContext) {
    if (ctx.tenant.status !== 'active') {
      throw new FlowError('tenant_disabled', 409, 'This installation is not active, so its configuration cannot be published');
    }
  }

  /**
   * Stores and activates a compiled config. `expectedActive` is the active version its conflict
   * and auto-merge checks were made against: activation is refused unless it is still active, in
   * the same conditional write, so a concurrent editor's version is never overwritten.
   */
  async function storeVersion(ctx: ConfigContext, compiled: Compiled, expectedActive: number | null, copiedFrom?: number): Promise<PublishOutcome> {
    const result = await publishTenantConfig(
      {
        installationId: ctx.tenant.installationId,
        submission: compiled.submission,
        platform: { appId: ctx.appId },
        repositoryIds: repositoryIds(ctx),
        publishedBy: ctx.githubLogin,
        source: compiled.source,
        expectedActive,
        ...(copiedFrom !== undefined ? { copiedFrom } : {}),
      },
      { store, putObject: objects.put, now },
    );
    if (result.ok) return { ok: true, version: result.version, yaml: result.yaml, warnings: compiled.warnings };
    if (result.reason === 'invalid') return { ok: false, errors: result.errors, warnings: [] };
    if (result.reason === 'superseded' || result.reason === 'changed') {
      throw new FlowError('config_changed', 409, 'Someone published another version at the same time; it stays active. Reload to see it, then make your changes again.');
    }
    if (result.reason === 'uninstalled' || result.reason === 'no_tenant') throw new FlowError('not_authorized', 403, 'You are not a member of that installation');
    throw new FlowError('config_changed', 409, result.message);
  }

  /** Refuses turning auto-merge on without the explicit confirmation. */
  function confirmAutoMerge(turnedOn: string[], confirmed: boolean) {
    if (turnedOn.length && !confirmed) {
      throw new FlowError('auto_merge_unconfirmed', 409, `Confirm turning on auto-merge for ${turnedOn.join(', ')}: Updraft will merge pull requests its reviewer approves`);
    }
  }

  const turnedOn = (previous: ConfigSource | null, next: ConfigSource) => {
    const before = autoMergeRepositories(previous);
    return [...autoMergeRepositories(next)].filter(([lower]) => !before.has(lower)).map(([, name]) => name).sort();
  };

  return {
    async load(caller: Caller, installationId: number): Promise<ConfigView> {
      const ctx = await github.configContext(caller, installationId);
      const active = ctx.tenant.activeConfigVersion;
      const [source, keys] = await Promise.all([activeSource(installationId, active), keysSet(installationId)]);
      let config = defaultConsoleConfig({ offered: CONSOLE_AGENTS, login: ctx.githubLogin, keys });
      const kind: ConfigView['source'] = source?.format ?? 'none';
      let notices: string[] = [];
      if (source?.format === 'console') {
        const parsed = parseConsoleConfig(source.config);
        if (parsed.ok) {
          config = parsed.config;
          notices = upgradeNotes(source.config);
        } else {
          // Never a silent fallback: the editor starts from the defaults, and says why. The
          // version itself still runs, and re-activates as it was.
          notices = [
            `Version ${active} could not be opened in this editor (${parsed.errors
              .slice(0, 3)
              .map((e) => `${e.path}: ${e.message}`)
              .join('; ')}${parsed.errors.length > 3 ? '; ...' : ''}). The editor starts from the defaults, and publishing from here replaces it.`,
          ];
        }
      }
      return {
        tenant: ctx.summary,
        githubLogin: ctx.githubLogin,
        repositories: ctx.repositories,
        agentKeys: Object.fromEntries(AGENT_KEY_NAMES.map((n) => [n, keys.has(n)])),
        agents: [...CONSOLE_AGENTS],
        activeVersion: active ?? null,
        source: kind,
        config,
        notices,
        defaults: { prompts: DEFAULT_PROMPTS },
        limits: { ceilings: CEILINGS, console: CONSOLE_LIMITS },
      };
    },

    /** The generated YAML and every problem a publish would find, storing nothing. */
    async preview(caller: Caller, installationId: number, config: unknown): Promise<CheckResult> {
      const ctx = await github.configContext(caller, installationId);
      const out = await compile(ctx, { format: 'console', config }, null);
      if (!out.ok) return out;
      const previous = await activeSource(installationId, ctx.tenant.activeConfigVersion);
      return { ok: true, yaml: out.compiled.yaml, warnings: out.compiled.warnings, autoMergeTurnedOn: turnedOn(previous, out.compiled.source) };
    },

    async publish(
      caller: Caller,
      installationId: number,
      input: { config: unknown; baseVersion?: number | null; confirmAutoMerge?: boolean },
    ): Promise<PublishOutcome> {
      const ctx = await github.configContext(caller, installationId);
      requireActive(ctx);
      const active = ctx.tenant.activeConfigVersion ?? null;
      if (input.baseVersion !== undefined && input.baseVersion !== active) {
        throw new FlowError('config_changed', 409, `Version ${active} was published since you started editing; reload to see it, then make your changes again`);
      }
      const out = await compile(ctx, { format: 'console', config: input.config }, null);
      if (!out.ok) return out;
      confirmAutoMerge(turnedOn(await activeSource(installationId, active ?? undefined), out.compiled.source), input.confirmAutoMerge === true);
      return storeVersion(ctx, out.compiled, active);
    },

    async versions(caller: Caller, installationId: number): Promise<{ activeVersion: number | null; versions: VersionSummary[] }> {
      const ctx = await github.configContext(caller, installationId);
      const active = ctx.tenant.activeConfigVersion ?? null;
      const versions = (await store.listConfigVersions(installationId))
        .map((v) => ({
          version: v.version,
          status: v.status,
          publishedAt: v.publishedAt,
          publishedBy: v.publishedBy,
          sha256: v.sha256,
          active: v.version === active,
          ...(v.copiedFrom !== undefined ? { copiedFrom: v.copiedFrom } : {}),
        }))
        .sort((a, b) => b.version - a.version);
      return { activeVersion: active, versions };
    },

    /** One version's files as jobs see them (config.yaml and prompts/), for the history's diff. */
    async version(caller: Caller, installationId: number, version: number): Promise<{ version: VersionSummary; files: Record<string, string> }> {
      const ctx = await github.configContext(caller, installationId);
      const v = await store.getConfigVersion(installationId, version);
      if (!v) throw new FlowError('not_found', 404, `There is no version ${version}`);
      // A pending version's upload may have stopped partway, so its files are not read at all.
      const names = v.status === 'ready' ? v.files.filter((f) => f !== SOURCE_FILE) : [];
      const texts = await Promise.all(names.map((f) => objects.get(`${configPrefix(installationId, version)}${f}`)));
      const files: Record<string, string> = {};
      names.forEach((f, i) => {
        if (texts[i] !== null) files[f] = texts[i]!;
      });
      return {
        version: {
          version: v.version,
          status: v.status,
          publishedAt: v.publishedAt,
          publishedBy: v.publishedBy,
          sha256: v.sha256,
          active: v.version === ctx.tenant.activeConfigVersion,
          ...(v.copiedFrom !== undefined ? { copiedFrom: v.copiedFrom } : {}),
        },
        files,
      };
    },

    /** Publishes a copy of an earlier version as the next one, checked against today's rules. */
    async reactivate(caller: Caller, installationId: number, version: number, input: { confirmAutoMerge?: boolean } = {}): Promise<PublishOutcome> {
      const ctx = await github.configContext(caller, installationId);
      requireActive(ctx);
      const v = await store.getConfigVersion(installationId, version);
      if (!v) throw new FlowError('not_found', 404, `There is no version ${version}`);
      if (v.status !== 'ready') throw new FlowError('not_reactivatable', 409, `Version ${version} was never fully published, so it cannot be re-activated`);
      if (v.version === ctx.tenant.activeConfigVersion) throw new FlowError('not_reactivatable', 409, `Version ${version} is already active`);
      const source = await readSource(v);
      if (!source) throw new FlowError('not_reactivatable', 409, `Version ${version} was published before versions kept their settings, so it cannot be re-activated`);

      let prompts: Record<string, string> | null = null;
      if (source.format === 'tenant') {
        prompts = {};
        for (const f of v.files.filter((f) => f.startsWith('prompts/'))) {
          const text = await objects.get(`${configPrefix(installationId, version)}${f}`);
          if (text !== null) prompts[f.slice('prompts/'.length)] = text;
        }
      }
      const out = await compile(ctx, source, prompts);
      if (!out.ok) return out;
      const active = ctx.tenant.activeConfigVersion ?? null;
      confirmAutoMerge(turnedOn(await activeSource(installationId, active ?? undefined), out.compiled.source), input.confirmAutoMerge === true);
      return storeVersion(ctx, out.compiled, active, version);
    },
  };
}

export type ConfigService = ReturnType<typeof createConfigService>;
