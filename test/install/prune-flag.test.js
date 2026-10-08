'use strict';
// --prune is validated while the arguments are parsed, so a bad value exits before any command touches
// the scratch HOME.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { IS_WIN } = require('../helper-platform');
const { createScratch } = require('../helper/scratch-env');

const DOFLOW = path.resolve(__dirname, '../../bin/doflow.js');

const scratches = [];
after(() => { for (const scratch of scratches) scratch.remove(); });

function run(args) {
  const scratch = createScratch('doflow-prune-flag-');
  scratches.push(scratch);
  // os.homedir() prefers USERPROFILE on Windows, so both must point at the scratch HOME.
  const env = scratch.env(IS_WIN ? { USERPROFILE: scratch.home } : {});
  const result = spawnSync('node', [DOFLOW, ...args], { env, input: '\n', encoding: 'utf8' });
  assert.ok(!fs.existsSync(path.join(scratch.home, '.claude')), 'no .claude created');
  assert.ok(!fs.existsSync(path.join(scratch.home, '.doflow')), 'no .doflow created');
  return result;
}

for (const value of ['abc', '5abc', '1.5']) {
  test(`--prune ${value} exits 2 naming the value`, () => {
    const r = run(['install', '-g', '--prune', value]);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, new RegExp(`--prune requires a non-negative whole number, got '${value.replace('.', '\\.')}'`));
  });
}

test('--prune -2 exits 1', () => {
  const r = run(['install', '-g', '--prune', '-2']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--prune requires a number/);
});

test('--prune as the last argument exits 1', () => {
  const r = run(['install', '-g', '--prune']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--prune requires a number/);
});

for (const value of ['0', '7']) {
  test(`--prune ${value} is accepted`, () => {
    const r = run(['install', '-g', '--dry-run', '-t', 'claude', '--mcp', 'none', '--prune', value]);
    assert.strictEqual(r.status, 0, r.stderr);
  });
}
