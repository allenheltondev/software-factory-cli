import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createWebhookHandler } from './flows/webhook.js';
import { createSettingsLoader } from './github/settings.js';
import { createDynamoStore } from './store/dynamo.js';

/**
 * The GitHub webhook's Lambda entry point (dist/webhook.mjs): POST /api/webhooks/github, a route
 * with no authorizer. API Gateway passes a JSON body through as the exact string GitHub signed.
 */

const handleWebhook = createWebhookHandler({
  store: createDynamoStore(process.env.TABLE_NAME ?? ''),
  loadSettings: createSettingsLoader(),
});

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body ?? '');
  const res = await handleWebhook({ body, headers: event.headers ?? {} });
  return { statusCode: res.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(res.body) };
}
