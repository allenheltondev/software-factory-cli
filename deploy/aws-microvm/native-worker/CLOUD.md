# Cloud test route (issue #104)

This opt-in development path connects the dedicated subscription image to the existing Cloud
webhook, broker and `run-event` runner. It is **disabled by default**, single tenant, single
repository, one pinned worker and one execution slot. No customer setup UI or production fleet
management is included. The #100 commercial gate and #103's live security/subscription gates
still apply. Local regression tests are not evidence of an AWS subscription execution.

## Provision and connect

1. Follow [README.md](README.md) to build the separate native image, create the tenant's EFS
   access point, grant its dedicated execution role EFS access, configure VPC/internet egress,
   and run the signed-out official CLI and credential isolation checks. Bake all test dependencies
   into the image: repository/tool/verify networking remains disabled. Keep suspend/resume off.
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

7. Save `route.json` with references only:

   ```json
   {
     "installationId": 55,
     "repositoryId": 9,
     "repository": "acme/test-repo",
     "labels": ["updraft-native-test"],
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
   workflows still need their API keys. An unrecognized PR origin in this test repository is
   refused instead of being routed to BYOK. Keep the original job history for the whole test.
8. From `cloud/`, run:

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
