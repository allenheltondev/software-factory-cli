import type { GitHubApi } from '../github/client.js';
import { appJwt } from '../github/jwt.js';
import { verifySignature } from '../github/signature.js';
import type { LoadSettings } from '../github/settings.js';
import type { Store } from '../store/store.js';

/**
 * The GitHub webhook (POST /api/webhooks/github, no authorizer: the HMAC is the authentication).
 *
 * #67 handles the installation lifecycle only; issue and pull request events, which start jobs,
 * arrive with the multi-tenant launcher (#68) and are acknowledged without action until then.
 *
 *   installation.deleted     tenant uninstalled, finally: everything in its partition gets the
 *                            table TTL for 30 days on, and reads stop at once when they pass. A
 *                            repeated delete keeps the first deadline.
 *   installation.suspend /   GitHub can deliver events out of order, so these do not trust their
 *   installation.unsuspend   own order: the handler asks GitHub for the installation's state now
 *                            (gone, suspended or active) and records that. If GitHub cannot be
 *                            asked, the event's action is used. Neither ever overrides an
 *                            uninstall (a conditional write).
 *   installation_repositories  nothing stored yet: repositories are read live from GitHub
 *
 * An installation that was never onboarded has no tenant, so its events change nothing: installing
 * the App on GitHub alone never creates a tenant.
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
  now = () => Date.now(),
  log = (m: string) => console.log(m),
}: {
  store: Store;
  github: Pick<GitHubApi, 'getInstallation'>;
  loadSettings: LoadSettings;
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
    let payload: { action?: unknown; installation?: { id?: unknown } };
    try {
      payload = JSON.parse(req.body) as typeof payload;
    } catch {
      return { status: 400, body: { ok: false, disposition: 'bad_json' } };
    }
    const action = typeof payload.action === 'string' ? payload.action : '';
    const installationId = Number(payload.installation?.id);

    const done = (disposition: string) => {
      log(JSON.stringify({ delivery, event, action, installationId: installationId || undefined, disposition }));
      return { status: 200, body: { ok: true, disposition } };
    };

    if (event === 'ping') return done('pong');
    if (event !== 'installation' || !Number.isSafeInteger(installationId) || installationId <= 0) return done('ignored');

    const uninstall = async () => {
      const result = await store.markUninstalled(installationId, now() + RETENTION_MS);
      return done(result === 'marked' ? 'tenant_uninstalled' : result === 'already' ? 'already_uninstalled' : 'no_tenant');
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
