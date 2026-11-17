// Sample `claude -p --output-format stream-json --verbose` events for tests.
//
// Every field here is documented; nothing is invented:
// - result: SDKResultMessage, https://code.claude.com/docs/en/agent-sdk/typescript#sdkresultmessage
//   (success: result, is_error, stop_reason, ...; errors: subtype error_max_turns |
//   error_during_execution | error_max_budget_usd | error_max_structured_output_retries, with errors[])
// - system/init: SDKSystemMessage, https://code.claude.com/docs/en/agent-sdk/typescript#sdksystemmessage
// - assistant / user: SDKAssistantMessage / SDKUserMessage (message is an Anthropic API message,
//   https://platform.claude.com/docs/en/api/messages/create)
// - "The last line of the stream is a `result` message", https://code.claude.com/docs/en/headless#stream-responses
// The values are made up.

export const SESSION = '8f2d6c1e-4b7a-4f3e-9a51-2c0d7e6b9f10';

const base = { session_id: SESSION };
const usage = { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 0, cache_read_input_tokens: 800 };

export function init(cwd = '/work/tree'): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    uuid: '0b6c3c5e-0000-4000-8000-000000000001',
    ...base,
    apiKeySource: 'none',
    claude_code_version: '2.1.289',
    cwd,
    tools: ['Bash', 'Edit', 'Read', 'Write'],
    mcp_servers: [],
    model: 'claude-sonnet-4-5',
    permissionMode: 'bypassPermissions',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
  };
}

let n = 0;
export function assistantText(text: string, parentToolUseId: string | null = null): Record<string, unknown> {
  n++;
  return {
    type: 'assistant',
    uuid: `0b6c3c5e-0000-4000-8000-${String(100 + n).padStart(12, '0')}`,
    ...base,
    parent_tool_use_id: parentToolUseId,
    message: {
      id: `msg_${n}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage,
    },
  };
}

export function assistantToolUse(id: string, command: string): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: '0b6c3c5e-0000-4000-8000-000000000200',
    ...base,
    parent_tool_use_id: null,
    message: {
      id: 'msg_tool',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage,
    },
  };
}

export function toolResult(id: string, content: string): Record<string, unknown> {
  return {
    type: 'user',
    ...base,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  };
}

const resultBase = {
  type: 'result',
  uuid: '0b6c3c5e-0000-4000-8000-000000000999',
  ...base,
  duration_ms: 95_000,
  duration_api_ms: 61_000,
  stop_reason: 'end_turn',
  usage,
  modelUsage: {},
};

export function success(result: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...resultBase,
    subtype: 'success',
    is_error: false,
    num_turns: 14,
    result,
    total_cost_usd: 0.4213,
    permission_denials: [],
    terminal_reason: 'completed',
    ...extra,
  };
}

export function errorResult(subtype: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...resultBase,
    subtype,
    is_error: true,
    num_turns: 30,
    stop_reason: null,
    total_cost_usd: 1.25,
    permission_denials: [],
    errors: [],
    ...extra,
  };
}

/** Events as run.log holds them: one JSON object per line. */
export const stream = (...events: Array<Record<string, unknown> | string>): string =>
  `${events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n')}\n`;
