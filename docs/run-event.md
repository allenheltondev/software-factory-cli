# Running one event: `updraft run-event`

`updraft start` is a worker that stays up: it polls GitHub, queues jobs and runs them.
`updraft run-event` is the same work for exactly one GitHub webhook event. It takes the payload
GitHub delivered, carries it through to the end (agent, verification, pull request, and where
they are configured the review, the revision and the merge) and exits. Nothing polls and nothing
waits for more work.

It is for places where a machine exists per event: a launcher receives the webhook of a GitHub
App, starts a fresh machine, and that machine runs this command once. It needs no clone prepared
in advance. It works with an empty state directory, and better with a state database that is
shared between the runs ([Shared state](#shared-state)).

```
updraft run-event --event-file <path> [--event-name issues] [--delivery-id <id>] [--json]
                  [--deadline-minutes <n>] [--worker-git-credentials] [--retry] [--shared-state <file>]
```

| Option | Meaning |
| --- | --- |
| `--event-file <path>` | Required. A file holding the webhook payload: the JSON body GitHub POSTs, unchanged |
| `--event-name <name>` | The delivery's `X-GitHub-Event` header. Default `issues` |
| `--delivery-id <id>` | The delivery's `X-GitHub-Delivery` header. Only written to the logs and the summary; it decides nothing |
| `--json` | Print one JSON object on stdout when the command ends (see [The summary](#the-summary)) |
| `--deadline-minutes <n>` | Stop everything, a running agent included, after this long. Default: no limit of its own; the action's `timeoutMinutes` and `verifyTimeoutMinutes` bound each agent and verification, and `autoMergeWaitMinutes` the wait for checks |
| `--worker-git-credentials` | Fetch with the worker's GitHub credentials even into a clone this command did not create (see [The clone](#the-clone)) |
| `--retry` | First requeue the event's jobs that failed, were interrupted or canceled, as `updraft retry` does, so this run does them again instead of ending as a `duplicate-delivery` (see [Idempotency](#idempotency)). A job that succeeded, or that was held for a human, is left as it is. For a launcher that retries from a console, on the state database it holds |
| `--shared-state <file>` | A copy of the shared state database that the caller keeps fresher than the one this run started from. Read, never written, during [the last look](#the-last-look). A file that is missing, unreadable or at another schema version is logged and otherwise ignored |

`-c, --config <path>`, `UPDRAFT_CONFIG` and `UPDRAFT_HOME` work as for every command.

## Events

| `--event-name` | `action` | What it sets off |
| --- | --- | --- |
| `issues` | `labeled` | The workflow's job for the issue, if the poller's dispatch rules would queue one |
| `pull_request_review` | `submitted`, `edited`, `dismissed` | The review loop's look at that pull request: a change request by an allowed actor queues a revision |
| `pull_request` | `synchronize`, `closed` | The same look: a new head commit gets its reviewer run; a closed or merged pull request stops being watched and its queued work is canceled |
| `check_suite`, `check_run` | `completed` | With `ciFix`: the same look, and the [CI step](ci-fix.md) for the pull request the payload lists: checks that failed on its ready head queue a revision, passed checks mark it ready. Checks still pending start nothing and keep nothing running |
| `status` | (none) | The same, for the watched pull request whose head is the payload's commit |

Every other event name or action is "nothing to do", decided from the payload alone. That
includes `pull_request.reopened`: a closed pull request is no longer watched, for good, so a
reopen has nothing to set off, and a launcher need not start a machine for one.

## What the caller provides

- **A config** with `execution.mode: live`. Any other mode is an error: this command exists to
  start an agent. The repository is configured as for `updraft start` (its numeric `id`, a
  workflow with the trigger label, `dispatch.allowedActors`, usually `publish`, and `revise`,
  `review`, `autoMerge` as wanted). `repositories.<repo>.checkoutPath` is still required, but
  the directory need not exist.
- **Credentials for GitHub**, as for the worker: `GH_TOKEN` / `GITHUB_TOKEN` (or a `gh` sign-in),
  or a GitHub App (`github.app`, with its private key file; see [github-app.md](github-app.md)).
  The same credentials serve the API, the fetch and the push.
- **The agents**: each CLI installed and signed in, as `updraft doctor` checks it. With `review`,
  the pool that reviews needs an agent other than the one that wrote the code, as always.
- **A state directory of its own.** Empty, or holding a `state.db` that is a copy of the shared
  state database (see [Shared state](#shared-state)). The command creates the database, logs,
  clone and worktrees it needs. Do not point it at the state directory of a running
  `updraft start`: that worker holds the lock, and the command exits with code 3.
- **The payload file**, and the event name when it is not `issues`.

## What it does for `issues.labeled`

1. **Recognises the event.** A payload for a pull request, for a repository whose id is not
   configured, or for a label that is not the trigger label of a workflow is "nothing to do",
   settled from the payload without a request to GitHub.
2. **Applies the worker's dispatch rules, from the API.** The payload came through a launcher, so
   it decides nothing by itself: it only says which repository (by id), issue and label to look
   at. The label application is then found in the issue's events on GitHub, and the same code the
   poller uses decides whether it queues a job: the actor GitHub reports for the event must be an
   allowed actor, the issue must be open, must not be a pull request and must still carry the
   label, the label must not have been removed again since, and the pool is routed from the
   issue's current labels, tiers and triage ([tier-routing.md](tier-routing.md),
   [triage.md](triage.md); the triage cache and its hourly limit are in the state database).
3. **Checks whether the event was already handled** (see [Idempotency](#idempotency)): first in
   the state database, then on GitHub.
4. **Makes the repository available** (see [The clone](#the-clone)).
5. **Runs the job through the worker**, in a mode that works until the event's work is done and
   then stops. It is wired as `updraft start` wires it: the pre-start check (which in live mode
   cancels the job when the label application is no longer the current one, its actor is no
   longer allowed, or the issue's title or body was edited since by someone who is not allowed),
   the assignment comment, the live executor, capacity groups, cooldowns and escalation, the
   action's `verify` commands, publication, the review loop and, for a failed job, the failure
   comment. Everything in [live-execution.md](live-execution.md),
   [verification.md](verification.md), [publication.md](publication.md),
   [assignment-comments.md](assignment-comments.md),
   [capacity-and-escalation.md](capacity-and-escalation.md), [revisions.md](revisions.md),
   [review-loop.md](review-loop.md) and [failure-comments.md](failure-comments.md) applies.
6. **Prints the summary and exits.**

The agent never receives the worker's GitHub credentials, here as elsewhere.

### The review loop in one run

With `review` (and `revise`, `autoMerge`) on for the repository, the loop runs inside the same
process, one step queuing the next:

1. the code run is published as a pull request;
2. a reviewer job for its head commit is queued and run by another agent of the review pool;
3. a "changes requested" verdict queues a revision, which is pushed to the pull request, and the
   new head gets its reviewer job (up to `maxRevisions`);
4. a "ready to merge" verdict marks the draft ready for review;
5. with `autoMerge`, every gate of [review-loop.md](review-loop.md#auto-merge) is evaluated. A
   merge that waits for checks is asked about every 30 seconds, for up to
   `autoMergeWaitMinutes`; the command stays up for that. The merge request names the reviewed
   commit.

The command ends when none of this is left: no job of the event queued or running, no review
or push being made, no merge still waiting, and [the last look](#the-last-look) found nothing
new. `--deadline-minutes` cuts all of it short. The summary's `loop` field says where the pull
request ended up, and its `outcome` and exit code cover every job of this list, not only the
first ([What counts as success](#what-counts-as-success)).

What the long-running worker does "after each poll" (retrying a publication or comment that
failed for a passing reason, queuing reviewer jobs, the merge step, the comments that say why a
pull request was not merged or that it reached `maxRevisions`) happens every few seconds here.
A retry is waited for only while it is due within five minutes of the work running out; one
scheduled for later is left, and the summary's `drain` says `retries-abandoned`.

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

## What it does for a pull request event

`pull_request_review` and `pull_request` deliveries need [shared state](#shared-state): which
pull requests Updraft opened is only on record there.

1. **From the payload, only where to look:** the repository (by id) and the pull request number.
   Nothing else in the payload is used: not the review's state, not its author, not its text,
   not the head commit. A repository that is not configured, or that has neither `revise` nor
   `review` on, is "nothing to do".
2. **From the state database, whether it is one of ours.** One on record as closed is "nothing
   to do" (`pull-request-closed`), before any request to GitHub: closed is final, and reopening
   a pull request does not bring it back. One that is **not on record** is not yet "not ours":
   the run that opens a pull request saves its state later than GitHub shows the pull request.
   So GitHub is asked ([below](#a-pull-request-the-state-database-does-not-know)), and the
   answer is either "nothing to do" (`pull-request-not-watched`) or the outcome
   `state-pending` with exit code 6. Either way no clone is made and no agent starts.
3. **The review poller, for that pull request.** The same code `updraft start` runs after each
   poll (`src/poller/reviews.ts`) reads the pull request from the API, once, and applies every
   rule of [revisions.md](revisions.md) and [review-loop.md](review-loop.md): a review counts
   only if GitHub says an allowed actor wrote it and nobody else edited it; the review text the
   agent is given is the snapshot taken now from the API; a review already on record (by its id)
   is never acted on twice; `maxRevisions` holds; a head commit someone pushed gets its reviewer
   job; a closed or merged pull request stops being watched and its queued jobs are canceled.
   The repository's other pull requests are left to their own events.
4. **If that queued nothing and nothing is left over for the pull request:** "nothing to do"
   (`no-new-work`, or `pull-request-closed`).
5. **Otherwise the clone, and the same run-until-done as above,** for what is queued for that
   pull request. A revision that is pushed gets its reviewer run in the same process, and so on
   through the loop.

### A pull request the state database does not know

Asked of the GitHub API, never of the payload, with one read of the pull request and one of
the worker's identity. The pull request is one of Updraft's when all of this holds:

- it is open;
- its author is the worker's own identity (the `gh` account, or the App's `<slug>[bot]`);
- its head is a job branch (`updraft/issue-<n>-<job id>`) in this repository, not in a fork;
- its body carries the marker publication writes (`<!-- updraft-run: run_... -->`).

If not: `nothing-to-do`, `pull-request-not-watched`, exit code 0; the message says which
condition failed. A pull request of Updraft's that is closed or merged ends the same way:
nothing acts on a closed pull request, whoever knows of it.

If so, the event is real work that this run cannot do, because everything a revision or a
review needs (the job, the run, the publication) is in a state database it was not given. The
command ends with:

- `outcome: "state-pending"`, `reason: "state-pending"`, **exit code 6**, `prNumber` and
  `prUrl` set, and a `message` that says what to do;
- nothing written: no state database is created for it, nothing is recorded in an existing
  one, nothing is posted.

**What the caller does with exit code 6:** run the same event again, with a newer copy of the
shared state database, once that has changed. It is not "deferred" (exit code 4): nothing of
the event is queued anywhere, and nothing but the caller will retry it. If the state never
arrives, because the run that opened the pull request died before saving anything, deliver
the pull request's `issues.labeled` event again:
[that restores the publication](#restoring-lost-state), and the pull request event then works.

### The last look

The other half of the same gap. A person's review can be submitted while the run that opened
the pull request is still at work, and its delivery can reach a machine that gives up before
the state arrives. So a run does not end without looking itself: once its work has run out,
it runs the review poller for each open pull request in its scope (the one it opened, or the
one its event is about), exactly as a pull request event would, and runs what that queues: a
revision for a change request by an allowed actor, a reviewer run for a head somebody pushed.

- It applies with `revise` or `review` on for the repository, and costs one read of the pull
  request per look.
- It cannot spin: there are at most three looks, and a look after the first is only taken
  when the one before queued something, which takes a new review or a new commit by somebody
  else. The run's own pushes and its own comment reviews queue nothing.
- `--deadline-minutes` bounds it: no look is taken with less than 30 seconds left, after the
  deadline or after a signal, and the work a look queues gets the time that is left.
- A look that fails (GitHub unreachable) is logged and reported, and changes nothing else
  about the run: the review still has its own delivery.
- When the work is deferred behind a cooldown, the look still records what it finds; it stays
  queued with the rest.

- A review that another run has already answered is not answered again
  ([One review, one revision](#one-review-one-revision)). With `--shared-state`, the reviews
  that fresher copy has on record for the pull request are taken over just before the look
  decides anything, so such a review is not even queued (`knownElsewhere` counts them).
  Without it, or when the other run's record has not reached the shared copy yet, the
  revision job is queued and then canceled before an agent starts, because the pull request
  itself says that the review has its revision.

The summary's `finalLook` says what happened:
`{ "looks": 2, "queued": 1, "knownElsewhere": 0, "error": null }`.

### One review, one revision

Two machines can meet the same review without either having seen the other's record of it:
the machine the review's own delivery started, and the last look of the run that opened the
pull request. Each has its own copy of the state, so the state cannot settle it before the
merge. The pull request can, and does ([revisions.md](revisions.md#one-revision-per-review-across-machines)
has the mechanism):

- **Before an agent starts for a review**, the pull request is read. If it is still at the
  commit the review was submitted against, nothing has been pushed since and the job goes
  ahead. Otherwise its comments are read: when the worker's own identity has left the
  comment of a revision for this review there, and the pull request is at exactly the commit
  that revision pushed (or the revision was a reply with nothing to push), the job is
  canceled with a reason that begins `superseded: `. No agent runs, nothing is posted, exit
  code 0 (a canceled job is not a failure). A branch that merely moved on proves nothing:
  the run that announced the revision may have died before pushing, and a person pushed. In
  that case the agent runs, and the check before the push (below) decides from the history.
- **Before a revision is pushed**, it announces the push in its comment on the pull request,
  and the push is only ever a fast-forward from the exact commit the run started from. Two
  runs that both got as far as an agent therefore end with one push: the other finds the
  first one's announcement made good on (in the history it started from, or where the branch
  now is), pushes nothing, withdraws its own announcement if it had made one, and ends with
  its job `succeeded`, its revision `skipped` with a `superseded: ` reason, and the outcome
  `superseded`. Exit code 0, no failure comment, no retry.

So a review produces at most one revision push, whichever machines see it and in whichever
order. What a race can still cost is one agent run. After the merge of both machines' state
there is one revision job for the review (the two are the same job, by the review's id), one
`review_requests` row, and it counts once towards `maxRevisions`.

### Updraft's own activity sends these events too

GitHub delivers `pull_request.synchronize` for the revision Updraft itself pushes, and
`pull_request_review.submitted` for the comment review it posts. A machine started for such a
delivery usually overlaps with the run that caused it, which has not uploaded its state yet:

- When the pull request is not in the shared state yet (the run that opened it has not saved
  anything since), the delivery ends `state-pending` with exit code 6, after two reads from
  GitHub. A caller that checkpoints the state while a run is going
  ([shared-state.md](shared-state.md#checkpoints)) makes that window short, and its retry of
  the event then finds the pull request on record and usually ends `no-new-work`.
- When the head on record is the current one, it costs one read of the pull request and ends
  `no-new-work`. The worker's own review is a comment, never a change request.
- When the other run has pushed a commit that the shared state does not know yet, with `review`
  on it can cost a **second reviewer run of the same commit**: the new machine sees a head
  without a review on record and reviews it, while the first run does the same in its own loop.
  Both reviews are posted. Nothing is pushed or merged twice
  ([shared-state.md](shared-state.md#what-concurrent-runs-can-and-cannot-do-to-each-other)).

`run-event` cannot tell the two cases apart from the API: the head is simply a commit on the
branch. The launcher can: when Updraft acts as a GitHub App, a delivery whose `sender` is the
App's own bot account was caused by Updraft, and need not start a machine. (With a personal
token the sender is that person either way, so there is nothing to filter on; expect the
duplicate review, or leave `pull_request.synchronize` out of the webhook's events and let a
person's push wait for the next review event.) Skipping a delivery is always safe: the payload
can only ever make Updraft do less.

## Shared state

A machine that starts with an empty state directory handles `issues.labeled` on its own, as
before. Everything that depends on earlier runs needs their state: cooldowns, the triage cache,
rotation, `updraft stats`, the review loop across events (a person's review arrives hours after
the run that opened the pull request), and noticing a duplicate delivery without asking GitHub.

The runs therefore share one state database, passed around as a file. The caller downloads it
into `<UPDRAFT_HOME>/state.db` before the run (keeping a copy as the snapshot), and afterwards
merges what the run changed into the latest shared copy with
`updraft state merge --changed <UPDRAFT_HOME>/state.db --base <snapshot> --into <latest>`.
[shared-state.md](shared-state.md) describes the merge, its rule for every table, and what runs
that overlap can and cannot do to each other.

What `run-event` does differently from `updraft start` because the database is shared:

- **It only works on its own event.** Its jobs are the ones it queued for the event (or found
  queued for it), and the reviewer and revision jobs of the pull requests those jobs opened or
  the event is about. Other queued jobs in the database belong to other events; they are never
  claimed, canceled, failed or changed.
- **It leaves alone what another run holds.** With checkpoints, the snapshot a run starts
  from can show another run's work in flight: a reviewer job that run queued a moment ago, a
  review posting it will retry, a merge it is waiting to make. Every run records a *hold* on
  its event's jobs (or, for a pull request event, on the pull request) before it starts
  working, releases it when it ends, and gives it an expiry (15 minutes after its
  `--deadline-minutes`; six hours without one) for the case that it never gets to.
  Work that was in the snapshot and is covered by another run's live hold is not this run's:
  its queued jobs are not started, its retries not made, its merge neither waited for nor
  made. The pull request itself is still **watched**: a pull request event reads it from
  GitHub as always, and what that read queues (a revision for a new review) is this run's own
  work, which it carries through, merge step included. A redelivered `issues` event whose job
  another run holds ends `duplicate-delivery`.
  [shared-state.md](shared-state.md#holds) has the details.
- **It never reconciles.** A run that another process left open in the database is another
  machine's, which may be at work right now: it is not closed, not marked interrupted, its
  process id is never signalled, its job is not requeued. (A restarted `updraft start` does all
  of that, because there every open run is its own predecessor's.) Such runs do not count towards
  `maxConcurrent`, an agent's or a capacity group's limit, or the one-job-per-issue rule either.
- **Its retries, reviewer jobs, merge step and notices are limited the same way,** and the
  startup sweep that publishes runs "a previous worker stopped before publishing" is skipped.
- **A stale worker lock in the snapshot is taken over** and released at the end; it never ends
  up in the shared database. A fresh one (see [shared-state.md](shared-state.md#seeding-and-maintenance))
  ends the command with exit code 3.
- **A state database written by a newer `updraft`** ends the command with exit code 5 before
  anything is started.

### Cooldowns

With `capacity` configured ([capacity-and-escalation.md](capacity-and-escalation.md)), a job
whose every eligible agent is cooling down after a usage limit stays queued. A worker that stays
up simply runs it when the cooldown ends. This command:

- **waits**, when the cooldown ends before `--deadline-minutes` (without a deadline: within five
  minutes), and then runs the job;
- otherwise **ends with outcome `deferred` and exit code 4.** The job stays `queued` in the state
  database and `deferredUntil` says when the cooldown ends. Nothing retries it by itself:
  **delivering the event again after that time is the retry.** The next run finds the queued job
  in the shared state and continues it (`resumed: true`), or defers again if it is still too
  early. This holds for a reviewer or revision job in the middle of the loop too: the event's
  own job is done, the rest is deferred, and the same redelivery continues it.

A usage limit hit by the agent mid-run is the same case: the run is recorded as failed, the
cooldown starts, the job goes back in the queue (up to `maxDeferrals` times), and the command
waits or defers as above.

## The clone

Where `checkoutPath` is missing or an empty directory, the command creates the clone there: an
empty repository with `origin` set to `https://github.com/OWNER/REPO.git`. The run's own
preparation then fetches the one branch it builds on (`baseBranch`, or the remote's default
branch; for a revision or a review, the pull request's branch), with its whole history and
without tags, and makes the job's worktree from it.

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
    "repository": "octo/widgets", "repositoryId": 42, "issue": 7, "pullRequest": null,
    "label": "updraft:ready", "sender": "allen", "eventId": "9001"
  },
  "dispatched": true,
  "resumed": false,
  "outcome": "succeeded",
  "reason": null,
  "stateRestored": false,
  "abandonedRun": null,
  "deferredUntil": null,
  "loop": {
    "pullRequest": 100, "url": "https://github.com/octo/widgets/pull/100",
    "rounds": 1, "maxRevisions": 3, "reviews": 2,
    "verdict": "ready-to-merge", "verdictSha": "…", "headSha": "…",
    "stage": "merged", "detail": "merged by Updraft at … (head …)",
    "ready": true, "merged": true, "mergeCommitSha": "…", "notMergedReason": null, "ciRerun": null
  },
  "message": "job job_ev9001x3f0c1d2e4a succeeded: https://github.com/octo/widgets/pull/100; pull request #100 is merged after 1 revision round(s) (…)",
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
  "followOnJobs": [
    { "jobId": "job_0mb3…", "kind": "review", "status": "succeeded", "outcome": "succeeded", "agent": "codex", "publication": "published", "…": "the job fields below" }
  ],
  "finalLook": { "looks": 1, "queued": 0, "knownElsewhere": 0, "error": null },
  "exitCode": 0
}
```

| Field | Meaning |
| --- | --- |
| `event` | What the delivery was about, as far as the payload could be read. `repository`, `sender` and the rest are the payload's; `eventId` is the timeline event's id from the API (null until it was found, and for pull request events); `pullRequest` is the pull request of a `pull_request` or `pull_request_review` delivery |
| `dispatched` | True when a job was queued for the event in this run |
| `resumed` | True when this run continued work an earlier run of the event left in the state database (a deferred job, a loop that was cut short) |
| `outcome` | `nothing-to-do`, `succeeded`, `canceled` (queued, then canceled by the pre-start check before any agent started), `superseded` (the agent ran and nothing was pushed, because another run of the same event published first, see [Idempotency](#idempotency), or another run revised for the same review first, see [One review, one revision](#one-review-one-revision)), `failed` (an agent run failed, could not start or was interrupted), `publish-failed` (a run succeeded, its publication, push or review posting did not), `not-started` (a job was still queued when the command ended), `deferred` (work of the event waits for a cooldown; see [Cooldowns](#cooldowns)), `state-pending` (see [A pull request the state database does not know](#a-pull-request-the-state-database-does-not-know)) or `error` (the command itself failed: config, GitHub, the event file, the state database). It is the worst of the event's own jobs **and** the jobs that followed from them in this run: see [What counts as success](#what-counts-as-success) |
| `reason` | Why nothing was done, as a code; null otherwise. From the payload: `unsupported-event`, `unsupported-action`, `malformed-payload`, `pull-request`, `repository-not-configured`, `label-not-configured`, `review-loop-off`. From the API: `actor-not-allowed`, `label-removed`, `label-missing`, `issue-closed`, `issue-gone`, `pull-request`. From the state database: `duplicate-delivery` (it already has the event's job, and nothing of it is left to do), `pull-request-closed`, `no-new-work`. From the state database and then the API: `pull-request-not-watched`, `state-pending` (with the outcome of that name). Others: `already-handled`, `canceled-before-start`, `published-by-another-run`, `cooldown` (with `deferred`), `state-not-restorable` (with `error`; see [Restoring lost state](#restoring-lost-state)), `publication-not-recoverable` (with `error`; see [An abandoned run](#an-abandoned-run)) |
| `stateRestored` | True when this run put a lost publication back on record from the GitHub API (with `reason: "already-handled"`). The job fields then describe the restored job. False otherwise |
| `abandonedRun` | Set when the state database had the event's job as `running` under a run that is gone, and this run closed it ([An abandoned run](#an-abandoned-run)): `jobId`, `runId` (the run that was left open), `heldUntil` (when its hold ended; null when none is on record), `settled` (`interrupted`, `released` for a run that was only claimed, or `publication` when its agent had finished and only its publication was left under way), `resumed` (true when this run then did the job itself), `existingBranch` (the branch or pull request branch GitHub has for the event, which is why nothing was started; null otherwise) and `detail`. Null otherwise |
| `deferredUntil` | With `deferred`: when the cooldown ends (ISO time). Null otherwise |
| `loop` | Where the review loop left the event's pull request, from the state database; null when the event has no pull request (yet). `rounds`: revision rounds so far, of `maxRevisions`. `reviews`: reviewer verdicts recorded. `verdict`, `verdictSha`: the newest verdict (`ready-to-merge`, `changes-requested`) and the commit it is for. `headSha`: the newest head known. `stage`, `detail`: the stage `updraft status` shows (`awaiting-review`, `reviewing`, `changes-requested`, `revising`, `ready-to-merge`, `merging`, `merged`, `needs-human`, `closed`). `ready`: the draft was marked ready for review. `merged`, `mergeCommitSha`, and `notMergedReason` (why it is not merged: `autoMerge` is off, the gate that blocked it, or the stage it is in). `ciRerun`: the CI step's one automatic re-run of the head's failed jobs (`sha`, `at`, `checks`), null when the head was not re-run ([ci-fix.md](ci-fix.md#one-re-run)) |
| `message` | One line saying the same to a person |
| `jobId`, `workflowId`, `status` | The job and its final status in the queue. For `issues.labeled`, the event's job; for a pull request event, the first job that was queued for the pull request (a revision or a reviewer job) |
| `runId`, `agent`, `runOutcome`, `logPath` | The job's last run; `runOutcome` is null when no agent run ended |
| `error` | The worker's own reason when the job did not succeed or was not published |
| `branch`, `baseSha`, `headSha`, `commitCount` | What the run left |
| `verification` | `passed` and each command's status; null when the action has no `verify` or it did not run |
| `publication`, `publicationError`, `prNumber`, `prUrl` | The publication's state (`published`, `skipped` when there were no commits, `failed`), or null when `publish` is off or nothing was attempted. For a revision job: its push to the pull request; for a reviewer job: the posting of its review |
| `failureCommentUrl` | The comment posted for a failed job (`commentOnFailure`) |
| `drain` | How the worker stopped: `idle`, `retries-abandoned` (a retry or a merge was left for later), `stalled`, `deferred`, `deadline`, `stopped` (a signal); null when it never started |
| `jobs` | Present only when the summary covers several jobs (several workflows share the trigger label, or several jobs were queued for the pull request): each job's fields. The top-level fields then describe the first |
| `followOnJobs` | Present when jobs followed from the event's in this run (reviewer runs, revisions, in the order they were queued): each with the job fields above, `kind` (`review`, `revision`) and its own `outcome`. They count towards the top-level `outcome` |
| `finalLook` | What [the last look](#the-last-look) did: `looks`, `queued`, `knownElsewhere` (reviews left alone because `--shared-state` had them on record), `error`. Null when none was due (no open pull request in scope, neither loop on, the run was cut short) |
| `exitCode` | The process's exit code |

### What counts as success

The outcome and the exit code are about **everything the run did for the event**: the event's
own jobs (for a pull request event, the jobs queued for the pull request when the run began)
and every job that followed from them in the same run, which the summary lists in
`followOnJobs`. The top-level job fields still describe the event's own (first) job, so a
summary can say `status: "succeeded"`, `publication: "published"` and `outcome: "failed"`:
the pull request was opened, and the reviewer run after it failed.

| What happened to a job in scope | Counts as |
| --- | --- |
| Its agent run failed, could not start, or was interrupted (a reviewer run that exits non-zero or gives no valid verdict included) | `failed`, exit code 1 |
| It succeeded, and its publication, its revision push or the posting of its review failed | `publish-failed`, exit code 1 |
| It was still queued when the run ended (nothing could start it, or the deadline came first) | `not-started`, exit code 1; behind a cooldown: `deferred`, exit code 4 |
| A follow-on job was canceled (its pull request was closed, its review withdrawn or outdated, or another run had already revised for the review) | Not a failure |
| A revision ran and gave way to another run's revision for the same review | `superseded`: not a failure |

The worst of these is the outcome (`failed`, then `publish-failed`, `not-started`,
`deferred`). What is **not** a failure, and ends with exit code 0 when no job failed:

- a valid review that leaves the pull request waiting for a person: `changes-requested` with
  `revise` off, `maxRevisions` reached (`needs-human`), "ready to merge" with `autoMerge` off;
- a merge that is waiting for checks longer than the run waits, or that GitHub does not allow
  yet (a failing check, a required approval, a conflict): `loop.merged` is false and
  `loop.notMergedReason` says why;
- a merge step or a notice that was left for later (`drain: "retries-abandoned"`). (A
  publication, push or review posting that was left for a later retry has failed as far as
  this run is concerned: `publish-failed`.)

`loop` is where the pull request stands; `updraft status` on the state directory shows each job.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Nothing to do (a restored publication included: `stateRestored`; and an abandoned run that was closed without being resumed: `abandonedRun`); or the event's job and every job that followed from it in this run succeeded, and what they produced was published, pushed or posted; or the job was canceled before an agent started; or another run of the same event published first, or revised for the same review first. Where the pull request stands is in `loop`: one that was reviewed and not merged, or waits for a person or for checks, is still exit code 0 ([What counts as success](#what-counts-as-success)) |
| 1 | A job of the event, **or a reviewer or revision job that followed from it in this run**, failed, was not published, pushed or posted, or never started; or the command failed (invalid config, a mode other than `live`, GitHub unreachable, the event could not be matched, a lost publication that cannot be restored) |
| 2 | The event file is missing or not JSON, or `--deadline-minutes` is not a positive number |
| 3 | Another worker holds the lock of this state directory |
| 4 | Deferred: work of the event waits for a usage-limit cooldown and is still queued in the state database. Merge the state as usual and deliver the event again after `deferredUntil` |
| 5 | The state database was written by a newer `updraft`. Nothing was started; use a newer version |
| 6 | State pending: the event is about a pull request Updraft opened, and this state database does not know it yet. Nothing was done and nothing was recorded. Run the event again with a newer copy of the state database; if that never comes, deliver the pull request's `issues.labeled` event again first ([Restoring lost state](#restoring-lost-state)) |

On SIGINT or SIGTERM the command stops the agent and exits 1, with the job `interrupted`.

Whatever the exit code, merge the state database afterwards when you share it: a failed run
has a job, a run, errors and metrics worth keeping, and `updraft state merge` reports
`changed: false` when there is nothing.

## Idempotency

GitHub redelivers webhooks, and a launcher can start two machines for one delivery.

- **The job id is derived from the event**: repository id, workflow id and the timeline event's
  id. The job branch is named after the job id (`updraft/issue-<n>-<job id>`), so every run of
  one event works on the same job and the same branch name, wherever it runs.
- **First the state database is asked.** If it already has the event's job:
  - and nothing of the event is left to do (the job reached an end, and no reviewer job,
    revision, review posting or merge of its pull request is pending): nothing to do,
    `reason: "duplicate-delivery"`, exit code 0, before any clone or agent. This includes a job
    that **failed**: with shared state a redelivery does not run a failed job again. Requeue it
    with `updraft retry JOB_ID` on a copy of the shared database, upload that, and deliver the
    event again. A launcher that retries a failed job for a person does the same in one step
    with `--retry`, which requeues the event's failed, interrupted or canceled jobs in the state
    database before this check;
  - and something is left (the job is still `queued` after a deferral, or the loop was cut
    short by a deadline or a cooldown): the run continues it, `resumed: true`;
  - and the job is `running` although no run that is still going holds it: see
    [An abandoned run](#an-abandoned-run).
- **Then GitHub is asked**, for a job that has not started: whether its branch already has a
  pull request (in any state: a merged pull request counts, also after its branch was deleted)
  or exists on the remote. If so, there is nothing to do: `reason: "already-handled"`, exit
  code 0, no clone fetched and no agent started. This is what stops a second run whose snapshot
  was taken before the first run's state was uploaded, and every second run when no state is
  shared.
- **A pull request that is there, and that the state database has nothing of**, is restored:
  see [Restoring lost state](#restoring-lost-state). The outcome is the same
  `already-handled`, with `stateRestored: true`.
- **Publication creates and never moves.** The push only creates the branch; Git refuses it if
  the branch appeared meanwhile. A pull request is opened only when none exists for the branch.
- **A review is acted on once**, by its id in `review_requests`, and a head commit is reviewed
  once, by the reviewer job's dedupe key. Both are in the shared state.

What remains:

- **Two runs that start at the same moment both run the agent.** Neither sees the other's state
  or a branch yet. Only one can publish: the other's push is refused, nothing on GitHub is
  changed by it, and it ends with `outcome: "superseded"`, `reason: "published-by-another-run"`
  and exit code 0. The cost is one agent run. The window is the length of an agent run, from
  the first run's check to its push.
- **Two events about the same pull request at the same moment** can both act on the same review
  or head commit. [shared-state.md](shared-state.md#what-concurrent-runs-can-and-cannot-do-to-each-other)
  says exactly what that can and cannot do; in short, the agent may run twice and a reviewer
  comment may appear twice, but one review gets one revision push
  ([One review, one revision](#one-review-one-revision)) and nothing is merged twice or at
  the wrong commit.
- **A run that pushed its branch and died before opening the pull request** leaves a branch
  without a pull request. Later runs of the event see the branch and do nothing. Without
  shared state: delete the branch on GitHub and redeliver the event to run it again. With
  shared state the job is on record, and [An abandoned run](#an-abandoned-run) says what a
  redelivery does and how to run the job again.
- **Without shared state, a failed job leaves nothing that marks the event as handled**, so a
  redelivery runs it again, and each failed run posts its own failure comment where
  `commentOnFailure` is on.
- A new application of the label (remove it, apply it again) is a new event with a new id and a
  new branch, as for the long-running worker.

## Restoring lost state

A run can open a pull request and then lose its state database: its machine died, or the
caller could not save the file. Without the publication on record, the pull request is not
watched, and every later review of it ends `state-pending`. Delivering the `issues.labeled`
event again repairs that, without running an agent.

When the check of [Idempotency](#idempotency) finds a pull request on GitHub for the event's
job, and the state database has no record of that pull request, the command reads the pull
request from the API ([the same test as above](#a-pull-request-the-state-database-does-not-know))
and puts back what the revision and review loops read:

| Row | From |
| --- | --- |
| The job | The event itself: the job id is derived from it, so it is the row the original run had. Status `succeeded` |
| The run | Its id from the marker in the pull request's body; its agent from the `<!-- updraft-agent: RUN_ID AGENT -->` marker beside it (or, for a pull request opened before #173, the "Opened by updraft from run ... (agent ...)" line); its attempt from the branch name. No summary, no log, no commits: nobody observed them |
| The publication | State `published`, with the pull request's number, URL, head branch and base branch from the API. `head_sha` and the issue comment are not recorded; the next read of the pull request supplies the head |
| The watch (`revision_prs`) | Derived from the publication and the job, as always |

Then: `outcome: "nothing-to-do"`, `reason: "already-handled"`, **`stateRestored: true`**, exit
code 0; the job fields of the summary describe the restored job, and `message` says that the
state was restored. A consumer that only knows `already-handled` sees what it always saw.

- **Marked.** `jobs.status_reason`, `runs.error` and `publications.error` begin with
  `reconstructed: ` and say when and by which delivery; the run's `worker_id` is
  `reconstructed`; the watch row's `created_at` is the epoch. `updraft state merge` never lets
  such a row replace the recorded one, in whichever order they reach the shared database
  ([shared-state.md](shared-state.md#reconstructed-rows)).
- **Only what the API establishes.** If the pull request is not Updraft's by the test above
  (another author, no marker), or the agent line is gone or names an agent that is no longer
  configured, nothing is restored and nothing is invented: `outcome: "error"`,
  `reason: "state-not-restorable"`, exit code 1, and a message that names the missing fact.
  The ways out are to merge the original run's state database if it was kept
  ([shared-state.md](shared-state.md#recovery)), or to close the pull request and apply the
  label again.
- **When it applies.** With `publish` on and `revise` or `review` on for the repository (the
  rows have no other reader), for an open pull request. A closed or merged one is plain
  `already-handled`, as before, and so is every repository with neither loop.
- **Also for a job a checkpoint carried.** If the state database has the event's job as
  `running`, `interrupted` or `succeeded` with no publication (the run's end was never
  saved), and no other run holds it, the same check and the same restore apply before the
  delivery is answered `duplicate-delivery`. A run the database has is kept as recorded and
  closed if it was left open.

## An abandoned run

A machine can checkpoint while its agent is at work and then disappear: no pull request, no
branch, no final merge of its database. The shared state then has the event's job as
`running` with an open run, for good: nothing reconciles across machines, and
`updraft retry` does not take a running job. A redelivery of the event resolves it.

**Never while the run may be alive.** A run holds its event's jobs from before it claims
them until it ends ([shared-state.md](shared-state.md#holds)), and a checkpoint carries the
hold with the job. While another run's hold on the job is live, a redelivery ends
`duplicate-delivery` as it always did, and settles nothing. Only when no live hold of
another run covers the job (it has expired: 15 minutes after that run's
`--deadline-minutes`, six hours without one; or it was released) is the job taken to be
abandoned.

Then, for that job and nothing else in the database:

1. **GitHub is asked first**, as for any job that has not started: a pull request for one of
   the job's branches, or such a branch on the remote.
2. **A pull request that can be restored is restored** ([above](#restoring-lost-state)):
   `already-handled`, `stateRestored: true`.
3. **Otherwise the abandoned run is closed**, exactly as the final merge of its database
   would have closed it ([shared-state.md](shared-state.md#work-the-run-did-not-finish)): an
   open run whose agent had started becomes `interrupted` and so does the job; a run that
   was only claimed is released and the job is `queued` again; a publication of it that was
   under way becomes `failed`; its hold is released. Runs and jobs of other events are not
   read, let alone changed.
4. **Where nothing of it is on GitHub, this delivery does the job.** The job is requeued
   (as `updraft retry` requeues it, with the reason "requeued by a redelivery of its event")
   and run in this run, as the job's next attempt: on the branch
   `updraft/issue-<n>-<job id>-<attempt>`, through the pre-start check and everything else.
   `resumed: true`, and the summary describes that run.
5. **Where its branch is on GitHub without a pull request** (the run pushed and died before
   opening it), nothing is started: running the job again would leave two results. The run
   is closed, the job is `interrupted`, and the command ends `nothing-to-do`,
   `already-handled`, exit code 0, with a message that says what to do: delete the branch,
   `updraft retry JOB_ID` on a copy of the shared state database, upload it, and deliver the
   event again. The same holds for a pull request that exists and cannot be restored
   because it is closed or neither loop is on (without the instructions: that work is done).
6. **Where the job has used its attempts** (three, the same number as start failures a job
   gets, and the number of attempt branches the checks of [Idempotency](#idempotency) know),
   or `updraft retry` would refuse it (a job held for a human), the run is closed and
   nothing is started: `nothing-to-do`, `duplicate-delivery`, exit code 0, and the message
   names `updraft retry`.

In all of 3 to 6 the summary has **`abandonedRun`**, which says which run was closed, when
its hold had ended, and whether this run did the job (`resumed`). The existing fields mean
what they always meant. Merge the state as usual afterwards: the job is no longer stuck in
the shared copy either. If the vanished run's own database turns up after all and is merged
([shared-state.md](shared-state.md#recovery)), its run row wins over the `interrupted` one,
as a run's own record always does.

Two redeliveries that arrive together after the hold has expired both close the run and both
run the job: the race of two runs of one event, with the outcome described under
[Idempotency](#idempotency) (one publishes, the other ends `superseded`).

**A run that vanished between its push and its pull request.** A checkpoint can also carry
the job as `succeeded` with its publication under way (`publishing`, no pull request): the
agent finished, the machine went before the pull request was opened. If the runner's final
merge ran before the machine went, it closed that publication as unfinished instead
(`failed`, not retryable, its error ending "not retried: the commits exist only on the
machine that made them"), and the same holds for it. A publication that GitHub or Updraft
refused has no such note and is left as it is. Once no live hold
covers the job, a redelivery asks GitHub for the job's branch and compares it with the
commit the run ended on (its summary's `headSha`):

- **The branch is there, at exactly that commit:** it is fetched into this clone and the
  publication is handed back to the publisher, due at once. The publisher finds the branch
  already pushed and opens the pull request. No agent runs again, and the run stays the one
  that did the work. `resumed: true`.
- **No branch:** the commits died with the machine. The publication fails for good, the job
  becomes `failed`, and it is requeued and run in this delivery as its next attempt, as in 4
  above (and refused as in 6).
- **Another commit is on the branch,** or the run recorded none: nothing can be vouched for.
  The publication fails for good and the job is `failed`. The command exits 1 with
  `reason: "publication-not-recoverable"` and a message that says what to do: delete the
  branch, `updraft retry JOB_ID` on a copy of the shared state database, upload it, and
  deliver the event again.

In each case `abandonedRun` has `settled: "publication"`.
