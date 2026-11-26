import { isBenchmarkLabel } from '../benchmarks/config.js';
import type { GitHubApi } from '../github/client.js';
import { appJwt } from '../github/jwt.js';
import { verifySignature } from '../github/signature.js';
import type { LoadSettings } from '../github/settings.js';
import { errorClassOf, type Launcher } from '../jobs/launch.js';
import type { RoutineDispatcher } from '../routines/dispatch.js';
import { PULL_REQUEST_ACTIONS, pullRequestOfPayload } from '../tenants/dispatch.js';
import { deliveryFromLaunch, LIFECYCLE_EVENTS, type DeliveryEvent } from '../jobs/deliveries.js';
import type { DeliveryRecord, Store } from '../store/store.js';
import { isMentionEvent } from '../control/mentions.js';

/**
 * The GitHub webhook (POST /api/webhooks/github, no authorizer: the HMAC is the authentication).
 *
 * Jobs (#68): `issues.labeled` goes to the multi-tenant launcher (jobs/launch.ts), which starts a
 * job when the tenant's active config says so, and so do the events of the review loop:
 * `pull_request_review` and `pull_request` (dispatch.ts PULL_REQUEST_ACTIONS says which actions).
 *
 *   installation.deleted     tenant uninstalled, finally: everything in its partition gets the
 *                            table TTL for 30 days on, and reads stop at once when they pass. A
 *                            repeated delete keeps the first deadline. With no tenant yet, an
 *                            uninstalled one is recorded (a tombstone with the same TTL) so a
 *                            racing Connect or install callback cannot create it.
 *   installation.suspend /   GitHub can deliver events out of order, so these do not trust their
 *   installation.unsuspend   own order: the handler asks GitHub for the installation's state now
 *                            (gone, suspended or active) and records that. If GitHub cannot be
 *                            asked, the event's action is used. Neither ever overrides an
 *                            uninstall (a conditional write).
 *   installation_repositories  nothing stored yet: repositories are read live from GitHub
 *
 * Every other delivery for a tenant is recorded for its deliveries list (jobs/deliveries.ts, #71),
 * with what became of it.
 *
 * Installing the App on GitHub alone never creates a tenant; only a delete records one (the
 * tombstone above), and it can never become active.
 */

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface WebhookRequest {
  body: string;
  /** Header names in any case. */
  headers: Record<string, string | undefined>;
}

export interface WebhookResponse {
  status: number;
  body: { ok: boolean; disposition: string };
}

/**
 * A write that fails (a throttled table, a Lambda timeout mid-sweep) answers 500, so GitHub shows
 * the delivery as failed and it can be redelivered; every write here is safe to repeat.
 */
export function createWebhookHandler({
  store,
  github,
  loadSettings,
  launch,
  routines,
  benchmarkInstallationId,
  queueEvents,
  mentions,
  now = () => Date.now(),
  log = (m: string) => console.log(m),
}: {
  /** The admission queue's dispatcher (jobs/queue.ts): label removals and closes cancel queued work. */
  queueEvents?: Pick<import('../jobs/queue.js').QueueDispatcher, 'subjectChanged'>;
  /** Commands by mention (control/mentions.ts, #135): `issue_comment` and review comments. */
  mentions?: (event: import('../control/mentions.js').MentionEvent) => Promise<import('../control/mentions.js').MentionResult>;
  store: Store;
  github: Pick<GitHubApi, 'getInstallation'>;
  loadSettings: LoadSettings;
  /** Absent: no job is ever started (local development, tests of the lifecycle). */
  launch?: Launcher;
  /** A matched routine runs on Anthropic, without an Updraft microVM. */
  routines?: RoutineDispatcher;
  benchmarkInstallationId?: number;
  now?: () => number;
  log?: (message: string) => void;
}) {
  async function handle(req: WebhookRequest): Promise<WebhookResponse> {
    const header = (name: string) => {
      const key = Object.keys(req.headers).find((k) => k.toLowerCase() === name);
      return key ? req.headers[key] : undefined;
    };
    const settings = await loadSettings();
    if (!settings) return { status: 503, body: { ok: false, disposition: 'not_configured' } };
    if (!verifySignature(req.body, header('x-hub-signature-256'), settings.webhookSecret)) {
      return { status: 401, body: { ok: false, disposition: 'bad_signature' } };
    }

    const event = header('x-github-event') ?? '';
    const delivery = header('x-github-delivery') ?? '';
    let payload: {
      action?: unknown;
      installation?: { id?: unknown; account?: { id?: unknown; login?: unknown; type?: unknown } };
      repository?: { id?: unknown; full_name?: unknown };
      label?: { name?: unknown };
      sender?: { login?: unknown };
      issue?: { number?: unknown };
      pull_request?: { number?: unknown; head?: { ref?: unknown } };
      review?: { state?: unknown };
      check_suite?: { head_branch?: unknown; pull_requests?: unknown };
    };
    try {
      payload = JSON.parse(req.body) as typeof payload;
    } catch {
      return { status: 400, body: { ok: false, disposition: 'bad_json' } };
    }
    const action = typeof payload.action === 'string' ? payload.action : '';
    const installationId = Number(payload.installation?.id);

    const done = (disposition: string, status = 200) => {
      log(JSON.stringify({ delivery, event, action, installationId: installationId || undefined, disposition }));
      return { status, body: { ok: status < 300, disposition } };
    };

    const validInstallation = Number.isSafeInteger(installationId) && installationId > 0;
    const base: DeliveryEvent = {
      at: new Date(now()).toISOString(),
      deliveryId: delivery.slice(0, 64),
      event: event.slice(0, 64),
      ...(action ? { action: action.slice(0, 64) } : {}),
      ...(typeof payload.repository?.full_name === 'string' ? { repository: payload.repository.full_name.slice(0, 200) } : {}),
      ...(Number.isSafeInteger(payload.issue?.number) ? { issue: payload.issue!.number as number } : {}),
      ...((n) => (Number.isSafeInteger(n) ? { pullRequest: n as number } : {}))(pullRequestOfPayload(event, payload).number),
      ...(typeof payload.label?.name === 'string' ? { label: payload.label.name.slice(0, 100) } : {}),
      ...(typeof payload.sender?.login === 'string' ? { sender: payload.sender.login.slice(0, 100) } : {}),
    };
    // The tenant's deliveries list (#71). Never fails the delivery: it is for people to read.
    const record = async (d: DeliveryRecord | null) => {
      if (!d || !validInstallation) return;
      await store.recordDelivery(installationId, d).catch((err: unknown) => log(JSON.stringify({ delivery, warning: `could not record the delivery: ${(err as Error)?.name}` })));
    };

    if (event === 'ping') return done('pong');
    // A comment that may be a command (#135): a pause, a stop, a resume. Never a launch of its own.
    if (mentions && validInstallation && isMentionEvent(event, action)) {
      const result = await mentions({ installationId, deliveryId: delivery, eventName: event, payload: payload as Parameters<typeof mentions>[0]['payload'] });
      if (result.reason !== 'no_command') {
        if (result.disposition !== 'ignored' || result.reason === 'automated') {
          await record({ ...base, disposition: result.disposition === 'deduped' ? 'deduped' : 'filtered', ...(result.reason ? { reason: result.reason } : {}), ...(result.message ? { message: result.message } : {}) });
        }
        return done(result.reason ?? result.disposition);
      }
    }
    const launches = (event === 'issues' && action === 'labeled') || (Object.hasOwn(PULL_REQUEST_ACTIONS, event) && PULL_REQUEST_ACTIONS[event]!.includes(action));
    if (launches && ((validInstallation && installationId === benchmarkInstallationId) ||
      (event === 'issues' && isBenchmarkLabel(payload.label?.name)))) return done('not_dispatched');
    if (event === 'issues' && action === 'labeled' && validInstallation && routines) {
      const routed = await routines({ installationId, deliveryId: delivery, eventName: event, payload });
      if (routed) {
        await record({ ...base, disposition: routed.disposition,
          ...(routed.reason ? { reason: routed.reason } : {}),
          ...(routed.message ? { message: routed.message } : {}) });
        return done(routed.disposition, routed.status);
      }
    }
    if (launches && validInstallation && launch) {
      let result;
      try {
        result = await launch({ installationId, deliveryId: delivery, eventName: event, ...(settings.slug ? { appBot: `${settings.slug}[bot]` } : {}), body: req.body, payload });
      } catch (err) {
        // Failed before the launcher's own handling (the image version, the claim, the quota
        // reservation): listed for a known tenant, and still answered 500 so GitHub can redeliver.
        if (await store.getTenant(installationId).catch(() => null)) await record({ ...base, disposition: 'launch_failed', errorClass: errorClassOf(err) });
        throw err;
      }
      await record(deliveryFromLaunch(base, result));
      return done(result.disposition, result.status);
    }
    // A queued job's issue lost its trigger label or was closed: its queued work ends now, rather
    // than when capacity frees (admission checks both again in any case: jobs/queue.ts).
    if (event === 'issues' && (action === 'unlabeled' || action === 'closed') && validInstallation && queueEvents) {
      const repositoryId = payload.repository?.id;
      const issue = payload.issue?.number;
      const label = payload.label?.name;
      if (Number.isSafeInteger(repositoryId) && Number.isSafeInteger(issue) && (action === 'closed' || typeof label === 'string')) {
        const canceled = await queueEvents.subjectChanged(installationId, repositoryId as number, { issue: issue as number }, action === 'closed' ? { kind: 'closed' } : { kind: 'unlabeled', label: label as string });
        if (canceled) {
          await record({ ...base, disposition: 'filtered', reason: 'queue_canceled', message: action === 'closed' ? 'The issue was closed: its queued job was canceled' : 'The trigger label was removed: its queued job was canceled' });
          return done('queue_canceled');
        }
      }
    }
    if (!LIFECYCLE_EVENTS.has(event)) {
      // Work Updraft Cloud does not take (yet): listed for the tenant it was meant for.
      if (validInstallation && (await store.getTenant(installationId))) await record({ ...base, disposition: 'filtered', reason: 'event_not_accepted' });
      return done(event === 'issues' && action === 'labeled' && !launch ? 'jobs_not_configured' : 'ignored');
    }
    if (event !== 'installation' || !validInstallation) return done('ignored');

    const a = payload.installation?.account;
    const account =
      a && typeof a.login === 'string' ? { id: Number(a.id) || 0, login: a.login, type: typeof a.type === 'string' ? a.type : '' } : undefined;
    const uninstall = async () => {
      const result = await store.markUninstalled(installationId, now() + RETENTION_MS, account);
      // tombstone: no tenant yet. One is recorded already uninstalled, so a Connect or install
      // callback that checked GitHub just before this delete cannot create it afterwards.
      return done(result === 'marked' ? 'tenant_uninstalled' : result === 'already' ? 'already_uninstalled' : 'tombstone');
    };

    if (action === 'deleted') return uninstall();
    if (action !== 'suspend' && action !== 'unsuspend') return done('ignored');

    // Only tenants matter; skip the GitHub call for installations that were never onboarded.
    if (!(await store.getTenant(installationId))) return done('no_tenant');

    let suspended = action === 'suspend';
    try {
      const current = await github.getInstallation(appJwt(settings.appId, settings.privateKey, now()), installationId);
      if (!current) return uninstall();
      suspended = current.suspendedAt !== null;
    } catch (err) {
      log(JSON.stringify({ delivery, event, action, installationId, warning: `could not read the installation: ${String(err)}` }));
    }
    const result = await store.setSuspended(installationId, suspended);
    if (result === 'uninstalled') return done('already_uninstalled');
    if (result === 'no_tenant') return done('no_tenant');
    return done(suspended ? 'tenant_suspended' : 'tenant_active');
  }

  return async function safely(req: WebhookRequest): Promise<WebhookResponse> {
    try {
      return await handle(req);
    } catch (err) {
      log(JSON.stringify({ error: String(err) }));
      return { status: 500, body: { ok: false, disposition: 'error' } };
    }
  };
}
