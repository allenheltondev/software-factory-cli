# Running one event: `updraft run-event`

`updraft start` is a worker that stays up: it polls GitHub, queues jobs and runs them.
`updraft run-event` is the same work for exactly one GitHub webhook event. It takes the payload
GitHub delivered, carries it through to the end (agent, verification, pull request) and exits.
Nothing polls and nothing waits for more work.

It is for places where a machine exists per event: a launcher receives the webhook of a GitHub
App, starts a fresh machine, and that machine runs this command once. It needs no clone prepared
in advance and no state from an earlier run.

```
updraft run-event --event-file <path> [--event-name issues] [--delivery-id <id>] [--json]
                  [--deadline-minutes <n>] [--worker-git-credentials]
```

| Option | Meaning |
| --- | --- |
| `--event-file <path>` | Required. A file holding the webhook payload: the JSON body GitHub POSTs, unchanged |
| `--event-name <name>` | The delivery's `X-GitHub-Event` header. Default `issues` |
| `--delivery-id <id>` | The delivery's `X-GitHub-Delivery` header. Only written to the logs and the summary; it decides nothing |
| `--json` | Print one JSON object on stdout when the command ends (see [The summary](#the-summary)) |
| `--deadline-minutes <n>` | Stop everything, a running agent included, after this long. Default: no limit of its own; the action's `timeoutMinutes` and `verifyTimeoutMinutes` bound the agent and the verification |
| `--worker-git-credentials` | Fetch with the worker's GitHub credentials even into a clone this command did not create (see [The clone](#the-clone)) |

`-c, --config <path>`, `UPDRAFT_CONFIG` and `UPDRAFT_HOME` work as for every command.

## What the caller provides

- **A config** with `execution.mode: live`. Any other mode is an error: this command exists to
  start an agent. The repository is configured as for `updraft start` (its numeric `id`, a
  workflow with the trigger label, `dispatch.allowedActors`, usually `publish`).
  `repositories.<repo>.checkoutPath` is still required, but the directory need not exist.
- **Credentials for GitHub**, as for the worker: `GH_TOKEN` / `GITHUB_TOKEN` (or a `gh` sign-in),
  or a GitHub App (`github.app`, with its private key file; see [github-app.md](github-app.md)).
  The same credentials serve the API, the fetch and the push.
- **The agent**: its CLI installed and signed in, as `updraft doctor` checks it.
- **An empty state directory** of its own. The command creates the database, logs, clone and
  worktree it needs. Do not point it at the state directory of a running `updraft start`: that
  worker holds the lock, and the command exits with code 3 (the job it queued is then that
  worker's to run). A state directory left by an earlier `run-event` works too.
- **The payload file**, and the event name when it is not `issues`.

## What it does

1. **Recognises the event.** Handled now: `issues` with `action: "labeled"`. Every other event
   name or action is "nothing to do". So is a payload for a pull request, for a repository whose
   id is not configured, or for a label that is not the trigger label of a workflow; those are
   settled from the payload without a request to GitHub.
2. **Applies the worker's dispatch rules, from the API.** The payload came through a launcher, so
   it decides nothing by itself: it only says which repository (by id), issue and label to look
   at. The label application is then found in the issue's events on GitHub, and the same code the
   poller uses decides whether it queues a job: the actor GitHub reports for the event must be an
   allowed actor, the issue must be open, must not be a pull request and must still carry the
   label, the label must not have been removed again since, and the pool is routed from the
   issue's current labels.
3. **Checks whether the event was already handled** (see [Idempotency](#idempotency)).
4. **Makes the repository available** (see [The clone](#the-clone)).
5. **Runs the one job through the worker**, in a mode that drains the queue and stops: the
   pre-start check (which in live mode cancels the job when the label application is no longer
   the current one, its actor is no longer allowed, or the issue's title or body was edited since
   by someone who is not allowed), the live executor, the action's `verify` commands, publication
   and, for a failed job, the failure comment. Everything in [live-execution.md](live-execution.md),
   [verification.md](verification.md), [publication.md](publication.md) and
   [failure-comments.md](failure-comments.md) applies unchanged.
6. **Prints the summary and exits.**

A publication or failure comment that fails for a passing reason (GitHub unavailable, a rate
limit) is retried when it comes due, as the worker does, but only while that is within five
minutes of the job ending. A retry scheduled for later is left: the summary reports the failure,
and the state directory, if kept, can finish it with `updraft publish RUN_ID`.

The agent never receives the worker's GitHub credentials, here as elsewhere.

Not acted on by this command: `repositories.<repo>.revise` and `review`. Those loops are driven by
polling pull requests; `updraft start` runs them.

### Finding the event

The rest of Updraft identifies a label application by the id of the issue's timeline event: it is
the job's dedupe key, and the pre-start check compares it with the issue's newest application of
the label. A webhook payload does not carry that id.

The command reads the issue's events from the API and takes the `labeled` event with the
payload's label, by the payload's sender, created at the payload's time (`issue.updated_at`; not
more than a minute before it, and of several the nearest). The event's id, actor and time are then
GitHub's, and all later checks run on them. If the events do not show the application yet, they
are read again a few times, a few seconds apart. If it never shows up, the command fails (exit
code 1) rather than treat the event as handled: a redelivery can try again.

A payload naming a sender who did not apply the label therefore matches nothing, and a payload
for an older application of the label is judged as that application (superseded, so nothing to
do), not as the current one.

## The clone

Where `checkoutPath` is missing or an empty directory, the command creates the clone there: an
empty repository with `origin` set to `https://github.com/OWNER/REPO.git`. The run's own
preparation then fetches the one branch it builds on (`baseBranch`, or the remote's default
branch), with its whole history and without tags, and makes the job's worktree from it.

The clone is neither shallow nor partial, on purpose:

- Publication pushes from a temporary repository that borrows the clone's objects. If the base
  branch moved while the agent worked, Git has to walk the history below the commit the job
  branch started from, and a shallow clone does not have it. The push would fail exactly on busy
  repositories.
- A partial clone fetches missing file contents when a command needs them. The agent works in a
  worktree of the clone without credentials, so its `git log -p` or `git diff` could fail.

Fetches into a clone the command created use the **worker's** credentials: the `gh` account's
token or the GitHub App's installation token. The token reaches Git the way it does for a push:
as an `Authorization` header scoped to `https://github.com/`, in `GIT_CONFIG_*` environment
variables of the worker's own Git process, with hooks disabled for that process. It is never in a
command line, a URL, the clone's config or any other file, and it is removed from anything Git
reports before that is logged. The agent's environment is built separately and does not contain
it. A remote that is not `https://github.com/...` (SSH, a host alias) gets no token.

Where `checkoutPath` is already a clone, it is used exactly as `updraft start` uses it: nothing
in it is changed, and fetches use that machine's own Git credentials. `--worker-git-credentials`
makes the fetches of such a clone use the worker's credentials instead.

## The summary

With `--json`, stdout carries exactly one line: a JSON object. It is printed whatever happened,
including when the command itself failed. The one exception is a command line the argument parser
rejects (an unknown option, no `--event-file`): that prints usage on stderr and exits 1. Logs go to stderr and to `updraft.log`; each run also
has its `run.log`. Without `--json`, stdout carries one line for a person instead.

```json
{
  "event": {
    "name": "issues", "action": "labeled", "deliveryId": "d0c0…",
    "repository": "octo/widgets", "repositoryId": 42, "issue": 7,
    "label": "updraft:ready", "sender": "allen", "eventId": "9001"
  },
  "dispatched": true,
  "outcome": "succeeded",
  "reason": null,
  "message": "job job_ev9001x3f0c1d2e4a succeeded: https://github.com/octo/widgets/pull/100",
  "jobId": "job_ev9001x3f0c1d2e4a",
  "workflowId": "wf",
  "status": "succeeded",
  "runId": "run_0mb2x…",
  "agent": "claude",
  "runOutcome": "succeeded",
  "error": null,
  "branch": "updraft/issue-7-job_ev9001x3f0c1d2e4a",
  "baseSha": "…", "headSha": "…", "commitCount": 1,
  "verification": { "passed": true, "commands": [{ "command": "npm test", "status": "passed" }] },
  "publication": "published",
  "publicationError": null,
  "prNumber": 100,
  "prUrl": "https://github.com/octo/widgets/pull/100",
  "failureCommentUrl": null,
  "logPath": "…/logs/runs/run_0mb2x…/run.log",
  "drain": "idle",
  "exitCode": 0
}
```

| Field | Meaning |
| --- | --- |
| `event` | What the delivery was about, as far as the payload could be read. `repository`, `sender` and the rest are the payload's; `eventId` is the timeline event's id from the API (null until it was found) |
| `dispatched` | True when a job was queued for the event in this run |
| `outcome` | `nothing-to-do`, `succeeded`, `canceled` (queued, then canceled by the pre-start check before any agent started), `superseded` (see [Idempotency](#idempotency)), `failed` (the agent run failed, could not start or was interrupted), `publish-failed` (the run succeeded, its publication did not), `not-started` (the job was still queued when the command ended) or `error` (the command itself failed: config, GitHub, the event file) |
| `reason` | Why nothing was done, as a code; null otherwise. From the payload: `unsupported-event`, `unsupported-action`, `malformed-payload`, `pull-request`, `repository-not-configured`, `label-not-configured`. From the API: `actor-not-allowed`, `label-removed`, `label-missing`, `issue-closed`, `issue-gone`, `pull-request`. Others: `already-handled`, `duplicate-delivery` (this state directory already has the event's job), `canceled-before-start`, `published-by-another-run` |
| `message` | One line saying the same to a person |
| `jobId`, `workflowId`, `status` | The job and its final status in the queue |
| `runId`, `agent`, `runOutcome`, `logPath` | The job's last run; `runOutcome` is null when no agent run ended |
| `error` | The worker's own reason when the job did not succeed or was not published |
| `branch`, `baseSha`, `headSha`, `commitCount` | What the run left |
| `verification` | `passed` and each command's status; null when the action has no `verify` or it did not run |
| `publication`, `publicationError`, `prNumber`, `prUrl` | The publication's state (`published`, `skipped` when there were no commits, `failed`), or null when `publish` is off or nothing was attempted |
| `failureCommentUrl` | The comment posted for a failed job (`commentOnFailure`) |
| `drain` | How the worker stopped: `idle`, `retries-abandoned`, `stalled`, `deadline`, `stopped` (a signal); null when it never started |
| `jobs` | Present only when several workflows share the trigger label, so the event has several jobs: each job's fields. The top-level fields then describe the first |
| `exitCode` | The process's exit code |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Nothing to do; or the job succeeded (and was published, where `publish` is on); or the job was canceled before an agent started; or another run of the same event published first |
| 1 | The job failed, was not published, or never started; or the command failed (invalid config, a mode other than `live`, GitHub unreachable, the event could not be matched) |
| 2 | The event file is missing or not JSON, or `--deadline-minutes` is not a positive number |
| 3 | Another worker holds the lock of this state directory |

On SIGINT or SIGTERM the command stops the agent and exits 1, with the job `interrupted`.

## Idempotency

GitHub redelivers webhooks, and a launcher can start two machines for one delivery. Each has its
own empty state directory, so the local database cannot tell them apart. GitHub is the only
state they share, and it is what decides.

- **The job id is derived from the event**: repository id, workflow id and the timeline event's
  id. The job branch is named after the job id (`updraft/issue-<n>-<job id>`), so every run of
  one event works on the same branch name, wherever it runs.
- **Before anything is queued**, the command asks GitHub whether that branch already has a pull
  request (in any state: a merged pull request counts, also after its branch was deleted) or
  exists on the remote. If so, there is nothing to do: `reason: "already-handled"`, exit code 0,
  no clone fetched and no agent started.
- **Publication creates and never moves.** The push only creates the branch; Git refuses it if
  the branch appeared meanwhile. A pull request is opened only when none exists for the branch.

What remains:

- **Two runs that start at the same moment both run the agent.** Neither sees a branch yet. Only
  one can publish: the other's push is refused, nothing on GitHub is changed by it, and it ends
  with `outcome: "superseded"`, `reason: "published-by-another-run"` and exit code 0. The cost
  is one agent run. The window is the length of an agent run, from the first run's check to its
  push.
- **A run that pushed its branch and died before opening the pull request** leaves a branch
  without a pull request. Later runs of the event see the branch and do nothing. Delete the
  branch on GitHub and redeliver the event to run it again (or keep the state directory and run
  `updraft publish RUN_ID`).
- **A failed job leaves nothing on GitHub that marks the event as handled**, so a redelivery
  runs it again. That is usually what a redelivery is for, but each failed run posts its own
  failure comment where `commentOnFailure` is on.
- A new application of the label (remove it, apply it again) is a new event with a new id and a
  new branch, as for the long-running worker.
