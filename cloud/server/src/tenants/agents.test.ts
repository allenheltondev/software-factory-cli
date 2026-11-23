import { describe, expect, it } from 'vitest';
import { agentsFrom } from './agents.js';

describe('the agents a deployment offers', () => {
  it("are CLOUD_AGENTS's, known ones only, else Claude and Codex", () => {
    expect(agentsFrom(undefined)).toEqual(['claude', 'codex']);
    expect(agentsFrom('')).toEqual(['claude', 'codex']);
    expect(agentsFrom('claude, Kiro ,kiro')).toEqual(['claude', 'kiro']);
    expect(agentsFrom('gemini')).toEqual(['claude', 'codex']);
  });
});
