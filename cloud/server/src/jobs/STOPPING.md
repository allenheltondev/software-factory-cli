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
confirmed retirement; it does not start a job.
The shared `createJobStopper` service is the integration point for future authorized
GitHub commands in #135. A plain GitHub mention currently invokes nothing.

## Durable boundary

A transaction writes the first operator, reason and timestamp to the job and its
summary, sets the attempt's `stopRequestedAt`, and pauses dispatch for its source
issue/PR and any recorded PR alias. Repeated requests retain the first audit record.
The broker refuses new starts, credentials and GitHub publication tokens. The
launcher checks workflow pauses; `markLaunching` and `startJob` check the attempt
fence. A human stop never changes the platform kill switch.

Already-issued GitHub tokens and STS credentials remain valid until expiry.
Termination ends their use by the target execution; broker refusal alone does not
revoke them. A GitHub write already in flight may complete. Stops do not undo
external writes, delete commits or PRs, or force-push human changes. The fuller
trusted-publisher boundary in #134 and stable workflow reconciliation in #135/#139
remain companion work.

Standard jobs terminate only the VM recorded by the server. A late VM registration
immediately advances a pending stop. A reservation canceled before `markLaunching`
cannot launch. A missing/ambiguous VM response keeps capacity held until registration
or the maximum VM lifetime; it is never treated as confirmation that no VM exists.
`TERMINATING` is not confirmation: the VM must be `TERMINATED` or absent. Capacity
and unused-time accounting use the existing idempotent release primitive.

Native jobs receive cancellation on their next heartbeat (normally ten seconds).
The root runner signals and reaps the process group. The signed-in session is reused
only after trusted server settlement; a forced root-runner kill never permits reuse.
After the 60-second grace period or lease expiration, reconciliation fences the exact
active worker assignment and requests termination. A queued or old completed job
cannot terminate a worker doing other work. Forced termination is recorded as needing
Claude reconnection. An uncertain/missing assignment retains capacity and reports an
error instead of guessing which VM to kill.

The console polls status and keeps **Stopping…** visible even if the runner has
reported a finish but retirement remains unconfirmed. A natural finish that wins
the race retains its actual outcome. The original stop request and confirmation
remain in history. Failed AWS requests are visible, can be retried through the
Actions menu, and are retried by the one-minute reconciler independently of the
browser. Structured `jobStop: requested | confirmed | failed` events include the
job, installation, operator/timestamp or error class and confirmation latency in
milliseconds for log-based alarms and stop-latency metrics.

## Recovery

Intentionally stopped work stays paused across redelivery, relabeling, PR events and
CI events. Owner-authorized **Resume automation** removes only pauses owned by this
stopped job, atomically with a resume audit; it cannot clear a newer stop. It permits
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
