import type { Caller } from '../caller.js';
import { FlowError, type GitHubFlows } from '../flows/github.js';
import type { Store, TelemetryExport, TelemetrySettings } from '../store/store.js';
import { agentKeySecretName, type SecretsPort } from './agent-keys.js';

/**
 * A tenant's agent telemetry in the console: jobs send traces of what their agents did, in the
 * OpenTelemetry GenAI semantic conventions, to the tenant's own Honeycomb, where Agent Timeline
 * shows each issue's implement run, reviews and revisions as one conversation.
 *
 *   view          the settings, whether a key is set (never the key), the Honeycomb team and
 *                 environment it belongs to, and how the last job's export went
 *   setKey        a Honeycomb ingest key (or a configuration key that may send events), checked
 *                 with Honeycomb's /1/auth before it is saved, in the region given. Saving the
 *                 first key turns telemetry on
 *   update        on or off, the service name (dataset), and whether content is recorded
 *   removeKey     deletes the key; telemetry is off until a new one is set
 *
 * The key is a secret like an agent key (`updraft/tenants/<id>/agent-keys/HONEYCOMB_API_KEY`), so
 * the API can write it and never read it, and only a job of this tenant can read it, through the
 * broker. The runner reads it as root; an agent never has it.
 */

export const TELEMETRY_KEY_NAME = 'HONEYCOMB_API_KEY';
export const telemetrySecretName = (installationId: number) => agentKeySecretName(installationId, TELEMETRY_KEY_NAME);

/** Honeycomb's API by region (docs.honeycomb.io/api). */
export const HONEYCOMB_API = { us: 'https://api.honeycomb.io', eu: 'https://api.eu1.honeycomb.io' } as const;
/** Honeycomb's UI by region, for links to a trace (docs.honeycomb.io/investigate/collaborate/share-trace). */
export const HONEYCOMB_UI = { us: 'https://ui.honeycomb.io', eu: 'https://ui-eu1.honeycomb.io' } as const;
export type Region = keyof typeof HONEYCOMB_API;

const SERVICE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
/** Ingest keys (hcxik_/hcaik_ + 58), configuration keys (22), classic keys (32 hex): one shape covers them. */
const KEY_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
const SLUG = /^[A-Za-z0-9_.-]{1,128}$/;

export interface HoneycombAuth {
  type: string;
  /** Whether the key may send events (an ingest key always may). */
  canSend: boolean;
  team?: { name: string; slug: string };
  environment?: { name: string; slug: string };
}
export type AuthCheck = { result: 'valid'; auth: HoneycombAuth } | { result: 'invalid' } | { result: 'unavailable' };
export type HoneycombChecker = (region: Region, key: string) => Promise<AuthCheck>;

/** GET /1/auth: "Any valid Honeycomb ingest or configuration API Key will work with this endpoint." */
export const checkHoneycombKey = (fetchFn: typeof fetch = fetch, timeoutMs = 8000): HoneycombChecker =>
  async (region, key) => {
    try {
      const res = await fetchFn(`${HONEYCOMB_API[region]}/1/auth`, { headers: { 'X-Honeycomb-Team': key }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 401 || res.status === 403) return { result: 'invalid' };
      if (!res.ok) return { result: 'unavailable' };
      const body = (await res.json()) as Record<string, unknown>;
      const access = (body.api_key_access ?? {}) as Record<string, unknown>;
      const named = (v: unknown) => {
        const o = (v ?? {}) as Record<string, unknown>;
        return typeof o.slug === 'string' && SLUG.test(o.slug) ? { name: String(o.name ?? o.slug).slice(0, 128), slug: o.slug } : undefined;
      };
      const type = typeof body.type === 'string' ? body.type.slice(0, 32) : 'unknown';
      const team = named(body.team);
      const environment = named(body.environment);
      return { result: 'valid', auth: { type, canSend: type === 'ingest' || access.events === true, ...(team ? { team } : {}), ...(environment ? { environment } : {}) } };
    } catch {
      return { result: 'unavailable' };
    }
  };

export interface TelemetryView {
  provider: 'honeycomb';
  enabled: boolean;
  region: Region;
  serviceName: string;
  captureContent: boolean;
  keyConfigured: boolean;
  key?: TelemetrySettings['key'];
  lastExport?: TelemetryExport & { traceUrl?: string };
  /** The Honeycomb environment's home, where AI Ecosystem → Conversations lists Agent Timeline's conversations. */
  environmentUrl?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export const DEFAULT_TELEMETRY: Omit<TelemetrySettings, 'updatedAt' | 'updatedBy'> = { provider: 'honeycomb', enabled: false, region: 'us', serviceName: 'updraft', captureContent: false };

export function telemetryView(s: TelemetrySettings | null): TelemetryView {
  const t = s ?? { ...DEFAULT_TELEMETRY, updatedAt: '', updatedBy: '' };
  return {
    provider: 'honeycomb',
    enabled: t.enabled && Boolean(t.key),
    region: t.region,
    serviceName: t.serviceName,
    captureContent: t.captureContent,
    keyConfigured: Boolean(t.key),
    ...(t.key ? { key: t.key } : {}),
    ...(t.lastExport ? { lastExport: withTraceUrl(t, t.lastExport) } : {}),
    ...(t.key?.team ? { environmentUrl: environmentUrl(t) } : {}),
    ...(t.updatedAt ? { updatedAt: t.updatedAt, updatedBy: t.updatedBy } : {}),
  };
}

/**
 * A link to a job's trace in Honeycomb: `<ui>/<team>/environments/<env>/trace?trace_id=...` with
 * the time range around it, or the Classic form with the dataset. Null without the slugs.
 */
export function traceUrl(s: Pick<TelemetrySettings, 'region' | 'serviceName' | 'key'> | null, traceId: string, startedAt: string, finishedAt?: string): string | null {
  if (!s?.key?.team || !/^[0-9a-f]{32}$/.test(traceId)) return null;
  const start = Math.floor(Date.parse(startedAt) / 1000);
  if (!Number.isFinite(start)) return null;
  const end = finishedAt && Number.isFinite(Date.parse(finishedAt)) ? Math.ceil(Date.parse(finishedAt) / 1000) : start + 6 * 3600;
  const q = `trace?trace_id=${traceId}&trace_start_ts=${start - 60}&trace_end_ts=${end + 300}`;
  const team = encodeURIComponent(s.key.team.slug);
  const env = s.key.environment?.slug;
  return env ? `${HONEYCOMB_UI[s.region]}/${team}/environments/${encodeURIComponent(env)}/${q}` : `${HONEYCOMB_UI[s.region]}/${team}/datasets/${encodeURIComponent(s.serviceName)}/${q}`;
}

const HOUR_MS = 3600 * 1000;

function withTraceUrl(s: TelemetrySettings, e: TelemetryExport): TelemetryExport & { traceUrl?: string } {
  if (!e.traceId) return e;
  // The export is recorded at the job's finish; a job runs a few hours at most.
  const url = traceUrl(s, e.traceId, new Date(Date.parse(e.at) - 6 * HOUR_MS).toISOString(), e.at);
  return url ? { ...e, traceUrl: url } : e;
}

function environmentUrl(s: TelemetrySettings): string {
  const team = encodeURIComponent(s.key!.team!.slug);
  const env = s.key?.environment?.slug;
  return env ? `${HONEYCOMB_UI[s.region]}/${team}/environments/${encodeURIComponent(env)}` : `${HONEYCOMB_UI[s.region]}/${team}`;
}

export interface TelemetryServiceDeps {
  store: Store;
  github: Pick<GitHubFlows, 'configContext' | 'member'>;
  secrets: SecretsPort;
  check: HoneycombChecker;
  now?: () => number;
}

export function createTelemetryService({ store, github, secrets, check, now = Date.now }: TelemetryServiceDeps) {
  const at = () => new Date(now()).toISOString();
  async function save(installationId: number, settings: TelemetrySettings): Promise<TelemetryView> {
    if ((await store.putTelemetry(installationId, settings)) === 'uninstalled') throw new FlowError('uninstalled', 409, 'This installation was uninstalled');
    return telemetryView(settings);
  }
  const current = async (installationId: number) => (await store.getTelemetry(installationId)) ?? { ...DEFAULT_TELEMETRY, updatedAt: '', updatedBy: '' };

  return {
    async view(caller: Caller, installationId: number): Promise<TelemetryView> {
      await github.member(caller, installationId);
      return telemetryView(await store.getTelemetry(installationId));
    },

    async setKey(caller: Caller, installationId: number, input: { value?: unknown; region?: unknown }): Promise<TelemetryView> {
      const ctx = await github.configContext(caller, installationId);
      const value = typeof input.value === 'string' ? input.value.trim() : '';
      if (!KEY_SHAPE.test(value)) throw new FlowError('invalid_key', 400, 'That does not look like a Honeycomb API key; nothing was changed');
      const before = await current(installationId);
      const region: Region = input.region === 'eu' ? 'eu' : input.region === 'us' ? 'us' : before.region;
      // The value is never repeated, in any message.
      const verdict = await check(region, value);
      if (verdict.result === 'invalid') throw new FlowError('invalid_key', 400, `Honeycomb (${region.toUpperCase()}) rejected that key; nothing was changed. Is it for the other region?`);
      if (verdict.result === 'unavailable') throw new FlowError('invalid_key', 400, 'Could not check the key with Honeycomb just now; nothing was changed, try again');
      if (!verdict.auth.canSend) throw new FlowError('invalid_key', 400, 'That key cannot send events. Use an Ingest key (Environment settings → API Keys in Honeycomb); nothing was changed');
      const tenant = await store.getTenant(installationId);
      if (!tenant || tenant.disabledReason === 'uninstalled') throw new FlowError('uninstalled', 409, 'This installation was uninstalled');
      await secrets.put(telemetrySecretName(installationId), value, { 'updraft:installation': String(installationId), 'updraft:key': TELEMETRY_KEY_NAME });
      const { team, environment, type } = verdict.auth;
      return save(installationId, {
        ...before,
        region,
        // The first key turns telemetry on; a rotation keeps what was chosen.
        enabled: before.key ? before.enabled : true,
        updatedAt: at(),
        updatedBy: ctx.githubLogin,
        key: { updatedAt: at(), updatedBy: ctx.githubLogin, type, ...(team ? { team } : {}), ...(environment ? { environment } : {}) },
      });
    },

    async update(caller: Caller, installationId: number, input: { enabled?: unknown; serviceName?: unknown; captureContent?: unknown }): Promise<TelemetryView> {
      const ctx = await github.configContext(caller, installationId);
      const before = await current(installationId);
      const next = { ...before };
      if (input.enabled !== undefined) {
        if (typeof input.enabled !== 'boolean') throw new FlowError('invalid_settings', 400, '`enabled` is true or false');
        if (input.enabled && !before.key) throw new FlowError('invalid_settings', 400, 'Add a Honeycomb key before turning telemetry on');
        next.enabled = input.enabled;
      }
      if (input.serviceName !== undefined) {
        if (typeof input.serviceName !== 'string' || !SERVICE_NAME.test(input.serviceName)) {
          throw new FlowError('invalid_settings', 400, 'The service name is 1 to 64 letters, digits, dots, dashes or underscores');
        }
        next.serviceName = input.serviceName;
      }
      if (input.captureContent !== undefined) {
        if (typeof input.captureContent !== 'boolean') throw new FlowError('invalid_settings', 400, '`captureContent` is true or false');
        next.captureContent = input.captureContent;
      }
      return save(installationId, { ...next, updatedAt: at(), updatedBy: ctx.githubLogin });
    },

    async removeKey(caller: Caller, installationId: number): Promise<TelemetryView> {
      const ctx = await github.configContext(caller, installationId);
      const before = await current(installationId);
      await secrets.remove(telemetrySecretName(installationId));
      const { key: _key, ...rest } = before;
      return save(installationId, { ...rest, enabled: false, updatedAt: at(), updatedBy: ctx.githubLogin });
    },
  };
}

export type TelemetryService = ReturnType<typeof createTelemetryService>;
