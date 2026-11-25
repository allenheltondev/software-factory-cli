# Assignment comments

In live mode, when the worker claims an implementation run and the final dispatch check passes, it
comments once on the source issue, just before the agent starts. By then the router has decided
the job's route (at enqueue, [tier-routing.md](tier-routing.md)) and the claim has recorded which
profile the run was given, so the comment states what was actually chosen:

> Updraft assigned a worker to this issue.
>
> | Field | Value |
> | --- | --- |
> | Status | Assigned |
> | Attempt | escalation 1 |
> | Complexity | `standard` |
> | Capability tier | `complex` |
> | Worker | `claude-complex` |
> | Adapter | `claude` |
> | Model (configured) | `claude-opus` |
> | Reasoning effort | `high` |
> | Pool | `complex` |
> | Routing reason | local classifier; escalated from standard |
> | Job ID | [job_...](https://updraft.readysetcloud.io/installations/123/jobs/job_...) |
> | Run ID | `run_...` |

Every value comes from persisted records, never from the current config or a model call: the
job's routing decision, stored at enqueue, and the run's own selection record (`run.selected`,
written in the claim's transaction: profile, adapter, configured model and effort, the tier that
runs and the one the router chose, the route's reason code, escalation hops and retries). Each
run has its own record, so a later attempt never changes what an earlier attempt's comment says.

- **Complexity** is the issue's classification (`routine`, `standard`, `complex`) by the local
  classifier or [triage](triage.md). Without one it says why: `Not classified (tier routing off)`
  when the workflow has no `tiers`, `Not classified (tier set by label)` for a tier override label,
  `Not classified (pool set by label rule)` for a `pool.rules` match. It is never guessed.
- **Capability tier** is the tier whose pool runs this attempt, including a high-risk floor and an
  escalation; `Not applicable (tier routing off)` without tiers, `Unknown` when nothing was
  recorded. It is never inferred from a model or profile name.
- **Model (configured)** and **Reasoning effort** are what the profile asks its CLI for
  (`agents.<name>.model`/`effort`, or the same flags in `args`). `CLI default` means the profile
  sets none, so the CLI chooses; `Unknown` means the run has no selection record. A model is
  never claimed as observed at assignment.
- **Routing reason** is built from fixed codes only (`tier override label`, `local classifier`,
  `local classifier, low confidence`, `triage`, `triage (earlier answer reused)`, `triage
  unavailable, local policy used`, `pool rule label`, `workflow pool`, plus `high-risk floor` and
  `escalated from <tier>`); no issue text or triage explanation. Omitted when none is known.
- **Attempt** appears for a retry (`retry N`) or an escalation (`escalation N`).

Values are escaped for a Markdown table.

### The model the CLI reported

After the run, the worker reads the model the agent CLI itself reported, when its output names
one (Claude Code: the main conversation's `assistant` messages, else its `init` message; other
adapters report none). It is kept on the run as `observedModel`, beside the configured model,
never in its place: the publication and failure comments list `Model (observed)` on its own line,
and nothing is listed when the CLI reported nothing.

### Review, revision and CI repair runs

They post no assignment comment. The message each one posts on the pull request (the review, and
a revision's or CI repair's reply) carries one line naming what ran it, from the same records:

> <sub>Profile `codex-review` · adapter `codex` · model (configured) `gpt-5` · model (observed) `gpt-5` · effort `high`</sub>

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
- Implementation runs only; reviewer and revision runs name their selection in their own pull
  request message instead (above).
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
edited in place, never repeated: to why it never started and what to do (`Canceled`, `Not
started`, `Expired`), or to `Started · queued for N minutes` when the job starts. Routing
runs inside the job, after that edit, so `Started` names no worker, model or tier and says the
assignment comment follows; that comment (for an implementation run) then carries the routing
decision and the worker actually selected. The acknowledgement is not rewritten into the
assignment table: it and the runner's assignment comment are written by different processes, and
keeping them separate means a late queue edit can never overwrite the selected metadata. A
relabel or redelivery of queued work changes nothing. Queue policy, bounds and expiry are in
[cloud/README.md](../cloud/README.md#admission-queue).

## Permission

The comment is posted as the active GitHub identity, like the other comments. Needed: a classic
token with the `repo` scope (`public_repo` for a public repository), a fine-grained token with
Issues set to read and write, or, with a GitHub App, the Issues repository permission set to read
and write. See [failure-comments.md](failure-comments.md) and [github-app.md](github-app.md).
