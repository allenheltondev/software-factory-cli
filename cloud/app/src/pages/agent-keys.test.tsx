import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type AgentKeysView } from '../api/client';
import { fakeApi } from '../test/fakeApi';
import { AgentKeysPage } from './AgentKeysPage';

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';
const view = (over: Partial<AgentKeysView> = {}): AgentKeysView => ({
  keys: [
    { name: 'ANTHROPIC_API_KEY', configured: true, required: true, lastRotatedAt: '2026-11-20T10:00:00.000Z', lastRotatedBy: 'pat', lastUsed: { at: '2026-11-21T10:00:00.000Z', ok: false } },
    { name: 'CODEX_API_KEY', configured: false, required: false },
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
  it('shows what a key is for, whether it works, and where the value is never shown', async () => {
    show(fakeApi({ agentKeys: async () => view({ refusals: [{ at: '2026-11-21T09:00:00.000Z', deliveryId: 'd', repository: 'acme/web', issue: 3, reason: 'CODEX_API_KEY is not set' }] }) }));
    const claude = await screen.findByTestId('key-ANTHROPIC_API_KEY');
    expect(within(claude).getByText('Configured')).toBeInTheDocument();
    expect(within(claude).getByText('Required by your configuration')).toBeInTheDocument();
    expect(within(claude).getByText(/Last rotated/)).toHaveTextContent('by pat');
    expect(within(claude).getByText('Failed')).toBeInTheDocument();
    expect(screen.getByTestId('key-failed-ANTHROPIC_API_KEY')).toHaveTextContent('often not the key');
    // A key that is set shows no input until it is rotated.
    expect(within(claude).queryByLabelText('New key')).toBeNull();
    const codex = screen.getByTestId('key-CODEX_API_KEY');
    expect(within(codex).getByText('Not set')).toBeInTheDocument();
    expect(within(codex).getByText('Optional')).toBeInTheDocument();
    expect(within(codex).getByRole('link', { name: /Get API key/ })).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
    expect(within(codex).getByRole('link', { name: /Setup guide/ })).toHaveAttribute('href', 'https://learn.chatgpt.com/docs/auth#sign-in-with-an-api-key');
    expect(within(codex).getByRole('link', { name: /OpenAI API key creation/ })).toHaveAttribute('href', 'https://developers.openai.com/api/docs/quickstart#create-and-export-an-api-key');
    // The guide stays when a key is already saved, for rotation.
    expect(within(claude).getByRole('link', { name: /Get API key/ })).toHaveAttribute('href', 'https://platform.claude.com/settings/keys');
    expect(within(claude).getByRole('link', { name: /Setup guide/ })).toHaveAttribute('href', 'https://platform.claude.com/docs/en/get-api-key');
    expect(screen.getByTestId('refusals')).toHaveTextContent('acme/web#3: CODEX_API_KEY is not set');
    expect(screen.getByTestId('keys-privacy')).toHaveTextContent('never shown again');
  });

  it('says up front when a required key is missing', async () => {
    show(fakeApi({ agentKeys: async () => view({ keys: [{ name: 'ANTHROPIC_API_KEY', configured: false, required: true }, { name: 'CODEX_API_KEY', configured: false, required: false }] }) }));
    expect(await screen.findByTestId('keys-needed')).toHaveTextContent('Add your Anthropic key to start running jobs');
  });

  it('catches a key pasted under the wrong provider before sending anything', async () => {
    const setAgentKey = vi.fn();
    const user = userEvent.setup();
    show(fakeApi({ agentKeys: async () => view(), setAgentKey }));
    const codex = await screen.findByTestId('key-CODEX_API_KEY');
    await user.type(within(codex).getByLabelText('OpenAI API key'), KEY);
    expect(within(codex).getByText(/looks like an Anthropic key/)).toBeInTheDocument();
    expect(within(codex).getByRole('button', { name: 'Check and save' })).toBeDisabled();
    expect(setAgentKey).not.toHaveBeenCalled();
  });

  it('rotates: the form opens on demand, the key is sent once, cleared, and confirmed', async () => {
    const calls: unknown[][] = [];
    const user = userEvent.setup();
    show(
      fakeApi({
        agentKeys: async () => view(),
        setAgentKey: async (...args) => {
          calls.push(args);
          return view({ keys: [{ name: 'ANTHROPIC_API_KEY', configured: true, required: true, lastRotatedAt: new Date().toISOString(), lastRotatedBy: 'pat' }, { name: 'CODEX_API_KEY', configured: false, required: false }] });
        },
      }),
    );
    const row = await screen.findByTestId('key-ANTHROPIC_API_KEY');
    await user.click(within(row).getByRole('button', { name: 'Rotate key' }));
    const field = within(row).getByLabelText('New key');
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute('type', 'password');
    await user.type(field, KEY);
    await user.click(within(row).getByRole('button', { name: 'Check and replace' }));
    await waitFor(() => expect(calls).toEqual([[55, 'ANTHROPIC_API_KEY', KEY]]));
    expect(await screen.findByTestId('key-saved-ANTHROPIC_API_KEY')).toHaveTextContent('Anthropic accepted the key');
    expect(screen.queryByLabelText('New key')).toBeNull();
    expect(document.body.textContent).not.toContain(KEY);
  });

  it('keeps what was typed when the provider refuses it, and says why next to the field', async () => {
    const user = userEvent.setup();
    show(fakeApi({ agentKeys: async () => view(), setAgentKey: async () => { throw new ApiError(400, 'invalid_key', 'Anthropic rejected that key; nothing was changed'); } }));
    const row = await screen.findByTestId('key-CODEX_API_KEY');
    await user.type(within(row).getByLabelText('OpenAI API key'), 'sk-whatever-1234567890123456');
    await user.click(within(row).getByRole('button', { name: 'Check and save' }));
    expect(await screen.findByTestId('keys-save-error')).toHaveTextContent('rejected that key');
    expect(within(row).getByLabelText('OpenAI API key')).toHaveValue('sk-whatever-1234567890123456');
  });
});
