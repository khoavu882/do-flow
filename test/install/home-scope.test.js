'use strict';
// sameDirectory decides whether a project run is rooted at the home directory, so it must see one
// directory behind every spelling a user can type: a trailing separator, `.`, a symlink and the
// macOS /var -> /private/var temp folder.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IS_WIN } = require('../helper-platform');
const { suiteTempDir } = require('../helper/tmp');
const { sameDirectory } = require('../../src/cli/shared.ts');

const R = suiteTempDir('doflow-home-scope-');
const home = path.join(R, 'home');
fs.mkdirSync(path.join(home, 'work'), { recursive: true });

test('the same directory, with and without a trailing separator', () => {
  assert.strictEqual(sameDirectory(home, home), true);
  assert.strictEqual(sameDirectory(`${home}${path.sep}`, home), true);
});

test('a symlink to the directory', () => {
  const link = path.join(R, 'link');
  fs.symlinkSync(home, link, IS_WIN ? 'junction' : 'dir');
  assert.strictEqual(sameDirectory(link, home), true);
});

test('`.` resolves against the current directory', () => {
  const cwd = process.cwd();
  try {
    process.chdir(home);
    assert.strictEqual(sameDirectory('.', home), true);
  } finally {
    process.chdir(cwd);
  }
});

test('the temp folder spelling and its real path', (t) => {
  const tmp = os.tmpdir();
  const real = fs.realpathSync(tmp);
  if (tmp === real) { t.skip('the temp folder is not reached through a symlink here'); return; }
  assert.strictEqual(sameDirectory(tmp, real), true);
});

test('a directory below, and the directory above, are different', () => {
  assert.strictEqual(sameDirectory(path.join(home, 'work'), home), false);
  assert.strictEqual(sameDirectory(R, home), false);
});

test('two missing paths compare as resolved strings', () => {
  const missing = path.join(R, 'missing');
  assert.strictEqual(sameDirectory(`${missing}${path.sep}`, missing), true);
  assert.strictEqual(sameDirectory(missing, path.join(R, 'absent')), false);
});
