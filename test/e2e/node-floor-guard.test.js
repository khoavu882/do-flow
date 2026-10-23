'use strict';

// 073 — bin/doflow.js refuses clearly on a Node that cannot strip types, instead of dying with a
// SyntaxError from the first .ts module. --no-experimental-strip-types stands in for such a Node (it
// is also how a user switches stripping off on a new one). The guard runs before the compile cache
// and before any ../src require, so the refusal prints nothing but its own line.
// maint-node24-floor — the floor is also a version: Node below 24.22.1 (the 2026-10-21 security
// release; Node 22 included) is refused with the same one-line shape. Those runtimes are not
// installed on every machine, so the version cases run bin/doflow.js in a vm with a fake `process`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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
  assert.ok(r.stderr.includes('>=24.22.1'), 'stderr must state the required range');
  assert.ok(r.stderr.includes('--no-experimental-strip-types'), 'stderr must name the disabled-stripping case');
  assert.equal(r.stderr.trim().split('\n').length, 1, 'one line, no stack trace');
});

test('node floor: a normal run still prints the bare version with empty stderr', () => {
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\n$/);
  assert.equal(r.stderr, '');
});

// Runs bin/doflow.js in a vm whose `process` reports `version` and stripping on. The refusal path
// calls the fake exit; a Node the guard accepts reaches the first `require`, which the vm stops.
function guard(version) {
  const stderr = [];
  const REACHED = Symbol('past the guard');
  const sandbox = {
    process: {
      versions: { node: version },
      features: { typescript: 'strip' },
      stderr: { write: (text) => { stderr.push(text); } },
      exit: (code) => { throw { exit: code }; },
      argv: [],
      on() {},
    },
    require: () => { throw { reached: REACHED }; },
  };
  let outcome;
  try {
    new vm.Script(fs.readFileSync(BIN, 'utf8'), { filename: BIN }).runInNewContext(sandbox);
    outcome = 'ran';
  } catch (error) {
    outcome = error && error.exit !== undefined ? { exit: error.exit } : error && error.reached === REACHED ? 'accepted' : error;
  }
  return { outcome, stderr: stderr.join('') };
}

test('node floor: a Node below 24.22.1, Node 22 included, exits 2 naming the Node and the floor in one line', () => {
  for (const version of ['22.18.0', '22.23.4', '23.6.0', '24.3.0', '24.21.9', '24.22.0']) {
    const r = guard(version);
    assert.deepEqual(r.outcome, { exit: 2 }, version);
    assert.ok(r.stderr.includes(`Node ${version}`), `${version}: stderr must name the running Node: ${r.stderr}`);
    assert.ok(r.stderr.includes('>=24.22.1'), `${version}: stderr must state the floor: ${r.stderr}`);
    assert.equal(r.stderr.trim().split('\n').length, 1, `${version}: one line, no stack trace`);
  }
});

test('node floor: 24.22.1 and newer pass the guard', () => {
  for (const version of ['24.22.1', '24.22.2', '24.23.0', '24.100.0', '25.0.0', '26.12.1', '26.13.0', '30.0.0']) {
    const r = guard(version);
    assert.equal(r.outcome, 'accepted', `${version}: ${JSON.stringify(r)}`);
    assert.equal(r.stderr, '', version);
  }
});

test('node floor: the floor in bin/doflow.js, package.json engines and the message are one value', () => {
  const engines = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).engines.node;
  assert.equal(engines, '>=24.22.1');
  assert.ok(guard('24.21.9').stderr.includes(engines));
});
