'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EXIT, usageError } = require('../../src/runtime/cli-result.ts');

test('cli-result-exit: EXIT defines frozen status constants per IC-002', () => {
  assert.equal(EXIT.OK, 0);
  assert.equal(EXIT.EMPTY, 1);
  assert.equal(EXIT.USAGE, 2);
  assert.equal(EXIT.OVERFLOW, 3);

  assert.ok(Object.isFrozen(EXIT), 'EXIT must be a frozen object');
});

test('cli-result-exit: usageError returns EXIT.USAGE', () => {
  // Capture console.error to avoid cluttering test output
  const origError = console.error;
  const origExitCode = process.exitCode;
  try {
    console.error = () => {};
    const code = usageError('test-verb', 'bad args');
    assert.equal(code, EXIT.USAGE);
    assert.equal(process.exitCode, EXIT.USAGE);
  } finally {
    console.error = origError;
    process.exitCode = origExitCode;
  }
});

test('cli-result-exit: changing OVERFLOW to 1 fails (negative control)', () => {
  function verifyExitConstants(constants) {
    if (constants.OVERFLOW !== 3) {
      throw new Error(`OVERFLOW must equal 3, got ${constants.OVERFLOW}`);
    }
    assert.notEqual(constants.OVERFLOW, constants.EMPTY, 'OVERFLOW must not collapse to EMPTY');
  }

  // Positive check passes
  verifyExitConstants(EXIT);

  // Negative control simulation: changing OVERFLOW to 1 fails
  const mutatedConstants = { ...EXIT, OVERFLOW: 1 };
  assert.throws(
    () => verifyExitConstants(mutatedConstants),
    (err) => err.message.includes('OVERFLOW must equal 3')
  );
});
