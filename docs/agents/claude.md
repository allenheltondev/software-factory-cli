# Live mode with Claude Code

How the worker runs Claude Code for a job in `live` mode. The parts common to every agent
(prompt file, process handling, outcomes and the run summary) are in
[Live execution](../live-execution.md).

## Prerequisites

Under the account and environment the worker runs as (the background
launchers' account, not just your terminal):

- Claude Code installed and signed in: `claude auth status` reports `loggedIn: true` (a
  claude.ai login, or `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` in the environment).
  `updraft agents` and `updraft doctor` run the same check.
- On Linux and macOS, a non-root user: Claude Code refuses the default full-auto profile as
  root or under `sudo`.
- Only agents with a live adapter enabled (`claude`, `codex` or `kiro`), a
  `checkoutPath` for the repository and a `prompt` for the action. `updraft validate` checks
  all three.

## Invocation

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

## Permission profile

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

## Platform notes

**Windows:** Claude Code's native Windows setup has no built-in command sandbox; commands run
unsandboxed ([sandboxing](https://code.claude.com/docs/en/sandboxing)). When an action needs
sandboxed command execution, run the worker and Claude Code inside WSL2, where the sandbox is
available, or inside another isolation boundary such as a VM or container.
