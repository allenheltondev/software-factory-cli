# Updraft Cloud

The hosted, multi-tenant Updraft at **https://updraft.readysetcloud.io** ([#64](https://github.com/allenheltondev/software-factory-cli/issues/64)).
It is a Ready, Set, Cloud app, built the way the other rsc-core consumer apps are built:

- The UI, sign-in and navbar come from [`@readysetcloud/ui`](https://github.com/readysetcloud/rsc-core).
- Sign-in uses the shared Ready, Set, Cloud Cognito pool.
- The stack is SAM in us-east-1.

This directory is its own npm project. It is not part of the `@allenheltondev/updraft` package, and the CLI's install, tests and CI matrix never touch it.

So far it covers two phases:

- **The hosting skeleton** ([#66](https://github.com/allenheltondev/software-factory-cli/issues/66)): sign in with a Ready, Set, Cloud account.
- **GitHub linking and installations** ([#67](https://github.com/allenheltondev/software-factory-cli/issues/67)): link a GitHub account, install the Updraft GitHub App on an account or organization you own, and see the repositories it can access.

Configuration, keys, jobs and status follow in #68–#71.

## Architecture

```
browser ── https://updraft.readysetcloud.io ──> CloudFront (one distribution, one origin for the browser)
   │                                            ├─ /*      -> S3 (private, OAC)  SPA; SpaRouterFunction rewrites
   │                                            │                                 extensionless paths to /index.html
   │                                            └─ /api/*  -> API Gateway REST (regional), OriginPath /<stage>
   │                                                           ├─ GET /api/health           no authorizer
   │                                                           ├─ POST /api/webhooks/github no authorizer -> WebhookFunction (HMAC)
   │                                                           └─ ANY /api/v1/{proxy+}      Cognito authorizer
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
- **Data.** One DynamoDB table, `UpdraftTable` (`pk`/`sk` and two generic GSIs, retained on delete). Its layout is in `server/src/store/store.ts`:
  - pending GitHub sign-ins, single use with a 10-minute TTL;
  - linked GitHub identities, unique per GitHub user;
  - tenants, one per App installation;
  - members of each tenant, each recording the GitHub identity that earned the membership;
  - a 10-minute offer of existing installations to connect.

  When the App is uninstalled, every item in the tenant's partition gets the table's `ttl`, 30 days out. DynamoDB deletes them after that, and reads treat the tenant as gone as soon as the deadline passes.
  - **Interrupted cleanup:** if a write fails partway, the webhook answers 500 so GitHub shows a delivery you can redeliver, and a redelivered delete finishes the sweep with the first deadline.
  - **No late members:** a member, or an agent key's metadata, is only ever added in a transaction that checks the tenant isn't uninstalled, so none misses the TTL.
  - **Outside the table:** the uninstall also records a cleanup entry that has no TTL. Once a day, `CleanupFunction` (`server/src/tenants/cleanup.ts`) deletes the S3 prefix `tenants/<id>/` and the agent key secrets of every uninstalled tenant past its deadline. It forgets the entry only once both are gone, so a run that fails is finished by the next one.
  - **Strongly consistent sweep:** the sweep and its replay read strongly, so a member committed just before the uninstall is found.
  - **Tombstones:** a delete for an installation with no tenant yet records one already uninstalled, expiring with the same TTL. A Connect or install callback that passed its GitHub check just before the delete can't create the tenant afterwards.
- **GitHub.** Linking and installing both leave for github.com and come back to the SPA's `/github/callback`, which posts what GitHub returned to `POST /api/v1/github/callback`.
  - **Callbacks:** a callback counts only with a `state` the server issued for this user, unused and under 10 minutes old.
  - **Installations:** an `installation_id` is never taken on trust. It must be listed by `GET /user/installations` for the GitHub user, the App must see it (`GET /app/installations/{id}`), and the user must own it: they *are* the account, or they're an active org **admin** (`GET /user/memberships/orgs/{org}`).
  - **Existing installations:** linking also lists the installations you already own, such as one installed on GitHub directly or one whose install callback expired. You connect the ones you pick, within 10 minutes, through `POST /api/v1/github/connect/:id`.
  - **Access follows the identity:** a membership counts only while you're linked to the GitHub identity that earned it. Unlinking, or linking a different account, ends access; linking the same account again restores it.
  - **Tokens:** user tokens are used within the request and never stored.
  - **The webhook:** `server/src/flows/webhook.ts` handles uninstall, suspend and unsuspend. Uninstall is final (a conditional write), and a repeated delete keeps the first deadline. GitHub can deliver events out of order, so for suspend and unsuspend the webhook asks GitHub for the installation's current state instead of trusting the event's order. Issue and pull request events are acknowledged without action until #68.

| Path | What it is |
| --- | --- |
| `app/` | The SPA: Vite, React 19, react-router, Tailwind with the RSC preset |
| `server/` | The API: Hono. `src/lambda.ts` is the Lambda entry, `src/local.ts` the local dev server; `scripts/bundle.mjs` bundles to `server/dist/` |
| `infra/` | `template.yaml` (SAM) and `samconfig.toml` |
| `scripts/smoke.mjs` | Anonymous post-deploy checks |
| `scripts/register-github-app.mjs` | Registers the Updraft GitHub App for one deployment and stores its key and secrets in AWS |
| `scripts/spa-release.mjs` | Records each SPA release and prunes assets of releases replaced long ago |
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
3. `make deploy-frontend`: build the SPA and write `auth-config.json` from the stack outputs, then release in this order:
   - Upload the new hashed files under `assets/` (immutable cache). **Nothing is deleted**, so an `index.html` still in flight or cached at an edge keeps finding the files it names.
   - Upload `auth-config.json`. Then record the release **before** switching anything: `scripts/spa-release.mjs record` writes `_releases/<time>.json` listing its assets. Every release that goes live has a record, even if the deploy stops right after the switch.
   - Upload `index.html` last (both files `no-cache`), which switches the release. Invalidate CloudFront, then mark the record live (`activate`).
   - `prune` deletes the assets of releases replaced more than `ASSET_RETENTION_DAYS` (default 7) ago. The window counts from replacement, not upload.
     - A record never marked live counts as possibly live.
     - A file no record mentions stays until a release recorded before the window proves it was retired.
     - If any record can't be read, nothing is deleted.
     - Pruning is best-effort. A failure leaves old files behind and doesn't fail the deploy, because the release is already live.
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

### The GitHub App (once per environment)

Each deployment has its own Updraft GitHub App: Production's points at `updraft.readysetcloud.io`, and Staging's at its CloudFront domain. Until one is registered, the dashboard says GitHub can't be connected yet, `/api/v1/github/*` answers `503 github_app_not_configured`, and the webhook answers 503.

Register it from your machine with AWS credentials for that account:

```sh
cd cloud
node scripts/register-github-app.mjs --app-url https://updraft.readysetcloud.io [--org <github org that should own it>]
# Staging: --app-url https://<staging distribution>.cloudfront.net --name "Updraft (Staging)"
```

1. Open the page it serves on `http://127.0.0.1:3999`, continue to GitHub, review the App and press **Create GitHub App**.
2. GitHub returns a one-time code. The script exchanges it and writes these values, without printing the secrets:
   - SSM: `/updraft/app/{id,client-id,slug,url}`
   - Secrets Manager: `updraft/app/{private-key,client-secret,webhook-secret}`

   The API picks them up within five minutes, with no deploy. `--replace` overwrites an App that is already stored.

The manifest sets everything #67 describes:
- **Webhook:** `<app-url>/api/webhooks/github`.
- **Callback URL:** `<app-url>/github/callback`, with "request user authorization during installation" on. There's no setup URL, because GitHub disables it with that setting. Existing installations are connected by linking instead.
- **Repository permissions:** Metadata (read); Contents, Issues and Pull requests (read and write); Checks and Commit statuses (read).
- **Organization permission:** Members (read). A user's token needs it to show their own org membership, which is how ownership of an org installation is checked.
- **Events:** Issues, Pull request and Pull request review. Installation events always arrive.

### Tenant config and agent keys

A tenant's jobs run with that tenant's own Updraft config and agent keys (#68). Until the console can edit them (#69, #70), an admin sets them with `server/scripts/tenant-admin.ts`, using AWS credentials for the stack's account:

```sh
cd cloud
npm run tenant-admin --workspace=server -- config publish --installation 55 --file tenant.yaml --prompts ./prompts
npm run tenant-admin --workspace=server -- config list    --installation 55
npm run tenant-admin --workspace=server -- key set        --installation 55 --name ANTHROPIC_API_KEY   # the key on stdin, never in argv
npm run tenant-admin --workspace=server -- key status     --installation 55
```

**The config** is an ordinary Updraft config: `agents`, `pools`, `actions`, `repositories`, `dispatch` and `review`. Prompts are `./prompts/<name>.md`, taken from the `--prompts` directory. `server/src/tenants/config.ts` compiles it as follows.

- **Tenant input the platform owns is rejected, with its path.** It's never silently overridden:
  - `github`, `execution`, `maxConcurrent`, `pollIntervalSeconds` and `capacity`;
  - an agent's `command`, `args`, `env`, `container`, `capacityGroup` or `maxConcurrent`;
  - a repository's `id`, `checkoutPath`, `remote` or `dependencies`;
  - any `tiers.triage`;
  - agents other than `claude` and `codex`;
  - publish modes other than `draft-pr` and `pr`;
  - timeouts over 120 minutes (agent) or 30 minutes (verify).
- **What the platform writes:**
  - live mode, one job at a time;
  - the platform App through `tokenFile` (#77), committing as its bot;
  - each agent in the sandbox runtime with only its own key's variable;
  - each repository's id, from what the installation can actually reach, and a checkout under `./clones/`.
- **Validation:** the result is checked with the worker's own `validateConfig` (imported from `src/`, as Linux), so a config that publishes is one the job accepts.
- **Publishing** (`server/src/tenants/publish.ts`):
  1. allocate the next version as pending (versions only grow, and none is rewritten);
  2. upload the bundle to `s3://<TenantBucket>/tenants/<id>/config/<version>/`;
  3. mark it ready;
  4. activate it, in one conditional write.

  If anything fails, the previous version stays active. Activation also only moves forward: a slow publish that finishes after a later one is reported as `superseded`, and the newer version stays active. Jobs will pin the version active when they're dispatched (PR 4).

**Agent keys** each get their own Secrets Manager secret, `updraft/tenants/<id>/agent-keys/<NAME>` (for `ANTHROPIC_API_KEY` and `CODEX_API_KEY`), tagged with the installation id.
- **No lost keys:** setting one key never reads or rewrites another, so two keys set at the same moment both survive.
- **Write-only:** nothing reads a value back. The table records only that a key is set, when, and by whom.
- **Shape check:** a value that doesn't look like the named key is refused without being repeated.
- **During an uninstall:** a key set that races an uninstall is refused, and the secret it wrote is removed again.

`tenant-admin` builds every AWS client from one region: `--region`, or else the SDK's own resolution. So stack discovery, the table, the bucket, the App settings and the key secrets are always in the same region.

## Not verified yet

Staging and Production deploy and pass the anonymous smoke checks. Signing in at `updraft.readysetcloud.io` works end to end through the Cognito authorizer.

Still unconfirmed: the GitHub flows against real GitHub, which need a registered App. That covers:
- user authorization with PKCE;
- "request user authorization during installation" returning `state` to the callback;
- the Members permission letting a user token read its own org membership.

Deliberately off:
- **API Gateway access and execution logging.** Both need the account-level API Gateway CloudWatch role, which this stack does not own.
- **Point-in-time recovery on `UpdraftTable`.** This is a decision, not a gap.
