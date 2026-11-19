import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Caller } from './caller.js';
import { FlowError, type GitHubFlows } from './flows/github.js';

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
 *   GET    /api/v1/installations/:id/repositories    a tenant's repositories (members only)
 *
 * Everything under /api/v1 needs a caller. How one is found depends on where the app runs
 * (`lambda.ts`: the Cognito authorizer's claims; `local.ts`: a token verified in process), so the
 * entry points pass `resolveCaller` in. The GitHub webhook is a separate function (webhook.ts).
 */

export type ResolveCaller = (c: Context) => Caller | null | Promise<Caller | null>;

export interface AppOptions {
  resolveCaller: ResolveCaller;
  github?: GitHubFlows;
  /** Logs unexpected errors. The response never carries their details. */
  logError?: (err: unknown) => void;
}

type Env = { Variables: { caller: Caller } };

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);

export function createApp({ resolveCaller, github, logError = (err) => console.error(err) }: AppOptions) {
  const app = new Hono<Env>().basePath('/api');

  app.get('/health', (c) => c.json({ ok: true }));

  app.use('/v1/*', async (c, next) => {
    const caller = await resolveCaller(c);
    if (!caller) return c.json({ error: 'unauthorized' }, 401);
    c.set('caller', caller);
    await next();
  });

  app.get('/v1/me', (c) => c.json(c.get('caller')));

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
    app.get('/v1/installations/:id/repositories', async (c) => {
      const id = Number(c.req.param('id'));
      if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: 'not_found' }, 404);
      return c.json(await github.repositories(c.get('caller'), id));
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
