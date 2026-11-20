'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { handleRetrievalPlanCommand } = require('../../src/runtime/retrieval-plan.ts');
const { planPath, readPlan, updatePlan } = require('../../src/runtime/retrieval-record.ts');

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
    new Promise<void>((resolve, reject) => {
      child1.on('close', (exitCode: any) => (exitCode === 0 ? resolve() : reject(new Error(`child1 exited with ${exitCode}`))));
    }),
    new Promise<void>((resolve, reject) => {
      child2.on('close', (exitCode: any) => (exitCode === 0 ? resolve() : reject(new Error(`child2 exited with ${exitCode}`))));
    }),
  ]);

  const file = planPath(root, taskId);
  const raw = fs.readFileSync(file, 'utf8');
  let parsed: any;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(raw);
  }, 'the file must always parse as valid JSON');

  assert.equal(parsed.revision, 2 * N + 1, `expected revision ${2 * N + 1}, got ${parsed.revision}`);
});

test('updatePlan runs build inside the cross-process lock and releases it afterwards', (t) => {
  const root = tempDir(t, 'doflow-retrieval-lock-');
  const taskId = 'lock-task';
  const file = planPath(root, taskId);
  let lockedDuringBuild = null;
  updatePlan(root, taskId, null, () => {
    lockedDuringBuild = fs.existsSync(`${file}.lock`);
    return { taskId, needs: [] };
  });
  assert.equal(lockedDuringBuild, true, 'build must run while the plan lock is held');
  assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock must be released after the write');
  assert.equal(readPlan(root, taskId).revision, 1);
});

test('concurrent attempts and reports preserve caller attempts and every revision', async (t) => {
  const root = tempDir(t, 'doflow-retrieval-mixed-concurrency-');
  const taskId = 'mixed-concurrency-task';

  const realLog = console.log;
  console.log = () => {};
  let code;
  try {
    code = handleRetrievalPlanCommand({ taskId, action: 'declare', need: ['locate-concept'], stateRoot: root, json: true });
  } finally {
    console.log = realLog;
    process.exitCode = 0;
  }
  assert.equal(code, 0, 'declare must succeed');

  const K = 10;
  const workerScript = (action: any) => `
    const { handleRetrievalPlanCommand } = require(${JSON.stringify(path.resolve(__dirname, '../../src/runtime/retrieval-plan.ts'))});
    const root = ${JSON.stringify(root)};
    const taskId = ${JSON.stringify(taskId)};
    const K = ${K};
    const action = ${JSON.stringify(action)};
    for (let i = 0; i < K; i++) {
      const code = handleRetrievalPlanCommand({
        taskId, action, need: action === 'attempt' ? ['locate-concept'] : [], stateRoot: root, json: true,
        provider: 'native.rg', attemptStatus: 'UNREACHED', reason: 'timeout', note: 'concurrent caller attempt',
      });
      if (code !== 1 && code !== 0) process.exit(2);
    }
    process.exit(0);
  `;

  const child1 = spawn(process.execPath, ['-e', workerScript('attempt')], { stdio: 'ignore' });
  const child2 = spawn(process.execPath, ['-e', workerScript('report')], { stdio: 'ignore' });
  await Promise.all([
    new Promise<void>((resolve, reject) => child1.on('close', (exitCode: any) => (exitCode === 0 ? resolve() : reject(new Error(`child1 exited with ${exitCode}`))))),
    new Promise<void>((resolve, reject) => child2.on('close', (exitCode: any) => (exitCode === 0 ? resolve() : reject(new Error(`child2 exited with ${exitCode}`))))),
  ]);

  const plan = readPlan(root, taskId);
  assert.equal(plan.needs[0].attempts.filter((attempt: any) => attempt.recordedBy === 'caller').length, K, 'all caller attempts must be present');
  assert.equal(plan.revision, 1 + 2 * K, `expected revision ${1 + 2 * K}, got ${plan.revision}`);
});
