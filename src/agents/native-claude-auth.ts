/**
 * Read-only native Claude Code subscription authentication probe for dedicated persistent workers.
 *
 * This module never reads CLI credential files and never returns stdout, stderr, account identity,
 * configuration paths, or environment values. It is safe to render its fixed vocabulary to a
 * worker status UI. A "connected" result is a readiness hint, not evidence that a sandbox
 * isolates Claude's credentials from tools spawned by the CLI.
 */
export type NativeClaudeAuthState = 'connected' | 'login_required' | 'expired' | 'wrong_method' | 'unknown';

export type NativeClaudeAuthReason =
  | 'native_subscription'
  | 'sign_in_required'
  | 'login_expired'
  | 'auth_override_present'
  | 'not_subscription'
  | 'cli_missing'
  | 'status_unavailable';

export interface NativeClaudeAuthStatus {
  state: NativeClaudeAuthState;
  reason: NativeClaudeAuthReason;
}

export interface NativeClaudeStatusResponse {
  code: number | null;
  stdout: string;
}

/**
 * Any of these selects a provider, API credential or injected OAuth token instead of the
 * CLI-managed subscription. We check names only, and never copy their values.
 * CLAUDE_CONFIG_DIR is intentionally allowed: the CLI manages its contents itself.
 */
const SUBSCRIPTION_OVERRIDES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_PROFILE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

export function hasClaudeAuthOverride(env: NodeJS.ProcessEnv): boolean {
  return SUBSCRIPTION_OVERRIDES.some((name) => typeof env[name] === 'string' && env[name] !== '');
}

/**
 * Classify the official `claude auth status` JSON. A nonstandard/old CLI, inconsistent
 * exit status or malformed expiry is unknown rather than optimistically connected.
 */
export function nativeClaudeAuthFromStatus(
  response: NativeClaudeStatusResponse,
  env: NodeJS.ProcessEnv = {},
  nowMs = Date.now(),
): NativeClaudeAuthStatus {
  if (hasClaudeAuthOverride(env)) return { state: 'wrong_method', reason: 'auth_override_present' };
  if (response.code === null || response.stdout.length > 65536) return { state: 'unknown', reason: 'status_unavailable' };

  let data: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(response.stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'unknown', reason: 'status_unavailable' };
    data = value as Record<string, unknown>;
  } catch {
    return { state: 'unknown', reason: 'status_unavailable' };
  }

  if (data.loggedIn === false && response.code === 1) return { state: 'login_required', reason: 'sign_in_required' };
  if (data.loggedIn !== true || response.code !== 0) return { state: 'unknown', reason: 'status_unavailable' };
  if (data.authMethod !== 'claude.ai') return { state: 'wrong_method', reason: 'not_subscription' };

  const expiry = data.loginExpiresAt;
  if (expiry !== undefined && expiry !== null) {
    if (typeof expiry !== 'string') return { state: 'unknown', reason: 'status_unavailable' };
    const end = Date.parse(expiry);
    if (!Number.isFinite(end)) return { state: 'unknown', reason: 'status_unavailable' };
    if (end <= nowMs) return { state: 'expired', reason: 'login_expired' };
  }
  return { state: 'connected', reason: 'native_subscription' };
}
