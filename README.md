# software-factory-cli

`factory` watches GitHub repositories you choose and turns labeled issues into queued jobs
for coding agents (Codex, Claude Code, Kiro). It runs on your machine, uses your `gh`
sign-in, and keeps its queue in a local SQLite database.

## Status

Pilot. This release covers repository discovery, config validation, issue-event polling, a
durable queue and a **log-only** worker: jobs are claimed, routed to a pool and agent, and
recorded, but no agent is started and no code is changed. The opt-in **prepare-only** mode
also creates a branch and Git worktree per job (still without an agent). The **live** mode
runs the routed agent in that worktree; this release ships the Claude Code and Kiro adapters
(see [Live mode with Claude Code](#live-mode-with-claude-code) and
[Live mode with Kiro](#live-mode-with-kiro)), so a live config validates only while Codex is
disabled. The Codex adapter and PR creation come next. See [docs/design.md](docs/design.md).

## Install

Requires Node.js 22.13 or later, Git, and the [GitHub CLI](https://cli.github.com/).

```sh
npm install -g software-factory-cli
gh auth login
factory doctor
```

## Quick start

1. `factory configure` - pick repositories, the trigger label, actions and pools. It writes
   your per-user config. For scripts, use `factory add OWNER/REPO` instead.
2. Add your GitHub login to `dispatch.allowedActors` in the config (only these users can
   dispatch work), then run `factory validate`.
3. `factory start` - polls GitHub and processes the queue until you stop it (Ctrl+C).
4. Add the `ready` label to an open issue. Within one poll interval, `factory status`
   shows the queued job and, in log-only mode, its run.

To run the worker in the background at login, see
[Background operation](#background-operation).

## Commands

All commands accept `--config <path>` (or `FACTORY_CONFIG`) to use a config file other than
the per-user default.

| Command | Behavior |
| --- | --- |
| `factory configure` | Interactively select repos, trigger labels, actions and pools (needs a terminal) |
| `factory add OWNER/REPO` | Add or update a repo workflow non-interactively. Options: `--label` (default `ready`), `--action` (default `implement-issue`), `--pool` (default `general`), `--route LABEL=POOL` (repeatable), `--backfill-since DATE`, `--workflow-id ID` |
| `factory validate` | Check the config without network access; exit 1 if invalid |
| `factory start` | Run the worker: poll GitHub and process the queue (non-interactive). Exits with code 3 if another worker holds the lock |
| `factory status [--json]` | Worker state, watched repos and checkpoints, agents, queue counts, active runs, recent jobs and errors. Works offline |
| `factory doctor [--json]` | Check Node, config, state, Git, `gh`, GitHub access, labels and agent commands in the current environment |
| `factory agents [--json] [--deep]` | List Claude Code, Codex and Kiro on this machine: path, version, sign-in status and platform support. `--deep` sends one short prompt to each usable agent (uses tokens) |
| `factory retry JOB_ID` | Requeue a failed, interrupted or canceled job |
| `factory clean [--dry-run]` | Remove job worktrees of succeeded or canceled runs. Keeps failed and interrupted runs' worktrees, and all branches. See [Per-job worktrees](#per-job-worktrees) |

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
| `execution.mode` | `log-only` | `log-only` writes run.log only. `prepare-only` also creates the job's branch and worktree; no agent runs in either. `live` also runs the routed agent in the worktree (see [Live execution](#live-execution)); it is rejected unless every enabled agent's adapter is implemented, which in this release means `claude` and `kiro` |
| `dispatch.allowedActors` | `[]` | GitHub logins allowed to dispatch work by applying a trigger label. Empty means nobody |
| `agents.<name>.adapter` | the agent's name | `codex`, `claude` or `kiro` |
| `agents.<name>.enabled` | `true` | Disabled agents are never chosen |
| `agents.<name>.maxConcurrent` | `1` | Per-agent cap across all pools and repos, 1-32 |
| `agents.<name>.command` | found by discovery | Live mode: the agent CLI to run. An absolute path, a path relative to the config file's directory, or a name looked up on `PATH`. Windows npm `.cmd` shims are resolved to the real executable or Node entry point |
| `agents.<name>.args` | none | Live mode: extra arguments for the agent CLI; the adapter places them where its CLI takes options |
| `agents.<name>.env` | none | Live mode: environment variables for the agent process, on top of the worker's. Not for secrets such as `KIRO_API_KEY`; see [Agent credentials](docs/background-operation.md#agent-credentials) |
| `pools.<name>.agents` | required | Agent names in the pool (at least one) |
| `pools.<name>.strategy` | `round-robin` | Rotates among agents with free capacity |
| `actions.<name>.prompt` | none | Prompt file, relative to the config file's directory |
| `actions.<name>.output` | `local-branch` | `local-branch` or `log`. Live mode starts agents only for `local-branch` actions |
| `actions.<name>.timeoutMinutes` | `60` | Live mode: stop the agent and fail the run after this long |
| `repositories.<OWNER/REPO>.id` | required | Stable GitHub repository ID (filled in by `configure` / `add`) |
| `repositories.<OWNER/REPO>.baseBranch` | remote's default branch | Branch that per-job branches start from (fetched first) |
| `repositories.<OWNER/REPO>.checkoutPath` | none | Local clone of the repo that per-job worktrees are created from, relative to the config file's directory. Required in `prepare-only` and `live` mode when a workflow's action has `output: local-branch` |
| `repositories.<OWNER/REPO>.remote` | a github.com remote | Remote of `checkoutPath` to fetch from. Without it, only a remote whose URL is on `github.com` with path `OWNER/REPO` qualifies (`origin` preferred). Set it for an SSH host alias such as `git@github-work:OWNER/REPO`; any host is then accepted, but `OWNER/REPO` must still match |
| `repositories.<OWNER/REPO>.backfillSince` | none | ISO timestamp. New subscriptions start at the current event; set this to enqueue matching events since then on the first poll |
| `workflows[].id` | `ACTION:LABEL` | Stable ID used to deduplicate events. Set it to keep dedupe stable if you rename the label or action |
| `workflows[].trigger` | required | `{ event: issue.labeled, label: <label> }` |
| `workflows[].action` | required | Action name |
| `workflows[].pool` | required | A pool name, or `{ rules: [{ hasLabel, use }], default }`. The first matching rule wins; routing uses the issue's labels when the job is queued |
| `workflows[].allowedActors` | `dispatch.allowedActors` | Per-workflow override of the allowlist |

Names of agents, pools, actions and workflow IDs use letters, digits, `.`, `_` and `-`.
Config changes take effect when the worker restarts.

## Per-job worktrees

In `prepare-only` and `live` mode, each job whose action has `output: local-branch` gets:

- a fetch of the base branch (`baseBranch`, else the remote's default branch) from the
  repo's remote in `checkoutPath`: the one named by `remote`, else a remote whose URL is on
  `github.com` with path `OWNER/REPO` (`origin` if several are). A same-named repo on another
  host is never picked on its own;
- a new branch `factory/issue-<n>-<jobId>` at the fetched commit. A retried job's later
  attempts add `-<attempt>`. An existing branch is never reused; the run fails instead;
- a worktree at `<state dir>/worktrees/<repoId>/<jobId>[-<attempt>]`, recorded as the run's
  checkout, and `run.log` describing it.

Your clone's own checkout is not touched. Git operations on one clone are serialized, so
concurrent jobs in one repo do not race. `factory doctor` checks that each `checkoutPath`
exists and is a Git repository, and shows which remote it selected (by the same rule) and
why; its repository check confirms the repo ID behind the configured name.

Worktrees of failed and interrupted runs are kept for inspection. `factory clean` removes
worktrees of succeeded runs, runs closed before they started (canceled), and runs whose agent
never started. It only touches worktrees under `<state dir>/worktrees`, skips any with
uncommitted changes, and keeps every branch, since the branch is the job's output. Delete
branches with `git branch -D` when you no longer need them.

## Live execution

In `live` mode the worker runs the routed agent for each `local-branch` job:

1. It renders the action's prompt file plus the issue's title, body, labels and URL into
   `prompt.md` in the run's log directory. The issue text is fenced and labelled as untrusted
   input. The adapter hands the file to the agent on stdin or by path, never in a command line.
2. It finds the agent CLI (`agents.<name>.command`, else the same lookup as `factory agents`).
   If it can't, or the process can't be spawned, the run is `start_failed` and the job is
   requeued for the next eligible agent (up to three start failures in a row).
3. It prepares the branch and worktree as above. A failure there fails the run.
4. It spawns the agent directly (no shell) in the worktree, records its pid and the OS start
   time of that process, and writes its stdout and stderr to `run.log`. `GH_TOKEN` and
   `GITHUB_TOKEN` are not passed to the agent unless `agents.<name>.env` sets them. If the
   worker can't record the pid, it stops the agent at once and fails the run (it is not a
   start failure, so no other agent is tried).
5. The adapter decides the outcome from the exit code and, where the CLI reports one, its
   machine-readable result (exit code 0 alone means `succeeded` otherwise). At
   `timeoutMinutes` the agent's process tree is killed and the run fails. Failed runs keep
   their worktree for inspection.
6. It appends a summary to `run.log` and stores it for `factory status`: commits on the job
   branch since the base commit, files changed (`git diff --stat` against the base, committed
   or not), untracked files, and the agent's final message (or its last output lines).

On macOS and Linux each agent runs in its own process group, so a timeout or shutdown also
stops whatever it started. Pressing Ctrl-C in a terminal therefore doesn't reach the agent
directly: the worker forwards its own shutdown (SIGINT or SIGTERM) to the agent's group as
SIGTERM, then SIGKILL after five seconds, and records the run `interrupted`. On Windows the
worker stops the agent's tree with `taskkill /t /f`. If the worker itself is killed, the
agent keeps running; the next `factory start` on the same host stops it, but only after
checking that the recorded pid still belongs to the same process (same start time), so a pid
the OS has since reused is never signalled. Runs recorded before this release have no start
time and are not signalled.

In live mode, `factory doctor` reports a missing, broken or signed-out agent CLI as a failure
rather than a warning.

### Live mode with Claude Code

Prerequisites, under the account and environment the worker runs as (the background
launchers' account, not just your terminal):

- Claude Code installed and signed in: `claude auth status` reports `loggedIn: true` (a
  claude.ai login, or `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` in the environment).
  `factory agents` and `factory doctor` run the same check.
- On Linux and macOS, a non-root user: Claude Code refuses the default full-auto profile as
  root or under `sudo`.
- Only `claude` and `kiro` enabled among the agents (Codex has no live adapter yet), a
  `checkoutPath` for the repository and a `prompt` for the action. `factory validate` checks
  all three.

Each job runs, in its worktree, with the prompt file on stdin:

```
claude -p --output-format stream-json --verbose --permission-mode bypassPermissions <agents.claude.args>
```

- `-p` is Claude Code's [headless mode](https://code.claude.com/docs/en/headless); with no
  prompt argument it reads the prompt from stdin.
- `stream-json` writes one JSON event per line to `run.log` as the run goes, so a run that
  times out still leaves a transcript. The last event is the run's result.
- The run is `succeeded` only when Claude Code exits 0 with a `success` result. An error
  result (`is_error`, such as a sign-in failure), the turn limit (`error_max_turns`), the
  spending limit (`error_max_budget_usd`) or an error during execution fails the run with
  that reason, and so does exiting 0 without a result the worker can read. The worker looks
  for the result in the last 16 MiB of output, past anything printed on stderr after it.
  The summary shows Claude's final message, then a line with the result, turns, estimated
  cost, any permission denials and the session id. To look at a run afterwards, run
  `claude --resume <session id>` in its worktree.

**Default permission profile: full auto.** `--permission-mode bypassPermissions` (the same as
`--dangerously-skip-permissions`) lets Claude edit files and run any command inside the job's
worktree without asking, as decided for the pilot. It is not a sandbox: commands run as your
user, can reach the network and can read or write outside the worktree. Anthropic recommends
this mode only in isolated environments; see
[permission modes](https://code.claude.com/docs/en/permission-modes#skip-all-checks-with-bypasspermissions-mode).

To narrow it, set a permission mode in `agents.claude.args`; any `--permission-mode` or
`--dangerously-skip-permissions` there replaces the default. Config arguments go last, after
the adapter's own:

```yaml
agents:
  claude:
    args:
      - --permission-mode
      - acceptEdits        # edits files without asking; other commands need an allow rule
      - --max-turns
      - "60"               # stop a run after 60 agentic turns (fails as error_max_turns)
      - --allowedTools     # variadic: keep it last
      - "Bash(npm test *)"
      - "Bash(git add *)"
      - "Bash(git commit *)"
```

In a `-p` run anything that would prompt is denied (and listed as a permission denial in the
summary), so with a narrower profile allow every command the action needs, including
`git add`/`git commit`. `--max-budget-usd` caps estimated spend the same way. Other flags
from the [CLI reference](https://code.claude.com/docs/en/cli-reference), such as `--model`,
pass through unchanged. Leave `--output-format` alone: `json` also works, but with `text`
the adapter can't read a result and goes by the exit code alone.

Without `--bare`, Claude Code loads the worktree's `CLAUDE.md`, `.claude/settings.json`
(including hooks) and `.mcp.json` as it would interactively, and `-p` skips the workspace trust
dialog. Point live mode only at repositories whose checked-in Claude settings you trust.

**Windows:** Claude Code's native Windows setup has no built-in command sandbox; commands run
unsandboxed ([sandboxing](https://code.claude.com/docs/en/sandboxing)). When an action needs
sandboxed command execution, run the worker and Claude Code inside WSL2, where the sandbox is
available, or inside another isolation boundary such as a VM or container.

### Live mode with Kiro

Prerequisites, under the account and environment the worker runs as (the background
launchers' account, not just your terminal):

- Kiro CLI 3.0.0 or later (`kiro-cli --version`) on a platform Kiro supports. Kiro lists
  "macOS, Windows 11 (PowerShell), or Linux (glibc 2.34+ or musl variant)" for the CLI
  ([installation](https://kiro.dev/docs/getting-started/installation/)) and doesn't document
  which CPU architectures the CLI supports. `factory agents` shows the platform check, and in
  live mode `factory doctor` fails on an OS outside that list, such as Windows 10 or a Linux
  with an older glibc. Elsewhere the CPU shows as "not documented" rather than supported.
- `KIRO_API_KEY` in the worker's environment. "Headless mode requires an API key set as the
  `KIRO_API_KEY` environment variable" ([headless mode](https://kiro.dev/docs/cli/headless/)).
  API keys are available on Kiro Pro, Pro+, Pro Max and Power subscriptions and are created
  at app.kiro.dev ([authentication](https://kiro.dev/docs/getting-started/authentication/)).
  `factory agents` and `factory doctor` check that the variable is set, but can't tell
  whether the key works without sending a prompt (`factory agents --deep` does).
  [Agent credentials](docs/background-operation.md#agent-credentials) shows how to give it to
  each launcher.
- **Don't put the key in `agents.kiro.env`** or anywhere else in the config file. The config
  is plain text that is easy to copy, share or commit, and `factory agents` / `factory doctor`
  check only the worker's own environment, so they would report Kiro as signed out anyway.
- A `checkoutPath` for the repository and a `prompt` for the action, as for Claude Code.

Each job runs, in its worktree, with the prompt file on stdin:

```
kiro-cli chat --no-interactive --v3 --trust-all-tools <agents.kiro.args>
```

- `chat --no-interactive` is Kiro's [headless mode](https://kiro.dev/docs/cli/headless/).
  With no prompt argument it reads the whole instruction from stdin. Don't add a positional
  argument in `agents.kiro.args`: Kiro would use it as the prompt and ignore stdin.
- `--v3` pins the agent harness, as Kiro recommends for scripts, so a change in Kiro's
  defaults doesn't change how jobs run ([agent harness](https://kiro.dev/docs/cli/agent-harness/)).
  `--v2`, `--v3` or `--agent-engine` in `agents.kiro.args` replaces it.
- The run's outcome is Kiro's exit code ([exit codes](https://kiro.dev/docs/reference/exit-codes/)):
  0 is `succeeded`. Anything else fails the run, with what the code means (1 is a general
  failure such as an authentication error or invalid arguments, 3 a required MCP server that
  didn't start, 4 an agent named by `--agent` that isn't available) and the last line Kiro
  printed. The summary shows Kiro's last output lines.
- Kiro also has `--output-format stream-json` (JSON Lines on stdout), but its docs don't yet
  describe the record format, so the adapter doesn't ask for it or read it. If you add it to
  `agents.kiro.args`, `run.log` keeps the event stream, the exit code still decides the
  outcome, and the summary shows the last JSON lines.

**Default permission profile: full auto.** `--trust-all-tools` lets Kiro use any tool
without asking, inside the job's worktree. As with Claude Code, that is not a sandbox: commands
run as your user and can reach the network and files outside the worktree. To narrow it, set
`--trust-tools` in `agents.kiro.args`. Any `--trust-tools` or `--trust-all-tools` there
replaces the default:

```yaml
agents:
  kiro:
    args:
      - --trust-tools=read_file,grep_search   # comma-separated tool ids; others are denied
      - --model
      - <model id>                            # see: kiro-cli chat --list-models
```

A headless run can't ask for approval, so a tool that isn't trusted is denied, sub-agents'
tool calls included. With a narrower profile, trust every tool the action needs, including
the one that runs `git add` and `git commit` (tool ids are in Kiro's
[built-in tools](https://kiro.dev/docs/tools/)). `--trust-tools` can't approve hook
confirmations; only `--trust-all-tools` does. On V3, `--sandbox` makes the run fail rather
than run commands without Kiro's
[local command sandbox](https://kiro.dev/docs/sandbox/).
Other flags from the [CLI reference](https://kiro.dev/docs/reference/cli-commands/), such as
`--model`, `--agent` and `--effort`, pass through unchanged after the adapter's own.

Kiro may load project configuration checked into the repository (for example agents, hooks
and MCP servers under `.kiro/`). Point live mode only at repositories whose
checked-in Kiro settings you trust.

**Windows:** Kiro supports the CLI on Windows 11 only. The worker starts `kiro-cli` directly,
without PowerShell. Live runs on Windows have been tested only against a stand-in CLI, not a
real Kiro install.

**Claude Code and Kiro together:** with both in a pool, such as the default
`general: { agents: [claude, kiro] }`, the queue hands consecutive jobs to them in turn
(round-robin). Each still needs its own prerequisites above.

## Files and locations

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Config | `%APPDATA%\software-factory\config.yaml` | `~/Library/Application Support/software-factory/config.yaml` | `$XDG_CONFIG_HOME/software-factory/config.yaml` (default `~/.config`) |
| State (`state.db`, `worktrees/`) | `%LOCALAPPDATA%\software-factory\` | `~/Library/Application Support/software-factory/` | `$XDG_STATE_HOME/software-factory/` (default `~/.local/state`) |
| Logs (`factory.log`, `runs/`) | `%LOCALAPPDATA%\software-factory\logs\` | `~/Library/Logs/software-factory/` | `$XDG_STATE_HOME/software-factory/logs/` |

Overrides:

- `FACTORY_HOME=<dir>` puts config (`<dir>/config.yaml`), state (`<dir>/state.db`) and logs
  (`<dir>/logs/`) under one directory.
- `--config <path>` or `FACTORY_CONFIG=<path>` changes only the config file; `--config` wins.
  Relative paths in the config (such as prompt files) resolve against the config file's
  directory.

## Background operation

`factory start` runs in the foreground. To start it at login, use the launchers shipped in
`examples/launchers/` (also inside the installed package):

| Platform | Launcher |
| --- | --- |
| Windows | `windows/register-task.ps1` registers a Task Scheduler task at logon for your account (no stored password), with restart on failure, no time limit and no overlapping runs. `unregister-task.ps1` removes it |
| macOS | `macos/install-launchagent.sh` installs a per-user LaunchAgent from `software-factory.plist.template` (`--uninstall` removes it) |
| Linux (systemd) | `linux/install-systemd-user.sh` installs a `systemd --user` service; `loginctl enable-linger` keeps it running without a login session |
| Other hosts | Run `factory start --config <path>` in the foreground under your existing supervisor |

Each launcher runs `node <package>/dist/cli.js start --config <path>` with absolute paths, a
working directory and an explicit `PATH`. Run `factory doctor` under the same account and
environment before relying on it. Details, log locations and troubleshooting:
[docs/background-operation.md](docs/background-operation.md).

## Security

- Only GitHub logins in `dispatch.allowedActors` (or a workflow's `allowedActors`) can
  dispatch work. The check uses the actor on the label event; with an empty list, no events
  are queued. In live mode the worker checks again right before it starts an agent: the label
  application that queued the job must still be the latest one for that label on the issue,
  and its actor must still be allowed. If the label was removed and put back since, the old
  job is canceled; a reapplication by an allowed actor has queued its own job.
- Issue titles, bodies and labels are untrusted input. In live mode they reach the agent
  only through a prompt file (on stdin or by path), never a command line, fenced and
  labelled as untrusted; the default prompt
  ([examples/prompts/implement-issue.md](examples/prompts/implement-issue.md)) also tells
  agents not to follow instructions in them.
- The worker only reads from GitHub and never pushes. In `prepare-only` and `live` mode it
  fetches into your clone and creates branches and worktrees; Git hooks configured for the
  clone (such as `post-checkout`) run as they would for any `git worktree add`.
- In live mode the agent runs as your user, in the job's worktree, with the worker's
  environment minus `GH_TOKEN`/`GITHUB_TOKEN`. That is not a sandbox: what the agent may do
  is up to the agent CLI's own permission settings. Claude Code runs in full-auto mode by
  default (see [Live mode with Claude Code](#live-mode-with-claude-code)), and so does Kiro
  (see [Live mode with Kiro](#live-mode-with-kiro)); the allowlist of actors who can dispatch
  work is the guard on who can start such a run.
- Agent credentials such as `KIRO_API_KEY` belong in the worker's environment, set by its
  launcher, not in the config file
  (see [Agent credentials](docs/background-operation.md#agent-credentials)).
- GitHub access uses `GH_TOKEN` or `GITHUB_TOKEN` if set, otherwise `gh auth token`. The CLI
  does not store tokens.

## Development

```sh
npm ci
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # compile to dist/
node scripts/pack-smoke.mjs   # npm pack, install into a temp prefix, run version/validate/status
```

CI (`.github/workflows/ci.yml`) runs these on Windows, macOS and Linux with Node 22 and 24,
and checks each launcher against the built CLI using paths with spaces.

## License

MIT
