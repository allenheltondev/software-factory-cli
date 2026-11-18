# Live execution

With `execution.mode: live` the worker runs the routed agent in each job's worktree. The other
modes start no agent: `log-only` writes `run.log` only, and `prepare-only` also creates the
job's branch and worktree. This page covers what is common to every agent. What is specific to
one agent CLI (prerequisites, the command line, its permission profile and platform notes) is
on its own page:

- [Claude Code](agents/claude.md)
- [Codex](agents/codex.md)
- [Kiro](agents/kiro.md)

`updraft start` runs these jobs as they are queued by polling. To run the job of one GitHub
webhook event and exit, on a machine that has no clone and no state yet, see
[Running one event](run-event.md); the run itself is the one described here.

## Requirements

`updraft validate` accepts `execution.mode: live` only when:

- at least one agent is enabled, and every enabled agent uses an adapter that can run agents
  (`claude`, `codex` and `kiro` all can);
- every repository with a workflow whose action has `output: local-branch` has a
  `checkoutPath`;
- every such action that a workflow uses has a `prompt`.

Live mode starts agents only for actions with `output: local-branch`. Runs of an action with
`output: log` are only logged, and `updraft validate` warns about them.

In live mode, `updraft doctor` reports a missing, broken or signed-out agent CLI as a failure
rather than a warning.

## Run lifecycle

For each `local-branch` job the worker does the following:

1. It renders the action's prompt file plus the issue's title, body, labels and URL into
   `prompt.md` in the run's log directory. The issue text is fenced and labelled as untrusted
   input. The adapter hands the file to the agent on stdin or by path, never in a command line.
2. It finds the agent CLI (`agents.<name>.command`, else the same lookup as `updraft agents`).
   If it can't, or the process can't be spawned, the run is `start_failed` and the job is
   requeued for the next eligible agent (up to three start failures in a row).
3. It prepares the branch and worktree as described in
   [Per-job worktrees](worktrees.md). A failure there fails the run.
4. It spawns the agent directly (no shell) in the worktree, records its pid and the OS start
   time of that process, and writes its stdout and stderr to `run.log`. `GH_TOKEN` and
   `GITHUB_TOKEN` are not passed to the agent unless `agents.<name>.env` sets them. If the
   worker can't record the pid, it stops the agent at once and fails the run (it is not a
   start failure, so no other agent is tried).
5. The adapter decides the outcome from the exit code and, where the CLI reports one, its
   machine-readable result (exit code 0 alone means `succeeded` otherwise). At
   `timeoutMinutes` the agent's process tree is killed and the run fails. Failed runs keep
   their worktree for inspection.
   If the action has `verify` commands and the agent succeeded, the worker then runs them in
   the worktree; a failing command fails the run (see [Verification](verification.md)).
6. It appends a summary to `run.log` and stores it for `updraft status`: commits on the job
   branch since the base commit, files changed (`git diff --stat` against the base, committed
   or not), untracked files, and the agent's final message (or its last output lines).

## Stopping agents

On macOS and Linux each agent runs in its own process group, so a timeout or shutdown also
stops whatever it started. Pressing Ctrl-C in a terminal therefore doesn't reach the agent
directly: the worker forwards its own shutdown (SIGINT or SIGTERM) to the agent's group as
SIGTERM, then SIGKILL after five seconds, and records the run `interrupted`. On Windows the
worker stops the agent's tree with `taskkill /t /f`. If the worker itself is killed, the
agent keeps running; the next `updraft start` on the same host stops it, but only after
checking that the recorded pid still belongs to the same process (same start time), so a pid
the OS has since reused is never signalled. A run with no recorded start time (one recorded
by a version of the CLI that did not store it) is not signalled either.

## Several agents in a pool

**Claude Code and Kiro together:** with both in a pool, such as the default
`general: { agents: [claude, kiro] }`, the queue hands consecutive jobs to them in turn
(round-robin). Each still needs its own prerequisites: see
[Claude Code](agents/claude.md#prerequisites) and [Kiro](agents/kiro.md#prerequisites).

If the chosen agent cannot be started (step 2 above), the job goes to the next eligible agent
in the pool.
