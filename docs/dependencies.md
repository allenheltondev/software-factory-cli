# Waiting on another repository

Off by default. Sometimes an issue can't be finished until a change lands somewhere else first,
such as a hook in a library the repository depends on. With
`repositories.<OWNER/REPO>.dependencies` set, a run that finds this can say so. The worker then
publishes nothing for that run and watches the pull request in the other repository. Once that
pull request is merged, the worker runs the issue again.

```yaml
repositories:
  octo/widgets:
    id: 42
    checkoutPath: ../clones/widgets
    publish: draft-pr
    dependencies:
      repositories: [octo/widget-lib]   # pull requests here may be waited on; nothing else counts
      checkIntervalMinutes: 5           # optional, default 5 (1 to 1440)
      maxWaitDays: 30                   # optional, default 30 (up to 365)
    workflows:
      - trigger: { event: issue.labeled, label: updraft:ready }
        action: implement-issue
        pool: general
```

It applies only in `live` mode, and only to implementation runs. Revision and reviewer runs
never wait. Set in another mode, it is a validation warning and does nothing. It doesn't need
`publish`: without `publish` nothing is published either way, but the wait and the run that
follows it still happen.

## How a run declares a wait

When `dependencies` is set, the prompt of every implementation run gets a short section after
the action's own prompt. The section names the allowed repositories and tells the agent what to
do when the issue needs a change in one of them first:

1. Open a pull request there with that change, or find the one that already has it.
2. Don't make the dependent change in this repository yet.
3. End the final message with exactly one line naming that pull request:

```text
UPDRAFT-WAITING-ON: octo/widget-lib#12
```

A link (`https://github.com/octo/widget-lib/pull/12`) works too. The worker reads the line the
same way it reads a reviewer's verdict line ([review-loop.md](review-loop.md)), and just as
strictly:

- It reads the agent's own final message, where the adapter can isolate it (Claude Code's
  `result`, Codex's last agent message). Otherwise it reads the whole output. A line that only
  appears in a tool's output doesn't count.
- The line must be the last non-empty line of that message, and there must be exactly one. Bold,
  code ticks, or a list or quote marker around it are ignored. A mention of the token inside a
  sentence isn't a declaration.
- It must name one pull request as `OWNER/REPO#NUMBER`, and `OWNER/REPO` must be listed in
  `dependencies.repositories` (case doesn't matter).

A run that doesn't meet these rules has declared nothing. It ends exactly as it would have
without the line: its commits are published if it left any, and `run.log` says why the line was
ignored (`waiting on: none (...)`).

### Which pull requests may be waited on

Only pull requests in repositories you list. The agent's output is untrusted: it follows the
issue, which anyone who can open or edit the issue controls. Without the list, an issue could
make the worker watch any repository the token can read. It could also make the worker gate an
issue on a pull request whose author decides when it "merges". The list keeps this in your
hands. The dependency repository doesn't need to be in `repositories:` itself. The worker only
reads its pull request, never its events.

## What a waiting run does and doesn't do

A run that declares a valid wait still ends `succeeded`. It did what it could, and its job shows
as `succeeded` in `updraft status`, with "waiting on OWNER/REPO#N" next to it. The worker
records the wait in the same database transaction that closes the run, so the run never exists
as succeeded without its wait. In particular, a publication can't slip in between. Then:

- Nothing from the run is published: no push, no pull request, no review. This holds for the
  publication right after the run, for the startup sweep, and for `updraft publish RUN_ID`. Any
  commits the agent made anyway stay on the job branch on the worker's machine, for inspection.
- The action's verify commands don't run. Nothing they could check is going to be published.
  `run.log` says that verification was skipped.
- The worker comments once on the issue (see [Comments](#comments)).

## Checking the pull request

After each poll, the worker (`updraft start`) checks the waits whose time has come. It schedules
checks every `checkIntervalMinutes` after the run ends, with a final check due at the wait deadline.
It checks at most 20 waits per pass and leaves the rest for the next one. Each check costs two or
three REST requests: the issue, the pull request, and once per wait the dependency repository
(to learn its stable id).

| What the check finds | What happens |
| --- | --- |
| The issue is closed, deleted, or no longer carries the workflow's trigger label | The wait ends **canceled**. No comment: someone chose this |
| The repository, its `dependencies` or its workflow is gone from the config, or the pull request's repository is no longer listed | The wait ends **canceled**. No comment |
| The pull request was **merged** by the wait deadline | A follow-up job is queued, and the wait ends **resumed**, even if the worker discovers the merge later |
| The pull request was **closed without merging**, or it (or its repository) can't be read: 404, or 403 for the repository | The wait ends **closed**, and the issue gets a failure comment |
| The deadline set by `maxWaitDays` has passed and the worker cannot confirm a merge by that deadline | The wait ends **expired**, and the issue gets a failure comment |
| It is still open | The next check is scheduled |
| Before the deadline, GitHub can't be reached, or answers 5xx or a rate limit | The next check backs off up to the deadline (the interval, then doubling, up to 6 hours). The worker honors GitHub's `Retry-After` if it delays the check further. The error is in `updraft status` |

A wait ends exactly once. If a check and `updraft cancel` race, the first one stands.

## The follow-up run

When the pull request is merged, the worker queues one follow-up job in the same transaction
that ends the wait:

- It uses the same workflow, action and issue as the waiting job. It also keeps the waiting job's
  routing decision, the pool it was in by then, and the escalation hops it had used. An escalated
  job doesn't start over at its original tier, and doesn't get a fresh hop budget.
- Its event id is `dep:<waiting run id>`. The jobs table's unique key gives one follow-up per
  wait, across restarts and replays.
- It's an ordinary queued job. `maxConcurrent`, agent limits, round-robin, capacity cooldowns,
  escalation and the pre-start check all apply to it as to any other job
  ([capacity-and-escalation.md](capacity-and-escalation.md)).
- Its pre-start check vouches for the issue text against the label application that queued the
  first job of the issue, not its own `dep:` event. If the label was removed and re-applied
  since, or someone outside the allowlist edited the issue, the follow-up is canceled, as the
  original job would have been. A re-applied label queues a fresh job of its own anyway.
- Its prompt says which pull request it waited on and when it merged (with the merge commit).
  The title of that pull request and the waiting run's explanation are fenced as untrusted input.
  The follow-up's worktree starts fresh from the base branch, which now has the dependency
  through whatever bumps it (a lockfile, a submodule, a release), not from the waiting run's
  branch.
- It runs and publishes like any implementation run. It may wait again: a chain of waits
  started by one label application is capped at five. After that, the prompt says the limit is
  reached, and the worker ignores a further declaration.

## Comments

Both comments go on the issue, as the worker's GitHub identity. Like the
[failure comment](failure-comments.md), they hold only what the worker itself knows: the
validated `OWNER/REPO#N`, the link it built from them, run and job ids, the agent, the check
interval and the wait limit. They never include the agent's explanation or the pull request's
title. Each carries a hidden marker with the run id, and the worker searches the issue's
comments for it before every write, so a retry leaves one comment. A comment that couldn't be
posted is retried after later polls, up to five attempts in all. A permission error isn't
retried. Comments never change a run or a wait.

- **Waiting.** Posted when the wait is recorded. It names the pull request and says that the
  worker checks it every `checkIntervalMinutes` and runs the issue again once it merges. It also
  says what happens if the pull request is closed or outlasts `maxWaitDays`, and how to stop
  waiting. It isn't posted late, after the wait has ended.
- **Stopped waiting.** This is the failure comment, rendered by `src/publish/failure-comment.ts`.
  It's posted when a wait ends closed or expired. It gives the reason and how to try again:
  remove the trigger label and apply it again.

A merge gets no comment of its own. The follow-up run's
[assignment comment](assignment-comments.md) says the issue is being worked on again.

## Stopping a wait

- Remove the trigger label from the issue, or close the issue. The next check cancels the wait.
- `updraft cancel JOB_ID` with the waiting job's id cancels it at once. The job stays
  `succeeded`.
- Remove the repository from `dependencies.repositories`, or remove `dependencies`. The next
  check cancels the wait. A worker started after `dependencies` was removed keeps checking the
  waits that are still waiting, so that they end.

## Where to see it

- `updraft status`: the queue line counts the succeeded jobs that are waiting. "Recent jobs"
  shows "waiting on OWNER/REPO#N" for them. A **Waiting on other repositories** section lists
  every wait that is still waiting (since when, last and next check, and errors), then the latest
  ended ones (resumed, with the follow-up job's id, or closed, canceled or expired, with the
  reason), and where their comments stand. `updraft status --json` has them under
  `snapshot.dependencyWaits`.
- `updraft stats`: a **Waiting on other repositories** block, and `dependencies` in the JSON.
  It shows the waits begun and ended in the window by how they ended, the median and average time
  from the start of a wait to the merge that resumed it, and how many are waiting now. The facts
  are `dependency.waiting` and `dependency.ended` in `metric_events`. They hold ids and codes
  only, never a repository name or pull request number of the dependency ([stats.md](stats.md)).
- `run.log` of the waiting run: `waiting on: OWNER/REPO#N` and the skipped verification. In the
  follow-up's `run.log`, a `continues:` line names the waiting job and run.

## Where it is recorded

`dependency_waits` in `state.db`, one row per waiting run, keyed by run id. It holds the
declared pull request, the state (`waiting`, `resumed`, `closed`, `canceled`, `expired`) and the
reason it ended, check counters and the next check time. It also holds the merge time and
commit, the follow-up job, and the delivery of both comments. The waiting run's explanation is
kept as untrusted text, capped at 4,000 characters, for the follow-up's prompt only.
`updraft clean --older-than` keeps a job while its wait is still waiting. On a
[shared state database](shared-state.md), a wait that ended is never brought back to waiting.
Waits are checked only by `updraft start`. `updraft run-event` records a wait its run declares,
but doesn't check it.
