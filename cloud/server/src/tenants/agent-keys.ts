import type { AgentKeyMeta, Store } from '../store/store.js';
// Not from config.ts: that pulls in the CLI's whole validator, which nothing here needs.
import { AGENT_KEY_ENV, SUPPORTED_AGENT_KEY_ENV, agentKeyVariables, type CloudAgent } from './agents.js';
import type { KeyChecker } from './key-check.js';

/**
 * A tenant's agent API keys (bring your own, #64). Each key is its own Secrets Manager secret,
 * `updraft/tenants/<installationId>/agent-keys/<NAME>`, whose value is the key itself. The job
 * broker (PR 3) reads a tenant's keys for that tenant's jobs only.
 *
 * One secret per key, not one JSON secret per tenant: writing a key never reads or rewrites
 * another, so two keys set at the same moment both survive.
 *
 * Write-only: nothing here, or anywhere in the API, returns a value. What can be read is that a
 * key is set, when, and by whom (AgentKeyMeta in the table).
 */

/** The keys this deployment asks for: its agents' API keys and what can stand in for them (a Claude subscription token). */
export const AGENT_KEY_NAMES = (Object.keys(AGENT_KEY_ENV) as CloudAgent[]).flatMap(agentKeyVariables);
/**
 * Keys no provider call checks when saved: Kiro's (it documents none), and a Claude
 * subscription token (Anthropic's API takes it only as Claude Code sends it). Only a job that ran
 * its agent says whether they work.
 */
export const UNCHECKED_AGENT_KEYS: ReadonlySet<string> = new Set([SUPPORTED_AGENT_KEY_ENV.kiro, 'CLAUDE_CODE_OAUTH_TOKEN']);

/** Every key any deployment may have stored: what an uninstall deletes, whatever is offered now. */
export const ALL_AGENT_KEY_NAMES = (Object.keys(SUPPORTED_AGENT_KEY_ENV) as CloudAgent[]).flatMap(agentKeyVariables);
/** Every key secret of a tenant starts with this (the uninstall cleanup deletes them by name). */
export const agentKeySecretPrefix = (installationId: number) => `updraft/tenants/${installationId}/agent-keys/`;
export const agentKeySecretName = (installationId: number, name: string) => `${agentKeySecretPrefix(installationId)}${name}`;

/** The Secrets Manager calls this needs, so tests need no AWS. */
export interface SecretsPort {
  /** Writes a new value, creating the secret (with these tags) when it does not exist; says which version it wrote. */
  put(name: string, value: string, tags: Record<string, string>): Promise<{ versionId?: string } | void>;
  /** Deletes the secret at once (no recovery window); nothing when it does not exist. */
  remove(name: string): Promise<void>;
}

/** Shapes of the keys we know, to catch a value pasted into the wrong name. Not a validity check. */
const KEY_SHAPE: Record<string, RegExp> = {
  // Not a subscription token (sk-ant-oat...): Claude Code would send that as an API key, and it fails.
  ANTHROPIC_API_KEY: /^sk-ant-(?!oat)[A-Za-z0-9_-]{20,}$/,
  // What `claude setup-token` prints.
  CLAUDE_CODE_OAUTH_TOKEN: /^sk-ant-oat\d+-[A-Za-z0-9_-]{20,}$/,
  CODEX_API_KEY: /^sk-[A-Za-z0-9_-]{20,}$/,
  // Kiro documents no format: one token of key characters, and never another provider's key.
  KIRO_API_KEY: /^(?!sk-)[A-Za-z0-9_.:+/=-]{20,512}$/,
};

/** A value that is the other of the two Claude credentials: said so, with where it goes. */
const WRONG_CLAUDE_FIELD: Record<string, { shape: RegExp; message: string }> = {
  ANTHROPIC_API_KEY: { shape: /^sk-ant-oat/, message: 'that is a Claude subscription token (from `claude setup-token`): set it as CLAUDE_CODE_OAUTH_TOKEN; nothing was changed' },
  CLAUDE_CODE_OAUTH_TOKEN: { shape: /^sk-ant-(?!oat)/, message: 'that is an Anthropic API key: set it as ANTHROPIC_API_KEY; nothing was changed' },
};

const PROVIDER: Record<string, string> = { ANTHROPIC_API_KEY: 'Anthropic', CLAUDE_CODE_OAUTH_TOKEN: 'Anthropic', CODEX_API_KEY: 'OpenAI', KIRO_API_KEY: 'Kiro' };
const providerOf = (name: string) => PROVIDER[name] ?? name;

export type SetKeyResult = { ok: true; meta: AgentKeyMeta } | { ok: false; message: string };

export async function setAgentKey(
  input: { installationId: number; name: string; value: string; updatedBy: string },
  deps: { secrets: SecretsPort; store: Store; check: KeyChecker; now?: () => number },
): Promise<SetKeyResult> {
  const { installationId, name, updatedBy } = input;
  const value = input.value.trim();
  if (!AGENT_KEY_NAMES.includes(name)) return { ok: false, message: `${name} is not an agent key Updraft Cloud uses (${AGENT_KEY_NAMES.join(', ')})` };
  // The value is never repeated, in any message.
  const wrong = WRONG_CLAUDE_FIELD[name];
  if (wrong?.shape.test(value)) return { ok: false, message: wrong.message };
  if (!KEY_SHAPE[name]!.test(value)) return { ok: false, message: `that does not look like a ${name}; nothing was changed` };
  const tenant = await deps.store.getTenant(installationId);
  if (!tenant) return { ok: false, message: `there is no tenant for installation ${installationId}` };
  if (tenant.disabledReason === 'uninstalled') return { ok: false, message: `installation ${installationId} was uninstalled` };

  // One cheap call to the provider, before anything is saved: a key it rejects is never stored.
  // If the provider cannot be reached, nothing is saved either (a bad key would break jobs later).
  const verdict = await deps.check(name, value);
  if (verdict === 'invalid') return { ok: false, message: `${providerOf(name)} rejected that key; nothing was changed` };
  if (verdict === 'unavailable') return { ok: false, message: `could not check the key with ${providerOf(name)} just now; nothing was changed, try again` };
  // 'unchecked': the provider has no call to check a key with (Kiro). Saved on its shape; the
  // first job that uses it tells, and the key's "last used" says how that went.

  const secretName = agentKeySecretName(installationId, name);
  await deps.secrets.put(secretName, value, { installationId: String(installationId), app: 'updraft-cloud' });
  const meta: AgentKeyMeta = { name, updatedAt: new Date((deps.now ?? Date.now)()).toISOString(), updatedBy };
  // Guarded: refused once the tenant is uninstalled, so no key row escapes the uninstall sweep.
  // The secret written in that race is removed again (and the uninstall cleanup deletes every
  // key secret of the tenant at the deadline in any case).
  if ((await deps.store.putAgentKeyMeta(installationId, meta)) !== 'stored') {
    await deps.secrets.remove(secretName).catch(() => {});
    return { ok: false, message: `installation ${installationId} was uninstalled` };
  }
  return { ok: true, meta };
}
