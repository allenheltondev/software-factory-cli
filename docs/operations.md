# Operating the worker

Day-to-day commands beyond `updraft start` and `updraft status`. The
[README](../README.md#commands) lists every command.

## Canceling a job

`updraft cancel JOB_ID` cancels a queued job at once. For a running job it records a request
in the state database; the worker (`updraft start`) checks for requests every 2 seconds, stops
the agent's process tree the same way a shutdown does, and marks the job `canceled` with the
reason `canceled by user`. `updraft status` shows `cancel requested` on the run until then. A
canceled job is not requeued, not published and gets no failure comment; `updraft retry JOB_ID`
queues it again. If the agent finished in the moment before the worker saw the request, the job
is still `canceled` and the run's error says what had happened; its work is in the worktree and
on the job branch.

If no worker is running, a job shown as running is a leftover: `updraft cancel` says so and
exits 1 without changing anything. The next `updraft start` stops any agent process left behind
and marks the job `interrupted` (or queues it again if its agent had not started).
A job that already finished cannot be canceled (exit 1).

## Reading the worker log

`updraft start` prints one line per event to stderr: time, level, a `[source]` column (the job,
else run, repo or component the event belongs to; `worker` when none), the message, then
secondary fields (`issue`, `pr`, `job`, `pool`, `run`, `agent`, `attempt`, `reason` first, `error`
last). Values with spaces, quotes or newlines are quoted and escaped so one event is always one
line, and values over 160 characters are shortened (the file keeps them in full).

Before:

```text
2026-01-02T14:32:09.114Z INFO  job queued repo=owner/app job=job_abc issue=39 workflow=default pool=general
2026-01-02T14:33:42.870Z WARN  publication failed error=rate limited retryable=true attempts=2
```

After:

```text
14:32:09  INFO   [job:job_abc]       job queued  issue=39 pool=general workflow=default repo=owner/app
14:33:42  WARN   [run:run_xyz]       publication failed  attempts=2 retryable=true error="rate limited"
```

Color is used only when stderr is an interactive terminal: DEBUG dim, WARN yellow, ERROR red,
and a lifecycle word in the message (queued/started/published green, retry yellow, failed red).
Output that is redirected, piped, run by Task Scheduler or the launchers, or in CI is plain text.
Set `NO_COLOR=1` or `UPDRAFT_COLOR=never` to turn color off, or `UPDRAFT_COLOR=always` (or
`FORCE_COLOR=1`) to force it.

`~/.updraft/logs/updraft.log` is unaffected: newline-delimited JSON with `at`, `level`, `msg` and
every field, never colored. Agent `run.log` transcripts are not reformatted.

The default level is `info`. Set `UPDRAFT_LOG_LEVEL=debug` (or `warn`, `error`) before
`updraft start` to change it; `debug` adds events such as repositories backing off.

## Retention

Nothing is pruned automatically. `updraft clean --older-than 30d` removes jobs that reached a
final state (succeeded, failed, interrupted, canceled) more than 30 days ago, together with
their runs, publication and failure-comment records, error rows and `runs/<runId>/` log
directories, and any other error rows older than that. Add `--dry-run` to see what would go.
The age is a number and a unit: `h`, `d` or `w`.

Kept regardless of age: queued and running jobs, and jobs with a publication or failure comment
that is still in progress, awaiting retry, or was touched after the cutoff. Worktrees that
`updraft clean` keeps for inspection (failed, interrupted and user-canceled runs) are removed
with their job when they have no uncommitted or untracked changes; a job whose worktree does
have such changes is kept whole and listed, so no worktree is left without a record. Branches
are never deleted.

A pruned job's event is remembered, so the same label event is never enqueued a second time,
however long ago the job ran. The rollup behind [`updraft stats`](stats.md) is never pruned, so
pruning does not change any number it reports. The database file does not shrink after pruning (freed space is
reused); run `VACUUM` with the worker stopped if you want it smaller.
