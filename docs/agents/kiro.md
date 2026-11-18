# Live mode with Kiro

How the worker runs the Kiro CLI for a job in `live` mode. The parts common to every agent
(prompt file, process handling, outcomes and the run summary) are in
[Live execution](../live-execution.md).

## Prerequisites

Under the account and environment the worker runs as (the background
launchers' account, not just your terminal):

- Kiro CLI 3.0.0 or later (`kiro-cli --version`) on a platform Kiro supports. Kiro lists
  "macOS, Windows 11 (PowerShell), or Linux (glibc 2.34+ or musl variant)" for the CLI
  ([installation](https://kiro.dev/docs/getting-started/installation/)) and doesn't document
  which CPU architectures the CLI supports. `updraft agents` shows the platform check, and in
  live mode `updraft doctor` fails on an OS outside that list, such as Windows 10 or a Linux
  with an older glibc. Elsewhere the CPU shows as "not documented" rather than supported.
- `KIRO_API_KEY` in the worker's environment. "Headless mode requires an API key set as the
  `KIRO_API_KEY` environment variable" ([headless mode](https://kiro.dev/docs/cli/headless/)).
  API keys are available on Kiro Pro, Pro+, Pro Max and Power subscriptions and are created
  at app.kiro.dev ([authentication](https://kiro.dev/docs/getting-started/authentication/)).
  `updraft agents` and `updraft doctor` check that the variable is set, but can't tell
  whether the key works without sending a prompt (`updraft agents --deep` does).
  [Agent credentials](../background-operation.md#agent-credentials) shows how to give it to
  each launcher.
- **Don't put the key in `agents.kiro.env`** or anywhere else in the config file. The config
  is plain text that is easy to copy, share or commit. (`updraft doctor` checks each agent
  with its `agents.<name>.env`, as a live run does, but `updraft agents` looks only at the
  worker's own environment.)
- A `checkoutPath` for the repository and a `prompt` for the action (see
  [Requirements](../live-execution.md#requirements)).

## Invocation

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

## Permission profile

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

## Platform notes

**Windows:** Kiro supports the CLI on Windows 11 only. The worker starts `kiro-cli` directly,
without PowerShell. Live runs on Windows have been tested only against a stand-in CLI, not a
real Kiro install.
