# Verification

A live run is `succeeded` when the agent CLI exits 0 and reports success. That says the agent
believes it is done; it does not say the tests pass. With `verify` on an action, the worker runs
your commands in the job worktree after the agent succeeded, and the run only counts as
`succeeded` if they all pass. Publication only happens for succeeded runs, so a branch that fails
verification is never pushed and no PR is opened for it.

```yaml
actions:
  implement-issue:
    prompt: ./prompts/implement-issue.md
    output: local-branch
    verify:
      - npm ci
      - npm test
    verifyTimeoutMinutes: 15
```

| Key | Default | Meaning |
| --- | --- | --- |
| `actions.<name>.verify` | none | Commands the worker runs in the job worktree after the agent succeeded, in order. Each entry is a string (run through the platform shell) or an array of strings (an executable and its arguments, run without a shell) |
| `actions.<name>.verifyTimeoutMinutes` | `15` | Time limit for all of the action's verify commands together |

## What happens

1. The agent finishes and its outcome is `succeeded`. For any other outcome (failed, timed out,
   interrupted, start failure) no verify command runs.
2. The worker runs the commands one at a time, in the job worktree. The first one that exits
   non-zero, cannot be started, or is still running when the time limit is reached stops the
   step; later commands are not run.
3. If every command exits 0, the run is `succeeded` and publication proceeds as configured.
   Otherwise the run is `failed` with an error such as `verification failed: "npm test" exited 1`,
   and the worktree is kept for inspection, exactly as for a failed agent run. The job is not
   retried on its own; fix the cause and use `updraft retry`.
4. If the worker is stopped (Ctrl-C, SIGTERM) while a command runs, the command's process tree
   is stopped and the run is `interrupted`.

Verification applies in `live` mode to actions with `output: local-branch`. Set anywhere else,
`updraft validate` warns and nothing is run. `updraft validate` rejects an empty list, empty or
multi-line commands, and an empty argv array.

## How a command is run

| Form | macOS, Linux | Windows |
| --- | --- | --- |
| string, `npm test` | `/bin/sh -c "npm test"` | `%SystemRoot%\System32\cmd.exe /d /s /c "npm test"` |
| array, `[node, --test]` | `node --test`, no shell | `node --test`, no shell |

- A string is a shell command line, so `&&`, pipes, redirection and quoting follow the rules of
  that OS's shell. On Windows that shell is `cmd.exe`, not PowerShell: it is what `npm run` uses
  for `package.json` scripts, it finds the `.cmd` shims that npm installs (`npm`, `npx`, `tsc`),
  and its exit code is the command's own. `/d` skips registry AutoRun commands, and `/s` makes
  `cmd.exe` take the text between the outer quotes as written, so a quoted path such as
  `"C:\Program Files\nodejs\node.exe" -e "..."` works. In `cmd.exe`, `%NAME%` is expanded even
  inside quotes.
- A config shared between Windows and other systems should keep string commands to what both
  shells read the same way: a program, plain arguments, double quotes. `npm ci` and `npm test`
  qualify. Put anything more involved in a `package.json` script or a script file in the repo.
- A string must be one line. Use one list entry per command instead of line breaks.
- The array form starts the executable directly, with the arguments exactly as listed. On
  Windows the executable must be a real program (`node`, `git`, `python`): a `.cmd` or `.bat`
  shim such as `npm` cannot be started without a shell, so use the string form for those.
- The command text comes only from your config file. Nothing from the issue, the agent's output
  or the repository is ever placed on a command line.

Each command runs with:

- **Working directory:** the job worktree.
- **Environment:** the worker's environment without `GH_TOKEN` and `GITHUB_TOKEN`. This is the
  agent's rule, for the agent's reason: the commands execute code the agent just wrote from an
  untrusted issue. `agents.<name>.env` is the agent's own configuration and is *not* passed on,
  so a verification result does not depend on which agent of the pool ran. Other secrets in the
  worker's environment are visible to the commands, as they are to the agent.
- **No stdin, no terminal.** Test runners that default to a watch mode when run interactively
  normally detect this; if yours does not, use its run-once command (`vitest run`, `jest --ci`).
- **The agent's process handling.** On macOS and Linux each command leads its own process group;
  at the time limit or on shutdown the group gets SIGTERM, then SIGKILL. On Windows the tree is
  stopped with `taskkill /t /f`. Processes a command leaves running in its group after it exits
  are stopped (macOS, Linux). The command's pid and OS start time replace the agent's in the
  state database, so if the worker itself crashes mid-verification, the next worker reaps the
  command (its message then calls it a leftover agent process) and marks the run interrupted.

`verifyTimeoutMinutes` covers the whole list, not each command, so the worst case for a run is
`timeoutMinutes + verifyTimeoutMinutes`. A slot of the agent stays occupied during verification.

### With a containerized agent

When the agent that ran the job has `agents.<name>.container` set, the commands do not run on
the host: each runs in its own container from the agent's image, with the worktree mounted and
none of the agent's credentials. A string command is then always run by `/bin/sh -c`, whatever
the host is. See [Isolating agents](isolation.md#verify-commands).

## Where the result shows up

`run.log` gets a delimited section after the agent's output, with each command's own output:

```text
---- end of agent output ----
exit: code 0 after 312s

---- verification (run by the worker: 2 command(s), 15 min in total) ----
---- verify 1/2: npm ci ----
command: ["/bin/sh","-c","npm ci"]
added 212 packages in 11s
exit: code 0 after 12s
---- verify 2/2: npm test ----
command: ["/bin/sh","-c","npm test"]
...
exit: code 0 after 42s
---- end of verification: passed ----
```

The run summary (in `run.log`, `updraft status` and `updraft status --json` as
`summary.verification`) lists each command with its result and duration:

```text
    verification: passed
      npm ci: passed in 12s
      npm test: passed in 42s
```

A result is `passed`, `exited <code>`, `failed` (could not start, or killed by a signal),
`timed out`, `stopped with the worker`, or `not run`. Runs of actions without `verify`, and runs
recorded before this feature, have no verification entry and render as before.

A published PR body has a **Verification** section with the same lines, so a reviewer can see
what was checked before the PR was opened:

````markdown
**Verification** (passed; commands run by the worker after the agent finished)

```text
npm ci: passed in 12s
npm test: passed in 42s
```
````

## Which commit was tested

The worker records the commit that was checked out when the first command started, and whether
the result is a test of exactly that commit: the worktree had no uncommitted or untracked files
at that moment, and the same commit was still checked out when the last command ended. A pass
with uncommitted files present is still a pass for the run, and the PR says so in a note, but
it is not counted as verification of the commit: a test can pass because of a fix that was
never committed. [Auto-merge](review-loop.md) requires an exact pass on the commit it merges.

Ignored files (build output, `node_modules`) are not part of this check. They are not in the
commit either, so a command that depends on one can pass here and fail on a fresh checkout.
That is why the worker's verification alone never authorizes a merge: auto-merge also requires
at least one check that GitHub ran on the commit, on a checkout of its own, to have passed.

For a containerized agent the worker does not run git inside submodules on the host (a
submodule's own Git config can name commands to run). Uncommitted files inside a submodule are
then not counted, so in a repository with submodules a containerized run's result is never
recorded as exact, and is not auto-merged.

Publication pushes the commit the run ended on. If the job branch is at any other commit when
the push is attempted (for example on a retry after someone committed to it), nothing is pushed.

## Uncommitted files

Verification runs in the worktree as the agent left it, and the worker never commits anything
on the agent's behalf. Only commits are published. Two things follow, and the summary reports
both by counting `git status --porcelain` entries (changed, staged and untracked files; ignored
files such as `node_modules` do not count) before the first command and after the last:

- **The commands can leave files behind.** `npm ci` may rewrite a lockfile, a build may write
  output that is not ignored. These changes stay uncommitted and are not in the PR. The summary
  says `uncommitted changes in the worktree went from 0 to 2 during verification`, and
  `updraft clean` does not remove a worktree with uncommitted changes (git refuses), so it stays
  until you deal with it. If this happens on every run, add the paths to `.gitignore` or use
  commands that do not write to tracked files (`npm ci` rather than `npm install`).
- **The agent can leave files uncommitted.** The commands then test a tree that contains them,
  while the PR will not. The run is not failed for this, but the summary and the PR body say
  `N uncommitted change(s) were in the worktree when verification ran: the commands saw them,
  but only commits are published`. Treat a PR with that note as not verified. To make it a hard
  failure, add a first command that fails on a dirty tree, for example `git diff --quiet HEAD`
  (tracked files only).

## Limits

- Verification shows that your commands passed in that worktree on the worker's machine. It is
  not a sandbox: the commands run repository code with the worker's user account, like the agent.
- An agent can make a test suite pass by editing the tests. Review the diff.
- Passing verification does not replace CI on the PR.
