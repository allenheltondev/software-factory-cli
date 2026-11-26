import { describe, expect, it, vi } from 'vitest';
import { fakeAgentReport, fakeContext, missingAgentReport } from './fakes.js';
import { nativeCodexAuthCommand } from './native-codex-auth.js';

describe('updraft native-auth --codex', () => {
  it('runs the official status command and prints only a fixed state', async () => {
    const ctx = fakeContext({ agents: [fakeAgentReport('codex')] });
    const run = vi.fn(async () => ({ code: 0, output: 'Logged in using ChatGPT\nprivate@example.com /secret/codex-home' }));
    expect(await nativeCodexAuthCommand(ctx, { json: true }, run)).toBe(0);
    expect(run).toHaveBeenCalledWith({ file: '/usr/bin/codex', args: [] }, ctx.env);
    expect(JSON.parse(ctx.out.text)).toEqual({ provider: 'codex', auth: 'chatgpt_subscription', state: 'connected', reason: 'chatgpt_subscription' });
    expect(ctx.out.text).not.toMatch(/private@example.com|secret/);
  });

  it('fails without running the CLI when an API key is in the environment', async () => {
    const ctx = fakeContext({ env: { OPENAI_API_KEY: 'never-print-me' } });
    const run = vi.fn();
    expect(await nativeCodexAuthCommand(ctx, { json: true }, run)).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(ctx.out.text).toContain('auth_override_present');
    expect(ctx.out.text).not.toContain('never-print-me');
  });

  it('reports an API-key login as not a subscription, with the official fix', async () => {
    const ctx = fakeContext({ agents: [fakeAgentReport('codex')] });
    expect(await nativeCodexAuthCommand(ctx, {}, async () => ({ code: 0, output: 'API key configured - sk-***SECRET' }))).toBe(1);
    expect(ctx.out.text).toContain('wrong_method (not_subscription)');
    expect(ctx.out.text).toContain('codex logout');
    expect(ctx.out.text).not.toContain('SECRET');
  });

  it('reports a missing CLI and probe failures without raw output', async () => {
    const missing = fakeContext({ agents: [missingAgentReport('codex')] });
    expect(await nativeCodexAuthCommand(missing, { json: true })).toBe(1);
    expect(JSON.parse(missing.out.text)).toMatchObject({ state: 'unknown', reason: 'cli_missing' });
    const ctx = fakeContext({ agents: [fakeAgentReport('codex')] });
    expect(await nativeCodexAuthCommand(ctx, { json: true }, async () => { throw new Error('refresh token xyz'); })).toBe(1);
    expect(ctx.out.text).toContain('status_unavailable');
    expect(ctx.out.text).not.toContain('refresh token');
  });
});
