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

To try it without installing, run a pinned version once, for example
`npx @allenheltondev/updraft@<version> agents` (the package's only command is `updraft`). The
background worker needs the global install: the launchers point at the global package, npx's
cache folder can change or be cleared, and an unpinned npx can run a newer CLI that upgrades
the state database past what the worker supports. `updraft start` warns when it runs from
the npx cache.

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
| `updraft validate --json` | The same, as one JSON object: errors, warnings, and the validated config with its defaults filled in (values of `agents.<name>.env` replaced by `(set)`) |
| `updraft start` | Run the worker: poll GitHub and process the queue (non-interactive). Exits with code 3 if another worker holds the lock. With `OTEL_EXPORTER_OTLP_ENDPOINT` set, each run is sent as OpenTelemetry GenAI traces to that OTLP/HTTP endpoint (as is `run-event`'s). See [docs/agent-telemetry.md](docs/agent-telemetry.md#running-it-yourself) |
| `updraft run-event --event-file FILE [--event-name NAME] [--delivery-id ID] [--deadline-minutes N] [--json]` | Handle one GitHub webhook event to the end, then exit: apply the worker's dispatch rules to it, create the clone if it is missing, run the job, verify and publish, and run the review loop (reviewer, revision, auto-merge) where it is configured. Handles `issues.labeled`, `pull_request_review` (submitted, edited, dismissed) and `pull_request` (synchronize, closed, reopened). No polling; for a machine started per event, with an empty state directory or a copy of a shared state database. Exits 0 when there was nothing to do or the job succeeded, 4 when the work waits for a usage-limit cooldown (deliver the event again later). See [docs/run-event.md](docs/run-event.md) |
| `updraft state merge --changed FILE --into FILE [--base FILE] [--json]` | Apply what one finished run changed in its copy of the state database to the latest shared copy: a three-way merge by key against the snapshot the run started from (`--base`), with a rule per table. `--into` is replaced only when the merge succeeded, as one self-contained file; exits 5 and changes nothing when it is newer than this CLI. See [docs/shared-state.md](docs/shared-state.md) |
| `updraft state info --db FILE [--json]` | Schema version, rows per table, jobs by status and open runs of a state database file. Read-only |
| `updraft status [--json]` | Worker state, watched repos and checkpoints, agents, queue counts, active runs, recent jobs and errors. Works offline |
| `updraft doctor [--json]` | Check Node, config, state, Git, `gh`, GitHub access (with `github.app`: the App's key, its installation on each repository and the permissions it grants), labels and each enabled agent in the current environment, the way a live run starts it (its `command` and `env`) |
| `updraft agents [--json] [--deep]` | List Claude Code, Codex and Kiro on this machine: path, version, sign-in status and platform support. `--deep` sends one short prompt to each usable agent (uses tokens) |
| `updraft retry JOB_ID` | Requeue a failed, interrupted or canceled job |
| `updraft publish RUN_ID` | Push the branch of a succeeded live run and open its PR, or finish a publication that failed part-way. Never opens a second PR or comment. See [docs/publication.md](docs/publication.md) |
| `updraft reviews [--json] [--limit N]` | For each PR Updraft published (newest first, default 20), show its head SHA and the current result from an outside reviewer: blockers yes/no, reviewer and link, or "no review for this head" / "not reviewed". Read-only: it changes neither the state database nor GitHub. See [docs/review-result.md](docs/review-result.md) |
| `updraft stats [--json] [--since AGE] [--repo OWNER/REPO]` | How the factory is doing over a window (default `30d`; `h`, `d`, `w` or `all`), overall and per repository: work items done, agent run time and queue wait (average, median, p90) per kind and agent, lead times, PRs opened, merged and blocked from auto-merge, failed runs, reviewer verdicts and findings, change-request rounds and revisions per PR. Read-only and local: nothing leaves the machine. Based on a rollup that `clean --older-than` never prunes. See [docs/stats.md](docs/stats.md) |
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
| `controls.enabled` | `false` | Read issue and pull request comments for mention commands (`@<handle> pause`, `resume`, `stop`, `cancel`, `review`, `steer`) from allowed actors. `controls.handle` overrides the handle (default: the worker's login or App slug). See [Steering by mention](docs/controls.md) |
| `review.reviewers` | `[]` | GitHub logins whose PR reviews carry a trusted `updraft-review-result` block (case-insensitive), shown by `updraft reviews`. Empty means no review result is trusted. Separate from `repositories.<OWNER/REPO>.review`, Updraft's own reviewer. See [docs/review-result.md](docs/review-result.md) |
| `github.app.appId` | none | Act on GitHub as a GitHub App installation (`<app-slug>[bot]`) instead of your `gh` account: polling, pushes, PRs and comments. The App's ID or client ID. Needs `privateKeyPath` or `tokenFile`. See [docs/github-app.md](docs/github-app.md) |
| `github.app.privateKeyPath` | none | Path of the App's PEM private key file, relative to the config file's directory. The key itself is never in the config. `UPDRAFT_GITHUB_APP_PRIVATE_KEY_PATH` in the worker's environment names another file |
| `github.app.tokenFile` | none | Instead of the key: a file of installation tokens that something else mints and replaces before they expire, so the worker never holds the key and reaches only what the token reaches. `UPDRAFT_GITHUB_APP_TOKEN_FILE` in the worker's environment names another file. See [docs/github-app.md](docs/github-app.md#a-token-file-instead-of-the-key) |
| `github.app.installationId` | looked up per repository | Use this installation for every repository. Leave it out when repositories are under different owners |
| `github.app.commitAsApp` | `false` | Live mode: agents commit as the App's bot (through `GIT_AUTHOR_*` and `GIT_COMMITTER_*` in the agent's environment) instead of the local Git identity. Commits are never rewritten afterwards |
| `agents.<name>.adapter` | the agent's name | `codex`, `claude`, `kiro` or `vibe` (local Updraft) |
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
| `actions.<name>.revisePrompt` | none | Prompt file for revision runs, relative to the config file's directory. Required in live mode for every action used by a repository with `revise` on. See [Revisions](docs/revisions.md) |
| `actions.<name>.reviewPrompt` | none | Prompt file for reviewer runs, relative to the config file's directory. Required in live mode for every action used by a repository with `review` on. See [The review loop](docs/review-loop.md) |
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
| Assignment comment (no setting) | always in live mode | When a live implementation run passes its final dispatch check, the worker comments once on the issue with the routing decision and the selection actually made (complexity, capability tier, agent, adapter, configured model and effort, pool, routing reason, job ID, run ID); needs the same Issues write permission as the failure comment. Failures never affect the run. See [Assignment comments](docs/assignment-comments.md) |
| `repositories.<OWNER/REPO>.revise` | `false` | Live mode, together with `publish`: when an allowed actor requests changes on a PR the worker opened, run the agent on that PR's branch with the review, verify, push the new commits to the PR as a fast-forward and reply there. Set in another mode or without `publish`, it is a validation warning and does nothing. See [Revisions](docs/revisions.md) |
| `repositories.<OWNER/REPO>.maxRevisions` | `3` | With `revise`: how many revision jobs one PR gets. Further change requests are recorded and shown in `updraft status` but not acted on, and one comment on the PR says so |
| `repositories.<OWNER/REPO>.review` | `false` | Live mode, together with `publish`: a second agent reviews every head commit of a PR the worker opened and its verdict is posted as a comment review. "Changes requested" queues a revision when `revise` is on; "ready to merge" marks a draft ready for review. `true`, or an object: `{ pool: <name> }` routes reviews of every workflow without a `reviewPool` to that pool (one agent fixes the reviewer, several take turns), and `{ allowSameAgent: true }` lets the agent that wrote the code review it when the pool has no other. `{ acceptance: enforce | report | off }` sets how the issue's acceptance criteria are checked (default `enforce`: a head with a mandatory criterion not independently verified is never ready; see [Acceptance criteria](docs/acceptance.md)). Set in another mode or without `publish`, it is a validation warning and does nothing. See [The review loop](docs/review-loop.md) |
| `repositories.<OWNER/REPO>.autoMerge` | off | With `review`: `squash`, `merge` or `rebase`. Updraft merges a PR whose current head its reviewer found ready, once the head's checks passed and nothing else stands in the way, with the reviewed commit pinned. The issue and the code are untrusted and could talk a reviewer into approving: read [Auto-merge](docs/review-loop.md#auto-merge) before setting it |
| `repositories.<OWNER/REPO>.autoMergeWaitMinutes` | `60` | With `autoMerge`: how long to wait for pending checks before giving up and leaving the PR for a person |
| `repositories.<OWNER/REPO>.ciFix` | off | With `review`: GitHub's checks are part of the loop. A head found ready is not marked ready (or merged) until its checks pass; a failure gets a revision with the failed checks' annotations and log excerpts (with `revise`), counted against `maxRevisions`. `true`, or `{ checks, ignore, waitMinutes }`. See [CI in the review loop](docs/ci-fix.md) |
| `repositories.<OWNER/REPO>.autoMergeRequiredChecks` | none | With `autoMerge`: names of the commit statuses or check runs (for example `test`) that must each report success on the commit. Without it, any one successful check is enough. A skipped or neutral check never counts as a success |
| `repositories.<OWNER/REPO>.dependencies` | off | Live mode: `{ repositories: [OWNER/REPO, ...], checkIntervalMinutes: 5, maxWaitDays: 30 }`. A run that finds its issue needs a pull request in one of those repositories first ends with an `UPDRAFT-WAITING-ON: OWNER/REPO#N` line; the worker publishes nothing for it, comments on the issue, checks the pull request every `checkIntervalMinutes`, and runs the issue again once it is merged (or comments and stops waiting if it is closed unmerged or outlasts `maxWaitDays`). Pull requests in other repositories are never waited on. See [Waiting on another repository](docs/dependencies.md) |
| `repositories.<OWNER/REPO>.backfillSince` | none | ISO timestamp. New subscriptions start at the current event; set this to enqueue matching events since then on the first poll. "First poll" means whenever `state.db` has no checkpoint for the repository, including with a new or deleted `state.db`, which then has no record of jobs already run. Remove it once the first poll has run |
| `workflows[].id` | `ACTION:LABEL` | Stable ID used to deduplicate events. Set it to keep dedupe stable if you rename the label or action |
| `workflows[].trigger` | required | `{ event: issue.labeled, label: <label> }` |
| `workflows[].action` | required | Action name |
| `workflows[].pool` | required | A pool name, or `{ rules: [{ hasLabel, use }], default }`. The first matching rule wins; routing uses the issue's labels when the job is queued |
| `workflows[].reviewPool` | `review.pool`, else the job's pool | With `review`: the pool reviewer runs are routed to, in turn on a rotation of their own. The agent that wrote the code is never picked while the pool has another enabled agent; a configuration where it is the only one is invalid unless `review.allowSameAgent` is set |
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
- [docs/agents/vibe.md](docs/agents/vibe.md) for Mistral Vibe

## Publication

Off by default. With `repositories.<OWNER/REPO>.publish` set to `draft-pr` or `pr`, the
worker publishes a live run that **succeeded and left at least one commit** on the job
branch. The worker does this after the agent has exited, as your `gh` account:

- it pushes the job branch to the repository's remote. The push only ever creates the branch;
  it never moves an existing branch (unless `revise` is on, see below) and never pushes the
  base branch;
- it opens a PR from the job branch into the base branch (a draft for `draft-pr`);
- it comments on the issue with a link to the PR.

Each step is recorded and checks GitHub before writing, so a retry never opens a second PR
or comment. Transient failures are retried by the worker; others wait for
`updraft publish RUN_ID`. Merging stays a human decision: publication never merges, approves
or marks a PR ready for review (the opt-in review loop below can do the last, and with
`autoMerge` the first).

Details, including authentication, retries and failure handling:
[docs/publication.md](docs/publication.md).

To have the PRs and comments authored by a bot instead of you (so that you can approve them,
and with short-lived credentials limited to the watched repositories), configure a GitHub
App: [docs/github-app.md](docs/github-app.md).

With `revise: true` as well, a "Request changes" review by an allowed actor on such a PR
queues a revision: the agent runs on the PR's branch with the review, and the worker pushes
the new commits as a fast-forward and replies on the PR. See
[docs/revisions.md](docs/revisions.md).

With `review: true`, the loop closes without a person in it: a second agent (never the one
that wrote the code, unless you allow that) reviews every head of such a PR in a throwaway
worktree and ends with a verdict. "Changes requested" queues a revision, up to `maxRevisions`
rounds; "ready to merge" marks the draft ready for review, and there it stops. GitHub does
not let an account approve its own PR, so the verdict is recorded by Updraft and posted as a
comment review. Merging is still up to a person unless `autoMerge` is set, which is off by
default and should stay off until you have read what its checks do and do not cover. See
[docs/review-loop.md](docs/review-loop.md).

When the right fix needs a change in another repository first, set `dependencies` to the
repositories whose pull requests may be waited on. The run opens the pull request there and ends
with `UPDRAFT-WAITING-ON: OWNER/REPO#N`. The worker publishes nothing for that run, shows the job
as waiting in `updraft status`, and once that pull request merges, it runs the issue again with
the merge noted in the prompt. See [docs/dependencies.md](docs/dependencies.md).

## Background operation

`updraft start` runs in the foreground. To start it at login, use the launchers shipped in
`examples/launchers/` (also inside the installed package):

| Platform | Launcher |
| --- | --- |
| Windows | `windows/register-task.ps1` registers a Task Scheduler task at logon for your account (no stored password), repeating every 5 minutes, with no time limit and no overlapping runs. Its wrapper restarts the worker after a crash, with backoff. `unregister-task.ps1` removes it |
| macOS | `macos/install-launchagent.sh` installs a per-user LaunchAgent from `updraft.plist.template` (`--uninstall` removes it) |
| Linux (systemd) | `linux/install-systemd-user.sh` installs a `systemd --user` service; `loginctl enable-linger` keeps it running without a login session |
| Other hosts | Run `updraft start --config <path>` in the foreground under your existing supervisor |
| Container | Run `updraft start` with `UPDRAFT_HOME` on a local volume; see [In a container](docs/background-operation.md#in-a-container) |

Each launcher runs `node <package>/dist/cli.js start --config <path>` with absolute paths, a
working directory and an explicit `PATH`. Run `updraft doctor` under the same account and
environment before relying on it. Details, log locations and troubleshooting:
[docs/background-operation.md](docs/background-operation.md).

## Running jobs in AWS Lambda MicroVMs

[deploy/aws-microvm/](deploy/aws-microvm/README.md) is a reference deployment without a
long-lived worker: a GitHub App webhook reaches a small Lambda function, which starts one AWS
Lambda MicroVM per labelled issue; the microVM runs `updraft run-event`, opens the pull
request and terminates itself. It was written from the service's documentation and has not
yet been run on AWS; its README lists what is tested and what is not.

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
  merges, unless you set `autoMerge`.
- `autoMerge` (off by default, needs `review`) lets Updraft merge a PR that its own reviewing
  agent found ready. That agent read untrusted issue text and untrusted code, either of which
  can be written to talk it into approving. The checks before the merge are listed, with what
  they do not cover, in [docs/review-loop.md](docs/review-loop.md#auto-merge).
- Agent credentials such as `KIRO_API_KEY` belong in the worker's environment, not in the
  config file. The CLI does not store tokens.
- With `github.app`, the worker acts as a GitHub App installation instead of your account,
  with one-hour tokens limited to the repositories the App is installed on. The App's private
  key stays in a file only you can read, never in the config; an agent running as your user
  can still read that file unless it runs in a container or the worker has its own OS
  account. The bot cannot dispatch work unless you list it in `allowedActors`. See
  [docs/github-app.md](docs/github-app.md#security).

## Files and locations

Everything lives in one directory, `~/.updraft`, on every OS (`%USERPROFILE%\.updraft` on
Windows, for example `C:\Users\you\.updraft`):

```text
~/.updraft/
  config.yaml      config
  prompts/         starter prompts written by configure / add
  state.db         queue, runs and checkpoints
  worktrees/       per-job worktrees
  logs/
    updraft.log    worker log
    runs/<runId>/  one run.log per run
```

On Windows it is deliberately outside `AppData`: Windows redirects new `AppData` folders that a
packaged (MSIX) app creates into that app's private storage, so a CLI run from such an app
(a desktop IDE or agent host) and one run from a terminal would each see their own files.

Overrides:

- `UPDRAFT_HOME=<dir>` moves the whole directory: config (`<dir>/config.yaml`), state
  (`<dir>/state.db`) and logs (`<dir>/logs/`).
- `--config <path>` or `UPDRAFT_CONFIG=<path>` changes only the config file; `--config` wins.
  Relative paths in the config (such as prompt files) resolve against the config file's
  directory.

## Moving from the per-OS locations

Earlier builds kept their files in per-OS folders:

| | Config folder (`config.yaml`, `prompts/`) | State folder (`state.db`, `worktrees/`, `logs/`) |
| --- | --- | --- |
| Windows | `%APPDATA%\updraft` | `%LOCALAPPDATA%\updraft` |
| macOS | `~/Library/Application Support/updraft` | the same folder; logs in `~/Library/Logs/updraft` |
| Linux | `~/.config/updraft` | `~/.local/state/updraft` |

Nothing reads those folders by default any more. When `~/.updraft` has no config and the old
config folder does, `updraft doctor`, `configure`, `add` and every command that stops for lack
of a config say where it is. Don't just move the files into `~/.updraft`:

- `state.db` records each run's log file and worktree by absolute path, so after a move
  `updraft logs` can't find old runs and `updraft clean` skips their worktrees.
- Relative paths in `config.yaml`, such as `checkoutPath: ../my-clone`, resolve against the
  config file's folder, so moving the file changes where they point.

Choose one of these instead:

**Keep the install where it is.** Nothing is lost. Point Updraft at the old folders, in your
user environment and in the launcher:

| | Set |
| --- | --- |
| Environment | `UPDRAFT_CONFIG=<config folder>/config.yaml` and `UPDRAFT_HOME=<state folder>` |
| Windows launcher | `register-task.ps1 -ConfigPath <config folder>\config.yaml -UpdraftHome <state folder>` |
| macOS launcher | `install-launchagent.sh --config <config folder>/config.yaml --updraft-home <state folder>` |
| Linux launcher | `install-systemd-user.sh --config <config folder>/config.yaml --updraft-home <state folder> --env-file ~/.config/updraft/worker.env` |

Config-relative paths, state and worktrees then resolve exactly as before. On macOS, logs of new
runs go to `<state folder>/logs`; logs of earlier runs stay in `~/Library/Logs/updraft` and are
still found. On Windows the folders stay under `AppData`, with the redirection problem
described above for packaged apps.

**Start over in `~/.updraft`.** Only the config moves. The queue, run history and stats stay
behind:

1. Let queued and running jobs finish, or cancel them. Publish any succeeded run you still
   want (`updraft publish RUN_ID`). Optionally run `updraft clean` to remove finished
   worktrees. Then stop the worker and remove its launcher.
2. Copy `config.yaml` and `prompts/` into `~/.updraft`. Then make every config-relative path
   absolute, or rewrite it relative to `~/.updraft`:
   - `repositories.*.checkoutPath`;
   - `actions.*.prompt`, `revisePrompt` and `reviewPrompt` (unchanged if they point into the
     copied `prompts/`);
   - `agents.*.command` and `agents.*.container.runtime` when they are paths;
   - `github.app.privateKeyPath`, and move the key file if it lived in the old folder.

   Then remove every `repositories.*.backfillSince` from the copied config, or move it to a
   cutoff after the last job the old install handled. A repository with no checkpoint is
   scanned back to its `backfillSince`, and the new `state.db` has no record of the jobs the
   old install already queued. Label events since that date would be dispatched again and
   open duplicate PRs.
3. Leave `state.db`, `logs/` and `worktrees/` where they are. `~/.updraft` gets a new, empty
   `state.db`:
   - with no `backfillSince`, polling starts at each repository's current event, so earlier
     label events are not queued again;
   - `updraft logs`, `retry`, `publish`, `status` and `stats` no longer know earlier jobs;
   - PRs opened before the switch get no further revisions or reviews.

   Earlier runs' logs stay readable as files in the old state folder. Their branches are
   untouched. Remove leftover worktrees with `git worktree remove <path>` from the clone.
4. Run `updraft validate` and `updraft doctor`, which check each `checkoutPath` and prompt
   file, then reinstall the launcher.

## Upgrading from software-factory-cli

Updraft was first called `software-factory-cli`, with the command `factory`. The rename is a
clean break: nothing reads the old names. To move an existing install:

1. Stop the worker and remove its launcher using the old package's scripts (the Task Scheduler
   task, LaunchAgent or systemd unit), then `npm uninstall -g software-factory-cli` and
   `npm install -g @allenheltondev/updraft`.
2. Keep the `software-factory` config and state folders where they are, or start over in
   `~/.updraft`, as described in [Moving from the per-OS locations](#moving-from-the-per-os-locations),
   with `software-factory` in place of `updraft` in the folder names. Don't just move or rename
   them, for the same reasons. The worker log is now `updraft.log`.
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
