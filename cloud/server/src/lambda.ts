import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handle } from 'hono/aws-lambda';
import { createApp } from './app.js';
import { callerFromClaims, type Claims } from './caller.js';
import { createGitHubFlows } from './flows/github.js';
import { createGitHubApi } from './github/client.js';
import { createSettingsLoader } from './github/settings.js';
import { createDynamoStore } from './store/dynamo.js';

/**
 * The API's Lambda entry point (bundled to dist/index.mjs by scripts/bundle.mjs). API Gateway (REST,
 * Cognito authorizer) invokes it with a proxy event; the authorizer's verified claims are on
 * `requestContext.authorizer.claims`.
 */

const clientId = process.env.USER_POOL_CLIENT_ID ?? '';
if (!clientId) console.error('USER_POOL_CLIENT_ID is not set; every /api/v1 request will be refused');
const tableName = process.env.TABLE_NAME ?? '';

const app = createApp({
  resolveCaller: (c) => {
    const event = (c.env as { event?: APIGatewayProxyEvent } | undefined)?.event;
    const claims = event?.requestContext?.authorizer?.claims as Claims | undefined;
    return callerFromClaims(claims, clientId);
  },
  ...(tableName
    ? { github: createGitHubFlows({ store: createDynamoStore(tableName), github: createGitHubApi(), loadSettings: createSettingsLoader() }) }
    : {}),
});

export const handler = handle(app);
