import type { GitHubApi } from '../github/client.js';
import { appJwt } from '../github/jwt.js';
import { verifySignature } from '../github/signature.js';
import type { LoadSettings } from '../github/settings.js';
import type { Launcher } from '../jobs/launch.js';
import type { Store } from '../store/store.js';

/**
 * The GitHub webhook (POST /api/webhooks/github, no authorizer: the HMAC is the authentication).
 *
 * Jobs (#68): `issues.labeled` goes to the multi-tenant launcher (jobs/launch.ts), which starts a
 * job when the tenant's active config says so. Pull request events are acknowledged without
 * action until the review loop comes to Updraft Cloud.
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
  now = () => Date.now(),
  log = (m: string) => console.log(m),
}: {
  store: Store;
  github: Pick<GitHubApi, 'getInstallation'>;
  loadSettings: LoadSettings;
  /** Absent: no job is ever started (local development, tests of the lifecycle). */
  launch?: Launcher;
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

    if (event === 'ping') return done('pong');
    if (event === 'issues') {
      if (action !== 'labeled' || !Number.isSafeInteger(installationId) || installationId <= 0) return done('ignored');
      if (!launch) return done('jobs_not_configured');
      const result = await launch({ installationId, deliveryId: delivery, body: req.body, payload });
      return done(result.disposition, result.status);
    }
    if (event !== 'installation' || !Number.isSafeInteger(installationId) || installationId <= 0) return done('ignored');

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
