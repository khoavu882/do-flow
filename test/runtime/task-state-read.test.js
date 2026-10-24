'use strict';
// task-state-read.test.js — what `readTaskState` says about a file it cannot read.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { readTaskState } = require('../../src/runtime/task-state.ts');

test('FU-mtjqt9 C-13: a torn state file is store-unreadable and the message carries none of its bytes', (t) => {
  const dir = tempDir(t, 'doflow-task-state-read-');
  const file = path.join(dir, 'torn.json');
  const secret = 'SECRET-PAYLOAD-77c1';
  fs.writeFileSync(file, `${secret} not json`);
  assert.throws(() => readTaskState(fs, file), (error) => {
    assert.equal(error.code, 'store-unreadable');
    assert.ok(error.message.includes(file), error.message);
    assert.equal(error.message.includes(secret), false, error.message);
    assert.equal(error.message.includes('SECRET'), false, error.message);
    return true;
  });
});

test('FU-mtjqt9 C-13: a file of another schema version is still refused with the version named', (t) => {
  const dir = tempDir(t, 'doflow-task-state-read-');
  const file = path.join(dir, 'future.json');
  fs.writeFileSync(file, JSON.stringify({ version: 999 }));
  assert.throws(() => readTaskState(fs, file), (error) => error.code === 'store-unreadable' && /schema version 999/.test(error.message));
});
