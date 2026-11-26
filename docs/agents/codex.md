# Live mode with Codex

How the worker runs Codex for a job in `live` mode. The parts common to every agent
(prompt file, process handling, outcomes and the run summary) are in
[Live execution](../live-execution.md).

## Prerequisites

Under the account and environment the worker runs as (the background
launchers' account, not just your terminal):

- Codex installed and signed in: `codex login status` exits 0 (a ChatGPT login or a stored
  API key), or `CODEX_API_KEY` is set in the worker's environment, which `codex exec`
  accepts. `updraft agents` and `updraft doctor` run the same check. To require the ChatGPT
  subscription and refuse API keys, see [On a ChatGPT subscription](#on-a-chatgpt-subscription).
- Only agents with a live adapter enabled, a `checkoutPath` for the repository and a `prompt`
  for the action (see [Requirements](../live-execution.md#requirements)).

## Invocation

Each job runs, in its worktree, with the prompt file on stdin (no prompt argument):

```
codex exec --json --dangerously-bypass-approvals-and-sandbox <agents.codex.args>
```

- `codex exec` is Codex's [non-interactive mode](https://developers.openai.com/codex/noninteractive);
  with no prompt argument it reads the prompt from stdin.
- `--json` makes stdout a stream of JSON events, one per line, written to `run.log` as the run
  goes: `thread.started`, `item.*` (commands, file changes, messages), then `turn.completed`
  or `turn.failed`.
- The run is `succeeded` only when Codex exits 0 after `turn.completed`. A `turn.failed`
  event fails the run with its message (for example a usage limit), and so does a non-zero
  exit (Codex exits 1 when the turn fails or is interrupted, or a fatal error was reported)
  or exiting 0 without a turn result the worker can read. `error` events alone don't decide
  anything, since Codex also reports errors it is about to retry that way. The summary shows
  Codex's final message, then a line with the turn result, token usage and the thread id. To
  look at a run afterwards, run `codex resume <thread id>` in its worktree.

## Permission profile

**Default permission profile: full auto.** `--dangerously-bypass-approvals-and-sandbox`
(alias `--yolo`) runs every command without approval and without Codex's sandbox, the
equivalent of Claude Code's `bypassPermissions`. It is not a sandbox: commands run as your
user, can reach the network and can read or write outside the worktree, including
environment variables such as `CODEX_API_KEY`. OpenAI recommends it only inside an isolated
runner; see [agent approvals and security](https://developers.openai.com/codex/agent-approvals-security).

The sandboxed mode OpenAI suggests for automation, `--sandbox workspace-write`, keeps `.git`
read-only, and for a worktree also the Git directory its `.git` file points to. In a job
worktree Codex can then edit files but cannot commit them: the run summary lists the
uncommitted changes, and the branch has no new commits. Network access is off in that mode
unless enabled with `-c sandbox_workspace_write.network_access=true`.

To change the profile, set it in `agents.codex.args`. Any of `--sandbox`/`-s`,
`--ask-for-approval`/`-a`, `--full-auto`, `--approve-for-me`, `--yolo`,
`--dangerously-bypass-approvals-and-sandbox`, or `-c sandbox_mode=...` /
`-c approval_policy=...` there replaces the default. Settings in `~/.codex/config.toml` or a
`--profile` do not; put them in `args`. Config arguments go last, after the adapter's own,
except `--ask-for-approval`/`-a`, which `codex exec` only accepts before the subcommand, so
the adapter moves it there:

```yaml
agents:
  codex:
    args:
      - --sandbox
      - workspace-write    # sandboxed edits; Codex can't commit (see above)
      - --model
      - gpt-5-codex
```

`codex exec` never stops to ask: with a narrower profile, anything that would need approval
is refused. `--full-auto` is still accepted by older releases (it is
`--sandbox workspace-write` with on-request approvals), but current docs say it is no longer
supported; use `--sandbox workspace-write` instead. Other flags from the
[CLI reference](https://developers.openai.com/codex/cli/reference), such as `--model` or
`-c key=value`, pass through unchanged. Leave `--json` and the prompt alone.

Codex reads the worktree's `AGENTS.md` files. Project `.codex/config.toml` settings and
project MCP servers load only for projects you have marked trusted, and the adapter doesn't
pass `--trust`. Point live mode only at repositories whose checked-in instructions you trust.

## On a ChatGPT subscription

`authentication: native-codex` runs the profile only on the CLI's own Sign in with ChatGPT,
never an API key: sign in once with `codex login --device-auth`, check with
`updraft native-auth --codex`, and every run checks the login again before checkout and just
before launch, then adds `-c model_provider="openai" -c forced_login_method="chatgpt"` and the
official `chatgpt_base_url`. An `OPENAI_*` or `CODEX_API_KEY` variable, an extra CA bundle
(`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `CODEX_CA_CERTIFICATE`, …), a profile `env.CODEX_HOME`,
or args that choose another provider or profile, fail the run. Design, isolation and the hosted worker: [Codex on a ChatGPT subscription](../codex-subscription.md).

## Platform notes

**Windows:** Codex has a native Windows sandbox for its sandboxed modes
([Windows sandbox](https://developers.openai.com/codex/windows/windows-sandbox)): the newer
`mxc` mode needs recent Windows 11 builds; the `elevated` mode needs a one-time
administrator-approved setup (`codex sandbox setup --elevated`) and uses separate
lower-privilege sandbox users and firewall rules; the `unelevated` fallback has weaker network
isolation. The default full-auto profile bypasses it, so none of that applies unless you
choose `--sandbox` in `args`. If you do, set the sandbox up under the worker's account and try
a run interactively first: the worker can't answer a setup prompt, and how `codex exec`
behaves when setup is missing is not documented. WSL2 uses the Linux sandbox instead.

**macOS and Linux:** the sandboxed modes use Seatbelt on macOS and bubblewrap on Linux and
WSL2; the docs ask you to install `bwrap` first, and WSL1 is not supported
([sandboxing](https://developers.openai.com/codex/sandboxing)). The default profile uses
neither.
