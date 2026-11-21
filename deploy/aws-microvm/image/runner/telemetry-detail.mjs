// Structural detail for agent telemetry: what a tool call was about, read from its arguments and
// its result, without recording either. telemetry.mjs puts these on spans whether or not the
// tenant records content: a command's program and category (not its arguments), a file's path,
// extension and whether it is a test (not its contents), line and byte counts, and the counts a
// test runner or a checker printed (not its output). Everything here is a pure function.
import path from 'node:path';

/** Tool categories, most telling first: a command with a test in it is a test, whatever else it does. */
const CATEGORY_RANK = ['test', 'lint', 'build', 'install', 'git', 'github', 'network', 'run', 'edit', 'filesystem', 'search', 'read', 'other'];
const rank = (c) => {
  const i = CATEGORY_RANK.indexOf(c);
  return i === -1 ? CATEGORY_RANK.length : i;
};

/** Programs that run another program: the one they run is what the command is about. */
const WRAPPERS = new Set(['sudo', 'env', 'timeout', 'time', 'nice', 'nohup', 'xargs', 'command', 'exec', 'stdbuf', 'unbuffer', 'xvfb-run']);
const RUNNER_OF = new Set(['npx', 'bunx', 'pnpx']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

const TEST_PROGRAMS = new Set(['vitest', 'jest', 'mocha', 'pytest', 'py.test', 'tox', 'nox', 'ava', 'tap', 'playwright', 'cypress', 'phpunit', 'rspec', 'karma', 'ctest', 'bats', 'nyc', 'c8']);
const LINT_PROGRAMS = new Set(['eslint', 'prettier', 'ruff', 'flake8', 'pylint', 'mypy', 'pyright', 'black', 'isort', 'golangci-lint', 'gofmt', 'goimports', 'shellcheck', 'rubocop', 'biome', 'stylelint', 'tflint', 'hadolint', 'markdownlint', 'clang-format', 'clang-tidy', 'ktlint', 'swiftlint']);
const BUILD_PROGRAMS = new Set(['tsc', 'make', 'cmake', 'ninja', 'webpack', 'esbuild', 'rollup', 'vite', 'turbo', 'nx', 'bazel', 'javac', 'gcc', 'g++', 'clang', 'rustc', 'msbuild', 'sam', 'cdk']);
const INSTALL_PROGRAMS = new Set(['pip', 'pip3', 'pipx', 'uv', 'poetry', 'pipenv', 'apt', 'apt-get', 'brew', 'apk', 'dnf', 'yum', 'conda', 'composer', 'gem']);
const SEARCH_PROGRAMS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'fd', 'locate', 'ls', 'tree', 'which', 'whereis']);
const READ_PROGRAMS = new Set(['cat', 'head', 'tail', 'less', 'more', 'sed', 'awk', 'wc', 'file', 'stat', 'diff', 'jq', 'yq', 'nl', 'cut', 'sort', 'uniq', 'od', 'xxd', 'hexdump', 'echo', 'printf', 'pwd']);
const FILESYSTEM_PROGRAMS = new Set(['mv', 'cp', 'rm', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown', 'ln', 'tee', 'tar', 'unzip', 'zip', 'patch']);
const RUN_PROGRAMS = new Set(['node', 'python', 'python3', 'ruby', 'deno', 'java', 'php', 'perl', 'bash', 'sh', 'zsh', 'tsx', 'ts-node', 'docker', 'podman', 'kubectl', 'aws']);

const SAFE_PROGRAM = /^[A-Za-z0-9._+-]{1,64}$/;

const TEST_WORD = /^(test|tests|t|tst|spec|specs|e2e|unit|integration)(:|$)|^test[:_-]|[:_-]test$|^(vitest|jest|mocha|pytest|playwright|cypress)$/;
const LINT_WORD = /^(lint|typecheck|type-check|types|check|format|fmt|prettier|eslint|stylelint)(:|$)|^lint[:_-]|[:_-]lint$/;
const BUILD_WORD = /^(build|compile|bundle|package|dist)(:|$)|^build[:_-]/;
const INSTALL_WORD = /^(install|i|ci|add|update|upgrade|sync|fetch|get|download)$/;

/** The category of one program with its arguments. */
function categorize(program, args) {
  const sub = args.find((a) => !a.startsWith('-')) ?? '';
  if (PACKAGE_MANAGERS.has(program)) {
    // npm run <script> / npm <script> / yarn <script>; bun test is bun's own runner.
    const script = sub === 'run' || sub === 'run-script' || sub === 'exec' || sub === 'x' ? (args.filter((a) => !a.startsWith('-'))[1] ?? '') : sub;
    if (!script) return 'run';
    if (TEST_WORD.test(script)) return 'test';
    if (LINT_WORD.test(script)) return 'lint';
    if (BUILD_WORD.test(script)) return 'build';
    if (INSTALL_WORD.test(script) && sub !== 'run') return 'install';
    if (TEST_PROGRAMS.has(script)) return 'test';
    if (LINT_PROGRAMS.has(script)) return 'lint';
    if (BUILD_PROGRAMS.has(script)) return 'build';
    return 'run';
  }
  if (TEST_PROGRAMS.has(program)) return 'test';
  if (LINT_PROGRAMS.has(program)) return 'lint';
  if (program === 'go') return sub === 'test' ? 'test' : sub === 'vet' || sub === 'fmt' ? 'lint' : sub === 'build' || sub === 'install' ? 'build' : sub === 'get' || sub === 'mod' ? 'install' : 'run';
  if (program === 'cargo') return sub === 'test' || sub === 'nextest' ? 'test' : sub === 'clippy' || sub === 'fmt' ? 'lint' : sub === 'build' || sub === 'check' ? 'build' : sub === 'add' || sub === 'fetch' || sub === 'install' ? 'install' : 'run';
  if (program === 'dotnet' || program === 'swift' || program === 'mix' || program === 'deno' || program === 'zig') return sub === 'test' ? 'test' : sub === 'build' ? 'build' : sub === 'format' || sub === 'fmt' || sub === 'lint' ? 'lint' : 'run';
  if (program === 'mvn' || program === 'mvnw' || program === 'gradle' || program === 'gradlew') return args.some((a) => /^(test|verify|check)$/.test(a)) ? 'test' : 'build';
  if (program === 'make' || program === 'just' || program === 'rake' || program === 'task') {
    if (args.some((a) => /^(test|tests|check|spec)$/.test(a))) return 'test';
    if (args.some((a) => /^(lint|fmt|format)$/.test(a))) return 'lint';
    return 'build';
  }
  if (program === 'bundle') return sub === 'exec' ? categorize(args[1] ?? '', args.slice(2)) : 'install';
  if ((program === 'python' || program === 'python3') && args[0] === '-m') {
    const mod = args[1] ?? '';
    if (/^(pytest|unittest|nose2?|tox)$/.test(mod)) return 'test';
    if (/^(mypy|ruff|flake8|pylint|black|isort)$/.test(mod)) return 'lint';
    if (/^pip$/.test(mod)) return 'install';
    return 'run';
  }
  if (program === 'git') return 'git';
  if (program === 'gh') return 'github';
  if (program === 'curl' || program === 'wget' || program === 'http') return 'network';
  if (program === 'sed' && args.some((a) => /^-i/.test(a))) return 'edit';
  if (BUILD_PROGRAMS.has(program)) return 'build';
  if (INSTALL_PROGRAMS.has(program)) return sub === 'install' || sub === 'add' || sub === 'sync' || program.startsWith('apt') || program === 'brew' ? 'install' : 'run';
  if (FILESYSTEM_PROGRAMS.has(program)) return 'filesystem';
  if (SEARCH_PROGRAMS.has(program)) return 'search';
  if (READ_PROGRAMS.has(program)) return 'read';
  if (RUN_PROGRAMS.has(program)) return 'run';
  return 'other';
}

const unquote = (t) => t.replace(/^['"]|['"]$/g, '');

/**
 * What a shell command runs, without its arguments: the programs of each segment (`a && b | c`),
 * the first that is not `cd`, and the most telling category among them. A `bash -lc '...'`
 * wrapper (how Codex runs commands) is looked inside. Null for anything that is not a command.
 */
export function describeCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  // `env [VAR=x ...] bash -c '...'`: the env is not what the command is about.
  let text = command.replace(/^\s*(?:\/\S*\/)?env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?=(?:\/\S*\/)?(?:ba|z|da)?sh\s)/, '');
  const wrapped = /^\s*(?:\/\S*\/)?(?:ba|z|da)?sh\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c\s+(['"])([\s\S]*)\1\s*$/.exec(text);
  if (wrapped) text = wrapped[2];
  const programs = [];
  let category = null;
  for (const segment of text.split(/&&|\|\||;|\||\n/)) {
    const tokens = segment.trim().replace(/^[({]\s*/, '').split(/\s+/).filter(Boolean).map(unquote);
    let i = 0;
    for (;;) {
      while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
      const t = tokens[i] ? path.basename(tokens[i]) : '';
      if (WRAPPERS.has(t)) {
        i++;
        // A wrapper's own flags and numbers (timeout 60, nice -n 5, env -i).
        while (i < tokens.length && (/^-/.test(tokens[i]) || /^\d+[smhd]?$/.test(tokens[i]))) i++;
        continue;
      }
      if (RUNNER_OF.has(t)) {
        i++;
        while (i < tokens.length && /^-/.test(tokens[i])) i++;
        continue;
      }
      break;
    }
    if (i >= tokens.length) continue;
    const program = path.basename(tokens[i]).replace(/^\.\//, '');
    if (!SAFE_PROGRAM.test(program) || program === 'cd' || program === 'export' || program === 'set' || program === 'source' || program === '.') continue;
    programs.push(program);
    const c = categorize(program, tokens.slice(i + 1));
    if (category === null || rank(c) < rank(category)) category = c;
  }
  if (!programs.length) return null;
  return { program: programs[0], programs: [...new Set(programs)].slice(0, 16), category: category ?? 'other' };
}

/** A path as recorded: relative to the first root it is under, else as given; cut to 512 characters. */
export function relativePath(p, roots = []) {
  if (typeof p !== 'string' || !p) return null;
  let out = p;
  for (const root of roots) {
    if (typeof root !== 'string' || !root) continue;
    const r = root.replace(/\/+$/, '');
    if (out === r) {
      out = '.';
      break;
    }
    if (out.startsWith(`${r}/`)) {
      out = out.slice(r.length + 1);
      break;
    }
  }
  return out.length > 512 ? out.slice(0, 512) : out;
}

/** Whether a path is a test file, by the conventions of the common ecosystems. */
export function isTestPath(p) {
  if (typeof p !== 'string') return false;
  const base = path.basename(p);
  return (
    /(^|\/)(__tests__|__mocks__|tests?|specs?|e2e|testdata|fixtures)\//i.test(p) ||
    /[._-](test|spec|tests|e2e)\.[A-Za-z0-9]+$/i.test(base) ||
    /^test_.+\.py$/.test(base) ||
    /_test\.(go|py|rb|exs?|dart|c|cc|cpp)$/.test(base) ||
    /Tests?\.(java|kt|cs|swift|scala)$/.test(base)
  );
}

/** A file's attributes: path, extension, test or not. */
export function fileAttributes(p, roots, prefix = 'updraft.tool.file') {
  const rel = relativePath(p, roots);
  if (!rel) return {};
  const ext = path.extname(rel).slice(1).toLowerCase();
  return { [`${prefix}.path`]: rel, [`${prefix}.extension`]: ext && ext.length <= 16 ? ext : undefined, [`${prefix}.test`]: isTestPath(rel) };
}

/** Lines in a text: what `wc -l` would say, plus one for a last line without a newline. */
export function lineCount(text) {
  if (typeof text !== 'string' || text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

const host = (url) => {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
};

/** What a TodoWrite (Claude) or todo_list (Codex) holds: counts by status. */
export function todoCounts(items, statusOf) {
  if (!Array.isArray(items)) return null;
  const counts = { total: items.length, pending: 0, in_progress: 0, completed: 0 };
  for (const item of items) {
    const s = statusOf(item);
    if (s in counts && s !== 'total') counts[s] += 1;
  }
  return counts;
}

const todoAttributes = (c) => (c ? { 'updraft.todo.total': c.total, 'updraft.todo.pending': c.pending, 'updraft.todo.in_progress': c.in_progress, 'updraft.todo.completed': c.completed } : {});

/** The general category of a tool call, from its name and, for commands, what it ran. */
export function toolCategory(name, attrs = {}) {
  if (attrs['updraft.tool.command.category']) return attrs['updraft.tool.command.category'];
  if (/^(Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/.test(name)) return 'edit';
  if (name === 'Read') return 'read';
  if (/^(Grep|Glob|LS)$/.test(name)) return 'search';
  if (/^(WebFetch|WebSearch|web_search)$/.test(name)) return 'web';
  if (name === 'TodoWrite') return 'plan';
  if (name === 'Task' || name === 'Agent') return 'delegate';
  if (name.startsWith('mcp__') || name.includes('.')) return 'mcp';
  return 'other';
}

const editLines = (oldText, newText) => ({ removed: lineCount(oldText), added: lineCount(newText) });

/** Attributes of a Claude Code tool call, from its arguments. */
export function claudeToolAttributes(name, input, roots) {
  const a = {};
  const i = input && typeof input === 'object' ? input : {};
  if (name === 'Bash') {
    const d = describeCommand(i.command);
    if (d) Object.assign(a, { 'updraft.tool.command.program': d.program, 'updraft.tool.command.programs': d.programs, 'updraft.tool.command.category': d.category });
    if (i.run_in_background === true) a['updraft.tool.background'] = true;
    if (typeof i.timeout === 'number') a['updraft.tool.timeout_ms'] = i.timeout;
  } else if (name === 'Edit') {
    const l = editLines(i.old_string, i.new_string);
    Object.assign(a, fileAttributes(i.file_path, roots), { 'updraft.tool.lines_added': l.added, 'updraft.tool.lines_removed': l.removed, 'updraft.tool.replace_all': i.replace_all === true ? true : undefined });
  } else if (name === 'MultiEdit') {
    const edits = Array.isArray(i.edits) ? i.edits : [];
    let added = 0;
    let removed = 0;
    for (const e of edits) {
      const l = editLines(e?.old_string, e?.new_string);
      added += l.added;
      removed += l.removed;
    }
    Object.assign(a, fileAttributes(i.file_path, roots), { 'updraft.tool.lines_added': added, 'updraft.tool.lines_removed': removed, 'updraft.tool.edits': edits.length });
  } else if (name === 'Write') {
    Object.assign(a, fileAttributes(i.file_path, roots), { 'updraft.tool.lines_added': lineCount(i.content) });
  } else if (name === 'NotebookEdit') {
    Object.assign(a, fileAttributes(i.notebook_path, roots), { 'updraft.tool.edit_mode': typeof i.edit_mode === 'string' ? i.edit_mode : undefined });
  } else if (name === 'Read') {
    Object.assign(a, fileAttributes(i.file_path, roots), { 'updraft.tool.read.offset': typeof i.offset === 'number' ? i.offset : undefined, 'updraft.tool.read.limit': typeof i.limit === 'number' ? i.limit : undefined });
  } else if (name === 'Grep' || name === 'Glob' || name === 'LS') {
    Object.assign(a, {
      'updraft.tool.search.path': relativePath(i.path, roots) ?? undefined,
      'updraft.tool.search.glob': typeof i.glob === 'string' ? i.glob.slice(0, 256) : name === 'Glob' && typeof i.pattern === 'string' ? i.pattern.slice(0, 256) : undefined,
      'updraft.tool.search.type': typeof i.type === 'string' ? i.type.slice(0, 32) : undefined,
      'updraft.tool.search.output_mode': typeof i.output_mode === 'string' ? i.output_mode : undefined,
    });
  } else if (name === 'WebFetch') {
    a['updraft.tool.url.host'] = host(i.url);
  } else if (name === 'TodoWrite') {
    Object.assign(a, todoAttributes(todoCounts(i.todos, (t) => t?.status)));
  } else if (name === 'Task' || name === 'Agent') {
    if (typeof i.subagent_type === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(i.subagent_type)) a['updraft.tool.subagent_type'] = i.subagent_type;
  }
  a['updraft.tool.category'] = toolCategory(name, a);
  return a;
}

/** Attributes of a tool's result: its size, and what a test runner or checker printed in it. */
export function resultAttributes(category, name, text, failed) {
  const out = typeof text === 'string' ? text : '';
  const a = { 'updraft.tool.output.bytes': Buffer.byteLength(out), 'updraft.tool.output.lines': lineCount(out) };
  if (name === 'Read' && !failed) a['updraft.tool.read.lines'] = lineCount(out);
  if ((name === 'Grep' || name === 'Glob') && !failed) a['updraft.tool.search.results'] = /^(No (files|matches) found|Found 0 )/.test(out.trim()) ? 0 : lineCount(out.trim());
  if (failed) {
    const code = /^Exit code (\d+)/.exec(out);
    if (code) a['updraft.tool.exit_code'] = Number(code[1]);
  }
  if (category === 'test' || category === 'lint' || category === 'build') Object.assign(a, testAttributes(parseTestOutput(out)), checkAttributes(parseCheckOutput(out)));
  return a;
}

/** Attributes of a Codex item that is a tool call, from what it says it did. */
export function codexToolAttributes(item, roots) {
  const a = {};
  if (item.type === 'command_execution') {
    const d = describeCommand(item.command);
    if (d) Object.assign(a, { 'updraft.tool.command.program': d.program, 'updraft.tool.command.programs': d.programs, 'updraft.tool.command.category': d.category });
  } else if (item.type === 'file_change' && Array.isArray(item.changes)) {
    const paths = item.changes.map((c) => relativePath(c?.path, roots)).filter(Boolean);
    const kinds = { add: 0, delete: 0, update: 0 };
    for (const c of item.changes) if (c?.kind in kinds) kinds[c.kind] += 1;
    Object.assign(a, {
      'updraft.tool.file.paths': paths.slice(0, 50),
      'updraft.tool.file.count': item.changes.length,
      'updraft.tool.file.added': kinds.add || undefined,
      'updraft.tool.file.deleted': kinds.delete || undefined,
      'updraft.tool.file.updated': kinds.update || undefined,
      'updraft.tool.file.test': paths.some(isTestPath),
    });
    if (paths.length === 1) Object.assign(a, fileAttributes(paths[0], []));
  }
  return a;
}

/** Codex todo_list items as counts. */
export const codexTodoAttributes = (item) => todoAttributes(todoCounts(item.items, (t) => (t?.completed === true ? 'completed' : 'pending')));

// ---- Test runner and checker output ------------------------------------------------------------

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const MAX_FAILED_TESTS = 20;

const countsIn = (text, words) => {
  const out = {};
  for (const m of text.matchAll(new RegExp(`(\\d+) (${words})\\b`, 'g'))) out[m[2]] = (out[m[2]] ?? 0) + Number(m[1]);
  return out;
};

const failedNames = (text, re, clean = (s) => s) => {
  const names = [];
  for (const m of text.matchAll(re)) {
    const n = clean(m[1].trim());
    if (n && !names.includes(n)) names.push(n.length > 200 ? `${n.slice(0, 200)}…` : n);
    if (names.length >= MAX_FAILED_TESTS) break;
  }
  return names;
};

const result = (framework, passed, failed, skipped, total, failedTests) => {
  const p = passed ?? 0;
  const f = failed ?? 0;
  const s = skipped ?? 0;
  return { framework, passed: p, failed: f, skipped: s, total: total ?? p + f + s, failedTests };
};

/**
 * The counts a test runner printed at the end of its output, and the names of failing tests
 * (not their messages): vitest, jest, pytest, go test, cargo test, mocha, rspec and node:test.
 * Null when no summary is found. When a command ran several suites, they are added up.
 */
export function parseTestOutput(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const text = raw.replace(ANSI, '').replace(/\r/g, '');

  // vitest: " Tests  1 failed | 12 passed | 2 skipped (15)"
  const vitest = [...text.matchAll(/^\s*Tests\s+((?:\d+ \w+\s*\|?\s*)+)\((\d+)\)\s*$/gm)];
  if (vitest.length) {
    const c = countsIn(vitest.map((m) => m[1]).join(' '), 'failed|passed|skipped|todo');
    const total = vitest.reduce((n, m) => n + Number(m[2]), 0);
    return result('vitest', c.passed, c.failed, (c.skipped ?? 0) + (c.todo ?? 0), total, failedNames(text, /^\s*(?:FAIL|×|✗)\s+(.+?)(?:\s+\d+m?s)?$/gm));
  }
  // jest: "Tests:       1 failed, 2 skipped, 10 passed, 13 total"
  const jest = [...text.matchAll(/^Tests:\s+(.+)$/gm)];
  if (jest.length) {
    const c = countsIn(jest.map((m) => m[1]).join(', '), 'failed|passed|skipped|todo|total');
    return result('jest', c.passed, c.failed, (c.skipped ?? 0) + (c.todo ?? 0), c.total, failedNames(text, /^\s*● (.+?)$/gm));
  }
  // pytest: "===== 2 failed, 10 passed, 1 skipped in 0.12s ====="
  const pytest = [...text.matchAll(/^=+ (.*?\b(?:passed|failed|error|errors|skipped|deselected|xfailed|xpassed|no tests ran)\b.*?) in [\d.]+s(?: \([^)]*\))? =+$/gm)];
  if (pytest.length) {
    const c = countsIn(pytest[pytest.length - 1][1], 'failed|passed|skipped|errors|error|xfailed|xpassed|deselected');
    return result('pytest', (c.passed ?? 0) + (c.xpassed ?? 0), (c.failed ?? 0) + (c.error ?? 0) + (c.errors ?? 0), (c.skipped ?? 0) + (c.xfailed ?? 0), undefined, failedNames(text, /^(?:FAILED|ERROR) (\S+)/gm));
  }
  // cargo: "test result: FAILED. 3 passed; 1 failed; 0 ignored; ..."
  const cargo = [...text.matchAll(/^test result: \w+\. (.+)$/gm)];
  if (cargo.length) {
    const c = countsIn(cargo.map((m) => m[1]).join('; '), 'passed|failed|ignored');
    return result('cargo', c.passed, c.failed, c.ignored, undefined, failedNames(text, /^test (\S+) \.\.\. FAILED$/gm));
  }
  // go test (-v prints a line per test; without it, a line per package)
  const goPass = (text.match(/^\s*--- PASS: /gm) ?? []).length;
  const goFail = (text.match(/^\s*--- FAIL: /gm) ?? []).length;
  const goSkip = (text.match(/^\s*--- SKIP: /gm) ?? []).length;
  if (goPass + goFail + goSkip) return result('go', goPass, goFail, goSkip, undefined, failedNames(text, /^\s*--- FAIL: (\S+)/gm));
  const goPkgOk = (text.match(/^ok\s+\S+\s+(?:[\d.]+s|\(cached\))/gm) ?? []).length;
  const goPkgFail = (text.match(/^FAIL\s+\S+\s+[\d.]+s/gm) ?? []).length;
  // Counted in packages, which is all go test says without -v.
  if (goPkgOk + goPkgFail) return { ...result('go', goPkgOk, goPkgFail, 0, undefined, failedNames(text, /^FAIL\s+(\S+)\s+[\d.]+s/gm)), unit: 'package' };
  // mocha: "  12 passing (30ms)" / "  2 failing" / "  1 pending"
  const passing = /^\s+(\d+) passing\b/m.exec(text);
  if (passing) {
    const failing = /^\s+(\d+) failing\b/m.exec(text);
    const pending = /^\s+(\d+) pending\b/m.exec(text);
    return result('mocha', Number(passing[1]), failing ? Number(failing[1]) : 0, pending ? Number(pending[1]) : 0, undefined, failedNames(text, /^\s+\d+\) (.+?):?$/gm));
  }
  // rspec: "10 examples, 2 failures, 1 pending"
  const rspec = /^(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?/m.exec(text);
  if (rspec) {
    const failed = Number(rspec[2]);
    const skipped = Number(rspec[3] ?? 0);
    return result('rspec', Number(rspec[1]) - failed - skipped, failed, skipped, Number(rspec[1]), failedNames(text, /^rspec (\S+)/gm));
  }
  // node:test / TAP: "# pass 10" "# fail 1" "# skipped 0"
  const tapPass = /^# pass (\d+)$/m.exec(text);
  const tapFail = /^# fail (\d+)$/m.exec(text);
  if (tapPass || tapFail) {
    const skip = /^# skip(?:ped)? (\d+)$/m.exec(text);
    return result('node-test', tapPass ? Number(tapPass[1]) : 0, tapFail ? Number(tapFail[1]) : 0, skip ? Number(skip[1]) : 0, undefined, failedNames(text, /^not ok \d+ - (.+)$/gm));
  }
  return null;
}

/** Errors and warnings a type checker or linter reported: tsc, eslint, ruff, mypy. Null if none is found. */
export function parseCheckOutput(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const text = raw.replace(ANSI, '').replace(/\r/g, '');
  const eslint = /✖ \d+ problems? \((\d+) errors?, (\d+) warnings?\)/.exec(text);
  if (eslint) return { tool: 'eslint', errors: Number(eslint[1]), warnings: Number(eslint[2]) };
  const tscFound = /^Found (\d+) errors?\b/m.exec(text);
  const tscLines = (text.match(/error TS\d+:/g) ?? []).length;
  if (tscFound || tscLines) return { tool: 'tsc', errors: tscFound ? Number(tscFound[1]) : tscLines, warnings: 0 };
  const mypy = /^Found (\d+) errors? in \d+ files?/m.exec(text);
  if (mypy) return { tool: 'mypy', errors: Number(mypy[1]), warnings: 0 };
  const ruff = /^Found (\d+) errors?\.?$/m.exec(text);
  if (ruff) return { tool: 'ruff', errors: Number(ruff[1]), warnings: 0 };
  return null;
}

export const testAttributes = (t, prefix = 'updraft.test') =>
  t
    ? {
        [`${prefix}.framework`]: t.framework,
        [`${prefix}.passed`]: t.passed,
        [`${prefix}.failed`]: t.failed,
        [`${prefix}.skipped`]: t.skipped,
        [`${prefix}.total`]: t.total,
        [`${prefix}.failed_tests`]: t.failedTests?.length ? t.failedTests : undefined,
        [`${prefix}.unit`]: t.unit,
      }
    : {};

export const checkAttributes = (c) => (c ? { 'updraft.check.tool': c.tool, 'updraft.check.errors': c.errors, 'updraft.check.warnings': c.warnings } : {});
