'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { tempDir } = require('../helper/tmp');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');

const health = require('../../src/runtime/health.ts');
const realProbeFreshness = health.probeFreshness;

let cannedProbe = null;

health.probeFreshness = function spyProbeFreshness(providerId, options) {
  if (cannedProbe === null) return realProbeFreshness(providerId, options);
  return typeof cannedProbe === 'function' ? cannedProbe(providerId) : cannedProbe;
};

const {
  handleRetrievalPlanCommand,
} = require('../../src/runtime/retrieval-plan.ts');
const { readPlan } = require('../../src/runtime/retrieval-record.ts');

function callVerb(options) {
  const lines = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  let code;
  try {
    code = handleRetrievalPlanCommand(options);
  } finally {
    console.log = realLog;
    console.error = realError;
    process.exitCode = 0;
  }
  return { code, out: lines.join('\n') };
}

function declareFixturePlan(root, taskId = 'task-attempt-1', need = ['locate-concept']) {
  const res = callVerb({
    taskId,
    action: 'declare',
    need,
    stateRoot: root,
    json: true,
  });
  assert.equal(res.code, 0, `declare must exit 0: ${res.out}`);
  return readPlan(root, taskId);
}

test('--status RETRIEVED exits 2 with refusal message (IC-012)', (t) => {
  const root = tempDir(t, 'doflow-attempt-retrieved-');
  const taskId = 't-retrieved';
  declareFixturePlan(root, taskId);

  const res = callVerb({
    taskId,
    action: 'attempt',
    need: 'locate-concept',
    provider: 'semble.search',
    attemptStatus: 'RETRIEVED',
    reason: 'provider-unavailable',
    stateRoot: root,
  });

  assert.equal(res.code, 2, 'RETRIEVED must exit 2');
  assert.match(
    res.out,
    /RETRIEVED is never recorded by hand: it is derived from evidence bound to the need\. Record what was found with: doflow evidence --task-id t-retrieved --action add --need locate-concept \.\.\./,
  );
});

test('--status UNAVAILABLE exits 2 with unknown status message (IC-012)', (t) => {
  const root = tempDir(t, 'doflow-attempt-unavailable-');
  const taskId = 't-unavailable';
  declareFixturePlan(root, taskId);

  const res = callVerb({
    taskId,
    action: 'attempt',
    need: 'locate-concept',
    provider: 'semble.search',
    attemptStatus: 'UNAVAILABLE',
    reason: 'provider-unavailable',
    stateRoot: root,
  });

  assert.equal(res.code, 2, 'UNAVAILABLE must exit 2');
  assert.match(
    res.out,
    /unknown --status 'UNAVAILABLE'\. Valid here: EMPTY, UNREACHED, UNVERIFIED\. A provider that could not be asked is UNREACHED with --reason provider-unavailable or policy-bypass\./,
  );
});

test('missing reason exits 2 with reason requirement message (IC-012)', (t) => {
  const root = tempDir(t, 'doflow-attempt-missing-reason-');
  const taskId = 't-missing-reason';
  declareFixturePlan(root, taskId);

  const res = callVerb({
    taskId,
    action: 'attempt',
    need: 'locate-concept',
    provider: 'semble.search',
    attemptStatus: 'UNREACHED',
    stateRoot: root,
  });

  assert.equal(res.code, 2, 'missing reason must exit 2');
  assert.match(
    res.out,
    /--status UNREACHED needs --reason <code>: a lookup that returned no locator must say why\. Codes: provider-unavailable, policy-bypass, provider-error, timeout, empty-answer, index-stale, index-unverifiable\./,
  );
});

test('unregistered provider exits 2 with registered list message (IC-012)', (t) => {
  const root = tempDir(t, 'doflow-attempt-unreg-provider-');
  const taskId = 't-unreg-provider';
  declareFixturePlan(root, taskId);

  const res = callVerb({
    taskId,
    action: 'attempt',
    need: 'locate-concept',
    provider: 'unregistered.custom-engine',
    attemptStatus: 'UNREACHED',
    reason: 'provider-unavailable',
    stateRoot: root,
  });

  assert.equal(res.code, 2, 'unregistered provider must exit 2');
  assert.match(
    res.out,
    /provider 'unregistered\.custom-engine' is not registered under capability 'code\.semantic-search' \(need 'locate-concept'\)\. Registered: .*\. A fallback is another provider of the same capability, for example native\.rg\./,
  );
});

test('EMPTY on an UNKNOWN index stores UNVERIFIED with index-unverifiable (IC-012, IC-013)', (t) => {
  const root = tempDir(t, 'doflow-attempt-unknown-index-');
  const taskId = 't-unknown-index';
  declareFixturePlan(root, taskId);

  cannedProbe = { state: 'UNKNOWN', artifact: null, refresh: null, label: null, reason: 'unlocatable' };
  t.after(() => { cannedProbe = null; });

  const res = callVerb({
    taskId,
    action: 'attempt',
    need: 'locate-concept',
    provider: 'semble.search',
    attemptStatus: 'EMPTY',
    reason: 'empty-answer',
    stateRoot: root,
    json: true,
  });

  assert.equal(res.code, 0, `attempt must exit 0: ${res.out}`);
  const plan = readPlan(root, taskId);
  assert.ok(plan, 'plan exists');
  const attempts = plan.needs[0].attempts;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, 'UNVERIFIED', 'EMPTY on UNKNOWN index must map to UNVERIFIED');
  assert.equal(attempts[0].reason, 'index-unverifiable', 'reason must be updated to index-unverifiable');
  assert.equal(attempts[0].indexState, 'UNKNOWN');
});

test('attempt 1 semble.search UNREACHED provider-unavailable is recorded with role primary (IC-013)', (t) => {
  const root = tempDir(t, 'doflow-attempt-primary-');
  const taskId = 't-primary';
  declareFixturePlan(root, taskId);

  const res = callVerb({
    taskId,
    action: 'attempt',
    need: 'locate-concept',
    provider: 'semble.search',
    attemptStatus: 'UNREACHED',
    reason: 'provider-unavailable',
    stateRoot: root,
    json: true,
  });

  assert.equal(res.code, 0, `attempt must exit 0: ${res.out}`);
  const plan = readPlan(root, taskId);
  const need = plan.needs[0];
  assert.ok(Array.isArray(need.attempts), 'attempts is array');
  assert.equal(need.attempts.length, 1);
  const att = need.attempts[0];
  assert.equal(att.n, 1);
  assert.equal(att.provider, 'semble.search');
  assert.equal(att.capability, 'code.semantic-search');
  assert.equal(att.role, 'primary', 'role must be primary when provider matches declared provider');
  assert.equal(att.status, 'UNREACHED');
  assert.equal(att.reason, 'provider-unavailable');
  assert.equal(att.recordedBy, 'caller');
  assert.deepEqual(att.evidenceIds, []);
  assert.ok(att.recordedAt);
});

test('the declared fields deep-equal their declare-time values after attempt (DEC-002, FR-007, IC-013)', (t) => {
  const root = tempDir(t, 'doflow-attempt-deep-equal-');
  const taskId = 't-deep-equal';
  const declaredPlan = declareFixturePlan(root, taskId);
  const declaredNeed = declaredPlan.needs[0];

  // Record fallback attempt with native.rg
  const res = callVerb({
    taskId,
    action: 'attempt',
    need: 'locate-concept',
    provider: 'native.rg',
    attemptStatus: 'UNREACHED',
    reason: 'provider-unavailable',
    stateRoot: root,
    json: true,
  });
  assert.equal(res.code, 0, `attempt must exit 0: ${res.out}`);

  const currentPlan = readPlan(root, taskId);
  const currentNeed = currentPlan.needs[0];

  assert.equal(currentNeed.provider, declaredNeed.provider, 'declared need.provider must not be overwritten');
  assert.equal(currentNeed.capability, declaredNeed.capability);
  assert.equal(currentNeed.intent, declaredNeed.intent);
  assert.equal(currentNeed.queryRef, declaredNeed.queryRef);
  assert.equal(currentNeed.result, declaredNeed.result);

  const { attempts: _attCurrent, ...declaredCurrent } = currentNeed;
  const { attempts: _attDeclared, ...declaredOriginal } = declaredNeed;
  assert.deepEqual(declaredCurrent, declaredOriginal, 'declared fields must deep-equal declare-time values');

  // Verify the attempt role is fallback
  assert.equal(currentNeed.attempts[0].role, 'fallback', 'attempt with native.rg must have role fallback');
});

test('flags reach the handler through bin/doflow.js (IC-021)', (t) => {
  const root = tempDir(t, 'doflow-attempt-bin-');
  const taskId = 't-bin-flags';

  // Declare plan via bin/doflow.js
  const declareRes = spawnSync(process.execPath, [
    DOFLOW, 'retrieval-plan',
    '--task-id', taskId,
    '--action', 'declare',
    '--need', 'locate-concept',
    '--json',
  ], { cwd: root, env: { ...process.env, HOME: root }, encoding: 'utf8' });
  assert.equal(declareRes.status, 0, `declare failed: ${declareRes.stderr}`);

  // Attempt via bin/doflow.js passing --status, --provider, --reason, --note
  const attemptRes = spawnSync(process.execPath, [
    DOFLOW, 'retrieval-plan',
    '--task-id', taskId,
    '--action', 'attempt',
    '--need', 'locate-concept',
    '--provider', 'semble.search',
    '--status', 'UNREACHED',
    '--reason', 'provider-unavailable',
    '--note', 'verified reaching handler',
    '--json',
  ], { cwd: root, env: { ...process.env, HOME: root }, encoding: 'utf8' });

  assert.equal(attemptRes.status, 0, `attempt failed: ${attemptRes.stderr}\n${attemptRes.stdout}`);
  const payload = JSON.parse(attemptRes.stdout);
  assert.equal(payload.action, 'attempt');
  assert.equal(payload.attempt.status, 'UNREACHED');
  assert.equal(payload.attempt.provider, 'semble.search');
  assert.equal(payload.attempt.reason, 'provider-unavailable');
  assert.equal(payload.attempt.note, 'verified reaching handler');

  const diskPlan = readPlan(root, taskId);
  assert.ok(diskPlan);
  const diskAttempt = diskPlan.needs[0].attempts[0];
  assert.equal(diskAttempt.status, 'UNREACHED');
  assert.equal(diskAttempt.provider, 'semble.search');
  assert.equal(diskAttempt.reason, 'provider-unavailable');
  assert.equal(diskAttempt.note, 'verified reaching handler');
});

test('two child processes appending attempts lose none (IC-020, DEC-012, NFR-004)', async (t) => {
  const root = tempDir(t, 'doflow-attempt-concurrency-');
  const taskId = 't-concurrent-attempts';

  declareFixturePlan(root, taskId);

  const K = 10;
  const workerScript = `
    const { handleRetrievalPlanCommand } = require(${JSON.stringify(path.resolve(__dirname, '../../src/runtime/retrieval-plan.ts'))});
    const root = ${JSON.stringify(root)};
    const taskId = ${JSON.stringify(taskId)};
    const K = ${K};
    for (let i = 0; i < K; i++) {
      const code = handleRetrievalPlanCommand({
        taskId,
        action: 'attempt',
        need: 'locate-concept',
        provider: 'native.rg',
        attemptStatus: 'UNREACHED',
        reason: 'timeout',
        note: 'worker child attempt ' + i,
        stateRoot: root,
        json: true,
      });
      if (code !== 0) {
        process.exit(2);
      }
    }
    process.exit(0);
  `;

  const child1 = spawn(process.execPath, ['-e', workerScript], { stdio: 'ignore' });
  const child2 = spawn(process.execPath, ['-e', workerScript], { stdio: 'ignore' });

  await Promise.all([
    new Promise((resolve, reject) => {
      child1.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`child1 exited with ${code}`))));
    }),
    new Promise((resolve, reject) => {
      child2.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`child2 exited with ${code}`))));
    }),
  ]);

  const plan = readPlan(root, taskId);
  assert.ok(plan, 'plan exists');
  const attempts = plan.needs[0].attempts;
  assert.equal(attempts.length, 2 * K, `expected ${2 * K} attempts, got ${attempts.length}`);

  const ns = attempts.map((a) => a.n).sort((a, b) => a - b);
  const expectedNs = Array.from({ length: 2 * K }, (_, i) => i + 1);
  assert.deepEqual(ns, expectedNs, 'attempt numbers must be exactly 1..2K without gaps or duplicates');
  assert.equal(plan.revision, 2 * K + 1, `revision must be monotonically bumped to ${2 * K + 1}`);
});

test('IC-012 refusal edge cases: unknown reason code, note > 160, multiple needs', (t) => {
  const root = tempDir(t, 'doflow-attempt-refusals-');
  const taskId = 't-refusals';
  declareFixturePlan(root, taskId);

  // 1. Unknown reason code
  const unknownReason = callVerb({
    taskId,
    action: 'attempt',
    need: 'locate-concept',
    provider: 'semble.search',
    attemptStatus: 'UNREACHED',
    reason: 'not-a-valid-reason',
    stateRoot: root,
  });
  assert.equal(unknownReason.code, 2);
  assert.match(unknownReason.out, /unknown --reason 'not-a-valid-reason'\. Codes:/);

  // 2. Note longer than 160 characters
  const longNote = 'a'.repeat(161);
  const noteRes = callVerb({
    taskId,
    action: 'attempt',
    need: 'locate-concept',
    provider: 'semble.search',
    attemptStatus: 'UNREACHED',
    reason: 'provider-unavailable',
    note: longNote,
    stateRoot: root,
  });
  assert.equal(noteRes.code, 2);
  assert.match(noteRes.out, /--note is at most 160 characters \(got 161\):/);

  // 3. Multiple needs on attempt
  const multiNeed = callVerb({
    taskId,
    action: 'attempt',
    need: ['locate-concept', 'other-need'],
    provider: 'semble.search',
    attemptStatus: 'UNREACHED',
    reason: 'provider-unavailable',
    stateRoot: root,
  });
  assert.equal(multiNeed.code, 2);
  assert.match(multiNeed.out, /--need takes one intent on retrieval-plan --action attempt, got 2\. Record one write per need\./);

  // 4. Missing need
  const noNeed = callVerb({
    taskId,
    action: 'attempt',
    provider: 'semble.search',
    attemptStatus: 'UNREACHED',
    reason: 'provider-unavailable',
    stateRoot: root,
  });
  assert.equal(noNeed.code, 2);
  assert.match(noNeed.out, /--need takes one intent on retrieval-plan --action attempt, got 0\. Record one write per need\./);
});
