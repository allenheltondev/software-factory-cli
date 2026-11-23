import { describe, expect, it } from 'vitest';
import { agentKeyVariables, agentsFrom, alternativeTo, keyOrAlternatives, keysMet, keysToHand, keysUsedFor } from './agents.js';

describe('the agents a deployment offers', () => {
  it("are CLOUD_AGENTS's, known ones only, else Claude and Codex", () => {
    expect(agentsFrom(undefined)).toEqual(['claude', 'codex']);
    expect(agentsFrom('')).toEqual(['claude', 'codex']);
    expect(agentsFrom('claude, Kiro ,kiro')).toEqual(['claude', 'kiro']);
    expect(agentsFrom('gemini')).toEqual(['claude', 'codex']);
  });
});

describe('a Claude subscription token in place of the API key', () => {
  it("is one of Claude's key variables, and stands in for ANTHROPIC_API_KEY", () => {
    expect(agentKeyVariables('claude')).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
    expect(agentKeyVariables('codex')).toEqual(['CODEX_API_KEY']);
    expect(alternativeTo('CLAUDE_CODE_OAUTH_TOKEN')).toBe('ANTHROPIC_API_KEY');
    expect(alternativeTo('ANTHROPIC_API_KEY')).toBeUndefined();
    expect(keyOrAlternatives('claude')).toBe('ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN');
    expect(keyOrAlternatives('kiro')).toBe('KIRO_API_KEY');
  });

  it('meets the need for Claude\'s API key', () => {
    expect([...keysMet(['CLAUDE_CODE_OAUTH_TOKEN'])].sort()).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
    expect([...keysMet(['CODEX_API_KEY'])]).toEqual(['CODEX_API_KEY']);
  });

  it('is handed to a job instead of the API key when both are set: the subscription before API credits', () => {
    expect(keysToHand(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY'])).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY']);
    expect(keysToHand(['ANTHROPIC_API_KEY'])).toEqual(['ANTHROPIC_API_KEY']);
  });

  it("is the key a need was met with when it was handed", () => {
    expect(keysUsedFor(['ANTHROPIC_API_KEY', 'CODEX_API_KEY'], ['CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY'])).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY']);
    expect(keysUsedFor(['ANTHROPIC_API_KEY'], ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'])).toEqual(['ANTHROPIC_API_KEY']);
    expect(keysUsedFor(['ANTHROPIC_API_KEY'], ['CODEX_API_KEY'])).toEqual([]);
  });
});
