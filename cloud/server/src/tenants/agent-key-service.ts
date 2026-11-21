import type { Caller } from '../caller.js';
import { FlowError, type GitHubFlows } from '../flows/github.js';
import type { DispatchRefusal, Store } from '../store/store.js';
import { AGENT_KEY_NAMES, setAgentKey, type SecretsPort } from './agent-keys.js';
import type { KeyChecker } from './key-check.js';

/**
 * A tenant's agent keys in the console (#70), for its members only. Values are write-only:
 * `PUT` takes one, nothing returns one. What a member sees per key is whether it is set, when it
 * was last rotated, and whether the last job that used it worked.
 */

export interface AgentKeyView {
  name: string;
  configured: boolean;
  /** The active config runs an agent that needs this key: without it no job starts. */
  required: boolean;
  lastRotatedAt?: string;
  lastRotatedBy?: string;
  /** Absent until a job has used the key. */
  lastUsed?: { at: string; ok: boolean };
}

export interface AgentKeysView {
  keys: AgentKeyView[];
  /** Launches refused recently, and why (a key not set is one reason). */
  refusals: DispatchRefusal[];
}

export interface AgentKeyServiceDeps {
  store: Store;
  github: Pick<GitHubFlows, 'configContext'>;
  secrets: SecretsPort;
  check: KeyChecker;
  now?: () => number;
}

export function createAgentKeyService({ store, github, secrets, check, now }: AgentKeyServiceDeps) {
  async function view(installationId: number): Promise<AgentKeysView> {
    const [metas, refusals, tenant] = await Promise.all([store.listAgentKeyMeta(installationId), store.listRefusals(installationId, 10), store.getTenant(installationId, { consistent: true })]);
    const active = tenant?.activeConfigVersion;
    const needed = new Set(active === undefined ? [] : ((await store.getConfigVersion(installationId, active, { consistent: true }))?.dispatch?.keys ?? []));
    const byName = new Map(metas.map((m) => [m.name, m]));
    return {
      keys: AGENT_KEY_NAMES.map((name) => {
        const m = byName.get(name);
        if (!m) return { name, configured: false, required: needed.has(name) };
        return {
          name,
          configured: true,
          required: needed.has(name),
          lastRotatedAt: m.updatedAt,
          lastRotatedBy: m.updatedBy,
          ...(m.lastUsedAt ? { lastUsed: { at: m.lastUsedAt, ok: m.lastUsedOk === true } } : {}),
        };
      }),
      refusals,
    };
  }

  // The config context is the membership check, as for the configuration (not_authorized otherwise).
  const member = (caller: Caller, installationId: number) => github.configContext(caller, installationId);

  return {
    async list(caller: Caller, installationId: number): Promise<AgentKeysView> {
      await member(caller, installationId);
      return view(installationId);
    },
    async set(caller: Caller, installationId: number, name: string, value: unknown): Promise<AgentKeysView> {
      const ctx = await member(caller, installationId);
      if (typeof value !== 'string' || value === '' || value.length > 512) throw new FlowError('invalid_key', 400, 'Send the key as a string in `value`');
      const out = await setAgentKey({ installationId, name, value, updatedBy: ctx.githubLogin }, { secrets, store, check, ...(now ? { now } : {}) });
      if (!out.ok) throw new FlowError('invalid_key', 400, out.message);
      return view(installationId);
    },
  };
}

export type AgentKeyService = ReturnType<typeof createAgentKeyService>;
