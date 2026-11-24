# Mistral Vibe in local Updraft

Install the [Vibe CLI](https://docs.mistral.ai/vibe/code/cli/install-setup) on the
machine running Updraft and make sure `vibe --version` works. The adapter was
tested with Vibe 3.1.4.

In your local Updraft config, use `execution.mode: live` and add a profile to a pool
used by an implementation or review workflow. Set `model` to a Vibe model alias. Omit it to
use the model selected in Vibe.

```yaml
execution:
  mode: live
agents:
  mistral:
    adapter: vibe
    model: devstral-local
    maxConcurrent: 1
pools:
  mistral:
    agents: [mistral]
```

- **Mistral API credits.** Set `MISTRAL_API_KEY` in the environment that starts
  Updraft. Configure the Mistral model you have access to in Vibe and use that
  alias as the profile's `model`. Keep the key out of Updraft YAML. See
  [Vibe API keys and profiles](https://docs.mistral.ai/vibe/code/cli/api-keys-profiles).
- **Open weights.** Serve your model through Ollama, llama.cpp, LM Studio, or
  another OpenAI-compatible server. Add its provider URL and model alias to your
  Vibe config, then use that alias in Updraft. A key is only needed if your
  endpoint requires one. See [Vibe offline models](https://docs.mistral.ai/vibe/code/cli/offline-models).

For local inference with background network calls disabled, set
`enable_telemetry = false` and `enable_update_checks = false` in Vibe's config
and disable any tools or connectors that use remote services.

Vibe runs headlessly in the job worktree and uses its configured tool permissions.
The default Vibe agent allows edits but denies tools that would require interactive
approval. Updraft runs the repository's configured verification commands as usual.
`updraft agents` checks discovery without calling a model. Its `--deep` probe
uses the active model in Vibe's own configuration.

This adapter supports implementation, review, and revision in local Updraft.
Host runs record Vibe's reported input, output and cached tokens, model steps,
and estimated cost when available. With local OpenTelemetry enabled, they appear
on the agent-run span. Vibe can report cost as zero for an unpriced model, so
use your Mistral account for actual credit charges.
