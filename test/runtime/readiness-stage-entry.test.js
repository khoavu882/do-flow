'use strict';
// readiness-stage-entry.test.js — review R3 (P1): the same readiness state had conflicting
// execution policies. do-implement permitted editing under NEEDS_EVIDENCE and NEEDS_USER_DECISION,
// do-flow stopped before any stage not READY, and readiness_gate.md said gather-or-ask first — so
// which skill you entered the work through decided whether unresolved prerequisites blocked
// editing. The policy now lives in the runtime as stageEntryFor(state, mode), every readiness
// report carries its answer, and the standalone exemption is a declared mode rather than an
// inference from a missing evidence record.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  stageEntryFor, READINESS_STATES, EXECUTION_MODES, STAGE_ENTRY_DECISIONS,
} = require('../../src/runtime/readiness');

const REPO = path.resolve(__dirname, "../..");
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');

test('the policy table: every state maps to one decision per mode, and only these', () => {
  const expected = {
    'READY/workflow': 'ENTER',
    'READY/standalone': 'ENTER',
    'NEEDS_EVIDENCE/workflow': 'GATHER_FIRST',
    'NEEDS_EVIDENCE/standalone': 'ENTER',
    'NEEDS_USER_DECISION/workflow': 'ASK_USER',
    'NEEDS_USER_DECISION/standalone': 'ASK_USER',
    'BLOCKED/workflow': 'STOP',
    'BLOCKED/standalone': 'STOP',
  };
  for (const state of READINESS_STATES) {
    for (const mode of EXECUTION_MODES) {
      const entry = stageEntryFor(state, mode);
      assert.equal(entry.decision, expected[`${state}/${mode}`], `${state} in ${mode} mode`);
      assert.ok(STAGE_ENTRY_DECISIONS.has(entry.decision));
      assert.ok(entry.reason.length > 0, 'every decision carries its reason');
    }
  }
  // The one row that differs between modes is NEEDS_EVIDENCE — an owed user decision and
  // contradicting evidence stop edits in every mode, because neither is cured by the work
  // being small.
  const differing = [...READINESS_STATES].filter(
    (s) => stageEntryFor(s, 'workflow').decision !== stageEntryFor(s, 'standalone').decision,
  );
  assert.deepEqual(differing, ['NEEDS_EVIDENCE']);
});

test('an unknown mode is refused — the standalone exemption is declared, never inferred', () => {
  assert.throws(() => stageEntryFor('READY', 'casual'), /Unknown execution mode 'casual'/);
  assert.throws(() => stageEntryFor('MOSTLY_READY', 'workflow'), /no stage-entry decision/);
});

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-entry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.js'), 'module.exports = 1;\n');
  return dir;
}

function json(cwd, args) {
  const res = spawnSync('node', [DOFLOW, ...args, '--json'], {
    cwd, env: { ...process.env, HOME: cwd }, encoding: 'utf8',
  });
  return { ...res, data: res.stdout ? JSON.parse(res.stdout) : null };
}

test('the CLI seam: the same unmet contract answers GATHER_FIRST to a workflow and ENTER to a declared one-off', (t) => {
  const cwd = project(t);
  const base = ['readiness', '--task-id', 'entry-task', '--task-class', 'trivial-edit'];

  const workflow = json(cwd, base);
  assert.equal(workflow.data.state, 'NEEDS_EVIDENCE');
  assert.equal(workflow.data.executionMode, 'workflow', 'the default mode fails closed');
  assert.equal(workflow.data.stageEntry.decision, 'GATHER_FIRST');

  const standalone = json(cwd, [...base, '--mode', 'standalone']);
  assert.equal(standalone.data.state, 'NEEDS_EVIDENCE', 'the state itself does not change with mode');
  assert.equal(standalone.data.executionMode, 'standalone');
  assert.equal(standalone.data.stageEntry.decision, 'ENTER');
  assert.match(standalone.data.stageEntry.reason, /reported, not enforced/);
});

test('the CLI seam: an owed user decision answers ASK_USER in both modes', (t) => {
  const cwd = project(t);
  for (const modeArgs of [[], ['--mode', 'standalone']]) {
    const res = json(cwd, ['readiness', '--task-id', 'entry-ask', '--task-class', 'trivial-edit',
      '--user-decision-pending', ...modeArgs]);
    assert.equal(res.data.state, 'NEEDS_USER_DECISION');
    assert.equal(res.data.stageEntry.decision, 'ASK_USER');
  }
});

test('the CLI seam: an invalid --mode is a usage error, not a silent default', (t) => {
  const cwd = project(t);
  const res = json(cwd, ['readiness', '--task-id', 'entry-bad', '--task-class', 'trivial-edit', '--mode', 'yolo']);
  assert.equal(res.status, 2);
  assert.equal(res.data.ok, false);
  assert.match(res.data.summary, /Unknown execution mode 'yolo'/);
});
