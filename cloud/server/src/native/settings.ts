import type { Caller } from '../caller.js';
import { FlowError, type GitHubFlows } from '../flows/github.js';
import type { NativeRoute } from './route.js';
import type { NativeModeStore, NativeStore } from './store.js';

/** Per-installation UI state. Claude's native credentials never enter the application. */
export function createNativeSettingsService(d: {
  github: Pick<GitHubFlows, 'member' | 'configContext'>;
  route?: NativeRoute;
  mode: NativeModeStore;
  workers: NativeStore;
  now?: () => number;
}) {
  const now = d.now ?? Date.now;
  async function view(caller: Caller, installationId: number) {
    await d.github.member(caller, installationId);
    const r = d.route;
    if (!r || r.installationId !== installationId) return { configured: false, enabled: false, worker: null };
    const [enabled, worker] = await Promise.all([
      d.mode.enabled(r.installationId, r.workerId),
      d.workers.get(r.installationId, r.workerId),
    ]);
    const stale = !worker || worker.fenced === true || now() - worker.heartbeatAt > 60_000;
    return {
      configured: true,
      enabled,
      repository: r.repository,
      labels: r.labels,
      worker: worker ? {
        status: stale ? 'offline' : worker.auth,
        online: !stale,
        busy: !!worker.active,
        lastHeartbeatAt: new Date(worker.heartbeatAt).toISOString(),
        workerVersion: worker.workerVersion,
      } : null,
    };
  }
  return {
    view,
    async update(caller: Caller, installationId: number, enabled: boolean) {
      await d.github.configContext(caller, installationId);
      const r = d.route;
      if (!r || r.installationId !== installationId) {
        throw new FlowError('invalid_settings', 409, 'No Claude subscription worker is provisioned for this installation');
      }
      const worker = await d.workers.get(r.installationId, r.workerId);
      if (worker?.active) {
        throw new FlowError('invalid_settings', 409, 'Wait for the current subscription job to finish before changing authentication mode');
      }
      if (!enabled && (await d.workers.queued(r.installationId, r.workerId)).length > 0) {
        throw new FlowError('invalid_settings', 409, 'Wait for queued subscription jobs to finish or expire before switching to API keys');
      }
      if (enabled && (!worker || worker.fenced || worker.auth !== 'connected' || now() - worker.heartbeatAt > 60_000)) {
        throw new FlowError('invalid_settings', 409, 'Sign in directly to Claude on the worker and ensure it is connected before enabling subscription jobs');
      }
      await d.mode.setEnabled(r.installationId, r.workerId, enabled);
      return view(caller, installationId);
    },
  };
}
export type NativeSettingsService = ReturnType<typeof createNativeSettingsService>;
