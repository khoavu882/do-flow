'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('../../src/cli/index.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const BIN = path.join(REPO_ROOT, 'bin', 'doflow.js');

test('doflow --help documents --absence, --status and retrieval-plan attempt action', () => {
  const res = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('--absence'), 'help must list --absence');
  assert.ok(res.stdout.includes('--status'), 'help must list --status');
  assert.ok(res.stdout.includes('attempt'), 'help must mention attempt');
  assert.match(res.stdout, /retrieval-plan:\s*declare\|report\|attempt/, 'help must list attempt action for retrieval-plan');
});

test('parseArgs parses --status into attemptStatus and --absence flag', () => {
  const parsed = parseArgs(['retrieval-plan', '--task-id', 't1', '--action', 'attempt', '--status', 'EMPTY', '--absence']);
  assert.equal(parsed.cmd, 'retrieval-plan');
  assert.equal(parsed.taskId, 't1');
  assert.equal(parsed.action, 'attempt');
  assert.equal(parsed.attemptStatus, 'EMPTY');
  assert.equal(parsed.absence, true);
});

test('parseArgs parses --status=UNREACHED inline syntax', () => {
  const parsed = parseArgs(['retrieval-plan', '--task-id', 't1', '--status=UNREACHED']);
  assert.equal(parsed.attemptStatus, 'UNREACHED');
});
