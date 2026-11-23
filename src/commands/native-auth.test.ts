import { describe, expect, it } from 'vitest';
import { fakeContext, missingAgentReport } from './fakes.js';
import { EXIT } from './errors.js';
import { nativeAuthCommand } from './native-auth.js';

describe('native-auth provider selection', () => {
  it('requires an explicit provider without attempting to probe credentials', async () => {
    const ctx = fakeContext({ agents: [missingAgentReport('claude')] });
    const code = await nativeAuthCommand(ctx, { json: true });
    expect(code).toBe(EXIT.USAGE);
    expect(ctx.err.text).toContain('--claude');
    expect(ctx.out.text).toBe('');
  });

  it('delegates --claude to the native Claude status check', async () => {
    const ctx = fakeContext({ agents: [missingAgentReport('claude')] });
    // No subprocess is needed: a known missing CLI produces a sanitized provider result.
    const code = await nativeAuthCommand(ctx, { claude: true, json: true });
    expect(code).toBe(EXIT.FAILURE);
    expect(JSON.parse(ctx.out.text)).toMatchObject({
      provider: 'claude',
      auth: 'native_subscription',
      state: 'unknown',
      reason: 'cli_missing',
    });
    expect(ctx.err.text).toBe('');
  });
});
