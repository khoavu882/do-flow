'use strict';
// 1.24.x gave these two options parameters an `= {}` default; a no-argument call must not die on the
// destructure itself (A5 of the 073 final review).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { destructiveCommandGlobs } = require('../../src/helper/guardrails.ts');
const { handleVerifyCommand } = require('../../src/runtime/verification/engine.ts');

test('handleVerifyCommand() with no argument returns a usage exit code instead of throwing', () => {
  const write = process.stderr.write;
  const code = process.exitCode;
  process.stderr.write = () => true;
  try {
    assert.equal(typeof handleVerifyCommand(), 'number');
  } finally {
    process.stderr.write = write;
    process.exitCode = code;
  }
});

test('destructiveCommandGlobs() with no argument gets past the destructure (fails later, on the missing repoRoot)', () => {
  assert.throws(() => destructiveCommandGlobs(), (e) => e.code === 'ERR_INVALID_ARG_TYPE');
});
