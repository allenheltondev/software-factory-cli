# Live mode with Kiro

How the worker runs the Kiro CLI for a job in `live` mode. The parts common to every agent
(prompt file, process handling, outcomes and the run summary) are in
[Live execution](../live-execution.md).

## Prerequisites

Under the account and environment the worker runs as (the background
launchers' account, not just your terminal):

- Kiro CLI 3.0.0 or later is recommended (`kiro-cli --version`): Updraft starts Kiro with
  `--v3`, and 3.0.0 is the release it is written against. Some earlier releases have the V3
  harness too and may work, but are not verified. `updraft agents` notes an older CLI and
  `updraft doctor` warns about it (never a failure), unless the agent's `args` pick a harness
  themselves, such as `--v2`. It must also run on a platform Kiro supports. Kiro lists
  "macOS, Windows 11 (PowerShell), or Linux (glibc 2.34+ or musl variant)" for the CLI
  ([installation](https://kiro.dev/docs/getting-started/installation/)) and doesn't document
  which CPU architectures the CLI supports. `updraft agents` shows the platform check, and in
  live mode `updraft doctor` fails on an OS outside that list, such as Windows 10 or a Linux
  with an older glibc. Elsewhere the CPU shows as "not documented" rather than supported.
- A way to sign in that works without a person present, one of:
  - **`KIRO_API_KEY` in the worker's environment.** Kiro's docs say "Headless mode requires an
    API key set as the `KIRO_API_KEY` environment variable"
    ([headless mode](https://kiro.dev/docs/cli/headless/)). API keys are available on Kiro
    Pro, Pro+, Pro Max and Power subscriptions and are created at app.kiro.dev
    ([authentication](https://kiro.dev/docs/getting-started/authentication/)).
    [Agent credentials](../background-operation.md#agent-credentials) shows how to give it to
    each launcher. A key doesn't expire on its own, so it suits a background worker best.
  - **A `kiro-cli login` session** (Builder ID or IAM Identity Center), under the account the
    worker runs as. Despite the docs, headless runs work with one: verified with kiro-cli
    3.5.0 signed in through IAM Identity Center, with no key set. The session expires on
    Kiro's or your organization's schedule. After that, runs fail until someone runs
    `kiro-cli login` again, so check `updraft doctor` if Kiro runs start failing.

  With the key set, `updraft agents` and `updraft doctor` report Kiro as signed in without
  running it. Without it, they ask `kiro-cli whoami`, which prints "Logged in with ..." for a
  session. Neither check can tell whether the key or session is accepted without sending a
  prompt (`updraft agents --deep` does).
- On Windows, Kiro's installer puts `kiro-cli.exe` in `%LOCALAPPDATA%\Kiro-Cli` and adds that
  folder to your user `PATH`. A terminal or worker started before the install doesn't see it
  until it is restarted. `updraft agents` also looks in that folder and says so, or you can
  set `agents.kiro.command` to the full path.
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
- Kiro's stdout and stderr are kept apart. `kiro-cli` writes its answer to stdout and its own
  log records (`[INFO] [KRS] ...`) to stderr. Sharing one file, a record could land on the same
  line as a reviewer's verdict, which then didn't read as a verdict. While Kiro runs, `run.log`
  gets its stdout, and its stderr goes to `agent-stderr.log` in the same run directory. When
  Kiro exits, the stderr is appended to `run.log` under `---- agent stderr ----`. So
  `updraft logs --follow` shows Kiro's stderr only once the run has ended. The verdict and the
  summary come from stdout. A failed run's reason is looked for in both.
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
