'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('CLI retrieval rerun against the committed baseline runs without dependency-default errors', { timeout: 300000 }, () => {
  const res = spawnSync(
    process.execPath,
    ['bench/runner.ts', 'retrieval', 'rerun', '--json'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, DOFLOW_QUIET: '1' },
    }
  );

  assert.notEqual(res.status, 2, `unexpected exit code 2: stderr=${res.stderr}, stdout=${res.stdout}`);
  assert.ok(
    res.status === 0 || res.status === 1 || res.status === 4,
    `expected exit code 0, 1 or 4, got ${res.status}: stderr=${res.stderr}, stdout=${res.stdout}`
  );
  assert.doesNotMatch(res.stderr || '', /is not a function/);
  assert.doesNotMatch(res.stdout || '', /is not a function/);
  assert.doesNotMatch(res.stderr || '', /^\s*at\s+/m);
  assert.doesNotMatch(res.stdout || '', /^\s*at\s+/m);

  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.verb, 'rerun');
  assert.equal(parsed.exitCode, res.status);
  assert.ok(!parsed.error || !parsed.error.includes('deps.'));
  assert.doesNotMatch(parsed.error || '', /is not a function/);
  assert.doesNotMatch(parsed.error || '', /^\s*at\s+/m);

  if (res.status === 4) {
    const combined = `${res.stdout}\n${res.stderr}`;
    assert.match(combined, /tool \w+: pinned|tool drift/i);
    assert.ok(parsed.verify && Array.isArray(parsed.verify.tools) && parsed.verify.tools.some((t: any) => !t.ok));
  }
});
