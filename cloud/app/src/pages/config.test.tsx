import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, ConfigInvalidError, type ConfigView, type ConsoleConfig, type VersionSummary } from '../api/client';
import { fakeApi } from '../test/fakeApi';
import { ConfigHistoryPage, diffFiles } from './ConfigHistoryPage';
import { ConfigPage, issuesAt, parseLogins } from './ConfigPage';
import { InstallationPage } from './InstallationPage';
import { keysNeeded, workflowConflict } from './config/model';

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
  });
});

describe('InstallationPage', () => {
  it('links an active installation to its configuration', async () => {
    const api = fakeApi({
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
    at('/installations/55', <InstallationPage api={api} />, '/installations/:id');
    expect(await screen.findByTestId('configure-link')).toHaveAttribute('href', '/installations/55/config');
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
    expect(sent.repositories['acme/web']).toEqual({ enabled: true, workflows: ['implement'], publish: 'draft-pr', commentOnFailure: true, verify: ['npm ci && npm test'] });
    const first = await screen.findByTestId('first-publish');
    expect(first).toHaveTextContent('add the label updraft to an issue in acme/web');
    expect(within(first).getByRole('link', { name: /acme\/web/ })).toHaveAttribute('href', 'https://github.com/acme/web/issues');
  });

  it('ticks coding and review agents separately; no review agent means no review, one reviews its own work', async () => {
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published()), publishConfig: publishedOk(2) });
    configPage(api);
    await userEvent.click(within(await screen.findByTestId('review-claude')).getByRole('checkbox'));
    expect(screen.getByText(/Codex reviews its own work when it wrote the code/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    let sent = sentConfig(api);
    expect(sent.pools).toEqual({ builders: { agents: ['claude', 'codex'] }, reviewers: { agents: ['codex'] } });
    expect(sent.workflows.implement!.review).toMatchObject({ enabled: true, pool: 'reviewers', allowSameAgent: true });

    await userEvent.click(within(screen.getByTestId('review-codex')).getByRole('checkbox'));
    expect(screen.getByText(/No review: pull requests wait for a person/)).toBeInTheDocument();
    await userEvent.click(within(screen.getByTestId('coding-codex')).getByRole('checkbox'));
    // The last coding agent cannot be unticked.
    expect(within(screen.getByTestId('coding-claude')).getByRole('checkbox')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    sent = sentConfig(api, 1);
    expect(sent.pools).toEqual({ builders: { agents: ['claude'] } });
    expect(sent.agents.codex).toEqual({ adapter: 'codex', enabled: false });
    expect(sent.workflows.implement!.review.enabled).toBe(false);
  });

  it('takes a missing key in place, or the agent is unticked', async () => {
    const setAgentKey = vi.fn().mockResolvedValue({ keys: [{ name: 'ANTHROPIC_API_KEY', configured: true, required: true }, { name: 'CODEX_API_KEY', configured: true, required: true }], refusals: [] });
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published({ agentKeys: { ANTHROPIC_API_KEY: true, CODEX_API_KEY: false } })), setAgentKey });
    configPage(api);
    const codex = await screen.findByTestId('coding-codex');
    expect(screen.getByTestId('blockers')).toHaveTextContent('Add a key for Codex, or untick it.');
    // Shown once, under coding, not again under review.
    expect(within(screen.getByTestId('review-codex')).queryByTestId('inline-key-codex')).toBeNull();
    await userEvent.type(within(codex).getByLabelText(/OpenAI Platform API key/), 'sk-proj-abc');
    await userEvent.click(within(codex).getByRole('button', { name: 'Save key' }));
    expect(setAgentKey).toHaveBeenCalledWith(55, 'CODEX_API_KEY', 'sk-proj-abc');
    await waitFor(() => expect(screen.queryByTestId('blockers')).toBeNull());
    expect(within(codex).getByText('Key set')).toBeInTheDocument();
  });

  it('changes an agent model, and keeps repository extras behind its settings', async () => {
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published()), publishConfig: publishedOk(2) });
    configPage(api);
    const claude = await screen.findByTestId('coding-claude');
    await userEvent.click(within(claude).getByRole('button', { name: 'Change model' }));
    await userEvent.type(within(claude).getByLabelText('Model'), 'claude-opus-5-5');
    const web = screen.getByTestId('repo-acme/web');
    expect(within(web).queryByLabelText('Base branch')).toBeNull();
    await userEvent.click(within(web).getByRole('button', { name: 'Settings for acme/web' }));
    await userEvent.selectOptions(within(web).getByLabelText('Open pull requests as'), 'pr');
    await userEvent.click(within(web).getByRole('checkbox', { name: /Start work here/ }));
    expect(web).toHaveTextContent('Paused');
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

  it('keeps prompts and limits under Advanced, and resets an edited prompt', async () => {
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published()), publishConfig: publishedOk(2) });
    configPage(api);
    await userEvent.click(await screen.findByText(/Advanced: prompts/));
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

/** From the simple page to the full editor. */
async function openFull() {
  await userEvent.click(await screen.findByText(/Advanced: prompts/));
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
    expect(sentConfig(api).repositories['acme/api']).toEqual({ enabled: true, workflows: ['implement'], publish: 'draft-pr', commentOnFailure: true, verify: ['npm test'] });
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

  it('adds an agent to every pool, edits pool members, and takes a missing key in place', async () => {
    const setAgentKey = vi.fn().mockResolvedValue({ keys: [{ name: 'ANTHROPIC_API_KEY', configured: true, required: true }, { name: 'CODEX_API_KEY', configured: true, required: true }], refusals: [] });
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published({ agentKeys: { ANTHROPIC_API_KEY: true, CODEX_API_KEY: false } })), setAgentKey, publishConfig: publishedOk(2) });
    configPage(api);
    await openFull();
    expect(await screen.findByTestId('config-missing-keys')).toHaveTextContent('codex (Codex) needs a key before you publish');
    await userEvent.click(screen.getByRole('button', { name: 'Go to agents' }));

    await userEvent.selectOptions(screen.getByLabelText('Add an agent'), 'claude');
    await userEvent.click(screen.getByRole('button', { name: 'Add agent' }));
    const second = screen.getByTestId('agent-claude-2');
    await userEvent.type(within(second).getByLabelText('Model'), 'claude-haiku-5-5');
    expect(within(screen.getByTestId('pool-builders')).getByRole('checkbox', { name: 'claude-2' })).toBeChecked();
    await userEvent.click(within(screen.getByTestId('pool-reviewers')).getByRole('checkbox', { name: 'claude-2' }));

    const codex = screen.getByTestId('agent-codex');
    await userEvent.type(within(codex).getByLabelText(/OpenAI Platform API key/), 'sk-proj-abc');
    await userEvent.click(within(codex).getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(screen.queryByTestId('config-missing-keys')).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const sent = sentConfig(api);
    expect(sent.agents['claude-2']).toEqual({ adapter: 'claude', model: 'claude-haiku-5-5', enabled: true });
    expect(sent.pools).toEqual({ builders: { agents: ['claude', 'codex', 'claude-2'] }, reviewers: { agents: ['claude', 'codex'] } });
  });

  it('turns an agent off instead of adding its key', async () => {
    const api = fakeApi({ config: vi.fn().mockResolvedValue(published({ agentKeys: { ANTHROPIC_API_KEY: true, CODEX_API_KEY: false } })) });
    configPage(api);
    await openFull();
    await userEvent.click(await screen.findByRole('button', { name: 'Go to agents' }));
    await userEvent.click(within(screen.getByTestId('agent-codex')).getByRole('checkbox', { name: 'On' }));
    expect(screen.queryByTestId('config-missing-keys')).toBeNull();
    expect(within(screen.getByTestId('agent-codex')).queryByTestId('inline-key-codex')).toBeNull();
  });

  it('refreshes key status when the tab regains focus without touching the draft', async () => {
    const config = vi.fn().mockResolvedValue(published({ agentKeys: { ANTHROPIC_API_KEY: false, CODEX_API_KEY: true } }));
    configPage(fakeApi({ config }));
    await openFull();
    expect(await screen.findByTestId('config-missing-keys')).toBeInTheDocument();
    await userEvent.click(within(screen.getByTestId('repo-acme/api')).getByRole('checkbox', { name: 'Work in acme/api' }));
    config.mockResolvedValue(published({ agentKeys: { ANTHROPIC_API_KEY: true, CODEX_API_KEY: true } }));
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

  it('offers no auto-merge where no workflow reviews', async () => {
    const config = withRepo();
    config.workflows.implement!.review.enabled = false;
    configPage(fakeApi({ config: vi.fn().mockResolvedValue(published({ config })) }));
    await openFull();
    const web = await screen.findByTestId('repo-acme/web');
    expect(within(web).getByRole('checkbox', { name: /Auto-merge/ })).toBeDisabled();
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
