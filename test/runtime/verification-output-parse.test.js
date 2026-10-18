'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTestCounts } = require('../../src/runtime/verification/contract-runner.ts');

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
