// Lint for correctness, not style: the type-aware rules that catch real bugs in a long-running
// worker (a promise nobody awaits, a misused async callback), plus the usual unused-code checks.
// Formatting is left alone.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Terminal escape sequences and control characters are matched on purpose (agent output).
      'no-control-regex': 'off',
      // `let x = fallback; try { x = ... } catch {}` is this codebase's idiom for best-effort lookups.
      'no-useless-assignment': 'off',
      // Tests match column-aligned status output literally.
      'no-regex-spaces': 'off',
    },
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'vitest.config.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
    },
  },
  {
    // Plain Node scripts: the stand-in agent CLIs used by tests, the pack smoke test, this file.
    files: ['**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', Buffer: 'readonly', URL: 'readonly' } },
  },
);
