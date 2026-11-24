import type { NativeTrigger } from './native/route.js';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AdminAccess } from './admin/access.js';
import type { AdminService } from './admin/admin.js';
import type { Caller } from './caller.js';
import { safeMessage } from './tenants/redact.js';
import { FlowError, type GitHubFlows } from './flows/github.js';
import type { TenantLimits } from './store/store.js';
import type { RoutineService } from './routines/service.js';
import type { AgentKeyService } from './tenants/agent-key-service.js';
import type { StatusService } from './tenants/status-service.js';
import type { StatsService } from './tenants/stats-service.js';
import type { TelemetryService } from './tenants/telemetry-service.js';
import type { ConfigService, PublishOutcome } from './tenants/config-service.js';
import type { NativeSettingsService } from './native/settings.js';

/**
 * The API, mounted at /api because CloudFront forwards `/api/*` paths to API Gateway unchanged.
 *
 *   GET    /api/health                               unauthenticated (no authorizer on the route)
 *   GET    /api/v1/me                                the signed-in caller
 *   GET    /api/v1/github                            App configured? linked identity, tenants
 *   POST   /api/v1/github/link                       start linking: { url } on github.com
 *   DELETE /api/v1/github/link                       unlink the GitHub identity
 *   POST   /api/v1/github/install                    start installing the App: { url }
 *   POST   /api/v1/github/callback                   finish either: { code, state, installationId?, setupAction? }
 *   POST   /api/v1/github/connect/:id                connect an installation the last link offered
 *   GET    /api/v1/installations/:id/repositories    a tenant's repositories (members only)
 *
 * A tenant's configuration (tenants/config-service.ts), members only:
 *   GET    /api/v1/installations/:id/config          what the editor loads: settings, repositories, keys set
 *   POST   /api/v1/installations/:id/config/preview  { config }: the generated YAML, or every problem
 *   POST   /api/v1/installations/:id/config/publish  { config, baseVersion, confirmAutoMerge? }
 *   GET    /api/v1/installations/:id/config/versions             the history, newest first
 *   GET    /api/v1/installations/:id/config/versions/:v          one version's files
 *   POST   /api/v1/installations/:id/config/versions/:v/reactivate  { confirmAutoMerge? }: publish a copy
 *
 * A tenant's agent keys (tenants/agent-key-service.ts), members only. Values are write-only: no route returns one.
 *   GET    /api/v1/installations/:id/agent-keys          per key: configured, last rotated, last used OK/failed; recent refusals
 *   PUT    /api/v1/installations/:id/agent-keys/:name    { value }: checked with the provider, then saved (rotation replaces it)
 *
 * A tenant's status and diagnostics (tenants/status-service.ts), members only:
 *   GET    /api/v1/installations/:id/overview                   installation status, repositories, config, keys, activity
 *   GET    /api/v1/installations/:id/deliveries?limit=          recent webhook deliveries, one disposition each
 *   GET    /api/v1/installations/:id/jobs?limit=                recent jobs and how each ended
 *   GET    /api/v1/installations/:id/jobs/:jobId                one job, with its deliveries
 *   POST   /api/v1/installations/:id/jobs/:jobId/retry          run a job that did not finish its work again: 202 { jobId } of the new job
 *   GET    /api/v1/installations/:id/jobs/:jobId/logs/:name     the end of updraft.log or run.log
 *
 * A tenant's agent telemetry (tenants/telemetry-service.ts), members only. The key is write-only:
 *   GET    /api/v1/installations/:id/telemetry           settings, whether a key is set, where it sends, the last export
 *   PUT    /api/v1/installations/:id/telemetry           { enabled?, serviceName?, captureContent?, links? }
 *   PUT    /api/v1/installations/:id/telemetry/key       { value, region } (Honeycomb: checked with /1/auth), or
 *                                                        { provider: 'otlp', value, endpoint, header } or { provider: 'cloudwatch', value, awsRegion } (an empty export), then saved
 *   DELETE /api/v1/installations/:id/telemetry/key       telemetry is off until a new key is set
 *
 * A tenant's insights (tenants/stats-service.ts), members only:
 *   GET    /api/v1/installations/:id/insights?window=&repo=     `updraft stats` over the shared state: issues worked,
 *                                                               review findings, rounds, by repository and by model
 *
 * Admins only, the members of the stack's admin Cognito group (admin/access.ts; anyone else gets 403):
 *   GET    /api/v1/admin/tenants                     every tenant: quotas, usage, failures
 *   GET    /api/v1/admin/tenants/:id                 one tenant, with its recent and running jobs
 *   POST   /api/v1/admin/tenants/:id/disable         { reason? }: jobs stop at once
 *   POST   /api/v1/admin/tenants/:id/enable
 *   PUT    /api/v1/admin/tenants/:id/limits          { limits: { concurrentJobs?, jobsPerDay?, microvmMinutesPerMonth? } | null }
 *   POST   /api/v1/admin/jobs/:jobId/release         give back a job's capacity (its microVM is not running)
 *
 * Everything under /api/v1 needs a caller. How one is found depends on where the app runs
 * (`lambda.ts`: the Cognito authorizer's claims; `local.ts`: a token verified in process), so the
 * entry points pass `resolveCaller` in. The GitHub webhook is a separate function (webhook.ts).
 */

export type ResolveCaller = (c: Context) => Caller | null | Promise<Caller | null>;

export interface AppOptions {
  resolveCaller: ResolveCaller;
  github?: GitHubFlows;
  admin?: { access: AdminAccess; service: AdminService };
  config?: ConfigService;
  agentKeys?: AgentKeyService;
  routines?: RoutineService;
  nativeClaude?: NativeSettingsService;
  status?: StatusService;
  stats?: StatsService;
  telemetry?: TelemetryService;
  /** Logs unexpected errors. The response never carries their details. */
  logError?: (err: unknown) => void;
}

type Env = { Variables: { caller: Caller } };

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
const LIMIT_NAMES = ['concurrentJobs', 'jobsPerDay', 'microvmMinutesPerMonth'] as const;
const JOB_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Who did it, for the admin's actions: their email, else their sub. */
const adminName = (caller: Caller) => `admin:${caller.email ?? caller.sub}`;

export function createApp({ resolveCaller, github, admin, config, agentKeys, routines, nativeClaude, status, stats, telemetry, logError = (err) => console.error(safeMessage(err)) }: AppOptions) {
  const app = new Hono<Env>().basePath('/api');

  app.get('/health', (c) => c.json({ ok: true }));

  app.use('/v1/*', async (c, next) => {
    const caller = await resolveCaller(c);
    if (!caller) return c.json({ error: 'unauthorized' }, 401);
    c.set('caller', caller);
    await next();
  });

  app.get('/v1/me', async (c) => {
    const caller = c.get('caller');
    return c.json({ ...caller, admin: admin ? await admin.access.isAdmin(caller) : false });
  });

  if (admin) {
    const { access, service } = admin;
    const tenantId = (raw: string) => {
      const id = Number(raw);
      return Number.isSafeInteger(id) && id > 0 ? id : null;
    };
    app.use('/v1/admin/*', async (c, next) => {
      if (!(await access.isAdmin(c.get('caller')))) return c.json({ error: 'forbidden' }, 403);
      await next();
    });
    app.get('/v1/admin/tenants', async (c) => c.json(await service.listTenants()));
    app.get('/v1/admin/tenants/:id', async (c) => {
      const id = tenantId(c.req.param('id'));
      return id ? c.json(await service.tenant(id)) : c.json({ error: 'not_found' }, 404);
    });
    app.post('/v1/admin/tenants/:id/disable', async (c) => {
      const id = tenantId(c.req.param('id'));
      if (!id) return c.json({ error: 'not_found' }, 404);
      const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
      return c.json(await service.disable(id, adminName(c.get('caller')), str(body.reason)));
    });
    app.post('/v1/admin/tenants/:id/enable', async (c) => {
      const id = tenantId(c.req.param('id'));
      return id ? c.json(await service.enable(id, adminName(c.get('caller')))) : c.json({ error: 'not_found' }, 404);
    });
    app.put('/v1/admin/tenants/:id/limits', async (c) => {
      const id = tenantId(c.req.param('id'));
      if (!id) return c.json({ error: 'not_found' }, 404);
      let body: { limits?: unknown };
      try {
        body = (await c.req.json()) as { limits?: unknown };
      } catch {
        return c.json({ error: 'bad_request' }, 400);
      }
      if (body.limits !== null && (typeof body.limits !== 'object' || body.limits === undefined)) return c.json({ error: 'bad_request' }, 400);
      const given = body.limits as Record<string, unknown> | null;
      if (given && Object.keys(given).some((k) => !(LIMIT_NAMES as readonly string[]).includes(k))) {
        return c.json({ error: 'invalid_limits', message: `Limits are ${LIMIT_NAMES.join(', ')}` }, 400);
      }
      const limits = given
        ? (Object.fromEntries(Object.entries(given).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => [k, Number(v)])) as TenantLimits)
        : null;
      return c.json(await service.setLimits(id, adminName(c.get('caller')), limits));
    });
    app.put('/v1/admin/tenants/:id/job-finished-events', async (c) => {
      const id = tenantId(c.req.param('id'));
      if (!id) return c.json({ error: 'not_found' }, 404);
      const body = await c.req.json().catch(() => null) as { enabled?: unknown } | null;
      if (typeof body?.enabled !== 'boolean') return c.json({ error: 'bad_request' }, 400);
      return c.json(await service.setJobFinishedEvents(id, adminName(c.get('caller')), body.enabled));
    });
    app.post('/v1/admin/jobs/:jobId/release', async (c) => {
      const jobId = c.req.param('jobId');
      if (!JOB_ID.test(jobId)) return c.json({ error: 'not_found' }, 404);
      return c.json(await service.releaseJob(jobId, adminName(c.get('caller'))));
    });
  }

  if (github) {
    app.get('/v1/github', async (c) => c.json(await github.status(c.get('caller'))));
    app.post('/v1/github/link', async (c) => c.json(await github.startLink(c.get('caller'))));
    app.delete('/v1/github/link', async (c) => {
      await github.unlink(c.get('caller'));
      return c.json({ ok: true });
    });
    app.post('/v1/github/install', async (c) => c.json(await github.startInstall(c.get('caller'))));
    app.post('/v1/github/callback', async (c) => {
      let body: Record<string, unknown>;
      try {
        body = (await c.req.json()) as Record<string, unknown>;
      } catch {
        return c.json({ error: 'bad_request' }, 400);
      }
      const input = {
        ...(str(body.code) ? { code: str(body.code) } : {}),
        ...(str(body.state) ? { state: str(body.state) } : {}),
        ...(str(body.installationId) ? { installationId: str(body.installationId) } : {}),
        ...(str(body.setupAction) ? { setupAction: str(body.setupAction) } : {}),
      };
      return c.json(await github.completeCallback(c.get('caller'), input));
    });
    app.post('/v1/github/connect/:id', async (c) => {
      const id = Number(c.req.param('id'));
      if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: 'not_found' }, 404);
      return c.json(await github.connect(c.get('caller'), id));
    });
    app.get('/v1/installations/:id/repositories', async (c) => {
      const id = Number(c.req.param('id'));
      if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: 'not_found' }, 404);
      return c.json(await github.repositories(c.get('caller'), id));
    });
  }

  if (config) {
    const positive = (raw: string) => {
      const n = Number(raw);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    };
    const body = async (c: Context): Promise<Record<string, unknown> | null> => {
      try {
        const b = (await c.req.json()) as unknown;
        return typeof b === 'object' && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };
    // An invalid config is a 400 that carries every problem, with the field it is about.
    const outcome = (c: Context, out: PublishOutcome) => (out.ok ? c.json(out) : c.json({ error: 'invalid_config', errors: out.errors, warnings: out.warnings }, 400));
    const MAX_BODY = 4 * 1024 * 1024;
    const tooLarge = (c: Context) => Number(c.req.header('content-length') ?? 0) > MAX_BODY;

    app.get('/v1/installations/:id/config', async (c) => {
      const id = positive(c.req.param('id'));
      return id ? c.json(await config.load(c.get('caller'), id)) : c.json({ error: 'not_found' }, 404);
    });
    app.post('/v1/installations/:id/config/preview', async (c) => {
      const id = positive(c.req.param('id'));
      if (!id) return c.json({ error: 'not_found' }, 404);
      if (tooLarge(c)) return c.json({ error: 'too_large' }, 413);
      const b = await body(c);
      if (!b) return c.json({ error: 'bad_request' }, 400);
      return c.json(await config.preview(c.get('caller'), id, b.config));
    });
    app.post('/v1/installations/:id/config/publish', async (c) => {
      const id = positive(c.req.param('id'));
      if (!id) return c.json({ error: 'not_found' }, 404);
      if (tooLarge(c)) return c.json({ error: 'too_large' }, 413);
      const b = await body(c);
      if (!b) return c.json({ error: 'bad_request' }, 400);
      const base = b.baseVersion;
      if (base !== undefined && base !== null && positive(String(base)) === null) return c.json({ error: 'bad_request' }, 400);
      return outcome(
        c,
        await config.publish(c.get('caller'), id, {
          config: b.config,
          ...(base !== undefined ? { baseVersion: base === null ? null : Number(base) } : {}),
          confirmAutoMerge: b.confirmAutoMerge === true,
        }),
      );
    });
    app.get('/v1/installations/:id/config/versions', async (c) => {
      const id = positive(c.req.param('id'));
      return id ? c.json(await config.versions(c.get('caller'), id)) : c.json({ error: 'not_found' }, 404);
    });
    app.get('/v1/installations/:id/config/versions/:v', async (c) => {
      const id = positive(c.req.param('id'));
      const v = positive(c.req.param('v'));
      return id && v ? c.json(await config.version(c.get('caller'), id, v)) : c.json({ error: 'not_found' }, 404);
    });
    app.post('/v1/installations/:id/config/versions/:v/reactivate', async (c) => {
      const id = positive(c.req.param('id'));
      const v = positive(c.req.param('v'));
      if (!id || !v) return c.json({ error: 'not_found' }, 404);
      const b = (await body(c)) ?? {};
      return outcome(c, await config.reactivate(c.get('caller'), id, v, { confirmAutoMerge: b.confirmAutoMerge === true }));
    });
  }

  if (agentKeys) {
    const positive = (raw: string) => {
      const n = Number(raw);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    };
    app.get('/v1/installations/:id/agent-keys', async (c) => {
      const id = positive(c.req.param('id'));
      return id ? c.json(await agentKeys.list(c.get('caller'), id)) : c.json({ error: 'not_found' }, 404);
    });
    app.put('/v1/installations/:id/agent-keys/:name', async (c) => {
      const id = positive(c.req.param('id'));
      if (!id) return c.json({ error: 'not_found' }, 404);
      if (Number(c.req.header('content-length') ?? 0) > 4096) return c.json({ error: 'too_large' }, 413);
      let value: unknown;
      try {
        value = ((await c.req.json()) as { value?: unknown }).value;
      } catch {
        return c.json({ error: 'bad_request' }, 400);
      }
      return c.json(await agentKeys.set(c.get('caller'), id, c.req.param('name'), value));
    });
  }

  if (routines) {
    const positive = (raw: string) => {
      const n = Number(raw);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    };
    app.get('/v1/installations/:id/routines', async (c) => {
      const id = positive(c.req.param('id'));
      return id ? c.json(await routines.list(c.get('caller'), id)) : c.json({ error: 'not_found' }, 404);
    });
    app.put('/v1/installations/:id/routines', async (c) => {
      const id = positive(c.req.param('id'));
      if (!id) return c.json({ error: 'not_found' }, 404);
      if (Number(c.req.header('content-length') ?? 0) > 4096) return c.json({ error: 'too_large' }, 413);
      const input = await c.req.json().catch(() => null);
      return c.json(await routines.set(c.get('caller'), id, input));
    });
    app.delete('/v1/installations/:id/routines/:ruleId', async (c) => {
      const id = positive(c.req.param('id'));
      return id ? c.json(await routines.remove(c.get('caller'), id, c.req.param('ruleId'))) : c.json({ error: 'not_found' }, 404);
    });
  }

  if (nativeClaude) {
    const positive = (raw: string) => {
      const n = Number(raw);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    };
    app.get('/v1/installations/:id/claude-subscription', async (c) => {
      const id = positive(c.req.param('id'));
      return id ? c.json(await nativeClaude.view(c.get('caller'), id)) : c.json({ error: 'not_found' }, 404);
    });
    app.get('/v1/installations/:id/claude-subscription/requests/:requestId', async (c) => {
      const id = positive(c.req.param('id'));
      const requestId = c.req.param('requestId');
      if (!id || !/^job_[A-Za-z0-9_-]{16}$/.test(requestId)) return c.json({ error: 'not_found' }, 404);
      return c.json(await nativeClaude.waiting(c.get('caller'), id, requestId));
    });
    app.post('/v1/installations/:id/claude-subscription/requests/:requestId/start', async (c) => {
      const id = positive(c.req.param('id'));
      const requestId = c.req.param('requestId');
      if (!id || !/^job_[A-Za-z0-9_-]{16}$/.test(requestId)) return c.json({ error: 'not_found' }, 404);
      return c.json(await nativeClaude.start(c.get('caller'), id, requestId));
    });
    app.post('/v1/installations/:id/claude-subscription/restart', async (c) => {
      const id = positive(c.req.param('id'));
      return id ? c.json(await nativeClaude.restart(c.get('caller'), id)) : c.json({ error: 'not_found' }, 404);
    });
    app.post('/v1/installations/:id/claude-subscription/login', async (c) => {
      const id = positive(c.req.param('id'));
      if (!id) return c.json({ error: 'not_found' }, 404);
      c.header('Cache-Control', 'no-store');
      return c.json(await nativeClaude.login(c.get('caller'), id));
    });
    app.put('/v1/installations/:id/claude-subscription', async (c) => {
      const id = positive(c.req.param('id'));
      if (!id) return c.json({ error: 'not_found' }, 404);
      const input = (await c.req.json().catch(() => null)) as { enabled?: unknown; triggers?: unknown } | null;
      if (!input || typeof input.enabled !== 'boolean' || Object.keys(input).some((key) => key !== 'enabled' && key !== 'triggers')) return c.json({ error: 'bad_request' }, 400);
      const triggers = input.triggers;
      if (triggers !== undefined && (!Array.isArray(triggers) || triggers.length > 200 || triggers.some((t) =>
        !t || typeof t !== 'object' || Object.keys(t).sort().join(',') !== 'label,repository,repositoryId' ||
        !Number.isSafeInteger(t.repositoryId) || t.repositoryId <= 0 ||
        typeof t.repository !== 'string' || t.repository.length > 256 || !/^[\w.-]+\/[\w.-]+$/.test(t.repository) ||
        typeof t.label !== 'string' || !t.label.trim() || t.label.length > 100))) return c.json({ error: 'bad_request' }, 400);
      return c.json(await nativeClaude.update(c.get('caller'), id, input.enabled, triggers as NativeTrigger[] | undefined));
    });
  }

  if (status) {
    const positive = (raw: string) => {
      const n = Number(raw);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    };
    // Diagnostics change by the second: never cached on the way.
    app.use('/v1/installations/:id/*', async (c, next) => {
      await next();
      if (/\/(overview|deliveries|jobs)/.test(c.req.path)) c.header('Cache-Control', 'no-store');
    });
    app.get('/v1/installations/:id/overview', async (c) => {
      const id = positive(c.req.param('id'));
      return id ? c.json(await status.overview(c.get('caller'), id)) : c.json({ error: 'not_found' }, 404);
    });
    app.get('/v1/installations/:id/deliveries', async (c) => {
      const id = positive(c.req.param('id'));
      return id ? c.json(await status.deliveries(c.get('caller'), id, c.req.query('limit'))) : c.json({ error: 'not_found' }, 404);
    });
    app.get('/v1/installations/:id/jobs', async (c) => {
      const id = positive(c.req.param('id'));
      return id ? c.json(await status.jobs(c.get('caller'), id, c.req.query('limit'))) : c.json({ error: 'not_found' }, 404);
    });
    app.get('/v1/installations/:id/jobs/:jobId', async (c) => {
      const id = positive(c.req.param('id'));
      return id ? c.json(await status.job(c.get('caller'), id, c.req.param('jobId'))) : c.json({ error: 'not_found' }, 404);
    });
    app.post('/v1/installations/:id/jobs/:jobId/retry', async (c) => {
      const id = positive(c.req.param('id'));
      return id ? c.json(await status.retry(c.get('caller'), id, c.req.param('jobId')), 202) : c.json({ error: 'not_found' }, 404);
    });
    app.get('/v1/installations/:id/jobs/:jobId/logs/:name', async (c) => {
      const id = positive(c.req.param('id'));
      return id ? c.json(await status.log(c.get('caller'), id, c.req.param('jobId'), c.req.param('name'))) : c.json({ error: 'not_found' }, 404);
    });
  }

  if (telemetry) {
    const idOf = (c: Context) => {
      const n = Number(c.req.param('id'));
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    };
    const body = async (c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    app.get('/v1/installations/:id/telemetry', async (c) => {
      const id = idOf(c);
      return id ? c.json(await telemetry.view(c.get('caller'), id)) : c.json({ error: 'not_found' }, 404);
    });
    app.put('/v1/installations/:id/telemetry', async (c) => {
      const id = idOf(c);
      return id ? c.json(await telemetry.update(c.get('caller'), id, await body(c))) : c.json({ error: 'not_found' }, 404);
    });
    app.put('/v1/installations/:id/telemetry/key', async (c) => {
      const id = idOf(c);
      return id ? c.json(await telemetry.setKey(c.get('caller'), id, await body(c))) : c.json({ error: 'not_found' }, 404);
    });
    app.delete('/v1/installations/:id/telemetry/key', async (c) => {
      const id = idOf(c);
      return id ? c.json(await telemetry.removeKey(c.get('caller'), id)) : c.json({ error: 'not_found' }, 404);
    });
  }

  if (stats) {
    app.get('/v1/installations/:id/insights', async (c) => {
      const n = Number(c.req.param('id'));
      if (!Number.isSafeInteger(n) || n <= 0) return c.json({ error: 'not_found' }, 404);
      c.header('Cache-Control', 'no-store');
      return c.json(await stats.insights(c.get('caller'), n, { window: c.req.query('window'), repo: c.req.query('repo') }));
    });
  }

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    if (err instanceof FlowError) return c.json({ error: err.code, message: err.message }, err.status as ContentfulStatusCode);
    logError(err);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
