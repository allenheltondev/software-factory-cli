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
  - **Agent pools:** the console's settings (`server/src/tenants/console.ts`, version 2) are an agent roster (provider, model, effort, on or off), named pools of agents that take turns, workflows (a label, the pool that builds, the pool that reviews or none, revision on or off, prompts), and repositories (which workflows run there, verify commands, base branch, publishing, auto-merge). Who may start work is one list for the installation, which a repository can replace. A new installation starts with a `builders` and a `reviewers` pool that each hold every agent the deployment offers; a reviewer is never the agent that wrote the code unless the workflow allows it (the default when only one agent is offered). An agent that is off needs no key.
  - **One page:** the Configuration page shows the label and who may add it, the repositories (each with its checks, other settings behind ⚙), the coding agents and the review agents (ticked per agent; none ticked for review means no review), with keys added in place. It is the same page for the first setup and every change after; prompts, revision rounds and the time limit are under Advanced. A configuration with more than one label, other pools or more than one agent per provider opens in the full editor (Repositories, Workflows, Agents and pools) instead, which the simple page can also hand over to.
  - **Version 1 settings** (one agent and one reviewer per workflow, labels and actors per repository) are upgraded on read for the editor. Re-activating a version published with them compiles it with the version 1 compiler (`server/src/tenants/console-v1.ts`), exactly as it ran. Once upgraded settings are published, jobs and pull requests opened under version 1 still find what they stored: each workflow keeps its version 1 workflow id (`<action>:<label>`) through its action name, and the version 1 pool names (`W`, `W.review`) resolve to the pools that replaced them (`legacy` in the settings). Workflows split off by the upgrade do not count against the workflow limit, upgraded settings may hold as many agents and pools as v1 could (40 each), a v1 reviewer stays an agent apart from the builder even with the same model (so no new self-review is allowed), and prompt files identical across workflows are published once. When the active version cannot be opened in the editor anyway, the page says so and why instead of showing the defaults as if nothing were published. A repository that ran two version 1 workflows with different verify commands gets the first one's list, and the editor says so before publishing.
  - **Missing keys:** an agent whose key is not set cannot be ticked on the Configuration page (an info icon says which key to add, and opens the field for it). One the published configuration already runs stays ticked when its key is removed: publishing waits until the key is back or the agent is unticked, so a review policy never changes unseen.

- **Claude Code scheduled tasks (formerly Routines):** GitHub issue labels can route directly to an Anthropic-hosted Claude Code task. This is separate from the Updraft microVM agent pools. Open an installation's **Claude scheduled tasks** page; first create a task at [claude.ai/code/routines](https://claude.ai/code/routines), choose its repository and instructions, add an [API trigger](https://code.claude.com/docs/en/routines#add-an-api-trigger), then paste the full /fire URL and the dedicated API trigger token. Choose the same installed repository and label in Updraft. The next `issues.labeled` webhook for that label fires the task, returns the Claude session URL in Updraft's Deliveries view, and posts it on the GitHub issue (best effort). A matching route takes precedence over any Updraft workflow using that label; other labels continue as before. Routes default to the configuring member's linked GitHub login, with an explicit actor allowlist. Overlapping workflow actor restrictions, repository pauses, and the platform kill switch still apply. A delivery stays assigned to its original backend for 30 days; reapply the label to trigger a different backend. A task run uses the user's own Claude Code subscription and Anthropic's infrastructure, not an Updraft microVM or API credits.
  - **Authentication:** only the routine-specific, no-read-access API trigger token is stored, write-only in Secrets Manager at `updraft/tenants/<installation>/routine-triggers/<rule id>/<credential id>`. No Claude.ai login, authorization code, general OAuth/session token, or `CLAUDE_CODE_OAUTH_TOKEN` is accepted or intermediated. Hosted microVM agents continue using customer-owned API keys. Local Updraft remains free to use the normal unmodified Claude Code CLI and its native login.
  - **Scope and limits:** up to 25 routes per GitHub installation, keyed by repository and issue label. These routes trigger only on GitHub's signed `issues.labeled` webhook. The token and URL are never taken from an incoming webhook; stored URLs must match the official `https://api.anthropic.com/v1/claude_code/routines/trig_.../fire` format. Each successful fire creates an Anthropic-hosted session. Anthropic's experimental API has its own limits (currently 30 fires/hour per task and 100 per account); it has no idempotency key. Updraft claims the GitHub delivery before firing, and never automatically retries an ambiguous timeout: doing so could create duplicate sessions. Remove and re-apply the issue label for a fresh event after checking the Claude Code sessions page. Direct routines do not participate in Updraft's in-microVM review pools, CI checks, or auto-merge loop; put instructions and the GitHub connection in the Claude task itself.
  - **API:** member-only `GET/PUT /api/v1/installations/:id/routines` and `DELETE /api/v1/installations/:id/routines/:ruleId`. A stored rule lists its repository, label and API endpoint but never its trigger token. Route replacements atomically publish a new immutable credential reference; retired credentials are removed best effort, and uninstall cleanup enumerates every stored routine trigger secret, including unpublished credentials left after ambiguous storage failures.

- **Agent credentials** ([#70](https://github.com/allenheltondev/software-factory-cli/issues/70)): bring your own `ANTHROPIC_API_KEY` / `CODEX_API_KEY` / `KIRO_API_KEY`, under Agent keys in the console, or in place on the Configuration page. Each agent the configuration runs comes first, with the steps to get its key. Claude and Codex keys are checked with the provider before they are saved; Kiro has no call to check a key with, so a Kiro key is saved on its shape and its first job is the check (its "last used" says how that went). A Kiro key works for an organization that signs in through IAM Identity Center once an administrator turns on API keys in the Kiro settings of the AWS console. Codex and Kiro must be in the job image (`AGENT_PACKAGES`, `KIRO_INSTALL_COMMAND` in `deploy/aws-microvm/image/build.env`). The `CloudAgents` stack parameter (default `claude,codex`) lists the agents the console offers and the broker hands keys for; add `kiro` only once an image with Kiro in it has run a job end to end. Where Kiro is not listed, Agent keys and the Configuration page say that the deployment must ship Kiro in its job image and enable it in `CloudAgents`, rather than leaving it out without a word.
  - **Write-only:** a member sees `configured`, `last rotated` and `last used OK/failed` per key. `PUT /api/v1/installations/:id/agent-keys/:name` takes a value; no route returns one.
  - **Validated first:** the key is checked with one cheap provider call (listing models) before it is saved. A key the provider rejects, or a provider that cannot be reached, saves nothing. Rotating replaces the secret under the same name, so the next job reads the new key, and clears `last used`.
  - **Launcher:** a config version records, per workflow (each is its own trigger, with its own actors), the keys its agents need (stored once per repository when every trigger needs the same ones). If one of the matched trigger's keys is not set, the launcher starts nothing, answers 200 `missing_key` and records the reason (shown under "Recently not started", kept 30 days). A Codex workflow on one label does not hold up a Claude workflow on another.
    - **Versions published before this:** their dispatch rules have no keys, so the launcher reads them from the version's `config.yaml` (once per version per process; `tenants/key-needs.ts`). A version whose bundle cannot tell is refused, never run unchecked; the console shows every key as required for it.
  - **Last used:** the job pins the keys its trigger needs; when it finishes, each is marked OK (`succeeded`) or failed (any other outcome that was not a termination). A job that started before the key was rotated says nothing about the new value, so it is not recorded.
  - **Redaction:**
    - **In the microVM** (`deploy/aws-microvm/image/runner/redact.mjs`): with the keys the runner loaded, before anything leaves it. That covers the job's stdout and stderr on their way to the log stream (line by line, so a key split across writes is still found; a very long line is written in pieces cut only where no key or key-shaped token crosses), `updraft.log` and the run log before they are uploaded, the result document (`summary`, `error`, `stderrTail`) and the runner's own log lines. Anything shaped like a provider key, bearer token or key header goes too.
    - **In the API** (`server/src/tenants/redact.ts`): the same rules for the API's logged errors and the launcher's logged launch failures.

- **Status and diagnostics** ([#71](https://github.com/allenheltondev/software-factory-cli/issues/71)): each installation's page says whether it is working, and if not, why.
  - **Overview** (`GET /api/v1/installations/:id/overview`): the installation's status as GitHub has it now (active, suspended, missing permissions, disabled, uninstalled), the repositories it reaches and which are configured (and any configured one it no longer reaches), the active config version, the agent keys, and 30 days of activity in counts (or the latest 500 of each, which it says). What needs attention is listed with where to fix it. It also names the labels that start a job (`config.triggers`) and whether traces are set up (`telemetry`), for the console's **Get set up** checklist: the App and its permissions, its repositories, a published configuration, the keys of the agents it runs, traces (optional), and a first job, each with where to do it, the next one open. The checklist is shown until every step jobs need is done.
  - **Deliveries** (`GET .../deliveries`): every webhook delivery for a tenant except the App's lifecycle events, kept 30 days, with one disposition (`server/src/jobs/deliveries.ts`): `filtered` with its reason (unknown_repo, paused, not_trigger, actor_not_allowed, event_not_accepted, for pull request events loop_off, not_updraft_pr, own_event and comment_review, and the tenant's or platform's state), `deduped` (with reason `already_queued` when folded into queued work), `coalesced` (a pull request event folded into the job another event of that pull request just started), `queued` with why it waits (`concurrent_jobs`, `platform_concurrency`, `queue_ahead`) and the job it starts as, `throttled` with the limit (a budget, or `queue_full`), `launch_failed` with the AWS error's class, or `launched` with its job.
  - **Jobs** (`GET .../jobs`, `.../jobs/:jobId`, which lists every kept attempt of the job's delivery, an earlier failed one before a redelivery included): status, issue and pull request links, config version, duration and how each ended (`server/src/jobs/status.ts`: success, nothing to do, canceled, superseded, deferred, agent failure, verify failure (of any job the run did, a revision included), publish failure, timeout, `state_not_saved`, ...). The runner reports its pull request, verification and uploaded logs at the broker's `finish`; the broker keeps only what checks out (a pull request of the job's own repository, known log names). Kept 30 days.
  - **Stop**: installation owners can choose **Actions (⋯) → Stop job** on an active job card. The server records the request before termination and displays **Stopping…** until execution ends, keeping the PR, commits and audit history. Automatic continuation stays paused until an owner resumes automation or explicitly retries. [Cancellation semantics, recovery and deployment validation](server/src/jobs/STOPPING.md).
  - **Retry** (`POST .../jobs/:jobId/retry`, the **Retry job** button on a job's page): runs the event of a job that did not finish its work again, as a new job (the API answers 202 with its id). It is offered for a canceled job, a failed one (agent, verification, timeout, state not saved, stopped, could not run, unconfirmed) and one that never ran (over a quota, a failed launch, released by an admin); not for a running job, a success, nothing to do, superseded or deferred (a usage-limit cooldown ends by itself), nor one that was retried already, nor a publication that failed after the agent succeeded (its job is `succeeded` in the shared state, which `--retry` leaves alone, so the event would end as a duplicate and publish nothing; the answer says to apply the label again on GitHub), nor a job of a pull request's review loop (a revision or a review: the loop's own records decide what is left for it, so running its event again finds nothing new; it starts again from GitHub with a push or a review). The API checks the caller is a member and that the job can be retried, then invokes `WebhookFunction` directly (`server/src/jobs/retry.ts`), the one function with the launcher's permissions. That reads the event the job ran for from the tenant's `events/` prefix and launches it again under a delivery id of its own, so the tenant's active configuration, keys and quotas apply as to any new delivery (a label or key that has changed since can refuse it, and the console says why). The job is started with `retry: true` in its run-hook payload, so the runner gives `updraft run-event` `--retry`: the CLI derives a job's id from its event, so the shared state already holds the failed job, and a plain delivery would end as a duplicate; `--retry` requeues it in the runner's copy of the state first, as `updraft retry` does, and the result merges back like any run's. (An image built before this has no `--retry`: rebuild the image when you deploy.) A request first claims the retry on the original's summary (`retryReservedUntil`, a conditional write, so of two overlapping requests only one launches; a request that dies holding it loses it after two minutes). The claim keeps the id of the job it is about to launch (the launcher takes the id from the caller, `jobId`), so a claim that has run out is settled by looking for that job: if its launch reached the point of no return (`launchingAt` on the job itself, which `markLaunching` writes in the same transaction as the reservation's phase, so the evidence outlives the active entry that reconciliation deletes before it fails a job; or a microVM or a start on record), the original is recorded as retried to it in one conditional write that checks it is still the claim that was seen, and no second job is launched; if it has a record and its reservation is still `reserved`, the launch may have died before `RunMicrovm` and the reconciler fails it after five minutes, so the request answers `retry_pending` until then; if it has no record, its launch failed, or its reservation is gone with no mark (reconciliation took it, and a cancelled reservation cannot launch), the retry is launched afresh. A request reads the clock once, so a claim seen live is live for the write that would take it over, and gives the claim back if nothing started (over a quota, a refused launch), so it can be asked for again. A retry that started a job is recorded there (`retriedAs`, kept as long as the summary, 30 days), which is what stops a second one. It needs the job's own record, kept a week past its end: an older job answers `event_gone`, and the label is applied again on GitHub instead.
  - **Logs** (`GET .../jobs/:jobId/logs/:name`): the last MiB of `run.log` or `updraft.log`. The job is found in the caller's own tenant partition, so another tenant's log cannot be named; the text is redacted once more on the way out. The API reads `tenants/*/results/*` only, and cannot list the bucket, so S3 answers a missing log with 403: a log still there is always served, and a missing one is expired (410) past the stack's `ResultRetentionDays` (which the API gets too), or 502 within it.
  - **A microVM that ends without the job's finish** (stopped, crashed, out of time): reconciliation records the job as finished, `microvm_gone`, unless a finish got there first, so the console does not show it running.
  - **Workflows** (`GET .../workflows`, `.../workflows/:workflowId`, `.../jobs/:jobId/workflow`; the **Workflows** tab and a workflow's page, #139): an issue's whole story across its jobs (`server/src/workflows/`).
    - **Identity and runs:** each workflow is keyed by the repository id and the issue (`<repositoryId>-i<issue>`). A pull request belongs to its issue's workflow once a job reports opening it; one Updraft never saw opened gets its own (`<repositoryId>-p<n>`). Labeling the issue again after the workflow finished or was blocked starts a new run of it; a retry does not.
    - **A new run's pull request:** a new run starts with no pull request. The last run's is kept in `pastPullRequests` with its run, and a job on it later (an event on the old pull request) is that run's history: it does not change the current run, and reconciliation looks only at the current run's pull request. A relabel that first waits for a Claude sign-in or reconnect starts its run when it starts waiting, and the job that starts once someone signs in continues that run. The last 20 runs' pull requests are remembered: a job on an older one than that is taken as the current run's.
    - **Recording:** the launcher records each job's start, and the broker records the finish that stuck. When reconciliation finds a job's microVM gone without a finish, it records that too, and the workflow is blocked with what to do next.
    - **Consistency:** each change is a versioned save, made together with its timeline event in one transaction. Concurrent writers never overwrite each other, and the timeline never shows a change that was not made.
    - **Late finishes:** only the workflow's latest job decides its state. An earlier job's finish, late or replayed, is history, whatever stage the workflow is in, and is filed under the run it belonged to. A finish of a job whose start was never recorded, created after the latest one, makes it the latest. A finish after reconciliation saw the pull request merged or closed is history too: the workflow stays finished.
    - **Replays:** a start or finish whose event is already recorded changes nothing at all, neither the timeline nor the workflow (the save reports a replay).
    - **Status:** from the review loop's stage (`detail.loop.stage`) and the outcome, a workflow is working, waiting (for CI, a person's merge, or the loop's next event) or blocked (`job_failed`, `job_lost`, `needs_human`, `stalled`, `ci_stuck`, `ci_event_missed`, `sign_in_expired`, `publish_failed`, `label_event_missed`). A blocked or waiting workflow carries a reason in words and a next step.
    - **Timeline:** every job start and finish (with the steps' roles: the coding agent for implement and revision, the review agent for review, and the adapter, model and effort each step ran with), wait, queue admission or end, automatic recovery, stop and resume, block and finish. Each event has an immutable id, so recording one twice changes nothing. Reconciliation's own events are named for the workflow version they were decided on, so a later decision is a new event, not a replay (`server/src/workflows/timeline.ts` has the rules below).
      - **Order:** events are ordered by the workflow version they were saved with, which is the order the changes were made in, whatever the writers' clocks said. Only rebuilt history (no versions) is ordered by time. A finish found later from the job's own record keeps when it happened (`occurredAt`) apart from when it was recorded.
      - **Waits:** a change that ends a wait records how long it lasted (`waited`: CI, a Claude sign-in, a person, the loop's next event), measured from the workflow's own `waitingSince`. A wait for capacity is measured from the queue entry's own enqueue time, on the `admitted` event (or the queue end or cover); a pause from the stop's request, on the resume.
      - **Queue:** enqueue (with the wait's reason code), admission with how long it waited, cancel, refusal, expiry and coalescing are all on the timeline, each with its reason code.
      - **Routing:** a finish carries the route the runner reported: the tier, the tier first chosen (after an escalation), the pool and the routing reason, fixed codes only.
      - **Stop and resume:** an owner's stop records `control` `stop_requested` (who, and their reason) and pauses the workflow at once, rather than at reconciliation's next look. The stopped job's finish keeps it paused. A resume, from the workflow or from the stopped job, records `control` `resumed` (who, and how long it was paused) and gives the workflow back what it said before the pause, except that a lost job's retry is not carried on, and a stopped job's block says it was resumed.
    - **Retention:** a workflow record is kept 90 days after its last change; each timeline event 90 days after it was recorded (so a workflow older than that has lost its earliest events, and the console says so); job records 30 days (a timeline's link to an older job says the record expired instead); a stop's pause until it is resumed. The console reads the newest 500 events of a workflow and says how many older ones it leaves out, and when one read could not see them all (more than 2,000).
    - **Paused work:** every workflow a stop's pause holds is marked `paused` in the list (and the `status=paused` filter finds them), whatever its record says. A pause outlives every other record: one whose workflow is past the list's newest 200 shows that workflow's own record; one whose workflow record has expired is shown from the pause alone, and can be resumed from there.
    - **Totals:** computed on read from the timeline, counting each job once. They cover jobs and retries, reviews and revisions, tokens, the agents' reported cost, active time and wall time. A cost that includes a Claude subscription job is labelled an estimate, and steps that reported no cost are counted and left out.
    - **List filters:** the list takes `status` (or `paused`) and `repository` filters, and the console offers them.
    - **Rebuilt workflows:** jobs whose issue has no recorded workflow are rebuilt on read from job records, kept 30 days. This covers jobs from before workflows existed, and jobs whose recording failed. A rebuilt workflow has an id `legacy-<digest of the repository>-i<issue>`, is marked as rebuilt, and lists what it cannot show. It is never stored or reconciled.
    - **Sign-in waits:** a job waiting for a Claude subscription sign-in makes its workflow wait (`sign_in_required`, with where to sign in).
    - **Failed publication:** a run whose publication failed is blocked (`publish_failed`), with how to publish it again.
  - **Workflow reconciliation** (#136): a schedule on `WebhookFunction`, every five minutes, `{"action":"reconcileWorkflows"}` (`server/src/workflows/reconcile.ts`). It runs there because that function has the App's credentials, the launcher and the console retry. It reports, and recovers what is safe to recover (below, **Automatic recovery**); it never launches work any other way. It looks at up to 25 workflows that are due a look (`PLATFORM#WORKFLOW-DUE`), with an installation token limited to the repository and to reading pull requests, checks and statuses. It decides from GitHub's answers, never from elapsed time alone, and changes a workflow only if no job started meanwhile.
    - **Merged or closed:** a pull request merged or closed meanwhile finishes the workflow.
    - **Checks still running:** a wait for CI is looked at again every 15 minutes, holding nothing, and is blocked (`ci_stuck`) after 24 hours.
    - **Missed check event:** checks that all finished on the current head (check runs and commit statuses, or none at all) with no job picking up the result mean the check event was missed, or never sent. Status-only CI never sends one. The CI step is started for exactly that head (**Automatic recovery**), once. Where that is refused or spent, the workflow is blocked (`ci_event_missed`), saying why and what to do: re-run a check on GitHub, whose result restarts the review loop, or retry the last job.
    - **Stalled loop:** a review loop waiting for an event no one sent is blocked (`stalled`) after six hours.
    - **Lost finish:** a workflow whose job should have ended by now (its maximum duration plus 15 minutes) without the finish reaching it is updated from the job's own record (`finish_recovered`). A job still running is left to quota reconciliation, which ends it as `microvm_gone`. A job whose record has expired blocks the workflow (`job_lost`). A job that ended `microvm_gone` is looked at five minutes later for **Automatic recovery**.
    - **Sign-in expiry:** a wait for a Claude sign-in is blocked after 24 hours (`sign_in_expired`).
    - **Missed first label:** a labeled issue whose `issues.labeled` delivery never arrived has no workflow, so nothing above looks at it. Once an hour per tenant (five tenants per run), `server/src/workflows/label-scan.ts` lists the tenant's configured repositories' open issues that carry a trigger label and were updated since its last successful look. That look overlaps the previous one by an hour; the first goes back 24 hours. It takes at most 20 issues per tenant and look.
      - **Report, never replay:** it starts no job. GitHub's delivery names no label event, so a replay and a late real delivery could not share a claim. And an issue's job from before workflows existed has no workflow either.
      - **Evidence:** an issue with no workflow, whose label was applied between 15 minutes and seven days ago, is checked against the tenant's job and delivery records (both kept 30 days). If any job or delivery came for that issue since the label was applied, the event reached Updraft and nothing is reported.
      - **Blocked workflow:** otherwise the issue gets a blocked workflow (`label_event_missed`), saying that applying the label again starts it. A delivery that arrives after all starts the job, and the workflow with it.
      - **Failed looks:** a look that fails is tried again at the next interval, from where the last successful one left off.
      - **Limitation:** a missed first label stays report-only; applying the label again starts it.
    - **Automatic recovery** (`server/src/workflows/recovery.ts`): two recoveries, each through a path that already exists.
      - **Missed check event:** a `check_suite.completed` event for the pull request's current head is synthesized and handed to the launcher, like any delivery. So the tenant, the active rules and keys (ciFix on), a stop's pause, the kill switch, the execution route and the pull request's coalescing lease all apply. With capacity taken it waits in the admission queue, whose admission re-checks the head and drops the event once a push moved it on. The job runs the CLI's review-loop poll, which reads the pull request, its checks and the loop's records as they are then. It continues the existing pull request; a stale or repeated event finds nothing to do.
      - **Lost worker:** the workflow's latest job is an issue's implementation that ended `microvm_gone`. It is retried once through the console retry (`retriedAs`: one retry per job, whoever asks). Only when: no stop touched it; Lambda showed its microVM terminated, or an hour has passed since its lifetime ended (so no token it held still works); the issue is still open and labeled; no `updraft/issue-<n>-` branch exists on GitHub; and no pull request (open, closed or merged) from such a branch was opened since the lost job was created, the listing read back that far. A retry publishes on a branch of its own, so a lost run that pushed anything could otherwise end in a second pull request; such a workflow is blocked (`publication_uncertain`), naming the branch or pull request. This is deliberately conservative: a branch an earlier run left behind blocks the retry too, though the lost run pushed nothing; a person deletes it and retries from the job's page. A review-loop job is never retried (the loop's own records decide what is left), and is blocked with how to continue it. A subscription job keeps its worker: an offline worker refuses the retry rather than moving it to API keys.
      - **Fences:** each action is claimed on the workflow with a versioned save, before anything is launched. The claim's key is the run and head (check event) or the lost job (retry), and its timeline event (`recovery`) is named for the key and the try. A job starting meanwhile, a real event, or another reconciler that got there first wins, and nothing is launched. The pause is read again, and the pull request's head, right before the launch. The synthesized event's delivery id and job id are derived from the key, so the launcher's delivery claim, the queue entry and the job record dedupe it: a job under that id means the action already ran, and it never runs again, nor when a try handed the event to another job (folded into one of the pull request's, or a queued entry it joined). Only a launch whose job record provably ran nothing (`launch_failed` with no start, no microVM and no `launchingAt`: reclaimed before RunMicrovm was asked) lets the next try use ids of its own; a `launch_failed` after RunMicrovm was asked may still be running, and counts as the head's CI step. A try handed to a queued event that has no job yet is waited on while its queue entry waits, and once the entry ended unstarted the workflow is blocked, saying so.
      - **Budgets:** an action is tried at most six times (a transient refusal: jobs off, a busy queue or claim, a failed launch, an offline worker), 5 minutes apart and doubling to an hour. A run has at most three actions. A reconciliation run takes at most two, within its first five seconds; the rest stay due for the next run, first in line. Every look that does not act (a queued job pending, a recovery job still running, a claim another writer beat, a GitHub error) moves the workflow's next look on, so a workflow that cannot be acted on yet never holds up the others. Spent, or refused for good (ciFix off, a usage limit, a missing key, a changed route), the workflow is blocked with the refusal.
      - **A stop wins:** a paused workflow is reported, never recovered. A stopped or canceled job is never retried, and the launcher's own transactional pause check refuses a recovery launch that races a stop. A lost job's retry is not carried on after a pause is resumed: it stays blocked for a person to retry. That holds even for a pause set and resumed between two looks: any job of the run stopped since the lost job was created rules the retry out.
    - **Waiting for a person:** a pull request ready for a person to merge, or stopped for one (`needs_human`), is looked at every six hours, so a merge or close whose delivery was missed still ends the workflow. It is never blocked for taking time.
    - **One decision per look:** every change is a versioned save against the record it was decided on. A job that started or finished meanwhile, or another run that got there, means nothing is changed.
    - **Kill switch:** the kill switch stops the whole run.
  - **Retention:** results (result documents and logs) follow the stack's `ResultRetentionDays` (default 30): the daily cleanup deletes each tenant's older objects under `tenants/<id>/results/`.

- **Insights and the job lifecycle**: how the factory is doing, for each installation, under Insights in the console.
  - **Insights** (`GET /api/v1/installations/:id/insights?window=24h|7d|30d|90d|all&repo=owner/name`): `updraft stats --json` (docs/stats.md), computed by the CLI's own `computeStats` over the tenant's shared state database (`tenants/<id>/state/state.db`). It covers issues worked and how they ended, pull requests opened and merged, what review caught (verdicts, findings, first-pass ready), revision rounds per pull request, time per step, why merges were blocked, per repository, and by model for writing code (`routing.byModel`) and for reviewing (`review.byModel`), with a day-by-day series (`daily`) for the trend charts. Runners checkpoint the state every few seconds while a job runs, so the page is close to live.
    - The API's role may read that one object (never the unsaved databases a failed sync leaves beside it). It downloads it to `/tmp` only when its ETag changed (`If-None-Match`), opens it read-only with `node:sqlite`, and reuses a report for 15 seconds.
    - A state database written by a newer Updraft than the API bundles answers 503 `state_newer`; one from before stats were recorded reports zeros.
  - **Lifecycle** (on each job's page, and as badges in the jobs list): the runner reports at `finish` where the review loop left the pull request (`loop`: stage, rounds of `maxRevisions`, reviews, verdict, merged) and each step in order (`steps`: implement, review, revision, with agent, outcome, verification and publication). The broker keeps only codes, counts and booleans of it (`server/src/jobs/lifecycle.ts`).

- **Agent telemetry**: what each job's agents did, sent to the tenant's own tracing tool as OpenTelemetry GenAI spans ([docs/agent-telemetry.md](../docs/agent-telemetry.md)).
  - **Settings** (`GET/PUT /api/v1/installations/:id/telemetry`, `PUT/DELETE .../telemetry/key`): a Honeycomb Ingest key, checked with Honeycomb's `/1/auth` in the chosen region before it is saved (write-only, like an agent key: `agent-keys/HONEYCOMB_API_KEY`), sending on or paused, the service name, and whether prompts and outputs are recorded. Saving the first key turns it on.
  - **Broker**: a job of a tenant with telemetry on gets `descriptor.telemetry` (region, the key's secret name, service name, content on or off). It is never among `agentKeySecrets`, so the key never reaches an agent's environment.
  - **Runner** (`deploy/aws-microvm/image/runner/telemetry.mjs`): tails every `run.log` while the job runs and sends OpenTelemetry GenAI spans (`invoke_workflow`, `invoke_agent`, `chat`, `execute_tool`) over OTLP/HTTP JSON, one trace per job, `gen_ai.conversation.id` = `owner/repo#issue`. Its `finish` reports the trace id, how many spans got there, the conversation id, and the spans worth a link of their own (each run's agent span, the first red and green test runs, a failed verify command or step). The console links each job to its trace, to those spans, and to its conversation (a Honeycomb query by `gen_ai.conversation.id`, or Agent Timeline itself when the stack's `HoneycombTimelineUrl` template is set), lists the conversation's other jobs, and the settings page shows the last export.

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
  - **The webhook:** `server/src/flows/webhook.ts` handles uninstall, suspend and unsuspend. Uninstall is final (a conditional write), and a repeated delete keeps the first deadline. GitHub can deliver events out of order, so for suspend and unsuspend the webhook asks GitHub for the installation's current state instead of trusting the event's order. A labeled issue goes to the launcher ("Starting jobs" below), and so do the review loop's pull request events ("Pull request events" below).

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
5. Build and smoke-test the worker images in AWS. The Claude subscription image uses a separate
   release job. CloudFormation deploys the verified version in Staging and in Production
   when an operator enables the pilot. Each installation selects its own subscription triggers. See the
   [Claude subscription release and acceptance criteria](../deploy/aws-microvm/native-worker/CLOUD.md).

There is no `sam build`. `ApiFunction`'s `CodeUri` is the bundled `server/dist`, which `sam deploy` zips and uploads itself.

### Job Finished events (v1)

The account's **default** EventBridge bus receives `source: updraft.cloud` and
`detail-type: Job Finished` when a tenant job summary first moves to `finished`. Consumers in the
account subscribe with a rule on the default bus matching that source and detail type, so they
need no bus name, SSM lookup, or deploy order. `JobFinishedPublisherFunction` reads the table stream
(filtered to that transition) and puts the events. The infrastructure is always deployed and
has no deploy flag.

Publishing is per tenant and off by default. After the installation opts in, a platform admin
turns it on with `PUT /api/v1/admin/tenants/<installation-id>/job-finished-events` and
`{"enabled":true}`. Use `{"enabled":false}` to stop publishing new events.

Payloads include `schemaVersion: 1`, the stack, tenant and job IDs, repository,
timestamps, status and outcome, and available verification, PR, step, routing and usage
metadata. They exclude log contents and trace payloads. Changes within v1 are additive.
Consumers should deduplicate delivery attempts using `stack`, `tenantId` and `jobId`. A batch
retry can deliver an event twice, and several Updraft stacks in one account share the default
bus, told apart by `stack`. A later metadata update to an already finished job does not create
a finish event. The trigger reads the stream from `TRIM_HORIZON`. When the mapping is created or
replaced, it re-reads up to the last 24 hours, so a job that finished during the cutover is sent
rather than skipped. Expect duplicates at that point, which consumers deduplicate. Jobs older
than the stream's 24 hours are not sent.
Insights uses recorded response models while the source job summaries are retained for
30 days. After a summary expires, historical groups use the configured model from the
durable run history. Longer views can therefore include both attribution sources.

#### Recovering failed events

A batch that still fails after its retries (5, with the batch split in half each time) is
written to `JobEventsFailureBucket` (stack output `JobEventsFailureBucketName`) as a failure
record. Each record holds the full invocation payload, the stream records themselves, and is
kept for 90 days. The table stream keeps records for only 24 hours, so this bucket, not the
stream, is what makes a failure recoverable.

Two alarms watch the function's own metrics:

- `JobEventsPublishErrorsAlarm` (Lambda `Errors`) goes off as soon as a batch starts failing. A
  batch that recovers on retry needs nothing. Otherwise its failure record appears in the bucket.
- `JobEventsDestinationFailuresAlarm` (`DestinationDeliveryFailures`) means even the failure
  record could not be written. The batch is then lost once the stream trims it, so fix the cause
  within 24 hours; the mapping's retries will not bring it back.

To replay a failure record, after fixing the cause:

```sh
aws s3 cp "s3://$BUCKET/$KEY" record.json
jq -r '.payload' record.json > batch.json   # the original {"Records": [...]} batch
aws lambda invoke --function-name "$FUNCTION" --payload fileb://batch.json out.json > invoke.json
# Only if the replay succeeded: FunctionError is absent from the response.
jq -e 'has("FunctionError") | not' invoke.json && aws s3 rm "s3://$BUCKET/$KEY"
```

`$FUNCTION` is the stack output `JobFinishedPublisherFunctionName`. The function re-checks each
tenant's opt-in when it replays a record, and consumers deduplicate, so replaying a batch that
was partly published is safe. This procedure has not yet been exercised against a live failure.

### Mistral API pilot

The hosted job image packages Mistral Vibe. After the new image is active in Staging, add
`vibe` to the existing comma-separated `CLOUD_AGENTS` variable in the Staging GitHub environment
and run the Cloud deployment. A deployment without this variable keeps its stack settings.

1. Open the test installation's **Agent keys** and save a Mistral Studio API key.
2. Add **Mistral Vibe** to a pool used by a published workflow. Enter an API model ID
   such as `mistral-large-4-0` if your account has access, or use the default `mistral-medium-latest`.
3. Apply the start label to a fresh issue. Confirm a successful verification and PR, then
   compare the trace's input, output and cache tokens with Mistral Studio's usage.

Vibe uses the official Mistral API for hosted jobs. The sandbox receives the resolved
installation key and has a dedicated writable directory for its usage export. Updraft reads
numeric totals and removes the export and copied journals. An unpriced model can report zero
estimated cost. Mistral Studio records billed usage and applied credits.

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
- **Events:** Issues, Pull request, Pull request review, Issue comment and Pull request review comment (the last two carry mention commands, [docs/controls.md](../docs/controls.md)). Installation events always arrive. An App registered before mention commands needs Issue comment (and Pull request review comment) turned on by its owner.

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

**Agent keys** each get their own Secrets Manager secret, `updraft/tenants/<id>/agent-keys/<NAME>` (for `ANTHROPIC_API_KEY`, `CODEX_API_KEY` and `KIRO_API_KEY`), tagged with the installation id.
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
  - CI repair (`ci`, compiled to `repositories.R.ciFix`): with review on, a pull request the reviewer found ready is not done while its checks are pending or failing, and a failure the code can cause queues a revision (when the workflow revises) that counts against its revision rounds. A repository the editor adds to a reviewing workflow starts with it on; a repository already configured keeps what it has, so an explicit off stays off until someone ticks **Fix failing CI** in its settings. It takes optional `checks` (only these decide), `ignore` and `waitMinutes` (up to 120). A CI fix's job token also asks for Actions read, for the failed job's log, where the installation grants it; without it, the fix gets annotations and summaries.
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

5. The tenant is under its quotas. A slot that is taken (the tenant's concurrency, or the platform's) is not a refusal: the delivery waits in the admission queue and starts later on its own (see "Admission queue" below). Earlier queued work of the tenant goes first, so a delivery that finds work waiting queues behind it even if a slot is free that instant.

Each of these that fails answers 200 with why (`no_tenant`, `tenant_inactive`, `no_config`, `not_dispatched`, `jobs_off`, `kill_switch`, `duplicate`, `throttled`), and nothing is started. A queued delivery answers 202 (`queued`, with the job id it starts as). Otherwise the launcher:

- stores the event at `tenants/<id>/events/<delivery>/event.json`;
- records the job (`JOB#<jobId>`), pinning the repository, label, sender, config version and image version, its quota slots and the microVM time it reserves, plus the hash of a new job token;
- starts the microVM with a version 2 run-hook payload, which carries only the broker's name and the job's token;
- records the microVM's id on the job, the only microVM the broker will stop for it.

**Failures:** if storing or launching fails, the webhook answers 500 so the delivery can be redelivered. It releases the claim and the quota reservation so the redelivery isn't refused, and retires the job record so its token is never served. A job that ends without a clean success also releases the claim when it reports `finish`, so redelivering the webhook is how a failed job is retried. A success without a summary counts as unconfirmed.

`updraft run-event` in the microVM still makes the final decision, against GitHub and the same config. The launcher only makes sure no job starts that the config wouldn't allow.

### Admission queue

`server/src/jobs/queue.ts` and `queue-store.ts`. With the default of one job at a time, labeling a second issue while one runs used to start nothing and ask for the label to be applied again. Now the second issue (and a third, and a review, push or CI event of a pull request whose loop continues) is kept, acknowledged, and started automatically once a slot frees.

**Enqueue.** Where the launcher's reservation finds the tenant's or the platform's slots taken, or the tenant already has queued work, it stores the event (`tenants/<id>/events/queue/<jobId>/<delivery>.json`), then the entry, and only then answers the delivery (202 `queued`). A crash before that leaves GitHub showing a failed delivery, and its redelivery finds the entry. Nothing is reserved or counted while an entry waits: no slot, no day's job, no microVM time. Usage counts at admission, in the UTC day and month of the admission.

| Key | What |
| --- | --- |
| `TENANT#<id>` / `QUEUE#<jobId>` | The entry: the event's delivery, kind and stored body, the issue or pull request, the trigger label and sender, the config version active at enqueue, the execution route (API key or subscription worker), why it waits, its state, attempts and acknowledgement comment. Kept 30 days past its end. |
| `TENANT#<id>` / `QSUBJ#<repositoryId>#<i\|p><n>` | The issue's or pull request's waiting entry: at most one. |
| `TENANT#<id>` / `QUEUEDEPTH` | How many of the tenant's entries wait. |
| `PLATFORM#QUEUE` / `<enqueuedAt>#<id>#<jobId>` | A waiting entry, oldest first: what the dispatcher reads. |

The enqueue and the end of an entry are each one transaction over all four, so the depth never drifts and a subject never has two waiting entries. Every other change is a versioned write of the entry.

**Policy.**

- **One entry per issue or pull request.** A redelivery or a relabel of queued work joins it (listed `deduped`, reason `already_queued`; no second comment). A later event of a queued pull request replaces the queued event, so the newest one is run; a queued close is never replaced. While an entry is being admitted, a pull request's new event is not acknowledged (503, `QueueBusy`): redeliver it.
- **FIFO within a tenant, round robin across tenants.** Each dispatch run takes the oldest waiting entry of each tenant in turn, one per tenant per round, so a tenant whose slot is still taken never holds up another, and a long line never starves a short one. A tenant's later entries wait behind its head (no priority for continuations, no dependency ordering yet). Entries enqueued in the same millisecond have no defined order between them.
- **Bounded.** At most `QUEUE_MAX_PER_TENANT` (25) waiting entries per tenant. Past it, the delivery is throttled (`queue_full`) with the usual once-a-day comment. An entry not admitted within `QUEUE_EXPIRY_MS` (72 hours) expires.
- **Capacity waits, budgets refuse.** Only concurrency is waited out. A delivery over the day's jobs or the month's minutes is throttled as before, and queued work that meets a budget at admission is refused: nothing runs by surprise when a budget resets. Missing keys, an inactive tenant, no config, dispatch rules that no longer match, and a changed execution route refuse the entry, each with its own reason. The kill switch and a missing job image hold everything (the run does nothing; expiry still applies).
- **Snapshot and current policy.** The execution route is the one chosen at enqueue: if subscription mode is turned on or off, or the worker changes, the entry is refused (`route_changed`) rather than moved to API keys or back. Everything else (dispatch rules, keys, quotas, pauses) is checked as it is at admission, since admission goes through the launcher like a fresh delivery.
- **Revalidated on GitHub.** Before admission, with a read-only token for that one repository: an issue must be open and still carry its trigger label; a pull request must be open (a close needs nothing), and for a push or a check suite its head must still be the one the event was about (`stale_head` otherwise: the newer head's events continue the loop). An `issues.unlabeled` or `issues.closed` event cancels the issue's queued work at once. A stop's pause (#142) cancels queued work of that workflow (`workflow_paused`).

**Dispatch.** `WebhookFunction` runs the dispatcher on the table stream (`QueueWake`: a concurrency slot deleted, which is a release, or work queued) and every minute (`DispatchQueue`), which catches a lost wakeup, a dispatcher that died, expiries and backoff. Before anything else, each due entry's tenant and the platform are checked for a free slot (a read of the held slots against the quotas): a full tenant is skipped without a lease, a GitHub call or a launch, so full tenants at the front of the line cost almost nothing and never hold up a tenant with room. Otherwise the entry is taken under a 60-second lease (`admitting`), checked on GitHub, then launched through the launcher under its own job id, with `RunMicrovm`'s idempotency token being that id. Slots are taken only by the launcher's atomic reservation, so nothing is overbooked. Capacity gone again by then puts the entry back at its place. A job record from an earlier attempt always wins: an ambiguous launch answer, or a dispatcher that died after the job was recorded, never leads to a second launch. A failed attempt (GitHub or S3 unreachable, a launch error) is retried with backoff (30 seconds, doubling, at most 15 minutes) and refused after 8. Waiting is never a failed attempt: capacity gone again, the kill switch, an offline subscription worker, another job of the pull request starting, or the entry's own delivery claim still held (the enqueuing launch releases it as soon as the entry is written, before its comment) give the attempt back; expiry alone bounds them. A wait that can last (an offline subscription worker, the kill switch) backs off like a failure without being one: 30 seconds, doubling to 15 minutes.

**States.** `queued`, `admitting`, then one end: `admitted` (a job started under the entry's id, or the subscription's sign-in wait took it over), `canceled` (label removed, issue or pull request closed, stale head, paused, canceled by an owner), `refused` (a budget, keys, config or route: with what to change), `expired`.

**On GitHub.** With a repository's `notifications: quiet` (the default) the acknowledgement is the first stage of the issue's one live status comment, which the run takes over at assignment (the queue makes no `Started` edit, and reads the comment before any later edit so it never writes over the run); a queued pull request event posts nothing, and refused or expired work also gets one separate comment saying what to do ([assignment-comments.md](../docs/assignment-comments.md#queued-work-updraft-cloud)). With `verbose`, and for entries queued before the setting existed: one acknowledgement per queued job, the App's own comment, posted with a token for that one repository (issues, and a pull request's conversation), with a hidden marker (`<!-- updraft-queue: <jobId> -->`) that is searched for before any new post:

> Updraft queued this issue. Your account's current execution slot is occupied. Work will start automatically when capacity is available. No action is needed.
>
> **Status:** Queued · Waiting for capacity
>
> **Job:** [View in Updraft](https://updraft.readysetcloud.io/installations/123/jobs/job_example)

It names no agent and gives no time. Its id is recorded on the entry even when another writer changed the entry meanwhile, and a comment whose id was never recorded is found again by its marker. A comment written while the entry moved on (an admission landing while the acknowledgement was being posted) is edited to the entry's state at once. A start recorded on the workflow before the queued wait is never undone by it. It is edited in place when the work starts (`Started · queued for 12 minutes`; the run's own assignment comment follows for an implementation run), is canceled, refused or expires (with why and what to do). An acknowledgement whose post failed is posted by the dispatcher a minute later.

**In the console.** Queued jobs are listed first on the installation page, in the order they start, with their place in line, how long they have waited and why; never as running or throttled. A job's link works from its acknowledgement on: the job page shows the queue entry before it starts, and how long it waited once it has. The workflow waits in stage `queued`, and its timeline has the wait, then the start. Work queued while the workflow's latest job has not finished (it runs, as when CI finishes on its own pull request, or it waits for a Claude sign-in, or is queued itself) is only pending (`pendingJobId`): the running job stays the workflow's latest, and its finish decides the state; a pending job that never starts is history. Work coalesced into another job of its pull request moves the workflow on to that job. An owner can cancel queued work (`POST /api/v1/installations/<id>/jobs/<jobId>/cancel`); work already being admitted is stopped from its page instead. `GET /api/v1/installations/<id>/queue` lists entries, waiting and ended.

**Runbook.** Each dispatch run logs one Embedded Metric Format line (`"queueDispatch":"schedule"` or `"wake"`), as metrics in `Updraft/Queue`: `Runs`, `Waiting`, `OldestWaitSeconds`, `Admitted`, `Ended`, `Deferred`, `TenantsAtCapacity`, `PlatformAtCapacity` and `DispatchFailures`. Signs to watch:

- **Not running:** no `Runs` with `schedule` in 5 minutes: check the `DispatchQueue` schedule and `WebhookFunction`'s errors.
- **Stuck:** `OldestWaitSeconds` growing while `TenantsAtCapacity` and `PlatformAtCapacity` are zero means entries are deferred, not waiting for capacity: find the `queue dispatch failed` and `queued launch failed` log lines (they name the installation and the job).
- **At capacity:** `PlatformAtCapacity` at 1 for long is the platform ceiling (`PlatformConcurrentJobs`), not a fault.

To look at one entry, read `TENANT#<installationId>` / `QUEUE#<jobId>`. To hold all dispatch, engage the kill switch. To drop an entry by hand, cancel it from the console (it frees its place and edits its comment); never delete its items one by one.

### Workflow reconciliation runbook

Every run of `WebhookFunction`'s `ReconcileWorkflows` schedule logs one Embedded Metric Format line (`"workflowReconcile":true`). CloudWatch turns it into metrics in the `Updraft/Workflows` namespace:

- **Run outcome:** `Runs`, `Checked`, `Repaired`, `Recovered` (recoveries that started or queued a job), `Blocked`, `Finished` and `Failed`.
- **Backlog:** `Backlog`, and `OldestDueSeconds`, how long the oldest workflow due a look has waited.
- **Label scan:** `LabelTenants` and `LabelMissed`.

There are no alarms on them yet. These are the signs to watch for:

- **Not running:** no `Runs` in 15 minutes. Check the schedule is enabled, and that `WebhookFunction` is not throttled or failing at start (its `Errors` metric and log group). A run that throws before it logs its metrics counts as not running.
- **Failing:** `Failed` above zero for several runs in a row. Find the `workflow reconciliation failed` and `label scan failed` log lines: they name the installation and the workflow. GitHub errors (a revoked installation, rate limits) clear on their own. A failing workflow is looked at again 15 minutes later, and a failing tenant's scan an hour later, so one cannot hold up the rest.
- **Behind:** `OldestDueSeconds` over 30 minutes. Each run looks at 25 workflows, so a growing `Backlog` means more are due than that: raise `limit` in `webhook-lambda.ts`, or the schedule's rate. A steady `OldestDueSeconds` with a small backlog points at one workflow that fails every time.

**Blocked workflows:** these are not alarms; they are for the tenant. The workflow's page says why and what to do: retry the job, sign in, re-run a stuck check, apply the label again, or act on the pull request.

**Recovery:** each action logs one line with `recovery` (`missed_check_event` or `lost_job`), its `key`, try and result, and the workflow's `recovery` field holds the latest action, its tries and what it came to. A steady `Recovered` well above zero means events are being missed: look at the App's webhook deliveries on GitHub. To keep recovery from starting anything, engage the kill switch.

To look at one workflow, read `TENANT#<installationId>` / `WORKFLOW#<workflowId>` and its `WFEV#<workflowId>#…` events. A workflow due a look has `nextCheckAt`, and an entry under `PLATFORM#WORKFLOW-DUE`. To stop the reconciler from acting at all, engage the kill switch: it also stops launches.

### Pull request events

A job for a labeled issue runs the whole review loop it can in its microVM: the pull request, Updraft's own review, and revisions up to `maxRevisions`. What people do to that pull request afterwards starts further jobs, the same way as in the self-hosted stack ([deploy/aws-microvm/README.md](../deploy/aws-microvm/README.md#the-review-loop)). The launcher takes:

| Event | Actions | Needs |
| --- | --- | --- |
| `pull_request_review` | `submitted`, `edited`, `dismissed` | revisions on for the repository; not a comment review (only "Request changes" starts a revision; an approval or a dismissal can cancel one); a reviewer who is an allowed actor |
| `pull_request` | `synchronize` | review on for the repository; a pusher who is an allowed actor |
| `pull_request` | `closed` | review or revisions on; anyone (it ends the loop) |
| `check_suite` | `completed` | review and `ciFix` on for the repository; the suite's pull request on an Updraft branch; anyone, the App included (a suite's sender is whoever pushed). See [CI in the review loop](../docs/ci-fix.md) |

Every one of them also needs the repository in the active version (name and id), not paused, a pull request on an Updraft branch (`updraft/`), and, except for a check suite, a sender other than the App itself (`<slug>[bot]`): its reviewer's comment reviews and its revision pushes are handled by the job that made them. **Keys.** The event names no label, so the launcher finds the workflow that started the pull request: the job that opened it (its finish recorded that pull request), or an earlier job of the same pull request's loop, which carries the label on. It matches the pull request, never just its issue, since one issue can have pull requests from different workflows. Only when that job ran the version that is active now: then the keys checked are the ones it was started with (two workflows can share a label for different actors, and the label alone doesn't say which ran), or, once its record is gone (it's kept a week past its run), the label's keys if the label names one workflow's. After a republish nothing here names the workflow for sure (its agent may have changed, or its label moved to another workflow), so the job checks for itself: the runner follows the workflow stored for the pull request. Only that workflow's keys are checked, so a Codex workflow without its key doesn't hold up a Claude workflow's pull request. A close runs no agent and needs no key. When no kept job (30 days) opened or worked on the pull request, nothing names the workflow, and the job checks for itself: `run-event` fails without the key and says so on the job. A version published before this records no review loop in its dispatch rules, so its pull request events start nothing (`loop_off`) until it's published again. Any other action (`opened`, `reopened`, ...) is listed as `event_not_accepted`.

**Coalescing.** The first accepted event for a pull request claims it for 20 seconds (`pr-<repository id>-<number>`, a delivery claim with that expiry), and its job starts its run only after that (`notBefore` in the run-hook payload). Another event for the pull request within those seconds starts nothing and is listed as `coalesced`: the one job reads the pull request as GitHub has it then, so it sees every event folded into it. GitHub often sends a review and the push before it close together, and two jobs would each find the same review and run an agent on the same branch. Issues are never coalesced.
- **Only once the covering job is launched.** An event that finds the claim taken waits (up to 8 seconds) for the job holding it to have its microVM recorded before it answers `coalesced`. A launch that fails or is throttled gives the claim back, and a waiting event then takes it and launches its own job, so no event is acknowledged for a job that never ran.
- **Not confirmed in time:** the event answers 503 (`coalesce_unconfirmed`, listed as a failed launch), so GitHub shows the delivery failed and it can be redelivered.

**Quotas** count these jobs like any other. A pull request event that finds the account busy is queued like an issue (see "Admission queue"). Over a budget, the comment goes on the pull request ("submit the review again or push a commit"), once a day per pull request.

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
- **Concurrency is waited for, not refused.** A delivery that finds the tenant's or the platform's slots taken waits in the admission queue (above), with nothing counted while it waits.
- **Over a budget** (the day's jobs, the month's minutes) or past the queue's bound, the delivery is recorded as throttled in the month's usage, and its claim is given up. The issue gets one comment a day saying which quota stopped it and how to try again: remove the label and add it back. The comment is posted with an installation token for that one repository, allowed only to write issues.

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
4. creates or updates the `<stack>-job` MicroVM image, with `additionalOsCapabilities: ["ALL"]`, and waits for the build;
5. runs one microVM from the new version to check isolation (`server/scripts/job-image-check.ts`), and stops if the check fails;
6. writes the version to `/updraft/<stack>/job-image-version`.

**The isolation check** is why a version that builds can still be refused. A `SUCCESSFUL` build only means the image answered its `/ready` hook. It says nothing about whether a job's boundary holds on that version. So the build starts a microVM from it with the jobs' execution role and an image-check run-hook payload (version 3). That payload names no tenant, broker or job token. The runner installs the packet filter and runs the same sandbox self-test a job runs, with stand-in files in a job-shaped state directory. It logs one `ISOLATION CHECK {...}` line and starts nothing else. The build reads that line from the `isolation-check/<version>/<stamp>` log stream, then terminates the microVM; a 15-minute maximum duration also covers a build that dies first. Only a passed check activates the version, so a failure leaves jobs on the version they had. The one job check this can't cover is the tenant's config: there is no tenant yet.

The check's microVM counts against the account's MicroVM quota like a job's for a few minutes. It doesn't count against any tenant's quota.

**Until that parameter exists, the launcher starts no jobs (`jobs_off`).** It reads the parameter at most once a minute, so a new build, or setting the parameter back to an earlier version, takes effect without a deploy.

**CI builds it.** The deploy workflow has an `image` job that runs after the stack deploy. Each version records in its description a fingerprint of what it was built from (`server/scripts/job-image-inputs.ts`):
- `deploy/aws-microvm/image/`;
- the build script and its helpers;
- `src/config/` and `src/agents/`, because the server validates tenant configs with them (validation checks agent profiles and adapters) and the image's CLI runs them;
- the root `package.json` and `package-lock.json`.

The job builds only when the active version's fingerprint differs from the checkout's (`build-job-image --check`), or when a manual Production run sets `build_image`. Comparing with the active version, not with the previous commit, also covers an environment with no image yet, an earlier build that failed, and a Staging stack whose image another pull request built.

A change to the rest of the CLI (`src/`) reaches jobs only with the next image built for one of those reasons, or a `build_image` run. Production activates a new build within a minute. To roll back, set the parameter to the previous version (`aws lambda-microvms list-microvm-image-versions --image-identifier updraft-cloud-job` lists them).

**The deploy role needs these permissions** for the `image` job, in each account (Staging and Production), on top of what the stack deploy uses. The isolation check needs the `RunMicrovm`, `GetMicrovm` and `TerminateMicrovm` statement, `iam:PassRole` on the execution role and `logs:GetLogEvents`. The launcher's own role scopes `RunMicrovm` the same way, to the image's ARN. An image holds a limited number of versions, so each build first deletes the oldest beyond the newest five (never the active one, and never one still in use); `lambda:ListMicrovmImageVersions` and `lambda:DeleteMicrovmImageVersion` are for that. Without them the build says so and carries on, and fails only once the image is full. A role without the rest fails the build before it activates anything. `<account>` is that account's id. `lambda:CreateMicrovmImage` and `lambda:PassNetworkConnector` have no resource type in IAM, so they take `"Resource": "*"`. Creating is limited instead to an image tagged with this stack, which is how the build creates it:

```json
[
  { "Effect": "Allow", "Action": ["lambda:GetMicrovmImage", "lambda:UpdateMicrovmImage", "lambda:GetMicrovmImageVersion", "lambda:ListMicrovmImageVersions", "lambda:DeleteMicrovmImageVersion", "lambda:TagResource"],
    "Resource": "arn:aws:lambda:us-east-1:<account>:microvm-image:updraft-cloud-job*" },
  { "Effect": "Allow", "Action": "lambda:CreateMicrovmImage", "Resource": "*",
    "Condition": { "StringEquals": { "aws:RequestTag/updraft:stack": "updraft-cloud" } } },
  { "Effect": "Allow", "Action": "lambda:PassNetworkConnector", "Resource": "*" },
  { "Effect": "Allow", "Action": "iam:PassRole", "Resource": "arn:aws:iam::<account>:role/updraft-cloud-MicrovmBuildRole-*",
    "Condition": { "StringEquals": { "iam:PassedToService": "lambda.amazonaws.com" } } },
  { "Effect": "Allow", "Action": ["lambda:RunMicrovm", "lambda:GetMicrovm", "lambda:TerminateMicrovm"],
    "Resource": "arn:aws:lambda:us-east-1:<account>:microvm-image:updraft-cloud-job" },
  { "Effect": "Allow", "Action": "iam:PassRole", "Resource": "arn:aws:iam::<account>:role/updraft-cloud-MicrovmExecutionRole-*",
    "Condition": { "StringEquals": { "iam:PassedToService": "lambda.amazonaws.com" } } },
  { "Effect": "Allow", "Action": "logs:GetLogEvents",
    "Resource": "arn:aws:logs:us-east-1:<account>:log-group:/aws/lambda-microvms/updraft-cloud-job:log-stream:isolation-check/*" },
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

Not run on AWS yet: the job path end to end, pull request events included. That covers:
- building the job image with `build-job-image`;
- `RunMicrovm` from the launcher, with the Lambda-provided connectors;
- the runner's broker calls, from a microVM under the execution role;
- a labeled issue producing a pull request;
- a person's "Request changes" review producing a revision, and coalescing against real GitHub event timing;
- the quota transactions against DynamoDB itself, and the over-quota comment on a real issue;
- publishing from the console against the real bucket and table, with the API function's narrowed S3 permissions.

Deliberately off:
- **API Gateway access and execution logging.** Both need the account-level API Gateway CloudWatch role, which this stack does not own.
- **Point-in-time recovery on `UpdraftTable`.** This is a decision, not a gap.
