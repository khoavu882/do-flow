'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, suiteTempDir, removeTree } = require('./tmp.ts');
const { createScratch } = require('./scratch-env.ts');

const TMP_HELPER = path.join(__dirname, 'tmp.ts');
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;

function childFile(dir: any, name: any, source: any) {
  const file = path.join(dir, `${name}.test.js`);
  fs.writeFileSync(file, source);
  return file;
}

function runChild(file: any, resultFile: any) {
  const env: any = { ...process.env, RESULT_FILE: resultFile };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', file], { env, encoding: 'utf8' });
}

function childSource(body: any) {
  return `'use strict';\n${body}\n`;
}

test('tempDir creates a real path for a passing test and removes it after the file ends', (t) => {
  const dir = tempDir(t, 'doflow-tmp-pass-parent-');
  const result = path.join(dir, 'result');
  const file = childFile(dir, 'passing', childSource(`
    const { test } = require('node:test');
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { tempDir } = require(${JSON.stringify(TMP_HELPER)});
    test('passes', (t) => {
      const childDir = tempDir(t, 'doflow-tmp-pass-child-');
      assert.ok(fs.existsSync(childDir));
      fs.writeFileSync(process.env.RESULT_FILE, childDir);
    });
  `));

  const child = runChild(file, result);
  assert.equal(child.status, 0, child.stderr);
  const childDir = fs.readFileSync(result, 'utf8');
  assert.equal(fs.existsSync(childDir), false);
});

test('tempDir removes a failing subtest directory', (t) => {
  const dir = tempDir(t, 'doflow-tmp-fail-parent-');
  const result = path.join(dir, 'result');
  const file = childFile(dir, 'failing', childSource(`
    const { test } = require('node:test');
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { tempDir } = require(${JSON.stringify(TMP_HELPER)});
    test('parent', async (t) => {
      await t.test('fails', (t) => {
        const childDir = tempDir(t, 'doflow-tmp-fail-child-');
        fs.writeFileSync(process.env.RESULT_FILE, childDir);
        assert.fail('intentional child failure');
      });
    });
  `));

  const child = runChild(file, result);
  assert.notEqual(child.status, 0, 'the child test must fail');
  const childDir = fs.readFileSync(result, 'utf8');
  assert.equal(fs.existsSync(childDir), false);
});

test('the exit cleanup net removes a directory when a child throws at top level', (t) => {
  const dir = tempDir(t, 'doflow-tmp-throw-parent-');
  const result = path.join(dir, 'result');
  const file = childFile(dir, 'throws', childSource(`
    const fs = require('node:fs');
    const { suiteTempDir } = require(${JSON.stringify(TMP_HELPER)});
    const childDir = suiteTempDir('doflow-tmp-throw-child-');
    fs.writeFileSync(process.env.RESULT_FILE, childDir);
    throw new Error('intentional top-level throw');
  `));

  const child = runChild(file, result);
  assert.notEqual(child.status, 0, 'the child file must throw');
  const childDir = fs.readFileSync(result, 'utf8');
  assert.equal(fs.existsSync(childDir), false);
});

test('suiteTempDir removes its directory after the file ends', (t) => {
  const dir = tempDir(t, 'doflow-tmp-suite-parent-');
  const result = path.join(dir, 'result');
  const file = childFile(dir, 'suite', childSource(`
    const { test } = require('node:test');
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { suiteTempDir } = require(${JSON.stringify(TMP_HELPER)});
    const childDir = suiteTempDir('doflow-tmp-suite-child-');
    fs.writeFileSync(process.env.RESULT_FILE, childDir);
    test('uses suite directory', () => assert.ok(fs.existsSync(childDir)));
  `));

  const child = runChild(file, result);
  assert.equal(child.status, 0, child.stderr);
  const childDir = fs.readFileSync(result, 'utf8');
  assert.equal(fs.existsSync(childDir), false);
});

test('suiteTempDir called from a before hook remains available to test bodies', (t) => {
  const dir = tempDir(t, 'doflow-tmp-before-parent-');
  const result = path.join(dir, 'result');
  const file = childFile(dir, 'before-hook', childSource(`
    const { before, test } = require('node:test');
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const { suiteTempDir } = require(${JSON.stringify(TMP_HELPER)});
    let childDir;
    before(() => {
      childDir = suiteTempDir('doflow-tmp-before-child-');
      fs.writeFileSync(path.join(childDir, 'marker'), 'ready');
      fs.writeFileSync(process.env.RESULT_FILE, childDir);
    });
    test('uses suite directory after before hook', () => {
      assert.equal(fs.readFileSync(path.join(childDir, 'marker'), 'utf8'), 'ready');
    });
  `));

  const child = runChild(file, result);
  assert.equal(child.status, 0, child.stderr);
  const childDir = fs.readFileSync(result, 'utf8');
  assert.equal(fs.existsSync(childDir), false);
});

test('temp directory prefixes must start with doflow-', (t) => {
  assert.throws(() => tempDir(t, 'other-'), /doflow-/);
  assert.throws(() => suiteTempDir('other-'), /doflow-/);
});

test('removeTree removes a tree containing a read-only subfolder', {
  skip: process.platform === 'win32' || ROOT_USER,
}, (t) => {
  const dir = tempDir(t, 'doflow-tmp-readonly-');
  const readOnly = path.join(dir, 'read-only');
  fs.mkdirSync(readOnly);
  fs.writeFileSync(path.join(readOnly, 'entry'), 'x');
  fs.chmodSync(readOnly, 0o500);

  removeTree(dir);
  assert.equal(fs.existsSync(dir), false);
});

test('createScratch writes the default prune setting, supports an override, and removes idempotently', () => {
  const defaults = createScratch('doflow-tmp-scratch-default-');
  const enabled = createScratch('doflow-tmp-scratch-enabled-', { prune: 'on' });

  assert.equal(fs.readFileSync(path.join(defaults.xdg, 'doflow', 'prune'), 'utf8'), 'off\n');
  assert.equal(fs.readFileSync(path.join(enabled.xdg, 'doflow', 'prune'), 'utf8'), 'on\n');
  defaults.remove();
  assert.doesNotThrow(() => defaults.remove());
  enabled.remove();
  assert.doesNotThrow(() => enabled.remove());
});
