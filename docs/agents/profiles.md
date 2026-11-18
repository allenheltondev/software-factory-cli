# Model profiles for subscription CLIs

Each `agents.<name>` entry is a profile. Several entries can use the same adapter and login and
differ only in model and effort. Each keeps its own process isolation, `maxConcurrent` and place in
pools, so `claude-fast`, `claude-standard` and `claude-deep` run side by side.

```yaml
agents:
  claude-fast:     { adapter: claude, model: haiku,  effort: low }
  claude-deep:     { adapter: claude, model: opus,   effort: high }
  codex-deep:      { adapter: codex,  model: gpt-5-codex, effort: high }
  kiro-standard:   { adapter: kiro,   model: claude-sonnet-4 }
pools:
  deep: { agents: [claude-deep, codex-deep] }
```

`model` and `effort` are optional shorthands. Entries that put `--model ...` in `args` keep working
unchanged, and `updraft agents` / `updraft doctor` read the model and effort from `args` too.

| adapter | `model` becomes | `effort` becomes |
|---|---|---|
| claude | `--model <value>` | `--effort <value>` |
| codex | `--model <value>` | `-c model_reasoning_effort="<value>"` |
| kiro | `--model <value>` | `--effort <value>` |

Values are single arguments, never run through a shell, so names with spaces or a `provider/name`
prefix work the same on Windows, macOS and Linux. The same setting in both a field and `args`
(duplicate or contradictory), repeated differing flags, and values that are empty, start with `-`
or contain line breaks are config errors.

## What is and is not checked

- Updraft keeps no list of model or effort names. They differ by CLI version and plan, and the CLI
  itself rejects what it does not know; that failure shows in the run's log. Use the CLI's own
  discovery (for example `kiro-cli chat --list-models`, or `/model` in Claude Code and Codex).
- Updraft never calls a model API and holds no API keys. Nothing is probed silently; the only
  command that sends a prompt is `updraft agents --deep`, which warns first.
- Shown values are the **configured** ones. None of the CLIs reports the model a run resolved, so
  with no model set Updraft says "CLI default" rather than guessing. Each run's `run.log` header
  has a `profile:` line with the agent, adapter, model, effort and where each came from.
