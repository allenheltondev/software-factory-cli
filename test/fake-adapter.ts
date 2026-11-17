// Test-only adapter that runs test/fake-agent.mjs. Registered from tests under a real adapter
// name (the config schema only accepts known adapters); production registers none.
import { fileURLToPath } from 'node:url';
import type { AgentAdapter } from '../src/agents/adapters/registry.js';

/** Absolute path of the fake agent CLI script. */
export const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));

export interface FakeAdapterOptions {
  /** Adapter name to register as. Default "claude". */
  name?: string;
  /** Default 'stdin'. */
  promptVia?: 'stdin' | 'file-arg';
  /**
   * Add the fake agent script after the launch target. True (default) when the configured
   * command is node itself; false when it is a shim that already resolves to node + script.
   */
  addScript?: boolean;
  /** Replace the executable (e.g. a path that doesn't exist, to force a spawn error). */
  file?: string;
}

export function fakeAdapter(o: FakeAdapterOptions = {}): AgentAdapter {
  const via = o.promptVia ?? 'stdin';
  return {
    name: o.name ?? 'claude',
    buildInvocation(req) {
      const args = [...req.launch.args, ...(o.addScript === false ? [] : [FAKE_AGENT]), ...req.extraArgs];
      if (via === 'file-arg') args.push('--prompt-file', req.promptFile);
      return { file: o.file ?? req.launch.file, args, promptVia: via, env: { FAKE_ADAPTER_ENV: 'from-adapter' } };
    },
  };
}
