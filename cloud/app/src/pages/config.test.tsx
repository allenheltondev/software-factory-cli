import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, ConfigInvalidError, type ConfigView, type ConsoleConfig, type VersionSummary } from '../api/client';
import { fakeApi } from '../test/fakeApi';
import { ConfigHistoryPage, diffFiles } from './ConfigHistoryPage';
import { ConfigPage, issuesAt, parseLogins } from './ConfigPage';
import { InstallationPage } from './InstallationPage';

const PROMPTS = { implement: '# Implement the issue', review: '# Review the PR', revise: '# Revise the PR' };

const baseConfig = (): ConsoleConfig => ({
  version: 1,
  workflows: {
    implement: { agent: { adapter: 'claude' }, prompt: PROMPTS.implement, reviewer: { adapter: 'codex', prompt: PROMPTS.review }, revisePrompt: PROMPTS.revise, verify: [] },
  },
  repositories: {},
});

const view = (over: Partial<ConfigView> = {}): ConfigView => ({
  tenant: { installationId: 55, accountLogin: 'acme', accountType: 'Organization', status: 'active', role: 'owner' },
  githubLogin: 'pat',
  repositories: [
    { id: 9, fullName: 'acme/web', private: true, htmlUrl: 'https://github.com/acme/web' },
    { id: 10, fullName: 'acme/api', private: false, htmlUrl: 'https://github.com/acme/api' },
  ],
  agentKeys: { ANTHROPIC_API_KEY: true, CODEX_API_KEY: true },
  activeVersion: null,
  source: 'none',
  config: baseConfig(),
  defaults: { prompts: PROMPTS },
  limits: { ceilings: { timeoutMinutes: 120, verifyTimeoutMinutes: 30, autoMergeWaitMinutes: 120, maxRevisions: 5 }, console: {} },
  ...over,
});

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

async function addRepository(name = 'acme/web') {
  await userEvent.selectOptions(await screen.findByLabelText('Add a repository'), name);
  await userEvent.click(screen.getByRole('button', { name: 'Add' }));
  return screen.getByTestId(`repo-${name}`);
}

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

describe('ConfigPage', () => {
  it('adds a repository with the linked login as its allowed actor, and publishes it from the active version', async () => {
    const api = fakeApi({
      config: vi.fn().mockResolvedValue(view({ activeVersion: 3, source: 'console' })),
      publishConfig: vi.fn().mockResolvedValueOnce({ ok: true, version: 4, yaml: 'version: 1\n', warnings: [] }).mockResolvedValueOnce({ ok: true, version: 5, yaml: 'version: 1\n', warnings: [] }),
    });
    configPage(api);
    const repo = await addRepository();
    expect(within(repo).getByLabelText('Allowed actors')).toHaveValue('pat');
    expect(within(repo).getByLabelText('Label 1')).toHaveValue('updraft');
    expect(within(repo).getByLabelText('Publish as')).toHaveValue('draft-pr');
    expect(within(repo).getByLabelText(/auto-merge/i)).not.toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(api.publishConfig).toHaveBeenCalledTimes(1));
    const sent = vi.mocked(api.publishConfig).mock.calls[0]!;
    expect(sent[0]).toBe(55);
    expect(sent[1].baseVersion).toBe(3);
    expect(sent[1].confirmAutoMerge).toBeUndefined();
    expect(sent[1].config.repositories['acme/web']).toEqual({
      enabled: true,
      triggers: [{ label: 'updraft', workflow: 'implement' }],
      allowedActors: ['pat'],
      publish: 'draft-pr',
      commentOnFailure: true,
      review: false,
      revise: false,
    });
    expect(await screen.findByTestId('config-published')).toHaveTextContent('Published version 4');

    // The next publish is based on the version just published.
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(api.publishConfig).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.publishConfig).mock.calls[1]![1].baseVersion).toBe(4);
  });

  it('flags an empty allowed-actor list and will not publish it', async () => {
    const api = fakeApi({ config: vi.fn().mockResolvedValue(view()) });
    configPage(api);
    const repo = await addRepository();
    await userEvent.clear(within(repo).getByLabelText('Allowed actors'));
    expect(within(repo).getByText('Name at least one GitHub login')).toBeInTheDocument();
    expect(screen.getByTestId('config-empty-actors')).toHaveTextContent('acme/web');
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('pauses a repository', async () => {
    const api = fakeApi({ config: vi.fn().mockResolvedValue(view()), publishConfig: vi.fn().mockResolvedValue({ ok: true, version: 1, yaml: '', warnings: [] }) });
    configPage(api);
    const repo = await addRepository();
    await userEvent.click(within(repo).getByRole('button', { name: 'Pause' }));
    expect(within(repo).getByText('Paused')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(vi.mocked(api.publishConfig).mock.calls[0]![1].config.repositories['acme/web']!.enabled).toBe(false));
  });

  it('turns auto-merge on only after the confirmation, and says so when publishing', async () => {
    const api = fakeApi({ config: vi.fn().mockResolvedValue(view()), publishConfig: vi.fn().mockResolvedValue({ ok: true, version: 1, yaml: '', warnings: [] }) });
    configPage(api);
    const repo = await addRepository();
    const autoMerge = within(repo).getByLabelText(/auto-merge/i);
    expect(autoMerge).toBeDisabled(); // needs review first
    await userEvent.click(within(repo).getByLabelText(/^Review/));
    await userEvent.click(autoMerge);
    let dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(within(repo).getByLabelText(/auto-merge/i)).not.toBeChecked();

    await userEvent.click(within(repo).getByLabelText(/auto-merge/i));
    dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('without a person approving');
    await userEvent.click(within(dialog).getByRole('button', { name: /I understand/ }));
    expect(within(repo).getByLabelText(/auto-merge/i)).toBeChecked();
    expect(within(repo).getByLabelText('Merge method')).toHaveValue('squash');

    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(api.publishConfig).toHaveBeenCalled());
    const [, input] = vi.mocked(api.publishConfig).mock.calls[0]!;
    expect(input.confirmAutoMerge).toBe(true);
    expect(input.config.repositories['acme/web']!.autoMerge).toEqual({ method: 'squash' });
  });

  it('asks again when the server wants the auto-merge confirmation, and resends with it', async () => {
    const config = baseConfig();
    config.repositories['acme/web'] = { enabled: true, triggers: [{ label: 'updraft', workflow: 'implement' }], allowedActors: ['pat'], publish: 'draft-pr', commentOnFailure: true, review: true, revise: false, autoMerge: { method: 'merge' } };
    const api = fakeApi({
      config: vi.fn().mockResolvedValue(view({ config })),
      publishConfig: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(409, 'auto_merge_unconfirmed', 'Confirm turning on auto-merge for acme/web'))
        .mockResolvedValueOnce({ ok: true, version: 2, yaml: '', warnings: [] }),
    });
    configPage(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Confirm turning on auto-merge for acme/web');
    await userEvent.click(within(dialog).getByRole('button', { name: /I understand/ }));
    await waitFor(() => expect(api.publishConfig).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.publishConfig).mock.calls[1]![1].confirmAutoMerge).toBe(true);
    expect(await screen.findByTestId('config-published')).toHaveTextContent('version 2');
  });

  it('previews the generated YAML read-only', async () => {
    const api = fakeApi({
      config: vi.fn().mockResolvedValue(view()),
      previewConfig: vi.fn().mockResolvedValue({ ok: true, yaml: 'version: 1\nexecution:\n  mode: live\n', warnings: [{ path: 'repositories.acme/web.review', message: 'revise is off' }], autoMergeTurnedOn: [] }),
    });
    configPage(api);
    await addRepository();
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByTestId('config-yaml')).toHaveTextContent('mode: live');
    expect(screen.getByTestId('config-yaml').tagName).toBe('PRE');
    expect(screen.getByTestId('config-warnings')).toHaveTextContent('revise is off');
    expect(api.publishConfig).not.toHaveBeenCalled();
  });

  it('lists every problem of a refused publish, and shows each at its field', async () => {
    const api = fakeApi({
      config: vi.fn().mockResolvedValue(view()),
      publishConfig: vi.fn().mockRejectedValue(
        new ConfigInvalidError(
          [
            { path: 'workflows.implement.agent.effort', message: 'claude does not accept that effort' },
            { path: 'repositories.acme/web.triggers.0.label', message: 'required' },
          ],
          [],
        ),
      ),
    });
    configPage(api);
    await addRepository();
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const list = await screen.findByTestId('config-errors');
    expect(list).toHaveTextContent('Nothing was published');
    expect(list).toHaveTextContent('workflows.implement.agent.effort');
    expect(within(screen.getByTestId('workflow-implement')).getByText('claude does not accept that effort')).toBeInTheDocument();
  });

  it('says when someone else published meanwhile, and reloads', async () => {
    const api = fakeApi({
      config: vi.fn().mockResolvedValueOnce(view({ activeVersion: 1 })).mockResolvedValueOnce(view({ activeVersion: 2 })),
      publishConfig: vi.fn().mockRejectedValue(new ApiError(409, 'config_changed', 'Version 2 was published since you started editing')),
    });
    configPage(api);
    await addRepository();
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const conflict = await screen.findByTestId('config-conflict');
    expect(conflict).toHaveTextContent('Version 2 was published');
    await userEvent.click(within(conflict).getByRole('button', { name: 'Reload' }));
    expect(await screen.findByTestId('active-version')).toHaveTextContent('version 2 is active');
  });

  it('warns about missing keys and about a version tenant-admin published; a disabled tenant is read-only', async () => {
    const config = baseConfig();
    config.repositories['acme/web'] = { enabled: true, triggers: [{ label: 'updraft', workflow: 'implement' }], allowedActors: ['pat'], publish: 'draft-pr', commentOnFailure: true, review: false, revise: false };
    const api = fakeApi({
      config: vi.fn().mockResolvedValue(
        view({ config, source: 'tenant', activeVersion: 7, agentKeys: { ANTHROPIC_API_KEY: false, CODEX_API_KEY: true }, tenant: { ...view().tenant, status: 'disabled', disabledReason: 'suspended' } }),
      ),
    });
    configPage(api);
    expect(await screen.findByTestId('config-missing-keys')).toHaveTextContent('ANTHROPIC_API_KEY');
    expect(screen.getByTestId('config-tenant-source')).toHaveTextContent('Version 7 was published with tenant-admin');
    expect(screen.getByTestId('config-readonly')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('adds a workflow with the packaged prompts, and resets an edited prompt', async () => {
    const api = fakeApi({ config: vi.fn().mockResolvedValue(view()) });
    configPage(api);
    await userEvent.type(await screen.findByLabelText('New workflow name'), 'Bad Name');
    await userEvent.click(screen.getByRole('button', { name: 'Add workflow' }));
    expect(screen.getByText(/Lower-case letters/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('New workflow name'));
    await userEvent.type(screen.getByLabelText('New workflow name'), 'docs');
    await userEvent.click(screen.getByRole('button', { name: 'Add workflow' }));
    const docs = screen.getByTestId('workflow-docs');
    const prompt = within(docs).getByLabelText('Prompt');
    expect(prompt).toHaveValue(PROMPTS.implement);
    await userEvent.type(prompt, ' more');
    await userEvent.click(within(docs).getAllByRole('button', { name: 'Reset to the packaged prompt' })[0]!);
    expect(within(docs).getByLabelText('Prompt')).toHaveValue(PROMPTS.implement);
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
