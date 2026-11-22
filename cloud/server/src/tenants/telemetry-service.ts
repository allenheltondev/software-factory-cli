import { randomUUID } from 'node:crypto';
import type { Caller } from '../caller.js';
import { FlowError, type GitHubFlows } from '../flows/github.js';
import type { Store, TelemetryExport, TelemetrySettings } from '../store/store.js';
import { agentKeySecretName, type SecretsPort } from './agent-keys.js';
import {
  CONVERSATION_LINK_PLACEHOLDERS,
  TRACE_LINK_PLACEHOLDERS,
  checkOtlpEndpoint,
  fillTemplate,
  headerNameProblem,
  headerValueOk,
  linkTemplateProblem,
  parseOtlpEndpoint,
  type OtlpChecker,
} from './otlp-destination.js';

/**
 * A tenant's agent telemetry in the console: jobs send traces of what their agents did, in the
 * OpenTelemetry GenAI semantic conventions, to the tenant's own tracing tool: the Honeycomb preset,
 * or any OTLP/HTTP endpoint that takes JSON (tenants/otlp-destination.ts).
 *
 *   view          the settings, whether a key is set (never the key), where it sends (Honeycomb's
 *                 team and environment, or the endpoint and header), and how the last export went
 *   setKey        the destination and its key, together. Honeycomb: an ingest key (or a
 *                 configuration key that may send events), checked with /1/auth in the region
 *                 given. OTLP: an endpoint, a header and its value, checked with an empty export.
 *                 Saving the first key turns telemetry on
 *   update        on or off, the service name, whether content is recorded, and a custom
 *                 destination's link templates
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
  provider: 'honeycomb' | 'otlp';
  enabled: boolean;
  /** A custom destination: where it sends, and the header the key goes in (never the key). */
  otlp?: { endpoint: string; header: string; host: string };
  /** A custom destination's link templates. */
  links?: { trace?: string; conversation?: string };
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
  const host = t.otlp ? parseOtlpEndpoint(t.otlp.endpoint) : null;
  return {
    provider: t.provider,
    enabled: t.enabled && Boolean(t.key),
    ...(t.provider === 'otlp' && t.otlp ? { otlp: { ...t.otlp, host: host && 'host' in host ? host.host : '' } } : {}),
    ...(t.links && (t.links.trace || t.links.conversation) ? { links: t.links } : {}),
    region: t.region,
    serviceName: t.serviceName,
    captureContent: t.captureContent,
    keyConfigured: Boolean(t.key),
    ...(t.key ? { key: (({ secretVersion: _v, ...k }) => k)(t.key) } : {}),
    ...(t.lastExport ? { lastExport: withTraceUrl(t, t.lastExport) } : {}),
    ...(t.provider === 'honeycomb' && t.key?.team ? { environmentUrl: environmentUrl(t) } : {}),
    ...(t.updatedAt ? { updatedAt: t.updatedAt, updatedBy: t.updatedBy } : {}),
  };
}

/** What a link is built from: the destination, and for a custom one its templates. */
export type LinkSettings = Pick<TelemetrySettings, 'region' | 'serviceName' | 'key'> & Partial<Pick<TelemetrySettings, 'provider' | 'links'>>;

/** The trace's time range, UNIX seconds: a minute before it started, five after it ended (six hours when it has not). */
function traceWindow(startedAt: string, finishedAt?: string): { start: number; end: number } | null {
  const start = Math.floor(Date.parse(startedAt) / 1000);
  if (!Number.isFinite(start)) return null;
  const end = finishedAt && Number.isFinite(Date.parse(finishedAt)) ? Math.ceil(Date.parse(finishedAt) / 1000) : start + 6 * 3600;
  return { start: start - 60, end: end + 300 };
}

/**
 * A link to a job's trace. Honeycomb: `<ui>/<team>/environments/<env>/trace?trace_id=...` with the
 * time range around it, or the Classic form with the dataset; with `spanId`, the trace opens at
 * that span (Honeycomb opens the root when it is not in the trace); null without the slugs. A
 * custom destination: its `links.trace` template; a span link only when it names {span_id}.
 */
export function traceUrl(s: LinkSettings | null, traceId: string, startedAt: string, finishedAt?: string, spanId?: string): string | null {
  if (!s?.key || !/^[0-9a-f]{32}$/.test(traceId)) return null;
  const w = traceWindow(startedAt, finishedAt);
  if (!w) return null;
  const span16 = spanId && /^[0-9a-f]{16}$/.test(spanId) ? spanId : undefined;
  if (s.provider === 'otlp') {
    const template = s.links?.trace;
    if (!template || (spanId !== undefined && (!span16 || !template.includes('{span_id}')))) return null;
    return fillTemplate(template, { trace_id: traceId, span_id: span16 ?? '', ...times(w), service: s.serviceName });
  }
  if (!s.key.team) return null;
  const span = span16 ? `&span=${span16}` : '';
  const q = `trace?trace_id=${traceId}${span}&trace_start_ts=${w.start}&trace_end_ts=${w.end}`;
  return `${place(s)}/${q}`;
}

const times = (w: { start: number; end: number }) => ({ start: String(w.start), end: String(w.end), start_ms: String(w.start * 1000), end_ms: String(w.end * 1000) });

/** The environment (or, Classic, the dataset) a link is in: `<ui>/<team>/environments/<env>` or `<ui>/<team>/datasets/<dataset>`. */
function place(s: Pick<TelemetrySettings, 'region' | 'serviceName' | 'key'>): string {
  const team = encodeURIComponent(s.key!.team!.slug);
  const env = s.key?.environment?.slug;
  return env ? `${HONEYCOMB_UI[s.region]}/${team}/environments/${encodeURIComponent(env)}` : `${HONEYCOMB_UI[s.region]}/${team}/datasets/${encodeURIComponent(s.serviceName)}`;
}

/**
 * How far around a job a conversation link looks: a conversation (an issue's implement run,
 * reviews and revisions) can start days before the job and go on days after it.
 */
export const CONVERSATION_WINDOW_S = 7 * 24 * 3600;

/** UNIX seconds: a week before the job started, to a week after it or now, whichever is first. */
function conversationWindow(startedAt: string, nowMs: number): { start: number; end: number } | null {
  const at = Math.floor(Date.parse(startedAt) / 1000);
  if (!Number.isFinite(at)) return null;
  const start = at - CONVERSATION_WINDOW_S;
  const end = Math.max(at + 3600, Math.min(at + CONVERSATION_WINDOW_S, Math.ceil(nowMs / 1000)));
  return { start, end };
}

/**
 * A link to a conversation's spans in Honeycomb's query builder, the documented way to share a
 * query (docs.honeycomb.io/investigate/collaborate/share-query): every span with this
 * `gen_ai.conversation.id`, broken down by agent. Selecting the conversation id in the results
 * opens it in Agent Timeline. Null without the team's slug.
 */
export function conversationUrl(s: LinkSettings | null, conversationId: string, startedAt: string, nowMs: number): string | null {
  if (!s?.key || !conversationId) return null;
  const w = conversationWindow(startedAt, nowMs);
  if (!w) return null;
  // A custom destination: its own template, when it has one.
  if (s.provider === 'otlp') return s.links?.conversation ? fillTemplate(s.links.conversation, { conversation: conversationId, ...times(w), service: s.serviceName }) : null;
  if (!s.key.team) return null;
  const query = {
    start_time: w.start,
    end_time: w.end,
    breakdowns: ['gen_ai.conversation.id', 'gen_ai.agent.name'],
    calculations: [{ op: 'COUNT' }, { op: 'COUNT_DISTINCT', column: 'trace.trace_id' }],
    filters: [{ column: 'gen_ai.conversation.id', op: '=', value: conversationId }],
  };
  // Classic has no environments: the dataset is already in the place.
  const dataset = s.key.environment?.slug ? `/datasets/${encodeURIComponent(s.serviceName)}` : '';
  return `${place(s)}${dataset}/?query=${encodeURIComponent(JSON.stringify(query))}`;
}

/**
 * Agent Timeline has no documented link to a conversation. A deployment that knows one can set
 * it as a template (HONEYCOMB_TIMELINE_URL), for example
 * `{ui}/{team}/environments/{environment}/<the path the UI uses>?conversation={conversation}`.
 * Placeholders: {ui} {team} {environment} {dataset} {conversation} {start} {end} ({start} and
 * {end} in UNIX seconds, the same window as the conversation's query). It must start with
 * `{ui}/{team}/`, so it can only point into the tenant's own Honeycomb team.
 */
export const TIMELINE_PLACEHOLDERS = ['ui', 'team', 'environment', 'dataset', 'conversation', 'start', 'end'] as const;

/** The template, when it is one a link can be made from; null (no Agent Timeline link) otherwise. */
export function parseTimelineTemplate(raw: string | undefined): string | null {
  const t = raw?.trim();
  if (!t || t.length > 512 || !t.startsWith('{ui}/{team}/')) return null;
  if (!/^[A-Za-z0-9{}/._~?&=%-]+$/.test(t)) return null;
  const names = [...t.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!);
  if (!names.every((n) => (TIMELINE_PLACEHOLDERS as readonly string[]).includes(n))) return null;
  // Every brace is part of a placeholder.
  if (t.replace(/\{[a-z]+\}/g, '').includes('{') || t.replace(/\{[a-z]+\}/g, '').includes('}')) return null;
  return names.includes('conversation') ? t : null;
}

/** A conversation in Agent Timeline, from a template parseTimelineTemplate accepted. Null when the template needs a slug the key did not give. */
export function timelineUrl(template: string | null, s: LinkSettings | null, conversationId: string, startedAt: string, nowMs: number): string | null {
  if (!template || s?.provider === 'otlp' || !s?.key?.team || !conversationId) return null;
  const w = conversationWindow(startedAt, nowMs);
  if (!w) return null;
  const env = s.key.environment?.slug;
  if (template.includes('{environment}') && !env) return null;
  const values: Record<string, string> = {
    ui: HONEYCOMB_UI[s.region],
    team: encodeURIComponent(s.key.team.slug),
    environment: encodeURIComponent(env ?? ''),
    dataset: encodeURIComponent(s.serviceName),
    conversation: encodeURIComponent(conversationId),
    start: String(w.start),
    end: String(w.end),
  };
  return template.replace(/\{([a-z]+)\}/g, (_, name: string) => values[name] ?? '');
}

/** `links` for a custom destination: each template checked, an empty one cleared. */
function linksOf(raw: unknown): { trace?: string; conversation?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new FlowError('invalid_settings', 400, '`links` is { trace?, conversation? }');
  const r = raw as Record<string, unknown>;
  const out: { trace?: string; conversation?: string } = {};
  for (const [name, allowed, required] of [
    ['trace', TRACE_LINK_PLACEHOLDERS, 'trace_id'],
    ['conversation', CONVERSATION_LINK_PLACEHOLDERS, 'conversation'],
  ] as const) {
    const v = r[name];
    if (v === undefined || v === null || v === '') continue;
    const problem = linkTemplateProblem(v, allowed, required);
    if (problem) throw new FlowError('invalid_settings', 400, `The ${name} link: ${problem}`);
    out[name] = v as string;
  }
  return out;
}

const HOUR_MS = 3600 * 1000;
/** How long a key change may hold the settings: a Honeycomb check and two writes, with room to spare. */
export const KEY_CHANGE_LEASE_MS = 2 * 60 * 1000;
const NOT_OURS = new Error('not our lease');

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
  /** A custom destination's check: an empty export with the header. */
  checkOtlp?: OtlpChecker;
  now?: () => number;
}

export function createTelemetryService({ store, github, secrets, check, checkOtlp = checkOtlpEndpoint(), now = Date.now }: TelemetryServiceDeps) {
  const at = () => new Date(now()).toISOString();
  const current = async (installationId: number): Promise<TelemetrySettings> =>
    (await store.getTelemetry(installationId)) ?? { ...DEFAULT_TELEMETRY, updatedAt: '', updatedBy: '' };

  /**
   * Applies `change` to the settings as they are now and writes them over that version only; on
   * a conflict (another member saved in between) it reads again and reapplies the change. A
   * change names only the fields it sets, so it never undoes someone else's (an opt-out made
   * while a key was being checked stays an opt-out).
   */
  async function mutate(installationId: number, change: (latest: TelemetrySettings) => TelemetrySettings): Promise<TelemetryView> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const latest = await current(installationId);
      const next = change(latest);
      const out = await store.putTelemetry(installationId, next, latest.version ?? 0);
      if (out === 'uninstalled') throw new FlowError('uninstalled', 409, 'This installation was uninstalled');
      if (out === 'stored') return telemetryView({ ...next, version: (latest.version ?? 0) + 1 });
    }
    throw new FlowError('invalid_settings', 409, 'Someone else is changing these settings right now; reload and try again');
  }

  /** Takes the key-change lease, or says another change is under way. */
  async function acquire(installationId: number): Promise<string> {
    const id = randomUUID();
    await mutate(installationId, (latest) => {
      if (latest.keyChange && latest.keyChange.until > now()) {
        throw new FlowError('invalid_settings', 409, 'Another change to the telemetry key is under way; try again in a moment');
      }
      return { ...latest, keyChange: { id, until: now() + KEY_CHANGE_LEASE_MS } };
    });
    return id;
  }

  /** Gives the lease back after a change that did not finish; nothing when it is no longer ours. */
  async function release(installationId: number, lease: string): Promise<void> {
    try {
      await mutate(installationId, (latest) => {
        if (latest.keyChange?.id !== lease) throw NOT_OURS;
        const { keyChange: _lease, ...rest } = latest;
        return rest;
      });
    } catch {
      // Not ours any more, or the write failed: the lease runs out on its own.
    }
  }

  const lost = () => new FlowError('invalid_settings', 409, 'The key change took too long and another one may have started; check the key and try again');

  /**
   * A custom destination and its key, together: the endpoint and header are checked, then the
   * endpoint with an empty export carrying the header, and saved in the same write as the key's
   * version. A destination never changes without its key, so a key is only sent where it was checked.
   */
  async function setOtlpKey(caller: Caller, installationId: number, input: { value?: unknown; endpoint?: unknown; header?: unknown }): Promise<TelemetryView> {
    const ctx = await github.configContext(caller, installationId);
    const parsed = parseOtlpEndpoint(input.endpoint);
    if ('problem' in parsed) throw new FlowError('invalid_key', 400, `${parsed.problem}; nothing was changed`);
    const header = typeof input.header === 'string' ? input.header.trim().toLowerCase() : '';
    const headerProblem = headerNameProblem(header);
    if (headerProblem) throw new FlowError('invalid_key', 400, `${headerProblem}; nothing was changed`);
    const value = typeof input.value === 'string' ? input.value.trim() : '';
    if (!headerValueOk(value)) throw new FlowError('invalid_key', 400, 'The header value is 8 to 4096 printable characters, on one line; nothing was changed');
    const lease = await acquire(installationId);
    let done = false;
    try {
      // The value is never repeated, in any message.
      const verdict = await checkOtlp({ tracesUrl: parsed.tracesUrl, host: parsed.host, header }, value);
      if (verdict.result === 'invalid') throw new FlowError('invalid_key', 400, `${parsed.host} refused that key; nothing was changed`);
      if (verdict.result === 'not_otlp') throw new FlowError('invalid_key', 400, `${parsed.host} answered HTTP ${verdict.status} to an empty OTLP/HTTP JSON export: is this its OTLP endpoint, and does it take JSON? Nothing was changed`);
      if (verdict.result === 'unreachable') throw new FlowError('invalid_key', 400, `Could not check ${parsed.host}: ${verdict.reason}. Nothing was changed`);
      const tenant = await store.getTenant(installationId);
      if (!tenant || tenant.disabledReason === 'uninstalled') throw new FlowError('uninstalled', 409, 'This installation was uninstalled');
      const written = await secrets.put(telemetrySecretName(installationId), value, { 'updraft:installation': String(installationId), 'updraft:key': TELEMETRY_KEY_NAME });
      const key = { updatedAt: at(), updatedBy: ctx.githubLogin, ...(written?.versionId ? { secretVersion: written.versionId } : {}), type: 'otlp' };
      const view = await mutate(installationId, (latest) => {
        if (latest.keyChange?.id !== lease) throw lost();
        const { keyChange: _lease, ...rest } = latest;
        return { ...rest, provider: 'otlp', otlp: { endpoint: parsed.endpoint, header }, key, enabled: latest.key ? latest.enabled : true, updatedAt: at(), updatedBy: ctx.githubLogin };
      });
      done = true;
      return view;
    } finally {
      if (!done) await release(installationId, lease);
    }
  }

  return {
    async view(caller: Caller, installationId: number): Promise<TelemetryView> {
      await github.member(caller, installationId);
      return telemetryView(await store.getTelemetry(installationId));
    },

    async setKey(caller: Caller, installationId: number, input: { provider?: unknown; value?: unknown; region?: unknown; endpoint?: unknown; header?: unknown }): Promise<TelemetryView> {
      if (input.provider === 'otlp') return setOtlpKey(caller, installationId, input);
      if (input.provider !== undefined && input.provider !== 'honeycomb') throw new FlowError('invalid_key', 400, '`provider` is honeycomb or otlp; nothing was changed');
      const ctx = await github.configContext(caller, installationId);
      const value = typeof input.value === 'string' ? input.value.trim() : '';
      if (!KEY_SHAPE.test(value)) throw new FlowError('invalid_key', 400, 'That does not look like a Honeycomb API key; nothing was changed');
      // One key change at a time: the secret and the row are two stores, changed in order under the lease.
      const lease = await acquire(installationId);
      let done = false;
      try {
        const region: Region = input.region === 'eu' ? 'eu' : input.region === 'us' ? 'us' : (await current(installationId)).region;
        // The value is never repeated, in any message.
        const verdict = await check(region, value);
        if (verdict.result === 'invalid') throw new FlowError('invalid_key', 400, `Honeycomb (${region.toUpperCase()}) rejected that key; nothing was changed. Is it for the other region?`);
        if (verdict.result === 'unavailable') throw new FlowError('invalid_key', 400, 'Could not check the key with Honeycomb just now; nothing was changed, try again');
        if (!verdict.auth.canSend) throw new FlowError('invalid_key', 400, 'That key cannot send events. Use an Ingest key (Environment settings → API Keys in Honeycomb); nothing was changed');
        const tenant = await store.getTenant(installationId);
        if (!tenant || tenant.disabledReason === 'uninstalled') throw new FlowError('uninstalled', 409, 'This installation was uninstalled');
        // The secret first, then the row naming its version. Stopped between the two, the row still
        // names the version before (kept as AWSPREVIOUS), which matches the row's region and team.
        const written = await secrets.put(telemetrySecretName(installationId), value, { 'updraft:installation': String(installationId), 'updraft:key': TELEMETRY_KEY_NAME });
        const { team, environment, type } = verdict.auth;
        const key = {
          updatedAt: at(),
          updatedBy: ctx.githubLogin,
          ...(written?.versionId ? { secretVersion: written.versionId } : {}),
          type,
          ...(team ? { team } : {}),
          ...(environment ? { environment } : {}),
        };
        // Read after the check, not before it: only the region and the key change, and the first key
        // turns sending on. Whether it sends, and with content, stay what the latest save said.
        const view = await mutate(installationId, (latest) => {
          if (latest.keyChange?.id !== lease) throw lost();
          const { keyChange: _lease, otlp: _otlp, ...rest } = latest;
          return { ...rest, provider: 'honeycomb', region, key, enabled: latest.key ? latest.enabled : true, updatedAt: at(), updatedBy: ctx.githubLogin };
        });
        done = true;
        return view;
      } finally {
        if (!done) await release(installationId, lease);
      }
    },

    async update(caller: Caller, installationId: number, input: { enabled?: unknown; serviceName?: unknown; captureContent?: unknown; links?: unknown }): Promise<TelemetryView> {
      const ctx = await github.configContext(caller, installationId);
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new FlowError('invalid_settings', 400, '`enabled` is true or false');
      if (input.serviceName !== undefined && (typeof input.serviceName !== 'string' || !SERVICE_NAME.test(input.serviceName))) {
        throw new FlowError('invalid_settings', 400, 'The service name is 1 to 64 letters, digits, dots, dashes or underscores');
      }
      if (input.captureContent !== undefined && typeof input.captureContent !== 'boolean') throw new FlowError('invalid_settings', 400, '`captureContent` is true or false');
      const links = input.links === undefined ? undefined : linksOf(input.links);
      return mutate(installationId, (latest) => {
        if (input.enabled === true && !latest.key) throw new FlowError('invalid_settings', 400, 'Add a destination and its key before turning telemetry on');
        return {
          ...latest,
          ...(links !== undefined ? { links } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled as boolean } : {}),
          ...(input.serviceName !== undefined ? { serviceName: input.serviceName as string } : {}),
          ...(input.captureContent !== undefined ? { captureContent: input.captureContent as boolean } : {}),
          updatedAt: at(),
          updatedBy: ctx.githubLogin,
        };
      });
    },

    async removeKey(caller: Caller, installationId: number): Promise<TelemetryView> {
      const ctx = await github.configContext(caller, installationId);
      const lease = await acquire(installationId);
      try {
        // The row first, keeping the lease: from then on no job is handed the key, and no other key
        // change can start until the secret is gone too. Stopped between the two, the secret is left
        // unreferenced (the next save replaces it, the uninstall cleanup deletes it), never
        // referenced and gone.
        const view = await mutate(installationId, (latest) => {
          if (latest.keyChange?.id !== lease) throw lost();
          const { key: _key, ...rest } = latest;
          return { ...rest, enabled: false, updatedAt: at(), updatedBy: ctx.githubLogin };
        });
        await secrets.remove(telemetrySecretName(installationId));
        return view;
      } finally {
        // Only now may a save write a new version: the delete can no longer take it with it.
        await release(installationId, lease);
      }
    },
  };
}

export type TelemetryService = ReturnType<typeof createTelemetryService>;
