import {
  checkNativeCodexAuth,
  defaultNativeCodexAuthRunner,
  hasCodexAuthOverride,
  nativeCodexAuthHint,
  type NativeCodexAuthRunner,
  type NativeCodexAuthStatus,
} from '../agents/native-codex-auth.js';
import { println, type CommandContext } from './context.js';
import { EXIT } from './errors.js';

/**
 * Like the Claude check, Updraft offers no ChatGPT sign-in of its own and never handles tokens:
 * people sign in with the official `codex login --device-auth` on the worker, and this reports
 * only a fixed state and reason.
 */
export async function nativeCodexAuthCommand(
  ctx: CommandContext,
  options: { json?: boolean } = {},
  run: NativeCodexAuthRunner = defaultNativeCodexAuthRunner,
): Promise<number> {
  let status: NativeCodexAuthStatus;
  if (hasCodexAuthOverride(ctx.env)) {
    status = { state: 'wrong_method', reason: 'auth_override_present' };
  } else {
    try {
      const agents = await ctx.discoverAgents({ adapters: ['codex'], env: ctx.env });
      const launch = agents.find((a) => a.adapter === 'codex' && a.installed && a.runnable === 'yes')?.launch;
      status = launch ? await checkNativeCodexAuth(launch, ctx.env, run) : { state: 'unknown', reason: 'cli_missing' };
    } catch {
      // Never show a subprocess error: it can name an account, a path or a URL.
      status = { state: 'unknown', reason: 'status_unavailable' };
    }
  }

  if (options.json) {
    println(ctx.out, JSON.stringify({ provider: 'codex', auth: 'chatgpt_subscription', ...status }));
  } else {
    println(ctx.out, `Codex ChatGPT sign-in: ${status.state} (${status.reason})`);
    println(ctx.out, nativeCodexAuthHint(status.reason));
  }
  return status.state === 'connected' ? EXIT.OK : EXIT.FAILURE;
}
