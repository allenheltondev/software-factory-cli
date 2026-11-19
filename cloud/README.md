# Updraft Cloud

The hosted, multi-tenant Updraft at **https://updraft.readysetcloud.io** ([#64](https://github.com/allenheltondev/software-factory-cli/issues/64)).
It is a Ready, Set, Cloud app, built the way the other rsc-core consumer apps are built:

- The UI, sign-in and navbar come from [`@readysetcloud/ui`](https://github.com/readysetcloud/rsc-core).
- Sign-in uses the shared Ready, Set, Cloud Cognito pool.
- The stack is SAM in us-east-1.

This directory is its own npm project. It is not part of the `@allenheltondev/updraft` package, and the CLI's install, tests and CI matrix never touch it.

This first piece ([#66](https://github.com/allenheltondev/software-factory-cli/issues/66)) is the hosting skeleton. You can sign in with a Ready, Set, Cloud account and see a dashboard that proves the path from browser to API works. Linking GitHub, the App, tenants, configuration and jobs follow in #67–#71.

## Architecture

```
browser ── https://updraft.readysetcloud.io ──> CloudFront (one distribution, one origin for the browser)
   │                                            ├─ /*      -> S3 (private, OAC)  SPA; SpaRouterFunction rewrites
   │                                            │                                 extensionless paths to /index.html
   │                                            └─ /api/*  -> API Gateway REST (regional), OriginPath /<stage>
   │                                                           ├─ GET /api/health        no authorizer
   │                                                           └─ ANY /api/v1/{proxy+}   Cognito authorizer
   │                                                                  v
   │                                                           ApiFunction (Hono, Node 22, arm64)
   │                                                             checks the token's aud == this stack's client
   └── sign-in: @readysetcloud/ui/auth -> cognito-idp (USER_PASSWORD_AUTH) with this stack's AuthClient
```

- **One origin.** The SPA calls relative `/api/v1/...` paths. There is no CORS configuration and no API URL to configure, and Staging works on its `*.cloudfront.net` domain unchanged.
- **Auth.**
  - **Sign-in:** the SPA signs in with `@readysetcloud/ui/auth` against `AuthClient`, this stack's own client in the shared pool (`/readysetcloud/auth/user-pool-id`). It then sends `Authorization: Bearer <ID token>`.
  - **API Gateway:** the Cognito authorizer (`/readysetcloud/auth/user-pool-arn`) verifies the token's signature, issuer and expiry.
  - **The API itself:** the authorizer accepts a token minted for any client in the shared pool, so `server/src/caller.ts` also requires `token_use: id` and `aud` equal to `AuthClient`.
  - **Session scope:** `sharedCookieDomain: ''` keeps the session on this origin, the same choice ai-fantasy-league makes.
- **No `CustomErrorResponses`** on the distribution. They would turn the API's 401, 403 and 404 responses into `index.html`. The SPA fallback is a viewer-request function on the default behavior only.
- **Direct calls to the execute-api URL** meet the same authorizer and throttling. No origin-verify header is needed.
- **Data.** There is one DynamoDB table (`UpdraftTable`, `pk`/`sk` and two generic GSIs, retained on delete), ready for #67 onward. Nothing writes to it yet.

| Path | What it is |
| --- | --- |
| `app/` | The SPA: Vite, React 19, react-router, Tailwind with the RSC preset |
| `server/` | The API: Hono. `src/lambda.ts` is the Lambda entry, `src/local.ts` the local dev server; `scripts/bundle.mjs` bundles to `server/dist/` |
| `infra/` | `template.yaml` (SAM) and `samconfig.toml` |
| `scripts/smoke.mjs` | Anonymous post-deploy checks |
| `Makefile` | Dev, checks and deploy targets, shared by local runs and CI |

## Local development

```sh
cd cloud
npm ci
make dev-auth-config STACK_NAME=updraft-cloud DEPLOY_REGION=us-east-1   # once, needs AWS credentials for a deployed stack
make dev                                                               # API on :8787, SPA on :5173 (proxies /api)
```

`make dev-auth-config` writes `app/public/auth-config.json` (gitignored) from a deployed stack's outputs. Both the SPA and the local API read it.

There is no API Gateway locally, so `server/src/local.ts` verifies the ID token itself with `aws-jwt-verify`. Without that file the SPA shows a "sign-in is not configured" notice, and `/api/v1` answers 401.

Checks (the same ones CI runs):

```sh
npm run lint && npm run typecheck && npm test && npm run build
make validate-template        # sam validate --lint, no AWS credentials needed
```

## Deploying

Deploys run from GitHub Actions, the same way as ai-fantasy-league:

| Workflow | When | Environment | Domain |
| --- | --- | --- | --- |
| `.github/workflows/cloud-production.yaml` | push to `main` touching `cloud/**` or `cloud-*.yaml`; manual dispatch | Production | `updraft.readysetcloud.io` |
| `.github/workflows/cloud-staging.yaml` | pull requests touching the same paths (not from forks) | Staging | the CloudFront domain |

Both workflows call `.github/workflows/cloud-deploy-env.yaml`, which runs these steps:

1. lint, typecheck and test;
2. `make deploy-backend`: bundle the API, then `sam deploy`;
3. `make deploy-frontend`: build the SPA, then write `auth-config.json` from the stack outputs. Next it syncs to S3; hashed assets are cached as immutable, while `index.html` and `auth-config.json` are uploaded with `no-cache`. Finally it invalidates CloudFront.
4. `scripts/smoke.mjs` against the deployed URL.

There is no `sam build`. `ApiFunction`'s `CodeUri` is the bundled `server/dist`, which `sam deploy` zips and uploads itself.

### One-time setup

1. **AWS accounts.** Staging and Production are separate accounts, and both need rsc-core deployed. The template reads `/readysetcloud/auth/user-pool-id` and `/readysetcloud/auth/user-pool-arn` from SSM.
2. **Deploy role.** In each account, create an IAM role that this repository can assume through GitHub OIDC. Its trust policy should be scoped to `repo:allenheltondev/software-factory-cli:environment:<Production|Staging>`. It needs permission to deploy this stack: CloudFormation, Lambda, API Gateway, IAM roles for the function, S3, CloudFront, ACM, Route 53 records in the zone, DynamoDB, Cognito user pool clients, SSM read, CloudWatch Logs, and the SAM managed bucket.
3. **GitHub environments** (Settings > Environments):
   - `Production`: secret `AWS_DEPLOYMENT_ROLE_ARN`, and variable `HOSTED_ZONE_ID` set to the readysetcloud.io hosted zone id.
   - `Staging`: secret `AWS_DEPLOYMENT_ROLE_ARN`.

   Until a secret exists, that environment's deploy skips with a notice instead of failing.

A deploy by hand works too, with credentials for the target account:

```sh
cd cloud
make deploy-backend STACK_NAME=updraft-cloud DEPLOY_REGION=us-east-1 \
  APP_DOMAIN_NAME=updraft.readysetcloud.io APP_HOSTED_ZONE_ID=<zone id>
make deploy-frontend STACK_NAME=updraft-cloud DEPLOY_REGION=us-east-1
make smoke URL=https://updraft.readysetcloud.io
```

`make destroy CONFIRM=updraft-cloud` deletes the stack. The table is retained.

## Not verified yet

The template passes `sam validate --lint`, and the API and SPA are covered by unit tests, but **no deploy has run against AWS yet**. The first deploy should confirm these:

- API Gateway REST's Cognito authorizer accepts `Authorization: Bearer <token>`. rsc-core's own clients send that form to its Cognito-authorized API, so this repeats what is known to work there.
- CloudFront's AllViewerExceptHostHeader policy passes `Authorization` through to API Gateway, as it does to ai-fantasy-league's Function URL.
- The custom domain certificate validates in the readysetcloud.io hosted zone on the first Production deploy.

API Gateway access and execution logging are off for now. Both need the account-level API Gateway CloudWatch role, which this stack does not own.
