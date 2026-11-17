// Sample `codex exec --json` events for tests.
//
// Every field here is documented; nothing is invented:
// - ThreadEvent / ThreadItem in https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts
//   and .../items.ts ("based on event types from codex-rs/exec/src/exec_events.rs")
// - the sample stream in https://developers.openai.com/codex/noninteractive
//   (-> https://learn.chatgpt.com/docs/non-interactive-mode), "Make output machine-readable"
// The values are made up.

export const THREAD = '0199a213-81c0-7800-8aa1-bbab2a035a53';

export const threadStarted = (thread_id = THREAD): Record<string, unknown> => ({ type: 'thread.started', thread_id });

export const turnStarted = (): Record<string, unknown> => ({ type: 'turn.started' });

export function command(id: string, cmd: string, output: string, exit_code = 0): Record<string, unknown> {
  return {
    type: 'item.completed',
    item: { id, type: 'command_execution', command: cmd, aggregated_output: output, exit_code, status: exit_code === 0 ? 'completed' : 'failed' },
  };
}

export const reasoning = (id: string, text: string): Record<string, unknown> => ({ type: 'item.completed', item: { id, type: 'reasoning', text } });

export const fileChange = (id: string, path: string): Record<string, unknown> => ({
  type: 'item.completed',
  item: { id, type: 'file_change', changes: [{ path, kind: 'add' }], status: 'completed' },
});

export const agentMessage = (id: string, text: string): Record<string, unknown> => ({ type: 'item.completed', item: { id, type: 'agent_message', text } });

export function turnCompleted(usage: Record<string, number> = {}): Record<string, unknown> {
  return {
    type: 'turn.completed',
    usage: { input_tokens: 24763, cached_input_tokens: 24448, cache_write_input_tokens: 0, output_tokens: 122, reasoning_output_tokens: 0, ...usage },
  };
}

export const turnFailed = (message: string): Record<string, unknown> => ({ type: 'turn.failed', error: { message } });

export const errorEvent = (message: string): Record<string, unknown> => ({ type: 'error', message });

/** Events as run.log holds them: one JSON object per line. */
export const stream = (...events: Array<Record<string, unknown> | string>): string =>
  `${events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n')}\n`;
