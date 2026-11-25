# Per-job stop controls

An installation owner can choose **Actions (⋯) → Stop job** on an active job's
detail card or installation card. The confirmation names the repository, issue/PR,
and exact job. Editors can inspect status but cannot stop or restart intentionally
stopped work. The existing linked-identity membership check also applies; platform
admin membership alone does not grant access to a tenant's stop endpoint.

`POST /api/v1/installations/:installation/jobs/:job/stop` accepts only an optional
`reason` (at most 500 characters). It returns 202 with `state: stopping`, `canceled`,
or `finished`. No request accepts a VM, worker, session, or installation override.
`POST .../jobs/:job/resume` is owner-only and permits future automation after
confirmed retirement; it does not start a job. `POST .../workflows/:workflow/resume`
(`<repositoryId>-i<issue>` or `-p<n>`, optional body `{ jobId, at }`: the pause the
owner saw) does the same from the pause itself, and is the only resume once the stopped
job's records have expired.
The shared `createJobStopper` service is the integration point for future authorized
GitHub commands in #135. A plain GitHub mention currently invokes nothing.

## Durable boundary

A transaction writes the first operator, reason and timestamp to the job and its
summary, sets the attempt's `stopRequestedAt`, and pauses dispatch for its source
issue/PR and any recorded PR alias. Repeated requests retain the first audit record.
The broker refuses new starts, credentials and GitHub publication tokens. The
launcher checks workflow pauses; `markLaunching`, `startJob` and native assignment
condition their own transactions on every applicable issue/PR pause key, as well as
the attempt fence. Native assignment also checks the exact idle worker version and
queue entry, attaching the VM and deleting the queue entry in that transaction. A
queued cancellation that wins prevents assignment; an assignment that wins retains
its capacity until trusted cleanup or physical termination is confirmed. A human
stop never changes the platform kill switch.

Admission transactions define the sibling boundary. A sibling whose launch admission
committed before the pause may have an in-flight VM request; registration detects the
pause and retires that sibling without replacing the original owner's pause. It
cannot subsequently pass broker start. A sibling already executing before the pause
is not the target of this per-job stop; future starts and credential grants are
refused, and no unrelated shared session is killed. In-flight external calls are
subject to the credential/write limits below.

Already-issued GitHub tokens and STS credentials remain valid until expiry.
Termination ends their use by the target execution; broker refusal alone does not
revoke them. A GitHub write already in flight may complete. Stops do not undo
external writes, delete commits or PRs, or force-push human changes. The fuller
trusted-publisher boundary in #134 and checkpoint-aware resume in #135 remain
companion work. This PR is stacked on #154's stable workflow records and recovery.

Standard jobs terminate only the VM recorded by the server. A late VM registration
immediately advances a pending stop. A reservation canceled before `markLaunching`
cannot launch. A missing/ambiguous VM response keeps capacity held until registration
or the maximum VM lifetime; it is never treated as confirmation that no VM exists.
`TERMINATING` is not confirmation: the VM must be `TERMINATED` or absent. Capacity
and unused-time accounting use the existing idempotent release primitive.

If RunMicrovm returned an ID but all registration attempts failed, the trusted launcher
passes its own response to the stop service. That ID is retained on the stop audit as
`executionMicrovmId`, independently of the failed attachment, and termination is
attempted even if retirement metadata is temporarily unavailable. A failed termination
remains recoverable from the audit by background reconciliation. Client requests never
accept this identifier. A completed runner outcome is separate from physical retirement:
owners can stop its remaining VM and retain its original success/failure outcome.

Native jobs receive cancellation on their next heartbeat (normally ten seconds).
The root runner signals and reaps the process group. The signed-in session is reused
only after trusted server settlement; a forced root-runner kill never permits reuse.
After the 60-second grace period or lease expiration, reconciliation fences the exact
active worker assignment and requests termination. A queued or old completed job
cannot terminate a worker doing other work. Reconnect guidance is recorded only after
the fenced VM is confirmed terminated; a failed fence CAS or cooperative settlement
does not report reconnect. An uncertain/missing assignment retains capacity and reports an
error instead of guessing which VM to kill.

The console polls status and keeps **Stopping…** visible even if the runner has
reported a finish but retirement remains unconfirmed. A natural finish that wins
the race retains its actual outcome. The original stop request and confirmation
remain in history. Failed AWS requests are visible, can be retried through the
Actions menu, and are retried by the one-minute reconciler independently of the
browser. Structured `jobStop: requested | confirmed | failed` events include the
job, installation, operator/timestamp or error class and confirmation latency in
milliseconds for log-based alarms and stop-latency metrics.
Execution confirmation also remains separate from accounting completion. A failed
refund/slot release is reported as held/failed, never released, and is retried from the
active reservation. Its error stays visible after execution ends, with **Retry cleanup**
and continued status polling. A successful cleanup clears that error.

## Recovery

Intentionally stopped work stays paused across redelivery, relabeling, PR events and
CI events. The updated #154 base makes missed-event recovery report-only: the
workflow reconciler starts no jobs. It displays `workflow_paused` and defers without
reading CI while an owner's pause is active, then resumes diagnosis after explicit
unpause. Normal dispatch uses durable issue/PR provenance even after the originating
job expires. A canceled workflow remains explicitly
blocked as `job_canceled`, rather than being mistaken for a missed finish or an
ordinary CI wait. Owner-authorized **Resume automation** removes only pauses owned by this
stopped job, atomically with a resume audit; it cannot clear a newer stop.

**A pause outlives its job.** The `PAUSE#<repo>#<subject>` records have no TTL, and each
holds what resuming needs: the stopping job and time (the pause's identity), who stopped it
and why, every subject the stop paused, and, once execution was confirmed ended, when. The
job's own records expire (META a week past its maximum run, its summary after 30 days); the
pause does not. The workflow's page shows the pause and, to owners, **Resume automation**.
That resume deletes the pause on every subject in one transaction conditioned on exactly that
job and time, so a newer stop on any subject fails it as a whole and lifts nothing. With it
goes a `PAUSELOG#<repo>#<job>#<at>` audit record (resumed when and by whom, also without
TTL). A pause not yet marked confirmed is resumed only when its job record is gone, since a
stopped job past its record's lifetime cannot still be running; while that record exists
and is unconfirmed, the answer is `stop_pending`. The job's records, where they still exist,
are marked resumed as well, the summary even once META is gone (the pause holds the job's
creation time); that projection is best effort, and the `PAUSELOG` record is authoritative.
A pause is never expired on its own.

**Found after everything else is gone.** The pause also records its repository, issue and pull
request. The Workflows list includes every pause no kept workflow covers (the workflow record
lasts 90 days after its last change), as a blocked `workflow_paused` workflow built from the
pause alone, and its page shows the pause and the resume action. The view reports the subject
it found the pause on (the issue, or a pull request of the workflow), and the resume names that
subject with the pause's job and time (`{ jobId, at, subject }`), so what is shown is what is
lifted. It permits
future GitHub events and leaves this attempt stopped. It does not replay work,
reevaluate the same PR head immediately, reopen a closed PR, or implement #135's
checkpoint-aware resume. Existing **Retry job**, where supported, explicitly launches
the original event with current configuration, quota, authentication and kill-switch
checks, then removes its parent's pauses. It is unavailable until stopping is
confirmed. Review-loop jobs retain their existing retry restrictions; resume future
automation, then push/review on the existing PR. Reconnect Claude first if required.

## Validation and deployment gate

Unit/integration tests cover store transactions, authorization, duplicate stops,
before-launch and late-registration races, ambiguous launch responses, broker
refusal, accounting, natural completion, background retries, native cooperative
settlement, forced termination, and preserving another active assignment.
The local browser preview also verified the menu, keyboard confirmation and Escape
focus restoration, stopping/confirmed/resumed states, and the mobile confirmation
in both themes. This preview used a simulated API, not AWS execution.

Before marking #142 complete, deploy the API, webhook and cleanup functions/IAM and
rebuild the native worker image containing the updated root dispatcher. Exercise a
real standard VM and a real managed Claude job in staging, inspect process/VM
termination and accounting, and verify the next queued job. Also test termination
permission failures and reconnecting a forced native session. Local mocks and UI
previews do not establish those deployed guarantees. No live staging termination
evidence is supplied by this change alone.
