# Agent telemetry

Updraft Cloud can send what each job's agents did to the tenant's own tracing tool, as
OpenTelemetry traces in the [GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai):
every model call, tool call, verification and review round, in order, with one issue's jobs as
one conversation. Any backend that accepts OTLP/HTTP can store them; one that reads the GenAI
conventions also shows them as an agent conversation.

In Updraft Cloud it is set up per installation in the console, under **Agent telemetry**: where
the traces go (see [Destinations](#destinations)), the service name, and whether prompts and
outputs are recorded. Running Updraft yourself, the standard OpenTelemetry variables turn it on
(see [Running it yourself](#running-it-yourself)). Without any of it, the job page still shows what the runner saw (see
[What the console shows](#what-the-console-shows)).

## Destinations

### Honeycomb

A Honeycomb Ingest key, checked with Honeycomb's `/1/auth` before it is saved, and the region (US
or EU). The runner sends to `https://api.honeycomb.io/v1/traces` (or `api.eu1`) with the key in
`x-honeycomb-team`; the service name is the dataset. Honeycomb's
[Agent Timeline](https://docs.honeycomb.io/investigate/observe/agent-timeline), on every plan
including the free one, shows each conversation. The key's team and environment slugs make the
console's links: a [direct trace link](https://docs.honeycomb.io/investigate/collaborate/share-trace)
and a [shared query](https://docs.honeycomb.io/investigate/collaborate/share-query) for the
conversation.

### CloudWatch

An AWS region and an X-Ray API key. The runner sends to X-Ray's
[OTLP traces endpoint](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html)
in that region, `https://xray.<region>.amazonaws.com/v1/traces`, with the key as
`Authorization: Bearer <key>`; it takes OTLP/HTTP with JSON. The traces are in CloudWatch's
Transaction Search, where the `gen_ai.*` attributes, the service name and
`gen_ai.conversation.id` can be searched and grouped. To set it up in AWS:

1. Turn on [Transaction Search](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Transaction-Search.html)
   in the account: the endpoint takes no traces without it.
2. Give an IAM user the `AWSXRayAPIKeyAccess` managed policy, and create an
   [X-Ray API key](https://docs.aws.amazon.com/xray/latest/devguide/xray-opentelemetry-bearer-token.html)
   for it (IAM, the user, **Security credentials**, **API keys for AWS services**; or
   `aws iam create-service-specific-credential --service-name xray.amazonaws.com`). Paste its
   `ServiceCredentialSecret`, not the credential's id. API keys are not offered in every region.

The check before saving is the same empty export as for any OTLP endpoint. AWS checks the key
before it reads the body, so a 403 is a key it refused; a 400 to the empty export is taken as a
key that got through, unless its answer says Transaction Search is off. The key is stored as
`Bearer <key>`, and the runner treats CloudWatch as an OTLP endpoint and header (the rules and the
public-address check apply as below).

**View trace** opens the trace in the CloudWatch console,
`https://<region>.console.aws.amazon.com/cloudwatch/home?region=<region>#xray:traces/1-<first 8 hex>-<other 24 hex>`
(the trace id in X-Ray's form). AWS documents no link to a trace, so this is the form the console
uses today, and can change. There is no link to a span or to a conversation's search.

### Any OTLP endpoint

Any backend that takes OTLP/HTTP with JSON encoding: a hosted tracing service, or your own
OpenTelemetry Collector on a public HTTPS address (which can then forward anywhere, in any
encoding). Three things, saved together:

- **The endpoint**, the base OTLP endpoint as in `OTEL_EXPORTER_OTLP_ENDPOINT`: the runner sends
  to it plus `/v1/traces`, or to the endpoint itself when it already ends with `/v1/traces`. It
  must be `https://` to a public DNS name: no IP address, no single-label or internal name
  (`.internal`, `.local`, `.lan`, ...), no credentials, query string or fragment.
- **The header** the key goes in (`authorization`, `x-api-key`, ...): not one the runner sets
  itself (`content-type`, `host`, `content-length`, ...) or a `proxy-` one.
- **Its value**, whole: `Bearer <token>`, `Basic <base64>`, or a bare key.

Before saving, the API sends the endpoint an empty export (`{"resourceSpans":[]}`) with the
header: a receiver that takes OTLP/HTTP JSON accepts it and records nothing; 401 or 403 means the
key was refused, and 400, 404, 405, 406 or 415 that this is not an OTLP/HTTP JSON endpoint. Nothing
is saved unless it answered 2xx. The endpoint's name must resolve only to public addresses, and a
redirect is never followed.

**Links** are optional templates, so each job's page links into your tool:

- **Trace link**, naming `{trace_id}`, and also `{span_id}` for the moments in it (the job's own
  trace link then opens at its root span), `{start}` and `{end}` in UNIX seconds, `{start_ms}` and
  `{end_ms}` in milliseconds (a minute before the job to five minutes after it), and `{service}`.
- **Conversation link**, naming `{conversation}`, with the same times (a week before the job to a
  week after it, or now) and `{service}`: every trace of one issue.

Each is an `https://` URL whose host is written out; every value filled in is URL-encoded. Without
them, the job page still shows what the agents did, and the jobs list links nowhere.

### Running it yourself

`updraft start` and `updraft run-event` send the same spans, from the same tracer, when the
standard OpenTelemetry exporter variables name an endpoint:

| Variable | What it does |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The base endpoint; spans go to it plus `/v1/traces` (`http://localhost:4318` for a local Collector) |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | The traces endpoint itself, used as given (wins over the one above) |
| `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | `key=value,key2=value2`, values URL-encoded (`authorization=Bearer%20<token>`); the traces ones win |
| `OTEL_SERVICE_NAME`, or `service.name` in `OTEL_RESOURCE_ATTRIBUTES` | The service name (default `updraft`) |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` | Records prompts and outputs, as **Prompts and outputs** does in the console |
| `OTEL_SDK_DISABLED=true`, or `OTEL_TRACES_EXPORTER` without `otlp` | Turns it off |

Only OTLP/HTTP with JSON is spoken: with `OTEL_EXPORTER_OTLP_PROTOCOL` (or the traces one) set to
anything but `http/json`, nothing is sent and the worker says so. Left unset, JSON is sent, which
an OpenTelemetry Collector's OTLP receiver and most backends' OTLP/HTTP endpoints accept.

Each run is its own trace, from the moment the worker claims it until it is recorded and
published (or commented on), so Updraft's own steps are in it. Its trace id is recorded with the
run, so a later run's trace links to it as in [Across jobs](#across-jobs). The header values, and
each word of them, are redacted from every span. Plain `http://` is allowed here, for a Collector
on your own machine or network. Inside Updraft Cloud's microVM the runner traces the job itself,
so the worker there sends nothing of its own.

The tracer is the runner's: `src/telemetry/runner/` holds copies of
`deploy/aws-microvm/image/runner/telemetry.mjs`, `telemetry-detail.mjs` and `redact.mjs`, kept
identical by `test/telemetry-copy.test.ts` (`node scripts/copy-telemetry.mjs --sync` refreshes
them), and the build copies them into `dist/`.

## How it works

Nothing is installed in, or asked of, an agent. The microVM's runner (root) already has what it
needs: every run's `run.log`, which holds

- the worker's header: job, repository, issue, trigger, agent profile, configured model and effort;
- the agent's own machine-readable output: Claude Code's `--output-format stream-json` and
  Codex's `exec --json`, one event per line, written as the agent works;
- the worker's markers: the start and end of the agent's output, each verify command and its exit.

The runner (`deploy/aws-microvm/image/runner/telemetry.mjs`) tails those files every 500 ms while
the job runs, so each event is timed when it is written. It turns them into spans and sends
finished ones every few seconds over OTLP/HTTP (JSON) to the destination. No collector and no SDK
are involved.

Claude Code can also export OpenTelemetry itself, but its spans are named `claude_code.*` and need a
Collector `transform` processor to carry agent names, span names and token usage in the GenAI
conventions. Reading the transcripts gives the same shape for Codex too, with none
of that.

## The spans

One job (one microVM, one webhook event) is one trace:

```
invoke_workflow updraft                 the job; agent "updraft"
├─ invoke_agent <profile>               one agent run: implement, review or revision
│  ├─ chat <model>                      one model response, with its token usage
│  ├─ execute_tool <tool>               one tool call: Bash, Edit, shell, an MCP tool, ...
│  │  └─ invoke_agent <profile>/<type>  a Claude Code subagent (the Task tool), with its own spans
│  └─ ...
└─ invoke_workflow verify               the workflow's verify commands; agent "updraft"
   └─ execute_tool verify               one command, failed when it exits non-zero
```

| Span | `gen_ai.operation.name` | Kind | Notable attributes |
| --- | --- | --- | --- |
| `invoke_workflow updraft` | `invoke_workflow` | internal | `updraft.job.outcome`, `updraft.pull_request(.url)`, `updraft.loop.stage`, `updraft.loop.rounds`, `updraft.loop.reviews`, `updraft.loop.merged` |
| `invoke_agent <profile>` | `invoke_agent` | internal | `gen_ai.agent.name` (the profile), `gen_ai.agent.id` (the Claude session or Codex thread), `gen_ai.provider.name`, `gen_ai.request.model` (configured), `updraft.job.kind`, `updraft.run.outcome`, totals of tokens and tool calls |
| `chat <model>` | `chat` | client | `gen_ai.response.model` (what the API reported), `gen_ai.response.id`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`, `gen_ai.response.finish_reasons` |
| `execute_tool <tool>` | `execute_tool` | internal | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type` (`function`, or `extension` for MCP tools), `updraft.tool.exit_code` |
| `execute_tool verify` | `execute_tool` | internal | `updraft.verify.command`, `updraft.verify.index`, `updraft.tool.exit_code` |

Every span carries `gen_ai.conversation.id`, which is `<owner>/<repo>#<issue>`, and
`gen_ai.agent.name`. A tool that reads the conventions (Honeycomb's Agent Timeline, for one) groups
traces into a conversation by the first and spans into lanes by the second, so one issue's implement run, each review, and each revision, over however
many webhook events and microVMs, read as one conversation, with the coding agent, the reviewing
agent and Updraft itself each in its own lane.

Details that follow the conventions:

- **Input tokens include the cache.** Anthropic reports `input_tokens` without cache reads and
  writes; the conventions' `gen_ai.usage.input_tokens` includes them, so Updraft adds them up.
  OpenAI's count already includes cached tokens and is sent as is. With the model and provider on
  the span, a backend that prices models (Honeycomb does) can estimate each call's cost.
- **One `chat` span per model response.** Claude Code streams each content block of a response as
  its own event, with the same message id; they are one span. It starts when the agent got the
  previous tool results back (or started), and ends when the response's last block arrived. A
  Codex turn has no per-call breakdown, so it is one `chat` span with the turn's usage.
- **The calling agent emits `invoke_agent`.** A Claude Code subagent is an `execute_tool Task`
  span with an `invoke_agent <profile>/<subagent_type>` span under it; the subagent's own model and
  tool calls carry its own agent name, as the conventions suggest for multi-agent workflows.
- **Failures are span errors.** A tool result marked `is_error`, a Codex command that exited
  non-zero or an MCP call that failed, an agent run that did not succeed, a verify command that
  failed, and a job that did not succeed: each sets the span's status to error with `error.type`.
- **Nothing is sampled.** A sampled conversation has holes in it, so the runner sends every span
  (up to 20,000 per run).

## Structural detail

Without content, a trace still says what each step was about. These attributes are read from
the tool calls, the worker's lines and the CLI's own reports, and are always recorded (they are
redacted like everything else, and never hold a command's arguments, a file's contents or a
tool's output):

| Where | Attributes |
| --- | --- |
| Every tool call | `updraft.tool.category` (`test`, `lint`, `build`, `install`, `git`, `github`, `network`, `run`, `edit`, `filesystem`, `search`, `read`, `web`, `plan`, `delegate`, `mcp`, `other`), `updraft.tool.output.bytes`, `updraft.tool.output.lines` |
| A command (Bash, Codex `shell`) | `updraft.tool.command.program` (the first program that is not `cd`), `updraft.tool.command.programs`, `updraft.tool.command.unknown_programs`, `updraft.tool.exit_code`, `updraft.tool.background`. Only well-known programs (npm, git, pytest, cargo, grep, ...) are ever named; any other is only counted, so no misreading of an unusual command can export one of its words. The command is split the way the shell would (quotes, escapes, comments, redirections, `[[ ... ]]` and `(( ... ))` as one unit, a shell's `-c` only among its own options), and a command whose boundaries cannot be known for certain (an unterminated quote or conditional, `$(...)` or backticks, a heredoc) gets no program |
| An edit (Edit, MultiEdit, Write, `apply_patch`) | `updraft.tool.file.path` (relative to the worktree), `.extension`, `.test`, `updraft.tool.lines_added`, `updraft.tool.lines_removed`; for a patch `updraft.tool.file.paths` and counts by kind |
| Read, Grep, Glob, WebFetch | the file or directory, a glob's extension only (`*.ts`), how many lines or results came back; WebFetch's host only |
| A test run (an agent's command or a verify command) | `updraft.test.framework` (vitest, jest, pytest, go, cargo, mocha, rspec, node-test), `.passed`, `.failed`, `.skipped`, `.total`, `.failed_tests` (names, never messages, up to 20); `updraft.check.tool`, `.errors`, `.warnings` for tsc, eslint, mypy and ruff, each told by its own summary or by the program the command ran |
| `invoke_agent` | `updraft.agent.duration_ms` and `.api_duration_ms` (wall time against time waiting on the model, as Claude Code measured them), `.permission_denials` and `.permission_denied_tools`, `.compactions`, `.first_compaction_ms`, `.cli_version`, `.permission_mode`, `.mcp_servers(_failed)`, `.exit_code`, `.stopped_by`; `updraft.review.verdict` and `updraft.review.findings` for a review; `updraft.change.*` from the run summary (commits, files, insertions, deletions, untracked, paths, test files, and lines changed in tests and elsewhere) |

Span events mark moments inside a span: `todo.update` whenever the agent's plan changes (counts
by status; the items only with content on), `compaction` when Claude Code compacted the context
(trigger and tokens before), `model_usage` per model at the end of a Claude run (tokens, cost),
and `system.<subtype>` for other things the CLI reports about itself (plain values only).

Updraft's own steps are spans on the `updraft` lane:

```
invoke_workflow updraft
├─ runner isolation / restore_state / verify_isolation / coalesce_wait / run_event / state_wait
├─ updraft prepare          prompt and worktree, until the agent starts (failed if it never did; the error text only with content on)
├─ invoke_agent <profile>
├─ invoke_workflow verify
├─ updraft publish          push and pull request, one span per attempt, an event per line (its text only for Updraft's own lines; a reason or an error from GitHub only with content on)
├─ updraft post_review      the review posted and what it led to (updraft.review.outcome)
├─ updraft push_revision    a revision's push
└─ updraft failure_comment
```

The tracer starts as soon as the packet filter is in place (before the state is restored), so a
job that fails in the runner, or runs no agent, still sends its span and the runner steps it got
through, the failed one marked, in the conversation `delivery/<delivery id>`. A failure in the
packet filter itself comes before the key is read, and is not traced.

The root span is the job in one wide event: tokens, reported cost and tool calls over every
run, the last review's verdict, findings and outcome, and the last change's size.

## How the agent worked

From the order and outcome of a run's calls, its `invoke_agent` span also says how it went:

| Attribute | What it is |
| --- | --- |
| `updraft.agent.tools.<category>` | tool calls by category |
| `updraft.agent.time_to_first_tool_ms`, `_edit_ms`, `_test_ms`, `_green_ms` | from the agent's start to its first tool call, edit, test run and passing test run: how long it explored before it changed anything |
| `updraft.agent.test_runs`, `.test_runs_failed`, `.test_runs_until_green` | test runs, the red ones, and how many it took to see green |
| `updraft.agent.edit_test_cycles` | an edit followed by a test run, counted once per test run; `.edited_after_last_test` when it changed code after its last test |
| `updraft.agent.repeated_commands` | a command run again with no edit since, which cannot answer differently |
| `updraft.agent.files_edited`, `.files_read`, `.max_edits_one_file`, `.hot_file` | the file it kept coming back to (3 edits or more) |
| `updraft.agent.max_consecutive_tool_errors` | the longest run of failed tool calls |
| `updraft.agent.thrashing` | 3 or more repeated commands, 8 or more edits to one file, or 5 or more tool errors in a row; also on the job's span if any run was |
| `updraft.agent.model_ms`, `.tool_ms`, `.idle_ms` | time waiting on the model, in tools, and in neither (overlaps counted once; they add up to the span) |
| `updraft.agent.peak_context_tokens`, `.context_growth_tokens`, `.cache_hit_ratio` | how the main agent's context grew; each `chat` span has `updraft.chat.index` and `updraft.chat.cache_hit_ratio` |

Commands are compared in memory, by their text; only the counts leave the microVM.

## Across jobs

Each job is its own trace, so a revision and the review it answers are in different traces.
They are linked: the runner gives `updraft run-event` its trace id (`UPDRAFT_TRACE_ID`), the
worker records it with every run it starts (a `trace:<run>` row in `meta`, merged into the
shared state and pruned with the run), and writes the earlier traced runs a run follows into
its `run.log` header (`follows: run <id> (<relation>, trace <trace id>)`). A run's
`invoke_agent` span id is derived from its run id, so the runner turns each line into a span
link to that run's `invoke_agent` span, with `updraft.link.relation`:

- `review`: the review whose findings a revision answers, and `source`, the run that opened the pull request;
- `code`: the run that pushed the commit a review looks at;
- `resumes`: the run that waited on another pull request, for its follow-up;
- `retry`: the job's earlier attempt.

## Claude Code's own events

The transcript does not say how long an API request took, that it was retried, or that a tool
was refused. Claude Code's own [OpenTelemetry log events](https://code.claude.com/docs/en/monitoring-usage)
do, and the runner collects them without giving an agent any key:

- When the job has telemetry, the runner (root) starts a small OTLP/HTTP receiver on
  `127.0.0.1` with a random port (`deploy/aws-microvm/image/runner/otlp-relay.mjs`) before
  `updraft run-event`, and the job gets `CLAUDE_CODE_ENABLE_TELEMETRY=1`,
  `OTEL_LOGS_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=none`, `OTEL_TRACES_EXPORTER=none`,
  `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<port>`
  and `OTEL_LOGS_EXPORT_INTERVAL=1000`. No headers, no key; `OTEL_LOG_USER_PROMPTS` and
  `OTEL_LOG_TOOL_DETAILS` stay unset. Without telemetry none of this is set.
- Updraft passes its environment on to an agent's runtime client, and the sandbox runtime
  (`updraft-sandbox`) passes exactly these variables on to a contained agent, and only when
  every one of them has its expected value and the endpoint is `http://127.0.0.1:<port>`. The
  packet filter does not stand in the way: it only keeps non-root users from the credential
  addresses and the lifecycle hook port. An agent with `container.network: none` has no
  loopback to send to, and sends nothing.
- The relay keeps six events: `claude_code.api_request`, `claude_code.api_error`,
  `claude_code.api_refusal`, `claude_code.api_retries_exhausted`, `claude_code.tool_decision`
  and `claude_code.tool_result`, each with a fixed list of scalar
  attributes (model, duration, tokens, cost, status code, attempt, tool name, decision and its
  source, success, prompt id, ...). An API error's message is the provider's free text, so it is
  kept only with **Prompts and outputs** on (cut to 200 characters and redacted); its status,
  attempt and duration are kept either way. Anything else is
  counted and dropped. It reads JSON only (415 otherwise), refuses bodies over 1 MB (413), keeps
  at most 1,000 records per request and 50,000 per job, and accepts and discards metrics and
  traces.
- Each event is matched by its `session.id` to the `invoke_agent` span whose `gen_ai.agent.id`
  is that session (the stream-json `session_id`), and added to it as a span event (at most 256
  per span), redacted like everything else. The span also gets
  `updraft.agent.api_requests`, `updraft.agent.api_errors`, `updraft.agent.api_retries`
  (events with `attempt` > 1), `updraft.agent.api_duration_ms_total` and
  `updraft.agent.api_duration_ms_max` (over requests and errors), and
  `updraft.agent.tool_rejections`, `updraft.agent.api_refusals` and
  `updraft.agent.api_retries_exhausted`. A subagent shares its parent's session, so its events are on
  the run's agent span.

Any process on the microVM that can reach loopback could post events to the relay; they can
only land on an agent span of this job, as span events in the tenant's own dataset.

## Content

Off by default. With **Prompts and outputs** on, spans also carry:

- `gen_ai.input.messages` and `gen_ai.output.messages`, in the conventions' JSON message format:
  the run's prompt and its final answer on `invoke_agent`; each response's text, reasoning and tool
  calls, and the tool results it read, on `chat`;
- `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` on `execute_tool`;
- `gen_ai.agent.description` on a subagent.

Every value is redacted with the job's own keys (the agent keys and the destination's key) and with
patterns for anything shaped like a provider key, bearer token or key header, then cut to
16 KB. A JSON value is cut inside its strings, so it stays valid JSON. Code and issue text are
not redacted: they are what the content is.

## The contract

What a destination, a query, a board or an alert can rely on, whichever tool reads it:

- **Span names and kinds**: `invoke_workflow updraft`, `invoke_agent <profile>`,
  `invoke_agent <profile>/<subagent type>`, `chat <model>`, `execute_tool <tool>`,
  `execute_tool verify`, `invoke_workflow verify`, `updraft <step>` and `runner <step>`, in the tree
  under [The spans](#the-spans), one trace per job.
- **The GenAI attributes** in the tables above, with the conventions' meaning:
  `gen_ai.conversation.id` (`<owner>/<repo>#<issue>`, `delivery/<id>` for a job that ran no agent,
  or a run's job id for a run of no issue), `gen_ai.agent.name`, `gen_ai.operation.name`, the
  model, provider, token and tool attributes.
- **The `updraft.*` attributes** in [Structural detail](#structural-detail) and
  [How the agent worked](#how-the-agent-worked): names, types and units (counts, `_ms`
  milliseconds, `_usd` dollars, ratios between 0 and 1) stay as documented.
- **Span links between jobs** (`updraft.link.relation`) and the derived `invoke_agent` span id of
  a run, so a later trace can always link to an earlier run.
- **The finish report's marks and totals** ([Spans worth a link](#spans-worth-a-link)): kinds and
  fields as documented.

Changes are additive: a new attribute or span event can appear, and an existing one keeps its
name, type and meaning. Renaming or removing one is a breaking change and is called out in the
release notes. Content attributes (`gen_ai.input.messages`, `gen_ai.output.messages`,
`gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`) are only there with content on, and their
values follow the conventions' JSON message format, cut at 16 KB. Resource attributes are
`service.name` (the service name setting), `updraft.delivery.id` and `updraft.microvm.id`.

## What the console shows

- **Agent telemetry** (`/installations/:id/telemetry`): where traces go and the key (never its
  value), sending on or paused, content on or off, the service name, and the last job's export:
  how many spans got there, the last error, and a link to its trace.
- **Each job's page**:
  - **What the agents did**, with or without a destination: the job's totals (agent runs, tokens in
    and out, the cost the agent CLIs reported, tool calls and how many failed, whether a run went
    in circles) and its moments in order, each at its time from the job's start on a bar the
    length of the job: each run's agent (with its review verdict, and whether it failed or went in
    circles), the first failing test run, the first passing one after it, the first failed verify
    command, and the first failed Updraft or runner step. When the trace was sent somewhere with
    links, each moment opens the trace at its span.
  - **Traces**, when the trace was sent: **View trace**, **Open conversation** (the conversation's
    spans in the destination's search), and the conversation id to copy. With no destination, an
    offer to set one up.
  - **This conversation**: the other recent jobs of the same conversation (the implementation, each
    review and revision), each with its trace.
- **The jobs list**: a **Trace** and a **Conversation** link on each job that sent telemetry.

With no destination, the runner still reads the run logs as the job runs, with an exporter that
sends nothing (`createLocalExporter`): the finish reports the marks and totals with `local: true`,
the job is given no trace id (so no later trace links to it), Claude Code's own events are not
collected, and the settings page records no export. A job's links are only built from what
reached a destination: none for a local job, or for one whose export sent nothing.

The links are built from the destination the trace went to, not from today's settings. The
runner reports where it sent (`sentTo`: the destination kind and host), and the broker keeps a
snapshot of the installation's link settings with the job (`destination`: Honeycomb's region,
team and environment, CloudWatch's region, or a custom destination's host and link templates;
never a key), only when they are where the runner sent; it ignores any `destination` a runner
reports itself. The settings page's last export keeps the same snapshot. So a job sent to
Honeycomb still opens in Honeycomb after the installation moved to CloudWatch, and a trace id
is never put into another backend's URL. A job from before snapshots (all of them Honeycomb's) is
linked from the settings while they are still Honeycomb's, and not after.

For Honeycomb, **View trace** is a
[direct trace link](https://docs.honeycomb.io/investigate/collaborate/share-trace) built from the
key's team and environment slugs, and **Open conversation** a
[shared query](https://docs.honeycomb.io/investigate/collaborate/share-query):
`gen_ai.conversation.id = <owner/repo#issue>`, broken down by conversation and agent, with a span
count and a trace count, from a week before the job to a week after it (or now). Selecting the
conversation id in the results opens it in Agent Timeline. If the deployment sets an Agent Timeline
link (below), **Open in Agent Timeline** shows instead.

### Spans worth a link

The runner reports these with the job's finish (`telemetry.marks`): a kind (`agent`,
`test_failed`, `test_green`, `verify_failed`, `step_failed`), the span id, the run kind, and for an
agent span its profile, verdict, and whether it failed or thrashed, and where it was in the job
(`offsetMs` from the job's start, `durationMs`). Every moment is reported, at most 8 per run
and 32 per job, with `sent: false` on one whose span the destination did not accept (its batch
got no 2xx, or an OTLP partial success, which counts its rejected spans as failed and confirms
none of the batch, since it does not say which; or it was dropped or still queued). Such a moment
is still on the job's timeline; it gets no link, which would open the root span instead. A test run counts
as the first passing one only when its output showed tests that passed. It also reports the
conversation id the job's span was sent in, so a review's job, which has no issue of its own, links
to the issue's conversation, and a job that ran no agent to `delivery/<id>`. And the job's
`totals`: `runs`, `inputTokens`, `outputTokens`, `costUsd` (when an agent CLI reported a cost),
`toolCalls`, `toolErrors`, `thrashing` and `durationMs`. The broker keeps only marks of a known
kind, with a 16-hex span id, plain words and counts, and totals as counts.

### A link into Agent Timeline itself

Honeycomb documents no URL for a conversation in Agent Timeline. A deployment that knows the path
the UI uses can set the `HoneycombTimelineUrl` stack parameter (`HONEYCOMB_TIMELINE_URL`) to a
template, for example
`{ui}/{team}/environments/{environment}/<path>?conversation={conversation}`, with the placeholders
`{ui}`, `{team}`, `{environment}`, `{dataset}`, `{conversation}`, `{start}` and `{end}` (UNIX
seconds, the same window as the query). It must start with `{ui}/{team}/` and name
`{conversation}`, or it is ignored with a warning. Every value is URL-encoded. As an undocumented
path it can change without notice; the query link works either way.

## Security

- The key is a Secrets Manager secret, `updraft/tenants/<id>/agent-keys/HONEYCOMB_API_KEY` (the
  name from when Honeycomb was the only destination; CloudWatch's key and a custom destination's
  header value are kept there too). The API can create, replace and delete it, never read it. Only a job of the same tenant can read
  it, with the broker's tenant-scoped credentials.
- The broker passes it to the runner as telemetry settings, never among the agent keys, so it is
  never in the job process's or an agent's environment. The runner reads it as root.
- The key and where it sends always match. The settings record the Secrets Manager version the
  key was written as, in the same conditional write as its destination (Honeycomb's region and
  team, CloudWatch's region and endpoint, or the custom endpoint and header), and the runner reads exactly that version. A
  destination cannot change without the key being entered again, so no member can point a saved
  key at another server. Key changes take a two-minute lease on the settings, so a rotation and
  another rotation, or a removal, never overlap; a change that stops halfway leaves the settings
  naming the previous version, which Secrets Manager keeps. A removal clears the settings first
  and deletes the secret second, holding the lease until the delete is done, so a new key saved
  meanwhile can never be deleted with the old one.
- Every setting change is a compare-and-set on the version it read, so an opt-out made while a
  key was being checked is never undone.
- A custom endpoint (and CloudWatch's) is checked twice: by the API before it is saved (its rules,
  its name resolving only to public addresses, an empty export answered 2xx, no redirect
  followed), and by the runner before each job sends (the same rules, and the name resolving only
  to public addresses then). The connections themselves go only to public addresses: both the
  API's check and the runner's export connect through `node:https` with a lookup that refuses an
  answer with any address that is not public, so the address connected to is one that lookup
  vetted, whatever the name answers later. The certificate is still checked against the host
  name. Neither follows a redirect.
- The key's value and each word of it (the token in `Bearer <token>`) are redacted from
  everything the runner sends, logs or uploads.
- A failed export (the destination unreachable, the key revoked) is counted and reported; it never fails
  the job.
