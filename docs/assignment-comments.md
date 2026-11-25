# Assignment comments

In live mode, when the worker claims an implementation run and the final dispatch check passes, it
comments once on the source issue, just before the agent starts:

> Updraft assigned a worker to this issue.
>
> | Field | Value |
> | --- | --- |
> | Worker | `codex` |
> | Model (configured) | `claude-sonnet` |
> | Complexity | `standard` |
> | Job ID | [job_...](https://updraft.readysetcloud.io/installations/123/jobs/job_...) |
> | Run ID | `run_...` |
> | Pool | `general` |

Model shows `CLI default` or `Unknown` when no model is configured or recorded, and complexity
`Not classified` when the job was not routed; a model is never claimed as observed at assignment.
Values are escaped for a Markdown table.

## Job link

Hosted runs (`updraft run-event` started by the Updraft runner, for API-key MicroVMs and native
subscription workers alike) receive three nonsecret environment variables. Operators do not set
them by hand: the Cloud launcher puts the deployment's console origin (`UPDRAFT_CONSOLE_ORIGIN` on
the launching Lambdas, from the stack's `AppDomainName`, or `ManagedClaudeConsoleOrigin` when set;
empty means no link) in the run-hook payload as `consoleOrigin`, and the runner sets the variables
for every try of `run-event`, from that origin, the broker's job id (the Cloud job id, the same for
retries and for every local run of the job) and the installation id in the broker's token file:
`UPDRAFT_CONSOLE_ORIGIN` (the deployment's trusted console origin, https; production is
`https://updraft.readysetcloud.io`, staging and self-hosted deployments set their own),
`UPDRAFT_CLOUD_INSTALLATION_ID` and `UPDRAFT_CLOUD_JOB_ID`. With all three valid, the comment links
`/installations/<id>/jobs/<cloud job id>`. If the Cloud job id equals the local job id, the Job ID
cell is the link; otherwise the local Job ID stays plain and an `Updraft job` row carries the link.
The link grants no access: the console still requires sign-in and installation membership.
Standalone workers, or missing or invalid context (non-https origin, an origin with a path or
credentials, malformed ids), render the same table with plain IDs and no link. The destination
never comes from issue content, agent output or repository configuration.

It names the agent actually selected for the run. The wording is about assignment, so it stays
accurate if the run later fails (a failure comment, if enabled, follows separately). Prompts,
paths and logs are never included.

## When it is posted

- Live mode only; log-only and prepare-only mode post nothing.
- Implementation runs only; reviewer and revision runs post nothing.
- Only after the dispatch check passes. A claim canceled or released by that check (issue closed,
  label removed, worker stopping) posts nothing.
- Every attempt is announced separately: `updraft retry`, or a start failure that moves the job to
  another agent, gets a new run ID and its own comment with the same job ID and the agent chosen
  for that run.

## Delivery

Delivery never affects the run. The agent starts without waiting for GitHub, and a failed comment
does not change the job's outcome. Transient failures (network, 5xx, rate limit) are retried a few
times with backoff; other failures are not. Failures are written to the worker log
(`assignment comment not posted`) and recorded as errors (`updraft status`).

Each comment carries a hidden marker, `<!-- updraft-run-assigned: RUN_ID -->`. The issue's comments
are searched for it before every write, so a retry, a restart, or a write GitHub accepted but whose
response was lost leaves exactly one comment per run.

Retries are in-process: if the worker stops before a comment is posted, it is not posted later.

## Queued work (Updraft Cloud)

When an Updraft Cloud account's execution capacity is taken (one job at a time by default), a
labeled issue, or a review, push or CI event of an Updraft pull request, is queued instead of
refused. Updraft acknowledges it once, as the App:

> Updraft queued this issue. Your account's current execution slot is occupied. Work will start
> automatically when capacity is available. No action is needed.
>
> **Status:** Queued · Waiting for capacity
>
> **Job:** [View in Updraft](https://updraft.readysetcloud.io/installations/123/jobs/job_example)

The link is the job's real, stable id (or the plain id when no console origin is configured).
The comment names no worker and promises no start time. It carries a hidden marker,
`<!-- updraft-queue: JOB_ID -->`, so a retried post finds it instead of posting again. It is
edited in place, never repeated: to `Started · queued for N minutes` when the job starts (the
assignment comment above then follows, for an implementation run, with the worker actually
selected), or to why it never started and what to do (`Canceled`, `Not started`, `Expired`).
A relabel or redelivery of queued work changes nothing. Queue policy, bounds and expiry are in
[cloud/README.md](../cloud/README.md#admission-queue).

## Permission

The comment is posted as the active GitHub identity, like the other comments. Needed: a classic
token with the `repo` scope (`public_repo` for a public repository), a fine-grained token with
Issues set to read and write, or, with a GitHub App, the Issues repository permission set to read
and write. See [failure-comments.md](failure-comments.md) and [github-app.md](github-app.md).
