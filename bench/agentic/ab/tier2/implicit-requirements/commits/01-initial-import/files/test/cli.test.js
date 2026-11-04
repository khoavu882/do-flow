'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.join(__dirname, '..', 'bin', 'cli.js');

test('an unknown command exits 2 with a one line error', () => {
  const result = spawnSync(process.execPath, [cli, 'frobnicate'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, 'error: unknown command: frobnicate\n');
});

test('an unknown option exits 2', () => {
  const result = spawnSync(process.execPath, [cli, 'list', '--nope'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^error: /);
});
