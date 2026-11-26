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
 * key that appears after the checks still cannot bill an API account.
 */
export const CODEX_SUBSCRIPTION_ARGS = ['-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"'] as const;
