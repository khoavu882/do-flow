'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseTestCounts, extractFailedFiles } = require('../../src/runtime/verification/contract-runner.ts');
const { tempDir } = require('../helper/tmp');

const TAP_PASS = `TAP version 13
# Subtest: test one
ok 1 - test one
  ---
  duration_ms: 1.2
  ...
# Subtest: test two
ok 2 - test two
  ---
  duration_ms: 0.8
  ...
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4.5
`;

const TAP_FAIL = `TAP version 13
# Subtest: test one
ok 1 - test one
  ---
  duration_ms: 1.0
  ...
# Subtest: test two
not ok 2 - test two
  ---
  duration_ms: 2.5
  failureType: 'testCodeFailure'
  ...
1..2
# tests 2
# suites 0
# pass 1
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 6.2
`;

const SPEC_PASS = `✔ test alpha (1.5ms)
✔ test beta (2.1ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 8.9ms
`;

const SPEC_FAIL = `✔ test alpha (1.5ms)
✖ test beta (2.1ms)
  Error: assertion failed
ℹ tests 2
ℹ suites 0
ℹ pass 1
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9.4ms
`;

const PYTEST_SAMPLE = `============================= test session starts ==============================
platform darwin -- Python 3.11.0, pytest-7.4.0, pluggy-1.3.0
rootdir: /tmp/pytest-sample
collected 3 items

test_app.py .F.                                                          [100%]

=================================== FAILURES ===================================
__________________________________ test_two ____________________________________

    def test_two():
>       assert 1 == 2
E       assert 1 == 2

test_app.py:5: AssertionError
=========================== short test summary info ============================
FAILED test_app.py::test_two - assert 1 == 2
========================= 1 failed, 2 passed in 0.05s ==========================
`;

test('parseTestCounts parses pinned TAP 22.18 shape', () => {
  assert.deepEqual(parseTestCounts(TAP_PASS), { tests: 2, testsFailed: 0 });
  assert.deepEqual(parseTestCounts(TAP_FAIL), { tests: 2, testsFailed: 1 });
});

test('parseTestCounts parses spec 24/26 shape', () => {
  assert.deepEqual(parseTestCounts(SPEC_PASS), { tests: 2, testsFailed: 0 });
  assert.deepEqual(parseTestCounts(SPEC_FAIL), { tests: 2, testsFailed: 1 });
});

test('parseTestCounts returns null counts on pytest samples', () => {
  assert.deepEqual(parseTestCounts(PYTEST_SAMPLE), { tests: null, testsFailed: null });
});

test('parseTestCounts returns null counts on non-string or unparseable input', () => {
  assert.deepEqual(parseTestCounts(''), { tests: null, testsFailed: null });
  assert.deepEqual(parseTestCounts(null), { tests: null, testsFailed: null });
  assert.deepEqual(parseTestCounts(undefined), { tests: null, testsFailed: null });
  assert.deepEqual(parseTestCounts('random non test output'), { tests: null, testsFailed: null });
});

test('extractFailedFiles extracts files from TAP location:, spec test at, and pytest FAILED x::', (t) => {
  const root = tempDir(t, 'doflow-output-parse-');
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test', 'foo.test.js'), '// test foo\n');
  fs.writeFileSync(path.join(root, 'test', 'bar.test.js'), '// test bar\n');
  fs.writeFileSync(path.join(root, 'tests', 'test_baz.py'), '# test baz\n');

  const conventionNode = {
    isTest: (f) => f.startsWith('test/') && f.endsWith('.test.js'),
  };
  const conventionPy = {
    isTest: (f) => f.startsWith('tests/') && f.endsWith('.py'),
  };

  // 1. TAP location: (absolute path)
  const tapOutput = `TAP version 13
# Subtest: test one
not ok 1 - test one
  ---
  duration_ms: 1.5
  location: '${path.join(root, 'test', 'foo.test.js')}:12:34'
  ...
1..1
# tests 1
# fail 1
`;
  assert.deepEqual(
    extractFailedFiles(tapOutput, { root, convention: conventionNode }),
    ['test/foo.test.js'],
    'extracts TAP location'
  );

  // 2. Spec test at (relative to root)
  const specOutput = `✔ test alpha (1.5ms)
✖ test beta (2.1ms)
  Error: assertion failed
✖ failing tests:
test at test/bar.test.js:20:10
✖ test beta (2.1ms)
  Error: assertion failed
ℹ tests 2
ℹ fail 1
`;
  assert.deepEqual(
    extractFailedFiles(specOutput, { root, convention: conventionNode }),
    ['test/bar.test.js'],
    'extracts spec test at'
  );

  // 3. Pytest FAILED x::
  const pytestOutput = `=================================== FAILURES ===================================
FAILED tests/test_baz.py::test_case - AssertionError: assert 1 == 2
========================= 1 failed, 0 passed in 0.05s ==========================
`;
  assert.deepEqual(
    extractFailedFiles(pytestOutput, { root, convention: conventionPy }),
    ['tests/test_baz.py'],
    'extracts pytest FAILED x::'
  );
});

test('extractFailedFiles drops directories, non-test files, files outside root, and faults', (t) => {
  const root = tempDir(t, 'doflow-output-drop-');
  fs.mkdirSync(path.join(root, 'test', 'somedir'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'not_a_test.js'), 'module.exports = 1;\n');

  const convention = {
    isTest: (f) => f.startsWith('test/'),
  };

  // Directory location is dropped
  const dirLocationOutput = `TAP version 13
not ok 1 - dir test
  ---
  location: '${path.join(root, 'test', 'somedir')}:1:1'
  ...
`;
  assert.deepEqual(
    extractFailedFiles(dirLocationOutput, { root, convention }),
    [],
    'drops directory location'
  );

  // Non-test file is dropped by convention.isTest
  const nonTestOutput = `TAP version 13
not ok 1 - non test
  ---
  location: '${path.join(root, 'src', 'not_a_test.js')}:1:1'
  ...
`;
  assert.deepEqual(
    extractFailedFiles(nonTestOutput, { root, convention }),
    [],
    'drops non-test file'
  );

  // File outside root is dropped
  const outsideRootOutput = `TAP version 13
not ok 1 - outside
  ---
  location: '/outside/path/test/foo.test.js:1:1'
  ...
`;
  assert.deepEqual(
    extractFailedFiles(outsideRootOutput, { root, convention }),
    [],
    'drops file outside root'
  );

  // Parse faults return []
  assert.deepEqual(extractFailedFiles('', { root, convention }), []);
  assert.deepEqual(extractFailedFiles(null, { root, convention }), []);
  assert.deepEqual(extractFailedFiles(undefined, { root, convention }), []);
  assert.deepEqual(extractFailedFiles('not a test output', { root, convention }), []);
  assert.deepEqual(extractFailedFiles('not a test output', { root: null, convention }), []);
  assert.deepEqual(extractFailedFiles('not a test output', { root, convention: null }), []);
});
