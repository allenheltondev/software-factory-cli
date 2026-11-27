# Codex on a ChatGPT subscription (#125)

How Updraft runs Codex on the owner's ChatGPT plan ("Sign in with ChatGPT") instead of an
OpenAI API key, on a host-native worker and on the hosted native worker. It reuses the design
that already runs Claude Code on a Claude subscription
([persistent-claude-worker.md](persistent-claude-worker.md),
[native worker](../deploy/aws-microvm/native-worker/README.md)), generalized by provider.

**Status:** the sign-in, the status checks before every run, the worker's isolated Codex
session, Cloud's Codex sessions and routing, the per-provider waiting notice and the console's
Connect ChatGPT page are built and checked in CI with a synthetic Codex CLI. Nothing here has
run against a real ChatGPT account yet (see the end).

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
     ignored. Audit, at `openai/codex` `rust-v0.172.0` (3d86e43, the release the image pins;
     `codex-rs/features/src/lib.rs`): every
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
     `web_search_request`, `web_search_cached`, `hosted_search_policy` (which would let a
     host-requested search mode override `web_search="disabled"`), `request_permissions_tool`,
     `exec_permission_approvals`, `memories`, `recommended_plugins`, `agent_message_board`,
     `agent_message_board_mcp`, `enable_mcp_apps`, `deferred_executor`,
     `send_message_to_user_async`, `artifact`. Every key is a `FeatureSpec` of that release:
     the image build runs the real pinned binary with these arguments and fails on any key it
     does not know (below). `js_repl` is `Stage::Removed`
     (ignored by the CLI) and not listed. Infrastructure flags (MCP startup, compression,
     retries, TUI) are left alone. Re-run this audit for every Codex version the image pins;
   - `agents.enabled=false`: the model catalog's `multi_agent_version` (v2 for most models)
     wins over both `multi_agent` features, and only `agents.enabled=false` turns sub-agents off
     (`multi_agent_version_override`, `codex-rs/core/src/config/mod.rs`);
   - `web_search="disabled"`, `check_for_update_on_startup=false`;
   - a direct-mode model only. A model whose catalog entry has `tool_mode: code_mode_only` reaches
     MCP tools only through code mode, which is off here, so it would have no usable tool. In
     `codex-rs/models-manager/models.json` at `rust-v0.172.0` (unchanged from 8727186) that is every gpt-5.6 and gpt-6.x model, the
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
read from `openai/codex` `rust-v0.172.0`, the pinned release, and must be re-checked for every
Codex version the image pins (the build guard catches a key that release does not know).

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

## Cloud: a Codex session per installation

Cloud keeps a managed session per installation **and provider**: Claude's, as before, and a
Codex session beside it on the same worker image. The two logins never share a VM, and a Codex
job never waits on a Claude sign-in.

**Stored data.** Claude's records keep their exact keys, so nothing is migrated and a live Claude
session is never retired by the deploy: the session row `TENANT#<id>` / `CLAUDE_SESSION`, waiting
jobs `CLAUDE_WAIT#<job>`, the worker `managed-<id>` (its `WORKER`, `MODE` and `QUEUE#` rows), the
waiting job id salt `claude-wait`, image policy records `NATIVE_IMAGE#<version>`, and the timeline
codes `claude_…`. Codex gets new keys beside them: `CODEX_SESSION`, `CODEX_WAIT#<job>`, worker
`managed-codex-<id>`, salt `codex-wait`, codes `codex_…` (`cloud/server/src/native/provider.ts`).
The capacity registry (`CLAUDE_CAPACITY`) is one record holding every lease, but each provider is
accounted on its own: concurrent environments, platform and tenant runtime hours, and platform
and tenant launches count only that provider's leases and counters, each against the same
configured limits (`NATIVE_MANAGED_*`). Claude's counters are the original fields (`seconds`,
`tenants`, `launches`, `tenantLaunches`); Codex's are new (`codexSeconds`, `codexTenants`,
`codexLaunches`, `codexTenantLaunches`). A lease carries `provider: "codex"` only for Codex; a lease
without it, as every existing one is, is Claude's, so Claude keeps its limits and Codex can never
take a Claude slot or budget. The platform can therefore run up to twice the configured concurrent
environments, one set per provider. Each provider's cleanup lists only its own leases and runs on
its own (one failing never skips the other), and each lease's session check names its own
session record. A stored worker id, job or queue route that names no Codex worker is Claude's.
Waits and deliveries name Codex explicitly (`provider: "codex"` on the waiting record, the delivery
record and the workflow's `signInProvider`); a record without it is Claude's.

**Only on an image verified with Codex.** Codex is offered and started only where the deployed
subscription image (`ManagedClaudeImageVersion`) has a Codex capability record
(`NATIVE_IMAGE#<version>` / `CAPABILITIES`, `codex: true`, beside its policy record, so a policy
write never drops it). The image build writes it (`build-job-image.ts --native-claude`) only after
that version passed the Claude smoke check and a Codex session smoke check (the image starts with
the Codex run hook, serves `/codex-login` and refuses `/claude-login`). Without it, an older image,
or the window between a backend deploy and the image build, the Connect ChatGPT card is hidden,
`/codex-subscription/connect` says the image cannot run Codex yet, the managed Codex stack refuses
to start or launch a session, and dispatch refuses a ChatGPT-plan trigger as unavailable (below).
A failed Codex smoke never blocks a Claude rollout: the version is published and approved for
Claude, no capability is recorded, and the image job warns in its log and step summary.

**Worker.** A Codex session's run hook adds `"provider": "codex"` to the cloud settings; Claude's
run hook is byte-for-byte as before, so an existing Claude VM on an older image is unaffected. Each
VM serves only its own provider's sign-in route (`/claude-login` or `/codex-login`). The worker
then reports Codex's login (`codex login status`) as its readiness, tells the root job runner
(`UPDRAFT_NATIVE_PROVIDER`, from the run hook, never from the job) to put the workflow's Codex
profiles on the native runtime, and leaves every other agent on its sandbox and API key.

**Routing.** The console's ChatGPT page chooses the published workflow triggers (repository and
label) whose workflows use Codex, exactly as the Claude page does for Claude. A delivery is routed
once, to one place:

1. Claude's subscription is decided first, exactly as before (a trigger the Claude page chose, for a
   workflow that needs `ANTHROPIC_API_KEY`).
2. Only if Claude's does not take it: Codex's, for a workflow that needs `CODEX_API_KEY` on a trigger
   the ChatGPT page chose, with Codex routing on.
3. Otherwise the API-key path, as before.

Codex work never falls back to an API key. If Codex's routing cannot be read (a throttled session,
mode or capability read), a delivery that could be Codex's fails retryably (the webhook answers 500
and GitHub redelivers it): an issue Claude does not take whose workflow needs `CODEX_API_KEY`, any
pull request event whose origin job is not kept, and work pinned to the Codex worker. Claude work
and workflows that never need Codex's key go on. On an image without the Codex capability the Codex
route still resolves, with its mode and triggers, marked unavailable: a ChatGPT-plan trigger is
refused (`native_worker_unavailable`) with one comment saying the worker image does not support
Codex yet and that no API key was used. Work pinned to a worker (a pull request's revision
or CI fix, a console retry) stays on that worker or is refused; it never moves between Claude, Codex and API keys. A trigger taken by one
subscription is not offered on the other's page. The delivery claim and the stable waiting job id
make a label start one job at most, whatever the route.

**Keys.** A Codex session's job is never given `CODEX_API_KEY` (and a Claude session's never
`ANTHROPIC_API_KEY`): the launcher records the job's scoped `agentKeys` without it and the broker
drops the session provider's own key again. Another agent's key in the same workflow (a Claude
reviewer, say) stays BYOK.

**Waiting.** A Codex job that needs a sign-in is parked like Claude's and gets one comment, only
when a person must act: "Codex needs you to sign in with ChatGPT before this job can start", with a
link to the installation's ChatGPT page. A retirement says which Codex session ended and why; the
timeline records it as `codex_session_<reason>` or `codex_<readiness>`.

**Console.** *Connect ChatGPT* (`/installations/<id>/codex`, linked from the Claude page and Agent
keys) starts the Codex session and opens the worker's private `/codex-login` frame, which shows only
OpenAI's verification page and the one-time code. The frame sends nothing to the worker, and the
page gets only a status. The page shows the session's sanitized state (connected, needs sign-in,
offline) and the routing choices.

**Image.** One image for both CLIs (`build-job-image.ts --native-claude`): Claude Code and Codex are
each pinned to an exact release (`NATIVE_CLAUDE_VERSION`, `NATIVE_CODEX_VERSION` = 0.172.0 in
`job-image-context.ts`); `install.sh` records Codex's native binary from the pinned platform package.
The feature list is audited against `rust-v0.172.0`. **Build guard:** `install.sh` then runs
`codex-config-check.mjs`, which runs that real binary once with the worker's whole `codexArgs`
argv under `--strict-config`, offline and signed out: a fresh empty `CODEX_HOME`, an empty cwd, no
inherited environment, every proxy variable pointing at a closed local port, and `/bin/false` as
the one MCP server. Codex validates every `-c` override first and then fails to start the required
MCP server, before any thread, model or network call; that exact outcome passes, and anything else
(above all `unknown configuration field`) fails the image build. So a feature key a new pin no
longer knows can never ship.

The readiness checklist reports Codex's session as its own check (`codex-subscription`, #200).

Still to do: a separate credential UID per CLI, and a connected-account page shared with
Claude's (#123).

## Verify live, with a real ChatGPT account

- With the real 0.172.0 CLI and a ChatGPT login, the model is offered only `updraft.exec` and
  `apply_patch` (the build guard proves the flags are accepted, not what they leave on).
- On staging: Connect ChatGPT starts a Codex session on the current image, the frame shows the page
  and the code, and the page turns connected; an existing Claude session keeps running through the
  deploy; a label on a ChatGPT-routed workflow starts one job on the Codex session with no
  `CODEX_API_KEY` anywhere in the job.

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
