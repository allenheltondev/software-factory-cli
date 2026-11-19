import type { AgentKeyMeta, Store } from '../store/store.js';
import { AGENT_KEY_ENV } from './config.js';

/**
 * A tenant's agent API keys (bring your own, #64): one Secrets Manager secret per tenant,
 * `updraft/tenants/<installationId>/agent-env`, a JSON object of the variables the job passes to
 * its agents (`ANTHROPIC_API_KEY`, `CODEX_API_KEY`). The job broker (PR 3) reads it for that
 * tenant's jobs only.
 *
 * Write-only: nothing here, or anywhere in the API, returns a value. What can be read is that a
 * key is set, when, and by whom (AgentKeyMeta in the table).
 */

export const AGENT_KEY_NAMES = Object.values(AGENT_KEY_ENV) as string[];
export const agentEnvSecretName = (installationId: number) => `updraft/tenants/${installationId}/agent-env`;

/** The Secrets Manager calls this needs, so tests need no AWS. */
export interface SecretsPort {
  /** The secret's current value, or undefined when the secret does not exist yet. */
  get(name: string): Promise<string | undefined>;
  /** Writes a new value, creating the secret (with these tags) when it does not exist. */
  put(name: string, value: string, tags: Record<string, string>): Promise<void>;
}

/** Shapes of the keys we know, to catch a value pasted into the wrong name. Not a validity check. */
const KEY_SHAPE: Record<string, RegExp> = {
  ANTHROPIC_API_KEY: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
  CODEX_API_KEY: /^sk-[A-Za-z0-9_-]{20,}$/,
};

export type SetKeyResult = { ok: true; meta: AgentKeyMeta } | { ok: false; message: string };

export async function setAgentKey(
  input: { installationId: number; name: string; value: string; updatedBy: string },
  deps: { secrets: SecretsPort; store: Store; now?: () => number },
): Promise<SetKeyResult> {
  const { installationId, name, updatedBy } = input;
  const value = input.value.trim();
  if (!AGENT_KEY_NAMES.includes(name)) return { ok: false, message: `${name} is not an agent key Updraft Cloud uses (${AGENT_KEY_NAMES.join(', ')})` };
  // The value is never repeated, in any message.
  if (!KEY_SHAPE[name]!.test(value)) return { ok: false, message: `that does not look like a ${name}; nothing was changed` };
  const tenant = await deps.store.getTenant(installationId);
  if (!tenant) return { ok: false, message: `there is no tenant for installation ${installationId}` };
  if (tenant.disabledReason === 'uninstalled') return { ok: false, message: `installation ${installationId} was uninstalled` };

  const secretName = agentEnvSecretName(installationId);
  const current = await deps.secrets.get(secretName);
  let env: Record<string, string> = {};
  if (current) {
    try {
      const parsed = JSON.parse(current) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) env = parsed as Record<string, string>;
    } catch {
      // An unreadable secret is replaced by one holding just this key.
    }
  }
  env[name] = value;
  await deps.secrets.put(secretName, JSON.stringify(env), { installationId: String(installationId), app: 'updraft-cloud' });
  const meta: AgentKeyMeta = { name, updatedAt: new Date((deps.now ?? Date.now)()).toISOString(), updatedBy };
  await deps.store.putAgentKeyMeta(installationId, meta);
  return { ok: true, meta };
}
