import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCodexConfig, judgeCodexConfigRun } from '../native-worker/codex-config-check.mjs';
import { CODEX_DISABLED_FEATURES, codexArgs } from '../native-worker/policy.mjs';

// #125 review: every key the worker passes under --strict-config must exist in the pinned Codex.
// The live (not Stage::Removed) FeatureSpec keys of openai/codex rust-v0.172.0 (3d86e43),
// codex-rs/features/src/lib.rs: the release NATIVE_CODEX_VERSION pins. Update it with the pin.
const CODEX_0_172_FEATURES = new Set([
  'agent_message_board', 'agent_message_board_mcp', 'analytics_plan_history', 'api_key_cyber_access_programs',
  'api_key_model_discovery', 'app_server_websocket_compression', 'apply_patch_streaming_events', 'apps',
  'apps_early_resource_discovery', 'artifact', 'async_compaction', 'async_compaction_root_only', 'auth_elicitation',
  'background_paginated_rollout_migration', 'bedrock_setup_wizard', 'browser_annotation_api', 'browser_use',
  'browser_use_external', 'browser_use_full_cdp_access', 'catalog_apps_instructions', 'chronicle', 'cli_daybreak',
  'cli_resume_account_check', 'code_mode', 'code_mode_host', 'code_mode_host_output_truncation',
  'code_mode_interrupt', 'code_mode_only', 'code_mode_only_strict_3p_tools', 'code_mode_prewarm',
  'code_mode_tool_search', 'codex_apps_mcp_2026_07_28', 'command_sessions_world_state', 'compaction_image_budget',
  'computer_use', 'concurrent_reasoning_summaries', 'connector_tool_result_passthrough', 'content_item_kinds',
  'context_management', 'credential_masking', 'critical_path_timing', 'current_time_reminder',
  'cwd_relative_turn_diffs', 'daemon_auto_start', 'daybreak_program_propagation', 'default_mode_request_user_input',
  'defer_mailbox_preemption', 'deferred_executor', 'deferred_tool_world_state', 'enable_mcp_apps',
  'enable_request_compression', 'exec_permission_approvals', 'executed_tool_call_metadata',
  'executor_capability_discovery', 'executor_capability_discovery_v2', 'external_agent_memory_import', 'fast_mode',
  'file_backed_tool_audio', 'gateway_setup_wizard', 'gcp_setup_wizard', 'goals', 'guardian_approval',
  'guardian_conversation_history_tools', 'guardian_denial_reconsideration',
  'guardian_enhanced_node_repl_transcripts', 'guardian_include_additional_context',
  'guardian_native_multi_agent_history', 'guardian_nested_approval_context', 'guardian_node_repl_transcript_images',
  'guardian_recorded_items', 'guardian_reuse_parent_compaction', 'guardian_root_handoff_context',
  'guardian_trust_orchestrator_connectors', 'guardianv2', 'guardianv2_decisions_comparison', 'guardianv3', 'hooks',
  'hosted_search_policy', 'image_generation', 'image_generation_animation', 'image_resize_notice', 'in_app_browser',
  'in_app_chat', 'in_app_dictation', 'in_app_local_automation', 'in_app_updates', 'in_app_voice',
  'incremental_exec_tools', 'incremental_tools', 'incremental_tools_legacy', 'incremental_tools_legacy_gcp',
  'instant_interrupt', 'interrupt_on_cancel', 'local_thread_store_compression', 'login_shell_package_path',
  'mcp_2026_07_28', 'mcp_connection_sharing', 'mcp_lazy_stdio_startup', 'mcp_oauth_refresh_coordination',
  'mcp_shared_repl_cwd', 'mcp_tool_list_changed', 'memories', 'mentions_v2', 'model_catalog_in_context',
  'multi_agent', 'multi_agent_v2', 'multi_agent_v2_dynamic_tools', 'multi_env_copy_file', 'multi_environment_mcp',
  'network_proxy', 'non_prefixed_mcp_tool_names', 'nonfatal_clock_read_errors', 'omit_app_server_notification_media',
  'omit_skill_descriptions', 'output_token_replay', 'per_environment_context', 'plugin_sharing', 'plugins',
  'powershell_shell_version', 'prediction_preserve_parent_tools', 'prefer_mxc', 'prevent_idle_sleep', 'psp',
  'realtime_frames_local', 'reasoning_effort_override', 'recommended_plugins', 'remote_plugin',
  'request_permissions_tool', 'respect_system_proxy', 'restored_history_prewarm', 'retain_client_developer_messages',
  'retain_client_tool_outputs', 'rollout_budget', 'runtime_agent_instances', 'runtime_metrics', 'safe_image_decoder',
  'secret_auth_storage', 'send_message_to_user_async', 'shell_snapshot', 'shell_snapshot_v2', 'shell_tool',
  'simplified_selection_hints', 'skill_catalog_deltas', 'skill_mcp_dependency_install', 'skill_search',
  'skip_host_skill_discovery', 'sleep_tool', 'standalone_web_search', 'step_model_switching',
  'subagent_default_context_limits', 'subagent_thread_environments', 'suppress_model_change_announcements',
  'system_proxy_fallback', 'terminal_visualization_instructions', 'token_budget', 'tool_call_mcp_elicitation',
  'tool_suggest', 'tui_extensions_statusline', 'tui_multi_backend', 'tui_workspace', 'ultrafast_mode',
  'unbounded_connection_retries', 'unified_exec', 'unified_exec_tty', 'unified_image_budget',
  'untrusted_as_tool_output', 'use_agent_identity', 'use_legacy_landlock', 'use_xaa', 'utc_environment_date',
  'view_image', 'wake_on_agent_messages', 'web_search_cached', 'web_search_request', 'windows_sandbox_service',
  'workspace_dependencies', 'write_stdin_approval',
]);

describe('the Codex lockdown matches the pinned release', () => {
  it('switches off only features the pinned release defines', () => {
    expect(CODEX_DISABLED_FEATURES.filter((name) => !CODEX_0_172_FEATURES.has(name))).toEqual([]);
    expect(CODEX_DISABLED_FEATURES).not.toContain('web_search_indexed_default');
    expect(CODEX_DISABLED_FEATURES).not.toContain('statsig_gates');
    expect(CODEX_DISABLED_FEATURES).toContain('hosted_search_policy');
  });
  it('is pinned in the image build at the release this list was read from', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const context = fs.readFileSync(path.join(here, '..', '..', '..', 'cloud', 'server', 'scripts', 'job-image-context.ts'), 'utf8');
    expect(context).toContain("NATIVE_CODEX_VERSION = '0.172.0'");
  });
});

describe('the image build guard runs the real argv', () => {
  it('passes only when Codex got past config validation to the MCP startup', () => {
    expect(judgeCodexConfigRun({ status: 1, stderr: 'Error: required MCP servers failed to initialize: updraft: handshaking failed' })).toEqual({ ok: true });
    expect(judgeCodexConfigRun({ status: 1, stderr: 'Error loading config.toml: unknown configuration field `features.statsig_gates` in -c/--config override' }))
      .toEqual({ ok: false, reason: 'the pinned Codex does not know features.statsig_gates' });
    expect(judgeCodexConfigRun({ status: 1, stderr: 'Error loading config.toml: invalid type' }).ok).toBe(false);
    expect(judgeCodexConfigRun({ status: 0, stdout: '' }).ok).toBe(false);
    expect(judgeCodexConfigRun({ status: null, signal: 'SIGKILL', stderr: 'required MCP servers failed to initialize' }).ok).toBe(false);
    expect(judgeCodexConfigRun({ status: 1, stderr: 'Not logged in' }).ok).toBe(false);
  });
  it('hands the binary the exact worker argv, a fresh signed-out home and no way out', async () => {
    const calls = [];
    const verdict = await checkCodexConfig('/opt/codex/bin/codex', {
      run: (binary, args, options) => {
        calls.push({ binary, args, options, home: fs.readdirSync(options.env.CODEX_HOME) });
        return { status: 1, stdout: '', stderr: 'required MCP servers failed to initialize' };
      },
    });
    expect(verdict).toEqual({ ok: true });
    const [call] = calls;
    expect(call.binary).toBe('/opt/codex/bin/codex');
    expect(call.args).toEqual(codexArgs(['exec', '--json', '-c', 'model_reasoning_effort="medium"'], { command: '/bin/false', args: [] }));
    expect(call.args).toContain('--strict-config');
    expect(call.home).toEqual([]);
    expect(call.options.env.HTTPS_PROXY).toBe('http://127.0.0.1:9');
    expect(Object.keys(call.options.env).some((k) => /KEY|TOKEN|OPENAI/.test(k))).toBe(false);
    expect(fs.existsSync(call.options.env.CODEX_HOME)).toBe(false);
  });
  // The real pinned binary, where one is at hand (UPDRAFT_CODEX_BIN): the check the image build runs.
  it.skipIf(!process.env.UPDRAFT_CODEX_BIN)('accepts the worker argv with the real pinned binary', async () => {
    expect(await checkCodexConfig(process.env.UPDRAFT_CODEX_BIN)).toEqual({ ok: true });
  });
});
