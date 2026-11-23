# EFS-backed native Claude worker experiment (#100)

**Acceptance status: incomplete.** This implements a candidate boundary without EC2. Local
Linux attacks pass and official Claude Code 2.1.330 accepts the isolation flags while signed
out. EFS on Lambda MicroVMs, authenticated tool initialization, authentication across actual
MicroVM replacement, and a subscription-backed issue/PR/review/revision remain unverified.
The proof must fail if any of those tests fails; there is no weaker execution fallback.

## Execution boundary

```text
Updraft (UID 1000) -> docker-shaped runtime -> root supervisor
                                              |
                     +------------------------+---------------------+
                     |                                              |
          Official Claude CLI (UID 1001)                  Verification commands
          private cwd; EFS-backed HOME                              |
          native login/refresh owned by CLI                         |
          no built-in tools, hooks or project settings               |
                     |                                              |
          one MCP tool: updraft.exec                                 |
                     |                                              |
          trusted stdio shim -> private Unix socket                  |
                     |                                              |
                     +---> existing bubblewrap sandbox <------------+
                           UID 1000, narrow worktree/git mounts
                           fresh HOME and PID/mount/user/network namespaces
                           no native auth home, host processes/sockets or network
```

Claude starts outside the repository with `--restricted`, empty `--setting-sources`, disabled
hooks/slash commands, `--tools ""`, `--strict-mcp-config` and exactly one approved MCP tool.
Repository reads, edits, git and tests all use that tool. Arbitrary profile flags, custom
environment variables, resume paths, plugins, extra directories and additional tools are
refused. The initialization inventory must contain only `mcp__updraft__exec` and optionally
`EndConversation`; a changed CLI tool surface fails closed before tools may execute.

The supervisor uses **PR #101's classifier**, imported from the installed Updraft distribution.
Every Claude launch checks restricted `auth status` from a private directory with a fresh
environment. Wrong/expired/missing auth fails; raw status and CLI startup stderr are withheld.
No component reads, copies, serializes or uploads credential files. The official CLI alone
manages its home. A supervisor-created advisory lock contains no credentials.

EFS access points replace the client's POSIX identity, so their UID and root `0700` mode alone
are insufficient. The mount is `/var/lib/updraft-native-auth/home`, beneath a **local** ancestor
owned by UID 1001 with mode `0700`. Local traversal is denied before NFS can remap the caller.
The job sandbox additionally cannot mount paths outside `workRoot` or reach NFS over the network.
A nonblocking NFS-backed `flock` excludes a second supervisor; actual cross-MicroVM lock
recovery remains a live acceptance test. Children have cleared supplementary groups,
no-new-privileges and parent-death signals; disconnect/stop/shutdown cancels their execution.

The trust boundary includes root, the kernel, root-owned installation/configuration and the
official CLI. The experiment does not enable Cloud dispatch or protect source code from model
requests authorized by the job. Networking for repository code is disabled: bake dependencies
and tools into the image. Triage, background jobs, arbitrary agent flags, alternate adapters,
suspend/resume and sharing this storage between tenants are outside this proof.
Prompts are limited to 512 KiB, each tool command to 120 seconds/256 KiB output, and each
verification command to 2 MiB output. A blocked transport also closes rather than buffering
unlimited output; larger production workloads need a separately reviewed resource policy.

## Reproduce the local checks

```sh
npm ci
npm run build
npm test -- deploy/aws-microvm/test/native-worker.test.mjs
# Linux root, bubblewrap and util-linux; unsupported namespaces FAIL, never skip.
sudo node deploy/aws-microvm/native-worker/security-check.mjs
# Root-installed official executable; temporary signed-out home, no operator auth files.
sudo node deploy/aws-microvm/native-worker/official-cli-check.mjs /absolute/path/to/claude
```

The security check uses a synthetic Claude CLI and synthetic credentials, but the real root
supervisor, MCP transport/shim, separate UIDs and bubblewrap. It attacks credential reads,
parent `/proc`, symlinks, Node subprocesses, mounting, sockets, loopback and metadata endpoints;
it also exercises verification, edits/commits/tests, auth rejection, inventory rejection,
cancellation, lock exclusion and supervisor replacement. Its explicit storage-probe injection
is available only to the in-process test, never through CLI/environment/payload configuration.

The official check was run with **2.1.330**. It confirms restricted signed-out status, accepted
isolation flags, and rejection of hostile repository startup helpers/hooks/MCP. It does not
prove authenticated model behavior. CI includes a separate Linux security job without skips.

## Prepare a separate AWS proof deployment

1. Create a dedicated per-tenant execution role, a customer-managed MicroVM VPC egress
   connector, and two private subnets in different AZs. Supply EFS DNS/NFS connectivity and
   outbound HTTPS for Claude/GitHub. Keep repository tools in their empty network namespace.
2. Deploy `storage.yaml` with those IDs and the role ARN. It creates a dedicated encrypted,
   backed-up EFS filesystem/access point and mount targets. Mount access requires TLS, the
   tenant role and an access point; no filesystem-root mount is granted. Do not share this
   filesystem between tenants. IAM administrators remain trusted. Data is **retained** on
   stack deletion/replacement; explicitly remove it when decommissioning the worker.
3. Build and pack the current CLI, then prepare a new image context:

   ```sh
   npm run build
   npm pack
   sh deploy/aws-microvm/native-worker/package-image.sh /tmp/updraft-native-image
   cp allenheltondev-updraft-*.tgz /tmp/updraft-native-image/vendor/
   ```

   Pin the official Claude package in the copied `build.env`; 2.1.330 was compatibility-tested.
   The context extends the reference image with EFS/util-linux tooling and a separate
   entrypoint. Installation resolves the actual official executable path, including native
   npm binaries. Never log in during image build or snapshot an authenticated home.
4. Zip/upload that context and create a **separate** MicroVM image using the existing
   deployment's build-role/base-image/resources shape. Grant additional OS capabilities
   `ALL`; enable ready/run/terminate hooks on port 9000, run timeout 60 seconds. Do **not**
   configure automatic suspension or suspend/resume hooks for this experiment. Existing
   `deploy.sh image`, the BYOK image and Cloud dispatch remain unchanged.
5. Launch with the dedicated role, VPC egress connector, the provider's authenticated direct
   shell access, and a run-hook payload containing only these references:

   ```json
   {"fileSystemId":"fs-REPLACE","accessPointId":"fsap-REPLACE"}
   ```

   The lifecycle hook mounts with TLS/IAM, checks the mount and local permissions, acquires
   the durable lock, and executes a real namespace probe before returning success. Any
   mount/IAM/tooling/namespace failure returns 503 with no local-storage fallback. Compatibility
   of `amazon-efs-utils` with MicroVM role credentials, DNS, capabilities and VPC connectors is
   **unverified** and must be established on AWS. Do not route production events here.

## Direct sign-in and Updraft execution

From a direct operator terminal on the worker, run the unmodified official CLI:

```sh
cd /
setpriv --reuid 1001 --regid 1001 --clear-groups -- \
  env -i PATH=/usr/local/bin:/usr/bin:/bin \
  HOME=/var/lib/updraft-native-auth/home \
  CLAUDE_CONFIG_DIR=/var/lib/updraft-native-auth/home/.claude \
  claude --restricted --setting-sources '' auth login
```

Use the same identity/environment with `auth status` or `auth logout`. Updraft must not record
terminal input, auth codes or OAuth URLs. Issue #100's commercial-hosting review remains in force.

Merge `updraft.example.yaml` into the existing trusted live configuration. Use both profiles
in the existing implementation/reviewer pools and retain verification/publication/revision
settings. Do not set `authentication: native-claude` on these container profiles: the generic
container guard remains intact. This **specific runtime** applies the same native subscription
classifier before every real Claude launch; no other container receives an exception.

Run Updraft as UID/GID 1000. Put clones (`checkoutPath`) and `UPDRAFT_HOME` beneath
`/var/lib/updraft-jobs`, giving that account ownership of its clone/control/state directories.
Generated worktrees then stay within the allowed root. Keep the existing GitHub App credentials
and configuration. Run `updraft validate`, `updraft doctor`, then the existing
`updraft run-event --event-file ... --event-name issues --delivery-id ... --json`.
Implementation, verify, PR creation, review and revision use the existing state machine.

Every agent must use the prototype runtime, `network: none`, and empty agent/container env.
Do not introduce a host-native agent or host verification wrapper. Existing narrow/read-only
git mounts protect metadata that host git would later obey. No Cloud registration, heartbeat,
dispatch, SSH server or custom login UI is added by this prototype.

## Live acceptance checklist — all still pending

- Real MicroVM mounts EFS; UID 1000 cannot traverse its private **local** parent, and tool/verify
  commands cannot read a synthetic canary, inspect Claude, reach NFS or obtain AWS credentials.
- A real subscription model job initializes with exactly the permitted MCP inventory. Hostile
  instructions cannot restore built-ins, load hooks/helpers/plugins, or read native auth state.
- Terminate the MicroVM and launch a replacement using the same access point. Native auth
  status and a model request succeed without another login or credential copying.
- A concurrent worker cannot obtain the EFS lock; abrupt MicroVM loss releases it safely.
- A throwaway issue completes implementation, verify, PR creation, review and at least one
  revision. Record issue/PR/run IDs, tool inventory, restart result and attack outcomes without
  credentials, raw auth JSON, OAuth URLs or copied CLI-home files.
- Expired/revoked login fails without API billing fallback. Cancellation/worker termination
  leaves no executing model/tool subprocess.

Any failed item leaves the proof incomplete. Registration, leasing/dispatch and setup UI follow
only after these pass.

Sources: [MicroVM lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html),
[mount capabilities](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html#microvms-images-os-capabilities),
[networking](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html),
[Claude CLI](https://code.claude.com/docs/en/cli-reference),
[sandbox limits](https://code.claude.com/docs/en/sandboxing).
