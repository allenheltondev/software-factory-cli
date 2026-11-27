# Assignment comments

What Updraft says on GitHub about its own progress depends on
`repositories.<OWNER/REPO>.notifications`:

- `quiet` (the default): **one live status comment per run** on the issue, posted once and
  edited in place as the run moves on, plus a separate comment only when a person has to act.
  Everything else goes on the console's workflow timeline.
- `verbose`: the separate status comments of earlier versions (the assignment table below, the
  "PR has the changes" comment, the queue acknowledgement on a pull request and every CI step
  comment).

```yaml
repositories:
  acme/web:
    notifications: verbose   # default: quiet
```

On Updraft Cloud the setting is on the repository's settings in the console's configuration page
("Post a separate comment for each step").

## One status comment (quiet)

A run from label to merged pull request that needs no person leaves exactly one Updraft comment on
the issue, edited through these stages, and nothing on the pull request but its body and the
reviews:

| Stage | Written by | Says |
| --- | --- | --- |
| Queued | Updraft Cloud's queue, only if the work waited for capacity | that it waits for capacity; no time and no agent |
| Assigned | the run, when its worker claims it | the table below |
| PR opened | publication | `PR #N opened` with its link; the table gains the observed model |
| Reviewing, Revising, Fixing checks, Addressing suggestions, Changes requested, Waiting for checks, Ready to merge, Checks passed | review, revision, CI-fix and suggestion jobs and the review's verdict | e.g. `Revising PR #12 for review round 2`, `Fixing failed checks on abc1234 of PR #12 (CI fix 1)`, `Applying the review's suggestions to abc1234 of PR #12, which the review found ready` |
| Ready for a person to merge, Revision limit reached, Changes requested, Waiting for a person | the verdict, the CI step, auto-merge or a review-loop job that failed, when the loop rests until a person acts | what the person does next (the review or the please-act comment on the PR says how) |
| Merged, Closed | auto-merge, or the review loop seeing a merge or close by anyone | `PR #N was merged`, `... merged after CI fix N`, `PR #N was closed without being merged` |
| Finished, Waiting | a run that succeeded without a pull request | no changes to publish, publishing off, an action that opens none, or a wait on another pull request |
| Stopped | a run that failed for good or was canceled, or a pull request that could not be opened | what ended it; a retry's assignment replaces it |

The Assigned table shows only rows that carry information:

> **Updraft · Assigned**
>
> Updraft assigned a worker to this issue and is working on it.
>
> | | |
> | --- | --- |
> | Worker | `claude-complex` |
> | Model | `claude-opus` |
> | Model (observed) | `claude-opus-5-5` |
> | Reasoning effort | `high` |
> | Capability tier | `complex` |
> | Job | [job_...](https://updraft.readysetcloud.io/installations/123/jobs/job_...) |
>
> [View this work in Updraft](https://updraft.readysetcloud.io/installations/123/workflows/456-i7)

The model row is the configured one, and `Model (observed)` appears once the CLI reported one.
Effort and tier appear only when they were set. A row that would read `Not applicable`, `Not
classified` or `CLI default` is left out, and so are the run id, pool and routing reason: the
console link has them. Without a console (a standalone worker) the job row is the plain local id
and there is no link.

### One comment, two writers

The Cloud queue (before the run starts) and the runner (from assignment on) write the same
comment. GitHub has no compare-and-set for comments, so the protocol
(`src/publish/status-marker.ts`, shared by both) is read, decide, write:

- A hidden marker carries the comment's key (the job that started it: the Cloud job id, or the
  local job id), the stage as an ordinal and, once one is open, the pull request:
  `<!-- updraft-status: key=job_... stage=40 pr=12 -->`.
- Every writer lists the issue's comments and finds the comment by that marker (only among the
  worker's own comments) before every write. A write whose response was lost, a restart or a
  redelivered event edits the comment it finds instead of posting another.
- The run's assignment finds the comment by its own key, or takes over a queue acknowledgement
  that still waits; the review loop finds the one naming its pull request. Only assignment and
  publication ever post one; the review loop only edits.
- A review-loop stage names the head commit it is about (`sha=`), and a write about a head that
  is no longer the pull request's newest never replaces one about a newer head. On one head the
  stage of the newer job attempt (or step) wins, by when it started (`at=`): a person's retry of a
  failed review shows `Reviewing` again, and a stale older attempt never moves a newer stage back.
- Without the worker's own login (or, on Updraft Cloud, the App's slug) nothing is matched or
  posted: anyone can type a marker into a comment.
- Stages only move forward across writers: a queue stage never replaces a runner stage (the queue
  reads the comment before every edit), assignment and publication never replace a later stage,
  and nothing replaces `Merged` except another final stage.

Comments posted by earlier versions are left alone, never deleted.

### Comments that ask a person to act

These stay separate, so GitHub notifies people, and each is one or two plain sentences with what
to do and, when hosted, the console link:

- a Claude sign-in or reconnect wait (Updraft Cloud);
- queued work that was refused (a budget, a missing key, the routing changed) or expired, and the
  over-quota comment (`queue_full`, jobs per day, job minutes);
- a delivery refused because an agent key is not set: which key, a link to the installation's
  Agent keys page, and how to try again. Once per issue or pull request, configuration version
  and set of keys (`<!-- updraft-refused: missing_key v3 ANTHROPIC_API_KEY -->`);
- a workflow the reconciler or automatic recovery blocked for a person (`publication_uncertain`,
  `recovery_exhausted`, a lost job that needs a manual retry, `ci_event_missed`, `ci_stuck`,
  `stalled`, `lag_stuck`, `sign_in_expired`, a refused recovery): its message and next action, with the
  workflow's console link, on the pull request when the workflow has one, else on the issue.
  Once per workflow run and reason (`<!-- updraft-blocked: 99-i7 g2 publication_uncertain -->`).
  Posting it never changes what recovery decided;
- the CI step stopping for a person (the budget is used up, the failure isn't code, CI repair is
  off) or a fixed head that passed when merging is up to a person ([ci-fix.md](ci-fix.md));
- a merge auto-merge left to a person;
- a reviewer job that stopped waiting for GitHub's pull request to show Updraft's own push, 30
  minutes after it (`lag_stuck`, [review-loop.md](review-loop.md)): once per pushed head
  (`<!-- updraft-lag-stuck: <sha> -->`);
- the revision limit, and a revision that could not be pushed ([revisions.md](revisions.md)); the
  revision's own reply states the same merge policy as the PR body;
- the review itself (including a verdict held back as `needs-verification`), its inline findings,
  thread replies and replies to mention commands ([controls.md](controls.md)), which are the
  product, not status. So are the replies that close a suggestion's thread (fixed, declined with
  the reason, or deferred) and the one follow-up issue of a pull request's suggestions
  ([review-loop.md](review-loop.md#suggestions)).

A pause an owner made is shown in the console only: the person who paused it knows.

### The pull request body

In both modes the body is short: `Closes #N`, the merge sentence, the console link (or the run id
and agent when not hosted), the commits and diff stat, the worker's verification and the agent's
final message. The agent's `updraft-acceptance` and `updraft-findings` blocks are taken out, and a
message too long for the body is cut at a line, never inside a fenced block. The merge sentence
states what auto-merge will attempt: `Updraft merges this (squash) once review and required checks pass`
when `autoMerge` is on and the verify gate passed on the commit, otherwise `Merging is up to a
person`, with the reason when a gate already stands in the way. A revision or CI fix that pushes a
new head restates it for that head's own verification, and the revision's reply says the same.

## The assignment table (verbose)

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

In verbose mode they post no assignment comment. The message each one posts on the pull request (the review, and
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
refused.

**Quiet (the default).** The acknowledgement is the status comment's first stage, on the issue
only:

> **Updraft · Queued**
>
> Updraft queued this issue. Your account's current execution slot is occupied. It starts
> automatically when capacity is free; no action is needed.
>
> [View this work in Updraft](https://updraft.readysetcloud.io/installations/123/jobs/job_example)

It carries the status marker under the queued job's id, and the queue's own
`<!-- updraft-queue: JOB_ID -->` so a retried post finds it. When the job starts the queue does
not edit it: the run's assignment is the next stage. If the work never starts, the queue edits it
to `Canceled`, `Not started` or `Expired`; refused and expired work also gets one separate comment
that says what to do. A queued pull request event posts nothing on the pull request.

**Verbose.** One acknowledgement, as the App, on the issue or pull request:

> Updraft queued this issue. Your account's current execution slot is occupied. Work will start
> automatically when capacity is available. No action is needed.
>
> **Status:** Queued · Waiting for capacity
>
> **Job:** [View in Updraft](https://updraft.readysetcloud.io/installations/123/jobs/job_example)

It is edited in place, never repeated: to why it never started and what to do (`Canceled`, `Not
started`, `Expired`), or to `Started · queued for N minutes` when the job starts, and the
assignment comment follows separately. Entries queued before `notifications` existed keep this
form.

Either way the link is the job's real, stable id (or the plain id when no console origin is
configured), and a relabel or redelivery of queued work changes nothing. Queue policy, bounds and
expiry are in [cloud/README.md](../cloud/README.md#admission-queue).

## Permission

The comment is posted as the active GitHub identity, like the other comments. Needed: a classic
token with the `repo` scope (`public_repo` for a public repository), a fine-grained token with
Issues set to read and write, or, with a GitHub App, the Issues repository permission set to read
and write. See [failure-comments.md](failure-comments.md) and [github-app.md](github-app.md).
