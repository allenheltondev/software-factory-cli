# Assignment comments

In live mode, when the worker claims an implementation run and the final dispatch check passes, it
comments once on the source issue, just before the agent starts:

> Updraft assigned **codex** to work on this issue.
>
> - **Job ID** `job_...`
> - **Run ID** `run_...`
> - **Pool** `general`

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

## Permission

The comment is posted as the active GitHub identity, like the other comments. Needed: a classic
token with the `repo` scope (`public_repo` for a public repository), a fine-grained token with
Issues set to read and write, or, with a GitHub App, the Issues repository permission set to read
and write. See [failure-comments.md](failure-comments.md) and [github-app.md](github-app.md).
