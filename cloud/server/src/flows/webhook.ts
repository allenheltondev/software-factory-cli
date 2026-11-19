import { verifySignature } from '../github/signature.js';
import type { LoadSettings } from '../github/settings.js';
import type { Store } from '../store/store.js';

/**
 * The GitHub webhook (POST /api/webhooks/github, no authorizer: the HMAC is the authentication).
 *
 * #67 handles the installation lifecycle only; issue and pull request events, which start jobs,
 * arrive with the multi-tenant launcher (#68) and are acknowledged without action until then.
 *
 *   installation.deleted     tenant disabled (uninstalled); its data is deleted after 30 days
 *   installation.suspend     tenant disabled (suspended)
 *   installation.unsuspend   tenant active again
 *   installation_repositories  nothing stored yet: repositories are read live from GitHub
 *
 * An installation that was never onboarded through /github/callback has no tenant, so its events
 * change nothing: installing the App on GitHub alone never creates a tenant.
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

export function createWebhookHandler({ store, loadSettings, now = () => Date.now(), log = (m: string) => console.log(m) }: {
  store: Store;
  loadSettings: LoadSettings;
  now?: () => number;
  log?: (message: string) => void;
}) {
  return async function handle(req: WebhookRequest): Promise<WebhookResponse> {
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
    if (event !== 'installation' || !Number.isSafeInteger(installationId)) return done('ignored');

    if (action === 'deleted') {
      const changed = await store.updateTenantStatus(installationId, {
        status: 'disabled',
        disabledReason: 'uninstalled',
        deleteAfter: now() + RETENTION_MS,
      });
      return done(changed ? 'tenant_uninstalled' : 'no_tenant');
    }
    if (action === 'suspend') {
      const changed = await store.updateTenantStatus(installationId, { status: 'disabled', disabledReason: 'suspended' });
      return done(changed ? 'tenant_suspended' : 'no_tenant');
    }
    if (action === 'unsuspend') {
      const tenant = await store.getTenant(installationId);
      if (!tenant) return done('no_tenant');
      if (tenant.disabledReason === 'uninstalled') return done('ignored');
      await store.updateTenantStatus(installationId, { status: 'active' });
      return done('tenant_active');
    }
    return done('ignored');
  };
}
