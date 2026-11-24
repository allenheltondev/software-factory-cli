import { describe, expect, it } from 'vitest';
import { claudeLoginFrame } from './claudeLoginFrame';
const grant = { url: 'wss://worker.on.aws/claude-login', token: 'sample', port: 8081 };
describe('isolated Claude sign-in document', () => {
  it.each([
    { url: 'https://worker.on.aws/claude-login' },
    { url: 'wss://worker.on.aws.evil.test/claude-login' },
    { url: 'wss://worker.on.aws/claude-login?token=sample' },
    { url: 'wss://worker.on.aws:8081/claude-login' },
    { url: 'wss://worker.on.aws/lifecycle' },
    { port: 8082 },
    { token: '</script><script>alert(1)</script>' },
  ])('rejects an untrusted worker grant %j', (override) => {
    expect(() => claudeLoginFrame({ ...grant, ...override })).toThrow();
  });
  it('keeps code delivery inside the frame, uses a restricted provider destination and static theme tokens', () => {
    const html = claudeLoginFrame(grant);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('connect-src wss://worker.on.aws');
    expect(html).toContain("authorize.origin !== 'https://claude.ai'");
    expect(html).toContain("authorize.pathname !== '/oauth/authorize'");
    expect(html).toContain('socket.send(input.value.trim())');
    expect(html).not.toMatch(/postMessage\([^;]*input\.value/);
    expect(html).not.toContain('localStorage');
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).toContain('aria-describedby="code-help"');
  });
});
