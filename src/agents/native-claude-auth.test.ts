import { describe, expect, it } from 'vitest';
import { defaultNativeAuthRunner, hasClaudeAuthOverride, nativeClaudeAuthFromStatus, nativeClaudeAuthHint } from './native-claude-auth.js';

const now = Date.parse('2026-11-23T12:00:00Z');
const response = (status: Record<string, unknown>, code = 0) => ({ code, stdout: JSON.stringify(status) });
const signedIn = { loggedIn: true, authMethod: 'claude.ai', loginExpiresAt: '2026-12-31T00:00:00Z' };

describe('native Claude subscription status, without inspecting credentials', () => {
  it('accepts an official native subscription login and an isolated CLI config directory', () => {
    expect(nativeClaudeAuthFromStatus(response(signedIn), { CLAUDE_CONFIG_DIR: '/private/claude-profile' }, now))
      .toEqual({ state: 'connected', reason: 'native_subscription' });
  });

  it('requires a login when the official CLI reports signed out', () => {
    expect(nativeClaudeAuthFromStatus(response({ loggedIn: false, authMethod: 'none' }, 1), {}, now))
      .toEqual({ state: 'login_required', reason: 'sign_in_required' });
  });

  it('requires a fresh login if the expiry has passed', () => {
    expect(nativeClaudeAuthFromStatus(response({ ...signedIn, loginExpiresAt: '2026-11-23T11:59:59Z' }), {}, now))
      .toEqual({ state: 'expired', reason: 'login_expired' });
  });

  it.each(['api_key', 'oauth_token', 'third_party', 'none', 'api_key_helper'])('rejects %s as subscription auth', (method) => {
    expect(nativeClaudeAuthFromStatus(response({ loggedIn: true, authMethod: method }), {}, now))
      .toEqual({ state: 'wrong_method', reason: 'not_subscription' });
  });

  it.each(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_PROFILE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'])(
    'blocks %s from overriding subscription credentials', (name) => {
      expect(hasClaudeAuthOverride({ [name]: 'SECRET_DO_NOT_LOG' })).toBe(true);
      expect(nativeClaudeAuthFromStatus(response(signedIn), { [name]: 'SECRET_DO_NOT_LOG' }, now))
        .toEqual({ state: 'wrong_method', reason: 'auth_override_present' });
    },
  );

  it('rejects conflicting API-key source even when CLI claims a native session', () => {
    expect(nativeClaudeAuthFromStatus(response({ ...signedIn, apiKeySource: 'apiKeyHelper' }), {}, now))
      .toEqual({ state: 'wrong_method', reason: 'not_subscription' });
  });

  it('has specific hints for auth, expiry and unavailable probes', () => {
    expect(nativeClaudeAuthHint('sign_in_required')).toContain('claude auth login');
    expect(nativeClaudeAuthHint('auth_override_present')).toContain('Remove it');
    expect(nativeClaudeAuthHint('status_unavailable')).toContain('claude auth status');
    expect(nativeClaudeAuthHint('status_unavailable')).not.toContain('Sign in directly');
  });

  it('uses a resolved executable and launch prefix without a shell, including Windows-compatible Node shims', async () => {
    const run = await defaultNativeAuthRunner(
      { file: process.execPath, args: ['-e', 'process.stdout.write(process.argv.slice(1).join(","))'] },
      { PATH: process.env.PATH },
    );
    expect(run).toEqual({ code: 0, stdout: 'auth,status' });
  });

  it('fails closed on unavailable, inconsistent or malformed status', () => {
    for (const sample of [
      { code: null, stdout: '' },
      { code: 0, stdout: 'some sensitive error text' },
      response({ loggedIn: true, authMethod: 'claude.ai' }, 1),
      response({ loggedIn: false }, 0),
      response({ ...signedIn, loginExpiresAt: 'garbled' }),
      response({ ...signedIn, loginExpiresAt: 123 }),
    ]) {
      expect(nativeClaudeAuthFromStatus(sample, {}, now)).toEqual({ state: 'unknown', reason: 'status_unavailable' });
    }
  });

  it('does not return any arbitrary account info, config path or secret', () => {
    const input = response({ ...signedIn, email: 'user@example.com', configDirectory: '/secret/home', oauthToken: 'SUPER_SECRET' });
    const output = JSON.stringify(nativeClaudeAuthFromStatus(input, {}, now));
    expect(output).toBe('{"state":"connected","reason":"native_subscription"}');
    expect(output).not.toMatch(/email|home|token|SUPER_SECRET/);
  });
});
