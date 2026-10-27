'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tempDir } = require('../helper/tmp.ts');
const cmdSelfUpdate = require('../../src/cli/commands/self-update.ts');

function capture(fn: () => void) {
  const out: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (text: any) => { out.push(String(text)); };
  console.error = (text: any) => { out.push(String(text)); };
  try { fn(); } finally { console.log = log; console.error = error; }
  return out.join('\n');
}

test('self-update on an install that is not a git checkout says how to upgrade and runs no git', (t) => {
  const installRoot = tempDir(t, 'doflow-self-update-npm-');
  let installed = 0;
  const out = capture(() => cmdSelfUpdate({}, { repoRoot: installRoot, install: () => { installed += 1; } }));
  assert.match(out, /not a git checkout; to upgrade DoFlow run: npm install -g @khoavu882\/doflow/);
  assert.doesNotMatch(out, /git fetch failed/);
  assert.equal(installed, 1, 'the install still runs');
});
