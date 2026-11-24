import { expect, it, vi } from 'vitest';

vi.hoisted(() => { process.env.CLOUD_AGENTS = 'claude,codex,vibe'; });

const { checkAgentKeyWithProvider } = await import('./key-check.js');
const { compileTenantConfig } = await import('./config.js');
const { defaultConsoleConfig, toTenantSubmission } = await import('./console.js');

it('checks a Studio key only at the official Mistral models endpoint', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
  await expect(checkAgentKeyWithProvider(request)('MISTRAL_API_KEY', 'fake-studio-key')).resolves.toBe('valid');
  expect(request).toHaveBeenCalledWith('https://api.mistral.ai/v1/models', expect.objectContaining({
    headers: { authorization: 'Bearer fake-studio-key' },
    redirect: 'error',
  }));
});

it('compiles a Vibe trigger with only its own tenant key in the sandbox', () => {
  const config = defaultConsoleConfig({ login: 'owner', keys: new Set(['MISTRAL_API_KEY']) });
  config.agents.vibe!.model = 'mistral-large-4-0';
  config.repositories['acme/site'] = { enabled: true, workflows: ['implement'], publish: 'draft-pr', commentOnFailure: true, verify: [] };
  const result = compileTenantConfig(toTenantSubmission(config), { appId: 1 }, new Map([['acme/site', 42]]));
  expect(result).toMatchObject({
    ok: true,
    dispatch: { repositories: { 'acme/site': { keys: ['MISTRAL_API_KEY'] } } },
  });
  expect(result.ok && result.files['config.yaml']).toMatch(/env:\n\s+- MISTRAL_API_KEY/);
});
