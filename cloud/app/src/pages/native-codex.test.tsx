import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { fakeApi } from '../test/fakeApi';
import type { NativeClaudeView } from '../api/client';
import { NativeClaudePage, NativeCodexPage } from './NativeClaudePage';
import { codexLoginFrame } from './codexLoginFrame';
import { reasonLabel } from '../components/workflows';

// Connect ChatGPT (#125): Codex on the owner's ChatGPT plan, beside Claude's subscription page.
const trigger = { repositoryId: 9, repository: 'acme/web', label: 'updraft' };
const signedOut: NativeClaudeView = {
  configured: true, enabled: false, owner: true, managed: true, browserLogin: true, triggers: [], availableTriggers: [trigger], worker: null,
};
const grant = { url: 'wss://worker.on.aws/codex-login', token: 'sample', port: 8081, generation: 'one' };

function show(api: ReturnType<typeof fakeApi>, path = '/installations/55/codex') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/installations/:id/codex" element={<NativeCodexPage api={api} />} />
        <Route path="/installations/:id/claude" element={<NativeClaudePage api={api} />} />
      </Routes>
    </MemoryRouter>,
  );
}
const focus = () => act(async () => { window.dispatchEvent(new Event('focus')); });

describe('Connect ChatGPT', () => {
  it('connects through the Codex API only and opens the private device-code frame', async () => {
    const user = userEvent.setup();
    let current: NativeClaudeView = signedOut;
    const nativeCodexStart = vi.fn(async () => {
      current = { ...current, worker: { status: 'auth-required', online: true, busy: false, lastHeartbeatAt: '2026-11-26T10:00:00Z', workerVersion: 'tenant-browser-1', generation: 'one' } };
      return current;
    });
    const nativeCodexLogin = vi.fn().mockResolvedValue(grant);
    const api = fakeApi({ nativeCodex: async () => current, nativeCodexStart, nativeCodexLogin });
    show(api);
    expect(await screen.findByRole('heading', { name: 'ChatGPT account' })).toBeInTheDocument();
    expect(screen.getByText('Connection required')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect ChatGPT' }));
    await focus();
    const frame = await screen.findByTitle('Private ChatGPT sign-in');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
    const doc = frame.getAttribute('srcdoc') ?? '';
    expect(doc).toContain('connect-src wss://worker.on.aws');
    expect(doc).not.toContain('socket.send');
    expect(nativeCodexStart).toHaveBeenCalledExactlyOnceWith(55);
    expect(nativeCodexLogin).toHaveBeenCalledExactlyOnceWith(55, expect.any(AbortSignal));
    // Claude's calls are never used by the Codex page.
    expect(api.nativeClaude).not.toHaveBeenCalled();
    expect(api.nativeClaudeStart).not.toHaveBeenCalled();
    expect(api.nativeClaudeLogin).not.toHaveBeenCalled();
    // The frame reports only a status, under its own kind; Claude's kind is ignored here.
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: (frame as HTMLIFrameElement).contentWindow!, origin: 'null',
      data: { kind: 'updraft-claude-login', result: 'connected' } })));
    expect(screen.queryByText(/Verifying your connection with your environment/)).not.toBeInTheDocument();
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: (frame as HTMLIFrameElement).contentWindow!, origin: 'null',
      data: { kind: 'updraft-codex-login', result: 'connected' } })));
    expect(screen.getByText(/Verifying your connection with your environment/)).toBeInTheDocument();
  });

  it('shows the sanitized connection and Codex routing choices once connected', async () => {
    const connected: NativeClaudeView = { ...signedOut, triggers: [trigger],
      worker: { status: 'connected', online: true, busy: false, lastHeartbeatAt: '2026-11-26T10:00:00Z', workerVersion: 'tenant-browser-1', generation: 'one' } };
    show(fakeApi({ nativeCodex: async () => connected }));
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('ChatGPT plan')).toBeInTheDocument();
    expect(screen.getByText('OpenAI API key')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Claude account →' })).toHaveAttribute('href', '/installations/55/claude');
  });

  it('puts a Connect ChatGPT card on the Claude page only where the worker image can run Codex', async () => {
    const { unmount } = show(fakeApi({ nativeClaude: async () => ({ ...signedOut, codexAvailable: true }) }), '/installations/55/claude');
    expect(await screen.findByText('Connect ChatGPT')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ChatGPT account →' })).toHaveAttribute('href', '/installations/55/codex');
    unmount();
    for (const codexAvailable of [false, undefined]) {
      const view = show(fakeApi({ nativeClaude: async () => ({ ...signedOut, ...(codexAvailable === undefined ? {} : { codexAvailable }) }) }), '/installations/55/claude');
      expect(await screen.findByRole('heading', { name: 'Claude account' })).toBeInTheDocument();
      expect(screen.queryByText('Connect ChatGPT')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'ChatGPT account →' })).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('offers nothing to connect while the deployment\'s image cannot run Codex', async () => {
    const nativeCodexStart = vi.fn();
    show(fakeApi({ nativeCodex: async () => ({ provider: 'codex', available: false, configured: false, enabled: false, managed: true, owner: true, worker: null }), nativeCodexStart }));
    expect(await screen.findByText(/not available on this deployment's worker image yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect ChatGPT' })).not.toBeInTheDocument();
    expect(nativeCodexStart).not.toHaveBeenCalled();
  });
});

describe('isolated ChatGPT device-code document', () => {
  it.each([
    { url: 'wss://worker.on.aws/claude-login' },
    { url: 'https://worker.on.aws/codex-login' },
    { url: 'wss://worker.on.aws.evil.test/codex-login' },
    { url: 'wss://worker.on.aws/codex-login?x=1' },
    { port: 8082 },
    { token: '</script><script>alert(1)</script>' },
  ])('rejects an untrusted worker grant %j', (override) => {
    expect(() => codexLoginFrame({ ...grant, ...override })).toThrow();
  });
  it('shows only the official verification page and the code, and sends nothing back', () => {
    const html = codexLoginFrame(grant);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("page.href !== 'https://auth.openai.com/codex/device'");
    expect(html).not.toContain('socket.send');
    expect(html).not.toMatch(/<input/);
    expect(html).not.toMatch(/postMessage\([^;]*userCode/);
    expect(html).not.toContain('localStorage');
    expect(html).toContain("kind: 'updraft-codex-login'");
  });
});

describe('Codex wait codes on the timeline', () => {
  it('words codex_* codes as Codex, Claude\'s unchanged', () => {
    expect(reasonLabel('codex_session_idle')).toBe('The Codex session ended because it was idle for its whole idle limit; a new one needs a sign-in');
    expect(reasonLabel('codex_session_disabled')).toBe('The Codex session ended because an operator paused Codex connections; a new one needs a sign-in');
    expect(reasonLabel('codex_auth_required')).toBe('Codex needs a sign-in');
    expect(reasonLabel('codex_sign_in_uncommented')).toBe('Codex needs a ChatGPT sign-in; GitHub would not take the comment asking for it, so sign in from Updraft');
    expect(reasonLabel('codex_expired_uncommented')).toBe('The Codex sign-in expired; GitHub would not take the comment asking for it, so sign in from Updraft');
    expect(reasonLabel('codex_sign_in')).toBeUndefined();
    expect(reasonLabel('claude_auth_required')).toBe('Claude needs a sign-in');
    expect(reasonLabel('kiro_auth_required')).toBeUndefined();
  });
});
