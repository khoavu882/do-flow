'use strict';
// targeted-test-selection.test.js: feature 071. The targeted tier is scoped to the feature's changed
// test files (FR-003), recorded (FR-004), subsumed by an identical required broad tier (FR-001) and
// never stands in for it (FR-005); a `node --test` script yields a scopable command (FR-002).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir } = require('../helper/tmp');
const { detectCommands } = require('../../src/runtime/command-detect.ts');
const { VerificationEngine } = require('../../src/runtime/verification/engine.ts');
const { selectChangedTests, quotePath } = require('../../src/runtime/verification/test-selection.ts');

const REPO = path.resolve(__dirname, '../..');

/** A project whose test script is `script`, with `files` (relative path -> content) written under it. */
function project({ script = 'node --test test/', files = {} } = {}) {
  const root = suiteTempDir('doflow-targeted-selection-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: script } }));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const NODE_FILES = {
  'test/a.test.js': '',
  'test/b.test.js': '',
  'test/c.test.mjs': '',
  'test/helper/util.js': '',
  'test/guards/g1.test.js': '',
  'test/guards/g2.test.js': '',
  'src/lib.js': '',
};

/** A `spawnSync`-shaped exec that records every shell command and fails those `failing` matches. */
function fakeExec({ failing = () => false, gitStatus = null } = {}) {
  const calls = [];
  const exec = (command, argsOrOptions) => {
    if (command === 'git' || command.startsWith('git ')) {
      if (gitStatus === null) return { status: 128, stdout: '', stderr: 'fatal: not a git repository' };
      return { status: 0, stdout: gitStatus, stderr: '' };
    }
    calls.push(command);
    return failing(command)
      ? { status: 1, stdout: '', stderr: 'not ok 1 - boom' }
      : { status: 0, stdout: 'ok', stderr: '', argsOrOptions };
  };
  return { exec, calls };
}

function compile(root, { risk = 'LOW', changedFiles, exec, targetPattern } = {}) {
  const engine = new VerificationEngine({ cwd: root, repoRoot: REPO, exec });
  const contract = engine.compileContract({
    taskId: 'A.1',
    riskLevel: risk,
    projectRoot: root,
    changedFiles,
    targetPattern,
    scope: { allowedPaths: ['src/', 'test/'] },
  });
  return { engine, contract, tier: (id) => contract.tiers.find((t) => t.id === id) };
}

test('FR-002: a `node --test <dirs>` script yields `node --test {pattern}` as a declared command', () => {
  for (const script of ['node --test test/', 'node --test test/ tests/']) {
    const root = project({ script });
    const found = detectCommands({ projectRoot: root }).commands.testTargeted;
    assert.equal(found.command, 'node --test {pattern}');
    assert.equal(found.derivation, 'declared');
    assert.deepEqual(found.testDirs, script.split(' ').slice(2));
  }
});

test('FR-002: a quoted or glob test script reduces to its directory roots', () => {
  const cases = [
    ['node --test "test/**/*.test.js"', ['test']],
    ["node --test 'test/**/*.test.js' 'e2e/**/*.test.js'", ['test', 'e2e']],
    ['node --test "**/*.test.js"', ['.']],
    ['node --test src/a/*.spec.js', ['src/a']],
    ['node --test "test/**/*.test.js" test', ['test']],
    ['node --test "test/" tests/unit', ['test/', 'tests/unit']],
  ];
  for (const [script, dirs] of cases) {
    const found = detectCommands({ projectRoot: project({ script }) }).commands.testTargeted;
    assert.equal(found.derivation, 'declared', script);
    assert.deepEqual(found.testDirs, dirs, script);
  }
});

test('FR-003: with a glob test script a changed test file is selected from the glob root', () => {
  // No test/guards/ here: the guard directory is always added to a selection (see the case above).
  const root = project({
    script: 'node --test "test/**/*.test.js"',
    files: { 'test/a.test.js': '', 'test/b.test.js': '', 'src/lib.js': '' },
  });
  const found = detectCommands({ projectRoot: root }).commands.testTargeted;
  const selected = selectChangedTests({ found, observation: { files: ['test/a.test.js'] }, root });
  assert.equal(selected.selection.selectedCount, 1);
  assert.ok(selected.selection.totalCount > 0);
  assert.equal(selected.pattern, 'test/a.test.js');
});

test('FR-002: any other test script keeps the inferred `npm test -- {pattern}` command', () => {
  for (const script of ['node --test', 'jest', 'node --test test/ && node other.js', 'mocha test/']) {
    const root = project({ script });
    const found = detectCommands({ projectRoot: root }).commands.testTargeted;
    assert.equal(found.command, 'npm test -- {pattern}', script);
    assert.equal(found.derivation, 'inferred', script);
    assert.equal(found.testDirs, undefined, script);
  }
});

test('FR-003: two changed test files and one source file select those tests plus the guard directory', () => {
  const root = project({ files: NODE_FILES });
  const { tier } = compile(root, {
    changedFiles: ['test/a.test.js', 'test/c.test.mjs', 'src/lib.js'],
    exec: fakeExec().exec,
  });
  const targeted = tier('targeted-tests');
  assert.equal(targeted.resolution, 'RESOLVED');
  assert.equal(targeted.checks[0].command, 'node --test test/a.test.js test/c.test.mjs test/guards/');
  assert.equal(targeted.checks[0].targetScoped, true);
  assert.equal(targeted.checks[0].derivation, 'declared');
  // 2 changed files + the 2 guard files; 5 test files exist under test/.
  assert.deepEqual(targeted.selection, { basis: 'changed-test-files', selectedCount: 4, totalCount: 5, fallback: null });
});

test('FR-003: a changed `.test.ts` file is selected and counted among the test files', () => {
  const root = project({ files: { ...NODE_FILES, 'test/d.test.ts': '' } });
  const { tier } = compile(root, {
    changedFiles: ['test/d.test.ts', 'src/lib.js'],
    exec: fakeExec().exec,
  });
  const targeted = tier('targeted-tests');
  assert.equal(targeted.checks[0].command, 'node --test test/d.test.ts test/guards/');
  // 1 changed .ts file + the 2 guard files; 6 test files exist under test/ (the .ts one is counted).
  assert.deepEqual(targeted.selection, { basis: 'changed-test-files', selectedCount: 3, totalCount: 6, fallback: null });
});

test('FR-003: a deleted test file and a non-test file under the test directory are not selected', () => {
  const root = project({ files: NODE_FILES });
  const { tier } = compile(root, {
    changedFiles: ['test/gone.test.js', 'test/helper/util.js', 'test/b.test.js'],
    exec: fakeExec().exec,
  });
  assert.equal(tier('targeted-tests').checks[0].command, 'node --test test/b.test.js test/guards/');
});

test('FR-003: a changed guard test is covered by the guard directory, not listed twice', () => {
  const root = project({ files: NODE_FILES });
  const { tier } = compile(root, { changedFiles: ['test/guards/g1.test.js'], exec: fakeExec().exec });
  const targeted = tier('targeted-tests');
  assert.equal(targeted.checks[0].command, 'node --test test/guards/');
  assert.equal(targeted.selection.selectedCount, 2);
});

test('FR-003: without a guard directory only the changed test files are selected', () => {
  const root = project({ files: { 'test/a.test.js': '', 'test/b.test.js': '' } });
  const { tier } = compile(root, { changedFiles: ['test/a.test.js'], exec: fakeExec().exec });
  assert.equal(tier('targeted-tests').checks[0].command, 'node --test test/a.test.js');
});

test('FR-003: a path with a space or a quote reaches the shell as one word', () => {
  assert.equal(quotePath('test/plain.test.js'), 'test/plain.test.js');
  assert.equal(quotePath('test/my file.test.js'), "'test/my file.test.js'");
  assert.equal(quotePath("test/it's.test.js"), `'test/it'\\''s.test.js'`);
  assert.equal(quotePath('test/my file.test.js', 'win32'), '"test/my file.test.js"');

  const root = project({ files: { 'test/my file.test.js': '' } });
  const { tier } = compile(root, { changedFiles: ['test/my file.test.js'], exec: fakeExec().exec });
  assert.equal(tier('targeted-tests').checks[0].command, "node --test 'test/my file.test.js'");
});

test('FR-003 / FR-004: no changed test file runs the broad command and records `no-changed-tests`', () => {
  const root = project({ files: NODE_FILES });
  const { tier } = compile(root, { changedFiles: ['src/lib.js', 'README.md'], exec: fakeExec().exec });
  const targeted = tier('targeted-tests');
  assert.equal(targeted.checks[0].role, 'test');
  assert.equal(targeted.checks[0].command, 'npm test');
  assert.equal(targeted.checks[0].targetScoped, false);
  assert.deepEqual(targeted.selection, { basis: 'changed-test-files', selectedCount: 0, totalCount: 5, fallback: 'no-changed-tests' });
});

test('FR-004: unavailable change detection runs the broad command and records `change-scope-unavailable`', () => {
  const root = project({ files: NODE_FILES });
  const { tier } = compile(root, { exec: fakeExec({ gitStatus: null }).exec });
  const targeted = tier('targeted-tests');
  assert.equal(targeted.checks[0].command, 'npm test');
  assert.equal(targeted.selection.fallback, 'change-scope-unavailable');
  assert.equal(targeted.selection.selectedCount, null);
});

test('FR-003: with no caller list the selection reads the same git observation the change-scope tier uses', () => {
  const root = project({ files: NODE_FILES });
  const { tier } = compile(root, { exec: fakeExec({ gitStatus: ' M test/b.test.js\0 M src/lib.js\0' }).exec });
  assert.equal(tier('targeted-tests').checks[0].command, 'node --test test/b.test.js test/guards/');
});

test('an explicit target pattern wins over the selector and is recorded as such', () => {
  const root = project({ files: NODE_FILES });
  const { tier } = compile(root, { changedFiles: ['test/a.test.js'], targetPattern: 'test/b.test.js', exec: fakeExec().exec });
  const targeted = tier('targeted-tests');
  assert.equal(targeted.checks[0].command, 'node --test test/b.test.js');
  assert.deepEqual(targeted.selection, { basis: 'explicit-pattern', selectedCount: null, totalCount: null, fallback: null });
});

test('an inferred `{pattern}` command with no convention keeps its fallback and records `not-scopable`', () => {
  const root = project({ script: 'jest', files: { 'test/a.test.js': '' } });
  const { tier } = compile(root, { changedFiles: ['test/a.test.js'], exec: fakeExec().exec });
  const targeted = tier('targeted-tests');
  assert.equal(targeted.checks[0].command, 'npm test');
  assert.equal(targeted.selection.fallback, 'not-scopable');
});

test('a pytest project selects changed `test_*.py` and `*_test.py` files', () => {
  const root = suiteTempDir('doflow-targeted-selection-');
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
  for (const rel of ['tests/test_a.py', 'tests/b_test.py', 'tests/conftest.py']) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), '');
  }
  const { tier } = compile(root, { changedFiles: ['tests/test_a.py', 'tests/conftest.py'], exec: fakeExec().exec });
  assert.equal(tier('targeted-tests').checks[0].command, 'pytest tests/test_a.py');
  assert.equal(tier('targeted-tests').selection.totalCount, 2);
});

test('selectChangedTests returns null for a toolchain with no test-file convention', () => {
  assert.equal(selectChangedTests({
    found: { source: 'Cargo.toml' }, observation: { files: ['src/lib.rs'] }, root: '/nonexistent',
  }), null);
});

test('FR-001: at MEDIUM the targeted tier is SUBSUMED by the broad tier and the broad command runs once', () => {
  const root = project({ files: NODE_FILES });
  const { exec, calls } = fakeExec();
  const { engine, contract, tier } = compile(root, { risk: 'MEDIUM', changedFiles: ['src/lib.js'], exec });

  const targeted = tier('targeted-tests');
  assert.equal(targeted.resolution, 'SUBSUMED');
  assert.equal(targeted.subsumedBy, 'broad-tests');
  assert.deepEqual(targeted.checks, []);
  assert.equal(targeted.selection.fallback, 'no-changed-tests');

  const report = engine.runContract(contract, { changedFiles: ['src/lib.js'] });
  const entry = report.tiers.find((t) => t.id === 'targeted-tests');
  assert.equal(entry.status, 'SUBSUMED');
  assert.equal(entry.subsumedBy, 'broad-tests');
  assert.deepEqual(entry.selection, targeted.selection);
  assert.deepEqual(report.notApplicable.filter((n) => n.tier === 'targeted-tests').map((n) => n.status), ['SUBSUMED']);
  assert.equal(report.tiers.find((t) => t.id === 'broad-tests').status, 'PASS');
  assert.deepEqual(calls, ['npm test']);
  assert.equal(report.status, 'PASS');
});

test('FR-001: a scoped targeted command differs from the broad one, so it is not subsumed', () => {
  const root = project({ files: NODE_FILES });
  const { tier } = compile(root, { risk: 'MEDIUM', changedFiles: ['test/a.test.js'], exec: fakeExec().exec });
  assert.equal(tier('targeted-tests').resolution, 'RESOLVED');
  assert.equal(tier('broad-tests').resolution, 'RESOLVED');
});

test('FR-001: at LOW the broad tier is not required, so a fallback targeted run is not subsumed', () => {
  const root = project({ files: NODE_FILES });
  const { tier } = compile(root, { risk: 'LOW', changedFiles: ['src/lib.js'], exec: fakeExec().exec });
  assert.equal(tier('targeted-tests').resolution, 'RESOLVED');
  assert.equal(tier('targeted-tests').checks[0].command, 'npm test');
});

test('FR-004: the report carries the targeted tier selection', () => {
  const root = project({ files: NODE_FILES });
  const { exec, calls } = fakeExec();
  const { engine, contract } = compile(root, { changedFiles: ['test/a.test.js', 'test/b.test.js', 'src/lib.js'], exec });
  const report = engine.runContract(contract, { changedFiles: ['test/a.test.js', 'test/b.test.js', 'src/lib.js'] });
  const entry = report.tiers.find((t) => t.id === 'targeted-tests');
  assert.equal(entry.status, 'PASS');
  assert.deepEqual(entry.selection, { basis: 'changed-test-files', selectedCount: 4, totalCount: 5, fallback: null });
  assert.deepEqual(calls, ['node --test test/a.test.js test/b.test.js test/guards/']);
});

test('FR-005: a passing targeted run does not mark the broad tier passed at LOW', () => {
  const root = project({ files: NODE_FILES });
  const { engine, contract } = compile(root, { risk: 'LOW', changedFiles: ['test/a.test.js'], exec: fakeExec().exec });
  const report = engine.runContract(contract, { changedFiles: ['test/a.test.js'] });
  assert.equal(report.tiers.find((t) => t.id === 'targeted-tests').status, 'PASS');
  const broad = report.tiers.find((t) => t.id === 'broad-tests');
  assert.notEqual(broad.status, 'PASS');
  assert.equal(broad.status, 'SKIPPED');
  assert.equal(broad.checks.length, 0);
});

test('FR-005: at MEDIUM a passing scoped targeted run does not hide a failing broad run', () => {
  const root = project({ files: NODE_FILES });
  const { exec, calls } = fakeExec({ failing: (command) => command === 'npm test' });
  const { engine, contract } = compile(root, { risk: 'MEDIUM', changedFiles: ['test/a.test.js'], exec });
  const report = engine.runContract(contract, { changedFiles: ['test/a.test.js'] });
  assert.equal(report.tiers.find((t) => t.id === 'targeted-tests').status, 'PASS');
  assert.equal(report.tiers.find((t) => t.id === 'broad-tests').status, 'FAIL');
  assert.equal(report.status, 'FAIL');
  assert.deepEqual(calls, ['node --test test/a.test.js test/guards/', 'npm test']);
});

test('NFR-001: the risk levels and their required tier sets are unchanged', () => {
  const { riskLevels } = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/verification.json'), 'utf8'));
  assert.ok(riskLevels.LOW.requiredTiers.includes('targeted-tests'));
  assert.ok(!riskLevels.LOW.requiredTiers.includes('broad-tests'));
  for (const level of ['MEDIUM', 'HIGH', 'CRITICAL']) {
    assert.ok(riskLevels[level].requiredTiers.includes('broad-tests'), level);
  }
});

/** A real git repository holding `files`, committed, so untracked additions are observed by git itself. */
function gitProject(files) {
  const root = project({ files });
  const git = (...args) => {
    const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
  };
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return root;
}

test('review 1: an untracked directory of tests and a non-ASCII test name are both selected from real git', () => {
  const root = gitProject({ 'test/a.test.js': '', 'test/guards/g1.test.js': '' });
  fs.mkdirSync(path.join(root, 'test/newdir'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test/newdir/new.test.js'), '');
  fs.writeFileSync(path.join(root, 'test/tést.test.js'), '');
  const engine = new VerificationEngine({ cwd: root, repoRoot: REPO });
  const contract = engine.compileContract({
    taskId: 'A.1', riskLevel: 'LOW', projectRoot: root, scope: { allowedPaths: ['src/', 'test/'] },
  });
  const command = contract.tiers.find((t) => t.id === 'targeted-tests').checks[0].command;
  assert.equal(command, "node --test test/newdir/new.test.js 'test/t\u00e9st.test.js' test/guards/");
});

test('review 2: a declared `node --test` script carrying a flag is not given the targeted form', () => {
  const root = project({ script: 'node --test --require ./setup.js test/' });
  const found = detectCommands({ projectRoot: root }).commands.testTargeted;
  assert.equal(found.command, 'npm test -- {pattern}');
  assert.equal(found.derivation, 'inferred');
});

test('review 3: a test file whose name starts with `-` reaches the runner with a directory prefix', () => {
  const root = suiteTempDir('doflow-targeted-selection-');
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
  fs.writeFileSync(path.join(root, '--deselect=x_test.py'), '');
  const selected = selectChangedTests({
    found: { source: 'pyproject.toml' }, observation: { files: ['--deselect=x_test.py'] }, root,
  });
  assert.equal(selected.pattern, './--deselect=x_test.py');
  for (const word of selected.pattern.split(' ')) assert.ok(!word.replace(/^'/, '').startsWith('-'), word);
});

test('review 4: on win32 a path holding `%` or `!` is not selectable and the broad command runs', () => {
  const root = project({ files: { 'test/100%.test.js': '', 'test/a!.test.js': '', 'test/ok.test.js': '' } });
  const found = detectCommands({ projectRoot: root }).commands.testTargeted;
  for (const name of ['test/100%.test.js', 'test/a!.test.js']) {
    const selected = selectChangedTests({ found, observation: { files: [name, 'test/ok.test.js'] }, root, platform: 'win32' });
    assert.equal(selected.pattern, null, name);
    assert.equal(selected.selection.fallback, 'unsafe-path', name);
  }
  const posix = selectChangedTests({ found, observation: { files: ['test/100%.test.js'] }, root, platform: 'linux' });
  assert.equal(posix.pattern, "'test/100%.test.js'");
  assert.equal(quotePath('test/100%.test.js', 'linux'), "'test/100%.test.js'");
});
