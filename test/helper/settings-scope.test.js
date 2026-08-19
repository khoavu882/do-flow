'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chmodHooksExecutable } = require('../../src/helper/settings-scope');

function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-settingsscope-'));
}

// The project-scope hook path rewrite itself (${CLAUDE_PROJECT_DIR} substitution) now lives in
// src/adapters/claude/index.js#settingsContent, covered by test/claude-adapter.test.js's
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

  assert.strictEqual(fs.statSync(hook).mode & 0o777, 0o775, 'existing rw bits preserved, +x added');
  assert.strictEqual(fs.statSync(readme).mode & 0o777, 0o664, 'a non-.sh file must be left untouched');
});

test('chmodHooksExecutable is a no-op when there is no hooks/ directory', () => {
  const dir = scratchDir();
  assert.doesNotThrow(() => chmodHooksExecutable(dir));
});
