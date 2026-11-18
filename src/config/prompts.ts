import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfigRelative } from './io.js';
import type { UpdraftConfigInput } from './schema.js';

/** Prompts shipped in the package (examples/prompts), resolved from src/config or dist/config. */
const PACKAGED_PROMPTS_DIR = fileURLToPath(new URL('../../examples/prompts/', import.meta.url));

/**
 * For each action whose prompt file (or revise or review prompt file) is missing next to the config, copy
 * the packaged prompt with the same file name if one exists. Never overwrites. Returns written paths.
 */
export function writeStarterPrompts(configFile: string, config: UpdraftConfigInput, packagedDir = PACKAGED_PROMPTS_DIR): string[] {
  const written: string[] = [];
  const prompts = Object.values(config.actions).flatMap((action) => [action.prompt, action.revisePrompt, action.reviewPrompt]);
  for (const prompt of prompts) {
    if (!prompt) continue;
    const target = resolveConfigRelative(configFile, prompt);
    if (existsSync(target) || written.includes(target)) continue;
    const source = `${packagedDir}${basename(target)}`;
    if (!existsSync(source)) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    written.push(target);
  }
  return written;
}
