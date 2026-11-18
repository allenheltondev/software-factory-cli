# Updraft

`updraft` watches GitHub repositories you choose and turns labeled issues into queued jobs
for coding agents (Codex, Claude Code, Kiro). It runs on your machine, uses your `gh`
sign-in, and keeps its queue in a local SQLite database.

## Status

Pilot. `updraft` polls GitHub issue events for the repositories you configure and queues a
job when an allowed user applies a trigger label to an open issue. Each job is routed to an
agent pool and, in `live` mode, the chosen agent (Claude Code, Codex or Kiro) runs in a
branch and Git worktree created for that job. Publication is opt-in per repository: the
worker can push the job branch and open a pull request. The default mode, `log-only`, records
what would run and starts no agent.

It is built for one person running it on their own machine. Agents run as your user, in
full-auto mode by default and without a sandbox; read [Security](#security) before turning
on live mode. Commands and config keys may still change. The original design is in
[docs/design.md](docs/design.md).

## Install

Requires Node.js 22.13 or later, Git, and the [GitHub CLI](https://cli.github.com/).

```sh
npm install -g @allenheltondev/updraft
gh auth login
updraft doctor
```

## Quick start

1. `updraft configure` - pick repositories, the trigger label, actions and pools. It writes
   your per-user config. For scripts, use `updraft add OWNER/REPO` instead.
2. Check `dispatch.allowedActors` in the config: only these GitHub logins can dispatch work.
   A new config lists the account `gh` is signed in as. Then run `updraft validate`.
3. `updraft start` - polls GitHub and processes the queue until you stop it (Ctrl+C).
4. Add the `ready` label to an open issue. Within one poll interval, `updraft status`
   shows the queued job and, in log-only mode, its run.

A new config is in `log-only` mode, which starts no agent. To have agents work on issues,
set a `checkoutPath` for each repository and `execution.mode: live`, then run
`updraft validate` and `updraft doctor`; see [Live execution](#live-execution). To run the
worker in the background at login, see [Background operation](#background-operation).

## Commands

All commands accept `--config <path>` (or `UPDRAFT_CONFIG`) to use a config file other than
the per-user default.

| Command | Behavior |
| --- | --- |
| `updraft configure` | Interactively select repos, trigger labels, actions and pools (needs a terminal) |
| `updraft add OWNER/REPO` | Add or update a repo workflow non-interactively. Options: `--label` (default `ready`), `--action` (default `implement-issue`), `--pool` (default `general`), `--route LABEL=POOL` (repeatable), `--backfill-since DATE`, `--workflow-id ID` |
| `updraft validate` | Check the config without network access; exit 1 if invalid |
| `updraft start` | Run the worker: poll GitHub and process the queue (non-interactive). Exits with code 3 if another worker holds the lock |
| `updraft status [--json]` | Worker state, watched repos and checkpoints, agents, queue counts, active runs, recent jobs and errors. Works offline |
| `updraft doctor [--json]` | Check Node, config, state, Git, `gh`, GitHub access, labels and each enabled agent in the current environment, the way a live run starts it (its `command` and `env`) |
| `updraft agents [--json] [--deep]` | List Claude Code, Codex and Kiro on this machine: path, version, sign-in status and platform support. `--deep` sends one short prompt to each usable agent (uses tokens) |
| `updraft retry JOB_ID` | Requeue a failed, interrupted or canceled job |
| `updraft publish RUN_ID` | Push the branch of a succeeded live run and open its PR, or finish a publication that failed part-way. Never opens a second PR or comment. See [docs/publication.md](docs/publication.md) |
| `updraft logs RUN_ID\|JOB_ID [--follow] [--path]` | Print a run's `run.log`; for a job, the log of its latest run (named on stderr). `--follow` keeps printing until the run has finished; `--path` prints only the file path. Needs neither network nor a running worker |
| `updraft cancel JOB_ID` | Cancel a queued job, or ask the running worker to stop a running one: the agent's process tree is stopped within a few seconds, the job ends `canceled`, its worktree and branch are kept, and nothing is published. See [Canceling a job](docs/operations.md#canceling-a-job) |
| `updraft clean [--dry-run] [--older-than AGE]` | Remove job worktrees of succeeded runs and runs whose agent never started. Keeps the worktrees of failed, interrupted and user-canceled runs, and all branches. With `--older-than` (e.g. `30d`, `12h`, `2w`) also prunes old jobs, runs, logs and errors. See [Per-job worktrees](docs/worktrees.md) and [Retention](docs/operations.md#retention) |

## Configuration

YAML, validated on load. A complete example is in
[examples/config.yaml](examples/config.yaml).

```yaml
version: 1
pollIntervalSeconds: 60
maxConcurrent: 2
execution:
  mode: log-only
dispatch:
  allowedActors: [your-github-login]
agents:
  codex: { maxConcurrent: 1 }
  claude: { maxConcurrent: 1 }
pools:
  art: { agents: [codex] }
  general: { agents: [claude], strategy: round-robin }
actions:
  implement-issue:
    prompt: ./prompts/implement-issue.md
    output: local-branch
repositories:
  OWNER/REPO:
    id: 123456789
    workflows:
      - id: implement
        trigger: { event: issue.labeled, label: "ready" }
        action: implement-issue
        pool:
          rules:
            - { hasLabel: art, use: art }
          default: general
```

| Key | Default | Meaning |
| --- | --- | --- |
| `version` | required | Config schema version; must be `1` |
| `pollIntervalSeconds` | `60` | GitHub poll interval, 10-3600 |
| `maxConcurrent` | `2` | Global cap on simultaneous runs, 1-64 |
| `execution.mode` | `log-only` | `log-only` writes run.log only. `prepare-only` also creates the job's branch and worktree; no agent runs in either. `live` also runs the routed agent in the worktree; it needs at least one enabled agent. See [docs/live-execution.md](docs/live-execution.md) |
| `dispatch.allowedActors` | `[]` | GitHub logins allowed to dispatch work by applying a trigger label. Empty means nobody |
| `agents.<name>.adapter` | the agent's name | `codex`, `claude` or `kiro` |
| `agents.<name>.enabled` | `true` | Disabled agents are never chosen |
| `agents.<name>.maxConcurrent` | `1` | Per-agent cap across all pools and repos, 1-32 |
| `agents.<name>.command` | found by discovery | Live mode: the agent CLI to run. An absolute path, a path relative to the config file's directory, or a name looked up on `PATH`. Windows npm `.cmd` shims are resolved to the real executable or Node entry point. With `container`, a name or path inside the image, used as written |
| `agents.<name>.args` | none | Live mode: extra arguments for the agent CLI; the adapter places them where its CLI takes options |
| `agents.<name>.env` | none | Live mode: environment variables for the agent process, on top of the worker's. Not for secrets such as `KIRO_API_KEY`; see [Agent credentials](docs/background-operation.md#agent-credentials). With `container`, set inside the container |
| `agents.<name>.container.image` | none | Live mode: run this agent, and the action's `verify` commands, in a container from this image instead of on the host (see [Isolating agents](docs/isolation.md)). The image must contain the agent CLI, `git` and the repository's toolchain, and must already be present locally; a run never pulls. Not supported on native Windows (use WSL2) |
| `agents.<name>.container.runtime` | `docker` | `docker` or `podman` looked up on `PATH`, or a path relative to the config file's directory |
| `agents.<name>.container.env` | `[]` | Names of variables to pass from the worker's environment into the agent's container, such as its API key. Names only, never values. Nothing else of the worker's environment reaches the container |
| `agents.<name>.container.network` | the runtime's default | Passed as `--network`, for example `none`, `bridge` or a network you created |
| `agents.<name>.container.args` | none | Extra arguments for `<runtime> run`, such as `["--memory", "4g"]`. They can widen what the container reaches |
| `pools.<name>.agents` | required | Agent names in the pool (at least one) |
| `pools.<name>.strategy` | `round-robin` | Rotates among agents with free capacity |
| `actions.<name>.prompt` | none | Prompt file, relative to the config file's directory |
| `actions.<name>.output` | `local-branch` | `local-branch` or `log`. Live mode starts agents only for `local-branch` actions |
| `actions.<name>.timeoutMinutes` | `60` | Live mode: stop the agent and fail the run after this long |
| `actions.<name>.verify` | none | Live mode, `local-branch` actions: commands the worker runs in the job worktree after the agent succeeded, in order; the first that fails fails the run, so it is not published. A string runs through the shell (`sh -c`, or `cmd.exe /d /s /c` on Windows); an array is an executable and its arguments, run without a shell. Set in another mode or on a `log` action, it is a validation warning and does nothing. See [Verification](docs/verification.md) |
| `actions.<name>.verifyTimeoutMinutes` | `15` | Time limit for all of the action's verify commands together; at the limit the running command's process tree is killed and the run fails |
| `repositories.<OWNER/REPO>.id` | required | Stable GitHub repository ID (filled in by `configure` / `add`) |
| `repositories.<OWNER/REPO>.baseBranch` | remote's default branch | Branch that per-job branches start from (fetched first) |
| `repositories.<OWNER/REPO>.checkoutPath` | none | Local clone of the repo that per-job worktrees are created from, relative to the config file's directory. Required in `prepare-only` and `live` mode when a workflow's action has `output: local-branch` |
| `repositories.<OWNER/REPO>.remote` | a github.com remote | Remote of `checkoutPath` to fetch from. Without it, only a remote whose URL is on `github.com` with path `OWNER/REPO` qualifies (`origin` preferred). Set it for an SSH host alias such as `git@github-work:OWNER/REPO`; any host is then accepted, but `OWNER/REPO` must still match |
| `repositories.<OWNER/REPO>.publish` | `none` | Live mode, `local-branch` actions: `draft-pr` pushes the job branch of a succeeded run that left commits and opens a draft PR; `pr` opens a ready-for-review PR instead (for private repos where your plan has no draft PRs). Set in another mode, it is a validation warning and does nothing. See [docs/publication.md](docs/publication.md) |
| `repositories.<OWNER/REPO>.commentOnFailure` | `false` | Live mode: when a run leaves its job failed (agent error, timeout, failed verification, worktree preparation failure, or no agent could start), the worker comments once on the issue with the run id, agent, duration, reason and how to retry. Never includes agent output or local paths. Set in another mode, it is a validation warning and does nothing. See [Failure comments](docs/failure-comments.md) |
| `repositories.<OWNER/REPO>.backfillSince` | none | ISO timestamp. New subscriptions start at the current event; set this to enqueue matching events since then on the first poll |
| `workflows[].id` | `ACTION:LABEL` | Stable ID used to deduplicate events. Set it to keep dedupe stable if you rename the label or action |
| `workflows[].trigger` | required | `{ event: issue.labeled, label: <label> }` |
| `workflows[].action` | required | Action name |
| `workflows[].pool` | required | A pool name, or `{ rules: [{ hasLabel, use }], default }`. The first matching rule wins; routing uses the issue's labels when the job is queued |
| `workflows[].allowedActors` | `dispatch.allowedActors` | Per-workflow override of the allowlist |

Names of agents, pools, actions and workflow IDs use letters, digits, `.`, `_` and `-`.
Config changes take effect when the worker restarts.

## Per-job worktrees

In `prepare-only` and `live` mode, each job whose action has `output: local-branch` gets a
new branch `updraft/issue-<n>-<jobId>`, created at the freshly fetched base branch, and a
worktree for it under `<state dir>/worktrees`. Your clone's own checkout is not touched, and
an existing branch is never reused. Worktrees of failed and interrupted runs are kept for
inspection; `updraft clean` removes the others and keeps every branch, since the branch is
the job's output. Details, including how the remote is chosen:
[docs/worktrees.md](docs/worktrees.md).

## Live execution

In `live` mode the worker runs the routed agent for each job whose action has
`output: local-branch`:

- It writes the action's prompt and the issue's title, body, labels and URL to a prompt file.
  The issue text is fenced and labelled as untrusted input, and reaches the agent on stdin or
  by path, never in a command line.
- It starts the agent CLI directly (no shell) in the job's worktree, with the worker's
  environment minus `GH_TOKEN` and `GITHUB_TOKEN`, and writes its output to `run.log`. If the
  CLI can't be found or started, the job is requeued for the next eligible agent.
- The agent's exit code and, where its CLI reports one, its machine-readable result decide
  whether the run `succeeded` or `failed`. At `timeoutMinutes` the agent's process tree is
  killed and the run fails. Stopping the worker stops its agents and records their runs as
  `interrupted`.
- A summary of the commits, changed files and the agent's final message is appended to
  `run.log` and shown by `updraft status`.

Every agent runs in **full-auto mode by default**: it edits files and runs commands without
asking, as your user. That is not a sandbox. `agents.<name>.args` narrows it.

The full lifecycle, the requirements `updraft validate` checks and how agents are stopped are
in [docs/live-execution.md](docs/live-execution.md). Prerequisites, the exact command line,
the permission profile and platform notes for each agent:

- [docs/agents/claude.md](docs/agents/claude.md) for Claude Code
- [docs/agents/codex.md](docs/agents/codex.md) for Codex
- [docs/agents/kiro.md](docs/agents/kiro.md) for Kiro

## Publication

Off by default. With `repositories.<OWNER/REPO>.publish` set to `draft-pr` or `pr`, the
worker publishes a live run that **succeeded and left at least one commit** on the job
branch. The worker does this after the agent has exited, as your `gh` account:

- it pushes the job branch to the repository's remote. The push only ever creates the branch;
  it never moves an existing branch and never pushes the base branch;
- it opens a PR from the job branch into the base branch (a draft for `draft-pr`);
- it comments on the issue with a link to the PR.

Each step is recorded and checks GitHub before writing, so a retry never opens a second PR
or comment. Transient failures are retried by the worker; others wait for
`updraft publish RUN_ID`. Merging stays a human decision: the worker never merges, approves
or marks a PR ready for review.

Details, including authentication, retries and failure handling:
[docs/publication.md](docs/publication.md).

## Background operation

`updraft start` runs in the foreground. To start it at login, use the launchers shipped in
`examples/launchers/` (also inside the installed package):

| Platform | Launcher |
| --- | --- |
| Windows | `windows/register-task.ps1` registers a Task Scheduler task at logon for your account (no stored password), with restart on failure, no time limit and no overlapping runs. `unregister-task.ps1` removes it |
| macOS | `macos/install-launchagent.sh` installs a per-user LaunchAgent from `updraft.plist.template` (`--uninstall` removes it) |
| Linux (systemd) | `linux/install-systemd-user.sh` installs a `systemd --user` service; `loginctl enable-linger` keeps it running without a login session |
| Other hosts | Run `updraft start --config <path>` in the foreground under your existing supervisor |

Each launcher runs `node <package>/dist/cli.js start --config <path>` with absolute paths, a
working directory and an explicit `PATH`. Run `updraft doctor` under the same account and
environment before relying on it. Details, log locations and troubleshooting:
[docs/background-operation.md](docs/background-operation.md).

## Security

The key points; [docs/security.md](docs/security.md) has the full statement of each.

- Only GitHub logins in `dispatch.allowedActors` (or a workflow's `allowedActors`) can
  dispatch work, and with an empty list no events are queued. In live mode the check is
  repeated right before an agent starts.
- Applying the label approves the issue text as it is then. In live mode a job is canceled
  if the title or body was edited afterwards by someone who is not an allowed actor;
  re-apply the label to dispatch the edited issue.
- Issue titles, bodies and labels are untrusted input. They reach the agent only through a
  prompt file, fenced and labelled as untrusted, never a command line.
- In live mode the agent runs as your user, in full-auto mode by default. That is not a
  sandbox: it can run any command, reach the network and read or write outside the worktree.
  The allowlist of actors is the guard on who can start such a run.
- The agent is not given `GH_TOKEN`/`GITHUB_TOKEN`. That is a guard against accidental use,
  not isolation: it can still reach whatever your user can, including `gh auth token`, Git
  credential helpers and SSH keys. Only an isolation boundary such as a separate account, VM
  or container would prevent that.
- `agents.<name>.container` puts that boundary in place: the agent and the verify commands run
  in containers that see only the job's worktree and what a commit needs. See
  [Isolating agents](docs/isolation.md) for what that does and does not protect against.
- Without `publish`, the worker only reads from GitHub and never pushes. With `publish`, it
  creates job branches, opens PRs and comments on issues as your `gh` account. It never
  merges.
- Agent credentials such as `KIRO_API_KEY` belong in the worker's environment, not in the
  config file. The CLI does not store tokens.

## Files and locations

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Config | `%APPDATA%\updraft\config.yaml` | `~/Library/Application Support/updraft/config.yaml` | `$XDG_CONFIG_HOME/updraft/config.yaml` (default `~/.config`) |
| State (`state.db`, `worktrees/`) | `%LOCALAPPDATA%\updraft\` | `~/Library/Application Support/updraft/` | `$XDG_STATE_HOME/updraft/` (default `~/.local/state`) |
| Logs (`updraft.log`, `runs/`) | `%LOCALAPPDATA%\updraft\logs\` | `~/Library/Logs/updraft/` | `$XDG_STATE_HOME/updraft/logs/` |

Overrides:

- `UPDRAFT_HOME=<dir>` puts config (`<dir>/config.yaml`), state (`<dir>/state.db`) and logs
  (`<dir>/logs/`) under one directory.
- `--config <path>` or `UPDRAFT_CONFIG=<path>` changes only the config file; `--config` wins.
  Relative paths in the config (such as prompt files) resolve against the config file's
  directory.

## Upgrading from software-factory-cli

Updraft was first called `software-factory-cli`, with the command `factory`. The rename is a
clean break: nothing reads the old names. To move an existing install:

1. Stop the worker and remove its launcher using the old package's scripts (the Task Scheduler
   task, LaunchAgent or systemd unit), then `npm uninstall -g software-factory-cli` and
   `npm install -g @allenheltondev/updraft`.
2. Rename the `software-factory` config and state directories to `updraft` (see
   [Files and locations](#files-and-locations)). The worker log is now `updraft.log`.
3. Replace `FACTORY_HOME` and `FACTORY_CONFIG` with `UPDRAFT_HOME` and `UPDRAFT_CONFIG`
   wherever you set them, and install the launcher again from the new package.
4. Let queued and running jobs finish before you switch, or re-apply the label afterwards.
   Job branches are now `updraft/issue-<n>-<jobId>` and the hidden markers in PRs and comments
   are `updraft-run`, so a job started under the old name is not matched: publishing it again
   would not find its `factory/issue-...` branch or its existing PR.

## Development

```sh
npm ci
npm run typecheck   # tsc --noEmit
npm run lint        # eslint: type-aware correctness rules, no formatting rules
npm test            # vitest
npm run build       # compile to dist/
node scripts/pack-smoke.mjs   # npm pack, install into a temp prefix, run version/validate/status
```

CI (`.github/workflows/ci.yml`) runs these on Windows, macOS and Linux with Node 22 and 24,
and checks each launcher against the built CLI using paths with spaces.

## License

MIT
