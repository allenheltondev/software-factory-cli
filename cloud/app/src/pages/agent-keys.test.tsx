import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ApiError, type AgentKeysView } from '../api/client';
import { fakeApi } from '../test/fakeApi';
import { AgentKeysPage } from './AgentKeysPage';

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';
const view = (over: Partial<AgentKeysView> = {}): AgentKeysView => ({
  keys: [
    { name: 'ANTHROPIC_API_KEY', configured: true, lastRotatedAt: '2026-11-20T10:00:00.000Z', lastRotatedBy: 'pat', lastUsed: { at: '2026-11-21T10:00:00.000Z', ok: false } },
    { name: 'CODEX_API_KEY', configured: false },
  ],
  refusals: [],
  ...over,
});

const show = (api: ReturnType<typeof fakeApi>) =>
  render(
    <MemoryRouter initialEntries={['/installations/55/keys']}>
      <Routes>
        <Route path="/installations/:id/keys" element={<AgentKeysPage api={api} />} />
      </Routes>
    </MemoryRouter>,
  );

describe('AgentKeysPage', () => {
  it('shows configured, last rotated and last used, with no value anywhere', async () => {
    show(fakeApi({ agentKeys: async () => view({ refusals: [{ at: '2026-11-21T09:00:00.000Z', deliveryId: 'd', repository: 'acme/web', issue: 3, reason: 'CODEX_API_KEY is not set' }] }) }));
    const row = await screen.findByTestId('key-ANTHROPIC_API_KEY');
    expect(within(row).getByText('Configured')).toBeInTheDocument();
    expect(within(row).getByText(/Last rotated/)).toHaveTextContent('by pat');
    expect(within(row).getByText('Failed')).toBeInTheDocument();
    expect(within(screen.getByTestId('key-CODEX_API_KEY')).getByText('Not set')).toBeInTheDocument();
    expect(screen.getByTestId('refusals')).toHaveTextContent('acme/web#3: CODEX_API_KEY is not set');
  });

  it('sends the key once, clears it from the page, and shows the new state', async () => {
    const calls: unknown[][] = [];
    const user = userEvent.setup();
    show(
      fakeApi({
        agentKeys: async () => view(),
        setAgentKey: async (...args) => {
          calls.push(args);
          return view({ keys: [{ name: 'ANTHROPIC_API_KEY', configured: true, lastRotatedAt: '2026-11-21T11:00:00.000Z', lastRotatedBy: 'pat' }, { name: 'CODEX_API_KEY', configured: false }] });
        },
      }),
    );
    const row = await screen.findByTestId('key-ANTHROPIC_API_KEY');
    await user.type(within(row).getByLabelText('Replace the key'), KEY);
    await user.click(within(row).getByRole('button', { name: 'Rotate' }));
    await waitFor(() => expect(calls).toEqual([[55, 'ANTHROPIC_API_KEY', KEY]]));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(within(screen.getByTestId('key-ANTHROPIC_API_KEY')).getByLabelText('Replace the key')).toHaveValue('');
    expect(document.body.textContent).not.toContain(KEY);
  });

  it('shows why a key was refused and drops the typed value', async () => {
    const user = userEvent.setup();
    show(fakeApi({ agentKeys: async () => view(), setAgentKey: async () => { throw new ApiError(400, 'invalid_key', 'Anthropic rejected that key; nothing was changed'); } }));
    const row = await screen.findByTestId('key-CODEX_API_KEY');
    await user.type(within(row).getByLabelText('Key'), 'sk-whatever-1234567890123456');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    expect(await screen.findByTestId('keys-save-error')).toHaveTextContent('Anthropic rejected that key');
    expect(within(screen.getByTestId('key-CODEX_API_KEY')).getByLabelText('Key')).toHaveValue('');
  });
});
