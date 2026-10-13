'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('CLI retrieval rerun against the committed baseline runs without dependency-default errors', { timeout: 300000 }, () => {
  const res = spawnSync(
    process.execPath,
    ['bench/runner.js', 'retrieval', 'rerun', '--json'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, DOFLOW_QUIET: '1' },
    }
  );

  assert.notEqual(res.status, 2, `unexpected exit code 2: stderr=${res.stderr}, stdout=${res.stdout}`);
  assert.ok(res.status === 0 || res.status === 1, `expected exit code 0 or 1, got ${res.status}`);
  assert.doesNotMatch(res.stderr || '', /deps\.\w+ is not a function/);
  assert.doesNotMatch(res.stdout || '', /deps\.\w+ is not a function/);

  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.verb, 'rerun');
  assert.ok(parsed.exitCode === 0 || parsed.exitCode === 1);
  assert.ok(!parsed.error || !parsed.error.includes('deps.'));
});
