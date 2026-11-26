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

## Checking a failure against the base commit

Before a live run's agent starts, the worker also writes the files of the run's base commit
to a directory of their own, so that an agent that sees a test fail in a file its change does
not touch can show whether the failure is its own:

| Path | Variable | What it is |
| --- | --- | --- |
| `<state dir>/base-checks/<run id>/base` | `UPDRAFT_BASE_DIR` | The files of the base commit: for a code run the commit the job branch starts from, for a revision the pull request's head before it, for a reviewer the pull request's base (the merge base with its base branch) |
| `<state dir>/base-checks/<run id>/scratch` | `UPDRAFT_SCRATCH_DIR` | Empty, the agent's to write |

The prompts of the coding agent, the reviser and the reviewer name both and give the one
command to use:

```sh
rm -rf "$UPDRAFT_SCRATCH_DIR/base" && cp -R "$UPDRAFT_BASE_DIR" "$UPDRAFT_SCRATCH_DIR/base" \
  && cd "$UPDRAFT_SCRATCH_DIR/base" && <install> && <the failing test>
```

and ask for the result as evidence: "fails on base too" or "passes on base". The job's
worktree, its branch and its index are not touched by any of it.

Isolation:

- **Read-only.** A containerized agent gets the base directory as a read-only mount and the
  scratch directory read-write; neither is anything a commit, the run summary, verification or
  a push ever reads. (A host agent, with no container, can of course write anywhere it can.)
- **No git metadata and no credentials.** The files are written by the worker with a
  temporary index outside the clone (`git read-tree` and `git checkout-index --prefix`): no
  `.git`, no hooks, no config, no refs, no token. The clone's own index, HEAD, refs and
  worktrees are unchanged, and no hook runs. Submodules are not checked out. The files are
  converted as `git checkout` in the clone converts them (line endings by `core.autocrlf` and
  `.gitattributes`, and the clone's filters), so they match the worktree byte for byte where
  the commits do.
- **Removed when the run ends**, whatever the outcome, and `run.log` says so. The verify
  commands do not get it. If the base commit cannot be written, the run goes ahead without it
  (`base checkout: none (...)` in `run.log`) and the prompt does not mention it.

It is there because the other ways do not work in a container: there, the clone's git
directory is read-only apart from what a commit writes ([Isolation](isolation.md#the-git-directory)),
so in a clone with the files ref store `git stash pop` and deleting a branch fail with
`packed-refs.lock: Read-only file system` (a clone the worker makes uses reftable when every
agent runs the host's Git, which avoids that for deletions; see
[Isolation](isolation.md#the-git-directory)), and checking out another commit would change the
working tree that becomes the pull request.

In `live` mode the routed agent then runs in the worktree; see
[Live execution](live-execution.md).
