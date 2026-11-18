import { existsSync } from 'node:fs';
import { ConfigError, configExists, readRawConfig, resolveConfigRelative } from '../config/io.js';
import type { UpdraftConfig } from '../config/schema.js';
import { validateConfig, type ConfigIssue } from '../config/validate.js';
import { println, type CommandContext } from './context.js';
import { appKeyProblem } from './doctor-app.js';
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

export async function validateCommand(ctx: CommandContext): Promise<number> {
  const check = checkConfig(ctx.paths.configFile);
  switch (check.state) {
    case 'missing':
      println(ctx.err, `✗ No config at ${check.path}. Run "updraft configure" or pass --config.`);
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
      // github.app: the key is a file outside the config, so it is checked here (offline), not by the schema.
      const app = check.config.github?.app;
      const keyProblem = app ? appKeyProblem(app, { configDir: ctx.paths.configDir, env: ctx.env }) : null;
      if (keyProblem) {
        println(ctx.err, `✗ Invalid config ${check.path}`);
        println(ctx.err, `  ✗ github.app.privateKeyPath: ${keyProblem}`);
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
