# Publication

How the worker pushes a job branch and opens a pull request for a live run. For how the run
itself works, see [Live execution](live-execution.md).

## When a run is published

Off by default. Set `repositories.<OWNER/REPO>.publish` to `draft-pr` or `pr` to have the
worker publish a live run's work. It applies only in `live` mode, to actions with
`output: local-branch`, and only to runs that **succeeded and left at least one commit** on
the job branch. Failed runs keep their local worktree as before; a run with no commits is
recorded as "not published".

## What the worker does

The worker publishes, never the agent, as the active `gh`
account (`GH_TOKEN` or `GITHUB_TOKEN` if set, otherwise `gh auth token`):

1. **Push** the job branch to the repo's remote in `checkoutPath` (the same remote the
   worktree was fetched from): `git push <remote> <sha>:refs/heads/updraft/issue-<n>-<jobId>`.
   The push only ever creates the branch: it carries `--force-with-lease=<ref>:` with an empty
   expected value, so Git refuses it if the branch exists by the time it runs, and it never
   moves an existing branch, not even by a fast-forward. It never pushes the base branch and
   refuses any branch other than the run's job branch. The remote must have exactly one push
   URL, and it must point at the configured repository (`git push` sends to every `pushurl`
   a remote has, so a remote with several is refused). The check and the push then both name that URL directly, from a
   throwaway repository that borrows the clone's objects but none of its configuration, with
   global and system Git config switched off, so a remote, `insteadOf` rule or hook changed
   after the check can't send the push elsewhere. If the branch already exists at that URL at
   the same commit, the push is skipped; at a different commit, before or during the push,
   publication fails and the remote branch is left alone.
2. **Open a PR** from the job branch into the base branch (draft for `draft-pr`), titled with
   the issue title. The body says `Closes #<n>`, lists the commits and the diffstat, quotes the
   agent's final message (capped, in a code block so mentions and closing keywords in it stay
   inert), and carries the run id and a hidden `<!-- updraft-run: <runId> -->` marker.
3. **Comment on the issue** with a link to the PR and a short summary, with the same marker.

Merging stays a human decision: the worker never merges, approves or marks a PR ready for
review.

## Authentication

API calls use the token. For an `https://github.com/...` remote, the push
uses the same token, handed to that one `git` process as an `Authorization` header scoped to
`https://github.com/` through `GIT_CONFIG_*` environment variables, so it is not in the command
line, the remote URL, a file or the logs. For SSH remotes (including host aliases) the push uses
your SSH key and `~/.ssh/config`; because Git config files are ignored for the push, a
`core.sshCommand` there does not apply (set `GIT_SSH_COMMAND` in the worker's environment
instead). Git hooks and tracing are turned off for these commands.

## Idempotent retries

Each step is recorded as it completes (in the state DB, separately
from the run, so publication never changes a run's outcome), and each step checks GitHub
before writing: the remote branch before pushing, any PR for the head branch in any state
(open, closed or merged) before opening one, and an issue comment with the run's marker before
commenting. A retry resumes where the last attempt stopped and never creates a duplicate.
Only one attempt owns a publication at a time. Right before each push, PR and comment it
confirms it still owns the publication and renews its lease, so a slow lookup can't lead to
a late write. Every GitHub request gives up after 60 seconds, an attempt stops after 8
minutes (and is retried later), and an attempt that lost its lease can neither write to
GitHub again nor change the recorded state.

## Failures

Network errors, GitHub 5xx responses and rate limits are retried by the worker
on its own after each poll, with backoff, up to five attempts. Other failures wait for you:
`updraft status` shows the error, and `updraft publish RUN_ID` retries through the same path.
`updraft publish` also publishes a succeeded run the worker did not publish, for example one
from before you turned `publish` on. Permission errors say what is needed: push access to the
repository and a token with the classic `repo` scope, or a fine-grained token with Contents,
Pull requests and Issues set to read and write (`gh auth refresh -h github.com -s repo`).
GitHub refuses draft PRs for private repositories on some plans; publication then fails with
a message to set `publish: pr`. It never falls back on its own.

`updraft status` shows each run's PR link or publication error, and `updraft doctor` checks
that the active account has push access to every repository with `publish` set.

What publication does and does not protect against is covered under
[Security](security.md).
