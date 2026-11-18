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
however long ago the job ran. The database file does not shrink after pruning (freed space is
reused); run `VACUUM` with the worker stopped if you want it smaller.
