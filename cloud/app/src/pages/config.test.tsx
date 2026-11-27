import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { AuthProvider, configureAuth } from '@readysetcloud/ui/auth';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, ConfigInvalidError, type AgentKeyView, type ConfigView, type ConsoleConfig, type VersionSummary } from '../api/client';
import { AppLayout } from '../layout/AppLayout';
import { fakeApi } from '../test/fakeApi';
import { ConfigHistoryPage, diffFiles } from './ConfigHistoryPage';
import { ConfigPage, issuesAt, parseLogins } from './ConfigPage';
import { InstallationPage } from './InstallationPage';
import { keysNeeded, workflowConflict } from './config/model';
// The settings the server's round-trip and compile tests use (server/src/tenants/config-service.test.ts).
import fixture from '../../../server/src/tenants/fixtures/console-samples.json';

const PROMPTS = { implement: '# Implement the issue', review: '# Review the PR', revise: '# Revise the PR' };

/** What the server starts a new installation from: Claude and Codex in builders and reviewers. */
const baseConfig = (): ConsoleConfig => ({
  version: 2,
  agents: { claude: { adapter: 'claude', enabled: true }, codex: { adapter: 'codex', enabled: true } },
  pools: { builders: { agents: ['claude', 'codex'] }, reviewers: { agents: ['claude', 'codex'] } },
  allowedActors: ['pat'],
  workflows: {
    implement: {
      label: 'updraft',
      pool: 'builders',
      prompt: PROMPTS.implement,
      review: { enabled: true, pool: 'reviewers', prompt: PROMPTS.review, allowSameAgent: false },
      revise: { enabled: true, prompt: PROMPTS.revise },
    },
  },
  repositories: {},
});
/** More than the simple page shows (a pool of its own): it opens in the full editor. */
const beyondSimple = (): ConsoleConfig => {
  const config = withRepo();
  config.pools.fast = { agents: ['claude'] };
  return config;
};
const withRepo = (config = baseConfig()): ConsoleConfig => ({ ...config, repositories: { 'acme/web': { enabled: true, workflows: ['implement'], publish: 'draft-pr', commentOnFailure: true, verify: [] } } });

const view = (over: Partial<ConfigView> = {}): ConfigView => ({
  tenant: { installationId: 55, accountLogin: 'acme', accountType: 'Organization', status: 'active', role: 'owner' },
  githubLogin: 'pat',
  repositories: [
    { id: 9, fullName: 'acme/web', private: true, htmlUrl: 'https://github.com/acme/web' },
    { id: 10, fullName: 'acme/api', private: false, htmlUrl: 'https://github.com/acme/api' },
  ],
  agentKeys: { ANTHROPIC_API_KEY: true, CODEX_API_KEY: true },
  agents: ['claude', 'codex'],
  activeVersion: null,
  source: 'none',
  config: baseConfig(),
  defaults: { prompts: PROMPTS },
  limits: { ceilings: { timeoutMinutes: 120, verifyTimeoutMinutes: 30, autoMergeWaitMinutes: 120, maxRevisions: 5 }, console: {} },
  ...over,
});
/** A configuration that was published: the editor, not the guide. */
const published = (over: Partial<ConfigView> = {}) => view({ activeVersion: 1, source: 'console', config: withRepo(), ...over });

function at(path: string, element: React.ReactNode, route: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={element} />
      </Routes>
    </MemoryRouter>,
  );
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const configPage = (api: ReturnType<typeof fakeApi>) => at('/installations/55/config', <ConfigPage api={api} />, '/installations/:id/config');
const publishedOk = (version = 2) => vi.fn().mockResolvedValue({ ok: true, version, yaml: 'version: 1\n', warnings: [] });
const sentConfig = (api: ReturnType<typeof fakeApi>, call = 0) => (api.publishConfig as ReturnType<typeof vi.fn>).mock.calls[call]![1].config as ConsoleConfig;

describe('helpers', () => {
  it('parses logins from commas and spaces, and finds issues at a field or inside it', () => {
    expect(parseLogins(' @pat, sam  pat\nlee ')).toEqual(['pat', 'sam', 'lee']);
    const issues = [
      { path: 'repositories.acme/web.allowedActors.0', message: 'a GitHub login' },
      { path: 'repositories.acme/webby.publish', message: 'nope' },
    ];
    expect(issuesAt(issues, 'repositories.acme/web.allowedActors')).toBe('a GitHub login');
    expect(issuesAt(issues, 'repositories.acme/web')).toBe('a GitHub login');
  });

  it('diffs every file in either version', () => {
    const files = diffFiles({ 'config.yaml': 'a: 1\n', 'prompts/old.md': 'x' }, { 'config.yaml': 'a: 2\n', 'prompts/new.md': 'y' });
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['config.yaml', 'changed'],
      ['prompts/new.md', 'added'],
      ['prompts/old.md', 'removed'],
    ]);
  });

  it('knows which keys the agents of enabled repositories need, and skips agents that are off', () => {
    const config = withRepo();
    expect(keysNeeded(config, { ANTHROPIC_API_KEY: true })).toMatchObject({ needed: ['ANTHROPIC_API_KEY', 'CODEX_API_KEY'], missing: ['CODEX_API_KEY'] });
    config.agents.codex!.enabled = false;
    expect(keysNeeded(config, { ANTHROPIC_API_KEY: true }).missing).toEqual([]);
  });

  it('finds workflows of one repository that clash', () => {
    const config = withRepo();
    config.workflows.docs = { ...config.workflows.implement!, label: 'Updraft' };
    const repo = { ...config.repositories['acme/web']!, workflows: ['implement', 'docs'] };
    expect(workflowConflict(config, repo)).toMatch(/both start on the label/);
    config.workflows.docs.label = 'docs';
    config.workflows.docs.review = { ...config.workflows.docs.review, enabled: false };
    expect(workflowConflict(config, repo)).toMatch(/review or revise pull requests differently/);
    // The acceptance policy is part of it; unset is the CLI's default, enforce.
    config.workflows.docs.review = { ...config.workflows.implement!.review, acceptance: 'report' };
    expect(workflowConflict(config, repo)).toMatch(/review or revise pull requests differently/);
    config.workflows.docs.review = { ...config.workflows.implement!.review, acceptance: 'enforce' };
    expect(workflowConflict(config, repo)).toBeNull();
  });
});

describe('Installation navigation', () => {
  it('links an active installation to its configuration from the sidebar', async () => {
    configureAuth({ region: 'us-east-1', clientId: 'test-client', sharedCookieDomain: '' });
    const api = fakeApi({
      githubStatus: vi.fn().mockResolvedValue({ configured: true, tenants: [view().tenant] }),
      overview: vi.fn().mockResolvedValue({
        tenant: view().tenant,
        installation: { status: 'active', checked: true, missingPermissions: [] },
        repositories: [],
        config: { activeVersion: null },
        keys: [],
        activity: { window: { deliveries: 3, deliveriesComplete: true, jobs: 2, jobsComplete: true }, deliveries: {}, jobs: {}, running: 0 },
      }),
      jobs: vi.fn().mockResolvedValue({ jobs: [] }),
      deliveries: vi.fn().mockResolvedValue({ deliveries: [] }),
    });
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/installations/55']}>
          <Routes>
            <Route element={<AppLayout api={api} />}>
              <Route path="/installations/:id" element={<InstallationPage api={api} />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );
    const sidebar = screen.getByRole('navigation', { name: 'Primary navigation' });
    const configuration = await within(sidebar).findByRole('link', { name: 'Configuration' });
    expect(configuration).toHaveAttribute('href', '/installations/55/config');
  });
});


describe('the simple page', () => {
  it('sets up from nothing: one repository, both agents coding and reviewing, and shows where to try it', async () => {
    const api = fakeApi({ config: vi.fn().mockResolvedValue(view()), publishConfig: publishedOk(1) });
    configPage(api);
    expect(await screen.findByTestId('simple-config')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Set up Updraft/ })).toBeInTheDocument();
    const publish = screen.getByRole('button', { name: 'Publish' });
    expect(publish).toBeDisabled();
    expect(screen.getByTestId('blockers')).toHaveTextContent('Turn on at least one repository.');
    expect(within(screen.getByTestId('coding-claude')).getByRole('checkbox')).toBeChecked();
    expect(within(screen.getByTestId('coding-codex')).getByRole('checkbox')).toBeChecked();
    expect(within(screen.getByTestId('review-claude')).getByRole('checkbox')).toBeChecked();
    expect(within(screen.getByTestId('review-codex')).getByRole('checkbox')).toBeChecked();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Work in acme/web' }));
    await userEvent.type(within(screen.getByTestId('repo-acme/web')).getByLabelText('Checks'), 'npm ci && npm test');
    expect(screen.queryByTestId('blockers')).toBeNull();
    await userEvent.click(publish);

    expect(api.publishConfig).toHaveBeenCalledWith(55, { config: expect.any(Object), baseVersion: null });
    const sent = sentConfig(api);
    expect(sent.pools).toEqual({ builders: { agents: ['claude', 'codex'] }, reviewers: { agents: ['claude', 'codex'] } });
    // A new reviewed repository repairs failing CI: the guided software factory.
    expect(sent.repositories['acme/web']).toEqual({ enabled: true, workflows: ['implement'], publish: 'draft-pr', commentOnFailure: true, verify: ['npm ci && npm test'], ci: {} });
    const first = await screen.findByTestId('first-publish');
    expect(first).toHaveTextContent('add the label updraft to an issue in acme/web');
    expect(within(first).getByRole('link', { name: /acme\/web/ })).toHaveAttribute('href', 'https://github.com/acme/web/issues');
  });

  it('offers Kiro like any other agent', async () => {
    configPage(fakeApi({ config: vi.fn().mockResolvedValue(published({ agents: ['claude', 'codex', 'kiro'], agentKeys: { ANTHROPIC_API_KEY: true, CODEX_API_KEY: true, KIRO_API_KEY: false } })) }));
    expect(await screen.findByTestId('coding-kiro')).toBeInTheDocument();
    expect(screen.getByTestId('review-kiro')).toBeInTheDocument();
    expect(screen.queryByTestId('kiro-not-enabled')).toBeNull();
  });

  it('ticks coding and review agents separately; no review agent means no review; self-review takes explicit consent', async () => {
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published()), publishConfig: publishedOk(2) });
    configPage(api);
    expect(screen.queryByTestId('pending-changes')).toBeNull();
    await userEvent.click(within(await screen.findByTestId('review-claude')).getByRole('checkbox'));
    // The policy is not changed for the person: Codex would review its own code, so they choose.
    expect(screen.getByTestId('review-summary')).toHaveTextContent(/An agent would review its own work. Choose another review agent/);
    expect(screen.getByTestId('blockers')).toHaveTextContent('Codex would review its own work on "updraft": choose another review agent, or allow self-review.');
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(screen.getByTestId('pending-changes')).toHaveTextContent('acme/web · updraft: review Claude Code, Codex → Codex.');
    await userEvent.click(screen.getByTestId('allow-self-review'));
    expect(screen.getByTestId('pending-changes')).toHaveTextContent('An agent may now review its own pull request');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    let sent = sentConfig(api);
    expect(sent.pools).toEqual({ builders: { agents: ['claude', 'codex'] }, reviewers: { agents: ['codex'] } });
    expect(sent.workflows.implement!.review).toMatchObject({ enabled: true, pool: 'reviewers', allowSameAgent: true });

    await userEvent.click(within(screen.getByTestId('review-codex')).getByRole('checkbox'));
    expect(screen.getByTestId('review-policy')).toHaveTextContent('No automated review: pull requests wait for a person.');
    await userEvent.click(within(screen.getByTestId('coding-codex')).getByRole('checkbox'));
    // Unticking the last coding agent is allowed, and the bar says it must be put back.
    await userEvent.click(within(screen.getByTestId('coding-claude')).getByRole('checkbox'));
    expect(screen.getByTestId('blockers')).toHaveTextContent('Choose at least one coding agent.');
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    await userEvent.click(within(screen.getByTestId('coding-claude')).getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    sent = sentConfig(api, 1);
    expect(sent.pools).toEqual({ builders: { agents: ['claude'] } });
    expect(sent.agents.codex).toEqual({ adapter: 'codex', enabled: false });
    expect(sent.workflows.implement!.review.enabled).toBe(false);
  });

  it('shows an agent without a key disabled, says why, and takes the key from its info icon', async () => {
    // As the server starts a new installation: Codex, without its key, is on the roster and in no pool.
    const config = baseConfig();
    config.agents.codex!.enabled = false;
    config.pools = { builders: { agents: ['claude'] }, reviewers: { agents: ['claude'] } };
    const setAgentKey = vi.fn().mockResolvedValue({ keys: [{ name: 'ANTHROPIC_API_KEY', configured: true, required: true }, { name: 'CODEX_API_KEY', configured: true, required: true }], refusals: [] });
    const api = fakeApi({ config: vi.fn().mockResolvedValue(view({ config, agentKeys: { ANTHROPIC_API_KEY: true, CODEX_API_KEY: false } })), setAgentKey, publishConfig: publishedOk(1) });
    configPage(api);
    const codex = await screen.findByTestId('coding-codex');
    for (const row of [codex, screen.getByTestId('review-codex')]) {
      const box = within(row).getByRole('checkbox', { name: 'Codex' });
      expect(box).toBeDisabled();
      expect(box).not.toBeChecked();
    }
    // No chips: the tooltip says what to do.
    expect(screen.queryByText('Key set')).toBeNull();
    expect(screen.queryByText('No key')).toBeNull();
    const info = within(codex).getByRole('button', { name: 'Why Codex cannot be used' });
    expect(info).toHaveAccessibleDescription('Connect Codex with your OpenAI Platform API key to use it. Click to connect.');
    expect(within(screen.getByTestId('provider-codex')).getByText('Not connected')).toBeInTheDocument();

    // The info icon opens Codex's connection, in the connected-agents step.
    await userEvent.click(info);
    const card = screen.getByTestId('provider-codex');
    await userEvent.type(within(card).getByLabelText(/OpenAI Platform API key/), 'sk-proj-abc');
    await userEvent.click(within(card).getByRole('button', { name: 'Save key' }));
    expect(setAgentKey).toHaveBeenCalledWith(55, 'CODEX_API_KEY', 'sk-proj-abc');
    // Connected, and nothing else changed: connecting never puts an agent to work (or bills it).
    await waitFor(() => expect(within(codex).getByRole('checkbox', { name: 'Codex' })).toBeEnabled());
    expect(within(card).getByText('Connected')).toBeInTheDocument();
    expect(within(codex).getByRole('checkbox', { name: 'Codex' })).not.toBeChecked();
    expect(within(screen.getByTestId('review-codex')).getByRole('checkbox', { name: 'Codex' })).not.toBeChecked();
    // Choosing it is a separate step: Codex reviews Claude's work, independently.
    await userEvent.click(within(screen.getByTestId('review-codex')).getByRole('checkbox', { name: 'Codex' }));
    await userEvent.click(within(screen.getByTestId('review-claude')).getByRole('checkbox', { name: 'Claude Code' }));
    expect(screen.getByTestId('review-summary')).toHaveTextContent(/Independent review/);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Work in acme/web' }));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const sent = sentConfig(api);
    expect(sent.pools).toEqual({ builders: { agents: ['claude'] }, reviewers: { agents: ['codex'] } });
    // The defaults never consent to self-review, and an independent reviewer needs none.
    expect(sent.workflows.implement!.review.allowSameAgent).toBe(false);
  });

  it('never changes a published review policy because a key went missing: the person adds it back or unticks it', async () => {
    // Codex builds; Claude is the only reviewer; Claude's key has been deleted since.
    const config = withRepo();
    config.pools = { builders: { agents: ['codex'] }, reviewers: { agents: ['claude'] } };
    config.workflows.implement!.review.allowSameAgent = true;
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published({ config, agentKeys: { ANTHROPIC_API_KEY: false, CODEX_API_KEY: true } })), publishConfig: publishedOk(2) });
    configPage(api);
    const claude = await screen.findByTestId('review-claude');
    const box = within(claude).getByRole('checkbox', { name: 'Claude Code' });
    expect(box).toBeChecked();
    expect(box).toBeEnabled();
    expect(within(claude).getByRole('button', { name: 'Why Claude Code cannot be used' })).toHaveAccessibleDescription(/was removed. Connect it again, or untick Claude Code/);
    // Nothing in the draft changed by itself; the bar says what the person has to decide.
    expect(screen.getByTestId('blockers')).toHaveTextContent('Add the key for Claude Code, or untick it.');

    // An unrelated edit cannot be published while the reviewer has no key.
    await userEvent.type(within(screen.getByTestId('repo-acme/web')).getByLabelText('Checks'), 'npm test');
    expect(screen.getByTestId('blockers')).toHaveTextContent('Add the key for Claude Code, or untick it.');
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();

    // Turning review off is the person's choice, and then it publishes.
    await userEvent.click(box);
    expect(screen.getByTestId('review-policy')).toHaveTextContent('No automated review: pull requests wait for a person.');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(sentConfig(api).workflows.implement!.review.enabled).toBe(false);
  });

  it('shows what an upgrade from the first console could not keep', async () => {
    configPage(fakeApi({ config: vi.fn().mockResolvedValue(published({ notices: ["acme/web ran implement and docs with different checks. It now has one list, implement's: check it before you publish."] })) }));
    expect(await screen.findByTestId('config-notices')).toHaveTextContent('acme/web ran implement and docs with different checks');
  });

  it('changes an agent model, and keeps repository extras behind its settings', async () => {
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published()), publishConfig: publishedOk(2) });
    configPage(api);
    await userEvent.click(await screen.findByText(/models and effort/));
    const claude = screen.getByTestId('model-claude');
    expect(claude).toHaveTextContent('Automatic');
    expect(within(claude).queryByLabelText('Model')).toBeNull();
    await userEvent.click(within(claude).getByRole('checkbox', { name: 'Choose the model myself' }));
    await userEvent.type(within(claude).getByLabelText('Model'), 'claude-opus-5-5');
    const web = screen.getByTestId('repo-acme/web');
    expect(within(web).queryByLabelText('Base branch')).toBeNull();
    await userEvent.click(within(web).getByRole('button', { name: 'Settings for acme/web' }));
    await userEvent.selectOptions(within(web).getByLabelText('Open pull requests as'), 'pr');
    await userEvent.click(within(web).getByRole('checkbox', { name: /Pause/ }));
    expect(web).toHaveTextContent(/paused/);
    await userEvent.click(within(web).getByRole('checkbox', { name: /Only some people/ }));
    await userEvent.clear(within(web).getByLabelText('Who can add the label here'));
    await userEvent.type(within(web).getByLabelText('Who can add the label here'), 'sam');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const sent = sentConfig(api);
    expect(sent.agents.claude).toEqual({ adapter: 'claude', model: 'claude-opus-5-5', enabled: true });
    expect(sent.repositories['acme/web']).toMatchObject({ publish: 'pr', enabled: false, allowedActors: ['sam'] });
  });

  it('turns auto-merge on only after the confirmation, and says so when publishing', async () => {
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published()), publishConfig: publishedOk(2) });
    configPage(api);
    const web = await screen.findByTestId('repo-acme/web');
    await userEvent.click(within(web).getByRole('button', { name: 'Settings for acme/web' }));
    await userEvent.click(within(web).getByRole('checkbox', { name: /Auto-merge/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /I understand/ }));
    expect(within(web).getByLabelText('Merge method')).toHaveValue('squash');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(api.publishConfig).toHaveBeenCalledWith(55, expect.objectContaining({ confirmAutoMerge: true }));
  });

  it('keeps an existing repository with CI repair off, says so, and turns it on with check filters', async () => {
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published()), publishConfig: publishedOk(2) });
    configPage(api);
    const web = await screen.findByTestId('repo-acme/web');
    await userEvent.click(within(web).getByRole('button', { name: 'Settings for acme/web' }));
    const ci = within(web).getByTestId('ci-acme/web');
    expect(within(ci).getByRole('checkbox', { name: /Fix failing CI/ })).not.toBeChecked();
    expect(ci).toHaveTextContent(/Off: a pull request the reviewer finds ready counts as done/);
    await userEvent.click(within(ci).getByRole('checkbox', { name: /Fix failing CI/ }));
    expect(ci).toHaveTextContent(/counts against the 3 revision rounds/);
    await userEvent.type(within(ci).getByLabelText('Checks to ignore'), 'preview-deploy');
    await userEvent.type(within(ci).getByLabelText('Wait for checks (minutes)'), '30');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(sentConfig(api).repositories['acme/web']?.ci).toEqual({ ignore: ['preview-deploy'], waitMinutes: 30 });
  });

  it('shows and publishes the GitHub notifications setting: quiet by default, verbose when chosen', async () => {
    const config = withRepo();
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published({ config })), publishConfig: publishedOk(2) });
    configPage(api);
    const web = await screen.findByTestId('repo-acme/web');
    await userEvent.click(within(web).getByRole('button', { name: 'Settings for acme/web' }));
    const verbose = within(web).getByRole('checkbox', { name: /separate comment for each step/ });
    expect(verbose).not.toBeChecked();
    await userEvent.click(verbose);
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(sentConfig(api).repositories['acme/web']?.notifications).toBe('verbose');
  });

  it('shows and publishes the review suggestions setting: address by default, stored as nothing; follow-up or ignore when chosen', async () => {
    const config = withRepo();
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published({ config })), publishConfig: publishedOk(2) });
    configPage(api);
    const web = await screen.findByTestId('repo-acme/web');
    await userEvent.click(within(web).getByRole('button', { name: 'Settings for acme/web' }));
    const select = within(web).getByLabelText('Review suggestions');
    expect(select).toHaveValue('address');
    await userEvent.selectOptions(select, 'follow-up');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(sentConfig(api).repositories['acme/web']?.suggestions).toBe('follow-up');
  });

  it('drops CI repair with the last review agent, keeping the repository\'s other settings, and publishes', async () => {
    const config = withRepo();
    config.repositories['acme/web'] = { ...config.repositories['acme/web']!, publish: 'pr', verify: ['npm test'], ci: { ignore: ['preview'] } };
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published({ config })), publishConfig: publishedOk(2) });
    configPage(api);
    await userEvent.click(within(await screen.findByTestId('review-claude')).getByRole('checkbox'));
    await userEvent.click(within(screen.getByTestId('review-codex')).getByRole('checkbox'));
    const web = screen.getByTestId('repo-acme/web');
    await userEvent.click(within(web).getByRole('button', { name: 'Settings for acme/web' }));
    expect(within(web).getByRole('checkbox', { name: /Fix failing CI/ })).not.toBeChecked();
    expect(within(web).getByRole('checkbox', { name: /Fix failing CI/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const sent = sentConfig(api);
    expect(sent.workflows.implement!.review.enabled).toBe(false);
    expect(sent.repositories['acme/web']).toEqual({ enabled: true, workflows: ['implement'], publish: 'pr', commentOnFailure: true, verify: ['npm test'] });
  });

  it('says which checks decide when auto-merge names required checks, and what off means with auto-merge on', async () => {
    const config = withRepo();
    config.repositories['acme/web']!.autoMerge = { method: 'squash', requiredChecks: ['test'] };
    configPage(fakeApi({ config: vi.fn().mockResolvedValue(published({ config })) }));
    const web = await screen.findByTestId('repo-acme/web');
    await userEvent.click(within(web).getByRole('button', { name: 'Settings for acme/web' }));
    const ci = within(web).getByTestId('ci-acme/web');
    expect(ci).toHaveTextContent(/auto-merge still waits for its checks before it merges, but a failing check is not repaired/);
    await userEvent.click(within(ci).getByRole('checkbox', { name: /Fix failing CI/ }));
    expect(ci).toHaveTextContent("Empty: auto-merge's required checks (test)");
  });

  it('turns CI repair off again, and an explicit off is published as off', async () => {
    const config = withRepo();
    config.repositories['acme/web']!.ci = {};
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published({ config })), publishConfig: publishedOk(2) });
    configPage(api);
    const web = await screen.findByTestId('repo-acme/web');
    await userEvent.click(within(web).getByRole('button', { name: 'Settings for acme/web' }));
    await userEvent.click(within(web).getByRole('checkbox', { name: /Fix failing CI/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(sentConfig(api).repositories['acme/web']?.ci).toBeUndefined();
  });

  it('keeps prompts and limits under Advanced, and resets an edited prompt', async () => {
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published()), publishConfig: publishedOk(2) });
    configPage(api);
    await userEvent.click(await screen.findByText(/prompts, revision rounds/));
    const prompt = screen.getByLabelText('Coding prompt');
    await userEvent.type(prompt, ' more');
    await userEvent.click(screen.getByRole('button', { name: 'Reset to the packaged prompt' }));
    expect(screen.getByLabelText('Coding prompt')).toHaveValue(PROMPTS.implement);
    await userEvent.type(screen.getByLabelText('Revision rounds per pull request'), '2');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(sentConfig(api).workflows.implement!.revise).toEqual({ enabled: true, prompt: PROMPTS.revise, maxRevisions: 2 });
  });

  it('shows a configuration with more than one label or custom pools in the full editor', async () => {
    const config = withRepo();
    config.pools.fast = { agents: ['claude'] };
    configPage(fakeApi({ config: vi.fn().mockResolvedValue(published({ config })) }));
    expect(await screen.findByRole('button', { name: 'Workflows' })).toBeInTheDocument();
    expect(screen.queryByTestId('simple-config')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Simple view' })).toBeNull();
  });
});

describe('connected agents, teams and exceptions (#193)', () => {
  it('the happy path: connect one provider, choose it to code, no review, choose a repository and label, publish; no pool, profile, YAML or model', async () => {
    // A new installation where nothing is connected yet: the server starts every agent off.
    const config = baseConfig();
    config.agents.claude!.enabled = false;
    config.agents.codex!.enabled = false;
    config.pools = { builders: { agents: [] }, reviewers: { agents: [] } };
    const setAgentKey = vi.fn().mockResolvedValue({ keys: [{ name: 'ANTHROPIC_API_KEY', configured: true, required: false }], refusals: [] });
    const api = fakeApi({ config: vi.fn().mockResolvedValue(view({ config, agentKeys: {} })), setAgentKey, publishConfig: publishedOk(1) });
    configPage(api);
    // Three steps on one page.
    expect(await screen.findByText('1 · Connect agents')).toBeInTheDocument();
    expect(screen.getByText('2 · Choose your agent team')).toBeInTheDocument();
    expect(screen.getByText('3 · Choose where work starts')).toBeInTheDocument();

    const card = screen.getByTestId('provider-claude');
    expect(card).toHaveTextContent('API key · runs bill your API billing');
    await userEvent.click(within(card).getByRole('button', { name: 'Connect Claude Code' }));
    await userEvent.type(within(card).getByLabelText(/Claude Console API key/), 'sk-ant-abc');
    await userEvent.click(within(card).getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(within(card).getByText('Connected')).toBeInTheDocument());

    await userEvent.click(within(screen.getByTestId('coding-claude')).getByRole('checkbox', { name: 'Claude Code' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Work in acme/web' }));
    expect(screen.getByTestId('blockers')).toHaveTextContent('Choose at least one review agent, or choose no automated review.');
    await userEvent.click(screen.getByRole('button', { name: 'No automated review' }));
    // The label defaults are fine; keep "updraft".
    expect(within(screen.getByTestId('effective-config')).getByTestId('effective-acme/web-updraft')).toHaveTextContent('Claude Code');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const sent = sentConfig(api);
    expect(sent.pools).toEqual({ builders: { agents: ['claude'] } });
    expect(sent.agents).toEqual({ claude: { adapter: 'claude', enabled: true }, codex: { adapter: 'codex', enabled: false } });
    expect(sent.workflows.implement!.review.enabled).toBe(false);
    expect(await screen.findByTestId('first-publish')).toHaveTextContent('add the label updraft to an issue in acme/web');
  });

  it('a new installation with one provider that codes and reviews waits for explicit consent to self-review before publishing', async () => {
    // As the server starts a new installation: nothing connected, and self-review off.
    const config = baseConfig();
    config.agents.claude!.enabled = false;
    config.agents.codex!.enabled = false;
    config.pools = { builders: { agents: [] }, reviewers: { agents: [] } };
    expect(config.workflows.implement!.review.allowSameAgent).toBe(false);
    const setAgentKey = vi.fn().mockResolvedValue({ keys: [{ name: 'ANTHROPIC_API_KEY', configured: true, required: false }], refusals: [] });
    const api = fakeApi({ config: vi.fn().mockResolvedValue(view({ config, agentKeys: {} })), setAgentKey, publishConfig: publishedOk(1) });
    configPage(api);
    const card = await screen.findByTestId('provider-claude');
    await userEvent.click(within(card).getByRole('button', { name: 'Connect Claude Code' }));
    await userEvent.type(within(card).getByLabelText(/Claude Console API key/), 'sk-ant-abc');
    await userEvent.click(within(card).getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(within(card).getByText('Connected')).toBeInTheDocument());

    await userEvent.click(within(screen.getByTestId('coding-claude')).getByRole('checkbox', { name: 'Claude Code' }));
    await userEvent.click(within(screen.getByTestId('review-claude')).getByRole('checkbox', { name: 'Claude Code' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Work in acme/web' }));
    expect(screen.getByTestId('allow-self-review')).not.toBeChecked();
    expect(screen.getByTestId('blockers')).toHaveTextContent('Claude Code would review its own work on "updraft": choose another review agent, or allow self-review.');
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(api.publishConfig).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('allow-self-review'));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const sent = sentConfig(api);
    expect(sent.pools).toEqual({ builders: { agents: ['claude'] }, reviewers: { agents: ['claude'] } });
    expect(sent.workflows.implement!.review).toMatchObject({ enabled: true, pool: 'reviewers', allowSameAgent: true });
  });

  it('labels and repository exceptions in the main page: art -> Codex, ready inherits; changing the default shows who it affects; reset restores it', async () => {
    const config = withRepo();
    config.repositories['acme/api'] = { ...config.repositories['acme/web']! };
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published({ config })), publishConfig: publishedOk(2) });
    configPage(api);
    await userEvent.type(await screen.findByLabelText('Add a label'), 'art');
    await userEvent.click(screen.getByRole('button', { name: 'Add label' }));
    const art = screen.getByTestId('label-art');
    await userEvent.selectOptions(within(art).getByLabelText('Agents for "art"'), 'custom');
    await userEvent.click(within(art).getByTestId('label-art-coding-claude').querySelector('input')!);
    expect(within(art).getByTestId('label-art-team')).toHaveTextContent('Coding: Codex · Review: Claude Code, Codex · its own agents');

    // acme/api's "updraft" gets Claude alone; acme/web keeps the defaults.
    const apiRow = screen.getByTestId('repo-acme/api');
    await userEvent.click(within(apiRow).getByRole('button', { name: 'Customize agents for "updraft" in acme/api' }));
    await userEvent.click(within(apiRow).getByTestId('repo-acme/api-implement-coding-codex').querySelector('input')!);
    expect(screen.getByTestId('effective-acme/api-updraft')).toHaveTextContent('Claude CodeClaude Code, CodexThis repository only');

    // The default team says what it changes, and what it does not.
    expect(screen.getByTestId('affects-coding')).toHaveTextContent('Used by "updraft" in acme/web.');
    expect(screen.getByTestId('affects-coding')).toHaveTextContent('Not changed: "art" in acme/web, "updraft" in acme/api, "art" in acme/api (own agents).');
    await userEvent.click(within(screen.getByTestId('coding-codex')).getByRole('checkbox'));
    expect(screen.getByTestId('effective-acme/web-art')).toHaveTextContent('Codex');
    expect(screen.getByTestId('pending-changes')).toHaveTextContent('acme/web · updraft: coding Claude Code, Codex → Claude Code.');

    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const sent = sentConfig(api);
    expect(sent.pools).toEqual({
      builders: { agents: ['claude'] },
      reviewers: { agents: ['claude', 'codex'] },
      'art-coding': { agents: ['codex'] },
      'art-review': { agents: ['claude', 'codex'] },
      'implement-api-coding': { agents: ['claude'] },
      'implement-api-review': { agents: ['claude', 'codex'] },
    });
    expect(sent.workflows.art).toMatchObject({ label: 'art', pool: 'art-coding', review: { pool: 'art-review' } });
    expect(sent.repositories['acme/web']!.workflows).toEqual(['implement', 'art']);
    expect(sent.repositories['acme/api']!.workflows).toEqual(['implement-api', 'art']);

    // Reset both: the label and the repository use the defaults again.
    await userEvent.click(within(screen.getByTestId('label-art')).getByRole('button', { name: 'Reset to defaults' }));
    await userEvent.click(within(screen.getByTestId('repo-acme/api')).getByRole('button', { name: 'Use the agents of "updraft" in acme/api' }));
    expect(screen.getByTestId('effective-acme/api-updraft')).toHaveTextContent('Installation defaults');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const reset = sentConfig(api, 1);
    expect(reset.pools).toEqual({ builders: { agents: ['claude'] }, reviewers: { agents: ['claude', 'codex'] } });
    expect(reset.repositories['acme/api']!.workflows).toEqual(['implement', 'art']);
  });

  it('a no-op load and preview sends simple and advanced settings exactly as loaded, and offers no publish', async () => {
    const advanced = beyondSimple();
    advanced.agents['claude-2'] = { adapter: 'claude', model: 'claude-haiku-5-5', effort: 'low', enabled: true };
    advanced.pools.fast = { agents: ['claude-2'] };
    advanced.workflows.implement!.timeoutMinutes = 30;
    advanced.repositories['acme/web'] = { ...advanced.repositories['acme/web']!, allowedActors: ['sam'], autoMerge: { method: 'squash' }, ci: {}, baseBranch: 'dev' };
    advanced.legacy = { pools: { implement: 'builders' }, workflows: { implement: 'implement' } };
    for (const config of [withRepo(), advanced]) {
      const previewConfig = vi.fn().mockResolvedValue({ ok: true, yaml: 'version: 1\n', warnings: [], autoMergeTurnedOn: [] });
      const api = fakeApi({ config: vi.fn().mockResolvedValue(published({ config: clone(config) })), previewConfig });
      const { unmount } = configPage(api);
      await userEvent.click(await screen.findByRole('button', { name: 'View config' }));
      expect(previewConfig).toHaveBeenCalledWith(55, config);
      expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
      expect(screen.queryByTestId('pending-changes')).toBeNull();
      unmount();
    }
  });

  it('settings the page cannot show stay in the full editor, unconverted, with a readable summary and the custom settings named', async () => {
    const config = beyondSimple();
    config.agents['claude-2'] = { adapter: 'claude', model: 'claude-haiku-5-5', enabled: true };
    config.pools.fast = { agents: ['claude-2'] };
    config.workflows.implement!.pool = 'fast';
    configPage(fakeApi({ config: vi.fn().mockResolvedValue(published({ config })) }));
    expect(await screen.findByTestId('config-custom')).toHaveTextContent('Agent profile "claude-2" (Claude Code) has a name of its own');
    expect(screen.getByTestId('effective-acme/web-updraft')).toHaveTextContent('Claude Code');
    expect(screen.queryByTestId('simple-config')).toBeNull();
    expect(screen.getByRole('button', { name: 'Workflows' })).toBeInTheDocument();
  });

  it('explains a key whose last use failed without removing the agent, weakening review or switching billing', async () => {
    const api = fakeApi({
      config: vi.fn().mockResolvedValue(published()),
      agentKeys: vi.fn().mockResolvedValue({ keys: [{ name: 'ANTHROPIC_API_KEY', configured: true, required: true, lastUsed: { at: '2026-11-20T00:00:00Z', ok: false } }, { name: 'CODEX_API_KEY', configured: true, required: true }], refusals: [] }),
      publishConfig: publishedOk(2),
    });
    configPage(api);
    const card = await screen.findByTestId('provider-claude');
    await waitFor(() => expect(within(card).getByText('Last use failed')).toBeInTheDocument());
    expect(within(card).getByRole('button', { name: 'Reconnect Claude Code' })).toBeInTheDocument();
    const box = within(screen.getByTestId('coding-claude')).getByRole('checkbox', { name: 'Claude Code' });
    expect(box).toBeChecked();
    expect(screen.getByTestId('coding-claude')).toHaveTextContent('its last run could not use the key: reconnect it');
    expect(within(screen.getByTestId('review-claude')).getByRole('checkbox', { name: 'Claude Code' })).toBeChecked();
    expect(screen.getByTestId('review-summary')).toHaveTextContent(/Independent review/);
    // A Claude subscription is a separate route, never a silent fallback here.
    expect(within(card).getByRole('link', { name: 'Claude subscription routing' })).toHaveAttribute('href', '/installations/55/claude');
  });

  it('shows a provider this deployment no longer runs honestly, and keeps the settings that name it', async () => {
    const config = withRepo();
    config.agents.vibe = { adapter: 'vibe', enabled: false };
    configPage(fakeApi({ config: vi.fn().mockResolvedValue(published({ config })) }));
    const card = await screen.findByTestId('provider-vibe');
    expect(card).toHaveTextContent('Not available here');
    expect(within(card).queryByRole('button')).toBeNull();
    expect(within(screen.getByTestId('coding-vibe')).getByRole('checkbox')).toBeDisabled();
  });
});

/** From the simple page to the full editor. */
async function openFull() {
  await userEvent.click(await screen.findByText(/prompts, revision rounds/));
  await userEvent.click(screen.getByRole('button', { name: 'Open the full editor' }));
}

describe('the full editor', () => {
  it('turns a repository on with the first workflow, and publishes from the active version', async () => {
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published()), publishConfig: publishedOk(2) });
    configPage(api);
    await openFull();
    const publish = await screen.findByRole('button', { name: 'Publish' });
    // Nothing changed since version 1.
    expect(publish).toBeDisabled();
    await userEvent.click(within(screen.getByTestId('repo-acme/api')).getByRole('checkbox', { name: 'Work in acme/api' }));
    expect(screen.getByTestId('draft-state')).toHaveTextContent('Unsaved changes');
    const api_ = screen.getByTestId('repo-acme/api');
    await userEvent.type(within(api_).getByLabelText('Verify commands'), 'npm test');
    await userEvent.click(publish);
    expect(api.publishConfig).toHaveBeenCalledWith(55, { config: expect.any(Object), baseVersion: 1 });
    expect(sentConfig(api).repositories['acme/api']).toEqual({ enabled: true, workflows: ['implement'], publish: 'draft-pr', commentOnFailure: true, verify: ['npm test'], ci: {} });
    expect(await screen.findByTestId('config-published')).toHaveTextContent('Published version 2');
    expect(screen.getByTestId('draft-state')).toHaveTextContent('Version 2 is active');
  });

  it('pauses a repository, and gives it its own allowed actors', async () => {
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published()), publishConfig: publishedOk(2) });
    configPage(api);
    await openFull();
    const web = await screen.findByTestId('repo-acme/web');
    await userEvent.click(within(web).getByRole('button', { name: 'Pause' }));
    expect(web).toHaveTextContent('Paused');
    await userEvent.click(within(web).getByRole('checkbox', { name: /different list of people/ }));
    const actors = within(web).getByLabelText('Allowed actors in this repository');
    expect(actors).toHaveValue('pat');
    await userEvent.clear(actors);
    await userEvent.type(actors, 'sam, @lee');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(sentConfig(api).repositories['acme/web']).toMatchObject({ enabled: false, allowedActors: ['sam', 'lee'] });
  });

  it('chooses the pools a workflow builds and reviews with, and turns review off', async () => {
    const config = withRepo();
    config.pools.fast = { agents: ['claude'] };
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published({ config })), publishConfig: publishedOk(2) });
    configPage(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Workflows' }));
    const wf = screen.getByTestId('workflow-implement');
    expect(wf).toHaveTextContent('Runs in acme/web');
    await userEvent.selectOptions(within(wf).getByLabelText('Built by'), 'fast');
    await userEvent.click(within(wf).getByTestId('review-implement'));
    expect(within(wf).queryByLabelText('Reviewed by')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(sentConfig(api).workflows.implement).toMatchObject({ pool: 'fast', review: { enabled: false, pool: 'reviewers' } });
  });

  it('says when an agent could only review its own work', async () => {
    const config = withRepo();
    config.pools = { builders: { agents: ['claude'] }, reviewers: { agents: ['claude'] } };
    configPage(fakeApi({ config: vi.fn().mockResolvedValue(published({ config })) }));
    await openFull();
    await userEvent.click(await screen.findByRole('button', { name: 'Workflows' }));
    expect(screen.getByText(/would only ever review its own work/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: /review its own work when no other/ }));
    expect(screen.queryByText(/would only ever review its own work/)).toBeNull();
  });

  it('adds an agent to no pool, edits pool members, and takes a missing key in place', async () => {
    const setAgentKey = vi.fn().mockResolvedValue({ keys: [{ name: 'ANTHROPIC_API_KEY', configured: true, required: true }, { name: 'CODEX_API_KEY', configured: true, required: true }], refusals: [] });
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published({ config: beyondSimple(), agentKeys: { ANTHROPIC_API_KEY: true, CODEX_API_KEY: false } })), setAgentKey, publishConfig: publishedOk(2) });
    configPage(api);
    expect(await screen.findByTestId('config-missing-keys')).toHaveTextContent('codex (Codex) needs a key before you publish');
    await userEvent.click(screen.getByRole('button', { name: 'Go to agents' }));

    await userEvent.selectOptions(screen.getByLabelText('Add an agent'), 'claude');
    await userEvent.click(screen.getByRole('button', { name: 'Add agent' }));
    const second = screen.getByTestId('agent-claude-2');
    await userEvent.type(within(second).getByLabelText('Model'), 'claude-haiku-5-5');
    // Adding a profile changes no one's work until it is ticked into a pool.
    expect(within(screen.getByTestId('pool-builders')).getByRole('checkbox', { name: 'claude-2' })).not.toBeChecked();
    expect(within(screen.getByTestId('pool-fast')).getByRole('checkbox', { name: 'claude-2' })).not.toBeChecked();
    await userEvent.click(within(screen.getByTestId('pool-builders')).getByRole('checkbox', { name: 'claude-2' }));
    await userEvent.click(within(screen.getByTestId('pool-fast')).getByRole('checkbox', { name: 'claude-2' }));

    const codex = screen.getByTestId('agent-codex');
    await userEvent.type(within(codex).getByLabelText(/OpenAI Platform API key/), 'sk-proj-abc');
    await userEvent.click(within(codex).getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(screen.queryByTestId('config-missing-keys')).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const sent = sentConfig(api);
    expect(sent.agents['claude-2']).toEqual({ adapter: 'claude', model: 'claude-haiku-5-5', enabled: true });
    expect(sent.pools).toEqual({ builders: { agents: ['claude', 'codex', 'claude-2'] }, reviewers: { agents: ['claude', 'codex'] }, fast: { agents: ['claude', 'claude-2'] } });
  });

  it('turns an agent off instead of adding its key', async () => {
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published({ config: beyondSimple(), agentKeys: { ANTHROPIC_API_KEY: true, CODEX_API_KEY: false } })) });
    configPage(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Go to agents' }));
    await userEvent.click(within(screen.getByTestId('agent-codex')).getByRole('checkbox', { name: 'On' }));
    expect(screen.queryByTestId('config-missing-keys')).toBeNull();
    expect(within(screen.getByTestId('agent-codex')).queryByTestId('inline-key-codex')).toBeNull();
  });

  it('offers Kiro in the add-agent list', async () => {
    configPage(fakeApi({ config: vi.fn().mockResolvedValue(published({ config: beyondSimple(), agents: ['claude', 'codex', 'kiro'] })) }));
    await userEvent.click(await screen.findByRole('button', { name: 'Agents and pools' }));
    expect(within(screen.getByLabelText('Add an agent')).getByRole('option', { name: 'Kiro' })).toBeInTheDocument();
    expect(screen.queryByTestId('kiro-not-enabled')).toBeNull();
  });

  it('refreshes key status when the tab regains focus without touching the draft', async () => {
    const config = vi.fn().mockResolvedValue(published({ config: beyondSimple(), agentKeys: { ANTHROPIC_API_KEY: false, CODEX_API_KEY: true } }));
    configPage(fakeApi({ config }));
    expect(await screen.findByTestId('config-missing-keys')).toBeInTheDocument();
    await userEvent.click(within(screen.getByTestId('repo-acme/api')).getByRole('checkbox', { name: 'Work in acme/api' }));
    config.mockResolvedValue(published({ config: beyondSimple(), agentKeys: { ANTHROPIC_API_KEY: true, CODEX_API_KEY: true } }));
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(screen.queryByTestId('config-missing-keys')).toBeNull());
    expect(within(screen.getByTestId('repo-acme/api')).getByRole('checkbox', { name: 'Work in acme/api' })).toBeChecked();
  });

  it('turns auto-merge on only after the confirmation, and says so when publishing', async () => {
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published()), publishConfig: publishedOk(2) });
    configPage(api);
    await openFull();
    const web = await screen.findByTestId('repo-acme/web');
    await userEvent.click(within(web).getByRole('checkbox', { name: /Auto-merge/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /I understand/ }));
    expect(within(web).getByLabelText('Merge method')).toHaveValue('squash');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(api.publishConfig).toHaveBeenCalledWith(55, expect.objectContaining({ confirmAutoMerge: true }));
  });

  it('drops CI repair when the workflow stops reviewing, and publishes the rest unchanged', async () => {
    const config = withRepo();
    config.repositories['acme/web'] = { ...config.repositories['acme/web']!, verify: ['npm test'], baseBranch: 'dev', ci: { waitMinutes: 30 } };
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published({ config })), publishConfig: publishedOk(2) });
    configPage(api);
    await openFull();
    await userEvent.click(await screen.findByRole('button', { name: 'Workflows' }));
    await userEvent.click(within(screen.getByTestId('workflow-implement')).getByTestId('review-implement'));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const sent = sentConfig(api);
    expect(sent.workflows.implement!.review.enabled).toBe(false);
    expect(sent.repositories['acme/web']).toEqual({ enabled: true, workflows: ['implement'], publish: 'draft-pr', commentOnFailure: true, verify: ['npm test'], baseBranch: 'dev' });
  });

  it('lets CI repair be turned off where nothing reviews any more', async () => {
    const config = withRepo();
    config.workflows.implement!.review.enabled = false;
    config.repositories['acme/web']!.ci = {};
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published({ config })), publishConfig: publishedOk(2) });
    configPage(api);
    await openFull();
    const toggle = within(await screen.findByTestId('repo-acme/web')).getByRole('checkbox', { name: /Fix failing CI/ });
    expect(toggle).toBeEnabled();
    await userEvent.click(toggle);
    expect(toggle).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(sentConfig(api).repositories['acme/web']?.ci).toBeUndefined();
  });

  it('offers no auto-merge where no workflow reviews', async () => {
    const config = withRepo();
    config.workflows.implement!.review.enabled = false;
    configPage(fakeApi({ config: vi.fn().mockResolvedValue(published({ config })) }));
    await openFull();
    const web = await screen.findByTestId('repo-acme/web');
    expect(within(web).getByRole('checkbox', { name: /Auto-merge/ })).toBeDisabled();
    expect(within(web).getByRole('checkbox', { name: /Fix failing CI/ })).toBeDisabled();
  });

  it('asks again when the server wants the auto-merge confirmation, and resends with it', async () => {
    const publishConfig = vi.fn().mockRejectedValueOnce(new ApiError(409, 'auto_merge_unconfirmed', 'Confirm turning on auto-merge for acme/web')).mockResolvedValueOnce({ ok: true, version: 2, yaml: '', warnings: [] });
    const config = withRepo();
    config.repositories['acme/web']!.autoMerge = { method: 'squash' };
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published({ config })), publishConfig });
    configPage(api);
    await openFull();
    await userEvent.click(within(await screen.findByTestId('repo-acme/web')).getByRole('button', { name: 'Pause' }));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Confirm turning on auto-merge for acme/web');
    await userEvent.click(within(dialog).getByRole('button', { name: /I understand/ }));
    await waitFor(() => expect(publishConfig).toHaveBeenLastCalledWith(55, expect.objectContaining({ confirmAutoMerge: true })));
  });

  it('checks the draft and shows the generated YAML, and hides it again', async () => {
    const previewConfig = vi.fn().mockResolvedValue({ ok: true, yaml: 'version: 1\nexecution:\n  mode: live\n', warnings: [], autoMergeTurnedOn: [] });
    configPage(fakeApi({ config: vi.fn().mockResolvedValue(published()), previewConfig }));
    await openFull();
    await userEvent.click(await screen.findByRole('button', { name: 'View config' }));
    expect(await screen.findByTestId('config-yaml')).toHaveTextContent('mode: live');
    await userEvent.click(screen.getByRole('button', { name: 'Hide config' }));
    expect(screen.queryByTestId('config-yaml')).toBeNull();
  });

  it('lists every problem of a refused publish, opens the section of the first, and shows each at its field', async () => {
    const publishConfig = vi.fn().mockRejectedValue(
      new ConfigInvalidError(
        [
          { path: 'agents.codex.model', message: 'not a model codex knows' },
          { path: 'repositories.acme/web.verify.0', message: 'a command must not be empty' },
        ],
        [],
      ),
    );
    configPage(fakeApi({ config: vi.fn().mockResolvedValue(published()), publishConfig }));
    await openFull();
    await userEvent.click(within(await screen.findByTestId('repo-acme/web')).getByRole('button', { name: 'Pause' }));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const list = await screen.findByTestId('config-errors');
    expect(list).toHaveTextContent('agents.codex.model: not a model codex knows');
    expect(screen.getByRole('button', { name: 'Agents and pools (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Repositories (1)' })).toBeInTheDocument();
    expect(within(screen.getByTestId('agent-codex')).getByText('not a model codex knows')).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button', { name: 'Repositories' }));
    expect(within(screen.getByTestId('repo-acme/web')).getByText('a command must not be empty')).toBeInTheDocument();
  });

  it('says when someone else published meanwhile, and reloads', async () => {
    const config = vi.fn().mockResolvedValue(published());
    const publishConfig = vi.fn().mockRejectedValue(new ApiError(409, 'config_changed', 'Version 2 was published since you started editing'));
    configPage(fakeApi({ config, publishConfig }));
    await openFull();
    await userEvent.click(within(await screen.findByTestId('repo-acme/web')).getByRole('button', { name: 'Pause' }));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByTestId('config-conflict')).toHaveTextContent('Version 2 was published');
    config.mockResolvedValue(published({ activeVersion: 2 }));
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.getByTestId('active-version')).toHaveTextContent('version 2 is active'));
    expect(screen.queryByTestId('config-conflict')).toBeNull();
  });

  it('warns about a version tenant-admin published; a disabled tenant is read-only', async () => {
    configPage(fakeApi({ config: vi.fn().mockResolvedValue(view({ source: 'tenant', activeVersion: 3, tenant: { ...view().tenant, status: 'disabled' } })) }));
    expect(await screen.findByTestId('config-tenant-source')).toHaveTextContent('Version 3 was published with tenant-admin');
    expect(screen.getByTestId('config-tenant-source')).toHaveTextContent('Publishing from here replaces that config, including its tiers and anything else the console can\'t show.');
    expect(screen.getByTestId('config-readonly')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('adds a workflow with the packaged prompts on a label of its own, and resets an edited prompt', async () => {
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published()), publishConfig: publishedOk(2) });
    configPage(api);
    await openFull();
    await userEvent.click(await screen.findByRole('button', { name: 'Workflows' }));
    await userEvent.type(screen.getByLabelText('New workflow name'), 'Docs!');
    await userEvent.click(screen.getByRole('button', { name: 'Add workflow' }));
    expect(screen.getByText(/Lower-case letters/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('New workflow name'));
    await userEvent.type(screen.getByLabelText('New workflow name'), 'docs');
    await userEvent.click(screen.getByRole('button', { name: 'Add workflow' }));
    const docs = screen.getByTestId('workflow-docs');
    expect(within(docs).getByLabelText('Label')).toHaveValue('updraft:docs');
    expect(within(docs).getByLabelText('Built by')).toHaveValue('builders');
    expect(within(docs).getByLabelText('Reviewed by')).toHaveValue('reviewers');
    const prompt = within(docs).getByLabelText('Build prompt');
    expect(prompt).toHaveValue(PROMPTS.implement);
    await userEvent.type(prompt, ' more');
    await userEvent.click(within(docs).getByRole('button', { name: 'Reset to the packaged prompt' }));
    expect(within(docs).getByLabelText('Build prompt')).toHaveValue(PROMPTS.implement);
  });
});

describe('ConfigHistoryPage', () => {
  const versions: VersionSummary[] = [
    { version: 3, status: 'ready', publishedAt: '2026-11-20T12:00:00.000Z', publishedBy: 'pat', sha256: 'c', active: true, copiedFrom: 1 },
    { version: 2, status: 'ready', publishedAt: '2026-11-20T11:00:00.000Z', publishedBy: 'sam', sha256: 'b', active: false },
    { version: 1, status: 'ready', publishedAt: '2026-11-20T10:00:00.000Z', publishedBy: 'pat', sha256: 'a', active: false },
  ];
  const files: Record<number, Record<string, string>> = {
    1: { 'config.yaml': 'label: ready\n', 'prompts/implement.md': '# Implement' },
    2: { 'config.yaml': 'label: updraft\n', 'prompts/implement.md': '# Implement' },
  };
  const history = (api: ReturnType<typeof fakeApi>) => at('/installations/55/config/history', <ConfigHistoryPage api={api} />, '/installations/:id/config/history');

  it('lists who published each version and when, and shows what changed from the one before', async () => {
    const api = fakeApi({
      configVersions: vi.fn().mockResolvedValue({ activeVersion: 3, versions }),
      configVersion: vi.fn().mockImplementation(async (_: number, v: number) => ({ version: versions.find((x) => x.version === v), files: files[v] })),
    });
    history(api);
    const v3 = await screen.findByTestId('version-3');
    expect(v3).toHaveTextContent('Active');
    expect(v3).toHaveTextContent('Copy of v1');
    expect(screen.getByTestId('version-2')).toHaveTextContent('sam');
    expect(within(v3).queryByRole('button', { name: /Re-activate/ })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Changes in version 2' }));
    const diff = await screen.findByTestId('version-diff');
    expect(api.configVersion).toHaveBeenCalledWith(55, 2);
    expect(api.configVersion).toHaveBeenCalledWith(55, 1);
    expect(diff).toHaveTextContent('Compared with version 1');
    expect(diff).toHaveTextContent('- label: ready');
    expect(diff).toHaveTextContent('+ label: updraft');
    expect(diff).not.toHaveTextContent('prompts/implement.md');
  });

  it('re-activates a version only after the confirmation, asking again for auto-merge', async () => {
    const api = fakeApi({
      configVersions: vi.fn().mockResolvedValue({ activeVersion: 3, versions }),
      reactivateConfig: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(409, 'auto_merge_unconfirmed', 'Confirm turning on auto-merge for acme/web'))
        .mockResolvedValueOnce({ ok: true, version: 4, yaml: '', warnings: [] }),
    });
    history(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Re-activate version 1' }));
    let dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('publishes a copy of version 1 as a new version');
    expect(api.reactivateConfig).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Re-activate' }));
    await waitFor(() => expect(api.reactivateConfig).toHaveBeenCalledWith(55, 1, {}));
    dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('reactivate-auto-merge')).toHaveTextContent('acme/web');
    await userEvent.click(within(dialog).getByRole('button', { name: /I understand/ }));
    await waitFor(() => expect(api.reactivateConfig).toHaveBeenLastCalledWith(55, 1, { confirmAutoMerge: true }));
    expect(await screen.findByTestId('history-notice')).toHaveTextContent('as version 4');
    expect(api.configVersions).toHaveBeenCalledTimes(2);
  });
});

/*
 * #193, against the server: the settings below are fixtures/console-samples.json, which the server's
 * tests compile, publish, load and publish again (config-service.test.ts). What the page sends is
 * asserted equal to them, so a no-op load, preview or save compiles to the same bundle.
 */
const SAMPLES = fixture.samples as unknown as Record<string, ConsoleConfig>;
const TWO_PROVIDERS = fixture.twoProviders as unknown as { start: ConsoleConfig; published: ConsoleConfig };
const keyView = (keys: AgentKeyView[]) => ({ keys, refusals: [] });
const key = (name: string, over: Partial<AgentKeyView> = {}): AgentKeyView => ({ name, configured: true, required: false, ...over });
const okPreview = () => vi.fn().mockResolvedValue({ ok: true, yaml: 'version: 1\n', warnings: [], autoMergeTurnedOn: [] });
const previewed = (api: ReturnType<typeof fakeApi>, call = 0) => (api.previewConfig as ReturnType<typeof vi.fn>).mock.calls[call]![1] as ConsoleConfig;
/** Connects a provider from its card, as a person does: Connect, the key, Save key. */
async function connect(adapter: string, name: string, value: string) {
  const card = screen.getByTestId(`provider-${adapter}`);
  await userEvent.click(within(card).getByRole('button', { name: `Connect ${name}` }));
  await userEvent.type(within(card).getByLabelText(/API key/), value);
  await userEvent.click(within(card).getByRole('button', { name: 'Save key' }));
}

describe('the page and the compiled config agree (#193)', () => {
  it.each(Object.keys(SAMPLES))('%s: a no-op load and preview sends the settings byte for byte as loaded; saving an unrelated edit sends everything else unchanged', async (name) => {
    const sample = SAMPLES[name]!;
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published({ config: clone(sample) })), previewConfig: okPreview(), publishConfig: publishedOk(2) });
    configPage(api);
    await userEvent.click(await screen.findByRole('button', { name: 'View config' }));
    expect(JSON.stringify(previewed(api))).toBe(JSON.stringify(sample));
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(screen.queryByTestId('pending-changes')).toBeNull();
    // Only the advanced sample needs the full editor; its custom settings are named, not converted.
    expect(screen.queryByTestId('simple-config') !== null).toBe(name !== 'advanced');
    expect(screen.queryByTestId('config-custom') !== null).toBe(name === 'advanced');

    // One more person who can start work, in whichever view is open: nothing else in the settings moves.
    const actors = screen.getByLabelText(name === 'advanced' ? 'Allowed actors' : 'Who can add a label');
    await userEvent.type(actors, ' lee');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(JSON.stringify(sentConfig(api))).toBe(JSON.stringify({ ...sample, allowedActors: [...sample.allowedActors, 'lee'] }));
    await userEvent.click(screen.getByRole('button', { name: 'Hide config' }));
    await userEvent.click(screen.getByRole('button', { name: 'View config' }));
    expect(JSON.stringify(previewed(api, 1))).toBe(JSON.stringify(sentConfig(api)));
  });

  it('shows explicit models and efforts as Manual, never as Automatic, and keeps them through a save', async () => {
    const sample = SAMPLES.labels!;
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published({ config: clone(sample) })), publishConfig: publishedOk(2) });
    configPage(api);
    await userEvent.click(await screen.findByText(/models and effort/));
    expect(screen.getByTestId('model-claude')).toHaveTextContent('Manual: claude-opus-5-5 (high)');
    expect(screen.getByTestId('model-codex')).toHaveTextContent('Manual (medium)');
    expect(within(screen.getByTestId('model-claude')).getByLabelText('Model')).toHaveValue('claude-opus-5-5');
    await userEvent.type(screen.getByLabelText('Who can add a label'), ' lee');
    expect(screen.queryByText('Model or effort settings changed.')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(sentConfig(api).agents).toEqual(sample.agents);
  });

  it('a manual model or effort the server refuses is shown at its field under Advanced, and nothing is published until it is fixed', async () => {
    // The server's own messages for these values (config-service.test.ts, "manual models and efforts").
    const refused = new ConfigInvalidError(
      [
        { path: 'agents.claude.model', message: 'a model name: letters, digits, ".", "_", ":", "/" or "-"' },
        { path: 'agents.claude.effort', message: 'an effort level, such as low, medium or high' },
      ],
      [],
    );
    const publishConfig = vi.fn().mockRejectedValueOnce(refused).mockResolvedValueOnce({ ok: true, version: 2, yaml: 'version: 1\n', warnings: [] });
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published()), publishConfig });
    configPage(api);
    await userEvent.click(await screen.findByText(/models and effort/));
    const claude = screen.getByTestId('model-claude');
    await userEvent.click(within(claude).getByRole('checkbox', { name: 'Choose the model myself' }));
    await userEvent.type(within(claude).getByLabelText('Model'), 'claude opus');
    await userEvent.type(within(claude).getByLabelText('Reasoning effort'), 'very high');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

    expect(await screen.findByTestId('config-errors')).toHaveTextContent('Nothing was published');
    expect(screen.queryByTestId('config-published')).toBeNull();
    expect(screen.getByTestId('active-version')).toHaveTextContent('version 1 is active');
    expect(screen.getByTestId('advanced')).toHaveAttribute('open');
    const model = within(claude).getByLabelText('Model');
    expect(model).toBeInvalid();
    expect(model).toHaveAccessibleDescription(expect.stringContaining('a model name: letters, digits'));
    expect(within(claude).getByLabelText('Reasoning effort')).toHaveAccessibleDescription(expect.stringContaining('an effort level, such as low, medium or high'));

    await userEvent.clear(model);
    await userEvent.type(model, 'claude-opus-5-5');
    await userEvent.clear(within(claude).getByLabelText('Reasoning effort'));
    await userEvent.type(within(claude).getByLabelText('Reasoning effort'), 'high');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByTestId('config-published')).toHaveTextContent('Published version 2');
    expect(sentConfig(api, 1).agents.claude).toEqual({ adapter: 'claude', model: 'claude-opus-5-5', effort: 'high', enabled: true });
  });

  it('offers Connect ChatGPT on the Codex card only where the deployment supports it, and Claude\'s link is unchanged', async () => {
    const twoAgents = () => view({ config: clone(TWO_PROVIDERS.start), agents: ['claude', 'codex', 'kiro'], agentKeys: { KIRO_API_KEY: true } });
    const base = { configured: true, enabled: true, worker: null };
    const chatgpt = () => screen.queryByRole('link', { name: 'Connect ChatGPT account →' });
    const available = fakeApi({ config: vi.fn().mockResolvedValue(twoAgents()), nativeClaude: async () => ({ ...base, codexAvailable: true }),
      nativeCodex: async () => ({ ...base, worker: { status: 'auth-required', online: true, busy: false, lastHeartbeatAt: '2026-11-26T10:00:00Z', workerVersion: 'v1' } }) });
    const first = configPage(available);
    const codex = await screen.findByTestId('provider-codex');
    const link = await within(codex).findByRole('link', { name: 'Connect ChatGPT account →' });
    expect(link).toHaveAttribute('href', '/installations/55/codex');
    expect(codex).toHaveTextContent('Codex can run on a ChatGPT plan instead of an API key');
    await waitFor(() => expect(codex).toHaveTextContent('Needs sign-in'));
    expect(within(screen.getByTestId('provider-claude')).getByRole('link', { name: 'Claude subscription routing' })).toHaveAttribute('href', '/installations/55/claude');
    expect(within(screen.getByTestId('provider-claude')).queryByRole('link', { name: /ChatGPT/ })).toBeNull();
    first.unmount();
    for (const nativeClaude of [async () => ({ ...base, codexAvailable: false }), async () => base, async () => { throw new Error('down'); }]) {
      const { unmount } = configPage(fakeApi({ config: vi.fn().mockResolvedValue(twoAgents()), nativeClaude }));
      await screen.findByTestId('provider-codex');
      await waitFor(() => expect(chatgpt()).toBeNull());
      expect(within(screen.getByTestId('provider-claude')).getByRole('link', { name: 'Claude subscription routing' })).toHaveAttribute('href', '/installations/55/claude');
      unmount();
    }
  });

  it('two providers: connect Claude Code and Codex, choose both to code and Kiro to review, and publish what the server compiles', async () => {
    const setAgentKey = vi
      .fn()
      .mockResolvedValueOnce(keyView([key('ANTHROPIC_API_KEY'), key('CODEX_API_KEY', { configured: false }), key('KIRO_API_KEY')]))
      .mockResolvedValueOnce(keyView([key('ANTHROPIC_API_KEY'), key('CODEX_API_KEY'), key('KIRO_API_KEY')]));
    const api = fakeApi({
      config: vi.fn().mockResolvedValue(view({ config: clone(TWO_PROVIDERS.start), agents: ['claude', 'codex', 'kiro'], agentKeys: { KIRO_API_KEY: true } })),
      setAgentKey,
      previewConfig: okPreview(),
      publishConfig: publishedOk(1),
    });
    configPage(api);
    expect(await screen.findByTestId('provider-kiro')).toHaveTextContent('Saved, checked on first use');
    await connect('claude', 'Claude Code', 'sk-ant-abc');
    await waitFor(() => expect(within(screen.getByTestId('provider-claude')).getByText('Connected')).toBeInTheDocument());
    await connect('codex', 'Codex', 'sk-proj-abc');
    await waitFor(() => expect(within(screen.getByTestId('provider-codex')).getByText('Connected')).toBeInTheDocument());

    // Connected, and nothing chosen yet: the draft is still exactly what the server started from.
    await userEvent.click(screen.getByRole('button', { name: 'View config' }));
    expect(JSON.stringify(previewed(api))).toBe(JSON.stringify(TWO_PROVIDERS.start));

    await userEvent.click(within(screen.getByTestId('coding-claude')).getByRole('checkbox', { name: 'Claude Code' }));
    await userEvent.click(within(screen.getByTestId('coding-codex')).getByRole('checkbox', { name: 'Codex' }));
    await userEvent.click(within(screen.getByTestId('coding-kiro')).getByRole('checkbox', { name: 'Kiro' }));
    expect(within(screen.getByTestId('review-kiro')).getByRole('checkbox', { name: 'Kiro' })).toBeChecked();
    expect(screen.getByTestId('review-summary')).toHaveTextContent(/Independent review/);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Work in acme/web' }));
    const row = screen.getByTestId('effective-acme/web-updraft');
    expect(row).toHaveTextContent('Claude Code, Codex');
    expect(row).toHaveTextContent('Kiro');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    // The server compiles exactly these settings to builders [claude, codex], reviewers [kiro].
    expect(JSON.stringify(sentConfig(api))).toBe(JSON.stringify(TWO_PROVIDERS.published));
  });

  it('connecting a provider on its own changes nothing that would be compiled or published', async () => {
    const sample = SAMPLES.simple!;
    const setAgentKey = vi.fn().mockResolvedValue(keyView([key('ANTHROPIC_API_KEY'), key('CODEX_API_KEY'), key('KIRO_API_KEY')]));
    const api = fakeApi({
      config: vi.fn().mockResolvedValue(published({ config: clone(sample), agents: ['claude', 'codex', 'kiro'], agentKeys: { ANTHROPIC_API_KEY: true, CODEX_API_KEY: true, KIRO_API_KEY: false } })),
      setAgentKey,
      previewConfig: okPreview(),
    });
    configPage(api);
    await screen.findByTestId('provider-kiro');
    await connect('kiro', 'Kiro', 'ksk_abcdefghijklmnopqrstuvwxyz0123456789');
    await waitFor(() => expect(screen.getByTestId('provider-kiro')).toHaveTextContent('Saved, checked on first use'));
    expect(setAgentKey).toHaveBeenCalledWith(55, 'KIRO_API_KEY', 'ksk_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(screen.getByTestId('provider-kiro')).toHaveTextContent('Not in any team yet.');
    for (const role of ['coding', 'review']) expect(within(screen.getByTestId(`${role}-kiro`)).getByRole('checkbox', { name: 'Kiro' })).not.toBeChecked();
    expect(screen.queryByTestId('pending-changes')).toBeNull();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'View config' }));
    expect(JSON.stringify(previewed(api))).toBe(JSON.stringify(sample));
  });

  it('a stale connection, then reconnect: saving the key again shows it connected, and the draft is untouched', async () => {
    const agentKeys = vi
      .fn()
      .mockResolvedValueOnce(keyView([key('ANTHROPIC_API_KEY', { required: true, lastUsed: { at: '2026-11-20T00:00:00Z', ok: false } }), key('CODEX_API_KEY', { required: true })]))
      // As the server answers once the key is saved again: set, and not used since (config-service.test.ts).
      .mockResolvedValue(keyView([key('ANTHROPIC_API_KEY', { required: true }), key('CODEX_API_KEY', { required: true })]));
    const setAgentKey = vi.fn().mockResolvedValue(keyView([key('ANTHROPIC_API_KEY', { required: true }), key('CODEX_API_KEY', { required: true })]));
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published()), agentKeys, setAgentKey, previewConfig: okPreview() });
    configPage(api);
    const card = await screen.findByTestId('provider-claude');
    await waitFor(() => expect(within(card).getByText('Last use failed')).toBeInTheDocument());
    expect(screen.getByTestId('coding-claude')).toHaveTextContent('its last run could not use the key: reconnect it');

    await userEvent.click(within(card).getByRole('button', { name: 'Reconnect Claude Code' }));
    await userEvent.type(within(card).getByLabelText(/Claude Console API key/), 'sk-ant-new');
    await userEvent.click(within(card).getByRole('button', { name: 'Save key' }));
    expect(setAgentKey).toHaveBeenCalledWith(55, 'ANTHROPIC_API_KEY', 'sk-ant-new');
    await waitFor(() => expect(within(card).getByText('Connected')).toBeInTheDocument());
    expect(within(card).queryByText('Last use failed')).toBeNull();
    expect(screen.getByTestId('coding-claude')).not.toHaveTextContent('could not use the key');
    expect(within(screen.getByTestId('coding-claude')).getByRole('checkbox', { name: 'Claude Code' })).toBeChecked();
    expect(within(screen.getByTestId('review-claude')).getByRole('checkbox', { name: 'Claude Code' })).toBeChecked();
    expect(screen.queryByTestId('pending-changes')).toBeNull();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'View config' }));
    expect(previewed(api)).toEqual(withRepo());
  });

  it('a member who is not an owner gets the same page as the server allows: connect, choose and publish', async () => {
    const api = fakeApi({
      config: vi.fn().mockResolvedValue(published({ tenant: { ...view().tenant, role: 'editor' }, agents: ['claude', 'codex', 'kiro'], agentKeys: { ANTHROPIC_API_KEY: true, CODEX_API_KEY: true, KIRO_API_KEY: false } })),
      publishConfig: publishedOk(2),
    });
    configPage(api);
    await screen.findByTestId('simple-config');
    expect(screen.queryByTestId('config-readonly')).toBeNull();
    expect(within(screen.getByTestId('provider-kiro')).getByRole('button', { name: 'Connect Kiro' })).toBeEnabled();
    await userEvent.click(within(screen.getByTestId('review-claude')).getByRole('checkbox', { name: 'Claude Code' }));
    await userEvent.click(screen.getByTestId('allow-self-review'));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(sentConfig(api).pools.reviewers).toEqual({ agents: ['codex'] });
  });
});

/** The controls a person can reach: links, buttons, form fields and disclosure toggles. */
const CONTROLS = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
const ROLES = ['button', 'checkbox', 'textbox', 'combobox', 'spinbutton', 'link', 'radio', 'switch'] as const;
const STEPS = ['connected-agents', 'default-team', 'labels'] as const;

/** A window this wide, as the browser reports it to media queries and to script. */
function viewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const max = /max-width:\s*(\d+)px/.exec(query);
    const matches = (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
    return { matches, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false };
  }) as typeof window.matchMedia;
  window.dispatchEvent(new Event('resize'));
}

/** Why an element is not shown, if it is not: hidden itself, inside something hidden, or a closed disclosure's content. */
function hiddenBy(el: Element): string | null {
  for (let at: Element | null = el; at; at = at.parentElement) {
    if (at.hasAttribute('hidden')) return 'hidden';
    if (at.getAttribute('aria-hidden') === 'true') return 'aria-hidden';
    if (/(^|\s)([a-z-]+:)?(hidden|invisible|sr-only)(\s|$)/.test(at.getAttribute('class') ?? '')) return `class ${at.getAttribute('class')}`;
    const style = window.getComputedStyle(at);
    if (style.display === 'none' || style.visibility === 'hidden') return 'style';
    if (at.parentElement?.tagName === 'DETAILS' && !(at.parentElement as HTMLDetailsElement).open && at.tagName !== 'SUMMARY') return 'closed details';
  }
  return null;
}

/** A first run with Claude Code and Codex connected, and Kiro not yet. */
const firstRun = () => view({ config: clone(TWO_PROVIDERS.start), agents: ['claude', 'codex', 'kiro'], agentKeys: { ANTHROPIC_API_KEY: true, CODEX_API_KEY: true, KIRO_API_KEY: false } });

describe('accessibility and layout of the configuration page (#193)', () => {
  it('passes the automated accessibility checks, as a first run, as a returning user with everything open, and while connecting', async () => {
    // jsdom computes no colours, so contrast is the one check left to the owner's screenshots.
    // The page alone, as the app shell's <main> holds it (AppLayout); the shell's landmarks are its own.
    const check = async (state: string) => {
      const result = await axe.run(screen.getByTestId('config-page'), { rules: { 'color-contrast': { enabled: false } } });
      expect(result.violations.map((v) => `${state}: ${v.id}: ${v.help} (${v.nodes.map((n) => n.html.slice(0, 80)).join(' | ')})`)).toEqual([]);
    };
    const first = configPage(fakeApi({ config: vi.fn().mockResolvedValue(firstRun()) }));
    await screen.findByTestId('simple-config');
    await check('first run');
    await userEvent.click(within(screen.getByTestId('provider-kiro')).getByRole('button', { name: 'Connect Kiro' }));
    await check('connecting Kiro');
    first.unmount();

    configPage(fakeApi({ config: vi.fn().mockResolvedValue(published({ config: clone(SAMPLES.labels!) })) }));
    await screen.findByTestId('simple-config');
    await userEvent.click(screen.getByText(/models and effort/));
    await userEvent.click(within(screen.getByTestId('repo-acme/web')).getByRole('button', { name: 'Settings for acme/web' }));
    await check('returning, Advanced and settings open');
  });

  it('every control has an accessible name and the role of what it is', async () => {
    const { container } = configPage(fakeApi({ config: vi.fn().mockResolvedValue(published({ config: clone(SAMPLES.labels!) })) }));
    await screen.findByTestId('simple-config');
    await userEvent.click(screen.getByText(/models and effort/));
    await userEvent.click(within(screen.getByTestId('repo-acme/web')).getByRole('button', { name: 'Settings for acme/web' }));
    const exposed = new Set<Element>();
    for (const role of ROLES) {
      for (const el of screen.queryAllByRole(role)) {
        exposed.add(el);
        expect(el, `${role}: ${el.outerHTML.slice(0, 160)}`).toHaveAccessibleName();
      }
    }
    // Every native control is exposed with one of those roles (a summary is a disclosure toggle, named by its text).
    const controls = [...container.querySelectorAll(CONTROLS)];
    expect(controls.length).toBeGreaterThan(40);
    for (const el of controls) {
      // A closed dialog (the auto-merge confirmations) is not on the page until it opens.
      if (el.closest('dialog:not([open])')) continue;
      if (el.tagName === 'SUMMARY') expect(el.textContent?.trim()).toBeTruthy();
      else expect(exposed.has(el), el.outerHTML.slice(0, 160)).toBe(true);
    }
    for (const el of container.querySelectorAll('input[type="checkbox"]')) expect(screen.getAllByRole('checkbox')).toContain(el);
    for (const el of container.querySelectorAll('select')) expect(screen.getAllByRole('combobox')).toContain(el);
    // Each step is a heading under the page's own, in order.
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Connect agents', 'Choose your agent team', 'Choose where work starts', 'What will run']);
  });

  it('says each provider\'s status in words, not by colour alone', async () => {
    const config = withRepo();
    config.agents.vibe = { adapter: 'vibe', enabled: false };
    const agentKeys = vi.fn().mockResolvedValue(
      keyView([key('ANTHROPIC_API_KEY', { lastUsed: { at: '2026-11-20T00:00:00Z', ok: true } }), key('CODEX_API_KEY', { lastUsed: { at: '2026-11-20T00:00:00Z', ok: false } }), key('KIRO_API_KEY', { configured: false })]),
    );
    const first = configPage(fakeApi({ config: vi.fn().mockResolvedValue(published({ config, agents: ['claude', 'codex', 'kiro'], agentKeys: { ANTHROPIC_API_KEY: true, CODEX_API_KEY: true, KIRO_API_KEY: false } })), agentKeys }));
    const expected: Record<string, { status: string; action: string | null }> = {
      claude: { status: 'Connected', action: 'Replace Claude Code key' },
      codex: { status: 'Last use failed', action: 'Reconnect Codex' },
      kiro: { status: 'Not connected', action: 'Connect Kiro' },
      vibe: { status: 'Not available here', action: null },
    };
    await waitFor(() => expect(within(screen.getByTestId('provider-codex')).getByText('Last use failed')).toBeInTheDocument());
    for (const [a, { status, action }] of Object.entries(expected)) {
      const card = screen.getByTestId(`provider-${a}`);
      const badge = within(card).getByText(status);
      expect(hiddenBy(badge), a).toBeNull();
      if (action) expect(within(card).getByRole('button', { name: action })).toBeInTheDocument();
      else expect(within(card).queryByRole('button')).toBeNull();
    }
    // Each state has its own words.
    expect(new Set(Object.values(expected).map((e) => e.status)).size).toBe(4);
    first.unmount();

    // A Kiro key cannot be checked before a job uses it: that is said too.
    configPage(fakeApi({ config: vi.fn().mockResolvedValue(published({ agents: ['claude', 'codex', 'kiro'], agentKeys: { ANTHROPIC_API_KEY: true, CODEX_API_KEY: true, KIRO_API_KEY: true } })) }));
    expect(within(await screen.findByTestId('provider-kiro')).getByText('Saved, checked on first use')).toBeInTheDocument();
  });

  it('focus moves through the steps in order: connect, team, where work starts, then publishing', async () => {
    configPage(fakeApi({ config: vi.fn().mockResolvedValue(firstRun()) }));
    await screen.findByTestId('simple-config');
    const regions = ['header', ...STEPS, 'effective-config', 'advanced', 'publish-bar'];
    const regionOf = (el: Element) => {
      const i = regions.findIndex((r) => r !== 'header' && el.closest(`[data-testid="${r}"]`));
      return i < 0 ? 0 : i;
    };
    const order: number[] = [];
    const seen: Element[] = [];
    document.body.focus();
    for (let i = 0; i < 400; i++) {
      await userEvent.tab();
      const el = document.activeElement;
      if (!el || el === document.body || seen.includes(el)) break;
      seen.push(el);
      order.push(regionOf(el));
    }
    // Never back to an earlier step, and every step is reached.
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const step of [1, 2, 3, 6]) expect(order, regions[step]).toContain(step);
    // Within the first step, the providers in the order they are shown.
    const cards = seen.map((el) => el.closest('[data-testid^="provider-"]')?.getAttribute('data-testid')).filter((x): x is string => !!x);
    expect([...new Set(cards)]).toEqual(['provider-claude', 'provider-codex', 'provider-kiro']);
  });

  it('at 375px and 1280px wide the three steps stack in order, no control is hidden, and both widths show the same controls', async () => {
    // Both widths in one test, so the comparison never depends on test order.
    const counts: number[] = [];
    for (const width of [375, 1280]) {
      counts.push(await checkLayoutAt(width));
      cleanup();
    }
    // The same controls at both widths: nothing is dropped on a phone.
    expect(counts[0]).toBe(counts[1]);
  });
});

/** Renders the first-run page at `width`, checks the steps stack with no hidden control, and returns how many controls it shows. */
async function checkLayoutAt(width: number): Promise<number> {
    viewport(width);
    try {
      const { container } = configPage(fakeApi({ config: vi.fn().mockResolvedValue(firstRun()) }));
      const page = await screen.findByTestId('simple-config');
      const steps = STEPS.map((s) => screen.getByTestId(s));
      // One column at every width: the steps are siblings in a vertical flex container, in order.
      for (const step of steps) expect(step.parentElement).toBe(page);
      expect(page.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex', 'flex-col']));
      expect(page.className).not.toMatch(/(^|\s)[a-z-]+:(flex-row|grid|grid-cols-\d+|hidden)(\s|$)/);
      for (let i = 1; i < steps.length; i++) expect(steps[i - 1]!.compareDocumentPosition(steps[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(steps.map((s) => within(s).getAllByRole('heading')[0]!.textContent)).toEqual(['1 · Connect agents', '2 · Choose your agent team', '3 · Choose where work starts']);

      // Every control of the steps and of the publish bar is shown; only Advanced waits behind its toggle.
      const shown = [...steps, screen.getByTestId('publish-bar')].flatMap((s) => [...s.querySelectorAll(CONTROLS)]);
      expect(shown.length).toBeGreaterThan(15);
      for (const el of shown) expect(hiddenBy(el), el.outerHTML.slice(0, 160)).toBeNull();
      expect(hiddenBy(within(screen.getByTestId('advanced')).getByText('Advanced'))).toBeNull();
      return container.querySelectorAll(CONTROLS).length;
    } finally {
      viewport(1024);
    }
}
