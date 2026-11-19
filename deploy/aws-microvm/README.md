# Updraft on AWS Lambda MicroVMs

A reference deployment that runs each Updraft job in its own
[AWS Lambda MicroVM](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html),
started by a GitHub App webhook. There is no always-on worker: applying a trigger label to an
issue starts a microVM, the microVM runs the agent, opens the pull request and terminates
itself. Updraft's state database, which a long-running worker keeps on its disk, lives in S3:
each microVM starts from the latest copy and merges what it changed back, so cooldowns, the
triage cache, rotation, `updraft stats` and the review loop work across microVMs.

> **Status: written from the documentation, not yet run on AWS.** The launcher's logic and the
> runner's logic are covered by tests that need no AWS (127 of them, part of `npm test`). The
> SAM template, `deploy.sh`, the Dockerfile and every call to AWS have never been executed
> against the real services. [What is not verified](#what-is-not-verified) lists each
> assumption in one place. Expect to fix things on the first deployment.
>
> It also depends on parts of the Updraft CLI that were written at the same time as this
> directory and are not in the commit it was written against: `updraft state merge`,
> `updraft state info`, and `updraft run-event` handling pull request events and running the
> review loop on a state directory that already has history. The runner follows their
> contract as it was communicated and was tested with a stand-in, never with the real
> commands. Every use of them is in one function each (`updraftInvocation` in
> `image/runner/job.mjs`; `stateMergeInvocation`, `readMergeReport` and `stateInfoInvocation`
> in `image/runner/state.mjs`). The image build fails with a clear message if the Updraft it
> installs has no `run-event` or no `state merge`.

## Architecture

```
GitHub App webhook (events: Issues; with the review loop also Pull request reviews, Pull requests)
        |  POST /webhook    X-Hub-Signature-256, X-GitHub-Event, X-GitHub-Delivery
        v
API Gateway HTTP API  (throttled; one route)
        v
Launcher Lambda function  (launcher/, Node.js 22)
        |  1. verify the HMAC over the raw body (secret from Secrets Manager); else 401
        |  2. keep only accepted events (AcceptedEvents): issues.labeled (optionally: only some
        |     labels); pull_request_review.submitted/edited/dismissed and
        |     pull_request.synchronize/closed on Updraft's own branches;
        |     else 200, nothing started
        |  3. record the delivery id (DynamoDB, conditional put); already there: 200, nothing started
        |  4. pull request events: take a lease of a few seconds on the pull request (same
        |     table); held by an earlier event: 202, nothing started (coalesced)
        |  5. store the body          -> s3://BUCKET/events/<delivery>/event.json
        |  6. RunMicrovm(image, execution role, NO_INGRESS, internet egress,
        |                maximum duration, run-hook payload = references only)
        |  7. 202
        v
Lambda MicroVM  (image/, one per launch, restored from the image snapshot)
   runner/server.mjs   hook server on port 9000 (ENTRYPOINT, root, part of the snapshot)
        |  POST /aws/lambda-microvms/runtime/v1/run  { microvmId, runHookPayload }  -> 200 at once
        v
   runner/run-job.mjs  new process (root), with the microVM's execution role:
        |  event            <- s3://BUCKET/events/<delivery>/event.json
        |  config, prompts  <- s3://BUCKET/config/*
        |  App private key, agent API keys  <- Secrets Manager
        |  state database   <- s3://BUCKET/state/state.db  (GET; its ETag is remembered;
        |                      a pristine copy is kept where only root can read it)
        |  all written to a fresh directory, owner-only, owned by the job user
        v
   updraft run-event --event-file ... --event-name <event> --delivery-id ... --json
                     --deadline-minutes <n>
        |  as user "updraft" (not root), on the state database it was given; re-checks
        |  everything against the GitHub API, clones, runs the agent (full-auto) and the
        |  verify commands, opens the PR; with review/revise configured also runs the
        |  reviewer, the revisions and the wait for CI, all in this one run
        |
        |  meanwhile, runner: a checkpoint whenever the run's database changed, at most every
        |    StateCheckpointSeconds: the state sync below with `state merge --live`
        |  exit code 6 (the event's pull request is Updraft's, the snapshot does not know it
        |    yet): wait for the state object's ETag to change, download it, run the event
        |    again; at most StatePendingWaitSeconds in all, then the job has failed
        v
   runner: state sync, whatever the job's outcome, at most 4 times:
        |    latest database  <- s3://BUCKET/state/state.db  (GET, ETag)
        |    updraft state merge --changed <run's db> --into <latest> [--base <pristine>] --json
        |                      (as user "updraft", without AWS credentials)
        |    changed: false -> done.  Else updraft state info on the result, then
        |    PUT s3://BUCKET/state/state.db  If-Match: <ETag>   (If-None-Match: * if there was none)
        |    412 or 409: somebody else wrote first -> again with the newer object
        |  not saved: s3://BUCKET/state/unsaved/<delivery>/<attempt>/ gets base.db, then changed.db
        |    (updraft state copy), then manifest.json; the result says state_not_saved, the
        |    delivery record is removed
        v
   runner: updraft.log, run.log -> s3://BUCKET/results/<delivery>/<microvm-id>/
           result               -> s3://BUCKET/results/<delivery>/<microvm-id>.json
           job did not end well (or its state was not saved): remove the delivery record, so it
           can be redelivered
           TerminateMicrovm(own id)          (a watchdog stops a job that runs too long)
```

Files:

| Path | What it is |
| --- | --- |
| `template.yaml` | SAM template: HTTP API, launcher function, bucket (versioned), delivery table, secrets, IAM roles, log groups |
| `deploy.sh` | Deploys the stack, uploads the config, creates or updates the MicroVM image and waits for the build; `state info`, `state pull`, `state unsaved` and `state recover` for the shared state |
| `launcher/` | The launcher function. `lib/` is the logic (tested); `index.mjs` wires the AWS SDK to it |
| `image/Dockerfile`, `image/build.env` | The MicroVM image: git, Node.js, Updraft, agent CLIs, toolchain, the runner |
| `image/runner/` | Hook server (`server.mjs`, `hooks.mjs`), the job (`run-job.mjs`, `job.mjs`), the shared state (`state.mjs`), AWS calls (`aws.mjs`) |
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
- An API key for the agent (for Claude Code: an Anthropic API key). For the review loop, a
  second agent and its key (for Codex: an OpenAI API key, passed as `CODEX_API_KEY`).
- An Updraft with `run-event`, `state merge` and `state info`. Until such a version of
  `@allenheltondev/updraft` is on npm: a tarball of it from `npm pack`.

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
   prints all outputs later. With the defaults the launcher accepts `issues` events only;
   see [The review loop](#the-review-loop) for the rest.

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

   # The agents' keys: a JSON object of environment variables for the job, one entry per
   # agent CLI in the image. Write it to a file that you delete afterwards:
   #   {"ANTHROPIC_API_KEY": "<Claude Code's key>", "CODEX_API_KEY": "<Codex's key>"}
   aws secretsmanager put-secret-value --secret-id <AgentEnvSecretArn> \
     --secret-string file://<file-with-that-JSON-object>
   # With Claude Code alone, the file may hold just the key (taken as ANTHROPIC_API_KEY).

   # The webhook secret was generated by Secrets Manager. Read it to paste it into GitHub:
   aws secretsmanager get-secret-value --secret-id <WebhookSecretArn> --query SecretString --output text
   ```

   To use secrets you already have, pass their ARNs instead
   (`SAM_PARAMETER_OVERRIDES="WebhookSecretArn=... GitHubAppPrivateKeySecretArn=... AgentEnvSecretArn=..."`).
   No secret value is ever in the template, a parameter or the run-hook payload. The JSON
   object may not set names that would change the job process itself or carry credentials
   this design keeps away from it (`AWS_*`, `UPDRAFT_*`, `NODE_*`, `GH_TOKEN`, `PATH`, ...);
   the runner refuses such a secret.

4. **Build the MicroVM image.**

   ```sh
   # From npm, once a version with run-event and the state commands is published. Two
   # agents: Claude Code writes, Codex reviews (see "The review loop").
   UPDRAFT_SPEC=@allenheltondev/updraft@<version> \
   AGENT_PACKAGES="@anthropic-ai/claude-code @openai/codex" ./deploy.sh image

   # Or from this checkout:
   (cd ../.. && npm pack)            # writes allenheltondev-updraft-<version>.tgz
   UPDRAFT_TARBALL=../../allenheltondev-updraft-<version>.tgz \
   AGENT_PACKAGES="@anthropic-ai/claude-code @openai/codex" ./deploy.sh image
   ```

   The script zips `image/`, uploads it to `s3://<bucket>/image/`, calls
   `create-microvm-image` (or `update-microvm-image` when the image exists) and polls the new
   version until it is `SUCCESSFUL` or `FAILED`. Build logs are in the log group
   `/aws/lambda-microvms/<image-name>`. Other settings: `IMAGE_ARCH` (`ARM_64`), `IMAGE_MEMORY_MIB`
   (`4096`), `AGENT_PACKAGES` (Claude Code alone by default), `TOOL_PACKAGES`,
   `SYSTEM_PACKAGES`, `PYTHON_COMMAND`, `NODE_VERSION`, `REQUIRE_STATE_COMMANDS`,
   `BASE_IMAGE_ARN`, `BASE_IMAGE_VERSION`.

   `./deploy.sh` with no argument does steps 1, 2 (if `config/config.yaml` exists) and 4.

5. **Point the GitHub App at the endpoint.** In the App's settings:

   - *Webhook*: **Active**. *Webhook URL*: the `WebhookUrl` output. *Content type*:
     `application/json` (the launcher answers 400 to form-encoded deliveries). *Secret*: the
     webhook secret from step 3.
   - *Permissions & events*, *Subscribe to events*: **Issues**. With the review loop on,
     also **Pull request review** and **Pull request**. Nothing else: the launcher ignores
     every other event, and every event it does not accept (`AcceptedEvents`), so more
     subscriptions only cost invocations.
   - *Repository permissions*: **Metadata** read-only; **Contents**, **Issues** and **Pull
     requests** read and write. **Workflows** read and write only if agents are meant to change
     files under `.github/workflows/`. For the review loop with `autoMerge`, which merges and
     reads the state of CI: **Contents** and **Pull requests** read and write (as above), and
     **Checks** and **Commit statuses** read-only. Nothing else. (The first sentence is the
     table in [docs/github-app.md](../../docs/github-app.md#permissions) for a deployment
     that publishes.) GitHub asks each installation to accept added permissions.
   - Install the App on the repositories in your config, and only on those.

   GitHub sends a `ping` when the webhook is saved; the launcher answers 200 to it.

### Template parameters

Pass them through `SAM_PARAMETER_OVERRIDES="Key=Value ..."`.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `ImageName` | `updraft-job` | Name of the MicroVM image (set through `IMAGE_NAME`). The launcher runs `arn:<partition>:lambda:<region>:<account>:microvm-image:<ImageName>` |
| `ImageVersion` | empty | Pin an image version. Empty runs the latest active version |
| `MaximumDurationSeconds` | `14400` | Hard lifetime of a job's microVM (600 to 28,800). See [How long a run may take](#how-long-a-run-may-take) |
| `WatchdogReserveSeconds` | `600` | The runner stops the job this long before the maximum duration, and uses that time for state sync, logs and the result |
| `AcceptedEvents` | `issues` | Comma-separated webhook events that may start a microVM: `issues`, `pull_request_review`, `pull_request`. Set `issues,pull_request_review,pull_request` for the review loop |
| `PullRequestBranchPrefix` | `updraft/` | Pull request events start a microVM only for pull requests whose head branch starts with this (Updraft's job branches). Empty turns the check off |
| `IgnoredSenders` | empty | Comma-separated logins whose pull request events start nothing. Set it to the App's own `<app-slug>[bot]` |
| `PullRequestCoalesceSeconds` | `20` | Events for a pull request within this long of one that started a microVM start none (0 to 300; `0` launches for every event). See [Coalescing pull request events](#coalescing-pull-request-events) |
| `SharedState` | `enabled` | `disabled`: every job starts from an empty state database and saves nothing, as before this existed |
| `StateVersionRetentionDays` | `30` | How long a replaced version of the shared state database stays recoverable, and how long a database that could not be saved is kept under `state/unsaved/` |
| `StateCheckpointSeconds` | `20` | While a job runs, what it recorded so far is merged into the shared state whenever its database changed, at most this often (0 to 3600; `0`: only at the end). See [Checkpoints](#checkpoints) |
| `StatePendingWaitSeconds` | `180` | How long, in all, a job for a pull request that the shared state does not know yet waits inside its microVM for that state to arrive (0 to 1800; `0`: it fails at once). See [A pull request the state does not know yet](#a-pull-request-the-state-does-not-know-yet) |
| `IdlePolicyMode` | `explicit` | See [Idle policy](#idle-policy) |
| `EgressNetworkConnectorArn` | empty | A VPC egress network connector. Empty uses the Lambda-provided internet egress connector |
| `IngressNetworkConnectorArn` | empty | Empty uses the Lambda-provided `NO_INGRESS` connector. Set it only for debugging, for example to the `SHELL_INGRESS` connector |
| `DedupeWindowSeconds` | `14400` | How long a redelivery of a delivery that already started a microVM is ignored, unless that job reported a failure. About `MaximumDurationSeconds`. `0` turns deduplication off. See [Redelivery, deduplication and idempotency](#redelivery-deduplication-and-idempotency) |
| `TriggerLabels` | empty | Comma-separated label names. When set, only these labels start a microVM. It must contain every trigger label in the Updraft config; it is a cost saving, not a control |
| `WebhookSecretArn`, `GitHubAppPrivateKeySecretArn`, `AgentEnvSecretArn` | empty | Use existing secrets instead of creating them |
| `EventRetentionDays`, `ResultRetentionDays` | `14`, `90` | S3 lifecycle expiry of `events/` and `results/` |
| `LogRetentionDays` | `30` | Retention of both log groups |
| `WebhookRateLimit`, `WebhookBurstLimit` | `10`, `20` | HTTP API throttling in front of the launcher |

Every parameter that existed before the shared state and the review loop keeps its name and
meaning. Three defaults changed: `MaximumDurationSeconds` (was 7200), `WatchdogReserveSeconds`
(was 300) and `DedupeWindowSeconds` (was 7200). A deployment that passes its own values keeps
them.

### How long a run may take

With `review` and `revise` in the Updraft config, one `run-event` holds the whole loop for the
pull request it opened: the agent run, verification, a reviewer run, then per round a
revision, its verification and another review, and with `autoMerge` a wait for CI. The
microVM's maximum duration bounds all of it together. The runner gives `run-event` a
`--deadline-minutes` a few minutes short of it (see
[Two time limits](#design-decisions)); at that deadline `run-event` stops what it is doing and
reports, and the loop continues only when another event arrives for the pull request.

The default of 14,400 seconds (4 hours) is sized for an action with `timeoutMinutes: 60`:
the first run with its verification (up to about 75 minutes), a review (usually much
shorter than a coding run), and two rounds of revision and review.
Estimate yours as `timeoutMinutes + verification`, times `1 + maxRevisions`, plus the reviews,
plus `autoMergeWaitMinutes`, and raise the parameter if it does not fit; the service's limit
is 28,800 (8 hours). Without `review` and `revise` 7200 is enough. A microVM is terminated as
soon as its job ends, so a generous value costs nothing for jobs that finish; it is what a
job that hangs can cost.

`WatchdogReserveSeconds` is what the runner keeps for itself at the end. After a job that had
to be stopped: 20 seconds to kill it, then state sync (at most 5 minutes, and never past 90
seconds before the microVM's end), then the logs, the result and the termination request.
600 leaves all of that room. Lowering it does not shorten state sync after a job that ended
by itself in good time; it only takes time away from a sync after a job that ran into the
watchdog.

## Config and prompts

The Updraft config and the prompt files live in S3 under `config/` and are downloaded by each
microVM into the directory that becomes `UPDRAFT_HOME`. To change repositories, labels,
allowed actors, agent arguments or a prompt: edit the files in `config/` and run
`./deploy.sh config`. The next job uses them. No image build, no stack deployment, no code.

Rules the runner imposes on that config (the example follows them):

- `execution.mode: live`, and a `github.app` block with `privateKeyPath: ./github-app.pem`.
  The runner writes the key from Secrets Manager to that path, mode 0600.
- No file named `state.db` (or `event.json`, `github-app.pem`) at the top of `config/`: the
  runner puts its own files there and refuses a config that would collide with them.
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

The image contains git, Node.js 24 with TypeScript, Python 3.12 with pip and uv, a C/C++
toolchain and a headless Chromium (`image/build.env` lists and pins them). If a repository's
`verify` commands or its agent need more (a JDK, a database), add it to `SYSTEM_PACKAGES` or
`TOOL_PACKAGES` there, or install it in `image/Dockerfile`, and rebuild the image.

## Shared state

A long-running `updraft start` keeps a SQLite database (`state.db`) next to its config: the
job queue and its history, capacity cooldowns, the triage cache and its hourly limit, the
rotation cursors of the pools, the pull requests it opened and the reviews it has seen, and
the metrics behind `updraft stats`. A microVM's disk is gone when it terminates, so this
deployment keeps that file in S3, at `s3://<bucket>/state/state.db`, and every job borrows
it:

1. **Before the job** the runner (root, with the execution role) downloads the object into
   the job's state directory as `state.db`, where `run-event` expects its database, and
   remembers that there was one. It keeps a second, pristine copy in a directory only root
   can enter: the merge base. No object is the normal first run; the job then starts from an
   empty database.
2. **The job runs** on its copy, as the job user. While it runs, the runner saves
   [checkpoints](#checkpoints) of it.
3. **After the job**, whatever its outcome (succeeded, failed, stopped by the watchdog;
   only a job that never started is skipped), the runner loops, at most four times:
   - download the latest object and its ETag into a scratch directory;
   - run `updraft state merge --changed <the run's database> --into <the latest> --base
     <the pristine copy> --json` as the job user. It is a three-way, row-level merge: what
     this run changed relative to what it started from is applied to what is in S3 now,
     which may already contain other runs' changes;
   - if the merge reports `changed: false`, stop: there is nothing to save;
   - check the result (`updraft state info` must open it; the file must start with a SQLite
     header, be at least 4096 bytes, have no write-ahead log next to it, and not have an
     older schema version than the object it replaces);
   - upload it with a conditional write: `If-Match: <the ETag downloaded>`, or
     `If-None-Match: *` when there was no object. If S3 answers that the precondition does
     not hold, another microVM saved in between: start again from its object.

**The S3 behaviour this relies on.** Conditional writes on `PutObject`: with `If-Match`, S3
writes the object only if the current object's ETag is the one given, and with
`If-None-Match: *` only if no object exists under the key; otherwise it answers
`412 Precondition Failed`. A conditional write that collides with another write in flight is
answered `409 ConditionalRequestConflict`, and an `If-Match` on a key that has no current
object `404`. The runner treats all three as "somebody else was first". Of several
conditional writes to one key, S3 lets the first to finish succeed and fails the rest. This
is from the S3 User Guide
([conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html))
and from the `IfMatch` and `IfNoneMatch` members of `PutObjectRequest` in
`@aws-sdk/client-s3` 3.1171.0, the version in `image/runner/package-lock.json`. It is what
makes two microVMs that finish at the same moment safe: neither can overwrite the other's
upload without having merged it first. The upload is a single `PutObject` of the whole file,
so readers never see half of one.

### Checkpoints

A run opens its pull request minutes after it starts and may then work for hours: a reviewer
run, revisions, a wait for CI. Saved only at the end, the pull request would be unknown to
every other microVM for all that time, and a person's review of it would reach a microVM that
has never heard of the pull request. So while `run-event` runs, the runner (root) looks at the
run's `state.db` and `state.db-wal` every two seconds (their size and modification time, read
with `lstat`; it never opens them), and when they changed since the last checkpoint, and at
least `StateCheckpointSeconds` (20) have passed since the last one started, it runs the state
sync of step 3 with one difference: `updraft state merge --live`.

- `--live` reads the run's database through SQLite, in one read transaction, so the merge sees
  one consistent state of it while the run keeps writing; it leaves the database's `-wal` and
  `-shm` files alone; and it marks nothing as ended. Work in flight (an open run, a running
  job, a review being posted) is carried as it is.
- The merge still runs as the job user, with an environment built from nothing: no AWS
  credentials, no agent keys. Download and conditional upload are the runner's, as in step 3.
- A checkpoint has a small budget (2 attempts, 45 seconds, never more than the microVM has
  left). Checkpoints never overlap: the next one is not started while one runs. A checkpoint
  that fails, hangs or loses the race twice is a log line (`checkpoint skipped ...`) and is
  tried again at the next interval. Nothing a checkpoint does can delay or fail the job: it
  only reads the job's files.
- When the job ends, the runner stops the checkpointer first (a checkpoint under way is
  aborted and waited for), and only then starts the final sync. The final sync merges against
  the same pristine copy as every checkpoint did; `updraft state merge` then finds the run's
  own earlier rows in the shared database, brings each to its final state, and adds nothing
  twice (Updraft's `docs/shared-state.md`, "Checkpoints").
- `StateCheckpointSeconds=0` turns checkpoints off.

What the runner did is in the result document: `state.checkpoints` has `attempted`, `saved`,
`unchanged` (the merge found nothing new), `failed`, `lastSavedAt` and `lastProblem`.

Each checkpoint that saves is a download and an upload of the whole database, and a new
version of the object. A run's database changes at least every 15 seconds while an agent
runs (the run's lease is renewed), so expect one checkpoint per interval per running job.
See [Cost and quotas](#cost-and-quotas).

### A pull request the state does not know yet

Between the moment a run opens its pull request and its first checkpoint after that, a
`pull_request_review` or `pull_request` delivery for it can start a microVM whose snapshot
has no record of the pull request. `run-event` does not answer "not ours" from the snapshot
alone: it asks the GitHub API whether the pull request is open, was opened by the App, is on a
job branch of the repository and carries Updraft's marker. If so, it exits with code 6
(outcome `state-pending`) and does nothing. The runner then:

1. asks S3 for the state object's ETag every 5 seconds (a list request);
2. when it differs from the snapshot's, removes the run's database, downloads the object again
   (a new pristine copy too) and runs `updraft run-event` again, in the same microVM;
3. repeats this while `run-event` exits 6: at most 6 runs, at most `StatePendingWaitSeconds`
   (180) of waiting in all, and never past the point where the watchdog would leave the next
   run less than four minutes.

If the pull request is still unknown after that, the job has **failed**: the result says
`outcome: "failed"`, `exitCode: 6`, `state.pending: { tries, waitedMs, resolved: false }`
and what to do; the delivery record is removed. Nothing redelivers by itself: redeliver that
delivery from the App's *Recent Deliveries* once the state has arrived. If it never will (the
run that opened the pull request died without saving anything), redeliver the pull request's
**`issues`** delivery instead: `run-event` then restores the publication from GitHub
([When state is not saved](#when-state-is-not-saved)).

A pull request that is not Updraft's ends as before: exit 0, `pull-request-not-watched`, at
the cost of one read of the pull request.

### When state is not saved

The runner never uploads when the merge exits non-zero, when the merge says the shared
database has a newer schema than the Updraft in the image, when the merged file fails a
check, when four attempts all lost the race, or when its time is up. Checkpoints make it
unlikely that this loses much: everything up to the last checkpoint is in the shared database
already. What the run recorded after that exists only in the microVM, which is about to be
terminated. If that includes the pull request it opened, every later review of it would find
the pull request unknown. So a final sync that fails after the job ran is a failure of its
own, whatever the job's outcome:

- **The result says so.** `outcome` is `state_not_saved`; `jobOutcome` keeps what the job
  itself ended as (`succeeded`, `failed`, `timed_out`, ...). `state.sync.notSavedReason` and
  `notSavedCode` say why, `error` repeats it, and the log has a line starting with
  `STATE NOT SAVED`. (A run that left no database, or changed nothing, is not this case.)
- **The delivery record is removed**, also after a job that succeeded, so that the delivery
  can be redelivered.
- **The run's database is kept, as a backup that describes itself.** Under
  `s3://<bucket>/state/unsaved/<delivery id>/<attempt id>/`, with plain `PutObject`s (no merge
  and no condition, so this does not fail for the reason the sync did), in this order:

  | Object | What it is |
  | --- | --- |
  | `base.db` | The pristine copy of the shared database the run started from. Not written when the run started from nothing |
  | `changed.db` | A consistent single-file copy of the run's database, made by `updraft state copy` as the job user |
  | `manifest.json` | Written last. `version`, `deliveryId`, `attemptId`, `createdAt`, `schemaVersion`, `startedEmpty`, and for `changed` and `base` their `key`, `bytes` and `sha256` (`base` also its `schemaVersion`). A run that started from nothing has `"base": null` and `"startedEmpty": true` |

  The attempt id is a timestamp and eight random hex digits, new for every attempt to keep a
  database, so the files of two attempts for one delivery (a redelivery, a second microVM)
  are never mixed. **A backup is complete when its manifest is there, and only then.** The
  base is uploaded first because `changed.db` must never be usable without it, and the
  manifest last because it is what says that everything it names was written.
  `state.unsaved` in the result has `saved` and `complete` (both true only once the manifest
  is written), `attemptId`, `manifestKey`, `key`, `baseKey`, `startedEmpty`, `bytes`, and the
  `error` when a step failed; the log then has `UNSAVED STATE LOST`, and says so when objects
  without a manifest were left behind. The objects expire after `StateVersionRetentionDays`.

Nothing depends on those objects: no job reads them, and the next job's sync is the same
whether they exist or not. Two ways lead back to a complete shared state, and they can be
combined in either order:

```sh
./deploy.sh state unsaved                             # complete backups, and incomplete ones
./deploy.sh state recover <delivery id> [attempt id]  # verify one and merge it into state/state.db
```

`state unsaved` lists complete backups (delivery and attempt) apart from incomplete ones (an
attempt's directory with no `manifest.json`, with the objects it does have) and from
`<delivery id>.db` files in the layout an earlier runner wrote.

`state recover` takes a complete backup and nothing else. The attempt id is only needed when
a delivery has more than one. It

1. downloads `manifest.json` first, and refuses a manifest that is not version 1, is for
   another delivery or attempt, names a key outside its own directory, or does not say
   whether the run started empty;
2. downloads `changed.db`, and `base.db` when the manifest names one, and compares the size
   and the SHA-256 of each with the manifest;
3. loops as the runner does: download the current shared database and its ETag,
   `updraft state merge --changed <changed> --base <base> --into <shared>` locally, upload
   with `--if-match <ETag>` (`--if-none-match '*'` when there is none), start over on a 412
   or 409.

It merges **without `--base` only when the manifest says `startedEmpty: true`**. In every
other case a base that is missing, cannot be downloaded or is not the file the manifest
describes ends the command with a non-zero exit and a message, before any merge and any
upload. There is no fallback and no flag that skips the base, on purpose: merged without the
snapshot it started from, every row of the backup counts as that run's, so rows of other
runs that it merely started with would be compared with what those runs have recorded since.
(`updraft state merge` itself no longer lets such a row replace one that is finished in the
shared database, but another run's work that is still unfinished there would be closed as
abandoned: [shared-state.md](../../docs/shared-state.md#recovery).) When the base is gone for
good, redeliver the event instead; an incomplete backup or one in the old layout is in the
same position. The bucket keeps versions, so an object that was overwritten or deleted can
usually be restored first.

It needs an `updraft` on this machine of the version the image runs (`UPDRAFT_BIN` names
another command), `node` (which `updraft` needs anyway; the manifest checks run in it) and an
AWS CLI whose `s3api put-object` has `--if-match`. Merging the same backup twice adds nothing.

**Or redeliver the `issues` delivery.** `run-event` finds the event's pull request on GitHub,
finds no record of it in the state database, and restores the publication from the GitHub
API without running an agent: outcome `nothing-to-do`, reason `already-handled`,
`stateRestored: true`, exit 0. Reviews of the pull request are acted on again from then on.
The restored rows are marked as reconstructed, and if `state recover` later brings the
original rows, those replace them. A restore needs `revise` or `review` to be on for the
repository, and the pull request to be open, opened by the App, and still carrying the marker
and the agent line in its body; otherwise the redelivery ends with exit 1 and
`reason: "state-not-restorable"`, and `state recover` is the way.

**Recovering an earlier version.** The bucket has versioning turned on, so every upload of
`state/state.db` keeps the object it replaced as a noncurrent version, for
`StateVersionRetentionDays` (30) days. S3 versions a whole bucket or nothing, never a prefix,
so versioning is on for all of it; lifecycle rules remove replaced versions under `events/`
and `results/` a day after they expire, and under `config/` after 30 days.

```sh
./deploy.sh state info                       # size, date and the newest versions
aws s3api list-object-versions --bucket <bucket> --prefix state/state.db
# Make an earlier version current again: download it, then upload it as a new version.
aws s3api get-object --bucket <bucket> --key state/state.db --version-id <id> restored.db
aws s3 cp restored.db s3://<bucket>/state/state.db
```

A job that is running during a restore merges its own changes into the restored object when
it ends. The execution role cannot read, list or delete versions, so nothing inside a microVM
can destroy this history; it can replace the current object (see
[Security model](#security-model)).

**Newer schema.** `updraft state merge` refuses to merge into a database whose schema is
newer than the CLI that runs it, and the runner then uploads nothing. This happens when two
image versions with different Updraft versions run side by side, or after a rollback of the
image: the jobs on the older image still run but save nothing, each saying so in its result.
Pin `ImageVersion` or rebuild so that all jobs use the newest Updraft.

**Looking at the fleet's state from a laptop.**

```sh
./deploy.sh state pull ./fleet        # state.db and the config, laid out as an Updraft home
UPDRAFT_HOME=./fleet updraft status
UPDRAFT_HOME=./fleet updraft stats
```

`state pull` downloads the current `state.db` and the files under `config/` into the
directory (default `./updraft-state`). It is a copy for reading. **Nothing done to it is
ever uploaded**: a retry, a cancel or a migration by a newer local Updraft changes only the
copy, and the next `state pull` replaces it. Do not run `updraft start` or `updraft
run-event` against it. The App's private key is not downloaded, so commands that need GitHub
as the App do not work there. The database holds issue titles and review text; treat the
directory accordingly.

`SharedState=disabled` turns all of this off: the launcher sends no state key, the runner
downloads and uploads nothing, the execution role gets no access to `state/`, and every job
starts from an empty database as before.

## The review loop

Off by default, in Updraft and here. With `review` (and usually `revise`) set for a
repository, Updraft has a second agent review each pull request it opens, has the first agent
revise it when the reviewer or an allowed person asks for changes, and can merge it
([docs/review-loop.md](../../docs/review-loop.md), [docs/revisions.md](../../docs/revisions.md)).
In this deployment one microVM runs the whole loop for the pull request it opened, and
further microVMs are started by what people do to the pull request afterwards. To turn it on:

1. **Two agents in the image.** The reviewer must be a different agent from the one that
   wrote the code. Build the image with both CLIs and put both keys in the agent-environment
   secret (deployment steps 3 and 4):

   ```sh
   AGENT_PACKAGES="@anthropic-ai/claude-code @openai/codex" ./deploy.sh image
   # agent-environment secret: {"ANTHROPIC_API_KEY": "...", "CODEX_API_KEY": "..."}
   ```

2. **A review pool in the config**, with the prompts the loop needs:

   ```yaml
   agents:
     claude: { maxConcurrent: 1 }
     codex: { maxConcurrent: 1 }
     kiro: { enabled: false }

   pools:
     coders: { agents: [claude] }
     reviewers: { agents: [codex] }

   actions:
     implement-issue:
       prompt: ./prompts/implement-issue.md
       revisePrompt: ./prompts/revise-pr.md
       reviewPrompt: ./prompts/review-pr.md
       timeoutMinutes: 60

   repositories:
     your-org/your-repo:
       id: 123456789
       checkoutPath: ./clones/your-repo
       publish: draft-pr
       revise: true
       review: true
       maxRevisions: 2
       workflows:
         - trigger: { event: issue.labeled, label: ready }
           action: implement-issue
           pool: coders
           reviewPool: reviewers
   ```

   Copy `revise-pr.md` and `review-pr.md` from `examples/prompts/` into `config/prompts/`
   and run `./deploy.sh config`.

3. **The launcher accepts the pull request events**, and ignores the App's own:

   ```sh
   SAM_PARAMETER_OVERRIDES="AcceptedEvents=issues,pull_request_review,pull_request IgnoredSenders=<app-slug>[bot]" ./deploy.sh stack
   ```

4. **The App subscribes to them**: *Pull request review* and *Pull request*, next to
   *Issues* (deployment step 5), with the permissions listed there.

5. **`MaximumDurationSeconds` fits your loop** ([How long a run may take](#how-long-a-run-may-take)).

`SharedState` must stay `enabled`: revisions and reviews are only made to pull requests
recorded in the state database, and a microVM that starts from an empty one knows none.

**Which events start a microVM.** `pull_request_review` with action `submitted`, `edited` or
`dismissed`, and `pull_request` with action `synchronize` or `closed` (not `reopened`: a closed
pull request is no longer watched, for good, so no microVM is started for a reopen), and of
those only the ones that can lead to work:

- the pull request's head branch starts with `updraft/` (`PullRequestBranchPrefix`). Updraft
  revises and reviews only pull requests it opened, and those are on its job branches
  (`updraft/issue-<n>-<job id>`);
- the review is not a "Comment" review. In Updraft only a "Request changes" review starts a
  revision; an approval or a dismissal can cancel one that is pending; a comment review does
  nothing. Updraft's own reviewer posts comment reviews, so this also keeps a run from
  starting a second microVM for its own review. A single inline comment is a comment review
  too;
- the sender is not in `IgnoredSenders`. Set it to the App's `<app-slug>[bot]`: a push by the
  App is the run's own revision, which that run reviews itself.

Everything else is decided inside the microVM, by `run-event`, against the GitHub API, the
config and the state database: whether Updraft opened the pull request, whether the
reviewer is an allowed actor, whether the review still stands.

**Kiro as an agent.** Kiro is not an npm package, so `AGENT_PACKAGES` cannot install it: add
a `RUN` step to `image/Dockerfile` that runs Kiro's own installer and leaves `kiro-cli` on
the `PATH` of the job user, and enable `kiro` in the config. Its credential for headless use
is an API key in `KIRO_API_KEY` ([docs/agents/kiro.md](../../docs/agents/kiro.md)); add it to
the agent-environment secret's JSON object like the others. A `kiro-cli login` session also
works for headless runs on a workstation, but it expires and renewing it needs a person at a
browser, and a microVM starts from a snapshot with no session in it: it does not suit this
deployment. None of this has been tried here.

**Auto-merge.** `autoMerge` needs the *Checks* and *Commit statuses* permissions above, and
time: the run waits up to `autoMergeWaitMinutes` for pending checks inside its microVM. Read
[Security model](#security-model) before turning it on: the verdict that allows a merge is a
row in a database that an agent in the microVM can write to.

## Concurrency model

Nothing here queues or locks. Every accepted delivery starts its own microVM at once, and
several run at the same time. In plain terms, this is what they share and what follows.

**What a microVM has to itself.** Its disk, its clone, its agent processes, and its copy of
the state database as it was in S3 when the microVM started.

**What they share.** GitHub, and the one object `state/state.db`. A microVM writes to it at
the end of its job and, while the job runs, in [checkpoints](#checkpoints): so a microVM that
starts later sees what the earlier ones have recorded **so far**, their unfinished work
included.

**What two microVMs running at the same time cannot do to each other:**

- *Overwrite each other's state.* Each uploads only with a conditional write. The one that
  loses the race downloads the winner's object and merges into that. Both runs' rows end up
  in the shared database, in either order.
- *Corrupt the shared database.* An upload replaces the whole object at once, after the
  merged file was opened and checked; a microVM that dies mid-way has uploaded nothing.
- *Take over each other's unfinished work.* A checkpoint shows a run's work in flight: a
  queued reviewer job, a review posting that is due for a retry, a merge that waits for
  checks. `run-event` records, with that work, a **hold** that names the run and expires some
  time after its deadline; another run leaves held work alone (it does not start the queued
  job, make the retry, or wait for and make the merge) until the holder has released it or the
  hold has expired. A pull request that is held is still **watched**: a new review of it is
  acted on by the run that received it. Open runs of other microVMs are, as before, neither
  closed nor counted towards `maxConcurrent` or an agent's limit.
- *Record a run as ended while it runs.* A checkpoint settles nothing; only a run's final
  sync (or `state recover`) marks what that run left unfinished as interrupted.
- *Open two pull requests for one event, or move a branch backwards.* That is GitHub's doing
  and Updraft's, not this deployment's: the branch name is derived from the event, a push
  only creates a branch or fast-forwards it from the exact commit the run started from, and
  the loser ends with `superseded` or a failed revision.

**What they can do, and you should expect:**

- *Not see each other's latest.* A microVM never reads the shared database again after it
  started (the one exception: a job that waits for a pull request's state downloads a newer
  snapshot before it runs again). A capacity cooldown that one run records reaches only
  microVMs that start after the checkpoint that saved it. Two runs that start within the same minutes can both hit the same
  rate-limited agent, both spend the same triage budget, and both pick the same agent from a
  rotating pool. Limits that Updraft enforces by counting in its database (`maxConcurrent`,
  the hourly triage limit, cooldowns) are therefore exact only from one run to a later one,
  not between runs that overlap.
- *Do the same work twice.* Two deliveries about the same pull request that both start a
  microVM each see, for example, the same new "Request changes" review, and both run a
  revision; one push wins. The launcher's coalescing covers events that arrive within
  seconds of each other, not a review that arrives while an earlier microVM is still
  revising. The cost is an agent run, and possibly a second comment on the pull request.
- *Handle one review in two places.* A review that is submitted while the run that opened the
  pull request is still going is handled by the microVM its delivery started (the pull request
  is on record after the first checkpoint) **and** is seen by the first run, which reads its
  pull requests once more before it ends and does not have the second microVM's record of the
  review. Usually the second microVM has pushed its revision by then and the first run's
  revision finds the review answered or its push refused; the cost is as above. The last look
  exists for the review that arrives before any checkpoint has the pull request and whose own
  microVM gave up waiting: without it that review would be handled by nobody.
- *Disagree about one row.* When two runs changed the same row (the same pull request's
  stage, the same cursor), `updraft state merge` decides which value stands. That is the
  CLI's rule, not this deployment's.

**What losing a run's state does.** A microVM whose final save was refused, or that died,
leaves GitHub changed and the shared database behind by whatever the run recorded after its
last checkpoint (everything, if it never made one). Later runs then decide without that
history: a review that was handled but not recorded can be handled again; a cooldown is
forgotten; the run is missing from `updraft stats`, or is in the shared database as still
running, with its hold in force until it expires. A pull request that was opened but not
recorded is the case that matters: events about it end `state-pending` and fail, loudly,
until it is on record. The result document says when a save failed (`outcome:
"state_not_saved"`), the run's database is then under `state/unsaved/`, and
[When state is not saved](#when-state-is-not-saved) has the two ways back. A microVM that
died without a result object kept nothing: redeliver its `issues` delivery (after
`DedupeWindowSeconds`, when its record has expired) to restore the publication.

**What does not run at all.** There is no poller. A microVM acts on the event that started
it and on what it finds on GitHub for that issue or pull request, then ends. Work that the
long-running worker would notice by polling (a retry that comes due later, a job deferred by
a cooldown, checks that finish after the run's wait) happens only when a later event, or a
redelivery, starts another microVM for it.

## Testing with a redelivered webhook

1. In a repository the App is installed on, apply the trigger label to an issue as a user in
   `dispatch.allowedActors`.
2. On the App's settings page, *Advanced*, *Recent Deliveries*: the `issues` delivery should
   show a `202` response with a body such as `{"deliveryId":"...","microvmId":"mvm-..."}`.
3. Follow the job: `aws logs tail /aws/lambda-microvms/<image-name> --follow` (the log stream
   is the microVM id).
4. Read the outcome: `aws s3 cp s3://<bucket>/results/<delivery-id>/<microvm-id>.json -`.
   Its `state` part says what the run started from and whether its changes were saved;
   `./deploy.sh state info` shows the shared database growing a version.
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

There are three layers, and they do different jobs.

**The launcher deduplicates on the delivery id.** Before it starts a microVM it writes the
delivery id to a DynamoDB table with a conditional put; the item expires after
`DedupeWindowSeconds`. A redelivery that finds an unexpired item gets
`200 {"duplicate": true, ...}` and starts nothing. The item is removed again when the launch
fails (the launcher does it) and when the job does not end cleanly (the runner does it: any
outcome other than `run-event` exiting 0 with a summary **and** its state saved). `run-event`
exits 0 only when everything of the event went well, the reviewer runs and revisions of the
same run included. A final state sync that fails removes the record too
([When state is not saved](#when-state-is-not-saved)): the redelivery is what restores a
publication whose state was lost. So:

| First attempt | A redelivery |
| --- | --- |
| Still running | Ignored. Without this, both microVMs would run the agent |
| Ended with exit 0 (published, nothing to do, canceled, superseded) | Ignored until the window has passed; after that it starts a microVM that finds the work done |
| Failed (the event's job, or a reviewer run or revision that followed from it), timed out, deferred with a non-zero exit, still waiting for a pull request's state (exit 6), or the runner could not start it | Starts a new microVM at once: redelivering is the retry |
| Ended, and its state could not be saved (`state_not_saved`) | Starts a new microVM at once. For an `issues` delivery whose pull request exists, it restores the publication without running an agent |
| Launch failed (delivery shows `500`) | Starts a new microVM at once |
| Coalesced into another delivery (`202` with `"coalesced": true`) | Starts a new microVM once the few seconds of the lease are over: nothing was recorded for it |
| MicroVM died without reporting (no result object) | Ignored until the window has passed, because nothing removed the item. Delete it from the table (`DeliveryTableName` output) to retry sooner |

If the table cannot be reached, the launcher logs a warning and launches anyway.

**`updraft run-event` is idempotent per event, with gaps you should know.** The job id and the
branch name are derived from the GitHub timeline event, not from the delivery, so a second
run of the same event in a new microVM finds the pull request or the branch and exits 0 with
reason `already-handled`. With the shared state, a later run also finds the earlier run's
records. What that does not cover:

- Two microVMs for the same event started within one agent run of each other both run the
  agent; only one can publish. The launcher's deduplication exists to prevent this.
- A run that pushed the branch and died before opening the pull request leaves a branch that
  blocks later runs of that event until someone deletes it.
- A failed job leaves no marker on GitHub. A redelivery runs it again, and with
  `commentOnFailure` posts another failure comment. That is what a retry is, but it means
  every redelivery of a failing event costs an agent run.
- `run-event` exits 1 with an "event not found" error when GitHub's events API has not listed
  the label event after about 15 seconds of re-reading. The microVM is already running at
  that point, so the launcher cannot answer 5xx; the delivery shows `202`, the failure is in
  the result object (`updraftOutcome: "error"`), and redelivering the webhook is the retry.
- A job that `run-event` defers (an agent in a capacity cooldown, for example) is not picked
  up later by anything: there is no poller. If `run-event` reports it with a non-zero exit
  code, the delivery record is released and a redelivery after the cooldown is the retry; if
  it exits 0, redeliver after `DedupeWindowSeconds` or delete the record.

As far as I know GitHub does not redeliver failed deliveries by itself; a redelivery is a
person or a script asking for one.

### Coalescing pull request events

A redelivery has the same delivery id, and the deduplication above handles it. Pull request
events have a second problem: several *different* deliveries can concern one pull request within
seconds. A push followed by a review; a "Request changes" review and its dismissal; two
reviewers. `run-event` treats a pull request delivery as a pointer to the pull request and
looks at the pull request as it is on GitHub, so one microVM that looks after the burst has
handled all of it, and two microVMs would each find the same unhandled review and each run
an agent on the same branch.

The launcher therefore coalesces by pull request. The first accepted event for a pull
request writes a lease, `pr#<owner/repo>#<number>`, to the delivery table with a conditional
put, expiring after `PullRequestCoalesceSeconds` (20), and starts a microVM. An event for the
same pull request that finds the lease gets `202 {"coalesced": true, ...}`: no microVM, no
stored body, no delivery record. The launcher tells the microVM when the lease ends
(`notBefore` in the run-hook payload), and the runner does not start `run-event` before that
moment. So every event that was coalesced happened before the one job looked at GitHub.
`issues` events are never coalesced; each label application is its own job.

Why this and not the alternative, launching a microVM for every event and leaving it to the
code inside: that code cannot see another microVM. Two `run-event`s that start seconds apart
have the same copy of the state database and no way to know of each other until one of them
pushes. The burst is exactly the case in which they would duplicate work, it is common
(GitHub sends a review and the push that preceded it close together), and a lease of a few
seconds removes it for one DynamoDB write and at most 20 seconds of delay on a pull request
event.

What can go wrong, either way:

- **With coalescing (the default).** If the microVM that holds the lease fails before it
  looks at the pull request (the launch succeeded but the job could not start), the events
  coalesced into it are not acted on: their deliveries show `202` and nothing else happens.
  Redeliver any of them, or the first one; the failed job's result says so. If `run-event`
  ever decides from the delivery's payload instead of the pull request's state, coalescing
  would drop the trigger of every event but the first; that is an assumption about a command
  that was still being written (see [What is not verified](#what-is-not-verified)), and
  `PullRequestCoalesceSeconds=0` is the switch. The lease compares the launcher's clock with
  the microVM's; a microVM whose clock runs ahead by seconds could start before the lease
  ends. A pull request event waits out the rest of the 20 seconds before its job starts.
- **Without it (`0`), and beyond the lease in any case.** Every event starts a microVM. An
  event that arrives while an earlier microVM is still working on the same pull request,
  minutes later, always does: the lease is long over, and a longer one would make the first
  microVM miss events it had already looked past. Then two agents can revise the same branch
  from the same commit. Updraft's push guard lets only one of them land (the other's
  revision fails, and with `commentOnFailure` says so on the pull request), and the state
  merge keeps both runs' records. The cost is the wasted run and some noise. Serialising
  work per pull request across microVMs would need a queue; it is
  [not built](#not-yet-built).

## When something fails

| Symptom | Where to look |
| --- | --- |
| Delivery shows `401` | The secret in the App's webhook settings differs from the Secrets Manager value. The launcher caches the secret for 5 minutes after a change |
| Delivery shows `400` | Content type is not `application/json`, or a header is missing (replay from a shell) |
| Delivery shows `200` with `{"ignored": "..."}` | The event was filtered; the reason is in the body. Check `TriggerLabels`, and for pull request events `AcceptedEvents`, `PullRequestBranchPrefix` and `IgnoredSenders`. With `"duplicate": true`, the delivery already started a microVM; see the section above |
| Delivery shows `202` with `"coalesced": true` | Another event for the same pull request started a microVM seconds earlier, and that microVM covers this one. See [Coalescing pull request events](#coalescing-pull-request-events) |
| Every delivery shows `500` with `launcher misconfigured` | A template parameter the launcher cannot use, for example an event name in `AcceptedEvents` that is not one of the three. The launcher's log names the variable |
| Delivery shows `500` | The launcher's log group (`LauncherLogGroup` output). Each line is JSON with the `deliveryId`. Typical causes: the image does not exist or has no active version (`ResourceNotFoundException`), the account's MicroVM memory quota is used up (`ServiceQuotaExceededException`), a missing permission, a rejected parameter (`ValidationException`, see [Idle policy](#idle-policy)) |
| Delivery shows `429` or `503` | HTTP API throttling (`WebhookRateLimit`) |
| `202`, but no result object | The microVM's log stream in `/aws/lambda-microvms/<image-name>`. `aws lambda-microvms get-microvm --microvm-identifier <id>` shows `state` and `stateReason`. A microVM whose `/run` hook fails or times out is terminated without ever running |
| Result has `outcome: runner_error` | `error` says which step failed: reading the event or config from S3, a secret that is empty or not a PEM key, no `config.yaml`, a shared state object that is not a SQLite database (restore an earlier version, see [Shared state](#shared-state)), Updraft not startable |
| Result has `outcome: state_not_saved` (`state.sync.saved: false` with a `notSavedReason`) | The job ran (`jobOutcome` says how it went), but what it changed in the state database since its last checkpoint was not saved; the log has a `STATE NOT SAVED` line. The run's database is kept as the backup `state.unsaved.manifestKey` names (when `state.unsaved.complete` is true); [When state is not saved](#when-state-is-not-saved) says how to merge it or restore from GitHub. `notSavedCode` is `merge-failed` (`updraft state merge` exited non-zero; its last output is in the reason), `newer-schema` (the image's Updraft is older than the shared database; rebuild the image), `merged-database-unreadable` or `merged-database-refused` (the merged file failed a check), `attempts-exhausted` (four attempts each lost to another microVM), `timed-out` or `no-time` (the microVM was at its end; raise `WatchdogReserveSeconds` or `MaximumDurationSeconds`), `shared-database-unreadable` (the object in S3 is damaged; restore a version), `no-run-database`, `merge-report-missing`. [Concurrency model](#concurrency-model) says what the missing history means |
| Result has `outcome: failed`, `exitCode: 6`, `updraftOutcome: state-pending` | A pull request event arrived before the state of the run that opened the pull request did, and it did not arrive within `StatePendingWaitSeconds` (`state.pending`). Redeliver the delivery once that run has saved state (its first checkpoint is enough); if that run is gone, redeliver the pull request's `issues` delivery first. See [A pull request the state does not know yet](#a-pull-request-the-state-does-not-know-yet) |
| Result has `updraftOutcome: failed` although the pull request was opened | A job that followed from the event in the same run failed: a reviewer run, a revision. `summary.followOnJobs` lists them, `summary.loop` says where the pull request stands, and `summary.message` names the job that failed |
| Result has `updraftOutcome: error`, `summary.reason: state-not-restorable` | A redelivered `issues` event found its pull request on GitHub, no record of it in the shared state, and could not restore it from the API (the message says which fact is missing). Merge the original run's database with `./deploy.sh state recover`, or close the pull request and apply the label again |
| Log has `checkpoint skipped` lines | A checkpoint could not save (the reason follows). The job is not affected and the final sync saves everything; many of them in every job mean the database is too large or too contended for the checkpoint budget: raise `StateCheckpointSeconds` |
| Result has `state.snapshot.found: false` on a deployment that has run jobs | The object is gone or the role cannot list `state/`. `./deploy.sh state info` shows what is there |
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
  "outcome": "succeeded | failed | timed_out | terminated | runner_error | state_not_saved",
  "jobOutcome": "the same without state_not_saved: how the job itself ended",
  "exitCode": 0, "signal": null,
  "summary": { "...": "the JSON object updraft run-event printed, or null" },
  "summaryMissing": false,
  "updraftOutcome": "summary.outcome: nothing-to-do | succeeded | canceled | superseded | failed | publish-failed | not-started | deferred | state-pending | error | any newer one",
  "state": {
    "key": "state/state.db",
    "snapshot": { "found": true, "bytes": 1048576, "etag": "\"...\"", "schemaVersion": 12 },
    "checkpoints": { "intervalSeconds": 20, "attempted": 14, "saved": 12, "unchanged": 2, "failed": 0, "lastSavedAt": "...", "lastEtag": "\"...\"", "lastProblem": null },
    "pending": null,
    "sync": {
      "attempted": true, "saved": true, "changed": true,
      "attempts": 1, "conflicts": 0,
      "merge": { "changed": true, "...": "the JSON object updraft state merge printed (its counts)" },
      "info": { "...": "the JSON object updraft state info printed for the merged file" },
      "uploadedBytes": 1052672, "schemaVersion": 12, "etag": "\"...\"",
      "notSavedReason": null, "notSavedCode": null, "durationMs": 840
    },
    "unsaved": null
  },
  "logs": ["results/<delivery>/<microvm-id>/updraft.log", "results/<delivery>/<microvm-id>/run.log"],
  "error": null,
  "stderrTail": "last 8 KB of updraft's stderr",
  "startedAt": "...", "finishedAt": "...", "durationSeconds": 0
}
```

`state.checkpoints` is null when none was due; `state.pending` is `{ "tries", "waitedMs",
"resolved" }` when `run-event` exited 6 at least once; `state.unsaved` is `{ "saved", "complete",
"attemptId", "manifestKey", "key", "baseKey", "startedEmpty", "bytes", "error" }` when the
final sync failed: `manifestKey` is the backup's `manifest.json`, and `saved` and `complete`
are true only when that was written ([When state is not saved](#when-state-is-not-saved)). With a `pending` retry,
`state.snapshot` describes the snapshot of the last try.

`outcome` is the runner's view and follows the exit code (and, for `state_not_saved`, the
final state sync): `succeeded` is exit 0, which
`run-event` also uses for "nothing to do", "canceled by the pre-start check" and "another run
published first"; read `updraftOutcome` for which. Exit 0 covers the whole run: a reviewer run
or a revision that failed after the pull request was opened is exit 1. The runner never interprets
`updraftOutcome`: an outcome it has not heard of is handled by its exit code like any other.
`failed` is any other exit code: 1 for a failed, unpublished, interrupted, deferred or
never-started job and for command errors (config, GitHub, event not matched), 2 for an
unusable event file or deadline, 3 for a held worker lock (not expected here: the state
directory is new, only its database has a past), 4 for work deferred behind a cooldown, 5 for
a state database newer than the image's Updraft, 6 for a pull request whose state has not
arrived (after the runner's own retries). `run.log` is the file the summary's
`logPath` names, uploaded only if it lies inside the job's state directory; logs over 20 MB
are cut to their last 20 MB.

`state` is `null` with `SharedState=disabled`. `state.snapshot` is what the run started from:
`found` is false on the first run, and the whole of `snapshot` is `null` when the job failed
before the download. `schemaVersion` is read from the file's header. `state.sync.attempts`
counts download, merge and upload rounds, and `conflicts` how many of them lost to another
microVM. `saved` is true only when an upload succeeded; `notSavedReason` is null both then
and when the run changed nothing (`changed: false`). After a job that never started,
`attempted` is false.

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
later) is only for a `run-event` that does not. With the defaults: maximum 240 minutes,
watchdog at 230, deadline at about 226.

**State sync has its own budget, inside the reserve.** After the job the runner gives state
sync at most 5 minutes, and never more than what is left 90 seconds before the microVM's
maximum duration; those 90 seconds are for the logs, the result and the termination request.
When the budget is used up the merge process is killed, the S3 requests are aborted, and the
runner goes on to report and terminate whether or not they noticed: the wait is a race
against a timer, not a hope that every call returns. If Lambda's `/terminate` hook arrives
during sync, the budget is cut to 15 seconds. A download, a merge of a database of a few
megabytes and an upload take seconds, so four attempts fit several times over; the budget
exists for the day something hangs.

**The merge runs as the job user; the transfers run as root.** `updraft state merge` opens
files that an agent could have written, so it runs with the agent's privileges and nothing
more: no AWS credentials, no agent keys. Root does what needs the execution role (GET, PUT)
and decides what may be uploaded, from the bytes it read itself. The schema version in the
result document comes from the file's SQLite header (`user_version`), so that reporting it
does not depend on a command's output format.

**Versioning, not copies, keeps the previous state recoverable.** The runner could have
copied `state.db` to a dated key before each upload; that is a second write per job, a
window between the two, and a permission to write keys an agent could then also fill.
Bucket versioning does it inside S3, atomically with the write, and lets the execution role
stay without any right over old versions. Its price is that it is a property of the whole
bucket, which the lifecycle rules account for.

**Pull request events are coalesced for a few seconds, not serialised.** See
[Coalescing pull request events](#coalescing-pull-request-events) for the reasoning and for
what it leaves open.

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
small tools by default), `PYTHON_COMMAND` (what `python` and `python3` mean on PATH),
`UV_VERSION` (uv, installed with pip), and `PLAYWRIGHT_VERSION`, `PLAYWRIGHT_BROWSERS` and
`BROWSER_PACKAGES` (a headless Chromium in `/opt/ms-playwright` and the libraries it needs;
a project pinned to another Playwright version adds its own build with
`npx playwright install chromium` in the job);
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
  maximumDurationInSeconds: 14400,
  idlePolicy: { maxIdleDurationSeconds: 14400, suspendedDurationSeconds: 0, autoResumeEnabled: false },
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
  "maximumDurationSeconds": 14400,
  "watchdogReserveSeconds": 600,
  "launchedAt": "<ISO time the launcher called RunMicrovm>",
  "dedupeTable": "<table name; absent when deduplication is off>",
  "stateKey": "state/state.db",
  "notBefore": "<ISO time; only for a pull request event that holds a coalescing lease>"
}
```

`eventName` is `issues`, `pull_request_review` or `pull_request`. `stateKey` is absent with
`SharedState=disabled`. The payload's version is still 1: the two new fields are optional,
and a runner that does not know them ignores them. That also means an image built before
they existed runs jobs from a newer launcher without shared state and without waiting for
`notBefore`, silently: rebuild the image when you deploy this stack.

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
| `/terminate` | yes, 60 s | Signals the job, which stops Updraft, gives state sync at most 15 s and writes a result with `outcome: terminated`; waits up to 45 s; 200. An Updraft that needs its full 20 s to stop can leave too little for the result |
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
(event, action, optionally label; for pull request events the branch prefix, the review's
kind and the sender) only avoids starting microVMs for nothing.

**What the microVM re-checks.** Everything that decides whether an agent runs is decided by
`updraft run-event` against the GitHub API and the config: that the repository and label are
configured, that the label event is the latest application of that label, that its actor is
in `allowedActors`, that the issue was not edited by someone else since; for a pull request,
that Updraft opened it, that the reviewer is an allowed actor and the review still stands
(see [docs/security.md](../../docs/security.md), [docs/revisions.md](../../docs/revisions.md)).
The webhook body is treated as a hint about which issue or pull request to look at.

**What reaches the microVM.** The run-hook payload has no secret and no issue or review
text: the delivery id, the event name, S3 keys, two secret ARNs and time limits. With
`NO_INGRESS` there is no endpoint to connect to; only Lambda calls the hooks.

**What an agent inside the microVM can reach.** Be clear about this one. Agents run in
full-auto mode on issue text, and the microVM is the only boundary around them:

- *The network.* Egress is the public internet (or what your VPC connector allows).
- *The agents' API keys.* All of them are in the environment of `run-event` and of every
  agent it starts: with two agents configured, each agent can read the other's key.
- *The GitHub App's private key.* Updraft runs as the job user and reads the key file, and it
  starts the agent as the same user, so the agent can read the file. Updraft does not put the
  key or its path in the agent's environment, and the runner starts Updraft with an
  environment built from nothing (no `AWS_*`, no run request). That prevents accidents; it
  does not stop an agent that goes looking.
- *The state database on its disk.* The job's copy is `$UPDRAFT_HOME/state.db`, owned by the
  job user, and the agent runs as that user. It can read all of it: the titles of issues
  from every configured repository, the text of reviews as Updraft snapshotted them, run
  history, pull request numbers. And it can write to it: what the agent changes in that file
  is, to the merge, what the run changed, and is uploaded to the shared database. Reviewer
  verdicts, the record of which reviews were handled and which pull requests are Updraft's
  all live there.
- *The execution role.* The documentation describes the microVM's AWS credentials as provided
  through IMDSv2 and says nothing about restricting which process may ask for them (no hop
  limit, no per-user rule). Assume any process in the microVM can obtain the role's
  credentials. With them it can read the two secrets again, read `config/` and `events/` of
  this deployment (including other deliveries' webhook bodies), read and replace
  `state/state.db` (the current object; not its earlier versions, which it can neither read
  nor delete), write objects under `results/`, delete items from the delivery table (which
  only makes a redelivery possible again, or ends a coalescing lease early), and terminate
  microVMs of this image, its own and other jobs'. It cannot write the config, read the
  webhook secret, start microVMs or touch anything else in the account.

The runner keeps what it can out of the job user's hands: `updraft state merge` and
`updraft state info` run as the job user with an environment built from nothing, without AWS
credentials and without the agents' keys; the merge base is a copy only root can read; root
fills each scratch directory before handing it over, reads the merged file without following
links, and uploads only bytes that are a SQLite database of plausible size. Before the merge
it kills what is left of the job's process group. That makes the merge honest about the file
it was given. It does not make the file honest.

So an agent that is talked into it by an issue's text can obtain the App's private key, and
with it act as the App on every repository the App is installed on until the key is revoked;
and it can alter the shared state that later runs decide from. What limits that today: only
`allowedActors` can start a job at all; install the App on the job repositories only and
grant only the permissions above; protect the base branches on GitHub, so that the App's
Contents permission cannot push to them directly; rotate the key if a run looks wrong; keep
`autoMerge` off, because with it a "ready to merge" verdict in the state database, which an
agent can write, becomes a merge (branch protection that requires a person's approval is
what stops that, where it is on). A corrupted shared database is recoverable from its earlier
versions. Two changes would close most of the gap, and neither is built (see below): a
firewall rule in the microVM that keeps the job user away from the metadata endpoint, and
giving the job a short-lived installation token, minted outside the agent's reach, instead of
the key. Neither would keep the agent from the state database on its disk; that needs a
separate OS user for the agent.

**Roles.** The launcher's role can put objects under `events/`, put and delete items in the
delivery table, read the webhook secret, call
`lambda:RunMicrovm` on the one image and pass the one execution role. The build role can read
`image/*` and write build logs. The execution role is listed above; the shared state added
`s3:GetObject` and `s3:PutObject` on `state/*` and the right to list that prefix, and nothing
else (no delete, no version actions; a versioned bucket needs none for an ordinary write).
Checkpoints, the wait for newer state and the unsaved copies under `state/unsaved/` use those
same permissions and widened nothing: the ETag is asked for with the list request, and
each object of a backup under `state/unsaved/<delivery>/<attempt>/` is a `PutObject` under `state/*`.
The bucket blocks public access, refuses non-TLS requests, keeps replaced versions for a
while and expires `events/` and `results/`.

**Who can read the shared state.** Anyone with `s3:GetObject` on the bucket's `state/`
prefix: the execution role (so, in effect, every job and every agent), and whoever your
account's IAM policies give read access to the bucket, `deploy.sh state pull` included. With
`s3:GetObjectVersion` also every version of the last `StateVersionRetentionDays` days, which
still holds rows that Updraft pruned since. The object is encrypted at rest with S3-managed
keys, which protects against nobody who has the permission. It holds issue titles, the text
of "Request changes" reviews and their inline comments as first seen, run history and
metrics, reviewers' findings and run summaries. No column of the schema at the time of
writing is for a token or a key; assume anything else Updraft read from GitHub for a job may
be in it.

**Left open.** The stored webhook bodies and results contain issue and review text and are
readable by anyone with read access to the bucket. So are the uploaded logs: `run.log` is the
agent's whole transcript, and neither it nor `stderrTail` is filtered by the runner (Updraft
redacts the tokens it knows about from its own output; an agent can print anything). The
HTTP API is public by necessity; its throttle and the signature check are its only
protection (no WAF).

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
  delivery (every issue event, not only label events; with the review loop every pull request
  and review event of the repositories, on anyone's pull requests), one or two DynamoDB
  writes per accepted delivery (on-demand table), three secrets, CloudWatch Logs ingestion
  for the whole agent transcript, a small S3 bucket, and the agents' own API usage.
- The shared state costs one S3 list, two downloads and one upload of the database per job,
  and storage for every version of it kept: one per job that changed something, each the
  whole file, for `StateVersionRetentionDays`. At 5 MB and 100 jobs a day that is about
  15 GB kept; lower the parameter if the database grows.
- Checkpoints multiply that: while a job runs, up to one list, one download and one upload of
  the database every `StateCheckpointSeconds`, each upload another kept version. A one-hour
  job at the default 20 seconds is up to 180 versions; at 5 MB that is about 900 MB per job
  kept for `StateVersionRetentionDays`. If that is too much, raise `StateCheckpointSeconds`
  (60 keeps a pull request unknown to other microVMs for at most a minute or so after it is
  opened, which `StatePendingWaitSeconds` covers) or lower the retention. A job that waits
  for a pull request's state costs one list request every 5 seconds while it waits.
- A pull request event that starts a microVM for nothing (the review loop off for that
  repository, a pull request that is not Updraft's) costs the seconds until `run-event` has
  said so (for the latter, one read of the pull request from the API), plus up to
  `PullRequestCoalesceSeconds` of waiting.
- CloudTrail records `RunMicrovm` and `TerminateMicrovm` as data events, which are not logged
  unless enabled.

## Not yet built

- **A queue, and with it serialising work per pull request or per repository.** Every
  accepted delivery starts a microVM at once. Updraft's `maxConcurrent` settings apply within
  one process and mean nothing here. The only ceiling is the account's MicroVM memory quota,
  and hitting it loses the delivery until someone redelivers it. Two microVMs can work on one
  pull request at the same time ([Concurrency model](#concurrency-model)).
- **A poller.** Nothing looks at GitHub or at the state database between events. Deferred
  jobs, retries that come due later and checks that finish after a run's wait are picked up
  only by a later event or a redelivery.
- **Live shared state.** The database is copied at the start of a run and merged at its end.
  Runs that overlap do not see each other's cooldowns, counters or cursors.
- **Repairing lost state.** A run whose state was not saved, or that died before saving,
  leaves the shared database without its records, and nothing rebuilds them from GitHub.
- **Pruning the shared database.** `updraft clean` is not run on it; it grows with history.
  Run it on a pulled copy to see what it would remove; there is no supported way to push
  the result back.
- **Automatic retry.** A failed launch is a 500 in the App's delivery list and a failed job
  is a result object; nobody redelivers either automatically. A microVM that dies without
  reporting keeps its delivery record until the window has passed.
- **Keeping the App key, the execution role and the state database away from the agent**
  (metadata-endpoint firewall for the job user; installation token instead of the key; a
  separate OS user for the agent). Until then `autoMerge` should stay off.
- **Kiro in the image.** Described under [The review loop](#the-review-loop), not built or
  tried.
- **Cleanup of old image versions**, alarms (a `STATE NOT SAVED` log line would be the first
  to alarm on), a dashboard, a dead-letter path for failed launches.
- **The image as a CloudFormation resource**, and VPC egress beyond passing a connector ARN.
- **Failure comments when the runner itself fails.** If the job cannot start (bad secret, no
  config, an unreadable state database), the result object says so; nothing is written to
  the issue.

## What is not verified

Nothing in this directory has been run against AWS: there were no credentials where it was
written. Docker was not available either, so the Dockerfile has never been built. The one
exception is `image/runner/aws.mjs`'s two state functions, which were run with the real
`@aws-sdk/client-s3` against a local HTTP server that answers as the S3 documentation
describes (the `If-Match` and `If-None-Match` headers were sent; 412, 409 and 404 came back
as "not written" without a retry by the SDK; a 500 was retried and thrown; an aborted request
ended at once). That checks the SDK's side of items 22 and 24, not S3's. These are
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
17. **The SAM template.** Parsed as YAML and checked for dangling references by a script, and
    it passes `cfn-lint` 1.60.1 (which applies the SAM transform) without findings;
    `sam validate` and a deployment have not been run.
18. **`deploy.sh`.** Checked with `bash -n` and a dry run of the `image` step against a
    stand-in `aws` command (request JSON and zip contents inspected). The `stack` and `config`
    steps have not been run at all.
19. **GitHub's redelivery behaviour.** That GitHub does not retry failed deliveries on its own,
    and that a redelivery keeps the delivery id, is from memory; GitHub's documentation was
    not reachable when this was written.
20. **`updraft run-event`.** It was merged separately (`docs/run-event.md`) and has only ever
    been run here as a stand-in. The runner follows its contract
    (`image/runner/job.mjs`: `updraftInvocation`, `describeExitCode`) and reads three things
    from the summary: that it is a JSON object on the last stdout line, `outcome`, and
    `logPath`. `updraft.log` is read from
    `$UPDRAFT_HOME/logs/`, where the CLI writes it. That `logPath` is an absolute path or
    relative to `$UPDRAFT_HOME` is an assumption; a log that is not found is skipped silently.
21. **DynamoDB from the microVM.** With internet egress the public endpoint is assumed
    reachable, like S3 and Secrets Manager. With a VPC connector all three (and
    `lambda.<region>.amazonaws.com` for TerminateMicrovm) need a route or endpoints.
22. **S3 conditional writes.** That `PutObject` accepts `IfMatch` and `IfNoneMatch` is
    confirmed from the type definitions of `@aws-sdk/client-s3` 3.1171.0, and the 412, 409
    and 404 answers from the S3 User Guide's conditional-writes page; none of it was run
    against S3. Assumed on top of that: that the `ETag` string `GetObject` returns (quotes
    included) is what `IfMatch` expects back unchanged; that the SDK reports a refused
    precondition as an error whose `$metadata.httpStatusCode` is 412 or 409 or whose name is
    `PreconditionFailed` or `ConditionalRequestConflict` (`aws.mjs` checks both); and that
    the SDK does not retry such an answer on its own in a way that hides it.
23. **Versioning.** That versioning applies to the whole bucket, that an expiring current
    version becomes a delete marker and that S3 removes a delete marker left alone, are from
    the S3 User Guide. The lifecycle rules in the template (an expiry together with a
    noncurrent-version expiry in one rule; `ExpiredObjectDeleteMarker` with a
    noncurrent-version expiry) pass `cfn-lint` and have not been deployed. That conditional
    writes behave the same in a versioned bucket is stated by the guide for `If-None-Match`
    and assumed for `If-Match`. That an ordinary `PutObject` and a `GetObject` of the current
    version need no version-specific IAM action is from memory.
24. **Whether a state database exists.** S3 answers a `GetObject` of a missing key with 403
    instead of 404 to a caller without `s3:ListBucket`, and whether a `ListBucket` permission
    limited to prefixes counts there is not documented. The runner therefore asks with a
    list request for the exact key first (`s3GetIfExists` in `aws.mjs`). That the
    `s3:prefix` condition with the values `config/*` and `state/*` allows a list request
    with the prefix `state/state.db` is assumed.
25. **`updraft state merge` and `updraft state info` end to end.** The runner's use of them
    (`image/runner/state.mjs`) matches the commands as they are in this repository
    (`docs/shared-state.md`): the options, one JSON object with a boolean `changed`, exit 5
    with `reason: "schema-too-new"` for a database newer than the CLI, a single-file
    result, `--into` created when missing, `--changed` read in place. That was checked by
    reading both sides, not by running the real commands from the runner: the runner's
    tests use a stand-in. No field of `state info`'s output is read. The Dockerfile's
    check greps `updraft state --help` for `merge` and `copy`, and `updraft state merge
    --help` for `--live`.
26. **The schema version in the file header.** The runner reads the snapshot's schema
    version as SQLite's `user_version` (4 bytes at offset 60 of the file), which is where
    Updraft keeps it at the time of writing (`src/db/database.ts`). If that changes, the
    `schemaVersion` fields of the result and the "never replace a newer schema with an
    older one" check are wrong; the merge's own check still stands.
27. **`run-event` on pull request events and on existing state.** Assumed: that it accepts
    `--event-name pull_request_review` and `pull_request` with the payload GitHub sent; that
    it keeps its database at `$UPDRAFT_HOME/state.db` and works on one that is already
    there; that with `review` and `revise` configured it runs the loop inside the one run and
    stops at `--deadline-minutes`; and that for a pull request event it acts on the pull
    request's state on GitHub rather than on the particular delivery, which is what makes
    coalescing harmless. New outcomes are handled by exit code only.
28. **GitHub's pull request webhooks.** From memory, GitHub's documentation was not
    reachable: the payload fields the filter reads (`pull_request.number`,
    `pull_request.head.ref`, `review.id`, `review.state` with the value `commented` for a
    comment review, `sender.login` as `<app-slug>[bot]` for the App); that a single inline
    comment arrives as a `pull_request_review` with state `commented`; the App settings'
    names for the two event subscriptions; and that reading checks and statuses for a merge
    needs the *Checks* and *Commit statuses* permissions.
29. **Coalescing and clocks.** The runner waits until the launcher's `notBefore`, by the
    microVM's clock. See 15. DynamoDB's conditional put is the same mechanism as the
    delivery record and equally untested against DynamoDB.
30. **Time and size of state sync.** The budget (5 minutes, 4 attempts) is a guess for a
    database of a few megabytes; it was never measured. Each copy of the database is held
    in memory while it is checked and uploaded (limit 256 MB), and a database over 5 GB
    could not be uploaded with a single `PutObject` at all.
31. **Reading a pulled state directory.** That `updraft status` and `updraft stats` work on
    the directory `deploy.sh state pull` makes, with the config but without the App's key
    file, was not tried. `deploy.sh state info` and `state pull` were run against a stand-in
    `aws` command only.
32. **Codex and Kiro in the image.** That `@openai/codex` installs with npm on the base image
    and runs headless with `CODEX_API_KEY` is taken from [docs/agents/codex.md](../../docs/agents/codex.md);
    what Kiro needs is taken from [docs/agents/kiro.md](../../docs/agents/kiro.md). Neither
    was installed or run here.
33. **Checkpoints against a real run.** `updraft state merge --live` is tested in the Updraft
    repository against a database that another connection is writing to (an open, uncommitted
    transaction included), and `state.mjs` was run once by hand against the real CLI that
    way. It was never run against a real `run-event` with an agent at work in a microVM.
    Assumed: that reading a write-ahead-log database through a second, read-only SQLite
    connection as the same OS user works on the image's file system as it does on a
    developer machine (it needs the `-shm` file to be shared memory both processes can map);
    and that a read transaction held for the length of a merge only delays the run's own
    WAL checkpoint, never its writes.
34. **How the runner notices a change.** It compares the size and modification time of
    `state.db` and `state.db-wal`. A write that changes neither would be missed until the
    next one; SQLite appends to the log on every commit, so none is expected. The run's
    lease heartbeat (every 15 seconds while an agent runs) changes the files, so a job
    checkpoints about once per interval for as long as it runs; the cost estimate in
    [Cost and quotas](#cost-and-quotas) assumes exactly that and was not measured.
35. **The ETag from a list request.** The wait for newer state compares the `ETag` that
    `ListObjectsV2` reports with the one `GetObject` returned for the snapshot. That both are
    the same quoted string for an object written with a single `PutObject` (no multipart
    upload, SSE-S3) is assumed. If they differed, the wait would end at once, the job would
    run again on an unchanged snapshot, and after 6 such runs fail as it would have anyway.
36. **The pending retry inside one microVM.** That running `updraft run-event` a second time
    in the same state directory is sound: the first run exits 6 before it creates a clone or
    a worktree, the runner replaces `state.db` (and removes `-wal` and `-shm`) with the new
    snapshot and gives it to the job user, and logs append. Tested with a stand-in for the
    CLI; `run-event`'s own exit 6 path is tested in the Updraft repository.
37. **Unsaved state and `deploy.sh state recover`.** That `updraft state copy` (SQLite's
    `VACUUM INTO` on a read-only connection) keeps every row's id is tested in the Updraft
    repository; the three uploads of a backup, their order and each one failing were tested
    with stand-ins. `deploy.sh state unsaved` and `state recover` were run in tests against
    a stand-in `aws` command (`test/fake-aws.mjs`) and a stand-in `updraft`, and checked with
    `bash -n`; never against AWS. So these are from memory: that `aws s3api list-objects-v2
    --query 'Contents[].Key' --output text` prints the keys separated by tabs (and `None`
    for no objects, possibly once per page of a long listing, which the script filters
    out), that `aws s3api get-object ... --query ETag --output text` prints the ETag with
    its quotes, that `aws s3api put-object` accepts `--if-match` and `--if-none-match`
    (recent AWS CLI v2 only), and that a refused precondition shows as `PreconditionFailed`
    or `(412)` in its error text. That a lifecycle rule with `Prefix: state/unsaved/` and
    `ExpirationInDays` may coexist with the `state/` rule that only expires noncurrent
    versions, and that it covers the keys one level further down
    (`state/unsaved/<delivery>/<attempt>/...`), was not deployed. The real merge of a real
    backup through `state recover` was not run end to end: the script's decisions and the
    merge are tested separately.
38. **Holds between microVMs.** That a second microVM leaves a first one's unfinished work
    alone is tested in the Updraft repository with two state directories and a checkpoint
    merged by hand between them (a merge waiting for checks), not with two microVMs. A hold
    expires 15 minutes after the holder's `--deadline-minutes`; the runner's final sync or
    `state recover` releases it earlier. A microVM that died after a checkpoint therefore
    blocks its own queued follow-on work from being picked up by a later delivery for up to
    `MaximumDurationSeconds` plus 15 minutes.
39. **Restoring a publication from GitHub.** Tested against an in-memory GitHub. Assumed of
    the real API: that `GET /repos/{owner}/{repo}/pulls/{n}` returns `user.login` as
    `<app-slug>[bot]` for a pull request the App opened, `head.repo.id`, and the body exactly
    as publication wrote it (the marker comment and the "Opened by updraft from run ... (agent
    ...)" line survive unless a person edits them).
40. **One revision per review across microVMs.** Tested in the Updraft repository with two
    state directories, one in-memory GitHub and a real local Git remote, not with two
    microVMs. Assumed of the real API: that a comment the App posts is listed by
    `GET /repos/{owner}/{repo}/issues/{n}/comments` to every other caller as soon as the
    `POST` has returned, with `user.login` `<app-slug>[bot]` (the guarantee rests on a
    revision's announcement being readable before its push is); that
    `PATCH /repos/{owner}/{repo}/issues/comments/{id}` replaces the body for the App that
    wrote the comment, with the `Issues: write` or `Pull requests: write` permission it
    already has; and that the GraphQL `PullRequestReview.commit { oid }` is the head the
    review was submitted against. The runner does not pass `--shared-state` to
    `run-event` yet (the checkpointer would have to keep a copy the job user can read but
    not replace), so on this deployment the last look learns of another microVM's revision
    from the pull request, not from the shared database: one extra read of the pull request
    and its comments, and no agent run.
41. **A run that checkpointed and vanished.** That a redelivery after the hold has expired
    closes the vanished run and does the job is tested in the Updraft repository with a
    daemon that dies after a checkpoint, not with a microVM that is terminated. The
    launcher's deduplication record must have expired (or been released) for the redelivery
    to reach a microVM at all, and the hold lasts `--deadline-minutes` plus 15 minutes: a
    redelivery before that ends `duplicate-delivery`, as before.

## Tests

`npm test` at the repository root runs `deploy/aws-microvm/test/*.test.mjs` with the rest of
the suite:

- `launcher.test.mjs`: signature verification (GitHub's documented example, wrong secret,
  missing and malformed headers, tampered body, empty secret, `timingSafeEqual` on
  equal-length digests), the event filter (issues; the pull request events, their actions,
  the branch prefix, comment reviews, ignored senders), configuration (`AcceptedEvents` and
  the other settings, with their refusals), the `RunMicrovm` input (exact shape; no secret,
  no issue or review text; under 16 KB; accepted by the runner's parser, state key and
  `notBefore` included), the handler's responses with stand-ins for S3, Secrets Manager and
  RunMicrovm, deduplication with a stand-in table (duplicate, expiry, release on a failed
  launch, table unreachable), and coalescing by pull request (a burst, the lease's last
  second, other pull requests, redelivery, a failed launch, table unreachable, off).
- `runner-hooks.test.mjs`: hook routing over a real HTTP server.
- `deploy-state.test.mjs` (POSIX hosts with `bash`): `deploy.sh state unsaved` and `state
  recover` run for real against a stand-in `aws` on `PATH` (`fake-aws.mjs`: a directory for
  the bucket, ETags, the two write conditions) and a stand-in `updraft` that records how the
  merge was called. Complete and incomplete backups listed apart; a merge with `--base` only
  after the manifest and both checksums were checked; without `--base` only for
  `startedEmpty: true`; a refusal, with nothing merged and nothing uploaded, for a missing
  manifest, the old layout, a missing or mismatching base or database, a manifest for
  another delivery or with keys outside its directory; several attempts of one delivery;
  the retry after a lost conditional write; and `bash -n`.
- `runner-job.test.mjs`: the job, with stand-ins for AWS and `fake-updraft.mjs` in place of
  `updraft`, as a real child process: success, failure, no summary, a run that outlives the
  watchdog (stopped with SIGTERM, then SIGKILL), termination during a run, unusable secrets
  and config, the job's environment, the `--deadline-minutes` it passes, log upload (including
  a `logPath` that points or links outside the state directory), release of the delivery
  record, retries of the report and the termination.
- `runner-state.test.mjs`: state sync against an in-memory S3 that implements ETags,
  `If-Match`, `If-None-Match` and kept versions, with `fake-updraft.mjs` as a deterministic
  `updraft state merge` and `state info` that record their arguments and environment
  (`fake-state-db.mjs` is the file format they share: a real SQLite header, rows as JSON):
  the first run with no object; a clean update; another writer between GET and PUT (retry,
  both runs' rows present, a different ETag on the second write); an object that appears
  before the first write; retries exhausted; failed downloads and uploads; a failed merge, a
  newer schema, `changed: false` and unusable merged files (no upload in each case); a merge
  that hangs, S3 calls that never answer, no budget, and the shortened budget on
  termination; the environment of the merge (no `AWS_*`, no agent key). Through `runJob`:
  the snapshot in the job's directory and the pristine base outside it, the result
  document's `state`, sync after a failed job and after the watchdog, a job whose state is
  not saved (`state_not_saved` with the job's own outcome beside it, the delivery record
  released, the base, the database and the manifest kept under
  `state/unsaved/<delivery>/<attempt>/` in that order, and the case where that fails too; and
  `saveUnsaved` with the upload of the base, of the database or of the manifest failing, each
  reported as not saved and incomplete, and a run that started from nothing), no sync when the job never started, an unreadable snapshot, config objects
  named like the database, and the wait for `notBefore`. Checkpoints: a job that writes its
  database in steps has its first row in S3 while it is still running, every merge before
  the last is `--live` against the same base, a checkpoint that hangs or fails costs the job
  nothing, and `stateCheckpointSeconds: 0` takes none. The pending retry: exit 6, the object
  changes, a second run on the new snapshot succeeds; the state never arrives and the job
  fails after the wait, with the record released; a wait of 0; and a shared object that keeps
  changing without ever having the pull request (6 runs, then failed).

Not covered by tests: `launcher/index.mjs` (which holds the DynamoDB condition expression),
`image/runner/aws.mjs` (which holds the real conditional write and how its refusal is
recognised, and `s3Etag`), `deploy.sh` other than `state unsaved` and `state recover`, `run-job.mjs` and `server.mjs` (thin wiring that needs the AWS SDK, which the
repository does not depend on; each was started by hand with the SDK installed, without AWS,
and the two state functions of `aws.mjs` against a local stand-in for S3, as said under
[What is not verified](#what-is-not-verified)), switching to the job user and every file
ownership and mode that only matters between two users (the tests do not run as root with a
second user), the real `updraft state merge` on real SQLite files, the Dockerfile, the
template and `deploy.sh` beyond what is said above.

`npm run lint` covers these `.mjs` files. `npm run typecheck` does not: they are plain
JavaScript with JSDoc comments, outside `tsconfig.json`.
