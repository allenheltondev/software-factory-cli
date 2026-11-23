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
  const TOKEN = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789';

  it('offers a Claude subscription token next to the API key Claude needs, with how to get one', async () => {
    show(
      fakeApi({
        agentKeys: async () =>
          view({
            keys: [
              { name: 'ANTHROPIC_API_KEY', configured: false, required: true },
              { name: 'CLAUDE_CODE_OAUTH_TOKEN', configured: false, required: false, alternativeTo: 'ANTHROPIC_API_KEY' },
              { name: 'CODEX_API_KEY', configured: false, required: false },
            ],
          }),
      }),
    );
    const token = await screen.findByTestId('key-CLAUDE_CODE_OAUTH_TOKEN');
    // Shown with the API key it stands in for, not under "Other agents".
    expect(within(screen.getByTestId('other-agents')).queryByTestId('key-CLAUDE_CODE_OAUTH_TOKEN')).toBeNull();
    expect(token).toHaveTextContent('Claude: subscription');
    expect(screen.getByTestId('key-ANTHROPIC_API_KEY')).toHaveTextContent('Claude: API key');
    expect(screen.getByTestId('key-note-CLAUDE_CODE_OAUTH_TOKEN')).toHaveTextContent('instead of API credits');
    expect(within(token).getByTestId('key-steps-CLAUDE_CODE_OAUTH_TOKEN')).toHaveTextContent('claude setup-token');
    // Each Claude credential is sent to its own field before anything is saved.
    await userEvent.type(within(token).getByLabelText('Claude subscription token'), KEY);
    expect(within(token).getByText(/That is an Anthropic API key/)).toBeInTheDocument();
    const apiKey = screen.getByTestId('key-ANTHROPIC_API_KEY');
    await userEvent.type(within(apiKey).getByLabelText('Anthropic API key'), TOKEN);
    expect(within(apiKey).getByText(/That is a Claude subscription token/)).toBeInTheDocument();
  });

  it('says which of the two Claude credentials jobs use once the token is set', async () => {
    show(
      fakeApi({
        agentKeys: async () =>
          view({
            keys: [
              { name: 'ANTHROPIC_API_KEY', configured: true, required: false, lastRotatedAt: '2026-11-20T10:00:00.000Z' },
              { name: 'CLAUDE_CODE_OAUTH_TOKEN', configured: true, required: false, alternativeTo: 'ANTHROPIC_API_KEY', lastRotatedAt: '2026-11-21T10:00:00.000Z' },
            ],
          }),
      }),
    );
    expect(await screen.findByTestId('key-note-CLAUDE_CODE_OAUTH_TOKEN')).toHaveTextContent('Jobs run on your subscription, not API credits');
    expect(screen.getByTestId('key-note-ANTHROPIC_API_KEY')).toHaveTextContent('Not used while your Claude subscription token is set');
    // No provider call checks a subscription token: its first job does, and the card says so.
    expect(screen.getByTestId('key-CLAUDE_CODE_OAUTH_TOKEN')).toHaveTextContent('the first job is the check');
  });

  it('shows what a key is for, whether it works, and where the value is never shown', async () => {
    show(fakeApi({ agentKeys: async () => view({ refusals: [{ at: '2026-11-21T09:00:00.000Z', deliveryId: 'd', repository: 'acme/web', issue: 3, reason: 'CODEX_API_KEY is not set' }] }) }));
    const claude = await screen.findByTestId('key-ANTHROPIC_API_KEY');
    expect(within(claude).getByText('Last job failed')).toBeInTheDocument();
    expect(within(claude).getByText('Used by your configuration')).toBeInTheDocument();
    expect(within(claude).getByText(/Last rotated/)).toHaveTextContent('by pat');
    expect(screen.getByTestId('key-failed-ANTHROPIC_API_KEY')).toHaveTextContent('often not the key');
    // A key that is set shows no input until it is rotated.
    expect(within(claude).queryByLabelText('New key')).toBeNull();
    // An agent the configuration does not use waits under "Other agents", with the steps to get its key.
    const codex = within(screen.getByTestId('other-agents')).getByTestId('key-CODEX_API_KEY');
    expect(within(codex).getByText('Not set')).toBeInTheDocument();
    expect(within(codex).getByRole('link', { name: /API keys on the OpenAI platform/ })).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
    expect(within(codex).getByTestId('key-steps-CODEX_API_KEY')).toHaveTextContent('Paste it here.');
    expect(within(codex).getByRole('link', { name: /Get API key/ })).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
    expect(within(codex).getByRole('link', { name: /Setup guide/ })).toHaveAttribute('href', 'https://learn.chatgpt.com/docs/auth#sign-in-with-an-api-key');
    expect(within(codex).getByRole('link', { name: /OpenAI API key creation/ })).toHaveAttribute('href', 'https://developers.openai.com/api/docs/quickstart#create-and-export-an-api-key');
    // The guide stays when a key is already saved, for rotation.
    expect(within(claude).getByRole('link', { name: /Get API key/ })).toHaveAttribute('href', 'https://platform.claude.com/settings/keys');
    expect(within(claude).getByRole('link', { name: /Setup guide/ })).toHaveAttribute('href', 'https://platform.claude.com/docs/en/get-api-key');
    expect(screen.getByTestId('refusals')).toHaveTextContent('acme/web#3: CODEX_API_KEY is not set');
    expect(screen.getByTestId('keys-privacy')).toHaveTextContent('never shown again');
  });

  it('says up front when a required key is missing, puts it first with its steps, and says when all are set', async () => {
    show(
      fakeApi({
        agentKeys: async () =>
          view({ keys: [{ name: 'CODEX_API_KEY', configured: false, required: false }, { name: 'KIRO_API_KEY', configured: false, required: false }, { name: 'ANTHROPIC_API_KEY', configured: false, required: true }] }),
      }),
    );
    expect(await screen.findByTestId('keys-needed')).toHaveTextContent('Add your Anthropic key to start running jobs');
    const cards = screen.getAllByTestId(/^key-[A-Z_]+$/);
    expect(cards[0]).toHaveAttribute('data-testid', 'key-ANTHROPIC_API_KEY');
    expect(screen.getByTestId('key-steps-ANTHROPIC_API_KEY')).toHaveTextContent('Create key');
    expect(screen.getByTestId('other-agents')).toHaveTextContent('Other agents (Codex, Kiro)');
  });

  it('says so when every agent the configuration runs has its key', async () => {
    show(fakeApi({ agentKeys: async () => view({ keys: [{ name: 'ANTHROPIC_API_KEY', configured: true, required: true, lastRotatedAt: '2026-11-20T10:00:00.000Z', lastUsed: { at: '2026-11-21T10:00:00.000Z', ok: true } }, { name: 'CODEX_API_KEY', configured: false, required: false }] }) }));
    expect(await screen.findByTestId('keys-ready')).toHaveTextContent('Every agent your configuration runs has its key');
    expect(within(screen.getByTestId('key-ANTHROPIC_API_KEY')).getByText('Working')).toBeInTheDocument();
  });

  it("guides a Kiro key, including the organization's admin step, and saves it without a provider check", async () => {
    const calls: unknown[][] = [];
    const user = userEvent.setup();
    const kiro = { name: 'KIRO_API_KEY', configured: false, required: true };
    show(
      fakeApi({
        agentKeys: async () => view({ keys: [kiro, { name: 'ANTHROPIC_API_KEY', configured: false, required: false }] }),
        setAgentKey: async (...args) => {
          calls.push(args);
          return view({ keys: [{ ...kiro, configured: true, lastRotatedAt: new Date().toISOString(), lastRotatedBy: 'pat' }, { name: 'ANTHROPIC_API_KEY', configured: false, required: false }] });
        },
      }),
    );
    const card = await screen.findByTestId('key-KIRO_API_KEY');
    expect(within(card).getByTestId('key-steps-KIRO_API_KEY')).toHaveTextContent('IAM Identity Center');
    // The guide links are on the Kiro card too, and the unchecked-key messaging is kept.
    expect(within(card).getByRole('link', { name: /Get API key/ })).toHaveAttribute('href', 'https://app.kiro.dev/');
    expect(within(card).getByRole('link', { name: /Setup guide/ })).toHaveAttribute('href', 'https://kiro.dev/docs/getting-started/authentication/#generate-an-api-key');
    expect(within(card).getByRole('link', { name: /Enable API keys for an organization/ })).toHaveAttribute('href', 'https://kiro.dev/docs/enterprise/governance/api-keys/');
    const field = within(card).getByLabelText('Kiro API key');
    await user.type(field, KEY);
    expect(within(card).getByText(/looks like an Anthropic key/)).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, 'kiro_abcdefghijklmnopqrstuvwxyz012345');
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toEqual([[55, 'KIRO_API_KEY', 'kiro_abcdefghijklmnopqrstuvwxyz012345']]));
    expect(await screen.findByTestId('key-saved-KIRO_API_KEY')).toHaveTextContent('Your next Kiro job will use it');
    expect(within(screen.getByTestId('key-KIRO_API_KEY')).getByText(/the first job is the check/)).toBeInTheDocument();
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
