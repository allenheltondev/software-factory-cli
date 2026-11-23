import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { fakeApi } from '../test/fakeApi';
import type { NativeClaudeView } from '../api/client';
import { NativeClaudePage } from './NativeClaudePage';

const trigger = { repositoryId: 9, repository: 'acme/test-repo', label: 'updraft-native-test' };

const ready: NativeClaudeView = {
  triggers: [trigger],
  availableTriggers: [trigger],
  configured: true,
  enabled: false,
  repository: 'acme/test-repo',
  labels: ['updraft-native-test'],
  worker: {
    status: 'connected',
    online: true,
    busy: false,
    lastHeartbeatAt: '2026-11-23T19:00:00Z',
    workerVersion: '104',
  },
};

function show(api: ReturnType<typeof fakeApi>, url = '/installations/55/claude') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/installations/:id/claude" element={<NativeClaudePage api={api} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Claude subscription settings page', () => {
  it('keeps the API key and explicitly opts into a connected native worker', async () => {
    const user = userEvent.setup();
    const setNativeClaudeMode = vi.fn().mockResolvedValue({ ...ready, enabled: true });
    show(fakeApi({ nativeClaude: async () => ready, setNativeClaudeMode }));
    expect(await screen.findByText('Claude authentication')).toBeInTheDocument();
    expect(screen.getByText(/never deletes your saved Anthropic API key/)).toBeInTheDocument();
    expect(screen.getByText(/acme\/test-repo/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use subscription' }));
    await waitFor(() => expect(setNativeClaudeMode).toHaveBeenCalledWith(55, true));
    expect(screen.getByRole('button', { name: 'Use API key' })).toBeEnabled();
  });

  it('saves a published trigger without turning on the subscription', async () => {
    const user = userEvent.setup();
    const setNativeClaudeMode = vi.fn().mockResolvedValue(ready);
    show(fakeApi({ nativeClaude: async () => ({ ...ready, triggers: [] }), setNativeClaudeMode }));
    expect(await screen.findByRole('button', { name: 'Use subscription' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'acme/test-repo · updraft-native-test' }));
    await user.click(screen.getByRole('button', { name: 'Save workflow triggers' }));
    await waitFor(() => expect(setNativeClaudeMode).toHaveBeenCalledWith(55, false, [trigger]));
  });

  it('opens a sandboxed browser sign-in with the worker endpoint grant', async () => {
    const user = userEvent.setup();
    const nativeClaudeLogin = vi.fn().mockResolvedValue({ url: 'wss://worker.on.aws/claude-login', token: 'sample', port: 8081 });
    show(fakeApi({ nativeClaude: async () => ({ ...ready, browserLogin: true, worker: { ...ready.worker!, status: 'auth-required' } }), nativeClaudeLogin }));
    await user.click(await screen.findByRole('button', { name: 'Sign in to Claude' }));
    const frame = await screen.findByTitle('Private Claude sign-in');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
    expect(frame.getAttribute('srcdoc')).toContain('wss://worker.on.aws/claude-login');
    expect(nativeClaudeLogin).toHaveBeenCalledExactlyOnceWith(55);
  });

  it('starts a tenant worker from the GitHub deep link and opens its private sign-in panel', async () => {
    const user = userEvent.setup();
    const requestId = 'job_' + 'a'.repeat(16);
    const nativeClaudeStart = vi.fn().mockResolvedValue({
      ...ready, managed: true, browserLogin: true, enabled: true, worker: { ...ready.worker!, status: 'auth-required' },
    });
    const nativeClaudeLogin = vi.fn().mockResolvedValue({ url: 'wss://worker.on.aws/claude-login', token: 'sample', port: 8081 });
    show(fakeApi({
      nativeClaude: async () => ({ ...ready, managed: true, browserLogin: true, enabled: true, worker: null }),
      nativeClaudeWaiting: async () => ({ status: 'waiting', expiresAt: '2026-11-24T19:00:00Z' }),
      nativeClaudeStart, nativeClaudeLogin,
    }), `/installations/55/claude?request=${requestId}`);
    await user.click(await screen.findByRole('button', { name: 'Start worker and sign in' }));
    expect(await screen.findByTitle('Private Claude sign-in')).toBeInTheDocument();
    expect(nativeClaudeStart).toHaveBeenCalledExactlyOnceWith(55, requestId);
    expect(nativeClaudeLogin).toHaveBeenCalledExactlyOnceWith(55);
  });

  it('refuses a subscription selection until the worker is configured and signed in', async () => {
    show(fakeApi({ nativeClaude: async () => ({
      ...ready, worker: { ...ready.worker!, status: 'auth-required' },
    }) }));
    expect(await screen.findByText('Claude authentication')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use subscription' })).toBeDisabled();
    expect(screen.getByText(/The worker is offline or Claude is not signed in/)).toBeInTheDocument();
  });

  it('explains that first-time AWS worker provisioning remains necessary', async () => {
    show(fakeApi({ nativeClaude: async () => ({ configured: false, enabled: false, worker: null }) }));
    expect(await screen.findByText(/needs to be provisioned once/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use subscription' })).toBeDisabled();
    expect(screen.getByRole('link', { name: /Worker setup guide/ })).toHaveAttribute('href', expect.stringContaining('/CLOUD.md'));
  });
});
