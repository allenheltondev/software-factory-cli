import { describe, expect, it } from 'vitest';
import { operationName, claudeToolAttributes, codexToolAttributes, describeCommand, isTestPath, lineCount, parseCheckOutput, parseTestOutput, relativePath, resultAttributes } from '../image/runner/telemetry-detail.mjs';

/** A Bash call's command attributes. */
const commandAttributesOf = (command) => Object.fromEntries(Object.entries(claudeToolAttributes('Bash', { command }, [])).filter(([, v]) => v !== undefined));

describe('describeCommand', () => {
  it.each([
    ['npm test', 'npm', 'test'],
    ['npm run test:unit -- --run', 'npm', 'test'],
    ['pnpm vitest run src', 'pnpm', 'test'],
    ['npx vitest run', 'vitest', 'test'],
    ['yarn lint', 'yarn', 'lint'],
    ['npm run build', 'npm', 'build'],
    ['npm ci', 'npm', 'install'],
    ['cd app && npm install && npm test', 'npm', 'test'],
    ['CI=1 timeout 300 pytest -x tests/', 'pytest', 'test'],
    ['python -m pytest -q', 'python', 'test'],
    ['go test ./...', 'go', 'test'],
    ['go vet ./...', 'go', 'lint'],
    ['cargo clippy -- -D warnings', 'cargo', 'lint'],
    ['./gradlew test', 'gradlew', 'test'],
    ['make check', 'make', 'test'],
    ['git status && git diff --stat', 'git', 'git'],
    ['gh pr view 12', 'gh', 'github'],
    ['rg -n "theme" src | head -20', 'rg', 'search'],
    ['cat package.json', 'cat', 'read'],
    ["sed -i 's/a/b/' x.ts", 'sed', 'edit'],
    ['curl -s https://example.com', 'curl', 'network'],
    ['node scripts/gen.js', 'node', 'run'],
    ["bash -lc 'npm test'", 'npm', 'test'],
    ['/usr/bin/env bash -c "cargo build --release"', 'cargo', 'build'],
  ])('%s → %s (%s)', (command, program, category) => {
    expect(describeCommand(command)).toMatchObject({ program, category });
  });

  it('lists every program, never arguments, and refuses what is not a command', () => {
    expect(describeCommand('git add -A && git commit -m "secret message" && npm test')).toEqual({ program: 'git', programs: ['git', 'npm'], operations: ['git add', 'git commit', 'npm test'], category: 'test' });
    expect(describeCommand('')).toBeNull();
    expect(describeCommand('cd /tmp')).toBeNull();
    expect(describeCommand(42)).toBeNull();
  });

  it('never takes a word inside quotes for a program', () => {
    expect(describeCommand("printf 'a; secretword --x' && npm test")).toEqual({ program: 'printf', programs: ['printf', 'npm'], operations: ['printf', 'npm test'], category: 'test' });
    expect(describeCommand('echo "x | hiddenprog; y" | wc -l')).toEqual({ program: 'echo', programs: ['echo', 'wc'], operations: ['echo', 'wc'], category: 'read' });
    expect(describeCommand('git commit -m a\\;b')).toMatchObject({ programs: ['git'] });
    expect(describeCommand("bash -lc 'grep -r \"a;b\" src && npm test'")).toEqual({ program: 'grep', programs: ['grep', 'npm'], operations: ['grep', 'npm test'], category: 'test' });
    expect(describeCommand('npm test 2>&1 | tail -5')).toEqual({ program: 'npm', programs: ['npm', 'tail'], operations: ['npm test', 'tail'], category: 'test' });
    expect(describeCommand('ls # rm -rf; secretword')).toEqual({ program: 'ls', programs: ['ls'], operations: ['ls'], category: 'search' });
  });

  it('names only well-known programs; anything else is counted', () => {
    expect(describeCommand('some-tool --flag')).toEqual({ program: undefined, programs: [], operations: [], category: 'other', unknown: 1 });
    expect(describeCommand('./scripts/private_fixture_value.sh && npm test')).toEqual({ program: 'npm', programs: ['npm'], operations: ['npm test'], category: 'test', unknown: 1 });
    expect(describeCommand('env -u private_fixture_value npm test')).toMatchObject({ programs: [], unknown: 1 });
    expect(commandAttributesOf('some-tool --flag')).toEqual({ 'updraft.tool.command.unknown_programs': 1, 'updraft.tool.command.category': 'other', 'updraft.tool.category': 'other' });
  });

  it('keeps a conditional or arithmetic expression whole', () => {
    const cond = '[[ "$stage" == ready && "private_fixture_value" == "$stage" ]] && npm test';
    expect(describeCommand(cond)).toEqual({ program: 'npm', programs: ['npm'], operations: ['npm test'], category: 'test' });
    expect(describeCommand('[[ -f a || ( -d b ) ]] && make test')).toEqual({ program: 'make', programs: ['make'], operations: ['make'], category: 'test' });
    expect(describeCommand('(( n > 1 && private_fixture_value < 3 )) && git status')).toEqual({ program: 'git', programs: ['git'], operations: ['git status'], category: 'git' });
    expect(describeCommand('[[ -f a && private_fixture_value')).toBeNull();
  });

  it("reads a shell's -c only among its own options, before its first operand", () => {
    expect(describeCommand("bash ./check.sh -c 'private_script_argument'")).toEqual({ program: 'bash', programs: ['bash'], operations: ['bash'], category: 'run' });
    expect(describeCommand("bash -e -o pipefail -c 'npm test'")).toEqual({ program: 'npm', programs: ['npm'], operations: ['npm test'], category: 'test' });
    expect(describeCommand("sh -- -c 'private_script_argument'")).toEqual({ program: 'sh', programs: ['sh'], operations: ['sh'], category: 'run' });
  });

  it('never exports an unusual word, whatever the command (content off)', () => {
    const secret = 'private_fixture_value';
    for (const command of [
      `[[ "$x" == a && "${secret}" == b ]] && npm test`,
      `bash ./x.sh -c '${secret}'`,
      `case $x in a) ${secret} ;; esac`,
      `if true; then ${secret}; fi`,
      `{ ${secret}; }`,
      `xargs -I{} ${secret} {}`,
      `sudo -u root ${secret}`,
      `timeout -s KILL 5 ${secret}`,
      `FOO=1 ${secret} --x`,
      `echo a | ${secret}`,
    ]) {
      expect(JSON.stringify(claudeToolAttributes('Bash', { command }, [])), command).not.toContain(secret);
    }
  });

  it('records no program when the boundaries are not certain', () => {
    expect(describeCommand("printf 'unterminated; secretword")).toBeNull();
    expect(describeCommand('git commit -m "$(cat msg); secretword"')).toBeNull();
    expect(describeCommand('cat <<EOF > f\nsecretword --flag\nEOF')).toBeNull();
    expect(describeCommand('echo `secretword`')).toBeNull();
    expect(describeCommand("bash -c 'echo \"unterminated'")).toBeNull();
  });
});

describe('paths', () => {
  it('records a path relative to the worktree', () => {
    expect(relativePath('/work/tree/src/a.ts', ['/work/tree'])).toBe('src/a.ts');
    expect(relativePath('/work/tree', ['/work/tree/'])).toBe('.');
    expect(relativePath('/etc/hosts', ['/work/tree'])).toBe('/etc/hosts');
  });

  it.each([
    ['src/theme.test.ts', true],
    ['src/__tests__/theme.ts', true],
    ['tests/test_theme.py', true],
    ['pkg/theme_test.go', true],
    ['src/main/java/ThemeTest.java', true],
    ['src/theme.ts', false],
    ['docs/testing.md', false],
  ])('%s is a test: %s', (p, test) => {
    expect(isTestPath(p)).toBe(test);
  });

  it('counts lines like wc -l, plus an unterminated last line', () => {
    expect(lineCount('')).toBe(0);
    expect(lineCount('a\nb\n')).toBe(2);
    expect(lineCount('a\nb')).toBe(2);
  });
});

describe('tool attributes', () => {
  const roots = ['/work/tree'];

  it('describes an edit by its file and line counts, not its text', () => {
    const a = claudeToolAttributes('Edit', { file_path: '/work/tree/src/theme.ts', old_string: 'a\nb', new_string: 'a\nb\nc\n' }, roots);
    expect(a).toMatchObject({ 'updraft.tool.file.path': 'src/theme.ts', 'updraft.tool.file.extension': 'ts', 'updraft.tool.file.test': false, 'updraft.tool.lines_added': 3, 'updraft.tool.lines_removed': 2, 'updraft.tool.category': 'edit' });
    expect(JSON.stringify(a)).not.toContain('a\\nb');
  });

  it('describes a command, a search, a fetch and a plan', () => {
    expect(claudeToolAttributes('Bash', { command: 'npm test -- --grep secret', run_in_background: true }, roots)).toMatchObject({ 'updraft.tool.command.program': 'npm', 'updraft.tool.command.category': 'test', 'updraft.tool.category': 'test', 'updraft.tool.background': true });
    expect(claudeToolAttributes('Grep', { pattern: 'password', path: '/work/tree/src', glob: '*.ts' }, roots)).toEqual({ 'updraft.tool.search.path': 'src', 'updraft.tool.search.extension': 'ts', 'updraft.tool.category': 'search' });
    // A glob is recorded only as an extension: a name in it is an argument.
    expect(claudeToolAttributes('Glob', { pattern: '**/*private_fixture_value*' }, roots)).toEqual({ 'updraft.tool.category': 'search' });
    expect(claudeToolAttributes('Glob', { pattern: '**/*.py' }, roots)['updraft.tool.search.extension']).toBe('py');
    expect(claudeToolAttributes('WebFetch', { url: 'https://docs.example.com/a?token=x', prompt: 'p' }, roots)).toEqual({ 'updraft.tool.url.host': 'docs.example.com', 'updraft.tool.category': 'web' });
    expect(claudeToolAttributes('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }] }, roots)).toMatchObject({ 'updraft.todo.total': 3, 'updraft.todo.completed': 1, 'updraft.todo.in_progress': 1, 'updraft.todo.pending': 1, 'updraft.tool.category': 'plan' });
    expect(claudeToolAttributes('mcp__github__get_issue', {}, roots)['updraft.tool.category']).toBe('mcp');
  });

  it('describes a result by its size, and a test run by its counts', () => {
    expect(resultAttributes('read', 'Read', 'a\nb\nc\n', false)).toMatchObject({ 'updraft.tool.output.bytes': 6, 'updraft.tool.output.lines': 3, 'updraft.tool.read.lines': 3 });
    expect(resultAttributes('search', 'Grep', 'No matches found', false)['updraft.tool.search.results']).toBe(0);
    const failed = resultAttributes('test', 'Bash', 'Exit code 1\n FAIL  src/a.test.ts > theme > toggles\n Tests  1 failed | 4 passed (5)\n', true);
    expect(failed).toMatchObject({ 'updraft.tool.exit_code': 1, 'updraft.test.framework': 'vitest', 'updraft.test.failed': 1, 'updraft.test.passed': 4, 'updraft.test.total': 5, 'updraft.test.failed_tests': ['src/a.test.ts > theme > toggles'] });
  });

  it('describes a Codex patch by its files', () => {
    const a = codexToolAttributes({ type: 'file_change', changes: [{ path: '/work/tree/src/a.ts', kind: 'update' }, { path: '/work/tree/src/a.test.ts', kind: 'add' }] }, roots);
    expect(a).toMatchObject({ 'updraft.tool.file.paths': ['src/a.ts', 'src/a.test.ts'], 'updraft.tool.file.count': 2, 'updraft.tool.file.added': 1, 'updraft.tool.file.updated': 1, 'updraft.tool.file.test': true });
  });
});

describe('test runner output', () => {
  it('vitest', () => {
    const out = '\u001b[31m FAIL \u001b[39m src/a.test.ts > dark mode > persists\n\n Test Files  1 failed | 3 passed (4)\n      Tests  1 failed | 11 passed | 2 skipped (14)\n';
    expect(parseTestOutput(out)).toEqual({ framework: 'vitest', passed: 11, failed: 1, skipped: 2, total: 14, failedTests: ['src/a.test.ts > dark mode > persists'] });
  });

  it('jest', () => {
    const out = '  ● Theme › toggles\n\nTests:       1 failed, 2 skipped, 10 passed, 13 total\n';
    expect(parseTestOutput(out)).toMatchObject({ framework: 'jest', passed: 10, failed: 1, skipped: 2, total: 13, failedTests: ['Theme › toggles'] });
  });

  it('pytest, without the failure messages', () => {
    const out = 'FAILED tests/test_theme.py::test_toggle - AssertionError: secret value\n==== 1 failed, 9 passed, 1 skipped in 0.52s ====\n';
    expect(parseTestOutput(out)).toMatchObject({ framework: 'pytest', passed: 9, failed: 1, skipped: 1, total: 11, failedTests: ['tests/test_theme.py::test_toggle'] });
  });

  it('go test, with and without -v', () => {
    expect(parseTestOutput('=== RUN   TestA\n--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)\nFAIL\n')).toMatchObject({ framework: 'go', passed: 1, failed: 1, failedTests: ['TestB'] });
    expect(parseTestOutput('ok  \texample.com/a\t0.012s\nFAIL\texample.com/b\t0.020s\n')).toMatchObject({ framework: 'go', unit: 'package', passed: 1, failed: 1, failedTests: ['example.com/b'] });
  });

  it('cargo, added up over suites', () => {
    const out = 'test a::works ... ok\ntest b::breaks ... FAILED\ntest result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured\ntest result: ok. 2 passed; 0 failed; 1 ignored; 0 measured\n';
    expect(parseTestOutput(out)).toMatchObject({ framework: 'cargo', passed: 5, failed: 1, skipped: 1, failedTests: ['b::breaks'] });
  });

  it('mocha, rspec, node:test', () => {
    expect(parseTestOutput('  12 passing (30ms)\n  2 failing\n  1 pending\n')).toMatchObject({ framework: 'mocha', passed: 12, failed: 2, skipped: 1 });
    expect(parseTestOutput('10 examples, 2 failures, 1 pending\n')).toMatchObject({ framework: 'rspec', passed: 7, failed: 2, skipped: 1, total: 10 });
    expect(parseTestOutput('not ok 3 - theme toggles\n# pass 10\n# fail 1\n')).toMatchObject({ framework: 'node-test', passed: 10, failed: 1, failedTests: ['theme toggles'] });
  });

  it('nothing when there is no summary', () => {
    expect(parseTestOutput('hello\nworld\n')).toBeNull();
    expect(parseTestOutput('')).toBeNull();
  });

  it('checkers: eslint, tsc', () => {
    expect(parseCheckOutput('✖ 5 problems (3 errors, 2 warnings)\n')).toEqual({ tool: 'eslint', errors: 3, warnings: 2 });
    expect(parseCheckOutput('src/a.ts(1,1): error TS2322: x\nsrc/b.ts(2,2): error TS2345: y\n')).toEqual({ tool: 'tsc', errors: 2, warnings: 0 });
  });

  it('tells tsc, mypy and ruff apart', () => {
    expect(parseCheckOutput('src/a.ts:1:1 - error TS2322: x\n\nFound 3 errors in 2 files.\n')).toEqual({ tool: 'tsc', errors: 3, warnings: 0 });
    expect(parseCheckOutput('a.py:1: error: x  [arg-type]\nFound 4 errors in 2 files (checked 10 source files)\n')).toEqual({ tool: 'mypy', errors: 4, warnings: 0 });
    expect(parseCheckOutput('Success: no issues found in 10 source files\n')).toEqual({ tool: 'mypy', errors: 0, warnings: 0 });
    expect(parseCheckOutput('a.py:1:1: F401 unused\nFound 3 errors.\n[*] 2 fixable with the `--fix` option.\n')).toEqual({ tool: 'ruff', errors: 3, warnings: 0 });
    expect(parseCheckOutput('Found 4 errors in 2 files.\n', ['mypy'])).toEqual({ tool: 'mypy', errors: 4, warnings: 0 });
    expect(parseCheckOutput('Found 4 errors in 2 files.\n', ['tsc'])).toEqual({ tool: 'tsc', errors: 4, warnings: 0 });
    expect(parseCheckOutput('All checks passed!\n', ['ruff'])).toEqual({ tool: 'ruff', errors: 0, warnings: 0 });
    expect(parseCheckOutput('Found 4 errors in 2 files.\n')).toEqual({ tool: 'unknown', errors: 4, warnings: 0 });
  });
});

describe('Updraft MCP exec', () => {
  const opOf = (command) => claudeToolAttributes('mcp__updraft__exec', { command }, [])['updraft.tool.operation'];
  it.each([
    ['git status', 'git status'],
    ['git diff HEAD~1', 'git diff'],
    ['git -C /secret status', 'git'],
    ['npm test', 'npm test'],
    ['npm run build', 'npm build'],
    ['npm run deploy-prod', 'npm'],
    ['grep -r x . | grep y; sed s/a/b/ f; cat f', 'grep / sed / cat'],
    ['./mystery --token=abc', undefined],
    ['echo $(whoami)', undefined],
    ["echo 'unterminated", undefined],
    ['ls && cat a && head a && wc a', 'ls / cat / head / …'],
  ])('%s -> %s', (command, op) => expect(opOf(command)).toBe(op));

  it('classifies like Bash and leaves other MCP tools alone', () => {
    expect(claudeToolAttributes('mcp__updraft__exec', { command: 'npm test' }, [])['updraft.tool.category']).toBe('test');
    expect(claudeToolAttributes('mcp__other__exec', { command: 'npm test' }, [])['updraft.tool.category']).toBe('mcp');
    expect(claudeToolAttributes('Bash', { command: 'git status' }, [])['updraft.tool.operation']).toBeUndefined();
    expect(operationName(null)).toBeNull();
  });

  it('reads the exit status from the result, and leaves it unset when absent', () => {
    expect(resultAttributes('git', 'mcp__updraft__exec', 'x\nexit=2', false)['updraft.tool.exit_code']).toBe(2);
    expect(resultAttributes('git', 'mcp__updraft__exec', 'x', false)['updraft.tool.exit_code']).toBeUndefined();
  });
});
