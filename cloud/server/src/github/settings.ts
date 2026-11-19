import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';

/**
 * The Updraft GitHub App's settings, read at runtime rather than through the template, because
 * the stack deploys before the App exists (scripts/register-github-app.mjs writes them once it
 * does). Until then every GitHub route answers 503 github_app_not_configured.
 *
 *   SSM             /updraft/app/id, /updraft/app/client-id, /updraft/app/slug, /updraft/app/url
 *   Secrets Manager updraft/app/private-key, updraft/app/client-secret, updraft/app/webhook-secret
 */

export interface AppSettings {
  appId: string;
  clientId: string;
  slug: string;
  /** Where this deployment serves the SPA, e.g. https://updraft.readysetcloud.io (no trailing slash). */
  appUrl: string;
  privateKey: string;
  clientSecret: string;
  webhookSecret: string;
}

export type LoadSettings = () => Promise<AppSettings | null>;

export const SSM_PREFIX = '/updraft/app/';
export const SECRET_PREFIX = 'updraft/app/';
const CACHE_MS = 5 * 60 * 1000;

export function createSettingsLoader({
  ssm = new SSMClient({}),
  secrets = new SecretsManagerClient({}),
  now = () => Date.now(),
}: { ssm?: SSMClient; secrets?: SecretsManagerClient; now?: () => number } = {}): LoadSettings {
  let cached: { at: number; value: AppSettings | null } | null = null;

  async function secret(name: string): Promise<string | undefined> {
    try {
      const out = await secrets.send(new GetSecretValueCommand({ SecretId: `${SECRET_PREFIX}${name}` }));
      return out.SecretString || undefined;
    } catch (err) {
      if ((err as { name?: string }).name === 'ResourceNotFoundException') return undefined;
      throw err;
    }
  }

  async function load(): Promise<AppSettings | null> {
    const names = ['id', 'client-id', 'slug', 'url'].map((n) => `${SSM_PREFIX}${n}`);
    const out = await ssm.send(new GetParametersCommand({ Names: names }));
    const param = (n: string) => out.Parameters?.find((p) => p.Name === `${SSM_PREFIX}${n}`)?.Value;
    const [privateKey, clientSecret, webhookSecret] = await Promise.all([
      secret('private-key'),
      secret('client-secret'),
      secret('webhook-secret'),
    ]);
    const appId = param('id');
    const clientId = param('client-id');
    const slug = param('slug');
    const appUrl = param('url')?.replace(/\/+$/, '');
    if (!appId || !clientId || !slug || !appUrl || !privateKey || !clientSecret || !webhookSecret) return null;
    return { appId, clientId, slug, appUrl, privateKey, clientSecret, webhookSecret };
  }

  return async () => {
    // A missing App is re-checked every call, so registering it takes effect at once.
    if (cached?.value && now() - cached.at < CACHE_MS) return cached.value;
    const value = await load();
    cached = { at: now(), value };
    return value;
  };
}
