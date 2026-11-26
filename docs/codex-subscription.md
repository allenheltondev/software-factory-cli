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
    model: gpt-5.5
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
   the environment fails the check without starting the CLI, and so does any extra TLS trust
   root: `CODEX_CA_CERTIFICATE`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`,
   `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`. Proxy variables (`HTTPS_PROXY`, `ALL_PROXY`, …) are
   allowed: with only the system roots trusted, a proxy sees the host it tunnels to and never the
   login or the traffic, and hosts often need one. An interception CA is what would expose the
   tokens, and it is always refused.
4. A profile may not set `model_provider`, `model_providers.*`, `forced_login_method`,
   `cli_auth_credentials_store`, `chatgpt_base_url`, `openai_base_url`, `--profile`/`-p`, `--oss`
   or `--local-provider` in `args`, nor `CODEX_HOME` in `env` (`updraft validate` and the run
   both refuse them).
5. Every run appends `-c model_provider="openai" -c forced_login_method="chatgpt"
   -c chatgpt_base_url="https://chatgpt.com/backend-api/"`, so Codex itself refuses an API key
   that appears after the checks, and a `config.toml` cannot point the login at another backend.
   That URL is the CLI's own default for a ChatGPT login (`DEFAULT_CHATGPT_BASE_URL`,
   `codex-rs/model-provider/src/chatgpt_base_url.rs`), so pinning it changes nothing else.

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
  ├─ official Codex CLI, native binary (credential UID 1001), private cwd
  │    HOME = CODEX_HOME = <credential home>/codex (0700; auth.json, CLI-owned)
  │    only MCP tool: updraft.exec ──► trusted shim ──► private Unix socket
  └─ bubblewrap job sandbox (UID 1000): worktree mounts only, fresh HOME,
       new PID/mount/user/network namespaces, no credential home, no network
       (registry proxy only)
```

The controls, in order of importance:

1. **Prevention: nothing but `updraft.exec` is switched on.** The supervisor accepts
   `codex exec --json` with a model and a reasoning effort, nothing else (`codexArgs` in
   `policy.mjs`), and starts the CLI with:
   - `--ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check`, from a private
     empty cwd: no user `config.toml`, rules, project config or project MCP servers;
   - every feature that adds a tool or a call path off (`CODEX_DISABLED_FEATURES`), under
     `--strict-config`, so a key the pinned CLI does not know fails the run instead of being
     ignored. Audit, at `openai/codex` 8727186 (`codex-rs/features/src/lib.rs`): every
     `FeatureSpec` with `default_enabled: true` was listed, and each that adds a model-visible
     tool, a tool or MCP call path, an MCP server, sub-agents, hooks, browser or computer use,
     image generation or an approval reviewer is switched off: `shell_tool`, `unified_exec`,
     `unified_exec_tty`, `shell_snapshot`, `view_image`, `sleep_tool`, `code_mode_host`, `hooks`,
     `multi_agent`, `apps` (the ChatGPT `codex_apps` connector server, turned on for ChatGPT
     logins), `tool_suggest`, `plugins`, `remote_plugin`, `plugin_sharing`, `in_app_browser`,
     `in_app_local_automation`, `browser_use`, `browser_use_full_cdp_access`,
     `browser_use_external`, `computer_use`, `image_generation`, `skill_mcp_dependency_install`,
     `goals`, `tool_call_mcp_elicitation`, `auth_elicitation`, `guardian_approval`,
     `workspace_dependencies`. Off-by-default features that would add such a tool are pinned off
     too: `multi_agent_v2`, `code_mode`, `code_mode_only`, `standalone_web_search`,
     `web_search_request`, `web_search_cached`, `web_search_indexed_default`,
     `request_permissions_tool`, `exec_permission_approvals`, `memories`, `recommended_plugins`,
     `agent_message_board`, `agent_message_board_mcp`, `enable_mcp_apps`, `deferred_executor`,
     `send_message_to_user_async`, `artifact`, `statsig_gates`. `js_repl` is `Stage::Removed`
     (ignored by the CLI) and not listed. Infrastructure flags (MCP startup, compression,
     retries, TUI) are left alone. Re-run this audit for every Codex version the image pins;
   - `agents.enabled=false`: the model catalog's `multi_agent_version` (v2 for most models)
     wins over both `multi_agent` features, and only `agents.enabled=false` turns sub-agents off
     (`multi_agent_version_override`, `codex-rs/core/src/config/mod.rs`);
   - `web_search="disabled"`, `check_for_update_on_startup=false`;
   - a direct-mode model only. A model whose catalog entry has `tool_mode: code_mode_only` reaches
     MCP tools only through code mode, which is off here, so it would have no usable tool. In
     `codex-rs/models-manager/models.json` at 8727186 that is every gpt-5.6 and gpt-6.x model, the
     daybreak models and `codex-auto-review`; the one direct-mode model listed is `gpt-5.5`, which
     is the worker's default and the only one it accepts (unknown models are refused, not
     guessed). The CLI does not expose that flag before a run, so the list is kept in
     `policy.mjs` and `src/agents/native-codex-args.ts`; `updraft validate` and the run refuse
     another model for a Codex profile on the native worker runtime, with the reason. Host-native
     `native-codex` keeps Codex's own tools, so any model works there;
   - one MCP server, `updraft`, `required`, limited to `enabled_tools = ["exec"]`, which runs
     each command in the job sandbox exactly as Claude's tool does;
   - `model_provider="openai"`, `forced_login_method="chatgpt"`,
     `cli_auth_credentials_store="file"` and the official `chatgpt_base_url` (also on every
     `login status` and `login --device-auth`).
2. **Second layer: Codex's own sandbox.** `--sandbox read-only` with `approval_policy="never"`:
   should a built-in tool remain, it can neither write nor reach the network, and nothing is
   escalated.
3. **Third layer: the event gate.** Claude announces its tool list (`system/init`), which the
   supervisor checks before relaying anything. `codex exec --json` announces none, so the
   supervisor judges every event (`checkCodexEvent`): a turn may only reason, message, keep a
   to-do list and call `updraft.exec`. A `command_execution`, `file_change`, `web_search`,
   collaboration call, another MCP server or tool, or any item or event type it does not know
   kills the CLI and every child before the event is relayed; the run fails with exit 125. The
   gate is late by design: exec emits an item when a call has already been dispatched, drops
   some item kinds, and does not forward sub-agent events. That is why prevention comes first.

`apply_patch` is the one built-in Codex still offers: it comes from the model's catalog metadata
(`apply_patch_tool_type`, `codex-rs/core/src/tools/spec_plan.rs`), and no supported config key
removes it (replacing the whole model catalog with `model_catalog_json` would, but that changes
much more than one tool). Codex's read-only sandbox refuses every patch
(`codex-rs/core/src/safety.rs`), and an attempt that surfaces as `file_change` ends the session.
So the model's instructions say to create and edit files only with shell commands through
`updraft.exec`, never `apply_patch`, which keeps a normal run from tripping the gate.

Other parts of the boundary:

- **Hooks.** `CODEX_HOME/hooks.json` is still a place the CLI discovers hooks when the feature is
  on. With `features.hooks=false` and plugins off the hook engine loads no handlers
  (`codex-rs/hooks/src/engine/mod.rs`); on top of that the supervisor refuses to start Codex (and
  reports it unavailable) if `hooks.json` or `hooks` exists in CODEX_HOME. Only the credential
  identity can write there.
- **Separate home.** Codex has its own 0700 home (`HOME = CODEX_HOME = <credential home>/codex`),
  so it never starts in Claude's home. Both CLIs still run as one credential identity, so a
  breakout of one CLI process could read the other's login. A separate UID per CLI (and a
  separate EFS access point) is a follow-up.
- **Native binary.** The worker config names the official native executable (resolved by
  `install.sh` from the platform package, as `bin/codex.js` resolves it), and `trustedFile`
  checks that binary and its directories; the npm wrapper is refused.
- **Root never touches credential-writable paths.** CODEX_HOME is created by the credential
  identity (`setpriv … mkdir -m 0700`), then only `lstat`-checked by root (a real directory it
  owns, private); a link stops startup. The credential home's lock is taken as the credential
  identity. A lock file left by an earlier supervisor (root 0600) is handed over in place: root
  opens it with `O_NOFOLLOW`, checks the open descriptor (a regular file, one link, owned by root)
  and `fchown`s it, keeping the inode so an old supervisor still holding it still excludes the new
  one; a link, a non-regular file, a hard link or another owner is refused, and it is never deleted
  or recreated. Tool sockets live in a root-owned directory the CLI can only traverse; session and
  status directories are emptied as their owner before root removes the empty directory; the
  namespace probe directory is created and removed by the job identity.
- `codex login status` runs before every session as the credential identity in a private
  directory; its output is classified by the same `native-codex-auth.js` and never relayed.
- The CLI's environment is fixed (`codexEnv`): PATH, LANG, HOME and CODEX_HOME, nothing
  inherited, so no key, CA, proxy or endpoint override can reach it. Stderr is never relayed;
  `error` and `turn.failed` text is relayed as one bounded line with URLs, e-mail addresses and
  token-like values replaced (`sanitizeCodexText`), enough for usage-limit handling.
- `security-check.mjs` (CI job "native worker credential isolation") runs the real supervisor,
  MCP bridge, UIDs and bubblewrap with a synthetic Codex CLI and a synthetic `auth.json`. The
  stand-in refuses to start unless every flag above is present (its own copy of the feature
  list). It proves repository commands cannot read `auth.json` (direct read, the supervisor's
  `/proc/<pid>/root`, a symlink, a Node subprocess, the environment); that a built-in tool event
  ends the session with no later tool call run; that API-key, access-token, signed-out and
  unreadable logins, a hooks file, and caller-chosen sandbox, provider, MCP or profile options
  fail closed; that a linked CODEX_HOME stops startup with its target unchanged and a linked lock
  file creates nothing; and that readiness stays a sanitized state.

**What this does not prove:** whether the real CLI, with these flags, offers the model no
built-in tool but `apply_patch` is a property of the pinned Codex release and must be verified
live (below). The feature audit, the sub-agent switch and the direct-mode model list are all
read from `openai/codex` 8727186 and must be re-checked for every Codex version the image pins.

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
- The pinned release accepts every flag under `--strict-config` (a key it does not know fails
  the run), and with them the model is offered only `updraft.exec` and `apply_patch`: no shell,
  exec, image, web search, apps/connectors, plugins, agent or browser tools. Ask it to read
  `auth.json`, to run commands and to use a ChatGPT connector; record that no
  `command_execution`, `file_change` or `mcp_tool_call` to another server appears, and that the
  gate kills the session if one does. Check that normal runs edit files through `updraft.exec`
  and never trip the gate with `apply_patch`.
- No sub-agent tools appear with `agents.enabled=false` (the catalog's `multi_agent_version`
  would otherwise turn them on), and `gpt-5.5` (or whatever the pinned catalog lists without
  `tool_mode: code_mode_only`) offers `updraft.exec` as a direct tool. Re-check both, and the
  feature audit, for every pinned Codex version.
- MCP tool calls run without an approval prompt in `exec` with `approval_policy="never"` and
  `default_tools_approval_mode="approve"`.
- A real issue through implementation, review, revision and CI repair on the subscription, with
  no `OPENAI_API_KEY` or `CODEX_API_KEY` anywhere, and evidence of plan-backed usage.
- Refresh over several days; a revoked login fails without API billing; a second supervisor on
  the same storage cannot start.
