import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { fakeApi } from '../test/fakeApi';
import type { NativeClaudeView } from '../api/client';
import { NativeClaudePage } from './NativeClaudePage';

const ready: NativeClaudeView = {
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

function show(api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={['/installations/55/claude']}>
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
