import type { Store } from '../store/store.js';
import { routineId, routineLabel, routineSecretName, type RoutineRule, type RoutineRuleStore } from './rules.js';

type Event = { action?: unknown; repository?: { id?: unknown; full_name?: unknown };
  label?: { name?: unknown }; issue?: { number?: unknown } };
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
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) return { kind: 'rejected', status: response.status };
  const body = await response.json().catch(() => null) as { claude_code_session_url?: unknown; type?: unknown } | null;
  return body?.type === 'routine_fire' && validSession(body.claude_code_session_url)
    ? { kind: 'created', sessionUrl: body.claude_code_session_url } : { kind: 'uncertain' };
}

export function createRoutineDispatcher({ store, rules, readToken, fetchImpl = fetch, now = Date.now, notifyRun }:
  { store: Pick<Store, 'getTenant' | 'claimDelivery'>; rules: Pick<RoutineRuleStore, 'get'>;
    readToken: (name: string) => Promise<string | null>; fetchImpl?: typeof fetch; now?: () => number;
    notifyRun?: (installationId: number, repository: string, issue: number, url: string) => Promise<void> }): RoutineDispatcher {
  return async ({ installationId, deliveryId, eventName, payload }) => {
    if (eventName !== 'issues' || payload.action !== 'labeled') return null;
    const repositoryId = payload.repository?.id, repository = payload.repository?.full_name;
    const label = payload.label?.name, issue = payload.issue?.number;
    if (!Number.isSafeInteger(repositoryId) || typeof repository !== 'string' ||
        typeof label !== 'string' || !Number.isSafeInteger(issue) || Number(issue) <= 0) return null;
    const rule = await rules.get(installationId, routineId(repositoryId as number, label));
    if (!rule || rule.repository.toLowerCase() !== repository.toLowerCase() ||
        rule.repositoryId !== repositoryId || rule.label !== routineLabel(label)) return null;
    const tenant = await store.getTenant(installationId, { consistent: true });
    if (tenant?.status !== 'active' || tenant.disabledReason) return { disposition: 'filtered', status: 200, reason: 'tenant_inactive' };

    // /fire has no idempotency key. A delivery is attempted at most once, including timeouts.
    const claimed = await store.claimDelivery(installationId, `routine-${deliveryId}`, now() + CLAIM_MS, rule.id);
    if (!claimed) return { disposition: 'deduped', status: 200 };
    const token = await readToken(routineSecretName(installationId, rule.id)).catch(() => null);
    if (!token) return { disposition: 'routine_failed', status: 200, reason: 'trigger_token_unavailable' };
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
        if (notifyRun) await notifyRun(installationId, repository, issue as number, result.sessionUrl).catch(() => {});
        return { disposition: 'routine_triggered', status: 200, message: result.sessionUrl };
      }
      if (result.kind === 'rejected') return { disposition: 'routine_failed', status: 200, reason: `anthropic_http_${result.status}` };
      return { disposition: 'routine_unknown', status: 200, reason: 'unexpected_response' };
    } catch {
      return { disposition: 'routine_unknown', status: 200, reason: 'ambiguous_network_error' };
    }
  };
}
