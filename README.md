# software-factory-cli

`factory` watches GitHub repositories you choose and turns labeled issues into queued jobs
for coding agents (Codex, Claude Code, Kiro). It runs on your machine, uses your `gh`
sign-in, and keeps its queue in a local SQLite database.

## Status

Pilot. This release covers repository discovery, config validation, issue-event polling, a
durable queue and a **log-only** worker: jobs are claimed, routed to a pool and agent, and
recorded, but no agent is started and no code is changed. The opt-in **prepare-only** mode
also creates a branch and Git worktree per job (still without an agent). Agent execution and
PR creation come next. See [docs/design.md](docs/design.md).

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
4. Add the `factory:ready` label to an open issue. Within one poll interval, `factory status`
   shows the queued job and, in log-only mode, its run.

To run the worker in the background at login, see
[Background operation](#background-operation).

## Commands

All commands accept `--config <path>` (or `FACTORY_CONFIG`) to use a config file other than
the per-user default.

| Command | Behavior |
| --- | --- |
| `factory configure` | Interactively select repos, trigger labels, actions and pools (needs a terminal) |
| `factory add OWNER/REPO` | Add or update a repo workflow non-interactively. Options: `--label` (default `factory:ready`), `--action` (default `implement-issue`), `--pool` (default `general`), `--route LABEL=POOL` (repeatable), `--backfill-since DATE`, `--workflow-id ID` |
| `factory validate` | Check the config without network access; exit 1 if invalid |
| `factory start` | Run the worker: poll GitHub and process the queue (non-interactive). Exits with code 3 if another worker holds the lock |
| `factory status [--json]` | Worker state, watched repos and checkpoints, agents, queue counts, active runs, recent jobs and errors. Works offline |
| `factory doctor [--json]` | Check Node, config, state, Git, `gh`, GitHub access, labels and agent commands in the current environment |
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
        trigger: { event: issue.labeled, label: "factory:ready" }
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
| `execution.mode` | `log-only` | `log-only` writes run.log only. `prepare-only` also creates the job's branch and worktree; no agent runs in either |
| `dispatch.allowedActors` | `[]` | GitHub logins allowed to dispatch work by applying a trigger label. Empty means nobody |
| `agents.<name>.adapter` | the agent's name | `codex`, `claude` or `kiro` |
| `agents.<name>.enabled` | `true` | Disabled agents are never chosen |
| `agents.<name>.maxConcurrent` | `1` | Per-agent cap across all pools and repos, 1-32 |
| `pools.<name>.agents` | required | Agent names in the pool (at least one) |
| `pools.<name>.strategy` | `round-robin` | Rotates among agents with free capacity |
| `actions.<name>.prompt` | none | Prompt file, relative to the config file's directory |
| `actions.<name>.output` | `local-branch` | `local-branch` or `log` |
| `repositories.<OWNER/REPO>.id` | required | Stable GitHub repository ID (filled in by `configure` / `add`) |
| `repositories.<OWNER/REPO>.baseBranch` | remote's default branch | Branch that per-job branches start from (fetched first) |
| `repositories.<OWNER/REPO>.checkoutPath` | none | Local clone of the repo that per-job worktrees are created from, relative to the config file's directory. Required in `prepare-only` mode when a workflow's action has `output: local-branch` |
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

In `prepare-only` mode, each job whose action has `output: local-branch` gets:

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
  are queued.
- Issue titles, bodies and labels are untrusted input. Agent adapters (next release) will
  receive them through stdin or a prompt file, not shell command strings, and the default
  prompt ([examples/prompts/implement-issue.md](examples/prompts/implement-issue.md)) tells
  agents not to follow instructions in them.
- Agents are disabled in this release: nothing runs repository code or pushes to GitHub, and
  the worker only reads from GitHub. In `prepare-only` mode the worker fetches into your
  clone and creates branches and worktrees; Git hooks configured for the clone (such as
  `post-checkout`) run as they would for any `git worktree add`.
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
