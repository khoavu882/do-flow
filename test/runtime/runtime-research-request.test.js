'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { updateTaskState } = require('../../src/runtime/task-state');
const cli = path.resolve(__dirname, '../../bin/doflow.js');

function run(root, ...args) {
  return spawnSync(process.execPath, [cli, 'research-request', ...args, '--json'], { cwd: root, encoding: 'utf8' });
}

test('CLI opens, lists and resolves requests in a temporary project', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-req-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  updateTaskState({ fsImpl: fs, file: path.join(root, '.doflow/state/orchestration/demo.json'),
    build: () => ({ taskId: 'demo', taskClass: 'feature', state: 'RUNNING', cursor: 0,
      program: [{ type: 'stage', id: 'design' }] }) });
  const opened = run(root, '--action', 'open', '--task-id', 'demo', '--stage-id', 'design',
    '--question', 'Which upstream API?', '--reason', 'detected-gap');
  assert.equal(opened.status, 0, opened.stderr);
  const request = JSON.parse(opened.stdout);
  assert.equal(request.blocking, true);
  const listed = run(root, '--action', 'list', '--task-id', 'demo');
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).requests[0].id, request.id);
  const defaultList = run(root, '--task-id', 'demo');
  assert.equal(defaultList.status, 0, defaultList.stderr);
  assert.equal(JSON.parse(defaultList.stdout).requests[0].id, request.id);
  const resolved = run(root, '--action', 'resolve', '--task-id', 'demo', '--request-id', request.id,
    '--outcome', 'unresolved', '--gap', 'No source');
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(JSON.parse(resolved.stdout).status, 'UNRESOLVED');
  const invalid = run(root, '--action', 'open', '--task-id', 'demo', '--stage-id', 'design',
    '--question', 'Q', '--reason', 'detected-gap', '--blocking', 'maybe');
  assert.equal(invalid.status, 2);
});
