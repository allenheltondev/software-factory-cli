import { randomUUID } from 'node:crypto';
import type { Caller } from '../caller.js';
import { FlowError, type GitHubFlows } from '../flows/github.js';
import type { Store } from '../store/store.js';
import type { SecretsPort } from '../tenants/agent-keys.js';
import { MAX_ROUTINES, routineId, routineLabel, routineSecretName, validRoutineToken, validRoutineUrl, validActor, publicRoutine, type RoutineRuleStore } from './rules.js';

/** Configuration is member-only. Trigger tokens are write-only, never returned in API views. */
export function createRoutineService({ store, rules, secrets, github, now = Date.now }:
  { store: Store; rules: RoutineRuleStore; secrets: SecretsPort;
    github: Pick<GitHubFlows, 'member' | 'configContext'>; now?: () => number }) {
  const view = async (id: number) => ({ rules: (await rules.list(id)).map(publicRoutine) });
  const conflict = () => new FlowError('invalid_routine', 409, 'The route changed while saving; reload and try again');
  return {
    async list(caller: Caller, installationId: number) {
      await github.member(caller, installationId);
      return view(installationId);
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
      const actors = body.allowedActors === undefined ? [ctx.githubLogin] : body.allowedActors;
      if (!Array.isArray(actors) || actors.length === 0 || actors.length > 25 || !actors.every(validActor))
        throw new FlowError('invalid_routine', 400, 'Enter 1–25 GitHub logins allowed to trigger the task');
      const allowedActors = [...new Set(actors.map((actor: string) => actor.toLowerCase()))];
      const id = routineId(repo.id, label);
      const current = await rules.list(installationId);
      if (current.length >= MAX_ROUTINES && !current.some((r) => r.id === id))
        throw new FlowError('invalid_routine', 400, `An installation can have at most ${MAX_ROUTINES} routine routes`);
      const previous = current.find((r) => r.id === id);
      const rule = { id, repositoryId: repo.id, repository: repo.fullName, label, url: body.url, allowedActors,
        credentialId: randomUUID(), updatedAt: new Date(now()).toISOString(), updatedBy: ctx.githubLogin };
      const name = routineSecretName(installationId, id, rule.credentialId);
      await secrets.put(name, body.token, { installationId: String(installationId), app: 'updraft-cloud', purpose: 'routine-trigger' });
      // Publish only a pointer to an immutable secret. An ambiguous write must not delete a
      // potentially published credential; tenant cleanup also enumerates unpublished secrets.
      const saved = await rules.put(installationId, rule, previous?.credentialId);
      if (saved !== 'stored') {
        await secrets.remove(name).catch(() => {});
        if (saved === 'conflict') throw conflict();
        throw new FlowError('tenant_disabled', 409, 'The installation has been uninstalled');
      }
      if (previous) await secrets.remove(routineSecretName(installationId, id, previous.credentialId)).catch(() => {});
      return view(installationId);
    },
    async remove(caller: Caller, installationId: number, id: string) {
      await github.configContext(caller, installationId);
      if (!/^[a-f0-9]{32}$/.test(id)) throw new FlowError('not_found', 404, 'No such routine route');
      const previous = await rules.get(installationId, id);
      if (!previous) throw new FlowError('not_found', 404, 'No such routine route');
      if (!await rules.remove(installationId, id, previous.credentialId)) throw conflict();
      await secrets.remove(routineSecretName(installationId, id, previous.credentialId)).catch(() => {});
      return view(installationId);
    },
  };
}
export type RoutineService = ReturnType<typeof createRoutineService>;
