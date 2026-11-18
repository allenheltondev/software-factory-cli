# Updraft on AWS Lambda MicroVMs

A reference deployment that runs each Updraft job in its own
[AWS Lambda MicroVM](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html),
started by a GitHub App webhook. There is no always-on worker: applying a trigger label to an
issue starts a microVM, the microVM runs the agent, opens the pull request and terminates
itself.

> **Status: written from the documentation, not yet run on AWS.** The launcher's logic and the
> runner's logic are covered by tests that need no AWS (74 of them, part of `npm test`). The
> SAM template, `deploy.sh`, the Dockerfile and every call to the MicroVMs service have never
> been executed against the real service. [What is not verified](#what-is-not-verified) lists
> each assumption in one place. Expect to fix things on the first deployment.
>
> It also depends on `updraft run-event` (documented in `docs/run-event.md` of the Updraft
> repository), which was merged separately and is not in the commit this directory was
> written against: the runner follows its contract and was tested with a stand-in, never with
> the real command. The image build fails with a clear message if the Updraft it installs has
> no such command.

## Architecture

```
GitHub App webhook (event: Issues)
        |  POST /webhook    X-Hub-Signature-256, X-GitHub-Event, X-GitHub-Delivery
        v
API Gateway HTTP API  (throttled; one route)
        v
Launcher Lambda function  (launcher/, Node.js 22)
        |  1. verify the HMAC over the raw body (secret from Secrets Manager); else 401
        |  2. keep only issues.labeled (optionally: only some labels); else 200, nothing started
        |  3. record the delivery id (DynamoDB, conditional put); already there: 200, nothing started
        |  4. store the body          -> s3://BUCKET/events/<delivery>/event.json
        |  5. RunMicrovm(image, execution role, NO_INGRESS, internet egress,
        |                maximum duration, run-hook payload = references only)
        |  6. 202
        v
Lambda MicroVM  (image/, one per delivery, restored from the image snapshot)
   runner/server.mjs   hook server on port 9000 (ENTRYPOINT, root, part of the snapshot)
        |  POST /aws/lambda-microvms/runtime/v1/run  { microvmId, runHookPayload }  -> 200 at once
        v
   runner/run-job.mjs  new process (root), with the microVM's execution role:
        |  event            <- s3://BUCKET/events/<delivery>/event.json
        |  config, prompts  <- s3://BUCKET/config/*
        |  App private key, agent API key  <- Secrets Manager
        |  all written to a fresh directory, owner-only, owned by the job user
        v
   updraft run-event --event-file ... --event-name issues --delivery-id ... --json
                     --deadline-minutes <n>
        |  as user "updraft" (not root); re-checks everything against the GitHub API,
        |  clones, runs the agent (full-auto) and the verify commands, opens the PR
        v
   runner: updraft.log, run.log -> s3://BUCKET/results/<delivery>/<microvm-id>/
           result               -> s3://BUCKET/results/<delivery>/<microvm-id>.json
           job did not end well: remove the delivery record, so it can be redelivered
           TerminateMicrovm(own id)          (a watchdog stops a job that runs too long)
```

Files:

| Path | What it is |
| --- | --- |
| `template.yaml` | SAM template: HTTP API, launcher function, bucket, delivery table, secrets, IAM roles, log groups |
| `deploy.sh` | Deploys the stack, uploads the config, creates or updates the MicroVM image and waits for the build |
| `launcher/` | The launcher function. `lib/` is the logic (tested); `index.mjs` wires the AWS SDK to it |
| `image/Dockerfile`, `image/build.env` | The MicroVM image: git, Node.js, Updraft, agent CLIs, the runner |
| `image/runner/` | Hook server (`server.mjs`, `hooks.mjs`), the job (`run-job.mjs`, `job.mjs`), AWS calls (`aws.mjs`) |
| `image/vendor/` | Put an `npm pack` tarball of Updraft here to build an image from an unpublished build |
| `config/config.example.yaml` | Starting point for the Updraft config that the microVMs read from S3 |
| `test/` | Tests, run by the repository's `npm test` |

## Prerequisites

- An AWS account in a Region where Lambda MicroVMs is available, and credentials that may
  create the stack's resources, call the `lambda:*Microvm*` actions, and pass the two roles
  the stack creates.
- AWS CLI v2, recent enough to have the `lambda-microvms` commands; AWS SAM CLI; `zip`;
  Node.js 22 with npm (for `sam build`).
- A GitHub App you own (see [Acting as a GitHub App](../../docs/github-app.md) for creating
  one), its App ID and a private key.
- An API key for the agent (for Claude Code: an Anthropic API key).
- Until `@allenheltondev/updraft` with `run-event` is on npm: a tarball of it from `npm pack`.

## Deployment

All commands run in `deploy/aws-microvm/`. Names and the Region come from the environment
(`STACK_NAME`, `IMAGE_NAME`, `AWS_REGION`, ...; `./deploy.sh --help` lists them). Nothing is
hard-coded.

1. **Deploy the stack.**

   ```sh
   export AWS_REGION=<region>
   ./deploy.sh stack
   ```

   This runs `sam build` (which installs the launcher's four AWS SDK clients from
   `launcher/package.json`) and `sam deploy`. It prints the webhook URL. `./deploy.sh status`
   prints all outputs later.

2. **Write the Updraft config.**

   ```sh
   cp config/config.example.yaml config/config.yaml
   mkdir -p config/prompts
   cp ../../examples/prompts/implement-issue.md config/prompts/
   $EDITOR config/config.yaml        # allowedActors, appId, repositories, labels
   ./deploy.sh config
   ```

   Everything in `config/` (except `*.example.*`) is uploaded to `s3://<bucket>/config/`.
   `config/` is ignored by Git, apart from the example. See
   [Config and prompts](#config-and-prompts).

3. **Store the secrets.** The stack created three secrets; their ARNs are stack outputs.

   ```sh
   # The App's private key, as downloaded from GitHub:
   aws secretsmanager put-secret-value --secret-id <GitHubAppPrivateKeySecretArn> \
     --secret-string file://<path-to>/your-app.private-key.pem

   # The agent's key. Either the bare key (taken as ANTHROPIC_API_KEY) ...
   aws secretsmanager put-secret-value --secret-id <AgentEnvSecretArn> \
     --secret-string file://<file-containing-only-the-key>
   # ... or a JSON object of environment variables for the job, for other agents:
   #   {"ANTHROPIC_API_KEY": "...", "CODEX_API_KEY": "..."}

   # The webhook secret was generated by Secrets Manager. Read it to paste it into GitHub:
   aws secretsmanager get-secret-value --secret-id <WebhookSecretArn> --query SecretString --output text
   ```

   To use secrets you already have, pass their ARNs instead
   (`SAM_PARAMETER_OVERRIDES="WebhookSecretArn=... GitHubAppPrivateKeySecretArn=... AgentEnvSecretArn=..."`).
   No secret value is ever in the template, a parameter or the run-hook payload.

4. **Build the MicroVM image.**

   ```sh
   # From npm, once a version with run-event is published:
   UPDRAFT_SPEC=@allenheltondev/updraft@<version> ./deploy.sh image

   # Or from this checkout:
   (cd ../.. && npm pack)            # writes allenheltondev-updraft-<version>.tgz
   UPDRAFT_TARBALL=../../allenheltondev-updraft-<version>.tgz ./deploy.sh image
   ```

   The script zips `image/`, uploads it to `s3://<bucket>/image/`, calls
   `create-microvm-image` (or `update-microvm-image` when the image exists) and polls the new
   version until it is `SUCCESSFUL` or `FAILED`. Build logs are in the log group
   `/aws/lambda-microvms/<image-name>`. Other settings: `IMAGE_ARCH` (`ARM_64`), `IMAGE_MEMORY_MIB`
   (`4096`), `AGENT_PACKAGES`, `TOOL_PACKAGES`, `SYSTEM_PACKAGES`, `PYTHON_COMMAND`, `NODE_VERSION`,
   `BASE_IMAGE_ARN`, `BASE_IMAGE_VERSION`.

   `./deploy.sh` with no argument does steps 1, 2 (if `config/config.yaml` exists) and 4.

5. **Point the GitHub App at the endpoint.** In the App's settings:

   - *Webhook*: **Active**. *Webhook URL*: the `WebhookUrl` output. *Content type*:
     `application/json` (the launcher answers 400 to form-encoded deliveries). *Secret*: the
     webhook secret from step 3.
   - *Permissions & events*, *Subscribe to events*: **Issues**, and nothing else. The launcher
     ignores every other event, so more subscriptions only cost invocations.
   - *Repository permissions*: **Metadata** read-only; **Contents**, **Issues** and **Pull
     requests** read and write. **Workflows** read and write only if agents are meant to change
     files under `.github/workflows/`. Nothing else. (This is the table in
     [docs/github-app.md](../../docs/github-app.md#permissions) for a deployment that
     publishes.)
   - Install the App on the repositories in your config, and only on those.

   GitHub sends a `ping` when the webhook is saved; the launcher answers 200 to it.

### Template parameters

Pass them through `SAM_PARAMETER_OVERRIDES="Key=Value ..."`.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `ImageName` | `updraft-job` | Name of the MicroVM image (set through `IMAGE_NAME`). The launcher runs `arn:<partition>:lambda:<region>:<account>:microvm-image:<ImageName>` |
| `ImageVersion` | empty | Pin an image version. Empty runs the latest active version |
| `MaximumDurationSeconds` | `7200` | Hard lifetime of a job's microVM (600 to 28,800). The default leaves room for a 60 minute agent run (`timeoutMinutes`), 15 minutes of verification, cloning and installing dependencies |
| `WatchdogReserveSeconds` | `300` | The runner stops the job this long before the maximum duration |
| `IdlePolicyMode` | `explicit` | See [Idle policy](#idle-policy) |
| `EgressNetworkConnectorArn` | empty | A VPC egress network connector. Empty uses the Lambda-provided internet egress connector |
| `IngressNetworkConnectorArn` | empty | Empty uses the Lambda-provided `NO_INGRESS` connector. Set it only for debugging, for example to the `SHELL_INGRESS` connector |
| `DedupeWindowSeconds` | `7200` | How long a redelivery of a delivery that already started a microVM is ignored, unless that job reported a failure. About `MaximumDurationSeconds`. `0` turns deduplication off. See [Redelivery, deduplication and idempotency](#redelivery-deduplication-and-idempotency) |
| `TriggerLabels` | empty | Comma-separated label names. When set, only these labels start a microVM. It must contain every trigger label in the Updraft config; it is a cost saving, not a control |
| `WebhookSecretArn`, `GitHubAppPrivateKeySecretArn`, `AgentEnvSecretArn` | empty | Use existing secrets instead of creating them |
| `EventRetentionDays`, `ResultRetentionDays` | `14`, `90` | S3 lifecycle expiry of `events/` and `results/` |
| `LogRetentionDays` | `30` | Retention of both log groups |
| `WebhookRateLimit`, `WebhookBurstLimit` | `10`, `20` | HTTP API throttling in front of the launcher |

## Config and prompts

The Updraft config and the prompt files live in S3 under `config/` and are downloaded by each
microVM into the directory that becomes `UPDRAFT_HOME`. To change repositories, labels,
allowed actors, agent arguments or a prompt: edit the files in `config/` and run
`./deploy.sh config`. The next job uses them. No image build, no stack deployment, no code.

Rules the runner imposes on that config (the example follows them):

- `execution.mode: live`, and a `github.app` block with `privateKeyPath: ./github-app.pem`.
  The runner writes the key from Secrets Manager to that path, mode 0600.
- `checkoutPath` set, under `./clones/`. The schema requires it in live mode. The directory
  does not exist when the job starts; `updraft run-event` creates the clone there and fetches
  with the App's token.
- No `agents.<name>.container`. The microVM is the isolation boundary, and there is no
  container runtime in the image.
- Prompt paths relative to the config file, for example `./prompts/implement-issue.md`.
- `repositories.<owner/repo>.id` is the repository's numeric id
  (`gh api repos/OWNER/REPO --jq .id`).

Check a config before uploading it with `updraft validate --config config/config.yaml` (it
needs a `github-app.pem` next to it to pass; any RSA key file will do for the check).

The image contains Node.js and git and nothing else of a toolchain. If a repository's
`verify` commands or its agent need more (Python, a JDK, a database), install it in
`image/Dockerfile` and rebuild the image.

## Testing with a redelivered webhook

1. In a repository the App is installed on, apply the trigger label to an issue as a user in
   `dispatch.allowedActors`.
2. On the App's settings page, *Advanced*, *Recent Deliveries*: the `issues` delivery should
   show a `202` response with a body such as `{"deliveryId":"...","microvmId":"mvm-..."}`.
3. Follow the job: `aws logs tail /aws/lambda-microvms/<image-name> --follow` (the log stream
   is the microVM id).
4. Read the outcome: `aws s3 cp s3://<bucket>/results/<delivery-id>/<microvm-id>.json -`.
5. To run the same event again, choose **Redeliver** on that delivery. GitHub sends the same
   body with the same `X-GitHub-Delivery`. What happens depends on the first attempt, see the
   next section. While trying things out, `DedupeWindowSeconds=0` makes every redelivery
   start a microVM.

A delivery can also be replayed from a shell, which is useful before the App is connected:

```sh
SECRET=$(aws secretsmanager get-secret-value --secret-id <WebhookSecretArn> --query SecretString --output text)
SIG=$(openssl dgst -sha256 -hmac "$SECRET" < event.json | sed 's/^.* //')
curl -i -X POST "<WebhookUrl>" --data-binary @event.json \
  -H "content-type: application/json" -H "x-github-event: issues" \
  -H "x-github-delivery: $(uuidgen)" -H "x-hub-signature-256: sha256=$SIG"
```

## Redelivery, deduplication and idempotency

There are two layers, and they do different jobs.

**The launcher deduplicates on the delivery id.** Before it starts a microVM it writes the
delivery id to a DynamoDB table with a conditional put; the item expires after
`DedupeWindowSeconds`. A redelivery that finds an unexpired item gets
`200 {"duplicate": true, ...}` and starts nothing. The item is removed again when the launch
fails (the launcher does it) and when the job does not end cleanly (the runner does it: any
outcome other than `run-event` exiting 0 with a summary). So:

| First attempt | A redelivery |
| --- | --- |
| Still running | Ignored. Without this, both microVMs would run the agent |
| Ended with exit 0 (published, nothing to do, canceled, superseded) | Ignored until the window has passed; after that it starts a microVM that finds the work done |
| Failed, timed out, or the runner could not start it | Starts a new microVM at once: redelivering is the retry |
| Launch failed (delivery shows `500`) | Starts a new microVM at once |
| MicroVM died without reporting (no result object) | Ignored until the window has passed, because nothing removed the item. Delete it from the table (`DeliveryTableName` output) to retry sooner |

If the table cannot be reached, the launcher logs a warning and launches anyway.

**`updraft run-event` is idempotent per event, with gaps you should know.** The job id and the
branch name are derived from the GitHub timeline event, not from the delivery, so a second
run of the same event in a new microVM finds the pull request or the branch and exits 0 with
reason `already-handled`. What that does not cover:

- Two microVMs for the same event started within one agent run of each other both run the
  agent; only one can publish. The launcher's deduplication exists to prevent this.
- A run that pushed the branch and died before opening the pull request leaves a branch that
  blocks later runs of that event until someone deletes it.
- A failed job leaves no marker. A redelivery runs it again, and with `commentOnFailure` posts
  another failure comment. That is what a retry is, but it means every redelivery of a
  failing event costs an agent run.
- `run-event` exits 1 with an "event not found" error when GitHub's events API has not listed
  the label event after about 15 seconds of re-reading. The microVM is already running at
  that point, so the launcher cannot answer 5xx; the delivery shows `202`, the failure is in
  the result object (`updraftOutcome: "error"`), and redelivering the webhook is the retry.

As far as I know GitHub does not redeliver failed deliveries by itself; a redelivery is a
person or a script asking for one.

## When something fails

| Symptom | Where to look |
| --- | --- |
| Delivery shows `401` | The secret in the App's webhook settings differs from the Secrets Manager value. The launcher caches the secret for 5 minutes after a change |
| Delivery shows `400` | Content type is not `application/json`, or a header is missing (replay from a shell) |
| Delivery shows `200` with `{"ignored": "..."}` | The event was filtered; the reason is in the body. Check `TriggerLabels`. With `"duplicate": true`, the delivery already started a microVM; see the section above |
| Delivery shows `500` | The launcher's log group (`LauncherLogGroup` output). Each line is JSON with the `deliveryId`. Typical causes: the image does not exist or has no active version (`ResourceNotFoundException`), the account's MicroVM memory quota is used up (`ServiceQuotaExceededException`), a missing permission, a rejected parameter (`ValidationException`, see [Idle policy](#idle-policy)) |
| Delivery shows `429` or `503` | HTTP API throttling (`WebhookRateLimit`) |
| `202`, but no result object | The microVM's log stream in `/aws/lambda-microvms/<image-name>`. `aws lambda-microvms get-microvm --microvm-identifier <id>` shows `state` and `stateReason`. A microVM whose `/run` hook fails or times out is terminated without ever running |
| Result has `outcome: runner_error` | `error` says which step failed: reading the event or config from S3, a secret that is empty or not a PEM key, no `config.yaml`, Updraft not startable |
| Result has `outcome: failed` | `error` explains the exit code; `summary` is Updraft's own JSON summary (`outcome`, `reason`, `message`, `verification`, `publicationError`, ...), `stderrTail` its last output. `updraft.log` and the run log are in S3 next to the result (`logs`), the same output is in the microVM's log stream |
| Result has `updraftOutcome: error` and a message about an event not found | GitHub's events API had not listed the label event yet. Redeliver the webhook |
| Result's summary has `drain: deadline` | `run-event` reached the `--deadline-minutes` the runner gave it and stopped the agent. Raise `MaximumDurationSeconds`, or lower the action's `timeoutMinutes` |
| Result has `outcome: timed_out` | `run-event` did not stop at its own deadline and the watchdog killed it. Same remedy; also a bug worth reporting |
| Result has `summaryMissing: true` | `run-event` did not print a JSON object as its last stdout line; `outcome` then reflects the exit code only |
| Image build fails | Build logs in `/aws/lambda-microvms/<image-name>`; `deploy.sh` prints the version's `stateReason`. Reproduce with `docker build image/` |

The result document:

```json
{
  "deliveryId": "...", "eventName": "issues", "microvmId": "mvm-...",
  "outcome": "succeeded | failed | timed_out | terminated | runner_error",
  "exitCode": 0, "signal": null,
  "summary": { "...": "the JSON object updraft run-event printed, or null" },
  "summaryMissing": false,
  "updraftOutcome": "summary.outcome: nothing-to-do | succeeded | canceled | superseded | failed | publish-failed | not-started | error",
  "logs": ["results/<delivery>/<microvm-id>/updraft.log", "results/<delivery>/<microvm-id>/run.log"],
  "error": null,
  "stderrTail": "last 8 KB of updraft's stderr",
  "startedAt": "...", "finishedAt": "...", "durationSeconds": 0
}
```

`outcome` is the runner's view and follows the exit code: `succeeded` is exit 0, which
`run-event` also uses for "nothing to do", "canceled by the pre-start check" and "another run
published first"; read `updraftOutcome` for which. `failed` is any other exit code: 1 for a
failed, unpublished, interrupted or never-started job and for command errors (config, GitHub,
event not matched), 2 for an unusable event file or deadline, 3 for a held worker lock (not
expected here, the state directory is new). `run.log` is the file the summary's `logPath`
names, uploaded only if it lies inside the job's state directory; logs over 20 MB are cut to
their last 20 MB.

The same document, without `stderrTail`, is logged as one line starting with `RESULT`, so the
outcome survives a failed upload. For a shell inside a running job, deploy with
`IngressNetworkConnectorArn` set to the `SHELL_INGRESS` connector and use
`aws lambda-microvms create-microvm-shell-auth-token`; do not leave that on.

## Design decisions

**HTTP API, not a function URL.** Both deliver the raw body the signature is computed over.
The HTTP API was chosen because it has throttling in front of the function (an
unauthenticated endpoint otherwise invokes the function for every request anyone sends), a
single `POST /webhook` route with everything else answered by API Gateway, and no dependence
on function-URL resource policies. Its limits fit: 10 MB payloads (issue events are a few
kilobytes), 30 seconds integration timeout (GitHub waits 10).

**The AWS SDK is vendored, not taken from the runtime.** `sam build` installs
`launcher/package.json` into the function package. The Node.js 22 runtime ships an SDK, but
whether its version includes the MicroVMs client is not something to depend on. The image
installs the runner's SDK clients with `npm ci` from `image/runner/package-lock.json`.

**Deduplication: a DynamoDB conditional put with a TTL, released on failure.** Described
under [Redelivery, deduplication and idempotency](#redelivery-deduplication-and-idempotency).
It costs one write per accepted delivery. A plain time window would make a failed job
unretryable until it passed, so the launcher and the runner remove the item when the attempt
did not end cleanly. It fails open. Separately, the SDK's `clientToken` (filled in
automatically, reused across the SDK's own retries) keeps one invocation from starting two
microVMs.

**Two time limits inside the microVM.** The runner passes `--deadline-minutes` to
`run-event`, three minutes short of its own watchdog, which is `WatchdogReserveSeconds` short
of the microVM's maximum duration. At the deadline `run-event` stops the agent itself and
still prints its summary; the watchdog (SIGTERM to the process group, SIGKILL 20 seconds
later) is only for a `run-event` that does not. With the defaults: maximum 120 minutes,
watchdog at 115, deadline at about 111.

**Config in S3, not baked into the image.** An image build takes minutes and makes a new
image version; a config change should not need one. S3 holds several files (config and
prompts), which a single SSM parameter cannot. The execution role can read `config/` but not
write it, so a job cannot change the config of later jobs.

**The image is generic; every reference travels in the run-hook payload.** The bucket, keys,
secret ARNs and time limits are in the payload the launcher builds, so the image contains no
account-specific value and the same image works for any stack.

**The hook server holds nothing and starts the job as a new process.** `server.mjs` is running
when the snapshot is taken, so its memory is the same in every microVM. It uses no TLS, no
SDK, no randomness and no secrets. `/run` spawns `run-job.mjs`, which starts its life inside
the microVM: its TLS state, the temporary directory name and everything it fetches are
per-run, as the snapshot documentation requires.

**`/run` answers before anything is fetched.** The hook validates the payload and returns 200;
fetching the event, config and secrets happens in the job process. A failure there is
reported in the result document and the microVM terminates itself, instead of a hook timeout
that would leave only a `stateReason`.

**Build settings are a file, not build arguments.** `CreateMicrovmImage` has no build-argument
input. `image/build.env` holds `NODE_VERSION` (Node.js 24 by default), `UPDRAFT_SPEC`,
`AGENT_PACKAGES`, `TOOL_PACKAGES` (global npm tools for the repositories, TypeScript by default),
`SYSTEM_PACKAGES` (system packages: Python 3.12 with pip, a C/C++ toolchain, make and a few
small tools by default) and `PYTHON_COMMAND` (what `python` and `python3` mean on PATH);
`deploy.sh` appends overrides from its environment to the copy in the build context.

**4 GB baseline memory by default.** The documented sizes give 8 GB of disk up to a 2 GB
baseline and 16 GB at 4 GB. A clone, its dependencies and an agent fit more comfortably in
the latter. Set `IMAGE_MEMORY_MIB=2048` for the service default.

### Why the image is not in the template

The CloudFormation Template Reference lists `AWS::Lambda::MicrovmImage` (and
`AWS::Lambda::NetworkConnector`), so the resource type exists. The image is still created by
`deploy.sh` with the AWS CLI, for three reasons: the build context must be in S3 before the
resource is created, and the bucket is part of the same stack; the reference describes the
build as asynchronous ("use GetMicrovmImage to poll for completion") and does not say whether
a stack operation waits for it or fails with it; and its page marks nearly every property as
required, which does not match the API and makes me doubt the page more than the type. The
script waits for the build and reports its failure reason. Moving the image into the template
later is a small change: the stack already exports the build role and the launcher already
derives the image ARN from the name.

## The MicroVMs API as used here

Field names were taken from the type definitions of `@aws-sdk/client-lambda-microvms`
3.1171.0 and checked against the pages named below (all under
`https://docs.aws.amazon.com/lambda/latest/dg/`).

### RunMicrovm (launcher)

```js
{
  imageIdentifier: "arn:<partition>:lambda:<region>:<account>:microvm-image:<ImageName>",
  imageVersion: "<ImageVersion>",                 // only when the parameter is set
  executionRoleArn: "<MicrovmExecutionRole ARN>",
  ingressNetworkConnectors: ["arn:<partition>:lambda:<region>:aws:network-connector:aws-network-connector:NO_INGRESS"],
  egressNetworkConnectors: ["arn:<partition>:lambda:<region>:aws:network-connector:aws-network-connector:INTERNET_EGRESS"],
  maximumDurationInSeconds: 7200,
  idlePolicy: { maxIdleDurationSeconds: 7200, suspendedDurationSeconds: 0, autoResumeEnabled: false },
  logging: { cloudWatch: { logGroup: "/aws/lambda-microvms/<ImageName>" } },
  runHookPayload: "<JSON string, see below>"
  // clientToken: added by the SDK (idempotency token)
}
```

| Field | Source |
| --- | --- |
| `imageIdentifier`, `imageVersion`, `executionRoleArn`, `maximumDurationInSeconds` (1 to 28,800), `runHookPayload` (string, 16 KB), `logging`, connectors | `microvms-launching.html`, "Key parameters" |
| Image ARN format | `microvms-security.html`, "Resource ARN formats" |
| `INTERNET_EGRESS` connector ARN | `microvms-launching.html` and `microvms-getting-started.html` (example commands) |
| `NO_INGRESS` | `microvms-launching.html` (note under "Key parameters") and `microvms-networking.html`, "Ingress connectors": no inbound connectivity, hooks still work. The documentation gives the name, not the ARN; the ARN here follows the pattern of the documented `HTTP_INGRESS` and `SHELL_INGRESS` ARNs |
| `idlePolicy` fields; "for asynchronous applications ... disable automatic suspension or configure a suitable idle duration" | `microvms-launching.html`, "Idle policy configuration" |
| `suspendedDurationSeconds: 0` with `autoResumeEnabled: false` for per-session microVMs | `microvms-integrations-claude-managed-agents.html`, "Idle policy" |
| `logging: { cloudWatch: { logGroup } }`, stream defaults to the microVM id | `microvms-monitoring.html`, "Custom log destinations" |
| Errors to expect (`ServiceQuotaExceededException`, `ResourceNotFoundException`, `ValidationException`, `ThrottlingException`) | `microvms-launching.html`, "Error handling" |

The run-hook payload (under 1 KB; the launcher refuses to send more than 16,384 bytes):

```json
{
  "version": 1,
  "deliveryId": "<X-GitHub-Delivery>",
  "eventName": "issues",
  "region": "<region>",
  "bucket": "<bucket>",
  "eventKey": "events/<delivery>/event.json",
  "resultKeyPrefix": "results/<delivery>/",
  "configPrefix": "config/",
  "secrets": { "githubAppPrivateKey": "<secret ARN>", "agentEnv": "<secret ARN>" },
  "maximumDurationSeconds": 7200,
  "watchdogReserveSeconds": 300,
  "launchedAt": "<ISO time the launcher called RunMicrovm>",
  "dedupeTable": "<table name; absent when deduplication is off>"
}
```

### Idle policy

A microVM with no traffic on its endpoint counts as idle and is suspended after
`maxIdleDurationSeconds`. A job never gets endpoint traffic. With `IdlePolicyMode=explicit`
(the default) the launcher sets `maxIdleDurationSeconds` to the maximum duration, so the
microVM reaches its hard lifetime before it can be considered idle for long enough, and
`suspendedDurationSeconds: 0` with `autoResumeEnabled: false`, so that a microVM that is
suspended anyway is not kept. If the service rejects that combination (a
`ValidationException` in the launcher's log), deploy with `IdlePolicyMode=omit`, which sends
no idle policy at all, and check with `get-microvm` what a microVM then reports. The runner
answers `/suspend` with 200 and logs a warning, so a suspension is visible in the job's log.

### Lifecycle hooks (image and runner)

Lambda sends `POST /aws/lambda-microvms/runtime/v1/<hook>` to the port configured on the image
(`microvms-launching.html`, "Lifecycle hooks" and its OpenAPI specification;
`microvms-images.html`, "MicroVM image build hooks").

| Hook | Enabled | Runner's answer |
| --- | --- | --- |
| `/ready` | yes, 300 s | 200 as soon as the server listens; Lambda then takes the snapshot |
| `/validate` | no | 200 if called |
| `/run` | yes, 60 s | Body `{ "microvmId", "runHookPayload" }`. 200 after validating it and starting the job process; 400 for a body it cannot use (the microVM is then terminated by Lambda); a second `/run` is ignored with 200 |
| `/terminate` | yes, 60 s | Signals the job, which stops Updraft and writes a result with `outcome: terminated`; waits up to 45 s; 200 |
| `/suspend` | yes, 30 s | 200, with a warning in the log |
| `/resume` | no | 200 if called |

The image is created with this hook configuration (`deploy.sh`, as `--cli-input-json`, in the
API's field names):

```json
{
  "port": 9000,
  "microvmImageHooks": { "ready": "ENABLED", "readyTimeoutInSeconds": 300 },
  "microvmHooks": {
    "run": "ENABLED", "runTimeoutInSeconds": 60,
    "terminate": "ENABLED", "terminateTimeoutInSeconds": 60,
    "suspend": "ENABLED", "suspendTimeoutInSeconds": 30
  }
}
```

The 60 second ceiling for the runtime hooks and 3,600 for the build hooks are from the
CloudFormation Template Reference for `AWS::Lambda::MicrovmImage` (`MicrovmHooks`,
`MicrovmImageHooks`); `runTimeoutInSeconds` is also named on
`microvms-integrations-claude-managed-agents.html`.

Other calls: `TerminateMicrovm({ microvmIdentifier })` from the runner
(`microvms-launching.html`, "Terminating a MicroVM"); `create-microvm-image`,
`update-microvm-image` (which needs `baseImageArn` and `buildRoleArn` every time),
`get-microvm-image`, `get-microvm-image-version` and `list-microvms` from `deploy.sh`
(`microvms-images.html`, `microvms-getting-started.html`).

## Security model

**What the launcher trusts.** Only the HMAC. A request without a valid `X-Hub-Signature-256`
over its raw body gets 401 before the body is parsed. The comparison is constant-time, and an
empty secret is never accepted. A valid signature proves the delivery comes from GitHub for
this App; it says nothing about whether the event should lead to work. The launcher's filter
(event, action, optionally label) only avoids starting microVMs for nothing.

**What the microVM re-checks.** Everything that decides whether an agent runs is decided by
`updraft run-event` against the GitHub API and the config: that the repository and label are
configured, that the label event is the latest application of that label, that its actor is
in `allowedActors`, that the issue was not edited by someone else since (see
[docs/security.md](../../docs/security.md)). The webhook body is treated as a hint about
which issue to look at.

**What reaches the microVM.** The run-hook payload has no secret and no issue text: the
delivery id, the event name, S3 keys, two secret ARNs and time limits. With `NO_INGRESS`
there is no endpoint to connect to; only Lambda calls the hooks.

**What an agent inside the microVM can reach.** Be clear about this one. Agents run in
full-auto mode on issue text, and the microVM is the only boundary around them:

- *The network.* Egress is the public internet (or what your VPC connector allows).
- *The agent's API key.* It is in the agent's environment; it has to be.
- *The GitHub App's private key.* Updraft runs as the job user and reads the key file, and it
  starts the agent as the same user, so the agent can read the file. Updraft does not put the
  key or its path in the agent's environment, and the runner starts Updraft with an
  environment built from nothing (no `AWS_*`, no run request). That prevents accidents; it
  does not stop an agent that goes looking.
- *The execution role.* The documentation describes the microVM's AWS credentials as provided
  through IMDSv2 and says nothing about restricting which process may ask for them (no hop
  limit, no per-user rule). Assume any process in the microVM can obtain the role's
  credentials. With them it can read the two secrets again, read `config/` and `events/` of
  this deployment (including other deliveries' webhook bodies), write objects under
  `results/`, delete items from the delivery table (which only makes a redelivery possible
  again), and terminate microVMs of this image, its own and other jobs'. It cannot write the
  config, read the webhook secret, start microVMs or touch anything else in the account.

So an agent that is talked into it by an issue's text can obtain the App's private key, and
with it act as the App on every repository the App is installed on until the key is revoked.
What limits that today: only `allowedActors` can start a job at all; install the App on the
job repositories only and grant only the permissions above; protect the base branches on
GitHub, so that the App's Contents permission cannot push to them directly; rotate the key if
a run looks wrong. Two changes would close most of the gap, and neither is built (see below):
a firewall rule in the microVM that keeps the job user away from the metadata endpoint, and
giving the job a short-lived installation token, minted outside the agent's reach, instead of
the key.

**Roles.** The launcher's role can put objects under `events/`, put and delete items in the
delivery table, read the webhook secret, call
`lambda:RunMicrovm` on the one image and pass the one execution role. The build role can read
`image/*` and write build logs. The execution role is listed above. The bucket blocks public
access, refuses non-TLS requests and expires `events/` and `results/`.

**Left open.** The stored webhook bodies and results contain issue text and are readable by
anyone with read access to the bucket. So are the uploaded logs: `run.log` is the agent's
whole transcript, and neither it nor `stderrTail` is filtered by the runner (Updraft redacts
the tokens it knows about from its own output; an agent can print anything). The HTTP API is public by
necessity; its throttle and the signature check are its only protection (no WAF).

## Cost and quotas

No prices are quoted here; see [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/).
What the documentation says about what is billed and limited:

- A running microVM incurs compute charges: the baseline rate for its size, plus what it uses
  above the baseline (it can scale to four times the baseline), per second. A suspended
  microVM incurs snapshot storage charges instead; a terminated one incurs nothing. This
  design never keeps a microVM suspended and terminates each one as soon as its job ends, so
  a job costs its running time. `MaximumDurationSeconds` caps a job that hangs.
- Every image build creates a new image version, and image versions are stored at a cost.
  Delete old ones (`aws lambda-microvms delete-microvm-image-version`).
- The account has a quota for the total memory of all running and suspended microVMs in a
  Region (Service Quotas, "Lambda MicroVMs"). When it is reached, `RunMicrovm` fails with
  `ServiceQuotaExceededException`, the launcher answers 500 and the delivery has to be
  redelivered. Nothing here queues.
- The rest is ordinary: one short Lambda invocation and one HTTP API request per webhook
  delivery (every issue event, not only label events), one DynamoDB write per accepted
  delivery (on-demand table), three secrets, CloudWatch Logs ingestion for the whole agent
  transcript, a small S3 bucket, and the agent's own API usage.
- CloudTrail records `RunMicrovm` and `TerminateMicrovm` as data events, which are not logged
  unless enabled.

## Not yet built

- **Review and revision loops.** Only `issues.labeled` starts work. `pull_request_review`
  webhooks (a "Request changes" review starting a revision, Updraft's reviewer agent) are not
  handled; the launcher ignores those events. Do not set `revise` or `review` in this
  config and expect them to act.
- **Concurrency limits across microVMs.** Every accepted delivery starts a microVM at once.
  Updraft's `maxConcurrent` settings apply within one process and mean nothing here. The only
  ceiling is the account's MicroVM memory quota, and hitting it loses the delivery until
  someone redelivers it.
- **Auto-merge.** Not available, and it should not be enabled on this deployment before the
  credential exposure described under [Security model](#security-model) is closed.
- **Automatic retry.** A failed launch is a 500 in the App's delivery list and a failed job
  is a result object; nobody redelivers either automatically. A microVM that dies without
  reporting keeps its delivery record until the window has passed.
- **Keeping the App key and the execution role away from the agent** (metadata-endpoint
  firewall for the job user; installation token instead of the key; a separate OS user for
  the agent).
- **Cleanup of old image versions**, alarms, a dashboard, a dead-letter path for failed
  launches.
- **The image as a CloudFormation resource**, and VPC egress beyond passing a connector ARN.
- **Failure comments when the runner itself fails.** If the job cannot start (bad secret, no
  config), the result object says so; nothing is written to the issue.

## What is not verified

Nothing in this directory has been run against AWS: there were no credentials where it was
written. Docker was not available either, so the Dockerfile has never been built. These are
the specific points taken on trust or inferred, each to be confirmed on the first deployment:

1. **`NO_INGRESS` connector ARN.** The documentation names the connector but does not print
   its ARN. `...:network-connector:aws-network-connector:NO_INGRESS` is inferred from the
   documented ARNs of the other Lambda-provided connectors. Override with
   `IngressNetworkConnectorArn` if it is wrong.
2. **Idle policy semantics.** Whether `maxIdleDurationSeconds` equal to the maximum duration
   is accepted, whether `suspendedDurationSeconds: 0` behaves as on the Claude Managed Agents
   page for this case, and what omitting the idle policy does. The documentation says to
   "disable automatic suspension" for asynchronous work without saying how.
3. **`iam:PassRole`.** The launcher's role and the deploying identity are assumed to need
   `iam:PassRole` for the execution and build roles. The documentation does not mention it.
4. **IAM resources for microVM actions.** `lambda:RunMicrovm` and `lambda:TerminateMicrovm`
   are scoped to the image ARN, following the documentation's example operator policy. Whether
   that is how these actions are authorised, and whether RunMicrovm also needs permissions on
   the connectors, is not stated.
5. **Credentials inside the microVM.** One page says "IAM through IMDSv2". How the AWS SDK's
   default credential chain finds the role, whether there is a hop limit, and whether a
   non-root process can reach the endpoint are not documented. The runner assumes the default
   chain works; the security model assumes the agent can reach it too.
6. **Region inside the microVM.** Not assumed: the Region is passed in the payload.
7. **The container's user.** The runner assumes the ENTRYPOINT runs as root, which it needs to
   start the job as the `updraft` user. If it does not, the job runs as the runner's own user
   and the log says so.
8. **Hook timing.** The default hook timeouts are not documented; the image sets them. That
   `/terminate` is called when the maximum duration is reached, and how long the microVM
   lives after a self-requested `TerminateMicrovm`, are not documented. The watchdog exists so
   that the result does not depend on either.
9. **Self-termination.** That a microVM may call `TerminateMicrovm` on itself with its
   execution role is assumed.
10. **Logs.** That output of child processes (which inherit the ENTRYPOINT's stdout and
    stderr) is forwarded like the ENTRYPOINT's own, and that Lambda accepts a log group
    created beforehand by the stack.
11. **The base container image.** `public.ecr.aws/lambda/microvms:al2023-minimal` is
    documented; its contents are not. The Dockerfile assumes `sh`, `dnf` or `microdnf`, and
    the package names `git tar xz gzip shadow-utils ca-certificates findutils`
    (`curl-minimal` if there is no curl). It assumes the build has internet access (the
    documented default) to reach `nodejs.org` and the npm registry, and that `COPY`, `RUN`,
    `ENV` and `ENTRYPOINT` behave as in Docker.
12. **Image sizing.** `resources[0].minimumMemoryInMiB` is from the SDK's types; the accepted
    values are assumed to be the documented sizes in MiB (512, 1024, 2048, 4096, 8192).
    Whether the image's contents count against the microVM's disk limit is not documented.
13. **AWS CLI.** `aws lambda-microvms create-microvm-image`, `update-microvm-image`,
    `get-microvm-image`, `list-microvms` and `terminate-microvm` appear in the documentation.
    `get-microvm-image-version` is derived from the API operation `GetMicrovmImageVersion`
    (the documentation shows `update-microvm-image-version`). The request is passed with
    `--cli-input-json`, a general CLI feature, using the API's field names from the SDK.
14. **State names.** The documentation's table says `CREATION_FAILED`; the SDK and the
    CloudFormation reference say `CREATE_FAILED`. `deploy.sh` waits on the version state
    (`SUCCESSFUL` or `FAILED`), which both agree on.
15. **The clock after a snapshot restore.** GitHub App JWTs and the watchdog need a correct
    wall clock as soon as the job starts. Not documented.
16. **`clientToken`.** The SDK marks it as an idempotency token and fills it in; what the
    service does with a repeated token is not described.
17. **The SAM template.** Parsed as YAML and checked for dangling references by a script;
    `sam validate`, `cfn-lint` and a deployment have not been run.
18. **`deploy.sh`.** Checked with `bash -n` and a dry run of the `image` step against a
    stand-in `aws` command (request JSON and zip contents inspected). The `stack` and `config`
    steps have not been run at all.
19. **GitHub's redelivery behaviour.** That GitHub does not retry failed deliveries on its own,
    and that a redelivery keeps the delivery id, is from memory; GitHub's documentation was
    not reachable when this was written.
20. **`updraft run-event`.** It does not exist in the commit this was written against. The
    runner follows its contract as communicated (`image/runner/job.mjs`: `updraftInvocation`,
    `describeExitCode`) and reads three things from the summary: that it is a JSON object on
    the last stdout line, `outcome`, and `logPath`. `updraft.log` is read from
    `$UPDRAFT_HOME/logs/`, where the CLI writes it. That `logPath` is an absolute path or
    relative to `$UPDRAFT_HOME` is an assumption; a log that is not found is skipped silently.
21. **DynamoDB from the microVM.** With internet egress the public endpoint is assumed
    reachable, like S3 and Secrets Manager. With a VPC connector all three (and
    `lambda.<region>.amazonaws.com` for TerminateMicrovm) need a route or endpoints.

## Tests

`npm test` at the repository root runs `deploy/aws-microvm/test/*.test.mjs` with the rest of
the suite:

- `launcher.test.mjs`: signature verification (GitHub's documented example, wrong secret,
  missing and malformed headers, tampered body, empty secret, `timingSafeEqual` on
  equal-length digests), the event filter, configuration, the `RunMicrovm` input (exact
  shape; no secret, no issue text; under 16 KB; accepted by the runner's parser), the
  handler's responses with stand-ins for S3, Secrets Manager and RunMicrovm, and
  deduplication with a stand-in table (duplicate, expiry, release on a failed launch, table
  unreachable).
- `runner-hooks.test.mjs`: hook routing over a real HTTP server.
- `runner-job.test.mjs`: the job, with stand-ins for AWS and `fake-updraft.mjs` in place of
  `updraft`, as a real child process: success, failure, no summary, a run that outlives the
  watchdog (stopped with SIGTERM, then SIGKILL), termination during a run, unusable secrets
  and config, the job's environment, the `--deadline-minutes` it passes, log upload (including
  a `logPath` that points or links outside the state directory), release of the delivery
  record, retries of the report and the termination.

Not covered by tests: `launcher/index.mjs` (which holds the DynamoDB condition expression), `image/runner/aws.mjs`, `run-job.mjs` and
`server.mjs` (thin wiring that needs the AWS SDK, which the repository does not depend on;
each was started by hand with the SDK installed, without AWS), switching to the job
user (the tests do not run as root with a second user), the Dockerfile, the template and
`deploy.sh` beyond what is said above.

`npm run lint` covers these `.mjs` files. `npm run typecheck` does not: they are plain
JavaScript with JSDoc comments, outside `tsconfig.json`.
