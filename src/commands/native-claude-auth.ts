import { checkNativeClaudeAuth, hasClaudeAuthOverride, defaultNativeAuthRunner, type NativeAuthRunner, type NativeClaudeAuthStatus } from '../agents/native-claude-auth.js';
import { println, type CommandContext } from './context.js';
import { EXIT } from './errors.js';

/**
 * Updraft intentionally does not offer a Claude sign-in form or OAuth-code forwarding.
 * Users run `claude auth login` themselves in the worker's interactive shell.
 */
export async function nativeClaudeAuthCommand(
  ctx: CommandContext,
  options: { json?: boolean } = {},
  run: NativeAuthRunner = defaultNativeAuthRunner,
): Promise<number> {
  let status: NativeClaudeAuthStatus;
  if (hasClaudeAuthOverride(ctx.env)) {
    status = { state: 'wrong_method', reason: 'auth_override_present' };
  } else {
    try {
      const agents = await ctx.discoverAgents({ adapters: ['claude'], env: ctx.env });
      const launch = agents.find((a) => a.adapter === 'claude' && a.installed && a.runnable === 'yes')?.launch;
      status = launch
        ? await checkNativeClaudeAuth(launch, ctx.env, run, ctx.now())
        : { state: 'unknown', reason: 'cli_missing' };
    } catch {
      // Never show a subprocess error: it can contain a sensitive CLI URL, path or account.
      status = { state: 'unknown', reason: 'status_unavailable' };
    }
  }

  if (options.json) {
    println(ctx.out, JSON.stringify({ provider: 'claude', auth: 'native_subscription', ...status }));
  } else {
    const hints: Record<NativeClaudeAuthStatus['reason'], string> = {
      native_subscription: 'Native Claude subscription login is active.',
      sign_in_required: 'Sign in directly on this worker with "claude auth login".',
      login_expired: 'Claude login expired. Run "claude auth login" on this worker again.',
      auth_override_present: 'An API credential, OAuth token override or provider override is set. Remove it before using native subscription login.',
      not_subscription: 'Claude is using a different authentication method. Run "claude auth login" on this worker with subscription sign-in.',
      cli_missing: 'Install the official Claude Code CLI in the worker environment.',
      status_unavailable: 'Cannot verify the official CLI login. Update Claude Code and run "claude auth status" interactively.',
    };
    println(ctx.out, `Claude subscription: ${status.state} (${status.reason})`);
    println(ctx.out, hints[status.reason]);
  }
  return status.state === 'connected' ? EXIT.OK : EXIT.FAILURE;
}
