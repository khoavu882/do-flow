'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chmodHooksExecutable } = require('../../src/helper/settings-scope');
const { IS_WIN } = require('../helper-platform');

function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-settingsscope-'));
}

// The project-scope hook path rewrite itself (${CLAUDE_PROJECT_DIR} substitution) now lives in
// src/adapters/claude/index.js#settingsContent, covered by test/adapters/claude/claude-adapter.test.js's
// project/global-scope settings tests — this file only covers chmodHooksExecutable, the one
// piece of settings-scope.js still called from bin/doflow.js.

test('chmodHooksExecutable adds +x to every .sh hook while preserving existing bits, and skips non-.sh files', () => {
  const dir = scratchDir();
  const hooksDir = path.join(dir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hook = path.join(hooksDir, 'session-start.sh');
  const readme = path.join(hooksDir, 'README.md');
  fs.writeFileSync(hook, '#!/bin/sh\necho hi\n');
  fs.chmodSync(hook, 0o664);
  fs.writeFileSync(readme, 'not a hook\n');
  fs.chmodSync(readme, 0o664);

  chmodHooksExecutable(dir);

  // Windows has no permission bits: chmodSync can only toggle the read-only flag and every
  // writable file stats back as 0666, so the bit arithmetic is unanswerable there. The portable
  // invariant is that the pass runs cleanly, touches nothing but .sh files, and leaves content
  // intact — the exact bits are pinned on POSIX only.
  if (IS_WIN) {
    assert.strictEqual(fs.readFileSync(hook, 'utf8'), '#!/bin/sh\necho hi\n', 'hook content untouched');
    assert.strictEqual(fs.readFileSync(readme, 'utf8'), 'not a hook\n', 'readme content untouched');
    return;
  }
  assert.strictEqual(fs.statSync(hook).mode & 0o777, 0o775, 'existing rw bits preserved, +x added');
  assert.strictEqual(fs.statSync(readme).mode & 0o777, 0o664, 'a non-.sh file must be left untouched');
});

test('chmodHooksExecutable is a no-op when there is no hooks/ directory', () => {
  const dir = scratchDir();
  assert.doesNotThrow(() => chmodHooksExecutable(dir));
});
