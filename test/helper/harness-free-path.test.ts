'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./tmp.ts');
const { buildHarnessFreePath, HARNESS_BINARY_NAMES } = require('./harness-free-path.ts');
const { retiredIds } = require('../../src/registry/harness-ids.ts');

function exe(dir: string, name: string, mode = 0o755) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode });
}

test('harness-free-path: harness and retired names are dropped, other runnable files are linked', { skip: process.platform === 'win32' }, (t: any) => {
  const root = tempDir(t);
  const bin = path.join(root, 'bin');
  exe(bin, 'claude'); exe(bin, 'git-like');
  for (const id of retiredIds()) exe(bin, id);
  const out = buildHarnessFreePath(bin);
  assert.deepEqual(fs.readdirSync(out), ['git-like']);
  assert.ok(HARNESS_BINARY_NAMES.includes(retiredIds()[0]));
});

test('harness-free-path: a relative PATH entry is resolved before linking', { skip: process.platform === 'win32' }, (t: any) => {
  const root = tempDir(t);
  exe(path.join(root, 'rel'), 'tool');
  const rel = path.relative(process.cwd(), path.join(root, 'rel'));
  const out = buildHarnessFreePath(rel);
  assert.equal(fs.realpathSync(path.join(out, 'tool')), fs.realpathSync(path.join(root, 'rel', 'tool')));
});

test('harness-free-path: a non-executable file and a directory are not linked; the first entry wins', { skip: process.platform === 'win32' }, (t: any) => {
  const root = tempDir(t);
  exe(path.join(root, 'a'), 'plain', 0o644);
  fs.mkdirSync(path.join(root, 'a', 'subdir'));
  exe(path.join(root, 'a'), 'dup'); exe(path.join(root, 'b'), 'dup');
  const out = buildHarnessFreePath([path.join(root, 'a'), path.join(root, 'b')].join(path.delimiter));
  assert.deepEqual(fs.readdirSync(out), ['dup']);
  assert.equal(fs.realpathSync(path.join(out, 'dup')), fs.realpathSync(path.join(root, 'a', 'dup')));
});

test('harness-free-path: only EEXIST from symlinkSync is ignored', { skip: process.platform === 'win32' }, (t: any) => {
  const root = tempDir(t);
  exe(path.join(root, 'bin'), 'tool');
  const failing = (code: string) => ({ ...fs, symlinkSync() { throw Object.assign(new Error(code), { code }); } });
  assert.doesNotThrow(() => buildHarnessFreePath(path.join(root, 'bin'), failing('EEXIST')));
  assert.throws(() => buildHarnessFreePath(path.join(root, 'bin'), failing('EACCES')), /EACCES/);
});
