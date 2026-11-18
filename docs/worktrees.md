# Per-job worktrees

In `prepare-only` and `live` mode, each job whose action has `output: local-branch` gets:

- a fetch of the base branch (`baseBranch`, else the remote's default branch) from the
  repo's remote in `checkoutPath`: the one named by `remote`, else a remote whose URL is on
  `github.com` with path `OWNER/REPO` (`origin` if several are). A same-named repo on another
  host is never picked on its own;
- a new branch `updraft/issue-<n>-<jobId>` at the fetched commit. A retried job's later
  attempts add `-<attempt>`. An existing branch is never reused; the run fails instead;
- a worktree at `<state dir>/worktrees/<repoId>/<jobId>[-<attempt>]`, recorded as the run's
  checkout, and `run.log` describing it.

Your clone's own checkout is not touched. Git operations on one clone are serialized, so
concurrent jobs in one repo do not race. `updraft doctor` checks that each `checkoutPath`
exists and is a Git repository, and shows which remote it selected (by the same rule) and
why; its repository check confirms the repo ID behind the configured name.

Worktrees of failed and interrupted runs, and of runs canceled with `updraft cancel` after
their agent started, are kept for inspection. `updraft clean` removes
worktrees of succeeded runs, runs closed before they started (canceled), and runs whose agent
never started. It only touches worktrees under `<state dir>/worktrees`, skips any with
uncommitted changes, and keeps every branch, since the branch is the job's output. Delete
branches with `git branch -D` when you no longer need them.

In `live` mode the routed agent then runs in the worktree; see
[Live execution](live-execution.md).
