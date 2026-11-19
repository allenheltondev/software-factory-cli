import { Hono, type Context } from 'hono';
import type { Caller } from './caller.js';

/**
 * The API, mounted at /api because CloudFront forwards `/api/*` paths to API Gateway unchanged.
 *
 *   GET /api/health   unauthenticated (the API Gateway route has no authorizer)
 *   GET /api/v1/me    the signed-in caller
 *
 * Everything under /api/v1 needs a caller. How one is found depends on where the app runs
 * (`lambda.ts`: the Cognito authorizer's claims; `local.ts`: a token verified in process), so the
 * entry points pass `resolveCaller` in.
 */

export type ResolveCaller = (c: Context) => Caller | null | Promise<Caller | null>;

export interface AppOptions {
  resolveCaller: ResolveCaller;
  /** Logs unexpected errors. The response never carries their details. */
  logError?: (err: unknown) => void;
}

type Env = { Variables: { caller: Caller } };

export function createApp({ resolveCaller, logError = (err) => console.error(err) }: AppOptions) {
  const app = new Hono<Env>().basePath('/api');

  app.get('/health', (c) => c.json({ ok: true }));

  app.use('/v1/*', async (c, next) => {
    const caller = await resolveCaller(c);
    if (!caller) return c.json({ error: 'unauthorized' }, 401);
    c.set('caller', caller);
    await next();
  });

  app.get('/v1/me', (c) => c.json(c.get('caller')));

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    logError(err);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
