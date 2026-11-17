/**
 * Adapters that can run agents in live mode, keyed by adapter name.
 *
 * `execution.mode: live` validates only when every enabled agent's adapter is listed here.
 * Claude Code (#9) ships; Codex (#10) and Kiro (#11) each add a module under this directory and
 * list it in BUILT_IN_ADAPTERS. Tests register a fake with registerAdapter.
 */
import type { AgentAdapter } from './adapter.js';
import { claudeAdapter } from './claude.js';

export type { AgentAdapter, AgentExit, AgentInvocation, AgentVerdict, InvocationRequest } from './adapter.js';
export { defaultVerdict, LAST_LINE_BYTES, RAW_OUTPUT_BYTES } from './adapter.js';

const BUILT_IN_ADAPTERS: readonly AgentAdapter[] = [claudeAdapter];

const registry = new Map<string, AgentAdapter>(BUILT_IN_ADAPTERS.map((a) => [a.name, a]));

/** The live implementation for an adapter name, or null when there is none. */
export function getAdapter(name: string): AgentAdapter | null {
  return registry.get(name) ?? null;
}

export function implementedAdapters(): string[] {
  return [...registry.keys()].sort();
}

/**
 * Register (or replace) an adapter. Returns a function that restores the previous registration,
 * so a test can install a fake and put things back afterwards.
 */
export function registerAdapter(adapter: AgentAdapter): () => void {
  const previous = registry.get(adapter.name);
  registry.set(adapter.name, adapter);
  return () => {
    if (registry.get(adapter.name) !== adapter) return;
    if (previous) registry.set(adapter.name, previous);
    else registry.delete(adapter.name);
  };
}
