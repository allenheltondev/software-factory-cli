# Codex on a ChatGPT subscription (#125)

How Updraft runs Codex on the owner's ChatGPT plan ("Sign in with ChatGPT") instead of an
OpenAI API key, on a host-native worker and on the hosted native worker. It reuses the design
that already runs Claude Code on a Claude subscription
([persistent-claude-worker.md](persistent-claude-worker.md),
[native worker](../deploy/aws-microvm/native-worker/README.md)), generalized by provider.

**Status:** the sign-in, the status checks before every run, and the worker's isolated Codex
session are built and checked in CI with a synthetic Codex CLI. Cloud routing of Codex jobs to
a Codex session and the console's Connect ChatGPT panel are follow-ups (see the end). Nothing
here has run against a real ChatGPT account yet.

## The rule

Updraft never handles a ChatGPT credential. The official, unmodified Codex CLI signs in, keeps
and refreshes its own login, and Updraft only asks that CLI whether it is signed in with
ChatGPT. No token, refresh token, device code exchange or `auth.json` content enters Updraft's
control plane, broker payloads, DynamoDB, S3 or logs, and repository code and agent tools
cannot read the CLI's login. This is the same line as for Claude.

This is narrower than the issue's first draft, which had Updraft run its own OAuth client
(`dynamic_agent_client`, PKCE, token storage) and pass an access token to `codex app-server`.
That design has Updraft collect and store ChatGPT tokens, which the owner ruled out. Nothing in
this design needs it.

## What the official CLI offers

Researched in the `openai/codex` repository at commit `8727186` (2026-11-26) and OpenAI's
Codex authentication docs:

| Need | Official CLI | Source |
| --- | --- | --- |
| Sign in on a machine without a browser | `codex login --device-auth`: prints `https://auth.openai.com/codex/device` and a one-time code (valid 15 minutes); the CLI polls, exchanges the code itself and stores the login. Plain `codex login` suggests it on headless machines. Device code sign-in is labelled beta and may first need enabling in ChatGPT's security settings (personal) or by a workspace admin. | `codex-rs/login/src/device_code_auth.rs`, `codex-rs/cli/src/login.rs`; [Authentication](https://developers.openai.com/codex/auth) |
| Where the login lives | `$CODEX_HOME/auth.json` (default `~/.codex`) with `cli_auth_credentials_store = "file"`; `keyring` and `auto` use the OS keyring. The docs say to treat the file like a password. | `codex-rs/login/src/auth/storage.rs`, `codex-rs/config/src/types.rs`; [Authentication](https://developers.openai.com/codex/auth) |
| Is it signed in, and how | `codex login status`: one line on **stderr**, exit 0 when a credential exists (`Logged in using ChatGPT`, `API key configured - …`, `Logged in using access token`, …), exit 1 with `Not logged in`. It does not read `CODEX_API_KEY`. No expiry is reported. | `codex-rs/cli/src/login.rs` `run_login_status` |
| ChatGPT only, never an API key | `forced_login_method = "chatgpt"`: the CLI refuses API-key auth (and logs an API-key login out). `model_provider = "openai"` picks the built-in provider over any in `config.toml`. | `codex-rs/login/src/auth/manager.rs` |
| Headless runs | `codex exec --json`, prompt on stdin, as Updraft already runs Codex. Refresh is the CLI's: the CI guide says to let Codex refresh `auth.json` itself, keep one `auth.json` per runner or serialized stream, and re-run `codex login` on a trusted machine when a refresh token was revoked or rotated elsewhere. | [CI/CD auth](https://developers.openai.com/codex/auth/ci-cd-auth) |

So there is an official flow that works on a remote worker without Updraft touching a token:
device code sign-in, run by the CLI on the worker, with the person entering the code in their
own browser.

## Host-native worker

```yaml
agents:
  codex:
    authentication: native-codex
    model: gpt-5-codex
```

1. Sign in once as the worker's account: `codex login --device-auth`, then check with
   `updraft native-auth --codex --json` (`{"provider":"codex","auth":"chatgpt_subscription",
   "state":"connected",...}`; it prints only a fixed state and reason).
2. Every implementation, review and revision run by that profile checks the login twice, like
   `native-claude`: before checkout in the worker's environment, and just before launch with the
   agent's final environment and the job worktree as working directory. Only
   `Logged in using ChatGPT` passes; an API key, access token, Bedrock or workload-identity login,
   `Not logged in` and anything unexpected fail the run as `start_failed` with a fixed hint and
   no CLI output.
3. Any `OPENAI_*`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` or auth-endpoint override variable in
   the environment fails the check without starting the CLI. A profile may not set
   `model_provider`, `model_providers.*`, `forced_login_method`, `cli_auth_credentials_store`,
   `chatgpt_base_url`, `openai_base_url`, `--profile`/`-p`, `--oss` or `--local-provider`
   (`updraft validate` and the run both refuse them).
4. Every run appends `-c model_provider="openai" -c forced_login_method="chatgpt"`, so Codex
   itself refuses an API key that appears after the checks.

This is the mutually exclusive routing on a worker: a `native-codex` profile runs only on the
ChatGPT login, a profile without it is the API-key (BYOK) path, and nothing falls back from one
to the other. `native-codex` is refused with `container`, as `native-claude` is: on a host-native
worker the CLI and the repository commands share an account, so it is for trusted repositories
only. Untrusted code needs the isolated worker below.

## Hosted native worker: the isolation boundary

The native worker supervisor (`deploy/aws-microvm/native-worker/`) already keeps Claude's login
away from repository code. Codex uses the same boundary:

```text
root supervisor
  ├─ official Codex CLI (credential UID 1001), private cwd
  │    HOME = credential home, CODEX_HOME = <credential home>/.codex (auth.json, CLI-owned)
  │    only MCP tool: updraft.exec ──► trusted shim ──► private Unix socket
  └─ bubblewrap job sandbox (UID 1000): worktree mounts only, fresh HOME,
       new PID/mount/user/network namespaces, no credential home, no network
       (registry proxy only)
```

- The supervisor accepts `codex exec --json` with a model and a reasoning effort, nothing else
  (`codexArgs` in `policy.mjs`), and starts the CLI with: `--skip-git-repo-check --ephemeral
  --ignore-user-config --ignore-rules` (no user config, rules, hooks or project files);
  `features.shell_tool=false`, `features.unified_exec=false`, `features.view_image=false`,
  `web_search="disabled"` (no built-in tools); `--sandbox read-only` and
  `approval_policy="never"` (should a built-in tool remain, Codex's own sandbox blocks writes
  and network and nothing is escalated); `model_provider="openai"`,
  `forced_login_method="chatgpt"`, `cli_auth_credentials_store="file"`; and one MCP server,
  `updraft`, limited to its `exec` tool, which runs each command in the job sandbox exactly as
  Claude's tool does.
- Claude announces its tool list (`system/init`), which the supervisor checks before relaying
  anything. `codex exec --json` announces none, so the supervisor judges **every** event
  (`checkCodexEvent`): a turn may only reason, message, keep a to-do list and call
  `updraft.exec`. A `command_execution`, `file_change`, `web_search`, collaboration call, another
  MCP server or tool, or any event type it does not know kills the CLI and every child before
  the event is relayed; the run fails with exit 125. Tool calls are served only after
  `thread.started`.
- `codex login status` runs before every session as the credential identity in a private
  directory; its output is classified by the same `native-codex-auth.js` and never relayed.
- The CLI's environment is fixed (`codexEnv`): PATH, LANG, HOME and CODEX_HOME, nothing
  inherited, so no key or endpoint override can reach it.
- `security-check.mjs` (CI job "native worker credential isolation") runs the real supervisor,
  MCP bridge, UIDs and bubblewrap with a synthetic Codex CLI and a synthetic `auth.json`. It
  proves repository commands cannot read `auth.json` (direct read, the supervisor's
  `/proc/<pid>/root`, a symlink, a Node subprocess, the environment), that a built-in tool event
  ends the session with no later tool call run, that API-key, access-token, signed-out and
  unreadable logins and caller-chosen sandbox, provider, MCP or profile options fail closed, and
  that readiness stays a sanitized state.

**What the event gate does not prove:** it reacts to what the CLI reports. Whether the real CLI,
with these flags, offers the model no built-in tool at all is a property of the pinned Codex
release and must be verified live (below). Until then the read-only Codex sandbox is the second
layer, and the same separate-UID boundary keeps the credential home out of the job sandbox.

## Hosted sign-in

The private sign-in listener (`browser-login.mjs`, port 8081, opaque-origin frame, short-lived
port-scoped AWS grant) gains `/codex-login` when the worker has Codex installed. It runs the
official `codex login --device-auth` as the credential identity, reads only the verification
page (exactly `https://auth.openai.com/codex/device`) and a plain one-time code from the CLI's
output, and sends those two values to the frame over the direct browser-to-worker WebSocket. The
person opens the page, signs in to ChatGPT and enters the code; the CLI receives and stores the
login. The browser sends nothing back (any message ends the attempt), and the panel's parent
gets only a status (`connected`, `failed`, `expired`). The code never enters Updraft's API,
storage or logs.

## Lifecycle

- **Storage.** The login lives where Claude's does: the worker's private credential home (EFS
  access point for a persistent worker, private tmpfs for a disposable managed session). It is
  never copied between workers; a new disposable session needs a new sign-in, as Claude's does.
- **Refresh.** The CLI refreshes `auth.json` itself. One supervisor holds the credential home's
  lock and runs one agent at a time, so there is one refresh writer, which is what OpenAI's CI
  guide asks for.
- **Expiry and revocation.** `codex login status` cannot see a revoked or expired refresh token;
  the run fails with the CLI's error, and the next sign-in replaces the login. There is no API-key
  fallback.
- **Sign out.** `codex logout` as the credential identity, or end the worker and remove its
  storage.

## Cloud routing (follow-up)

Cloud today keeps one managed Claude session per installation (`cloud/server/src/native/*`),
routes a trigger there only when its workflow needs `ANTHROPIC_API_KEY`, and posts the one
sign-in notice when that session needs a sign-in. A Codex workflow needs `CODEX_API_KEY`, so it
is never sent to the Claude session; it stays on the API-key path (a test pins this). Codex
subscription routing needs:

1. A session per provider (session rows, admission, readiness, retirement and fencing keyed by
   provider, and a worker image with the pinned Codex CLI), so Claude and Codex logins never share
   a session and a Codex job never waits on a Claude sign-in.
2. Routing that selects the Codex session for triggers that need `CODEX_API_KEY`, drops that key
   from the job, and is exclusive with the API-key path, as Claude's is.
3. `native-config.mjs` / `isolation.mjs` on the job runner accepting the native runtime for Codex
   profiles, as they do for Claude.
4. The waiting notice and timeline words per provider ("Codex needs you to sign in with ChatGPT").
5. The console: a Connect ChatGPT card beside Claude's in the shared connected-account UI (#123),
   and a Codex frame that shows the page and the code instead of a code input.

## Verify live, with a real ChatGPT account

- Device code sign-in on a worker (and whether the account first has to enable it), then
  `updraft native-auth --codex` reports `connected`; restart the process and the VM and it still
  does.
- With the pinned Codex release and the supervisor's flags, the model is offered only
  `updraft.exec`: no shell, exec, patch, image, web search or agent tools. Ask it to read
  `auth.json` and to run commands; record that no `command_execution` or `file_change` item
  appears, and that the gate kills the session if one does.
- MCP tool calls run without an approval prompt in `exec` with `approval_policy="never"` and
  `default_tools_approval_mode="approve"`.
- A real issue through implementation, review, revision and CI repair on the subscription, with
  no `OPENAI_API_KEY` or `CODEX_API_KEY` anywhere, and evidence of plan-backed usage.
- Refresh over several days; a revoked login fails without API billing; a second supervisor on
  the same storage cannot start.
