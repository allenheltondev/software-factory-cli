import { configKeys } from './adapters/codex.js';

/**
 * Codex config keys that choose the model provider, the auth method or where credentials and
 * endpoints come from. A subscription profile may not set them: Updraft sets the ones that matter
 * itself (CODEX_SUBSCRIPTION_ARGS). Prefix match, so `model_providers.x.env_key` is covered.
 */
const PROVIDER_CONFIG_KEYS = ['model_provider', 'model_providers', 'forced_login_method', 'forced_chatgpt_workspace_id',
  'cli_auth_credentials_store', 'chatgpt_base_url', 'openai_base_url', 'profile', 'profiles'];
/** CLI options that pick a config profile or a local/open-source provider. */
const PROVIDER_FLAGS = ['--profile', '--oss', '--local-provider'];

/**
 * Why `args` (the profile's own Codex arguments) cannot run on the subscription, or null.
 * Checked by `updraft validate` and again before every run.
 */
export function codexSubscriptionArgProblem(args: readonly string[]): string | null {
  const key = configKeys(args).find((k) => PROVIDER_CONFIG_KEYS.some((p) => k === p || k.startsWith(`${p}.`)));
  if (key) return `args set "${key}", which chooses the provider or sign-in; native-codex sets these itself`;
  const flag = args.find((a) => PROVIDER_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)) || a === '-p' || (a.startsWith('-p') && !a.startsWith('--')));
  if (flag) return `args set "${flag}", which chooses a config profile or another provider; native-codex runs the default OpenAI provider`;
  return null;
}

/**
 * Appended to every subscription run (`-c` overrides win over the CLI's config.toml): the built-in
 * OpenAI provider, and a ChatGPT-only login. With `forced_login_method = "chatgpt"` the official
 * CLI itself refuses API-key auth (codex-rs/login/src/auth/manager.rs, login restrictions), so a
 * key that appears after the checks still cannot bill an API account. The ChatGPT backend is pinned
 * to the CLI's own default for a ChatGPT login (`DEFAULT_CHATGPT_BASE_URL`, codex-rs/model-provider/
 * src/chatgpt_base_url.rs), so a config.toml cannot send the login elsewhere.
 */
export const CODEX_SUBSCRIPTION_ARGS = ['-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"',
  '-c', 'chatgpt_base_url="https://chatgpt.com/backend-api/"'] as const;

/** Profile `env` names a native-codex profile may not set: the CLI's home is the worker's, not the profile's. */
export function codexSubscriptionEnvProblem(env: Record<string, string> | undefined): string | null {
  const name = Object.keys(env ?? {}).find((n) => n.toUpperCase() === 'CODEX_HOME');
  return name ? `env sets ${name}; native-codex uses the CLI's own home on this worker` : null;
}

/**
 * Models the isolated native worker can run (deploy/aws-microvm/native-worker/policy.mjs keeps the
 * same list). The worker switches Codex's code mode off, and a model whose bundled catalog entry
 * has `tool_mode: code_mode_only` (codex-rs/models-manager/models.json at openai/codex 8727186:
 * gpt-5.6-*, gpt-6*, the daybreak models, codex-auto-review) reaches MCP tools only through code
 * mode, so it would have no usable tool there. gpt-5.5 is the one direct-mode model listed, and the
 * worker's default. Unknown models are refused rather than guessed. Re-check for every pinned Codex.
 * Host-native native-codex keeps the CLI's own tools, so any model works there.
 */
export const CODEX_DIRECT_MODELS: readonly string[] = ['gpt-5.5'];

/** Does this profile run on the isolated native worker (its runtime and image)? */
export function onNativeWorker(agent: { container?: { runtime: string; image: string } | undefined }): boolean {
  const c = agent.container;
  return !!c && (c.runtime.split(/[\\/]/).pop() ?? '') === 'updraft-native-worker' && c.image === 'native-claude-worker';
}

/** Why a Codex model cannot run on the isolated native worker, or null (null model: the worker's default). */
export function isolatedCodexModelProblem(model: string | null): string | null {
  if (model === null || CODEX_DIRECT_MODELS.includes(model)) return null;
  return `model "${model}" is not a direct-mode Codex model: code-mode-only models (gpt-5.6, gpt-6.x, daybreak) reach tools only through code mode, which the isolated native worker switches off, so the run would have no usable tool. Use ${CODEX_DIRECT_MODELS.join(' or ')} (the default)`;
}
