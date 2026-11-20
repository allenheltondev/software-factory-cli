# Updraft Cloud

The hosted, multi-tenant Updraft at **https://updraft.readysetcloud.io** ([#64](https://github.com/allenheltondev/software-factory-cli/issues/64)).
It is a Ready, Set, Cloud app, built the way the other rsc-core consumer apps are built:

- The UI, sign-in and navbar come from [`@readysetcloud/ui`](https://github.com/readysetcloud/rsc-core).
- Sign-in uses the shared Ready, Set, Cloud Cognito pool.
- The stack is SAM in us-east-1.

This directory is its own npm project. It is not part of the `@allenheltondev/updraft` package, and the CLI's install, tests and CI matrix never touch it.

So far it covers these phases:

- **The hosting skeleton** ([#66](https://github.com/allenheltondev/software-factory-cli/issues/66)): sign in with a Ready, Set, Cloud account.
- **GitHub linking and installations** ([#67](https://github.com/allenheltondev/software-factory-cli/issues/67)): link a GitHub account, install the Updraft GitHub App on an account or organization you own, and see the repositories it can access.

- **The multi-tenant engine** ([#68](https://github.com/allenheltondev/software-factory-cli/issues/68)): a labeled issue in a tenant's repository runs a job with that tenant's config and keys, within quotas.
- **Configuration** ([#69](https://github.com/allenheltondev/software-factory-cli/issues/69)): repositories and workflows are configured and published in the browser, with versions and a history.

Agent keys in the console and status follow in #70 and #71.

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
  - a 10-minute offer of existing installations to connect;
  - jobs, each with the hash of its job token, kept 7 days past the job's maximum duration.

  When the App is uninstalled, every item in the tenant's partition gets the table's `ttl`, 30 days out. DynamoDB deletes them after that, and reads treat the tenant as gone as soon as the deadline passes.
  - **Interrupted cleanup:** if a write fails partway, the webhook answers 500 so GitHub shows a delivery you can redeliver, and a redelivered delete finishes the sweep with the first deadline.
  - **No late members:** a member, or an agent key's metadata, is only ever added in a transaction that checks the tenant isn't uninstalled, so none misses the TTL.
  - **Outside the table:** the uninstall also records a cleanup entry with no TTL. It's written in the same transaction that disables the tenant (or records its tombstone), so no uninstall exists without one. Once a day, `CleanupFunction` (`server/src/tenants/cleanup.ts`) cleans up every uninstalled tenant past its deadline:
    - the S3 prefix `tenants/<id>/`;
    - the agent key secrets;
    - any of the tenant's rows still in the table, which covers an interrupted sweep.

    It forgets the entry only once all three are gone, so a run that fails is finished by the next one.
  - **Strongly consistent sweep:** the sweep and its replay read strongly, so a member committed just before the uninstall is found.
  - **Tombstones:** a delete for an installation with no tenant yet records one already uninstalled, expiring with the same TTL. A Connect or install callback that passed its GitHub check just before the delete can't create the tenant afterwards.
- **GitHub.** Linking and installing both leave for github.com and come back to the SPA's `/github/callback`, which posts what GitHub returned to `POST /api/v1/github/callback`.
  - **Callbacks:** a callback counts only with a `state` the server issued for this user, unused and under 10 minutes old.
  - **Installations:** an `installation_id` is never taken on trust. It must be listed by `GET /user/installations` for the GitHub user, the App must see it (`GET /app/installations/{id}`), and the user must own it: they *are* the account, or they're an active org **admin** (`GET /user/memberships/orgs/{org}`).
  - **Existing installations:** linking also lists the installations you already own, such as one installed on GitHub directly or one whose install callback expired. You connect the ones you pick, within 10 minutes, through `POST /api/v1/github/connect/:id`.
  - **Access follows the identity:** a membership counts only while you're linked to the GitHub identity that earned it. Unlinking, or linking a different account, ends access; linking the same account again restores it.
  - **Tokens:** user tokens are used within the request and never stored.
  - **The webhook:** `server/src/flows/webhook.ts` handles uninstall, suspend and unsuspend. Uninstall is final (a conditional write), and a repeated delete keeps the first deadline. GitHub can deliver events out of order, so for suspend and unsuspend the webhook asks GitHub for the installation's current state instead of trusting the event's order. A labeled issue goes to the launcher ("Jobs and the job broker" below). Pull request events are acknowledged without action for now.

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

A tenant's jobs run with that tenant's own Updraft config and agent keys (#68). Members configure it in the console ("Configuring in the console" below). An admin can also publish a config document, and set keys until the console has them (#70), with `server/scripts/tenant-admin.ts`, using AWS credentials for the stack's account:

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

  Beside the bundle, `source.json` keeps what the version was written as: the console's settings, or tenant-admin's document. It's what the editor loads and what re-activating copies. A job downloads it with the bundle but doesn't use it.

  If anything fails, the previous version stays active. Activation also only moves forward: a slow publish that finishes after a later one is reported as `superseded`, and the newer version stays active. A job pins the version that was active when it was dispatched, so a publish never changes a running job.

  Each version also stores its **dispatch rules**, computed from the compiled config: every repository with its GitHub id, whether it's paused (`repositories.<repo>.paused`, Updraft Cloud's own setting, which isn't written to `config.yaml`), and each trigger label with the logins allowed to apply it (`server/src/tenants/dispatch.ts`). The launcher checks these without reading the bundle, so changing triggers or actors takes a publish, not a deploy. A version published before dispatch rules existed starts nothing until it's published again.

**Agent keys** each get their own Secrets Manager secret, `updraft/tenants/<id>/agent-keys/<NAME>` (for `ANTHROPIC_API_KEY` and `CODEX_API_KEY`), tagged with the installation id.
- **No lost keys:** setting one key never reads or rewrites another, so two keys set at the same moment both survive.
- **Write-only:** nothing reads a value back. The table records only that a key is set, when, and by whom.
- **Shape check:** a value that doesn't look like the named key is refused without being repeated.
- **During an uninstall:** a key set that races an uninstall is refused, and the secret it wrote is removed again.

`tenant-admin` builds every AWS client from one region: `--region`, or else the SDK's own resolution. So stack discovery, the table, the bucket, the App settings and the key secrets are always in the same region.

### Configuring in the console

A member configures a tenant on **Configure** (`/installations/<id>/config`), and sees its versions on the history page (`/installations/<id>/config/history`). The API is in `server/src/tenants/config-service.ts`, and every route answers 403 to anyone who isn't a member of that tenant, the same answer as for a tenant that doesn't exist.

The editor works in its own terms (`server/src/tenants/console.ts`), which it turns into an ordinary tenant config before compiling:

- **Per repository:**
  - enabled or paused. A paused repository stays configured, and the launcher starts nothing for it;
  - trigger labels, each mapped to a workflow;
  - allowed actors: a new repository starts with your GitHub login, and an empty list is refused;
  - base branch, review, revision (with a maximum), and a comment on failure;
  - publication: a draft PR by default, or a PR. Auto-merge is off by default, needs review, and turning it on takes an explicit confirmation. The editor asks for it, and a publish that turns auto-merge on without `confirmAutoMerge` is refused with `auto_merge_unconfirmed`.
- **Per workflow:**
  - the agent and the reviewer: Claude Code (`claude`) or Codex (`codex`), the agents the image ships, with a model and reasoning effort. They're checked by the CLI's own profile validation;
  - the prompt, starting from the packaged `examples/prompts/implement-issue.md`, and the review and revision prompts (`review-pr.md`, `revise-pr.md`);
  - verify commands, which run in the sandbox, and the agent and verify timeouts, within the platform's ceilings.

Compiled, workflow `W` is agent `W`, a reviewer `W.review` when some repository that runs it reviews, an action `W` with `./prompts/W.md` (and `W.review.md`, `W.revise.md` when they're used), and a one-agent pool for each. Each trigger becomes a CLI workflow that carries the repository's allowed actors.

**Preview and publish:**

1. **Preview** shows the generated `config.yaml`, read-only.
2. Preview and publish check the same things: the console's shape and limits (`CONSOLE_LIMITS`), the platform-enforced fields (config.ts), repositories the installation reaches, the worker's own `validateConfig`, and the size of the version's record. Each problem is reported on the field it's about.
   - **Keys:** every enabled agent that a repository which isn't paused can start needs its key set: the agents of its workflows' pools, rule and tier pools, and review pools. This is checked on the compiled config, so it applies to anything published or re-activated, tenant-admin versions included.
   - **Record size:** a version's dispatch rules and file list share one DynamoDB item (400 KB). A repository's actor list is stored once when all its triggers share it, which the console's always do. Rules larger than 300 KiB are refused at preview and publish.
3. **Publish** stores the bundle at `config/<n+1>/` and only then switches `activeConfigVersion`, with a conditional write. If validation or the upload fails, the active version stays as it was.
   - **Edits never cross:** a publish names the version it was edited from (`baseVersion`). If another version was activated since, it's refused with `config_changed`. The activation write itself also requires the version the publish was checked against to still be active (`expectedActive`). So of two editors who both saw the same version, the second to finish is refused, even when its version number is higher. Its auto-merge confirmation was computed against that same version. Re-activating is guarded the same way.
   - **Disabled tenants:** a tenant that's suspended or disabled can't publish.
4. **Running jobs** keep the version pinned in their `JOB#` record. Pause, trigger and allowed-actor changes reach the launcher with the next webhook, with no deploy.

**History:** every version, newest first, with who published it (their GitHub login, or `admin:<user>` for tenant-admin) and when. The page diffs each version's `config.yaml` and prompts against the version before it. **Re-activate** publishes a copy of an earlier version as a new one (`copiedFrom`), checked against today's rules and asking again before it turns auto-merge on. A version published before versions kept `source.json` can't be re-activated, and the editor starts from the defaults when one is active.

The API function can read and write only `tenants/*/config/*` in the tenant bucket. It reads only files a version lists, so it needs no `ListBucket`.

### Starting jobs

A labeled issue in a tenant's repository starts a job. `WebhookFunction` is the launcher (`server/src/jobs/launch.ts`). For `issues.labeled`, it checks, in order:

1. The tenant is active and has an active config version.
2. That version's dispatch rules match: the repository (by name *and* id), a trigger label, and a sender allowed to apply it.
3. Jobs are on: a job image version is published (see "The job image" below), and the kill switch is off (see "Quotas and the kill switch").
4. The delivery isn't already claimed. Each tenant's delivery is claimed once (`DELIVERY#<id>#<delivery>`), so a redelivery while a job for it may run starts nothing. The launcher's claim lasts five minutes. When the job's microVM starts, its broker `start` holds the claim for the job's whole lifetime. So a launch that stopped partway (the webhook Lambda timed out before or during `RunMicrovm`) blocks a redelivery for five minutes at most. If a redelivery's job has taken the claim by the time a slow job starts, the slow one is refused and recorded as `superseded`, so only one job runs per delivery. `RunMicrovm` gets the job id as its idempotency token.

5. The tenant is under its quotas.

Each of these that fails answers 200 with why (`no_tenant`, `tenant_inactive`, `no_config`, `not_dispatched`, `jobs_off`, `kill_switch`, `duplicate`, `throttled`), and nothing is started. Otherwise the launcher:

- stores the event at `tenants/<id>/events/<delivery>/event.json`;
- records the job (`JOB#<jobId>`), pinning the repository, label, sender, config version and image version, its quota slots and the microVM time it reserves, plus the hash of a new job token;
- starts the microVM with a version 2 run-hook payload, which carries only the broker's name and the job's token;
- records the microVM's id on the job, the only microVM the broker will stop for it.

**Failures:** if storing or launching fails, the webhook answers 500 so the delivery can be redelivered. It releases the claim and the quota reservation so the redelivery isn't refused, and retires the job record so its token is never served. A job that ends without a clean success also releases the claim when it reports `finish`, so redelivering the webhook is how a failed job is retried. A success without a summary counts as unconfirmed.

`updraft run-event` in the microVM still makes the final decision, against GitHub and the same config. The launcher only makes sure no job starts that the config wouldn't allow. Pull request events (the review loop) aren't handled yet.

### Quotas and the kill switch

`server/src/jobs/quotas.ts` has the details. Each tenant has three quotas, and the platform has a ceiling:

| Quota | Default (template parameter) | Counted |
| --- | --- | --- |
| Concurrent jobs | 1 (`QuotaConcurrentJobs`) | A slot per running job, `TENANT#<id>`/`SLOT#<n>` |
| Jobs per day | 20 (`QuotaJobsPerDay`) | At launch, per UTC day, whatever becomes of the job |
| MicroVM minutes per month | 1200 (`QuotaMicrovmMinutesPerMonth`) | Per UTC month: a job is charged its maximum duration when it starts, and refunded what it didn't use once Lambda shows its microVM terminated |
| Platform concurrency | 20 (`PlatformConcurrentJobs`) | A slot per running job across every tenant, `PLATFORM#JOBS`/`SLOT#<n>` |

- **Checked together.** The launcher takes both slots and counts the job against the day and the month in one transaction, or takes nothing and says which quota stopped it.
- **Slots are reserved for the job's lifetime at launch**, before its microVM exists, so no later write has to extend them. They're held whether or not the job's `start` is ever admitted (the kill switch, say, or a failed start). A launch that fails gives them back. One that stops partway keeps them until reconciliation releases the job (below). A slot whose job never started runs out on its own. If another job has taken a slot by the time a slow job starts, the slow job is refused and recorded as `throttled`.
- **Capacity follows the microVM, not the outcome.** `finish` only records the outcome. The slots are freed, and the unused time refunded, once Lambda shows the microVM `TERMINATED` or no longer has it. `TERMINATING` isn't enough, because Lambda runs the `/terminate` hook before it frees the microVM's resources. This happens once (`releasedAt`), and the job is retired with it, so a delayed `start` can never admit it.
  - Usually the release isn't the broker's `terminate`, which looks only a few times, but **reconciliation**: a second schedule on `CleanupFunction`, every five minutes (`server/src/jobs/reconcile.ts`). It goes through the platform's active entries (`PLATFORM#ACTIVE`/`JOB#<id>`), whatever each job's runner reported. An entry is written in the same transaction as the reservation's slots and removed on release, so a reservation is always found, however little else its launch managed to write. It starts out `reserved`, and the launcher marks it `launching` just before it calls `RunMicrovm`.
  - A `reserved` entry older than five minutes is a launch that stopped before it asked for a microVM (the webhook Lambda's timeout is 20 seconds). It's reclaimed: the slots and the day's and month's count go back, and any job record it wrote is retired as `launch_failed`, so it can never start. The counts go back in one transaction with the entry's delete, guarded by the entry still being `reserved`, so overlapping or retried runs give them back only once. Nothing else happens unless that transaction wins. A run working from a stale list, where the launch has since marked the entry `launching`, leaves the job, its slots and its entry alone.
  - For a `launching` entry it asks Lambda for the microVM's state. It releases the job once the microVM is terminated. Otherwise it holds the job's slots again, in a transaction with a check that the job isn't released, so a slow run can't bring back the slots of a job released meanwhile.
  - A `launching` job with no recorded microVM is released only at its maximum duration. That happens when the webhook Lambda timed out after asking for the microVM but before `RunMicrovm` answered: nothing can tell whether a microVM started, so its tenant's slot stays taken until then.
- **Stopping retires the job.** The broker's `terminate` and a refused `start` both mark the job stopping (`stopRequestedAt`). Nothing more is served for it, and its `start` can never be admitted, even if its `finish` never arrived. A refused `start` also asks Lambda to stop the microVM, but frees nothing: the microVM keeps its capacity until it's seen terminated.
- **The month is checked twice.** The launcher checks it, and the broker's `start` checks it again in the same transaction that charges the job. So launches that passed the launcher together can't all be charged against the same remaining minutes: one that finds the month spent is refused and recorded as `throttled`, with the same comment on the issue. A job starts while the month is under its quota, so the last job of a month can end over it.
- **No credentials before admission.** `credentials` and `github-token` serve only a job whose `start` committed, and `start` never commits for a job that's already finished.
- **Over a quota**, the delivery is recorded as throttled in the month's usage, and its claim is given up. The issue gets one comment a day saying which quota stopped it and how to try again: remove the label and add it back. The comment is posted with an installation token for that one repository, allowed only to write issues.

**Overrides.** An admin overrides a tenant's quotas on its record (`limits`), from 1 up to a ceiling (`LIMIT_CEILING`):

```powershell
npm run tenant-admin --workspace=server -- limits set --installation 55 --concurrent-jobs 2 --minutes-per-month 3000
```
```powershell
npm run tenant-admin --workspace=server -- limits show --installation 55
```
```powershell
npm run tenant-admin --workspace=server -- limits clear --installation 55
```

`show` prints the effective quotas, each marked as an override or the default, with today's and this month's usage.

**The kill switch** is the SSM parameter `/updraft/kill-switch`, one per account. While it's `on` (or `true`, `1` or `engaged`):
- the launcher starts nothing (`kill_switch`);
- the broker refuses `start`, `credentials` and `github-token`, so running jobs lose their credentials and GitHub token within the hour and stop;
- `finish` and `terminate` still work.

The stack doesn't create the parameter, so a deploy never resets it. No parameter means off. One that exists but can't be read counts as on. The webhook and the broker each read it at most every 30 seconds.

```powershell
aws ssm put-parameter --name /updraft/kill-switch --type String --value on --overwrite
```
```powershell
aws ssm put-parameter --name /updraft/kill-switch --type String --value off --overwrite
```

### The admin view

The console's **Admin** page (`/admin`) has two levels:
- **The tenant list:** every tenant with its status, today's jobs and this month's microVM minutes against its quotas, and its failed and throttled jobs for the month.
- **One tenant:** its jobs that hold capacity, its last 30 days of jobs with their outcomes, and three actions:
  - **Disable.** No new job starts, and running jobs are served nothing more, so they end within the hour. GitHub suspending or unsuspending the App doesn't undo it (`adminDisabled` on the tenant record); only **Enable** does. Enabling makes the tenant active again only if GitHub has it active too.
  - **Quotas.** Overrides of the stack's defaults, from 1 up to the ceiling, the same as `tenant-admin limits`.
  - **Release** a job that holds capacity it shouldn't. This is for a launch interrupted after it asked for a microVM: nothing can tell whether one started, so its slot stays taken until the job's maximum duration. Release only once you've checked in Lambda that no microVM of the job is running. The job is retired, and its slots and unused microVM time are given back. A job whose launch may be under way is refused with a 409: either a reservation the launcher marks `launching` first (Release and `markLaunching` compete on the same conditional write), or a `launching` one younger than five minutes.

**Who's an admin:** the members of one Cognito group in the shared Ready, Set, Cloud user pool, as the other Ready, Set, Cloud apps check their admins. The stack's `AdminGroup` parameter names it, and the default is `updraft-admins`, a group of its own: the pool is shared, so a generic `admin` group could include other apps' admins. Membership comes from the ID token's `cognito:groups`, so adding or removing someone takes effect with their next token, within the hour. The API function verifies that token itself (`aws-jwt-verify`) and takes the token's own array, matched exactly. API Gateway's authorizer flattens claims into strings, which can't keep the boundaries of a group name that contains a comma or a space (both legal), so a string claim grants nothing.
- Every admin route answers 403 to anyone else.
- `/api/v1/me` says whether the caller is an admin, which decides whether the console shows the link.
- Each action is logged with the admin's email.

The job summaries (`TENANT#<id>`/`JOB#<createdAt>#<jobId>`) are written with each job record and keep its first outcome. A failure also counts in the month's usage. The tenant list comes from a table scan, which is fine while there are few tenants.

### The job image

Jobs run the same image as the self-hosted stack (`deploy/aws-microvm/image/`), with this repository's CLI packed into it and both agents installed. `server/scripts/build-job-image.ts` builds it:
1. packs the CLI (`npm pack` at the repository root);
2. zips the build context, with LF line endings even from a Windows checkout;
3. uploads it to `JobImageBucket`;
4. creates or updates the `<stack>-job` MicroVM image and waits for the build;
5. writes the version to `/updraft/<stack>/job-image-version`.

**Until that parameter exists, the launcher starts no jobs (`jobs_off`).** It reads the parameter at most once a minute, so a new build, or setting the parameter back to an earlier version, takes effect without a deploy.

**CI builds it.** The deploy workflow has an `image` job that runs after the stack deploy. Each version records in its description a fingerprint of what it was built from (`server/scripts/job-image-inputs.ts`):
- `deploy/aws-microvm/image/`;
- the build script and its helpers;
- `src/config/` and `src/agents/`, because the server validates tenant configs with them (validation checks agent profiles and adapters) and the image's CLI runs them;
- the root `package.json` and `package-lock.json`.

The job builds only when the active version's fingerprint differs from the checkout's (`build-job-image --check`), or when a manual Production run sets `build_image`. Comparing with the active version, not with the previous commit, also covers an environment with no image yet, an earlier build that failed, and a Staging stack whose image another pull request built.

A change to the rest of the CLI (`src/`) reaches jobs only with the next image built for one of those reasons, or a `build_image` run. Production activates a new build within a minute. To roll back, set the parameter to the previous version (`aws lambda-microvms list-microvm-image-versions --image-identifier updraft-cloud-job` lists them).

**The deploy role needs these permissions** for the `image` job, in each account (Staging and Production), on top of what the stack deploy uses. `<account>` is that account's id. `lambda:CreateMicrovmImage` and `lambda:PassNetworkConnector` have no resource type in IAM, so they take `"Resource": "*"`. Creating is limited instead to an image tagged with this stack, which is how the build creates it:

```json
[
  { "Effect": "Allow", "Action": ["lambda:GetMicrovmImage", "lambda:UpdateMicrovmImage", "lambda:GetMicrovmImageVersion", "lambda:TagResource"],
    "Resource": "arn:aws:lambda:us-east-1:<account>:microvm-image:updraft-cloud-job*" },
  { "Effect": "Allow", "Action": "lambda:CreateMicrovmImage", "Resource": "*",
    "Condition": { "StringEquals": { "aws:RequestTag/updraft:stack": "updraft-cloud" } } },
  { "Effect": "Allow", "Action": "lambda:PassNetworkConnector", "Resource": "*" },
  { "Effect": "Allow", "Action": "iam:PassRole", "Resource": "arn:aws:iam::<account>:role/updraft-cloud-MicrovmBuildRole-*",
    "Condition": { "StringEquals": { "iam:PassedToService": "lambda.amazonaws.com" } } },
  { "Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::updraft-cloud-jobimagebucket-*/image/*" },
  { "Effect": "Allow", "Action": ["ssm:GetParameter", "ssm:PutParameter"], "Resource": "arn:aws:ssm:us-east-1:<account>:parameter/updraft/updraft-cloud/job-image-version" }
]
```

An admin can also run the build by hand, with credentials for the account:

```sh
cd cloud
npm run build-job-image --workspace=server -- --stack updraft-cloud   # add --no-activate to build without switching
```

### Jobs and the job broker

Every tenant's jobs run in microVMs with one execution role, `MicrovmExecutionRole`. Anything in a microVM, an agent included, has to be assumed able to use that role, so it reaches no tenant's data. It can invoke `BrokerFunction` and write its logs. Nothing else. It can't even terminate microVMs: that permission covers every microVM of the image, so it would let one tenant's runner stop another's.

**The broker** (`server/src/broker/broker.ts`) hands out what one job may have, to whoever holds that job's token. The launcher records each job in the table (`JOB#<jobId>`): its tenant, its one repository, the config version it pinned, and the sha-256 of a single-use, random job token. The token itself travels only in the microVM's run-hook payload (version 2). The runner calls the broker with it:

| Action | Answer |
| --- | --- |
| `start`, `credentials` | Where the job's data is, and AWS credentials for an hour. `start` also holds the job's delivery claim and quota slots for its lifetime, and charges its microVM time. They come from `sts:AssumeRole` on `JobDataRole`, with a session policy for this job only. It can read this job's event and config version, read and write the tenant's state, write this job's results, and read the tenant's agent key secrets. |
| `github-token` | An installation token for the job's one repository (`repository_ids`), with only `contents`, `issues` and `pull_requests` write, and `checks`, `statuses` and `metadata` read. It's shaped as the CLI's token file (#77). The runner writes it to `app-token.json` in the protected state directory and replaces it every 20 minutes. |
| `finish` | The job is over. Nothing more is served for its token. Its quota slots stay until its microVM is seen terminated. |
| `terminate` | Stops the job's own microVM: the one the launcher recorded with the job (`attachMicrovm`, set once). This works whatever the job's state, finished or with its tenant suspended included, because it only ever ends that one microVM. The job is retired at once. Its quota slots are freed and its unused microVM time refunded once Lambda shows the microVM `TERMINATED`, here or by reconciliation. |

- **The App's private key never enters a microVM.** Only the broker reads it, to mint tokens.
- **Refused alike:** an unknown job, a wrong token, a finished or expired job, and a tenant that's no longer active all get the same `refused`, so nothing can be probed. The tenant's status is read strongly consistently, so a suspend or uninstall that has committed stops the very next request. Errors are logged without their details, which could carry a credential.
- **Bounded either way:** `JobDataRole` allows only `tenants/*` and `updraft/tenants/*`, and AWS intersects it with each session policy. Even a broker bug can't give a job the App's secrets or the table.

## Not verified yet

Staging and Production deploy and pass the anonymous smoke checks. Signing in at `updraft.readysetcloud.io` works end to end through the Cognito authorizer.

Still unconfirmed: the GitHub flows against real GitHub, which need a registered App. That covers:
- user authorization with PKCE;
- "request user authorization during installation" returning `state` to the callback;
- the Members permission letting a user token read its own org membership.

Not run on AWS yet: the job path end to end. That covers:
- building the job image with `build-job-image`;
- `RunMicrovm` from the launcher, with the Lambda-provided connectors;
- the runner's broker calls, from a microVM under the execution role;
- a labeled issue producing a pull request;
- the quota transactions against DynamoDB itself, and the over-quota comment on a real issue;
- publishing from the console against the real bucket and table, with the API function's narrowed S3 permissions.

Deliberately off:
- **API Gateway access and execution logging.** Both need the account-level API Gateway CloudWatch role, which this stack does not own.
- **Point-in-time recovery on `UpdraftTable`.** This is a decision, not a gap.
