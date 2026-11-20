import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The Lambda entry point against the event shape API Gateway REST sends: CloudFront forwards
 * `/api/...` unchanged and OriginPath adds the stage, so the function sees `path: /api/...`, with
 * the Cognito authorizer's claims (all strings) on requestContext.authorizer.claims.
 */

const CLIENT = 'client-abc';
let handler: (event: APIGatewayProxyEvent, context: Context) => Promise<APIGatewayProxyResult>;

beforeAll(async () => {
  process.env.USER_POOL_CLIENT_ID = CLIENT;
  ({ handler } = (await import('./lambda.js')) as unknown as { handler: typeof handler });
});

function restEvent(path: string, claims?: Record<string, string>): APIGatewayProxyEvent {
  return {
    resource: '/api/v1/{proxy+}',
    path,
    httpMethod: 'GET',
    headers: { Host: 'abc123.execute-api.us-east-1.amazonaws.com' },
    multiValueHeaders: { Host: ['abc123.execute-api.us-east-1.amazonaws.com'] },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    body: null,
    isBase64Encoded: false,
    requestContext: {
      accountId: '123456789012',
      apiId: 'abc123',
      authorizer: claims ? { claims } : null,
      httpMethod: 'GET',
      identity: { sourceIp: '203.0.113.1' },
      path: `/prod${path}`,
      protocol: 'HTTP/1.1',
      requestId: 'req-1',
      requestTimeEpoch: 0,
      resourceId: 'r1',
      resourcePath: '/api/v1/{proxy+}',
      stage: 'prod',
    },
  } as unknown as APIGatewayProxyEvent;
}

const context = {} as Context;

describe('lambda handler', () => {
  it('returns the caller from the authorizer claims', async () => {
    const res = await handler(restEvent('/api/v1/me', { sub: 'u1', aud: CLIENT, token_use: 'id', email: 'a@b.c' }), context);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ sub: 'u1', email: 'a@b.c', admin: false });
  });

  it('refuses a token from another client in the pool', async () => {
    const res = await handler(restEvent('/api/v1/me', { sub: 'u1', aud: 'someone-else', token_use: 'id' }), context);
    expect(res.statusCode).toBe(401);
  });

  it('refuses a request with no authorizer claims', async () => {
    const res = await handler(restEvent('/api/v1/me'), context);
    expect(res.statusCode).toBe(401);
  });

  it('serves health', async () => {
    const res = await handler(restEvent('/api/health'), context);
    expect(res.statusCode).toBe(200);
  });
});
