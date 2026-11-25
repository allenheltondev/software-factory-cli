import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { fakeApi } from '../test/fakeApi';
import type { NativeClaudeView } from '../api/client';
import { NativeClaudePage } from './NativeClaudePage';
const trigger = { repositoryId: 9, repository: 'acme/test-repo', label: 'updraft-native-test' };
const ready: NativeClaudeView = {
  configured: true,
  enabled: false,
  owner: true,
  managed: true,
  browserLogin: true,
  triggers: [trigger],
  availableTriggers: [trigger],
  worker: {
    status: 'connected',
    online: true,
    busy: false,
    lastHeartbeatAt: '2026-11-24T19:00:00Z',
    workerVersion: '104',
    generation: 'one',
  },
};
const grant = { url: 'wss://worker.on.aws/claude-login', token: 'sample', port: 8081, generation: 'one' };
function show(
  api: ReturnType<typeof fakeApi>,
  url: string | { pathname: string; state: { connectClaude: boolean } } = '/installations/55/claude',
) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/installations/:id/claude" element={<NativeClaudePage api={api} />} />
      </Routes>
    </MemoryRouter>,
  );
}
async function focus() {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
}
describe('guided Claude connection', () => {
  it('connects before any waiting issue or routing selection, and confirms only the same worker generation', async () => {
    const user = userEvent.setup();
    let current: NativeClaudeView = { ...ready, triggers: [], worker: null };
    const nativeClaudeStart = vi.fn(async () => {
      current = { ...current, worker: { ...(current.worker ?? ready.worker!), status: 'auth-required' } };
      return current;
    });
    const nativeClaudeLogin = vi.fn().mockResolvedValue(grant);
    const setNativeClaudeMode = vi.fn();
    show(fakeApi({ nativeClaude: async () => current, nativeClaudeStart, nativeClaudeLogin, setNativeClaudeMode }));
    await user.click(await screen.findByRole('button', { name: 'Connect Claude account' }));
    await focus();
    const frame = await screen.findByTitle('Private Claude sign-in');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
    expect(nativeClaudeStart).toHaveBeenCalledExactlyOnceWith(55);
    expect(nativeClaudeLogin).toHaveBeenCalledExactlyOnceWith(55, expect.any(AbortSignal));
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: (frame as HTMLIFrameElement).contentWindow!,
          origin: 'null',
          data: { kind: 'updraft-claude-login', result: 'connected' },
        }),
      ),
    );
    expect(screen.getByText(/Verifying your connection with your environment/)).toBeInTheDocument();
    current = { ...current, worker: { ...ready.worker!, generation: 'other' } };
    await focus();
    expect(screen.queryByTitle('Private Claude sign-in')).not.toBeInTheDocument();
    expect(screen.getByText(/environment changed during sign-in/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect Claude' })).toBeEnabled();
    expect(screen.queryByText('Your account is connected but no workflows use it yet.')).not.toBeInTheDocument();
    nativeClaudeLogin.mockResolvedValue({ ...grant, generation: 'other' });
    await user.click(screen.getByRole('button', { name: 'Reconnect Claude' }));
    await focus();
    await screen.findByTitle('Private Claude sign-in');
    current = { ...current, worker: { ...ready.worker!, generation: 'other' } };
    await focus();
    await waitFor(() =>
      expect(screen.getByText('Your account is connected but no workflows use it yet.')).toBeInTheDocument(),
    );
    expect(setNativeClaudeMode).not.toHaveBeenCalled();
  });
  it('saves routing separately without enabling subscription billing', async () => {
    const user = userEvent.setup();
    const setNativeClaudeMode = vi.fn().mockResolvedValue(ready);
    show(fakeApi({ nativeClaude: async () => ({ ...ready, triggers: [] }), setNativeClaudeMode }));
    expect(await screen.findByRole('button', { name: 'Use subscription' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Save workflow triggers' }));
    await waitFor(() => expect(setNativeClaudeMode).toHaveBeenCalledWith(55, false, [trigger]));
  });
  it('requires confirmation before enabling billing', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const setNativeClaudeMode = vi.fn();
    show(fakeApi({ nativeClaude: async () => ready, setNativeClaudeMode }));
    await user.click(await screen.findByRole('button', { name: 'Use subscription' }));
    expect(confirm).toHaveBeenCalled();
    expect(setNativeClaudeMode).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
  it('keeps a resumed waiting job in context without navigating away', async () => {
    show(
      fakeApi({
        nativeClaude: async () => ready,
        nativeClaudeWaiting: async () => ({
          status: 'started',
          expiresAt: '2026-11-25T00:00:00Z',
          jobId: 'job_example',
        }),
      }),
      '/installations/55/claude?request=job_example',
    );
    expect(await screen.findByRole('link', { name: 'View resumed job' })).toHaveAttribute(
      'href',
      '/installations/55/jobs/job_example',
    );
    expect(screen.getByRole('heading', { name: 'Claude account' })).toBeInTheDocument();
  });
  it('does not expose connection or routing controls to members', async () => {
    show(fakeApi({ nativeClaude: async () => ({ ...ready, owner: false, worker: null }) }));
    expect(await screen.findByText('An installation owner can connect this account.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Claude account' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use subscription' })).toBeDisabled();
  });
  it('keeps a compatible older session connected and offers an optional idle upgrade', async () => {
    const current: NativeClaudeView = { ...ready, updateAvailable: { from: '9', to: '10', state: 'required' } };
    const restart = vi.fn(async () => ({ ...current, updateAvailable: { ...current.updateAvailable!, state: 'stopping' as const } }));
    const { unmount } = show(fakeApi({ nativeClaude: async () => current, nativeClaudeRestart: restart }));
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText(/Update available: image/)).toBeInTheDocument();
    expect(restart).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Update and reconnect' }));
    expect(restart).toHaveBeenCalledExactlyOnceWith(55);
    unmount();
    show(fakeApi({ nativeClaude: async () => ({ ...current, worker: { ...ready.worker!, busy: true } }) }));
    expect(await screen.findByRole('button', { name: 'Update and reconnect' })).toBeDisabled();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });
  it('updates an old image in one action and blocks busy recovery', async () => {
    const user = userEvent.setup();
    const current: NativeClaudeView = { ...ready, upgrade: { from: '9', to: '10', state: 'required' } };
    const nativeClaudeRestart = vi
      .fn()
      .mockResolvedValue({ ...current, upgrade: { ...current.upgrade!, state: 'stopping' } });
    const { unmount } = show(fakeApi({ nativeClaude: async () => current, nativeClaudeRestart }));
    await user.click(await screen.findByRole('button', { name: 'Update and reconnect' }));
    expect(nativeClaudeRestart).toHaveBeenCalledExactlyOnceWith(55);
    unmount();
    show(fakeApi({ nativeClaude: async () => ({ ...current, worker: { ...ready.worker!, busy: true } }) }));
    expect(await screen.findByRole('button', { name: 'Update and reconnect' })).toBeDisabled();
  });
  it('cancels a pending grant without restoring a stale sign-in frame', async () => {
    const user = userEvent.setup();
    const current = { ...ready, worker: { ...ready.worker!, status: 'auth-required' as const } };
    let resolve!: (value: typeof grant) => void;
    const nativeClaudeLogin = vi.fn(
      () =>
        new Promise<typeof grant>((done) => {
          resolve = done;
        }),
    );
    show(fakeApi({ nativeClaude: async () => current, nativeClaudeStart: async () => current, nativeClaudeLogin }));
    await user.click(await screen.findByRole('button', { name: 'Reconnect Claude' }));
    await focus();
    await waitFor(() => expect(nativeClaudeLogin).toHaveBeenCalledOnce());
    await user.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
    await act(async () => resolve(grant));
    expect(screen.queryByTitle('Private Claude sign-in')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect Claude' })).toBeEnabled();
  });

  it('retries expired authorization against the existing environment', async () => {
    const user = userEvent.setup();
    const current = { ...ready, worker: { ...ready.worker!, status: 'auth-required' as const } };
    const nativeClaudeLogin = vi.fn().mockResolvedValue(grant);
    const nativeClaudeStart = vi.fn().mockResolvedValue(current);
    show(fakeApi({ nativeClaude: async () => current, nativeClaudeStart, nativeClaudeLogin }));
    await user.click(await screen.findByRole('button', { name: 'Reconnect Claude' }));
    await focus();
    const frame = await screen.findByTitle('Private Claude sign-in');
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: (frame as HTMLIFrameElement).contentWindow!,
          origin: 'null',
          data: { kind: 'updraft-claude-login', result: 'expired' },
        }),
      ),
    );
    expect(screen.getByText(/Sign-in expired or was interrupted/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reconnect Claude' }));
    await focus();
    expect(await screen.findByTitle('Private Claude sign-in')).toBeInTheDocument();
    expect(nativeClaudeLogin).toHaveBeenCalledTimes(2);
    expect(nativeClaudeStart).toHaveBeenCalledTimes(2);
  });

  it('does not overlap reconciliation requests and aborts on navigation', async () => {
    let resolve!: (view: NativeClaudeView) => void;
    const nativeClaude = vi
      .fn()
      .mockResolvedValueOnce(ready)
      .mockImplementation(
        () =>
          new Promise<NativeClaudeView>((done) => {
            resolve = done;
          }),
      );
    const { unmount } = show(fakeApi({ nativeClaude }));
    await screen.findByRole('heading', { name: 'Claude account' });
    await focus();
    await focus();
    await focus();
    expect(nativeClaude).toHaveBeenCalledTimes(2);
    const signal = nativeClaude.mock.calls[1]![1] as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(ready));
  });
  it('starts the same flow from the Agent keys connection link', async () => {
    let current: NativeClaudeView = { ...ready, worker: null };
    const nativeClaudeStart = vi.fn(async () => {
      current = { ...current, worker: { ...ready.worker!, status: 'auth-required' } };
      return current;
    });
    const nativeClaudeLogin = vi.fn().mockResolvedValue(grant);
    show(fakeApi({ nativeClaude: async () => current, nativeClaudeStart, nativeClaudeLogin }), {
      pathname: '/installations/55/claude',
      state: { connectClaude: true },
    });
    await waitFor(() => expect(nativeClaudeStart).toHaveBeenCalledExactlyOnceWith(55));
    await focus();
    expect(await screen.findByTitle('Private Claude sign-in')).toBeInTheDocument();
    expect(nativeClaudeLogin).toHaveBeenCalledOnce();
  });
  it('keeps the exact active authorization frame across a transient status failure', async () => {
    const user = userEvent.setup();
    const current = { ...ready, worker: { ...ready.worker!, status: 'auth-required' as const } };
    let fail = false;
    const nativeClaude = vi.fn(async () => {
      if (fail) throw Error('temporary network failure');
      return current;
    });
    const nativeClaudeLogin = vi.fn().mockResolvedValue(grant);
    show(fakeApi({ nativeClaude, nativeClaudeStart: async () => current, nativeClaudeLogin }));
    await user.click(await screen.findByRole('button', { name: 'Reconnect Claude' }));
    await focus();
    const frame = await screen.findByTitle('Private Claude sign-in');
    const document = frame.getAttribute('srcdoc');
    fail = true;
    await focus();
    expect(screen.getByText(/temporary network failure/)).toBeInTheDocument();
    fail = false;
    await focus();
    expect(screen.getByTitle('Private Claude sign-in')).toBe(frame);
    expect(frame.getAttribute('srcdoc')).toBe(document);
    expect(nativeClaudeLogin).toHaveBeenCalledOnce();
  });
  it('ignores an in-flight start result after the owner cancels the wizard', async () => {
    const user = userEvent.setup();
    const current: NativeClaudeView = { ...ready, worker: null };
    let resolve!: (value: NativeClaudeView) => void;
    const nativeClaudeStart = vi.fn(
      () =>
        new Promise<NativeClaudeView>((done) => {
          resolve = done;
        }),
    );
    const nativeClaudeLogin = vi.fn().mockResolvedValue(grant);
    show(fakeApi({ nativeClaude: async () => current, nativeClaudeStart, nativeClaudeLogin }));
    await user.click(await screen.findByRole('button', { name: 'Connect Claude account' }));
    await user.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
    await act(async () => resolve({ ...ready, worker: { ...ready.worker!, status: 'auth-required' } }));
    await focus();
    expect(screen.getByRole('button', { name: 'Connect Claude account' })).toBeEnabled();
    expect(screen.queryByTitle('Private Claude sign-in')).not.toBeInTheDocument();
    expect(nativeClaudeLogin).not.toHaveBeenCalled();
  });
  it('offers actionable admission throttling and permits an explicit retry', async () => {
    const user = userEvent.setup();
    const current: NativeClaudeView = { ...ready, worker: null };
    const nativeClaudeStart = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('Claude environment capacity is full. Try connecting again after an environment finishes.'),
      )
      .mockResolvedValue(current);
    show(fakeApi({ nativeClaude: async () => current, nativeClaudeStart }));
    await user.click(await screen.findByRole('button', { name: 'Connect Claude account' }));
    expect(await screen.findByText(/capacity is full/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect Claude account' }));
    expect(nativeClaudeStart).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Preparing your environment…')).toBeInTheDocument();
  });
  it('leaves preparation on a backend startup failure and safely reconnects to a new environment', async () => {
    const user = userEvent.setup();
    let current: NativeClaudeView = { ...ready, worker: null, preparing: true };
    const nativeClaudeStart = vi.fn(async () => {
      if (current.recovery?.state === 'stopped')
        current = { ...ready, worker: { ...ready.worker!, status: 'auth-required', generation: 'replacement' } };
      return current;
    });
    const nativeClaudeRestart = vi.fn(async () => {
      current = { ...current, recovery: { state: 'stopped' } };
      return current;
    });
    const nativeClaudeLogin = vi.fn().mockResolvedValue({ ...grant, generation: 'replacement' });
    show(fakeApi({ nativeClaude: async () => current, nativeClaudeStart, nativeClaudeRestart, nativeClaudeLogin }));
    await screen.findByText('Preparing your environment…');
    current = { ...current, preparing: false, startupFailed: true, recovery: { state: 'required' } };
    await focus();
    expect(await screen.findByText(/environment did not become ready/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reconnect Claude' }));
    expect(nativeClaudeRestart).toHaveBeenCalledOnce();
    await focus();
    await focus();
    expect(await screen.findByTitle('Private Claude sign-in')).toBeInTheDocument();
    expect(nativeClaudeLogin).toHaveBeenCalledOnce();
  });
  it('shows configured idle policy before connection and effective expiry while connected', async () => {
    const deadline = '2026-11-24T21:00:00Z';
    const policy = {
      maxSessionSeconds: 28800,
      idleSeconds: 7200,
      concurrentSessions: 4,
      tenantDailySeconds: 86400,
      platformDailySeconds: 691200,
      tenantLaunchesPerDay: 12,
      platformLaunchesPerDay: 96,
    };
    let current: NativeClaudeView = { ...ready, worker: null, connectionPolicy: policy };
    show(fakeApi({ nativeClaude: async () => current }));
    expect(await screen.findByText(/close after 2 hours idle/)).toBeInTheDocument();
    expect(screen.getByText(/12 new environments per UTC day/)).toBeInTheDocument();
    current = { ...ready, connectionPolicy: policy, sessionExpiresAt: deadline, idleExpiresAt: deadline };
    await focus();
    expect(screen.getByText(/Current connection expires/)).toHaveTextContent(
      new Date(deadline).toLocaleString(undefined, { timeZoneName: 'short' }),
    );
  });
  it.each(['stopping', 'stopped'] as const)(
    'does not restart an intentionally retired %s session during status restoration',
    async (state) => {
      const nativeClaudeStart = vi.fn();
      const nativeClaudeRestart = vi.fn();
      const current: NativeClaudeView = {
        ...ready,
        worker: null,
        preparing: false,
        retired: true,
        retirementReason: 'idle',
        recovery: { state },
      };
      show(fakeApi({ nativeClaude: async () => current, nativeClaudeStart, nativeClaudeRestart }));
      expect(await screen.findByText('Session ended')).toBeInTheDocument();
      await focus();
      await focus();
      expect(screen.getByRole('button', { name: 'Reconnect Claude' })).toBeEnabled();
      expect(nativeClaudeStart).not.toHaveBeenCalled();
      expect(nativeClaudeRestart).not.toHaveBeenCalled();
    },
  );
});
