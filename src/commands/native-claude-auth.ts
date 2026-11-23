import { checkNativeClaudeAuth, hasClaudeAuthOverride, nativeClaudeAuthHint, defaultNativeAuthRunner, type NativeAuthRunner, type NativeClaudeAuthStatus } from '../agents/native-claude-auth.js';
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
    println(ctx.out, `Claude subscription: ${status.state} (${status.reason})`);
    println(ctx.out, nativeClaudeAuthHint(status.reason));
  }
  return status.state === 'connected' ? EXIT.OK : EXIT.FAILURE;
}
