import { nativeClaudeAuthCommand } from './native-claude-auth.js';
import { nativeCodexAuthCommand } from './native-codex-auth.js';
import { println, type CommandContext } from './context.js';
import { EXIT } from './errors.js';

/**
 * Provider-selecting CLI entry point. Provider probes remain separate, so adding another
 * provider's login check does not require introducing another top-level command.
 * Do not interpret an omitted provider as "all": exactly one explicitly requested check runs.
 */
export interface NativeAuthOptions {
  claude?: boolean;
  codex?: boolean;
  json?: boolean;
}

export async function nativeAuthCommand(ctx: CommandContext, opts: NativeAuthOptions = {}): Promise<number> {
  if (!!opts.claude === !!opts.codex) {
    println(ctx.err, 'Select one native auth provider: --claude or --codex');
    return EXIT.USAGE;
  }
  return opts.codex ? nativeCodexAuthCommand(ctx, { json: opts.json }) : nativeClaudeAuthCommand(ctx, { json: opts.json });
}
