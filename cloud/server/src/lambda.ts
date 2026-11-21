import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { handle } from 'hono/aws-lambda';
import { adminAccess, DEFAULT_ADMIN_GROUP } from './admin/access.js';
import { createAdminService } from './admin/admin.js';
import { createApp } from './app.js';
import { callerFromClaims, groupsFrom, type Claims } from './caller.js';
import { createGitHubFlows } from './flows/github.js';
import { createGitHubApi } from './github/client.js';
import { createSettingsLoader } from './github/settings.js';
import { quotasFromEnv } from './jobs/quotas.js';
import { createDynamoStore } from './store/dynamo.js';
import { createAgentKeyService } from './tenants/agent-key-service.js';
import { createSecretsManagerPort } from './tenants/secrets-manager.js';
import { checkAgentKeyWithProvider } from './tenants/key-check.js';
import { createConfigService, type ObjectStore } from './tenants/config-service.js';

/**
 * The API's Lambda entry point (bundled to dist/index.mjs by scripts/bundle.mjs). API Gateway (REST,
 * Cognito authorizer) invokes it with a proxy event; the authorizer's verified claims are on
 * `requestContext.authorizer.claims`. Those are all strings, so the caller's groups (what admin
 * access is decided by) come from verifying the same ID token here, where `cognito:groups` is the
 * token's own array and each group name is exact.
 */

const clientId = process.env.USER_POOL_CLIENT_ID ?? '';
if (!clientId) console.error('USER_POOL_CLIENT_ID is not set; every /api/v1 request will be refused');
const userPoolId = process.env.USER_POOL_ID ?? '';
const verifier = userPoolId && clientId ? CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'id' }) : null;
const tableName = process.env.TABLE_NAME ?? '';
const store = tableName ? createDynamoStore(tableName) : undefined;
const github = store ? createGitHubFlows({ store, github: createGitHubApi(), loadSettings: createSettingsLoader() }) : undefined;

// Tenant config bundles (tenants/config-service.ts). The function's role reaches only
// tenants/*/config/* in the bucket (template.yaml).
const bucket = process.env.TENANT_BUCKET ?? '';
const s3 = new S3Client({});
const objects: ObjectStore = {
  async get(key) {
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return (await out.Body?.transformToString('utf8')) ?? null;
  },
  async put(key, body, contentType) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  },
};

const app = createApp({
  resolveCaller: async (c) => {
    const event = (c.env as { event?: APIGatewayProxyEvent } | undefined)?.event;
    const claims = event?.requestContext?.authorizer?.claims as Claims | undefined;
    const caller = callerFromClaims(claims, clientId);
    if (!caller || !verifier) return caller;
    // The same token the authorizer accepted; a token that does not verify, or is someone else's,
    // leaves the caller with no groups (no admin access), never without a session.
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    try {
      const payload = await verifier.verify(token);
      if (payload.sub === caller.sub) {
        const groups = groupsFrom(payload['cognito:groups']);
        if (groups.length > 0) caller.groups = groups;
      }
    } catch {
      // No groups.
    }
    return caller;
  },
  ...(store && github
    ? {
        github,
        agentKeys: createAgentKeyService({ store, github, secrets: createSecretsManagerPort(), check: checkAgentKeyWithProvider() }),
        ...(bucket ? { config: createConfigService({ store, github, objects }) } : {}),
        admin: {
          access: adminAccess(process.env.ADMIN_GROUP ?? DEFAULT_ADMIN_GROUP),
          service: createAdminService({ store, quotas: quotasFromEnv(process.env) }),
        },
      }
    : {}),
});

export const handler = handle(app);
