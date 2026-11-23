import { execFile } from 'node:child_process';
import type { LaunchSpec } from './discovery.js';

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
  // The official CLI also reports apiKeySource for provider/API-key sign-in. An explicit
  // key source alongside claude.ai is ambiguous, so fail closed rather than assume billing.
  if (data.authMethod !== 'claude.ai' || (typeof data.apiKeySource === 'string' && data.apiKeySource !== '')) {
    return { state: 'wrong_method', reason: 'not_subscription' };
  }

  const expiry = data.loginExpiresAt;
  if (expiry !== undefined && expiry !== null) {
    if (typeof expiry !== 'string') return { state: 'unknown', reason: 'status_unavailable' };
    const end = Date.parse(expiry);
    if (!Number.isFinite(end)) return { state: 'unknown', reason: 'status_unavailable' };
    if (end <= nowMs) return { state: 'expired', reason: 'login_expired' };
  }
  return { state: 'connected', reason: 'native_subscription' };
}

/** Official CLI read-only status probe; nothing from stderr is returned.
 * The final pre-launch probe uses the same working directory as the agent, so project
 * settings that affect authentication are considered by the official CLI.
 */
export type NativeAuthRunner = (launch: LaunchSpec, env: NodeJS.ProcessEnv, cwd?: string) => Promise<NativeClaudeStatusResponse>;

export const defaultNativeAuthRunner: NativeAuthRunner = (launch, env, cwd) =>
  new Promise((resolve) => {
    execFile(
      launch.file,
      [...launch.args, 'auth', 'status'],
      { env, ...(cwd ? { cwd } : {}), encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 65_536 },
      (error, stdout) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout });
      },
    );
  });

/** Fail closed on all probe errors, including malformed outputs. */
export async function checkNativeClaudeAuth(
  launch: LaunchSpec,
  env: NodeJS.ProcessEnv,
  run: NativeAuthRunner = defaultNativeAuthRunner,
  nowMs = Date.now(),
  cwd?: string,
): Promise<NativeClaudeAuthStatus> {
  if (hasClaudeAuthOverride(env)) return { state: 'wrong_method', reason: 'auth_override_present' };
  try {
    return nativeClaudeAuthFromStatus(await (cwd ? run(launch, env, cwd) : run(launch, env)), env, nowMs);
  } catch {
    return { state: 'unknown', reason: 'status_unavailable' };
  }
}

/** Human-facing guidance shared by the CLI and failed worker jobs. Never interpolate raw CLI output. */
export function nativeClaudeAuthHint(reason: NativeClaudeAuthReason): string {
  const hints: Record<NativeClaudeAuthReason, string> = {
    native_subscription: 'Native Claude subscription login is active.',
    sign_in_required: 'Sign in directly on this worker with "claude auth login".',
    login_expired: 'Claude login expired. Run "claude auth login" on this worker again.',
    auth_override_present: 'An API credential, OAuth token override or provider override is set. Remove it before using native subscription login.',
    not_subscription: 'Claude authentication is not verifiably subscription-only. Remove conflicting API keys, apiKeyHelper or provider settings, then check "claude auth status" from the job worktree. Sign in with "claude auth login" if needed.',
    cli_missing: 'Install the official Claude Code CLI in the worker environment.',
    status_unavailable: 'Cannot verify the official CLI login. Update Claude Code and run "claude auth status" interactively.',
  };
  return hints[reason];
}
