'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir } = require('../helper/tmp.ts');
const { EXIT, usageError } = require('../../src/runtime/cli-result.ts');

const DISPATCHER = path.resolve(__dirname, '..', '..', 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';

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
  function verifyExitConstants(constants: any) {
    if (constants.OVERFLOW !== 3) {
      throw new Error(`OVERFLOW must equal 3, got ${constants.OVERFLOW}`);
    }
    assert.notEqual(constants.OVERFLOW, constants.EMPTY, 'OVERFLOW must not collapse to EMPTY');
  }

  // Positive check passes
  verifyExitConstants(EXIT);

  // Negative control simulation: changing OVERFLOW to 1 fails
  const mutatedConstants: any = { ...EXIT, OVERFLOW: 1 };
  assert.throws(
    () => verifyExitConstants(mutatedConstants),
    (err: any) => err.message.includes('OVERFLOW must equal 3')
  );
});

test('cli-result-exit: context-pack overflow passes through without failure capture', () => {
  const root = suiteTempDir('doflow-cli-result-overflow-');
  const xdg = path.join(root, 'xdg');
  fs.mkdirSync(xdg, { recursive: true });
  const result = spawnSync(BASH, [
    DISPATCHER,
    'context-pack',
    '--task-id', 'fx5-cli-result',
    '--objective', 'x'.repeat(6000),
    '--max-bytes', '5000',
    '--no-record',
    '--json',
  ], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: xdg, DOFLOW_FAILURE_CAPTURE: '', DOFLOW_AGENT: 'codex' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 3, `expected overflow exit 3; stdout=${result.stdout}; stderr=${result.stderr}`);
  assert.equal(
    fs.existsSync(path.join(xdg, 'doflow', 'failures', 'events.jsonl')),
    false,
    'overflow must not be captured as a dispatcher crash'
  );
});
