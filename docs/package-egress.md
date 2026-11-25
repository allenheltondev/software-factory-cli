# Package registry access for sandboxed commands

Issue #147. In the hosted native Claude worker, every repository command runs in bubblewrap
with `--network none`: the agent's `exec` tool calls and the action's verify commands alike.
Before this change that meant no `npm ci`, `pip install` or `cargo fetch`. A clean checkout
could not run its own tests, and reviews reported `ENOTFOUND` and "no network" instead of
results.

Sandboxed commands can now open TLS connections to allowlisted package-registry host names,
through a proxy the supervisor runs outside the sandbox. They have no other network route. The
sandbox keeps `--network none`. Nothing about its namespaces, mounts or identities changes.
This is a host-level boundary, not a guarantee that only dependency downloads happen: see
[What the boundary is](#what-the-boundary-is).

## How it works

```text
sandbox (--network none, job identity)          supervisor (root, outside)
  npm / pip / cargo / go / gem / git
     │ HTTPS_PROXY=http://127.0.0.1:<port>
     ▼
  egress-shim.mjs  ── sandbox's own loopback ──► /updraft-egress/proxy.sock ──► egress-proxy.mjs ──► registry:443
  (relay, prints refusals)                       (bind mount, read-only)        (the policy)
```

- **`image/sandbox/egress-proxy.mjs`** is the policy. It accepts HTTPS `CONNECT` only, to port
  443, and only to a host on the allowlist. It resolves the name itself and connects to the
  address it checked. If **any** address of the name is not public, the request is refused:
  loopback, RFC 1918, link-local (including the instance metadata service), CGNAT, multicast,
  documentation, IPv6 unique-local (`fd00:ec2::254`), IPv4-mapped and NAT64 forms of those,
  and everything outside `2000::/3`. That blocks DNS rebinding and registry names that point
  inward. A redirect is a new `CONNECT` and is checked again. Plain HTTP forwarding and IP
  literals are refused.
- **Each tunnel is bound to TLS for the name it asked for.** After the `200`, the proxy reads
  the client's first bytes before forwarding any of them upstream. They must be a TLS
  ClientHello (it may span several records, up to 16 KiB) whose SNI names exactly the
  `CONNECT` host. Plain bytes, a missing SNI, a different name, Encrypted Client Hello (where
  the visible name is not the real one) and malformed or oversized hellos are refused with a
  TLS `access_denied` alert. Nothing reaches the registry address first.
- **`image/sandbox/egress-shim.mjs`** runs in front of each command inside the sandbox. It
  relays the sandbox's loopback to the socket and sets `HTTPS_PROXY`, `HTTP_PROXY`,
  `npm_config_*proxy`, `YARN_HTTP(S)_PROXY` and `CARGO_HTTP_PROXY`, with `NO_PROXY` set for
  loopback. It decides nothing. A tool that ignores these variables has no network, as before.
- The socket's directory is `root:<job group>` mode `0710`, and the socket is `0660`. The
  Claude CLI's own identity cannot open it.
- **Bounds at every stage.** A hard limit of 64 live client sockets, whatever their stage: an
  incomplete request head, DNS, connect, TLS hello, tunnel, or a refusal still being flushed.
  A socket counts until it has physically closed. Beyond the limit, Node destroys a new
  connection on arrival, before any handler, timer or write. Drops are counted, and logged at
  most once a second. The shim reports such a connection as `proxy-busy`. Up to 32 are past DNS
  (connecting or tunneled). Concurrent requests for one name share a single resolver call, as
  package managers open many tunnels to one registry at once. That call has one completion
  handler. Each request waits as a waiter that is detached on its own deadline and when its
  connection ends, so a resolver that never settles holds one entry, not one per request. Up to 8 distinct names may be resolving
  at a time, and a lookup whose deadline passed still counts until the resolver returns, so
  hung lookups cannot pile up. Deadlines:
  10 s for the request head, 5 s for DNS, 10 s to connect, 10 s for the ClientHello, 120 s
  idle in a tunnel, plus 8 KiB per request head (complete or not) and 2 GiB per tunnel. Ending
  a connection is terminal and happens once: its timers, listeners, upstream socket and slots
  are released together, and a late DNS answer or connect is ignored.

The tool description and the agent's system prompt say which mode is active. With egress on,
the agent is told to install locked dependencies with the repository's own package manager, to
report the exact command and error when a check cannot run, and never to describe an unrun
check as passing.

## Defaults

`deploy/aws-microvm/native-worker/worker.example.json`, installed as
`/etc/updraft-native-worker.json`, turns egress on with the default registries and a 600 s
limit per tool command (it was 120 s, too short for a cold install of a larger project):

| Ecosystem | Hosts |
| --- | --- |
| npm, pnpm, Yarn, Corepack | `registry.npmjs.org`, `registry.yarnpkg.com`, `repo.yarnpkg.com` |
| pip, uv, Poetry | `pypi.org`, `files.pythonhosted.org` |
| cargo | `index.crates.io`, `static.crates.io`, `crates.io` |
| Go modules | `proxy.golang.org`, `sum.golang.org` |
| gem, Bundler | `rubygems.org`, `index.rubygems.org` |
| Maven Central | `repo.maven.apache.org`, `repo1.maven.org` |
| NuGet | `api.nuget.org` |

Not allowed by default: GitHub (`github.com`, `codeload.github.com`, release assets), other
source hosts and every other site. A dependency fetched from git, or a postinstall script
that downloads a binary from GitHub (some Playwright, esbuild-style or Prisma setups), fails
with an `updraft-egress:` line naming the host. Bake such tools into the image
(`TOOL_PACKAGES`, `PLAYWRIGHT_*` in `image/build.env`) or add the host deliberately.

## Configuration

The `egress` section of the worker config, validated when the supervisor starts. An invalid
section stops it from listening.

```json
{
  "toolTimeoutSeconds": 600,
  "egress": {
    "defaultRegistries": true,
    "allowHosts": ["npm.pkg.example.com", "*.artifacts.example.dev"],
    "shim": "/usr/local/lib/updraft-egress/egress-shim.mjs"
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `egress` | absent: no network | Present: registry egress on |
| `egress.defaultRegistries` | `true` | Include the table above |
| `egress.allowHosts` | `[]` | Extra hosts: an exact name, or `*.example.com` for names *below* example.com (not the apex). No IPs, ports, URLs or `*` alone |
| `egress.ports` | `[443]` | Ports a `CONNECT` may name |
| `egress.maxConnections` | `32` | Concurrent tunnels (1 to 256) |
| `egress.shim` | required | The shim's path. Must be under `/usr`, root-owned and not writable by others |
| `toolTimeoutSeconds` | `120` | Time limit per `exec` command (10 to 1800). The example config sets 600 |

Removing `egress` restores the old behavior exactly: `--network none` with no route out. With
no `egress` section, per-installation hosts are ignored too (the supervisor logs
`"decision":"off"`): an installation can never turn the network on.

## Per-installation registries (#157)

An installation whose repositories install from a private registry or a mirror (for example
`npm.pkg.github.com`, `acme.jfrog.io`, a CodeArtifact or Artifactory host) adds it in the
console: **Claude subscription → Package registries**. Only an owner of an active installation
can change the list; members see it read-only.

- **What is accepted.** One host per line: an exact name (`npm.pkg.github.com`), or
  `*.example.com` for every name *below* example.com (not the apex). At most 20. Refused with a
  message at save time: IP addresses (any form), ports, URLs and paths, a bare `*`, single-label
  names, internal names (`.local`, `.internal`, `.corp`, `.lan`, `.home.arpa`, `.arpa`,
  `.localhost`, `.test`, `.example`, ...), and wildcards over a shared domain where anyone can
  get a name (`*.amazonaws.com`, `*.jfrog.io`, `*.github.io`, `*.co.uk`, ...: the list in
  `SHARED_SUFFIXES` of `egress-proxy.mjs`, which is not exhaustive). List the exact host there
  instead. A test holds Cloud's check and the worker's to the same answers.
- **When it applies.** Cloud reads the list when it assigns a job to the worker, and hands it
  over with that assignment. The supervisor adds the hosts to the image's for that job and
  removes them when the job's runner exits. A change saved during a job applies from the next
  job; the running job keeps the list it started with. Every change of the proxy's list, at the
  start and at the end of a job, first drops every live proxy connection, so nothing admitted
  under one job's list carries into the next.
- **How it reaches the job.** Only over the worker control channel: the worker's root
  dispatcher calls the broker with its control credential, and the poll answer that assigns a
  job carries `{ jobId, hosts }`. The dispatcher passes it to the supervisor in process, with the
  job id of the assignment. Nothing the job identity, the sandbox, the agent or the repository
  can write is read: not the supervisor socket's frames, not the prompt, not repository files,
  not issue text. The security check attacks this (socket frames carrying `egress` and
  `allowHosts`, a prompt naming hosts) and confirms the host stays refused.
- **Tenant binding.** The list is stored per installation (`TENANT#<id>` / `EGRESS`) and read
  for the installation the worker's route belongs to. The supervisor applies a list only if it
  names the job id of the assignment it came with; a list for another job is ignored entirely.
- **Fail closed.** Any doubt gives the job the image's hosts only, never part of a list, and the
  reason is logged: a stored list that no longer validates (Cloud logs
  `{"nativeWorker":"egress","reason":"invalid-stored-policy"}` and the console shows the list
  as not applied), an entry the worker refuses (`invalid-host`), more than 20 (`too-many-hosts`),
  an unexpected shape (`malformed`), another job's list (`other-job`). If Cloud cannot read the
  list, the poll fails before the assignment is written: no job is handed out and the job stays
  queued, but the broker answers the worker with an error, and the worker's dispatcher stops on
  it as on any uncertain broker answer. That worker takes no more jobs; it needs operator
  recovery (for a managed worker, a restart and a new sign-in), and the queued job waits for the
  next worker. If the supervisor cannot apply a list, or cannot remove one after the job's runner
  exits, the dispatcher stops too: before the job runs, or before it polls for the next one.
- **Same checks as every other host.** An installation's host gets the same treatment as a
  default registry: HTTPS `CONNECT` to an allowed port, every resolved address public (a name
  that resolves to a private, loopback or metadata address is refused, also when only one of
  its addresses does), the TLS SNI bound to the name, the same limits and deadlines.

The supervisor logs each change: `{"event":"egress-policy","jobId":...,"decision":"apply"|"defaults-only"|"reset"|"off","hosts":[...],"reason":...}`.

This list applies to Claude subscription (native worker) jobs only. The standard Cloud path
already reaches every public host (see [Limitations](#limitations-and-follow-ups)).

## What a failure looks like

Each distinct refusal during a command is printed once to stderr after the command ends. It
appears in the tool result the agent reads and in the verification section of `run.log`:

```text
npm error 403 Forbidden - CONNECT tunnel failed
updraft-egress: refused CONNECT github.com:443 (not-allowed): the host is not an allowed package registry
```

| Reason | Stage | What to do |
| --- | --- | --- |
| `not-allowed` | policy | The host is not on the allowlist. An installation owner adds it in the console (Claude subscription → Package registries); it applies from the next job. An operator can add it for every installation with `allowHosts` |
| `policy-changed` | policy | The job ended, or the next one started, while this request was being checked. Not seen during a job |
| `ip-literal`, `port-not-allowed`, `https-only` | policy | The tool asked for an address, another port or plain HTTP. Use the registry's HTTPS host name |
| `non-public-address (<range>)` | DNS result | The name resolves to a private, loopback or metadata address. Never reachable from a job |
| `dns-failure (<code>)`, `dns-timeout` | DNS | The registry's name does not resolve from the worker, or not within 5 s. Check the microVM's egress connector |
| `request-timeout` | request | The client opened a connection and did not send a complete `CONNECT` within 10 s |
| `tls-refused` | TLS | The tunnel did not start with a ClientHello for the `CONNECT` host: not TLS, no or another server name, or Encrypted Client Hello. The supervisor log names which (`tls-required`, `tls-no-sni`, `tls-authority-mismatch`, `tls-opaque-handshake`, `tls-malformed`). Clients see a TLS `access denied` alert |
| `connect-failed (<code>)`, `connect-timeout` | network | The registry refused or did not answer: an outage, or the worker has no internet egress |
| `too-many-connections` | limit | Too many tunnels, or too many distinct names resolving at once. Lower the tool's parallelism, or raise `maxConnections` |
| `proxy-busy` | limit | The proxy was at its hard limit of live connections and closed this one unanswered. Lower the tool's parallelism, or retry |
| `proxy-unavailable` | worker | The shim cannot reach the proxy socket. The supervisor's egress did not start: check its log and config |

Registry authentication errors (401 or 403 from the registry itself, after the tunnel is up)
and TLS errors come from the package manager, not from the proxy. They have no
`updraft-egress:` line. A private registry that needs a token answers 401 here: credentials are
not supported yet (see [Private registry credentials](#private-registry-credentials)).

An installation's host still refused during a job:

- The host was saved after the job was assigned. It applies from the next job.
- The console shows the list as not applied (the saved list no longer validates). Correct it and
  save again. The supervisor log says `"decision":"defaults-only"` with the reason.
- The host is refused as `non-public-address`: its name resolves to a private address, for
  example a registry inside a VPC. Jobs never reach those, whoever allows them.
- The registry redirects downloads to another host (a CDN or object storage). The refusal names
  that host; add it too, as an exact name.

The supervisor logs one JSON line per decision on stdout:
`{"event":"egress","decision":"allow"|"deny"|"closed","target":"host:443","reason":...,"bytes":...}`.
It logs targets, reasons and byte counts, never request or response contents.

## What the boundary is

What the proxy enforces, and nothing more:

- A command can open a TLS connection to an allowlisted host name on an allowed port. The
  connection goes to an address that name resolved to, every one of which is public, and the
  TLS ClientHello must name that host in its SNI. That check gates the **initial ClientHello
  only**. Once it passes, every later byte of the connection (the rest of the handshake, the
  encrypted records, the HTTP authority inside them) is relayed unexamined. Nothing else leaves the sandbox: no other
  host, no address, no plain HTTP, no non-TLS protocol, and no route at all for a tool that
  ignores the proxy variables.

What it does **not** enforce, because it does not decrypt TLS (deliberately: no interception,
no certificate of its own, nothing that could read registry tokens):

- **What happens inside the TLS session.** Paths, methods and bodies are not seen. An allowed
  host is reachable for uploads as well as downloads, for example `npm publish` with someone's
  token. Treat every allowed host as a place repository content could be sent to.
- **Which origin a shared edge serves.** Registries sit behind CDNs whose addresses serve many
  unrelated sites. The SNI check keeps a client from naming another site in the handshake, but
  a client that sends the right SNI and then asks for another site in the encrypted HTTP
  `Host` header ("domain fronting") is stopped only if the CDN refuses that mismatch. Most
  large CDNs do, but this proxy cannot verify it.
- **Server authentication.** The client validates the registry's certificate, and an untrusted
  client may skip that. Skipping it lets the client accept an impostor. It does not widen
  where the connection goes.

So registry egress is a bounded, host-level allowance, not a guarantee that only dependency
downloads happen and not an exfiltration control. That is acceptable here because:

- The sandbox holds no credentials (README, "Execution boundary"). What could leave is the
  repository content the job already holds, which the agent can put in a pull request anyway.
- If one host must be limited to downloads only, the answer is a constrained fetch mechanism,
  such as a registry mirror the proxy alone talks to, not a wider allowlist (see
  [Private registry credentials](#private-registry-credentials)).

The same holds for an installation's own hosts. Adding one does **not** make it download-only
and is **not** an exfiltration control: a job can send repository content to it, as to any
allowed host. What per-installation lists add is scope: a host one installation allows is
reachable only during that installation's jobs, never during another's.

## Private registry credentials

Decision (#157): **no credential is ever given to the sandbox, and the opaque `CONNECT` proxy
does not inject one.** Private registries can be allowed by host today; one that needs a token
answers 401.

Why the proxy cannot simply add `Authorization`: a `CONNECT` tunnel carries TLS end to end
between the package manager and the registry. The proxy sees only the ClientHello. Adding a
header would mean terminating TLS: a certificate authority the sandbox trusts, the proxy
reading and rewriting every request on every allowed host, and a much larger trusted component
running as root. That is rejected. Putting the token in the sandbox (an `.npmrc`, an environment
variable) is rejected too: the agent, install scripts and repository code could read it, and
any allowed host could receive it.

The design to follow, as a separate change: a **trusted registry fetcher** outside the sandbox,
next to the proxy.

- The sandbox talks plain HTTP to a per-registry loopback address the shim exposes (for example
  `http://127.0.0.1:<port>/r/<name>/`), and the package manager's registry setting points there
  (`npm_config_@scope:registry`, `PIP_INDEX_URL`, ...). No TLS is terminated: the fetcher makes
  its own HTTPS request to the registry, validates the registry's certificate, and adds the
  token.
- **Download only:** `GET` and `HEAD`, no request body, paths under the configured prefix only,
  redirects followed by the fetcher itself to the same host or an allowed download host, never
  with the token on another host. Responses streamed back with size and time limits.
- The token is a job-scoped secret: saved write-only in the console (like agent keys), delivered
  by the broker to the root supervisor with the assignment, held in memory for the job, and never
  written to the sandbox, logs or caches. Tokens that echo back in responses (rare) are a risk to
  review per ecosystem.
- Registries that use the fetcher are not also put on the `CONNECT` allowlist, so the token path
  and the opaque path never share a host.

This also gives a download-only route for any registry, which the opaque tunnel cannot.

## Security notes

- Install scripts run, as they would on a developer machine, inside the same sandbox as the
  agent's other commands. To refuse them, use `npm ci --ignore-scripts` in the verify commands.
- The allowlist is by host, for the reasons above. It is not a malware filter, and a
  compromised registry package runs like any dependency.

## Limitations and follow-ups

- **Hosted native Claude only.** The standard Cloud (API key) path runs agents in the same
  sandbox *with* the microVM's network: the agent CLIs reach their model APIs from inside it.
  There, registries were already reachable, and so is every other public host except the
  credential addresses the packet filter blocks (`runner/isolation.mjs`).
- **Standard Cloud path: not narrowed yet (decision, #157).** Moving the standard path to
  `--network none` behind this proxy is deferred, not adopted, because it cannot be done safely
  without hosted validation of every agent:
  - each enabled agent CLI (Claude Code, Codex, Kiro, Mistral Vibe) must reach its model API,
    sign-in and token-refresh hosts through `HTTPS_PROXY` with `CONNECT`. Not every one is
    confirmed to honor the variable for every request, and a missing host breaks every job of
    that agent;
  - agent telemetry reaches the runner's OTLP relay on the microVM's loopback
    (`TELEMETRY_ENV`), which a separate network namespace does not have;
  - `checkAgentConfig` accepts `network: host` for these agents and the isolation self-test does
    not yet prove the reverse.
  Until it is adopted, the standard path keeps its current boundary: the packet filter that
  keeps every non-root user away from the credential addresses and the hook port
  (`runner/isolation.mjs`), with every public host reachable. Per-installation registry lists do
  not apply there (they would add nothing). The work to adopt it: a per-agent host table next to
  `DEFAULT_REGISTRY_HOSTS`, the shim in front of agent CLIs, an OTLP route through the proxy or a
  socket, `checkAgentConfig` requiring `network: none`, a self-test that a non-listed host is
  refused, and a hosted run of each agent.
- **No private registry credentials** yet: see [Private registry credentials](#private-registry-credentials).
- **No dependency cache across jobs.** Every job installs cold. This is predictable and works,
  and a cold install of this repository's `cloud/` workspace takes about 10 s. A lockfile-keyed
  cache is a possible optimization (#156).

## Evidence (local, not deployed)

Recorded 2026-11-25 on Linux with bubblewrap 0.9.0, using the real proxy (with the
admission bounds and TLS binding), real DNS, the real npm registry and the sandbox runtime
with `--network none`. A `git archive` export of this branch, made a git repository, with no
`node_modules` and a fresh `HOME` for each command:

| Command | Exit | Time |
| --- | --- | --- |
| `npm ci` (repository root) | 0 | 4 s |
| `cd cloud && npm ci` (app + server workspaces) | 0 | 8 s |
| `cd cloud && npm run lint` | 0 | 21 s |
| `cd cloud && npm run typecheck` | 0 | 11 s |
| `cd cloud && npm run test --workspace=app` | 0 | 10 s |
| `cd cloud && npm run test --workspace=server` | 0 (854 tests) | 9 s |
| `cd cloud && npm run build` | 0 | 6 s |

For the whole run the proxy logged 30 allowed tunnels, all to `registry.npmjs.org`, and no
refusal. An earlier run, before concurrent lookups for one name were shared, showed 13
`too-many-connections` refusals that npm recovered from by retrying. That is why lookups are
shared.

The same setup with other clients:

| Client | Result |
| --- | --- |
| `npm view is-number version` | `7.0.0` |
| `pip download six` (PyPI, files.pythonhosted.org) | downloaded |
| `curl https://registry.npmjs.org/` | 200 |
| `openssl s_client -connect registry.npmjs.org:443 -servername registry.npmjs.org` | handshake completes, certificate `*.npmjs.org` verifies |
| `openssl s_client ... -servername evil.example` (wrong SNI) | `tlsv1 alert access denied`, log `tls-authority-mismatch` |
| plain HTTP written into a registry tunnel | TLS alert, log `tls-required`, nothing forwarded |
| `git ls-remote https://github.com/...` | refused, `updraft-egress: ... (not-allowed)` |
| `curl --connect-to registry.npmjs.org:443:example.com:443 ...` | refused, `(not-allowed)` |

`security-check.mjs` (root, the real supervisor and MCP bridge, separate identities) adds four
egress checks, and all 20 checks pass.

**Not yet shown:** a deployed hosted subscription job and a standard Cloud job on AWS, and
CI-repair runs there. Those need a deployed native image built from this change.

Per-installation registries (#157), local only: the proxy over its socket with a stand-in
resolver (an installation's host reachable only during its job and never during another's, inward
and partly inward names refused, every connection dropped at each change, a lookup across a
change connecting nowhere), Cloud's worker control (the list bound to the assigned job, read
before the assignment commits, a change during a job reaching only the next one, an invalid
stored list sent as none), and `security-check.mjs` (21 checks, root, real supervisor) with the
socket-frame and prompt attacks. **Not yet shown:** a console save reaching a deployed worker's
next job, and a second installation's job on AWS refusing that host.
