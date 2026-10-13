'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { handleRetrievalPlanCommand } = require('../../src/runtime/retrieval-plan.ts');
const { planPath, readPlan } = require('../../src/runtime/retrieval-record.ts');

test('two child processes each run N reports against one plan; revision ends at 2N + 1', async (t) => {
  const root = tempDir(t, 'doflow-retrieval-concurrency-');
  const taskId = 'concurrency-task';

  const realLog = console.log;
  console.log = () => {};
  let code;
  try {
    code = handleRetrievalPlanCommand({
      taskId,
      action: 'declare',
      need: ['locate-concept'],
      stateRoot: root,
      json: true,
    });
  } finally {
    console.log = realLog;
    process.exitCode = 0;
  }
  assert.equal(code, 0, 'declare must succeed');

  const initial = readPlan(root, taskId);
  assert.ok(initial, 'initial plan exists');
  assert.equal(initial.revision, 1, 'initial plan starts at revision 1');

  const N = 10;
  const workerScript = `
    const { handleRetrievalPlanCommand } = require(${JSON.stringify(path.resolve(__dirname, '../../src/runtime/retrieval-plan.ts'))});
    const root = ${JSON.stringify(root)};
    const taskId = ${JSON.stringify(taskId)};
    const N = ${N};
    for (let i = 0; i < N; i++) {
      const code = handleRetrievalPlanCommand({
        taskId,
        action: 'report',
        need: [],
        stateRoot: root,
        json: true,
      });
      if (code !== 1 && code !== 0) {
        process.exit(2);
      }
    }
    process.exit(0);
  `;

  const child1 = spawn(process.execPath, ['-e', workerScript], { stdio: 'ignore' });
  const child2 = spawn(process.execPath, ['-e', workerScript], { stdio: 'ignore' });

  await Promise.all([
    new Promise((resolve, reject) => {
      child1.on('close', (exitCode) => (exitCode === 0 ? resolve() : reject(new Error(`child1 exited with ${exitCode}`))));
    }),
    new Promise((resolve, reject) => {
      child2.on('close', (exitCode) => (exitCode === 0 ? resolve() : reject(new Error(`child2 exited with ${exitCode}`))));
    }),
  ]);

  const file = planPath(root, taskId);
  const raw = fs.readFileSync(file, 'utf8');
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(raw);
  }, 'the file must always parse as valid JSON');

  assert.equal(parsed.revision, 2 * N + 1, `expected revision ${2 * N + 1}, got ${parsed.revision}`);
});
