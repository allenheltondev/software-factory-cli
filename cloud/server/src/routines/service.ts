import type { Caller } from '../caller.js';
import { FlowError, type GitHubFlows } from '../flows/github.js';
import type { Store } from '../store/store.js';
import type { SecretsPort } from '../tenants/agent-keys.js';
import { MAX_ROUTINES, routineId, routineLabel, routineSecretName, validRoutineToken, validRoutineUrl, type RoutineRuleStore } from './rules.js';

/** Configuration is member-only. Trigger tokens are write-only, never returned in API views. */
export function createRoutineService({ store, rules, secrets, github, now = Date.now }:
  { store: Store; rules: RoutineRuleStore; secrets: SecretsPort;
    github: Pick<GitHubFlows, 'member' | 'configContext'>; now?: () => number }) {
  return {
    async list(caller: Caller, installationId: number) {
      await github.member(caller, installationId);
      return { rules: await rules.list(installationId) };
    },
    async set(caller: Caller, installationId: number, raw: unknown) {
      const ctx = await github.configContext(caller, installationId);
      const tenant = await store.getTenant(installationId, { consistent: true });
      if (!tenant || tenant.disabledReason === 'uninstalled') throw new FlowError('tenant_disabled', 409, 'The installation is unavailable');
      const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const repo = ctx.repositories.find((r) => r.id === body.repositoryId);
      const label = typeof body.label === 'string' ? routineLabel(body.label) : '';
      if (!repo || label.length < 1 || label.length > 80 || Array.from(label).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) ||
          !validRoutineUrl(body.url) || !validRoutineToken(body.token))
        throw new FlowError('invalid_routine', 400, 'Choose an installed repository and label, then paste the API trigger URL and token from Claude Code scheduled tasks');
      const id = routineId(repo.id, label);
      const current = await rules.list(installationId);
      if (current.length >= MAX_ROUTINES && !current.some((r) => r.id === id))
        throw new FlowError('invalid_routine', 400, `An installation can have at most ${MAX_ROUTINES} routine routes`);
      const rule = { id, repositoryId: repo.id, repository: repo.fullName, label, url: body.url,
        updatedAt: new Date(now()).toISOString(), updatedBy: ctx.githubLogin };
      const name = routineSecretName(installationId, id);
      await secrets.put(name, body.token, { installationId: String(installationId), app: 'updraft-cloud', purpose: 'routine-trigger' });
      const saved = await rules.put(installationId, rule);
      if (saved !== 'stored') {
        await secrets.remove(name).catch(() => {});
        throw new FlowError('tenant_disabled', 409, 'The installation has been uninstalled');
      }
      return { rules: await rules.list(installationId) };
    },
    async remove(caller: Caller, installationId: number, id: string) {
      await github.configContext(caller, installationId);
      if (!/^[a-f0-9]{32}$/.test(id)) throw new FlowError('not_found', 404, 'No such routine route');
      if (!await rules.get(installationId, id)) throw new FlowError('not_found', 404, 'No such routine route');
      await rules.remove(installationId, id);
      await secrets.remove(routineSecretName(installationId, id));
      return { rules: await rules.list(installationId) };
    },
  };
}
export type RoutineService = ReturnType<typeof createRoutineService>;
