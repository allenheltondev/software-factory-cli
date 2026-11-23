import { nativeClaudeAuthCommand } from './native-claude-auth.js';
import { println, type CommandContext } from './context.js';
import { EXIT } from './errors.js';

/**
 * Provider-selecting CLI entry point. Provider probes remain separate, so adding native
 * Codex or Kiro login checks does not require introducing another top-level command.
 * Do not interpret an omitted provider as "all": only explicitly requested checks run.
 */
export interface NativeAuthOptions {
  claude?: boolean;
  json?: boolean;
}

export async function nativeAuthCommand(ctx: CommandContext, opts: NativeAuthOptions = {}): Promise<number> {
  if (!opts.claude) {
    println(ctx.err, 'Select one native auth provider: --claude');
    return EXIT.USAGE;
  }
  return nativeClaudeAuthCommand(ctx, { json: opts.json });
}
