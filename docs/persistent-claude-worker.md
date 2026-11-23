# Persistent Claude Code worker: native subscription proof (#100)

This is the first stage of [issue #100](https://github.com/allenheltondev/software-factory-cli/issues/100). It preserves Updraft's existing issue -> agent -> verification -> PR -> review -> revision -> merge pipeline and tests direct sign-in to the **unmodified official Claude Code CLI**.

## Current status

- **Implemented in this stage:** read-only, sanitized subscription status via `updraft native-auth --claude [--json]` and opt-in `agents.<name>.authentication: native-claude` to check direct subscription sign-in at the start of **every** Claude run (including implementation, review and revision). The early status check runs in the worker's environment; a second check immediately before the agent launches uses the agent's final environment **and the job worktree as its working directory**, so project-local Claude settings are considered. Only `connected`, `login_required`, `expired`, `wrong_method`, or `unknown` and a fixed reason leave the process. The command never reads, copies or forwards credential files, auth codes or stdout.
- **Already available:** `updraft start` and `updraft run-event` can use the official Claude Code adapter and retain implementation, review, revision and merge.
- **Not implemented yet:** a managed persistent worker lifecycle, tenant-scoped registration and heartbeat, GitHub webhook dispatch to these workers, terminal onboarding in the Updraft console, and proof that agent tool subprocesses cannot read Claude's native credentials. **Do not enable this as a production, multi-tenant hosted subscription feature yet.**
- **Not a Routines integration:** the work must continue through Updraft's own orchestration.

## User-controlled VM experiment

Use a **dedicated machine or VM per subscribing end user**, not a shared shell or worker account. Its system disk should be encrypted and its login kept across restarts. These steps establish CLI readiness only. Use a private test repository whose code and contributors you control while the credential/tool isolation work is unfinished.

1. Install official Claude Code following [Anthropic's installation guide](https://code.claude.com/docs/en/setup). Install Updraft and Git on the same host, with a normal non-root worker account.
2. In the worker account's interactive SSH/SSM terminal, use a persistent, worker-specific config directory. For example, on Linux:

   ```sh
   export CLAUDE_CONFIG_DIR="$HOME/.claude-updraft"
   umask 077
   mkdir -p "$CLAUDE_CONFIG_DIR"
   chmod 700 "$CLAUDE_CONFIG_DIR"
   unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
   unset ANTHROPIC_BASE_URL ANTHROPIC_PROFILE
   unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY
   claude auth login
   updraft native-auth --claude --json
   ```

   Complete the **Anthropic-hosted** browser login from that terminal. If sign-in requires a code, enter it *in the Claude CLI terminal only*. Never type the code or token into Updraft.
3. Exit the terminal, reconnect as the **same worker user** with the **same `CLAUDE_CONFIG_DIR`**, and rerun `updraft native-auth --claude --json`. Restart the VM and repeat. Confirm `connected` after both; use `claude auth status` directly for troubleshooting.
4. Configure `authentication: native-claude` on the Claude agent in your Updraft YAML config, then run `updraft validate`. For example:

   ```yaml
   agents:
     claude:
       enabled: true
       authentication: native-claude
   ```

   This opts every run by that agent (including review and revision) into fail-closed subscription checks before checkout and again immediately before launching the CLI with its final environment. It does **not** make the worker safe for untrusted repositories. The config validator currently rejects this option for containerized agents because native credential isolation remains unresolved.
5. With your existing Updraft config and GitHub credentials on that same machine, `updraft start` can process labeled issues and its configured review loop, or `updraft run-event --event-file ...` can run a single webhook event. **Do this only with trusted code during the prototype.** These commands do not establish safe tool isolation.

   For persistent operation on Linux, Updraft already ships a [systemd user launcher](background-operation.md#linux-systemd---user). **The systemd service must have the same `CLAUDE_CONFIG_DIR` as the terminal where you signed in**. For example, add this path (not a token) to the launcher's private `~/.updraft/worker.env`:

   ```sh
   mkdir -p "$HOME/.updraft"
   chmod 700 "$HOME/.updraft"
   printf 'CLAUDE_CONFIG_DIR=%s\n' "$HOME/.claude-updraft" >> "$HOME/.updraft/worker.env"
   chmod 600 "$HOME/.updraft/worker.env"
   # Install the existing launcher using its documented commands, then restart:
   systemctl --user restart updraft
   ```

   Configure the launcher before the restart and use the same non-root account and PATH as the login. Do not put the native Claude auth directory under Updraft's shared-state folder. The systemd `EnvironmentFile` points to a directory only; it must not contain a Claude subscription token.
6. To revoke sign-in, use `claude auth logout` directly on the worker. Remove the dedicated worker disk when terminating the worker under your own data-retention policy.

The status command intentionally returns no path, account identifier, token, auth method override value, or raw error, making it suitable for eventual UI telemetry. The preflight is a point-in-time check: if native login expires or is revoked *during* an agent run, the official Claude CLI is responsible for reporting the resulting execution error. Updraft does not continuously monitor or kill an already-running agent on a login-state change. A `connected` state is only a signal that Claude considers its own login usable now. It does **not** prove execution security or that Anthropic has approved the particular hosted use case.

## Native authentication probe contract

The status JSON parsing was verified in the existing CLI discovery implementation against **Claude Code v2.1.289**, including `loggedIn` and `authMethod` and the `api_key` method observed when `ANTHROPIC_API_KEY` was configured. The optional `loginExpiresAt` field (introduced in Claude Code v2.1.318) is parsed when present. When missing or null, the classifier **does return `connected`** if the CLI reports a valid `claude.ai` session: the expiry is *unknown*, not infinite, and the CLI still owns authentication on each model request. The official [CLI reference](https://code.claude.com/docs/en/cli-reference) documents `claude auth status`. The current PR includes mocked classification and OS CI tests; a live end-to-end `claude auth login` experiment and any changed fields in future CLI versions must be verified on the persistent worker.

The classifier accepts only `authMethod: "claude.ai"` and rejects `api_key`, `api_key_helper`, `oauth_token`, and any conflicting `apiKeySource`. This relies on the official CLI to accurately report its active auth method. The final probe runs from the checked-out job worktree to account for its project-local settings and `apiKeyHelper`, but it still relies on the official CLI's reported auth method. Updraft does not inspect or execute any credential helper itself. Project settings can change after the probe and the CLI may reload them mid-run, so this is **not a security boundary**. The hosted hostile-repository isolation proof remains blocking.

On Windows, Updraft's separate CLI discovery tests resolve recognized npm `.cmd` shims to a direct Node launch target before running the status command. The native-auth unit test exercises an already-resolved Node executable and does **not** itself test `.cmd` resolution. Unsupported shims fail closed. The command does not spawn a `.cmd` with `shell: true`.

## Security and commercial release gates

1. **License:** Anthropic's [legal and compliance documentation](https://code.claude.com/docs/en/legal-and-compliance) requires Commercial Terms for products offering Claude Code in hosted sandboxes, unmodified binaries, each user's direct authentication and no intermediary of subscriber traffic or subscription credentials. Obtain written confirmation for Updraft's hosting and access design before offering it commercially.
2. **Authentication ownership:** Claude alone manages `CLAUDE_CONFIG_DIR` and associated credential storage. Updraft must never mount that directory into its control plane, S3 shared state, job payload, Secrets Manager, logs, or a different tenant's worker. UI sign-in, OAuth callbacks, `claude setup-token` collection and `CLAUDE_CODE_OAUTH_TOKEN` relay are prohibited.
3. **Tool isolation, blocking:** Current `updraft start` with a host-native Claude process runs its tools as the same OS user and can read that user's credentials. Current containerized Updraft agents use a *temporary* HOME and receive no persisted auth. Simply mounting the persistent HOME into an agent sandbox would expose credentials to Bash, Read and potentially hostile repository commands. **A working shell/tool isolation design plus hostile-repo tests is required before enabling subscription workers for untrusted code or multi-tenant use.** Anthropic now supports [`sandbox.credentials`](https://code.claude.com/docs/en/sandboxing#protect-credentials), `sandbox.failIfUnavailable`, and `allowUnsandboxedCommands: false` to protect **sandboxed shell commands**. However, Anthropic documents that Read/Edit/Write, MCP servers, hooks and other CLI-launched processes can run **outside** the Bash sandbox, so this alone cannot satisfy the hosted security gate. A future worker proof must enforce restrictions on *all* tools and processes, keep the CLI itself unmodified, and test that nothing escapes into a credential-bearing home.
4. **Durability:** AWS Lambda MicroVMs have an eight-hour maximum lifetime. A per-job MicroVM cannot keep the native login across days; use a separate persistent, encrypted user-isolated worker, or prove a secure architecture that preserves *CLI-owned* auth without Updraft collecting credentials.
5. **Broker transport:** Add tenant-scoped worker registration, outbound polling/heartbeat, job leases, cancellation, retry and teardown. A job must dispatch to exactly one backend. Reuse `updraft run-event` and all review/revision/merge state. Never give a worker access to another tenant's app credentials, job state or files.

### Required adversarial tests before production

- Give a test repository malicious instructions and tool commands attempting to read native Claude credential files, `CLAUDE_CONFIG_DIR`, parent process environment, /proc process state, socket mounts, or another user's worker disk. All must fail without breaking normal source editing and verification.
- Restart the host, kill a running job, expire the CLI login and revoke the GitHub installation. Confirm that jobs cannot silently fall back to API billing or another tenant's credentials.
- Trigger a label twice and replay the webhook. Only one runner gets the lease; review/revision and merge events stay within the same Updraft state machine.

## References

- [Anthropic legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Claude Code authentication](https://code.claude.com/docs/en/authentication)
- [Claude Code CLI reference (`claude auth status`)](https://code.claude.com/docs/en/cli-reference)
- [AWS Lambda MicroVM lifetime](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)
