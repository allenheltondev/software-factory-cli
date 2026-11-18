import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import type { UpdraftConfig, UpdraftConfigInput } from './schema.js';
import { formatIssues, validateConfig, type ConfigIssue } from './validate.js';
import { updateYamlText } from './yaml-update.js';

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: ConfigIssue[] = [],
  ) {
    super(issues.length ? `${message}\n${formatIssues(issues)}` : message);
    this.name = 'ConfigError';
  }
}

export interface LoadedConfig {
  config: UpdraftConfig;
  path: string;
  warnings: ConfigIssue[];
}

export function configExists(path: string): boolean {
  return existsSync(path);
}

/** Read raw YAML without validation (used by configure to edit an existing file). */
export function readRawConfig(path: string): unknown {
  const text = readFileSync(path, 'utf8');
  try {
    return parse(text) ?? {};
  } catch (err) {
    throw new ConfigError(`Could not parse ${path}: ${(err as Error).message}`);
  }
}

export function loadConfig(path: string): LoadedConfig {
  if (!existsSync(path)) {
    throw new ConfigError(`No config at ${path}. Run "updraft configure" or pass --config.`);
  }
  const result = validateConfig(readRawConfig(path));
  if (!result.ok) throw new ConfigError(`Invalid config ${path}`, result.errors);
  return { config: result.config, path, warnings: result.warnings };
}

/**
 * Validate, then atomically write the config. Refuses to write an invalid config.
 * Writes the *input* shape so defaults are not frozen into the file. When a file
 * already exists, only the nodes that changed are edited, so hand-written
 * comments, key order and formatting elsewhere are kept.
 */
export function saveConfig(path: string, input: UpdraftConfigInput): LoadedConfig {
  const result = validateConfig(input);
  if (!result.ok) throw new ConfigError('Refusing to save invalid config', result.errors);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const text = (existing !== null && updateYamlText(existing, input)) || stringify(input, { lineWidth: 0 });
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
  return { config: result.config, path, warnings: result.warnings };
}

/** Resolve a path from the config (e.g. an action prompt) against the config file's directory. */
export function resolveConfigRelative(configFile: string, p: string): string {
  return isAbsolute(p) ? p : resolve(dirname(configFile), p);
}
