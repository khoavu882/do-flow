'use strict';

// The `pretest` guard: the suite refuses to start when the temp directory or an ancestor holds `.doflow`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { checkTmpdir } = require('../../scripts/check-tmpdir.js');

const SCRIPT = path.resolve(__dirname, '../../scripts/check-tmpdir.js');

test('a clean temp directory passes', (t) => {
  const base = tempDir(t, 'doflow-tmpcheck-');
  const tmp = path.join(base, 'a', 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  assert.deepEqual(checkTmpdir(tmp), { ok: true, line: '' });
});

test('a .doflow in the temp directory itself or in an ancestor is refused with one line naming the path', (t) => {
  const base = tempDir(t, 'doflow-tmpcheck-');
  const tmp = path.join(base, 'a', 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(path.join(base, '.doflow'));
  const viaAncestor = checkTmpdir(tmp);
  assert.equal(viaAncestor.ok, false);
  assert.ok(viaAncestor.line.includes(path.join(base, '.doflow')), viaAncestor.line);
  assert.equal(viaAncestor.line.includes('\n'), false);
  fs.mkdirSync(path.join(tmp, '.doflow'));
  assert.ok(checkTmpdir(tmp).line.includes(path.join(tmp, '.doflow')));
});

test('run as a script with a fake TMPDIR it exits 1 and prints the line, or exits 0 when clean', (t) => {
  const base = tempDir(t, 'doflow-tmpcheck-');
  const tmp = path.join(base, 'tmp');
  fs.mkdirSync(tmp);
  const env = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  assert.equal(spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' }).status, 0);
  fs.mkdirSync(path.join(tmp, '.doflow'));
  const refused = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.ok(refused.stderr.includes(path.join(tmp, '.doflow')), refused.stderr);
  assert.equal(refused.stderr.trim().split('\n').length, 1);
});

test('the global store under the home folder is exempt, any other .doflow still refuses, and the message never says remove', (t) => {
  const home = tempDir(t, 'doflow-tmpcheck-');
  fs.mkdirSync(path.join(home, '.doflow'));
  const tmp = path.join(home, 'var', 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  assert.deepEqual(checkTmpdir(tmp, home), { ok: true, line: '' });

  const elsewhere = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(elsewhere, '.doflow'), { recursive: true });
  const inner = path.join(elsewhere, 'tmp');
  fs.mkdirSync(inner);
  const refused = checkTmpdir(inner, home);
  assert.equal(refused.ok, false);
  assert.ok(refused.line.includes(path.join(elsewhere, '.doflow')), refused.line);
  assert.ok(refused.line.includes(`set TMPDIR outside ${elsewhere}`), refused.line);
  assert.equal(refused.line.includes('\n'), false);
  assert.equal(/remove/i.test(refused.line), false, refused.line);
});
