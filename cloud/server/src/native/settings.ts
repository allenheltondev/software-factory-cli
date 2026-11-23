import type { Caller } from '../caller.js';
import { FlowError, type GitHubFlows } from '../flows/github.js';
import type { Store, Tenant } from '../store/store.js';
import { legacyNativeTriggers, sameNativeTrigger, type NativeRoute, type NativeTrigger } from './route.js';
import type { ClaudeSessions } from './sessions.js';
import type { NativeModeStore, NativeStore } from './store.js';

/** Per-installation UI state. Claude's native credentials never enter the application. */
export function createNativeSettingsService(d: {
  github: Pick<GitHubFlows, 'member' | 'configContext'>;
  route?: NativeRoute;
  managed?: {
    route(id: number): Promise<NativeRoute>;
    start(id: number): Promise<void>;
    sessions: Pick<ClaudeSessions, 'get'>;
    grant(route: NativeRoute): (() => Promise<{ url: string; token: string; port: number; expiresAt?: string }>) | undefined;
  };
  mode: NativeModeStore;
  workers: NativeStore;
  store?: Pick<Store, 'getConfigVersion'>;
  loginGrant?: () => Promise<{ url: string; token: string; port: number; expiresAt?: string }>;
  now?: () => number;
}) {
  const now = d.now ?? Date.now;
  const route = (id: number) => d.route?.installationId === id ? Promise.resolve(d.route) : d.managed?.route(id);
  async function availableTriggers(tenant?: Tenant): Promise<NativeTrigger[]> {
    if (!d.store || tenant?.activeConfigVersion === undefined) return [];
    const config = await d.store.getConfigVersion(tenant.installationId, tenant.activeConfigVersion, { consistent: true });
    return Object.entries(config?.dispatch?.repositories ?? {}).flatMap(([repository, rule]) =>
      rule.paused ? [] : [...new Set(rule.triggers.filter((t) => (t.keys ?? rule.keys)?.includes('ANTHROPIC_API_KEY')).map((t) => t.label))].map((label) => ({ repository, repositoryId: rule.id, label })));
  }

  async function view(caller: Caller, installationId: number) {
    const membership = await d.github.member(caller, installationId);
    const r = await route(installationId);
    if (!r || r.installationId !== installationId) return { configured: false, enabled: false, worker: null };
    const [mode, worker, available] = await Promise.all([
      d.mode.snapshot(r.installationId, r.workerId),
      d.workers.get(r.installationId, r.workerId),
      availableTriggers(membership?.tenant),
    ]);
    const stale = !worker || worker.microvmId !== r.microvmId || worker.imageVersion !== r.imageVersion || worker.fenced === true || now() - worker.heartbeatAt > 60_000;
    return {
      configured: true,
      enabled: mode.enabled,
      managed: Boolean(d.managed && r !== d.route),
      browserLogin: Boolean(r === d.route ? d.loginGrant : d.managed) && membership?.summary?.role === 'owner',
      triggers: mode.triggers ?? legacyNativeTriggers(r),
      availableTriggers: available,
      repository: r.repository,
      labels: r.labels,
      worker: worker ? {
        status: stale ? 'offline' : worker.auth,
        online: !stale,
        busy: !!(worker.active || worker.settling),
        lastHeartbeatAt: new Date(worker.heartbeatAt).toISOString(),
        workerVersion: worker.workerVersion,
      } : null,
    };
  }
  return {
    view,
    async login(caller: Caller, installationId: number) {
      const membership = await d.github.member(caller, installationId);
      if (membership.summary.role !== 'owner') throw new FlowError('not_authorized', 403, 'Only installation owners can sign in to the worker');
      const r = await route(installationId);
      const grant = r && (r === d.route ? d.loginGrant : d.managed?.grant(r));
      if (!r || !grant || r.installationId !== installationId || membership.tenant.status !== 'active') {
        throw new FlowError('invalid_settings', 409, 'Browser sign-in is unavailable for this installation');
      }
      const worker = await d.workers.get(installationId, r.workerId);
      if (!worker || worker.microvmId !== r.microvmId || worker.imageVersion !== r.imageVersion || worker.fenced ||
          worker.active || worker.settling || now() - worker.heartbeatAt > 60_000 || !['auth-required', 'expired'].includes(worker.auth)) {
        throw new FlowError('invalid_settings', 409, 'Wait for the worker to be online and ready for sign-in');
      }
      return grant();
    },
    async waiting(caller: Caller, installationId: number, requestId: string) {
      await d.github.member(caller, installationId);
      const item = await d.managed?.sessions.get(installationId, requestId);
      if (!item) throw new FlowError('not_found', 404, 'This Claude sign-in request was not found');
      return {
        status: item.status === 'waiting' && item.expiresAt <= now() ? 'expired' : item.status,
        expiresAt: new Date(item.expiresAt).toISOString(), jobId: item.jobId, reason: item.reason,
      };
    },
    async start(caller: Caller, installationId: number, requestId: string) {
      const { summary, tenant } = await d.github.member(caller, installationId);
      if (summary.role !== 'owner') throw new FlowError('not_authorized', 403, 'Only an installation owner can start a subscription session');
      const item = await d.managed?.sessions.get(installationId, requestId);
      const r = await route(installationId);
      if (!d.managed || !r || r === d.route || tenant.status !== 'active' || !item || item.status !== 'waiting' || item.expiresAt <= now() ||
          !await d.mode.enabled(installationId, r.workerId)) {
        throw new FlowError('invalid_settings', 409, 'This installation does not have an active Claude sign-in request');
      }
      await d.managed.start(installationId);
      return view(caller, installationId);
    },
    async update(caller: Caller, installationId: number, enabled: boolean, selection?: NativeTrigger[]) {
      const context = await d.github.configContext(caller, installationId);
      const r = await route(installationId);
      if (!r || r.installationId !== installationId) {
        throw new FlowError('invalid_settings', 409, 'No Claude subscription worker is provisioned for this installation');
      }
      // Read the dispatch revision first: any enqueue after this invalidates the commit.
      const mode = await d.mode.snapshot(r.installationId, r.workerId);
      const triggers = selection?.filter((item, index) =>
        selection.findIndex((trigger) => sameNativeTrigger(trigger, item)) === index) ?? mode.triggers;
      if (selection) {
        const available = await availableTriggers(context.tenant);
        const reachable = new Set(context.repositories.map((repo) => repo.id));
        if (selection.some((item) => !reachable.has(item.repositoryId) || !available.some((trigger) => sameNativeTrigger(trigger, item)))) {
          throw new FlowError('invalid_settings', 409, 'Choose triggers from reachable repositories in the active configuration');
        }
      }
      if (enabled && (triggers ?? legacyNativeTriggers(r)).length === 0) {
        throw new FlowError('invalid_settings', 409, 'Choose at least one published workflow trigger for subscription jobs');
      }
      const worker = await d.workers.get(r.installationId, r.workerId);
      if (worker?.active || worker?.settling) {
        throw new FlowError('invalid_settings', 409, 'Wait for the current subscription job to finish before changing authentication mode');
      }
      if ((!enabled || selection !== undefined) && (await d.workers.queued(r.installationId, r.workerId)).length > 0) {
        throw new FlowError('invalid_settings', 409, 'Wait for queued subscription jobs to finish or expire before changing routing');
      }
      if (enabled && r === d.route && (!worker || worker.fenced || worker.auth !== 'connected' || now() - worker.heartbeatAt > 60_000)) {
        throw new FlowError('invalid_settings', 409, 'Sign in directly to Claude on the worker and ensure it is connected before enabling subscription jobs');
      }
      if (!await d.mode.setEnabled(r.installationId, r.workerId, enabled, { revision: mode.revision, workerVersion: worker?.version ?? null, routingVersion: mode.routingVersion, ...(triggers ? { triggers } : {}) })) {
        throw new FlowError('invalid_settings', 409, 'Worker or queued jobs changed; refresh the status and try again');
      }
      return view(caller, installationId);
    },
  };
}
export type NativeSettingsService = ReturnType<typeof createNativeSettingsService>;
