# Agent telemetry: Updraft in Honeycomb's Agent Timeline

Updraft Cloud can send what each job's agents did to the tenant's own Honeycomb, as OpenTelemetry
traces in the [GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai).
[Agent Timeline](https://docs.honeycomb.io/investigate/observe/agent-timeline) then shows every
model call, tool call, verification and review round in order, for one issue at a time.

It is set up per installation in the console, under **Agent telemetry**: a Honeycomb Ingest key
(checked with Honeycomb's `/1/auth` before it is saved), the region (US or EU), the service name
(the dataset), and whether prompts and outputs are recorded. Agent Timeline is on every Honeycomb
plan, the free one included.

## How it works

Nothing is installed in, or asked of, an agent. The microVM's runner (root) already has what it
needs: every run's `run.log`, which holds

- the worker's header: job, repository, issue, trigger, agent profile, configured model and effort;
- the agent's own machine-readable output: Claude Code's `--output-format stream-json` and
  Codex's `exec --json`, one event per line, written as the agent works;
- the worker's markers: the start and end of the agent's output, each verify command and its exit.

The runner (`deploy/aws-microvm/image/runner/telemetry.mjs`) tails those files every 500 ms while
the job runs, so each event is timed when it is written. It turns them into spans and sends
finished ones every few seconds over OTLP/HTTP (JSON) to `https://api.honeycomb.io/v1/traces`
(or `api.eu1`), with the key in `x-honeycomb-team`. No collector and no SDK are involved.

Claude Code can also export OpenTelemetry itself, but its spans are named `claude_code.*` and need a
Collector `transform` processor to carry agent names, span names and token usage in the GenAI
conventions (Honeycomb's [Instrumenting AI Agents](https://docs.honeycomb.io/send-data/use-cases/agents)
shows the configuration). Reading the transcripts gives the same shape for Codex too, with none
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
`gen_ai.agent.name`. Agent Timeline groups traces into a conversation by the first and spans into
lanes by the second, so one issue's implement run, each review, and each revision, over however
many webhook events and microVMs, read as one conversation, with the coding agent, the reviewing
agent and Updraft itself each in its own lane.

Details that follow the conventions and Honeycomb's cost calculation:

- **Input tokens include the cache.** Anthropic reports `input_tokens` without cache reads and
  writes; the conventions' `gen_ai.usage.input_tokens` includes them, so Updraft adds them up.
  OpenAI's count already includes cached tokens and is sent as is. With the model and provider on
  the span, Honeycomb estimates each call's cost at ingest.
- **One `chat` span per model response.** Claude Code streams each content block of a response as
  its own event, with the same message id; they are one span. It starts when the agent got the
  previous tool results back (or started), and ends when the response's last block arrived. A
  Codex turn has no per-call breakdown, so it is one `chat` span with the turn's usage.
- **The calling agent emits `invoke_agent`.** A Claude Code subagent is an `execute_tool Task`
  span with an `invoke_agent <profile>/<subagent_type>` span under it; the subagent's own model and
  tool calls carry its own agent name, as Honeycomb recommends for multi-agent workflows.
- **Failures are span errors.** A tool result marked `is_error`, a Codex command that exited
  non-zero or an MCP call that failed, an agent run that did not succeed, a verify command that
  failed, and a job that did not succeed: each sets the span's status to error with `error.type`.
- **Nothing is sampled.** Honeycomb recommends against sampling GenAI telemetry, and the runner
  sends every span (up to 20,000 per run).

## Content

Off by default. With **Prompts and outputs** on, spans also carry:

- `gen_ai.input.messages` and `gen_ai.output.messages`, in the conventions' JSON message format:
  the run's prompt and its final answer on `invoke_agent`; each response's text, reasoning and tool
  calls, and the tool results it read, on `chat`;
- `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` on `execute_tool`;
- `gen_ai.agent.description` on a subagent.

Every value is redacted with the job's own keys (the agent keys and the Honeycomb key) and with
patterns for anything shaped like a provider key, bearer token or key header, then cut to
16 KB. A JSON value is cut inside its strings, so it stays valid JSON. Code and issue text are
not redacted: they are what the content is.

## What the console shows

- **Agent telemetry** (`/installations/:id/telemetry`): the key (never its value), the Honeycomb
  team and environment it belongs to, sending on or paused, content on or off, the service name,
  and the last job's export: how many spans got there, the last error, and a link to its trace.
- **Each job's page**: **View trace in Honeycomb**, a
  [direct trace link](https://docs.honeycomb.io/investigate/collaborate/share-trace) built from the
  team and environment slugs, and the conversation id to open in AI Ecosystem → Conversations.
- **The jobs list**: a **Trace** link on each job that sent telemetry.

## Security

- The key is a Secrets Manager secret, `updraft/tenants/<id>/agent-keys/HONEYCOMB_API_KEY`. The
  API can create, replace and delete it, never read it. Only a job of the same tenant can read
  it, with the broker's tenant-scoped credentials.
- The broker passes it to the runner as telemetry settings, never among the agent keys, so it is
  never in the job process's or an agent's environment. The runner reads it as root.
- A failed export (Honeycomb unreachable, the key revoked) is counted and reported; it never fails
  the job.
