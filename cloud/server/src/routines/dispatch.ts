import type { Store } from '../store/store.js';
import { OFF_SWITCH, type KillSwitch } from '../jobs/kill-switch.js';
import { routineId, routineLabel, routineSecretName, type RoutineRule, type RoutineRuleStore } from './rules.js';

type Event = { action?: unknown; repository?: { id?: unknown; full_name?: unknown };
  label?: { name?: unknown }; issue?: { number?: unknown }; sender?: { login?: unknown } };
export interface RoutineDispatchResult {
  disposition: 'routine_triggered' | 'routine_failed' | 'routine_unknown' | 'deduped' | 'filtered';
  status: number;
  reason?: string;
  message?: string;
}
export type RoutineDispatcher = (input: { installationId: number; deliveryId: string; eventName: string; payload: Event }) =>
  Promise<RoutineDispatchResult | null>;
const CLAIM_MS = 30 * 24 * 60 * 60 * 1000;
function validSession(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 512) return false;
  try {
    const u = new URL(url);
    return u.origin === 'https://claude.ai' && /^\/code\/session_[A-Za-z0-9_-]+$/.test(u.pathname) && !u.search && !u.hash;
  } catch { return false; }
}

/** Anthropic's official routine-fire endpoint; never runs Claude Code within Updraft. */
export async function fireRoutine(rule: RoutineRule, token: string, context: string, fetchImpl: typeof fetch = fetch):
  Promise<{ kind: 'created'; sessionUrl: string } | { kind: 'rejected'; status: number } | { kind: 'uncertain' }> {
  const response = await fetchImpl(rule.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2026-10-21', 'content-type': 'application/json' },
    body: JSON.stringify({ text: context.slice(0, 65536) }),
    redirect: 'error', signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) return { kind: 'rejected', status: response.status };
  const body = await response.json().catch(() => null) as { claude_code_session_url?: unknown; type?: unknown } | null;
  return body?.type === 'routine_fire' && validSession(body.claude_code_session_url)
    ? { kind: 'created', sessionUrl: body.claude_code_session_url } : { kind: 'uncertain' };
}

export function createRoutineDispatcher({ store, rules, readToken, fetchImpl = fetch, now = Date.now, notifyRun, killSwitch = OFF_SWITCH }:
  { store: Pick<Store, 'getTenant' | 'getConfigVersion' | 'claimDelivery' | 'getDeliveryClaim' | 'listDeliveriesOf'>; rules: Pick<RoutineRuleStore, 'get'>;
    readToken: (name: string) => Promise<string | null>; fetchImpl?: typeof fetch; now?: () => number; killSwitch?: KillSwitch;
    notifyRun?: (installationId: number, repository: string, repositoryId: number, issue: number, url: string) => Promise<void> }): RoutineDispatcher {
  return async ({ installationId, deliveryId, eventName, payload }) => {
    if (eventName !== 'issues' || payload.action !== 'labeled') return null;
    const repositoryId = payload.repository?.id, repository = payload.repository?.full_name;
    const label = payload.label?.name, issue = payload.issue?.number;
    if (!Number.isSafeInteger(repositoryId) || typeof repository !== 'string' ||
        typeof label !== 'string' || !Number.isSafeInteger(issue) || Number(issue) <= 0) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(deliveryId)) return null;
    const tenant = await store.getTenant(installationId, { consistent: true });
    if (tenant?.status !== 'active' || tenant.disabledReason) return null;
    const candidate = await rules.get(installationId, routineId(repositoryId as number, label));
    const rule = candidate && candidate.repository.toLowerCase() === repository.toLowerCase() &&
      candidate.repositoryId === repositoryId && candidate.label === routineLabel(label) ? candidate : null;
    const duplicate = { disposition: 'deduped', status: 200 } as const;
    const filtered = (reason: string) => ({ disposition: 'filtered', status: 200, reason } as const);
    // Keep backend ownership independent of the launcher's short-lived execution lease. All
    // signed issue deliveries pass here, including those without a matching scheduled task.
    // Explicit console retries use a new delivery id and continue to use the original backend.
    const routingKey = `routine-route:${deliveryId}`;
    const owner = rule ? `routine:${rule.id}` : 'managed';
    const existing = await store.getDeliveryClaim(installationId, routingKey);
    if (existing && existing.jobId !== owner) return duplicate;
    if (!existing) {
      // Respect deliveries already started before this feature was deployed, including parked
      // native sign-in requests and completed jobs whose execution claim has expired.
      if (rule && (await store.getDeliveryClaim(installationId, deliveryId) ||
        (await store.listDeliveriesOf(installationId, deliveryId)).some((d) => d.disposition === 'launched' || d.reason === 'native_waiting_for_sign_in'))) return duplicate;
      if (!await store.claimDelivery(installationId, routingKey, now() + CLAIM_MS, owner)) {
        const winner = await store.getDeliveryClaim(installationId, routingKey);
        if (!winner) throw new Error('Delivery routing claim disappeared; retry the delivery');
        if (winner.jobId !== owner) return duplicate;
      }
    }
    if (!rule) return null;
    const sender = typeof payload.sender?.login === 'string' ? payload.sender.login.toLowerCase() : '';
    if (!rule.allowedActors.includes(sender)) return filtered('actor_not_allowed');
    if (await killSwitch.engaged()) return filtered('kill_switch');
    if (tenant.activeConfigVersion !== undefined) {
      const config = await store.getConfigVersion(installationId, tenant.activeConfigVersion, { consistent: true });
      if (!config?.dispatch) return filtered('no_rules');
      const repo = config.dispatch.repositories[repository.toLowerCase()];
      if (repo?.paused) return filtered('paused');
      const overlapping = repo?.triggers.filter((t) => t.label === routineLabel(label)) ?? [];
      if (overlapping.length && !overlapping.some((t) => (t.actors ?? repo?.actors ?? []).includes(sender))) return filtered('actor_not_allowed');
    }
    // A route can be replaced during a read. Read its exact immutable credential, and fail
    // closed if that revision was retired. Never pair the old URL with a replacement token.
    const token = await readToken(routineSecretName(installationId, rule.id, rule.credentialId)).catch(() => null);
    if (!token) return { disposition: 'routine_failed', status: 200, reason: 'trigger_token_unavailable' };
    // Also take the normal execution claim so a parked/resumed native job cannot race the fire.
    if (!await store.claimDelivery(installationId, deliveryId, now() + CLAIM_MS, `routine:${rule.id}`)) return duplicate;
    const context = [
      'Updraft Cloud received a verified GitHub issues.labeled event.',
      `Repository: ${repository}`, `Issue: #${issue}`, `Label: ${label}`,
      `GitHub issue URL: https://github.com/${repository}/issues/${issue}`,
      `GitHub delivery ID: ${deliveryId}`,
      'Use the saved task instructions and GitHub connection to decide what work to do.',
    ].join('\n');
    try {
      const result = await fireRoutine(rule, token, context, fetchImpl);
      if (result.kind === 'created') {
        if (notifyRun) await notifyRun(installationId, repository, repositoryId as number, issue as number, result.sessionUrl).catch(() => {});
        return { disposition: 'routine_triggered', status: 200, message: result.sessionUrl };
      }
      if (result.kind === 'rejected') return { disposition: 'routine_failed', status: 200, reason: `anthropic_http_${result.status}` };
      return { disposition: 'routine_unknown', status: 200, reason: 'unexpected_response' };
    } catch {
      return { disposition: 'routine_unknown', status: 200, reason: 'ambiguous_network_error' };
    }
  };
}
