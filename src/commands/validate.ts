import { existsSync } from 'node:fs';
import { ConfigError, configExists, readRawConfig, resolveConfigRelative } from '../config/io.js';
import type { UpdraftConfig } from '../config/schema.js';
import { validateConfig, type ConfigIssue } from '../config/validate.js';
import { legacyNotice, println, type CommandContext } from './context.js';
import { appCredentialField, appKeyProblem } from './doctor-app.js';
import { EXIT } from './errors.js';

/** Warn about action prompt files that don't exist (resolved against the config file's directory). */
export function promptFileWarnings(
  config: UpdraftConfig,
  configFile: string,
  fileExists: (p: string) => boolean = existsSync,
): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  for (const [name, action] of Object.entries(config.actions)) {
    if (!action.prompt) continue;
    const full = resolveConfigRelative(configFile, action.prompt);
    if (!fileExists(full)) out.push({ path: `actions.${name}.prompt`, message: `prompt file not found: ${full}` });
  }
  return out;
}

export type ConfigCheck =
  | { state: 'missing'; path: string }
  | { state: 'unreadable'; path: string; message: string }
  | { state: 'invalid'; path: string; errors: ConfigIssue[]; warnings: ConfigIssue[] }
  | { state: 'ok'; path: string; config: UpdraftConfig; warnings: ConfigIssue[] };

/** Load and validate without network access. Prompt-file checks are folded into warnings. */
export function checkConfig(path: string, fileExists: (p: string) => boolean = existsSync): ConfigCheck {
  if (!configExists(path)) return { state: 'missing', path };
  let raw: unknown;
  try {
    raw = readRawConfig(path);
  } catch (err) {
    return { state: 'unreadable', path, message: err instanceof ConfigError ? err.message : String(err) };
  }
  const result = validateConfig(raw);
  if (!result.ok) return { state: 'invalid', path, errors: result.errors, warnings: result.warnings };
  return {
    state: 'ok',
    path,
    config: result.config,
    warnings: [...result.warnings, ...promptFileWarnings(result.config, path, fileExists)],
  };
}

/**
 * `validate --json`: one JSON object on stdout, for another program that has to decide from the
 * config (a runner that refuses to start a job unless every agent is contained, say) without
 * parsing YAML or knowing the schema's defaults. `config` is the validated config with every
 * default filled in, as the worker will use it; the values of `agents.<name>.env` are left out
 * (their names stay), because that is where a token ends up when somebody puts one in the config.
 * Nothing is read but the config file and, for github.app, the key file's shape.
 */
export interface ValidateJson {
  ok: boolean;
  path: string;
  state: ConfigCheck['state'];
  errors: ConfigIssue[];
  warnings: ConfigIssue[];
  /** Null unless the config is valid. */
  config: UpdraftConfig | null;
}

function withoutEnvValues(config: UpdraftConfig): UpdraftConfig {
  const agents = Object.fromEntries(
    Object.entries(config.agents).map(([name, agent]) => [
      name,
      agent.env ? { ...agent, env: Object.fromEntries(Object.keys(agent.env).map((key) => [key, '(set)'])) } : agent,
    ]),
  );
  return { ...config, agents };
}

export function validateJson(ctx: Pick<CommandContext, 'paths' | 'env'>): ValidateJson {
  const check = checkConfig(ctx.paths.configFile);
  const base = { path: check.path, state: check.state };
  switch (check.state) {
    case 'missing':
      return { ...base, ok: false, errors: [{ path: '', message: `no config at ${check.path}` }], warnings: [], config: null };
    case 'unreadable':
      return { ...base, ok: false, errors: [{ path: '', message: check.message }], warnings: [], config: null };
    case 'invalid':
      return { ...base, ok: false, errors: check.errors, warnings: check.warnings, config: null };
    case 'ok': {
      const app = check.config.github?.app;
      const keyProblem = app ? appKeyProblem(app, { configDir: ctx.paths.configDir, env: ctx.env }) : null;
      if (keyProblem) {
        return { ...base, ok: false, state: 'invalid', errors: [{ path: appCredentialField(app!, { configDir: ctx.paths.configDir, env: ctx.env }), message: keyProblem }], warnings: check.warnings, config: null };
      }
      return { ...base, ok: true, errors: [], warnings: check.warnings, config: withoutEnvValues(check.config) };
    }
  }
}

export async function validateCommand(ctx: CommandContext, opts: { json?: boolean } = {}): Promise<number> {
  if (opts.json) {
    const report = validateJson(ctx);
    println(ctx.out, JSON.stringify(report));
    return report.ok ? EXIT.OK : EXIT.FAILURE;
  }
  const check = checkConfig(ctx.paths.configFile);
  switch (check.state) {
    case 'missing':
      println(ctx.err, `✗ No config at ${check.path}. Run "updraft configure" or pass --config.`);
      for (const line of legacyNotice(ctx)) println(ctx.err, line);
      return EXIT.FAILURE;
    case 'unreadable':
      println(ctx.err, `✗ ${check.message}`);
      return EXIT.FAILURE;
    case 'invalid':
      println(ctx.err, `✗ Invalid config ${check.path}`);
      for (const e of check.errors) println(ctx.err, `  ✗ ${e.path}: ${e.message}`);
      for (const w of check.warnings) println(ctx.err, `  ! ${w.path}: ${w.message}`);
      return EXIT.FAILURE;
    case 'ok': {
      // github.app: the key (or token file) is a file outside the config, so it is checked here (offline), not by the schema.
      const app = check.config.github?.app;
      const keyProblem = app ? appKeyProblem(app, { configDir: ctx.paths.configDir, env: ctx.env }) : null;
      if (keyProblem) {
        println(ctx.err, `✗ Invalid config ${check.path}`);
        println(ctx.err, `  ✗ ${appCredentialField(app!, { configDir: ctx.paths.configDir, env: ctx.env })}: ${keyProblem}`);
        for (const w of check.warnings) println(ctx.err, `  ! ${w.path}: ${w.message}`);
        return EXIT.FAILURE;
      }
      const repos = Object.values(check.config.repositories);
      const workflows = repos.reduce((n, r) => n + r.workflows.length, 0);
      println(ctx.out, `✓ Config is valid: ${check.path}`);
      println(
        ctx.out,
        `  ${repos.length} repo(s), ${workflows} workflow(s), ${Object.keys(check.config.agents).length} agent(s), ` +
          `${Object.keys(check.config.pools).length} pool(s), execution mode ${check.config.execution.mode}`,
      );
      for (const w of check.warnings) println(ctx.out, `  ! ${w.path}: ${w.message}`);
      return EXIT.OK;
    }
  }
}
