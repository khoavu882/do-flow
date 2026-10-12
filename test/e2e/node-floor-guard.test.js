'use strict';

// 073 — bin/doflow.js refuses clearly on a Node that cannot strip types, instead of dying with a
// SyntaxError from the first .ts module. --no-experimental-strip-types stands in for such a Node (it
// is also how a user switches stripping off on a new one). The guard runs before the compile cache
// and before any ../src require, so the refusal prints nothing but its own line.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');

const REPO = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO, 'bin', 'doflow.js');
const scratch = createScratch('doflow-node-floor-');

function run(nodeArgs) {
  const env = scratch.env({});
  delete env.NODE_COMPILE_CACHE; // same handling as compile-cache.test.js: no cache env leaks in
  delete env.NODE_DISABLE_COMPILE_CACHE;
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, [...nodeArgs, BIN, '--version'], { env, encoding: 'utf8' });
}

test('node floor: the guard precedes the compile cache and the first ../src require', () => {
  const src = fs.readFileSync(BIN, 'utf8');
  const guard = src.indexOf('process.features.typescript');
  assert.ok(guard !== -1, 'bin/doflow.js must test process.features.typescript');
  assert.ok(guard < src.indexOf('enableCompileCache()'), 'the guard must run before the compile cache');
  assert.ok(guard < src.search(/require\(['"]\.\.\/src\//), 'the guard must run before the first ../src require');
});

test('node floor: without type-stripping the CLI exits 2 naming the Node, the range and the flag, with empty stdout', () => {
  const probe = spawnSync(process.execPath, ['--no-experimental-strip-types', '-p', 'String(process.features.typescript)'], { encoding: 'utf8' });
  assert.equal(probe.stdout.trim(), 'false', 'negative control: --no-experimental-strip-types must turn stripping off on this Node');
  const r = run(['--no-experimental-strip-types']);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, '');
  assert.ok(r.stderr.includes(process.versions.node), 'stderr must name the running Node version');
  assert.ok(r.stderr.includes('^22.18.0 || >=23.6.0'), 'stderr must state the required range');
  assert.ok(r.stderr.includes('--no-experimental-strip-types'), 'stderr must name the disabled-stripping case');
  assert.equal(r.stderr.trim().split('\n').length, 1, 'one line, no stack trace');
});

test('node floor: a normal run still prints the bare version with empty stderr', () => {
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/);
  assert.equal(r.stderr, '');
});
