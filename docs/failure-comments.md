# Failure comments

Off by default. Set `repositories.<OWNER/REPO>.commentOnFailure: true` to have the worker
comment on the issue when a run for it fails, so whoever applied the label learns that no PR is
coming and how to retry. Without it, a failure is only visible in `updraft status` on the
machine running the worker.

```yaml
repositories:
  octo/widgets:
    id: 42
    checkoutPath: ../clones/widgets
    commentOnFailure: true
    workflows:
      - trigger: { event: issue.labeled, label: updraft:ready }
        action: implement-issue
        pool: general
```

Like `publish`, it makes the worker write to GitHub as the active `gh` account (`GH_TOKEN` or
`GITHUB_TOKEN` if set, otherwise `gh auth token`), so it is opt-in per repository, and it
applies only in `live` mode. Set in another mode, it is a validation warning and does nothing.
It is independent of `publish`: either can be set without the other.

## When a comment is posted

One comment, when a job ends `failed`:

- a run ended `failed`: the agent exited with an error, timed out, or the job's worktree could
  not be prepared;
- no agent could start: the job used up its consecutive start failures (three). The comment is
  for the last of them.

No comment for:

- a run that was `interrupted` (the worker was stopped; whoever stopped it is at the machine and
  can `updraft retry` the job);
- a job that was `canceled` before it started (the issue was closed or the label removed);
- a single start failure that was requeued for another agent;
- a job that failed without a run, because its pool or action was removed from the config.

If you retry the job and a later attempt succeeds and is published, the publication comment
follows on the issue. The failure comment is left as it is: the worker never edits or deletes it.
A later attempt that fails again gets a comment of its own.

## What the comment says

````markdown
An Updraft run for this issue failed, so no pull request was opened for it.

- Run: `run_01JD3M5K8Q` (attempt 1 of job `job_01JD3M2A7C`)
- Agent: `claude`
- Ran for: 12m 5s
- Branch: `updraft/issue-7-job_01JD3M2A7C` (on the worker's machine; not pushed)

**Reason**

```text
agent timed out after 60 min; its process tree was stopped
```

The agent's output is not posted here; the full error and the run log are on the machine running the worker (`updraft status`).

To try again, run `updraft retry job_01JD3M2A7C` on that machine, or remove the `updraft:ready` label from this issue and apply it again.

<!-- updraft-run-failed: run_01JD3M5K8Q -->
````

The issue may be public and the agent's output is untrusted, so the comment carries only what
the worker itself knows:

- **No agent output.** Not the output, not the agent's final message, not the commit list or
  diffstat. The run's recorded error often ends with something the agent printed (for example
  `agent exited with code 1 before reporting a result: <first line of output>`); the comment
  keeps only the worker's description before the first `: ` and drops the rest. The full error
  stays in `updraft status` and the run log.
- **No local paths.** Paths under the state, log and config directories, the clone, the home
  directory, and anything else that looks like an absolute POSIX, Windows or UNC path are
  replaced with `<path>`.
- **Nothing that notifies or links.** The reason is in a code block and the run id, job id,
  agent, branch and label are in inline code, so an `@mention`, an issue reference or a closing
  keyword in any of them is inert. The reason is capped at 300 characters.

The branch line appears only when the job branch was created. The branch is local to the
worker's machine: a failed run is never pushed.

## Retries and failures

The comment is idempotent in the same way publication's issue comment is. It carries a hidden
`<!-- updraft-run-failed: <runId> -->` marker (distinct from publication's
`<!-- updraft-run: <runId> -->`). Before posting, the worker looks for an issue comment with the
run's marker and adopts it if there is one; what was posted is recorded in the state DB,
separately from the run. A retry never posts a second comment, including when the response to
the first post was lost. Only one attempt owns a comment at a time, with the same lease and
ownership check before each request that publication uses.

Network errors, GitHub 5xx responses and rate limits are retried by the worker on its own after
each poll, with backoff, up to five attempts. Other failures (the token may not write issue
comments, the issue is locked, the repository is archived) are recorded and not retried. If you
retry the job before a pending comment could be posted, the comment is dropped. None of this
changes the run's outcome or holds up the worker.

`updraft status` shows, for each run, the comment's URL or why it was not posted, under
"Failure comments". The run's `run.log` gets a line too.

## Permissions

Commenting needs less than publication: read access to the repository, and a token that may
write issue comments. That is the classic `repo` scope (`public_repo` is enough for a public
repository), or a fine-grained token with Issues set to read and write. GitHub refuses comments
on archived repositories and on locked issues (unless the account has write access).

`updraft doctor` checks, for every repository with `commentOnFailure` set, that the active
account can read the repository and that the repository is not archived (a failure in `live`
mode, a warning otherwise). It cannot check that the token may write issue comments, because it
never writes to GitHub; that shows the first time a comment is posted.
