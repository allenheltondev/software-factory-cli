import { imageDecision, type ImagePolicy } from './image-policy.js';
import type { Caller } from '../caller.js';
import { FlowError, type GitHubFlows } from '../flows/github.js';
import type { Store, Tenant } from '../store/store.js';
import { routeWorkerVersion } from './readiness.js';
import { legacyNativeTriggers, sameNativeTrigger, type NativeRoute, type NativeTrigger } from './route.js';
import type { ClaudeSessions } from './sessions.js';
import type { NativeModeStore, NativeStore } from './store.js';
import { CODEX_UNAVAILABLE, providerKeys, type NativeProvider } from './provider.js';

/** Per-installation UI state. Claude's native credentials never enter the application. */
export function createNativeSettingsService(d: {
  github: Pick<GitHubFlows, 'member' | 'configContext'>;
  route?: NativeRoute;
  managed?: {
    route(id: number): Promise<NativeRoute>;
    start(id: number): Promise<void>;
    /** Latest image for new sessions; older approved images may remain connected. */
    imageVersion?: string;
    imagePolicy?(version: string): Promise<ImagePolicy>;
    stop?(microvmId: string): Promise<void>;
    vmState?(id: number, generation?: string): Promise<string | null>;
    lifecycle?(id: number, generation?: string): Promise<{ preparing: boolean; startupFailed: boolean; retiring: boolean; retired?: boolean; retirementReason?: string; expiresAt?: string; idleExpiresAt?: string; idleSeconds?: number }>;
    policy?: { maxSessionSeconds: number; idleSeconds: number; concurrentSessions: number; tenantDailySeconds: number; platformDailySeconds: number; tenantLaunchesPerDay: number; platformLaunchesPerDay: number };
    retire?(id: number, generation: string): Promise<boolean>;
    /** Whether the deployed image can run this provider (Codex: verified with Codex, #125). Absent: it can. */
    available?(): Promise<boolean>;
    sessions: Pick<ClaudeSessions, 'get'> & Partial<Pick<ClaudeSessions, 'pending' | 'session'>>;
    grant(route: NativeRoute): (() => Promise<{ url: string; token: string; port: number; expiresAt?: string }>) | undefined;
  };
  mode: NativeModeStore;
  workers: NativeStore;
  store?: Pick<Store, 'getConfigVersion'>;
  loginGrant?: () => Promise<{ url: string; token: string; port: number; expiresAt?: string }>;
  now?: () => number;
  /** Whose page this is: Claude (the default, as before) or Codex on a ChatGPT plan (#125). */
  provider?: NativeProvider;
  /**
   * The triggers the other provider's subscription has chosen. A trigger is the subscription
   * route of one provider at most, so the console never offers one already taken by the other
   * (dispatch decides Claude first regardless, so a label never starts two jobs).
   */
  otherTriggers?(installationId: number): Promise<NativeTrigger[]>;
  /** Claude's page only: whether Connect ChatGPT can be offered on this deployment (#125). */
  codexAvailable?(): Promise<boolean>;
}) {
  const now = d.now ?? Date.now;
  const provider = d.provider ?? 'claude';
  const keys = providerKeys(provider);
  const name = keys.name;
  const replacementState = (vm: string | null | undefined) =>
    vm === null || vm === 'TERMINATED' ? 'stopped' as const : vm === 'TERMINATING' ? 'stopping' as const : 'required' as const;
  const route = (id: number) => d.route?.installationId === id ? Promise.resolve(d.route) : d.managed?.route(id);
  async function availableTriggers(tenant?: Tenant): Promise<NativeTrigger[]> {
    if (!d.store || tenant?.activeConfigVersion === undefined) return [];
    const config = await d.store.getConfigVersion(tenant.installationId, tenant.activeConfigVersion, { consistent: true });
    return Object.entries(config?.dispatch?.repositories ?? {}).flatMap(([repository, rule]) =>
      rule.paused ? [] : [...new Set(rule.triggers.filter((t) => (t.keys ?? rule.keys)?.includes(keys.apiKey)).map((t) => t.label))].map((label) => ({ repository, repositoryId: rule.id, label })));
  }
  /** Published triggers this provider may take: its workflows', less those the other provider's subscription holds. */
  async function offeredTriggers(tenant?: Tenant): Promise<NativeTrigger[]> {
    const all = await availableTriggers(tenant);
    if (!d.otherTriggers || !tenant) return all;
    const taken = await d.otherTriggers(tenant.installationId).catch(() => [] as NativeTrigger[]);
    return all.filter((t) => !taken.some((other) => sameNativeTrigger(other, t)));
  }

  /**
   * A different approved image is an optional update. Only explicit policy blocks dispatch.
   */
  async function upgradeOf(r: NativeRoute, workerVersion?: string) {
    const latest = d.managed?.imageVersion;
    if (r === d.route || !latest || r.microvmId === 'mvm-pending' || !d.managed?.vmState) return undefined;
    const policy = await d.managed.imagePolicy?.(r.imageVersion);
    const decision = policy ? imageDecision(policy, workerVersion) : 'approved';
    if (r.imageVersion === latest && decision === 'approved') return undefined;
    const state = await d.managed.vmState(r.installationId, r.generation);
    const status = state === null || state === 'TERMINATED' ? 'stopped' as const : state === 'TERMINATING' ? 'stopping' as const : 'required' as const;
    return { from: r.imageVersion, to: latest, state: status, optional: decision === 'approved',
      reason: decision === 'protocol-incompatible' ? 'Worker protocol is not supported by this deployment' : policy?.reason ?? 'A newer worker image is available' };
  }

  /** Whether the deployed image can run this provider; a failed read is "not yet", never a launch. */
  const providerReady = async () => !d.managed?.available || await d.managed.available().catch(() => false);
  async function view(caller: Caller, installationId: number) {
    const membership = await d.github.member(caller, installationId);
    const r = await route(installationId);
    const codexAvailable = d.codexAvailable ? { codexAvailable: await d.codexAvailable().catch(() => false) } : {};
    if (!r || r.installationId !== installationId) return { configured: false, enabled: false, worker: null, ...codexAvailable };
    // Codex on an image that cannot run it yet: nothing to connect, and nothing is started.
    if (provider === 'codex' && !(await providerReady())) {
      return { provider, available: false, configured: false, enabled: false, managed: true, worker: null,
        owner: membership?.summary?.role === 'owner' && membership?.tenant?.status === 'active' };
    }
    const [mode, worker, available] = await Promise.all([
      d.mode.snapshot(r.installationId, r.workerId),
      d.workers.get(r.installationId, r.workerId),
      offeredTriggers(membership?.tenant),
    ]);
    const stale = !worker || worker.microvmId !== r.microvmId || worker.imageVersion !== r.imageVersion || worker.fenced === true || now() - worker.heartbeatAt > 60_000;
    const managed = r !== d.route ? d.managed : undefined;
    const [imageUpdate, pending, session, queued] = await Promise.all([
      upgradeOf(r, routeWorkerVersion(r, worker)), managed?.sessions.pending?.(installationId), managed?.sessions.session?.(installationId),
      worker ? d.workers.queued(r.installationId, r.workerId) : Promise.resolve([]),
    ]);
    const upgrade = imageUpdate?.optional ? undefined : imageUpdate;
    const lifecycle = await managed?.lifecycle?.(installationId, r.generation);
    const recovering = lifecycle?.startupFailed || lifecycle?.retiring || !upgrade && managed && worker?.microvmId === r.microvmId && (worker.fenced || worker.auth === 'expired' || stale);
    const awaitingWorker = !upgrade && !recovering && managed && session && (!worker || worker.microvmId !== r.microvmId || worker.auth === 'unavailable');
    const vm = recovering || awaitingWorker ? await managed?.vmState?.(installationId) : undefined;
    const preparing = lifecycle?.preparing ?? Boolean(awaitingWorker && (!session.microvmId || (vm !== null && vm !== 'TERMINATED' && vm !== 'TERMINATING')));
    const recovery = recovering ? { state: lifecycle?.startupFailed && !lifecycle.retiring ? 'required' as const : lifecycle?.retiring && vm !== null && vm !== 'TERMINATED' ? 'stopping' as const : replacementState(vm) } : undefined;
    return {
      ...(provider === 'codex' ? { provider, available: true } : {}),
      ...codexAvailable,
      preparing,
      ...(imageUpdate?.optional ? { updateAvailable: imageUpdate } : {}),
      startupFailed: lifecycle?.startupFailed ?? false,
      retired: lifecycle?.retired ?? false,
      ...(lifecycle?.retirementReason ? { retirementReason: lifecycle.retirementReason } : {}),
      ...(managed?.policy ? { connectionPolicy: { ...managed.policy, ...(lifecycle?.idleSeconds !== undefined ? { idleSeconds: lifecycle.idleSeconds } : {}) } } : {}),
      ...(lifecycle?.idleExpiresAt && !lifecycle.retired ? { idleExpiresAt: lifecycle.idleExpiresAt } : {}),
      ...(recovery ? { recovery } : {}),
      ...(lifecycle?.expiresAt && !lifecycle.retired ? { sessionExpiresAt: lifecycle.expiresAt } : !lifecycle?.retired && session?.microvmId === r.microvmId ? { sessionExpiresAt: new Date(session.requestedAt + 8 * 60 * 60_000).toISOString() } : {}),
      ...(upgrade ? { upgrade, upgradeBlocked: Boolean(worker?.active || worker?.settling) } : {}),
      ...(pending?.[0] ? { pendingRequest: pending[0].id } : {}),
      // Restarting and signing in are owner actions; members see the state, not the buttons.
      owner: membership?.summary?.role === 'owner' && membership?.tenant?.status === 'active',
      configured: true,
      enabled: mode.enabled,
      managed: Boolean(d.managed && r !== d.route),
      browserLogin: Boolean(r === d.route ? d.loginGrant : d.managed) && membership?.summary?.role === 'owner' && membership?.tenant?.status === 'active',
      triggers: mode.triggers ?? legacyNativeTriggers(r),
      availableTriggers: available,
      repository: r.repository,
      labels: r.labels,
      worker: worker ? {
        status: stale ? 'offline' : worker.auth,
        online: !stale,
        busy: !!(worker.active || worker.settling || queued.length > 0),
        lastHeartbeatAt: new Date(worker.heartbeatAt).toISOString(),
        workerVersion: worker.workerVersion,
        generation: r.generation ?? r.microvmId,
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
      const image = await d.managed?.imagePolicy?.(r.imageVersion);
      if (image && imageDecision(image, routeWorkerVersion(r, worker)) !== 'approved') throw new FlowError('invalid_settings', 409, `${name} image requires an update: ${image.reason}`);
      if (!worker || worker.microvmId !== r.microvmId || worker.imageVersion !== r.imageVersion || worker.fenced ||
          worker.active || worker.settling || now() - worker.heartbeatAt > 60_000 || !['auth-required', 'expired'].includes(worker.auth)) {
        throw new FlowError('invalid_settings', 409, 'Wait for the worker to be online and ready for sign-in');
      }
      return { ...await grant(), generation: r.generation ?? r.microvmId };
    },
    async waiting(caller: Caller, installationId: number, requestId: string) {
      await d.github.member(caller, installationId);
      const item = await d.managed?.sessions.get(installationId, requestId);
      if (!item) throw new FlowError('not_found', 404, `This ${name} sign-in request was not found`);
      return {
        status: item.status === 'waiting' && item.expiresAt <= now() ? 'expired' : item.status,
        expiresAt: new Date(item.expiresAt).toISOString(), jobId: item.jobId, reason: item.reason,
      };
    },
    async start(caller: Caller, installationId: number, requestId?: string) {
      const { summary, tenant } = await d.github.member(caller, installationId);
      if (summary.role !== 'owner') throw new FlowError('not_authorized', 403, 'Only an installation owner can start a subscription session');
      const item = requestId ? await d.managed?.sessions.get(installationId, requestId) : undefined;
      const r = await route(installationId);
      if (!d.managed || !r || r.installationId !== installationId || r === d.route || tenant.status !== 'active' || (requestId !== undefined && (!item || item.status !== 'waiting' || item.expiresAt <= now()))) {
        throw new FlowError('invalid_settings', 409, `This installation does not have an active ${name} sign-in request or permission to connect`);
      }
      if (!(await providerReady())) throw new FlowError('invalid_settings', 409, CODEX_UNAVAILABLE);
      await d.managed.start(installationId);
      return view(caller, installationId);
    },
    /** Fences and stops exactly an idle outdated, expired, or lost managed session. */
    async restart(caller: Caller, installationId: number) {
      const { summary, tenant } = await d.github.member(caller, installationId);
      if (summary.role !== 'owner') throw new FlowError('not_authorized', 403, `Only an installation owner can restart the ${name} worker`);
      // First snapshot is the only retirement target, including pending/retiring sessions.
      const session = await d.managed?.sessions.session?.(installationId);
      const r = await route(installationId);
      if (!d.managed?.stop || !r || r.installationId !== installationId || r === d.route || tenant.status !== 'active') {
        throw new FlowError('invalid_settings', 409, `This installation has no ${name} worker to restart`);
      }
      // Capture the target once. Eligibility must never select a different generation later.
      if (d.managed.retire && d.managed.sessions.session && !session) {
        throw new FlowError('invalid_settings', 409, `The ${name} environment changed. Check its current status before reconnecting.`);
      }
      if (session && ((r.generation && r.generation !== session.generation) ||
          (r.microvmId !== 'mvm-pending' && r.microvmId !== session.microvmId))) {
        throw new FlowError('invalid_settings', 409, `The ${name} environment changed. Check its current status before reconnecting.`);
      }
      const previous = await d.workers.get(r.installationId, r.workerId);
      const upgrade = await upgradeOf(r, routeWorkerVersion(r, previous));
      const lifecycle = await d.managed.lifecycle?.(installationId, session?.generation);
      if (!upgrade && !lifecycle?.startupFailed && !lifecycle?.retiring && (!previous || previous.microvmId !== r.microvmId || (!previous.fenced && previous.auth !== 'expired' && now() - previous.heartbeatAt <= 60_000))) {
        throw new FlowError('invalid_settings', 409, `The ${name} worker is already up to date and healthy`);
      }
      if (d.managed.retire && session) {
        await d.managed.retire(installationId, session.generation);
        return view(caller, installationId);
      }
      const state = upgrade?.state ?? replacementState(await d.managed.vmState?.(installationId));
      if (state === 'required') {
        // Read the dispatch revision first: an enqueue after this read makes the fence fail.
        const mode = await d.mode.snapshot(r.installationId, r.workerId);
        const worker = await d.workers.get(r.installationId, r.workerId);
        if (!worker || worker.microvmId !== r.microvmId) {
          throw new FlowError('invalid_settings', 409, `The ${name} worker is still starting; try again in a minute`);
        }
        if (worker.active || worker.settling || (await d.workers.queued(r.installationId, r.workerId)).length > 0) {
          throw new FlowError('invalid_settings', 409, 'Wait for the current subscription job to finish before restarting the worker');
        }
        // Fence before stopping: once this commits, no poll can claim and no launch can queue work
        // for this VM. A fenced worker (an earlier restart whose stop failed) needs only the stop.
        if (!worker.fenced && !await d.mode.fenceForRestart(r.installationId, r.workerId, {
          revision: mode.revision, ...(mode.routingVersion !== undefined ? { routingVersion: mode.routingVersion } : {}),
          workerVersion: worker.version, microvmId: r.microvmId,
        })) {
          throw new FlowError('invalid_settings', 409, 'The worker or its queued jobs changed; refresh the status and try again');
        }
        await d.managed.stop(r.microvmId);
      }
      return view(caller, installationId);
    },
    async update(caller: Caller, installationId: number, enabled: boolean, selection?: NativeTrigger[]) {
      const context = await d.github.configContext(caller, installationId);
      const r = await route(installationId);
      if (!r || r.installationId !== installationId) {
        throw new FlowError('invalid_settings', 409, `No ${name} subscription worker is provisioned for this installation`);
      }
      // Read the dispatch revision first: any enqueue after this invalidates the commit.
      const mode = await d.mode.snapshot(r.installationId, r.workerId);
      const triggers = selection?.filter((item, index) =>
        selection.findIndex((trigger) => sameNativeTrigger(trigger, item)) === index) ?? mode.triggers;
      if (selection) {
        const available = await offeredTriggers(context.tenant);
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
        throw new FlowError('invalid_settings', 409, `Sign in directly to ${name} on the worker and ensure it is connected before enabling subscription jobs`);
      }
      if (!await d.mode.setEnabled(r.installationId, r.workerId, enabled, { revision: mode.revision, workerVersion: worker?.version ?? null, routingVersion: mode.routingVersion, ...(triggers ? { triggers } : {}) })) {
        throw new FlowError('invalid_settings', 409, 'Worker or queued jobs changed; refresh the status and try again');
      }
      return view(caller, installationId);
    },
  };
}
export type NativeSettingsService = ReturnType<typeof createNativeSettingsService>;
