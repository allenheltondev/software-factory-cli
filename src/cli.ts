#!/usr/bin/env node
import { createRequire } from 'node:module';
import { buildProgram } from './commands/program.js';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

await buildProgram({ version: pkg.version }).parseAsync(process.argv);
