import { describe, expect, it, vi } from 'vitest';
import { fakeAgentReport, fakeContext, missingAgentReport } from './fakes.js';
import { nativeClaudeAuthCommand } from './native-claude-auth.js';

describe('updraft native-claude-auth', () => {
  it('uses the official CLI and emits only a fixed, sanitized JSON state', async () => {
    const ctx = fakeContext({ agents: [fakeAgentReport('claude')] });
    const run = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({
        loggedIn: true, authMethod: 'claude.ai',
        email: 'private@example.com', configDirectory: '/secret/profile',
      }),
    }));
    const exit = await nativeClaudeAuthCommand(ctx, { json: true }, run);
    expect(exit).toBe(0);
    expect(run).toHaveBeenCalledWith({ file: '/usr/bin/claude', args: [] }, ctx.env);
    expect(JSON.parse(ctx.out.text)).toEqual({ provider: 'claude', auth: 'native_subscription', state: 'connected', reason: 'native_subscription' });
    expect(ctx.out.text).not.toContain('private@example.com');
    expect(ctx.out.text).not.toContain('/secret/profile');
  });

  it('fails closed without running a credentialed CLI when environment credentials are injected', async () => {
    const ctx = fakeContext({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'never-print-me' } });
    const run = vi.fn();
    expect(await nativeClaudeAuthCommand(ctx, { json: true }, run)).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(ctx.out.text).toContain('auth_override_present');
    expect(ctx.out.text).not.toContain('never-print-me');
  });

  it('reports missing Claude and CLI failures without printing raw subprocess output', async () => {
    const missing = fakeContext({ agents: [missingAgentReport('claude')] });
    expect(await nativeClaudeAuthCommand(missing, { json: true })).toBe(1);
    expect(JSON.parse(missing.out.text)).toMatchObject({ state: 'unknown', reason: 'cli_missing' });

    const ctx = fakeContext({ agents: [fakeAgentReport('claude')] });
    expect(await nativeClaudeAuthCommand(ctx, { json: true }, async () => { throw new Error('private access token'); })).toBe(1);
    expect(ctx.out.text).toContain('status_unavailable');
    expect(ctx.out.text).not.toContain('private access token');
  });
});
