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

## Structural detail

Without content, a trace still says what each step was about. These attributes are read from
the tool calls, the worker's lines and the CLI's own reports, and are always recorded (they are
redacted like everything else, and never hold a command's arguments, a file's contents or a
tool's output):

| Where | Attributes |
| --- | --- |
| Every tool call | `updraft.tool.category` (`test`, `lint`, `build`, `install`, `git`, `github`, `network`, `run`, `edit`, `filesystem`, `search`, `read`, `web`, `plan`, `delegate`, `mcp`, `other`), `updraft.tool.output.bytes`, `updraft.tool.output.lines` |
| A command (Bash, Codex `shell`) | `updraft.tool.command.program` (the first program that is not `cd`), `updraft.tool.command.programs`, `updraft.tool.exit_code`, `updraft.tool.background` |
| An edit (Edit, MultiEdit, Write, `apply_patch`) | `updraft.tool.file.path` (relative to the worktree), `.extension`, `.test`, `updraft.tool.lines_added`, `updraft.tool.lines_removed`; for a patch `updraft.tool.file.paths` and counts by kind |
| Read, Grep, Glob, WebFetch | the file or directory, the glob, how many lines or results came back; WebFetch's host only |
| A test run (an agent's command or a verify command) | `updraft.test.framework` (vitest, jest, pytest, go, cargo, mocha, rspec, node-test), `.passed`, `.failed`, `.skipped`, `.total`, `.failed_tests` (names, never messages, up to 20); `updraft.check.errors`/`.warnings` for tsc, eslint, mypy, ruff |
| `invoke_agent` | `updraft.agent.duration_ms` and `.api_duration_ms` (wall time against time waiting on the model, as Claude Code measured them), `.permission_denials` and `.permission_denied_tools`, `.compactions`, `.first_compaction_ms`, `.cli_version`, `.permission_mode`, `.mcp_servers(_failed)`, `.exit_code`, `.stopped_by`; `updraft.review.verdict` and `updraft.review.findings` for a review; `updraft.change.*` from the run summary (commits, files, insertions, deletions, untracked, paths, test files, and lines changed in tests and elsewhere) |

Span events mark moments inside a span: `todo.update` whenever the agent's plan changes (counts
by status; the items only with content on), `compaction` when Claude Code compacted the context
(trigger and tokens before), `model_usage` per model at the end of a Claude run (tokens, cost),
and `system.<subtype>` for other things the CLI reports about itself (plain values only).

Updraft's own steps are spans on the `updraft` lane:

```
invoke_workflow updraft
├─ runner isolation / restore_state / verify_isolation / coalesce_wait / run_event / state_wait
├─ updraft prepare          prompt and worktree, until the agent starts (failed if it never did)
├─ invoke_agent <profile>
├─ invoke_workflow verify
├─ updraft publish          push and pull request, one span per attempt, an event per line
├─ updraft post_review      the review posted and what it led to (updraft.review.outcome)
├─ updraft push_revision    a revision's push
└─ updraft failure_comment
```

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
- The key and where it sends always match. The settings record the Secrets Manager version the
  key was written as, in the same conditional write as its region and team, and the runner reads
  exactly that version. Key changes take a two-minute lease on the settings, so a rotation and
  another rotation, or a removal, never overlap; a change that stops halfway leaves the settings
  naming the previous version, which Secrets Manager keeps. A removal clears the settings first
  and deletes the secret second, holding the lease until the delete is done, so a new key saved
  meanwhile can never be deleted with the old one.
- Every setting change is a compare-and-set on the version it read, so an opt-out made while a
  key was being checked is never undone.
- A failed export (Honeycomb unreachable, the key revoked) is counted and reported; it never fails
  the job.
