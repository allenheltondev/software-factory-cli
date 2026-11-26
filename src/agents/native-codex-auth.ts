import { execFile } from 'node:child_process';
import type { LaunchSpec } from './discovery.js';

/**
 * Read-only native Codex subscription ("Sign in with ChatGPT") probe for subscription workers
 * (docs/codex-subscription.md).
 *
 * It runs only the official CLI's `codex login status` and classifies the CLI's fixed status
 * sentence. It never reads `auth.json` or the OS keyring, and never returns stdout, stderr,
 * account identity, paths or environment values. The status sentences are those of
 * codex-rs/cli/src/login.rs `run_login_status` (openai/codex): it prints one line to stderr and
 * exits 0 when signed in ("Logged in using ChatGPT", "API key configured - …", "Logged in using
 * access token", …) and exits 1 with "Not logged in" when it holds no credential. Only ChatGPT
 * sign-in counts; everything else, and anything unexpected, is not subscription auth.
 *
 * The CLI reports no expiry: the ChatGPT login refreshes itself, and a lapsed or revoked login
 * shows up as a failed run, not here. So unlike Claude there is no `expired` state.
 *
 * Keep this module free of local imports: the native worker loads the built file on its own,
 * as it does native-claude-auth.js.
 */
export type NativeCodexAuthState = 'connected' | 'login_required' | 'wrong_method' | 'unknown';

export type NativeCodexAuthReason =
  | 'chatgpt_subscription'
  | 'sign_in_required'
  | 'auth_override_present'
  | 'not_subscription'
  | 'cli_missing'
  | 'status_unavailable';

export interface NativeCodexAuthStatus {
  state: NativeCodexAuthState;
  reason: NativeCodexAuthReason;
}

/** What the probe saw: the exit code and the CLI's status text (stdout and stderr together). */
export interface NativeCodexStatusResponse {
  code: number | null;
  output: string;
}

/**
 * Environment variables the official CLI reads that select an API key, an injected token, another
 * endpoint or workload identity instead of the CLI-owned ChatGPT login (codex-rs/login/src/auth:
 * OPENAI_API_KEY, CODEX_API_KEY, CODEX_ACCESS_TOKEN, the OPENAI_* workload identity markers and
 * the auth endpoint overrides). Any OPENAI_* name counts, so a new provider variable fails closed.
 * Also every extra TLS trust root (CODEX_CA_CERTIFICATE, SSL_CERT_FILE/DIR, NODE_EXTRA_CA_CERTS,
 * REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE): with only the system roots trusted, a proxy in
 * HTTPS_PROXY/ALL_PROXY sees the host it tunnels to and never the login or its traffic, so proxies
 * stay allowed (hosts often need one) while an interception CA is always refused.
 * Names only: values are never copied. The worker's own CODEX_HOME is allowed; the CLI manages
 * its contents (a profile's `env` may not set it, see validate.ts).
 */
const CODEX_OVERRIDES = [
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'CODEX_AUTHAPI_BASE_URL',
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
  'CODEX_REVOKE_TOKEN_URL_OVERRIDE',
  'CODEX_APP_SERVER_LOGIN_CLIENT_ID',
  'CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL',
  'CODEX_AGENT_IDENTITY_JWKS_BASE_URL',
  'CODEX_CA_CERTIFICATE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const;

export function hasCodexAuthOverride(env: NodeJS.ProcessEnv): boolean {
  return Object.entries(env).some(([name, value]) =>
    typeof value === 'string' && value !== '' && (name.toUpperCase().startsWith('OPENAI_') || (CODEX_OVERRIDES as readonly string[]).includes(name.toUpperCase())));
}

/** Classify `codex login status`. Inconsistent exit codes and unknown text are `unknown`. */
export function nativeCodexAuthFromStatus(response: NativeCodexStatusResponse, env: NodeJS.ProcessEnv = {}): NativeCodexAuthStatus {
  if (hasCodexAuthOverride(env)) return { state: 'wrong_method', reason: 'auth_override_present' };
  if (response.code === null || response.output.length > 65536) return { state: 'unknown', reason: 'status_unavailable' };
  // Newer CLIs may print a banner or warning before the status; only one known sentence decides.
  const lines = response.output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const said = (re: RegExp) => lines.some((l) => re.test(l));
  if (response.code === 1 && said(/^Not logged in$/)) return { state: 'login_required', reason: 'sign_in_required' };
  if (response.code !== 0) return { state: 'unknown', reason: 'status_unavailable' };
  const chatgpt = said(/^Logged in using ChatGPT$/);
  const other = said(/^API key configured\b/) || said(/^Logged in using (?!ChatGPT$)/);
  if (chatgpt && !other) return { state: 'connected', reason: 'chatgpt_subscription' };
  if (other) return { state: 'wrong_method', reason: 'not_subscription' };
  return { state: 'unknown', reason: 'status_unavailable' };
}

export type NativeCodexAuthRunner = (launch: LaunchSpec, env: NodeJS.ProcessEnv, cwd?: string) => Promise<NativeCodexStatusResponse>;

/** The official read-only status command. Its output is classified, never returned or logged. */
export const defaultNativeCodexAuthRunner: NativeCodexAuthRunner = (launch, env, cwd) =>
  new Promise((resolve) => {
    execFile(
      launch.file,
      [...launch.args, 'login', 'status'],
      { env, ...(cwd ? { cwd } : {}), encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 65_536 },
      (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, output: `${stdout}\n${stderr}` });
      },
    );
  });

/** Fail closed on every probe error. */
export async function checkNativeCodexAuth(
  launch: LaunchSpec,
  env: NodeJS.ProcessEnv,
  run: NativeCodexAuthRunner = defaultNativeCodexAuthRunner,
  cwd?: string,
): Promise<NativeCodexAuthStatus> {
  if (hasCodexAuthOverride(env)) return { state: 'wrong_method', reason: 'auth_override_present' };
  try {
    return nativeCodexAuthFromStatus(await (cwd ? run(launch, env, cwd) : run(launch, env)), env);
  } catch {
    return { state: 'unknown', reason: 'status_unavailable' };
  }
}

/** Human-facing guidance for the CLI and failed jobs. Never interpolates CLI output. */
export function nativeCodexAuthHint(reason: NativeCodexAuthReason): string {
  const hints: Record<NativeCodexAuthReason, string> = {
    chatgpt_subscription: 'Codex is signed in with ChatGPT.',
    sign_in_required: 'Sign in on this worker with "codex login --device-auth" (or "codex login" where a browser can reach it).',
    auth_override_present: 'An OpenAI API key, access token, endpoint or workload identity variable is set. Remove it before using ChatGPT sign-in.',
    not_subscription: 'Codex is signed in with an API key or another method, not ChatGPT. Run "codex logout", then "codex login --device-auth".',
    cli_missing: 'Install the official Codex CLI in the worker environment.',
    status_unavailable: 'Cannot verify the Codex login. Update the Codex CLI and run "codex login status" interactively.',
  };
  return hints[reason];
}
