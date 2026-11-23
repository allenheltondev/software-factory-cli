import { describe, expect, it } from 'vitest';
import { fakeAgentReport, fakeContext } from './fakes.js';
import { EXIT } from './errors.js';
import { nativeAuthCommand } from './native-auth.js';

describe('native-auth provider selection', () => {
  it('requires an explicit provider without attempting to probe credentials', async () => {
    const ctx = fakeContext({ agents: [fakeAgentReport('claude')] });
    const code = await nativeAuthCommand(ctx, { json: true });
    expect(code).toBe(EXIT.USAGE);
    expect(ctx.err.text).toContain('--claude');
    expect(ctx.out.text).toBe('');
  });

  it('delegates --claude to the native Claude status check', async () => {
    const ctx = fakeContext({ agents: [fakeAgentReport('claude')] });
    // The fake CLI path does not exist, but a failure must still produce sanitized provider JSON.
    const code = await nativeAuthCommand(ctx, { claude: true, json: true });
    expect(code).toBe(EXIT.FAILURE);
    expect(JSON.parse(ctx.out.text)).toMatchObject({
      provider: 'claude',
      auth: 'native_subscription',
      state: 'unknown',
      reason: 'status_unavailable',
    });
    expect(ctx.err.text).toBe('');
  });
});
