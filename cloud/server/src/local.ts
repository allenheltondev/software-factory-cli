import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { createApp } from './app.js';
import { callerFromClaims, type Claims } from './caller.js';

/**
 * Local API server on port 8787. The SPA's Vite dev server proxies /api here.
 *
 * There is no API Gateway locally, so this verifies the ID token itself, against the same pool
 * and client the deployed stack uses. They come from USER_POOL_ID / USER_POOL_CLIENT_ID, or from
 * app/public/auth-config.json, which `make dev-auth-config` writes from a deployed stack.
 */

function devAuthConfig(): { userPoolId?: string; clientId?: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    return JSON.parse(readFileSync(join(here, '..', '..', 'app', 'public', 'auth-config.json'), 'utf8')) as {
      userPoolId?: string;
      clientId?: string;
    };
  } catch {
    return {};
  }
}

const fileConfig = devAuthConfig();
const userPoolId = process.env.USER_POOL_ID ?? fileConfig.userPoolId ?? '';
const clientId = process.env.USER_POOL_CLIENT_ID ?? fileConfig.clientId ?? '';
if (!userPoolId || !clientId) {
  console.warn('local: no user pool configured (run `make dev-auth-config`); /api/v1 will answer 401');
}

const verifier = userPoolId && clientId ? CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'id' }) : null;

const app = createApp({
  resolveCaller: async (c) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.replace(/^Bearer\s+/i, '');
    if (!verifier || !token) return null;
    try {
      return callerFromClaims((await verifier.verify(token)) as unknown as Claims, clientId);
    } catch {
      return null;
    }
  },
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`local: API on http://localhost:${port}/api`));
