# Cloud test route (issue #104)

This opt-in development path connects the dedicated subscription image to the existing Cloud
webhook, broker and `run-event` runner. It is **disabled by default**, single installation, one pinned worker and one execution slot. The console manages workflow routing after operator provisioning. Production fleet
management is outside this pilot. The #100 commercial gate and #103's live security/subscription gates
still apply. Local regression tests are not evidence of an AWS subscription execution.

## Tenant-managed disposable sessions

The Cloud release workflow builds and publishes a dedicated image in each environment.
It checks a signed-out AWS worker for an official Claude sign-in link and confirms that
the browser grant cannot reach the lifecycle port. A failed check leaves the deployed
image version as it was. Staging deploys verified images automatically. To authorize a
Production pilot, set `ENABLE_MANAGED_CLAUDE=true` in the Production GitHub environment and
run the Production deploy workflow. The production owner then selects pilot triggers in the console.
Other installations need to opt in separately. Track broader rollout in #100.
The workflow passes the verified version to CloudFormation as `ManagedClaudeImageVersion`.
To run the same build and smoke test without enabling routing, use
`npm run build-job-image --workspace=server -- --native-claude` from `cloud/`.
CloudFormation creates a broker-only execution role, an application
control key, and the reference that lets the broker wake the webhook Lambda. The installation
owns the saved trigger selection, one current session binding, and its waiting delivery
records. The worker receives a session-scoped broker credential at boot. Claude credentials
stay in a private tmpfs on the worker.

Select published Claude triggers in **Configuration → Claude subscription routing**.
A labeled issue for a selected trigger waits until that installation has a signed-in worker.
The GitHub App posts an authenticated deep link once per delivery. The same link is available
on the installation's Deliveries view. The owner starts sign-in from that link. Cloud starts
or reuses the installation's MicroVM, then opens the private browser sign-in panel.
When the worker reports connected, waiting jobs resume without a second label event. Cloud
checks that the issue is open, the label is present, and the active configuration still
authorizes the action. Waiting requests expire in 24 hours and hold no worker slots or job
runtime quota. A new worker receives a different control credential and has to sign in again.

A deploy that changes `ManagedClaudeImageVersion` leaves a running worker on its old image.
Cloud sends it no new jobs: they wait (`image-unapproved`), and the issue comment asks for a reconnect. The console's Claude page shows a
**restart required** banner with the steps; members see it too, but only an owner can act.
**Restart worker** refuses a worker with an active, settling or queued job. Otherwise one
transaction fences the worker row (that exact VM, unchanged since the checks) and advances the
mode's revision and routing version, so no poll can claim and no launch can queue work for it.
Only then is that exact VM terminated. Once it has stopped, **Start new worker and sign in**
launches the deployed image for a waiting job, and the owner signs in again.

For live acceptance, use two test installations. Verify a member can see their own waiting
request, only the owner can start sign-in, and another installation cannot view or start it.
Repeat the webhook and open two sign-in tabs, then confirm one comment, one worker, and one
job. Verify the lifecycle-port denial and repository credential isolation before expanding
the pilot. Complete a real GitHub job, let the session expire, and
confirm the next labeled issue waits for a fresh login without API billing.

## Disposable browser sign-in pilot

A disposable image supports `{"storage":"ephemeral","cloud":{...}}`. It mounts a private
tmpfs for the Claude home and refuses a disk-backed fallback. No EFS or VPC connector is
required. The session ends when the VM terminates, at most eight hours after launch.

After building the dedicated image and provisioning its scoped broker execution role and
control secret, use `npx tsx server/scripts/native-worker.ts launch plan.json BROKER REGION`
from `cloud/`. The plan contains `installationId`, `workerId`, `imageArn`, `imageVersion`,
`executionRoleArn`, `controlSecretArn`, and a unique `session` identifier (8–64 letters,
numbers, underscores, or hyphens). Reuse the identifier only when retrying the same launch.
For a replacement, supply `previousMicrovmId` and a new session identifier. Start a fresh
session only after the old worker has drained and its termination is confirmed. The launcher
prints the non-secret `NativeWorkerRoute` value. Set it on the Cloud stack alongside the
existing image and secret references and `NativeWorkerBrowserSignIn=true`.

The owner opens **Configuration → Claude subscription routing → Sign in to Claude**. An
opaque-origin browser frame connects directly to port 8081 with a five-minute AWS grant. It
runs only the official subscription login command and shows only its official sign-in link.
The authorization code goes directly from the frame to the worker. Updraft's API receives
only normal worker readiness. Confirm the deployed gateway strips AWS WebSocket subprotocols
and that a port-8081 grant denies the lifecycle port. Do this and the authenticated
isolation check in a controlled pilot before enabling the production switch. The console
does not provision or rotate the MicroVM binding.

## Consecutive jobs reuse one connected session (#144)

After one sign-in, every eligible job runs in the same environment until it is idle for the
configured idle limit (`NATIVE_MANAGED_IDLE_MINUTES`, default eight hours) or reaches its
eight-hour lifetime. The managed VM is launched with an explicit idle policy
(`maxIdleDurationSeconds` = its lifetime, `suspendedDurationSeconds: 0`,
`autoResumeEnabled: false`). AWS measures idleness by **inbound** endpoint traffic, and this
worker only polls outward, so with the service default it could be suspended minutes after
sign-in. Cleanup retires a VM that is found suspended anyway, with the reason `suspended`.

When a labeled issue cannot start at once, the webhook names why and what it needs, in the
`nativeDispatch` log line and in the issue comment:

| Readiness | Owner action | Meaning |
| --- | --- | --- |
| `not-connected`, `auth-required`, `expired` | sign in | there is no session, or the CLI login is gone |
| `environment-retiring`, `environment-suspended`, `environment-ended`, `fenced`, `worker-lost`, `startup-failed`, `image-draining`, `image-revoked`, `image-unapproved`, `protocol-incompatible` | reconnect | this environment can never run a job again |
| `worker-starting`, `heartbeat-stale`, `auth-unavailable` | none: wait | a bounded gap; the job starts on the worker's next connected poll |

Readiness is judged from the session record first. A session can be absent, reserved with no VM
bound yet, retiring, or bound. AWS is only asked about a bound VM, never about the
`mvm-pending` placeholder. `worker-starting` lasts only until the session's startup deadline,
whether or not the VM is bound yet. After that it is `startup-failed`. `heartbeat-stale` lasts only
three minutes on a running VM. After that the in-VM dispatcher is `worker-lost`: its loop never
restarts. Cleanup then retires the environment with that reason, unless it still holds active,
settling or queued work. Parked jobs are kept and resume once Claude is reconnected. Cleanup
decides again on the exact worker snapshot its sealing transaction checks. A worker that
heartbeat or took work since cleanup read it is kept (`claudeSession: keep` in the log), and
so is one whose version moves before the transaction commits.

Known limitation: a lost dispatcher that still holds queued, never-assigned work is neither
retired nor reconnectable until that job expires (#141, #136).

The dispatcher stops for good on any refused control call. So Cloud answers each call from the
state that won any concurrent write: the runner's terminate, the dispatcher's `settled`, a
heartbeat or a reconciliation. It does not refuse a call that merely lost a race. A `settled`
request for a runner that reported its finish settles that assignment itself. A runner that
exited without a finish is still refused and fenced.

`claude-session-trace` prints the same decision from the stored state, read-only and without
secrets. Run it for the hosted acceptance runs and keep the output with the record:

```sh
npm run claude-session-trace --workspace=server -- --installation <id> --watch 30 > trace.jsonl
```

1. Connect Claude once. Label issue A and let it finish.
2. Label a different issue B one to five minutes later. Every line must keep the same
   `session.generation`, `session.microvmId` and `worker.session`. B's job must name that
   generation and VM. There must be no new waiting request, sign-in comment or BYOK launch.
3. Repeat with a gap of more than five minutes, so a cleanup run falls between the jobs.
4. Repeat with an implementation, review, revision or CI repair sequence, and label a separate
   issue while it runs. The new issue must queue (`queued`) and start on the same VM after
   settlement.
5. Check the failure paths: sign out, reconnect explicitly, deploy a new image and stop the
   VM. Each must show its precise readiness (`auth-required`, `image-unapproved`,
   `environment-ended`). Waiting requests must be kept, and nothing may fall back to an API key.

## Provision the older EFS-backed proof

1. Follow [README.md](README.md) to build the separate native image, create the tenant's EFS
   access point, grant its dedicated execution role EFS access, configure VPC/internet egress,
   and run the signed-out official CLI and credential isolation checks. Repository, tool and verify
   commands reach package registries only ([docs/package-egress.md](../../../docs/package-egress.md)); an installation
   owner adds private registries under **Claude subscription → Package registries**, applied per job. Keep suspend/resume off.
   The dedicated role must **not** be the Cloud BYOK execution role.
2. Publish this Cloud version with `NativeWorkerRoute` left empty. Record the Cloud stack's
   `BrokerFunctionName` output. The image tarball must include this branch's runner and CLI.
3. Create a random 32–256 character **worker control credential** in Secrets Manager, with a
   name under `updraft/native-workers/`. Generate/store it with your usual secret tooling; never
   put its value in a route file, image, shell history or job configuration. This authenticates the
   root dispatcher to Cloud. It has no relationship to Claude's login or tokens.
4. Give the dedicated worker role `lambda:InvokeFunction` on that broker's ARN, and
   `secretsmanager:GetSecretValue` on **only that control secret's full ARN**, in addition to the
   EFS/log permissions from #103. Do not grant it tenant S3 data, the platform App key, tenant
   agent keys, AssumeRole or MicroVM termination. Cloud supplies scoped job data via the broker.
5. Launch a fresh dedicated native MicroVM with the existing EFS-only boot payload. Sign in
   directly using the README's private operator shell and `claude auth login` as UID 1001. Prove
   a restart/replacement of that VM retains the login, with the previous VM confirmed terminated
   before replacement. Do not copy or inspect the CLI's credential files. Save the new image's
   version and, for the Cloud test, stop this warm-up VM.
6. Prepare a boot payload for the Cloud-connected replacement:

   ```json
   {
     "fileSystemId": "fs-12345678",
     "accessPointId": "fsap-12345678",
     "cloud": {
       "region": "us-east-1",
       "brokerFunctionName": "YOUR_BROKER_FUNCTION_NAME",
       "workerId": "native-test-1",
       "imageVersion": "YOUR_NATIVE_IMAGE_VERSION",
       "workerVersion": "104",
       "controlSecretArn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:updraft/native-workers/test-ABCDEF"
     }
   }
   ```

   Use the normal `RunMicrovm` CLI/SDK request from the README, this `runHookPayload`, the
   dedicated role and native image version, and a new client token. Keep the provider maximum
   duration finite and ingress restricted to the tested endpoint-token policy. Registration
   retries for up to 20 minutes while you pin its newly assigned VM ID in step 7; the provider
   lifecycle hook returns after starting this background loop. Registration alone cannot lease
   a job. If provisioning takes longer or the loop reports that it stopped, terminate this VM
   and repeat with a replacement; never restart an uncertain dispatcher session in place.

7. Save `route.json` with the worker binding only:

   ```json
   {
     "installationId": 55,
     "workerId": "native-test-1",
     "microvmId": "YOUR_MICROVM_ID",
     "imageVersion": "YOUR_NATIVE_IMAGE_VERSION",
     "controlSecretArn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:updraft/native-workers/test-ABCDEF"
   }
   ```

   Deploy the Cloud stack with `NativeWorkerRoute` set to this JSON,
   `NativeWorkerImageArn` to the dedicated image ARN, and `NativeWorkerControlSecretArn` to
   the same control secret ARN. Retain the normal tenant dispatch actor/label permissions and
   publish its ordinary workflows. The native runner replaces **every enabled Claude profile**
   with the native runtime, empty container environment, no network, and shared capacity group
   of one; it retains the classic sandbox for other adapters. Triage is refused. Non-Claude
   workflows still need their API keys. An unrecognized PR origin in an installation with console-managed routing is
   refused instead of being routed to BYOK. Keep the original job history for the whole test.
8. Open **Agent keys → Configure Claude Code subscription** in the Updraft app. After the worker reports `connected`, select the published repository and label combinations that should use the worker, then choose **Use subscription**. After initial provisioning, change this selection from **Configuration → Claude subscription routing** without a stack update. The saved Anthropic API key remains in place for other routes. A newly provisioned route defaults to **API-key mode** until you explicitly enable the subscription. The app will refuse switching while a native job is active or queued. You can change back to API mode when the worker is idle; unfinished subscription PRs are not silently switched to API billing.

9. From `cloud/`, run:

   ```sh
   npx tsx server/scripts/native-worker.ts status route.json BROKER_NAME us-east-1
   npx tsx server/scripts/native-worker.ts cancel route.json BROKER_NAME us-east-1 JOB_ID
   ```

   Operator IAM needs Invoke on the broker and GetSecretValue on the control secret. Status
   returns only connected/auth-required/expired/unavailable, busy state, versions, job ID and
   last heartbeat. It never returns native auth JSON, tokens, home paths or CLI account details.

## Dispatch and failure contract

Applying the configured label uses the normal GitHub webhook HMAC check, actor/repository
dispatch rules, quotas, delivery claims, PR coalescing and config pinning. The matching route
queues the job atomically with its record and summary; it never invokes BYOK `RunMicrovm`,
even if the worker is unavailable. Other tenant/repository/label routes retain BYOK behavior.
Only native Claude's Anthropic API key requirement is skipped. The broker's scoped credentials
cannot read that key, the worker control secret or Claude's EFS home.

The dispatcher initiates registration, polls and heartbeats using its separate root credential.
Cloud pins tenant, worker, image version and VM ID; the caller cannot select a tenant. Job
tokens are derived with a separate HMAC domain, stored only as hashes, and delivered once
after a conditional worker-row lease is committed. Repeated/concurrent polls never execute a
second copy. The worker runs the existing broker-backed `run-event` state machine; history,
redacted log retrieval, PR links, review/revision/merge behavior and console retry remain there.

The lease is 60 seconds with 10-second heartbeats. A lost assignment response, dispatcher
failure, root runner crash or uncertain settlement stops dispatch. There is no automatic task
replay and no API-key fallback. Cloud reconciliation (every five minutes) fences the old session,
requests MicroVM termination, and releases capacity only after confirmed termination. A
replacement needs a **different VM and session**, the same tenant's durable EFS mount and an
updated pinned route. The EFS lock also rejects concurrent writers to one login.

Queued jobs reserve quota and expire at their original job deadline. Persistent native quota
holds use an explicit non-expiring deadline (year 9999), including at broker start, because a
job deadline cannot prove a persistent VM stopped. Reconciliation or a normal completed runner
explicitly releases them. Missing termination permissions or AWS failures retain the holds;
do not manually release them without confirmed termination. Unresolved native job and worker
records likewise retain the evidence required to fence safely. Idle-worker billing is outside the
per-job minute ledger; do not use this development route as a production billing model.

On normal job completion the broker releases that job's slot and worker lease without stopping
the persistent VM. It first conditionally replaces the active lease with a durable settlement
marker, then releases quota, and clears the marker only after release succeeds. The marker
blocks polling and lets completion retries, reconciliation or the dispatcher's settlement check
recover partial failures without reviving the old assignment. Cancellation marks queued work terminal or tells an active runner to stop;
its deadline is not renewed while cancellation is pending. If stopping cannot be confirmed,
lease expiry takes the physical-fencing path. Drain all jobs and terminate the worker before
rotating the control secret, disabling/removing the route or removing its IAM permissions.

## Live acceptance record (required, not run by local tests)

- Record the Cloud deployment/image/config versions and test issue URL; no secret values.
- Prove login survives termination/replacement with retained EFS; record both VM IDs and the
  old VM's confirmed terminated state. Verify sanitized readiness reconnects without login.
- Apply the configured label on GitHub. Record delivery/job IDs and show no BYOK VM launch.
- Complete implementation, real verification, PR creation, review, at least one requested
  revision, and approved merge through normal GitHub events. Record job/history/log/PR links.
- Run malicious repository hooks/tools/verify credential reads against #103's boundary and
  retain failure results without credential contents. Repeat on the deployed image.
- Exercise duplicate webhooks/concurrent polls, queued work while busy, cancellation, expired
  login and worker loss. Verify no overlapping execution, no API fallback, and quota release
  only on completed-runner settlement or observed physical termination.

Keep the PR draft and the route off for customers until these records and #100's commercial
gate are complete. Any failed isolation check fails the proof instead of loosening protection.
