'use strict';
// implementation-gate.test.js — which stage needs a READY readiness record, the words every refusal
// uses, `verify`'s readiness check, and the one-release grace for runs started before the record
// existed (and the test that ends it).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createScratch } = require('../helper/scratch-env');
const { WorkflowEngine } = require('../../src/runtime/workflow-engine');
const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator');
const { writeReadinessRecord } = require('../../src/runtime/readiness-record');
const gate = require('../../src/runtime/implementation-gate');

const {
  gatedStage, heldClasses, refusalText, harnessHookNote, verifyReadinessCheck, preFloorGrace, graceWarning,
  READINESS_FLOOR_SINCE, PRE_FLOOR_GRACE_ENDS,
} = gate;

const REPO = path.resolve(__dirname, '..', '..');
const NOW = new Date('2026-10-08T12:00:00.000Z');
const NEXT = 'Next: doflow-run readiness --task-class bug --task-id T-1, then gather what it lists until it reports READY.';

let scratch;
before(() => {
  scratch = createScratch('doflow-implementation-gate-');
  scratch.apply();
});
after(() => {
  scratch.restore();
  scratch.remove();
});

let n = 0;
function dir() {
  n += 1;
  const d = path.join(scratch.dir, `p${n}`);
  fs.mkdirSync(d);
  return d;
}

/** A `bug` run for `taskId` in `root`, positioned at its gated `implementation` stage. */
function bugRun(root, taskId, { floor = true, edit } = {}) {
  const orchestrator = new WorkflowOrchestrator({ repoRoot: REPO, projectRoot: root, stateDir: path.join(root, '.doflow', 'state', 'orchestration') });
  const file = orchestrator.runFile(taskId);
  fs.rmSync(file, { force: true });
  orchestrator.start({ taskId, taskClass: 'bug', now: NOW });
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const node of run.program) {
    if (node.id === 'implementation') break;
    node.status = node.type === 'gate' ? 'approved' : 'completed';
  }
  run.cursor = run.program.findIndex((node) => node.id === 'implementation');
  if (floor) run.readinessFloor = 1;
  else delete run.readinessFloor;
  if (edit) edit(run);
  fs.writeFileSync(file, JSON.stringify(run, null, 2));
  return run;
}

function record(root, taskId, state = 'READY', taskClass = 'bug') {
  writeReadinessRecord({
    stateRoot: root, taskId, mode: 'workflow', inputs: {}, now: new Date(NOW.getTime() - 1000),
    report: { taskClass, templateName: 't', state, stageEntry: { decision: 'ENTER' }, requirements: [], evidenceCount: 1 },
  });
}

test('the held set is read from the shipped registry: every class whose workflow has a gated stage', () => {
  const engine = new WorkflowEngine({ repoRoot: REPO });
  assert.deepEqual(heldClasses(engine), ['feature', 'bug', 'refactor', 'dependency-change', 'trivial-edit']);
  assert.deepEqual(heldClasses(engine, { editTime: true }), ['feature', 'bug', 'refactor', 'dependency-change'],
    'trivial-edit opts out of the edit-time check only');
  assert.deepEqual(gatedStage(engine.resolveWorkflow('trivial-edit').stages), { id: 'implementation', readinessTemplate: 'trivial-edit', editTimeGate: false });
  assert.equal(gatedStage(engine.resolveWorkflow('trivial-edit').stages, { editTime: true }), null);
  assert.equal(gatedStage(engine.resolveWorkflow('research').stages), null);
});

test('the held set follows an injected registry: no class name is written in code', () => {
  const stage = (id, kind, readinessTemplate) => ({ id, skill: 'do-x', kind, readinessTemplate, optional: false, purpose: 'p' });
  const klass = (stages) => ({ name: 'n', description: 'd', readinessNote: 'r', stages, gates: [] });
  const engine = new WorkflowEngine({
    readinessTemplates: false,
    workflows: {
      version: 1,
      stageKinds: { design: { mutatesSource: false, description: 'd' }, build: { mutatesSource: true, description: 'b' } },
      classes: { paper: klass([stage('think', 'design', null)]), novel: klass([stage('think', 'design', null), stage('make', 'build', 'novel-template')]) },
      callers: { 'do-x': { role: 'stage' } },
    },
  });
  assert.deepEqual(heldClasses(engine), ['novel']);
  assert.deepEqual(gatedStage(engine.resolveWorkflow('novel').stages), { id: 'make', readinessTemplate: 'novel-template', editTimeGate: true });
});

test('editTimeGate must be a boolean, and only a stage that mutates source may declare it', () => {
  const shipped = () => JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'workflows.json'), 'utf8'));
  assert.deepEqual(WorkflowEngine.validateRegistry(shipped()), []);

  const notBoolean = shipped();
  notBoolean.classes['trivial-edit'].stages[0].editTimeGate = 'no';
  assert.deepEqual(WorkflowEngine.validateRegistry(notBoolean), ["class 'trivial-edit' stage #1 `editTimeGate` must be a boolean"]);

  const onDesign = shipped();
  const designIndex = onDesign.classes.feature.stages.findIndex((s) => s.kind === 'design');
  onDesign.classes.feature.stages[designIndex].editTimeGate = false;
  assert.deepEqual(WorkflowEngine.validateRegistry(onDesign), [`class 'feature' stage #${designIndex + 1} declares \`editTimeGate\` but does not mutate source`]);
});

test('every refusal text, with and without a slug in the next command', () => {
  const base = { taskId: 'T-1', template: 'bug' };
  const tail = `${NEXT} Nothing was changed.`;
  assert.equal(refusalText('missing', base),
    `doflow gate readiness-before-implementation: task 'T-1' has no readiness record for the 'bug' template. ${tail}`);
  assert.equal(refusalText('not-ready', { ...base, record: { state: 'NEEDS_EVIDENCE', evaluatedAt: '2026-10-08T11:00:00.000Z' } }),
    `doflow gate readiness-before-implementation: task 'T-1' was last evaluated NEEDS_EVIDENCE at 2026-10-08T11:00:00.000Z against the 'bug' template, not READY. ${tail}`);
  assert.equal(refusalText('wrong-template', { ...base, record: { taskClass: 'trivial-edit' } }),
    `doflow gate readiness-before-implementation: task 'T-1' has a READY record for the 'trivial-edit' template, and this stage needs 'bug'. ${tail}`);
  assert.equal(refusalText('unusable', { ...base, detail: 'no state' }),
    `doflow gate readiness-before-implementation: task 'T-1' has a readiness record that cannot be used (no state). ${tail}`);
  assert.equal(refusalText('ambiguous', { ...base, candidates: ['/a/r.json', '/b/r.json'] }),
    "doflow gate readiness-before-implementation: task 'T-1' has records in more than one other checkout (/a/r.json, /b/r.json). "
    + 'Next: run the command from the checkout that holds the one you mean, or run doflow-run readiness --task-class bug --task-id T-1 here. Nothing was changed.');

  assert.equal(refusalText('missing', { taskId: 'A.1', slug: '900-demo', template: 'feature' }),
    "doflow gate readiness-before-implementation: task 'A.1' has no readiness record for the 'feature' template. "
    + 'Next: doflow-run readiness --task-class feature --task-id A.1 --slug=900-demo, then gather what it lists until it reports READY. Nothing was changed.');
  assert.equal(refusalText('missing', { taskId: '900-demo', slug: '900-demo', template: 'feature' }),
    "doflow gate readiness-before-implementation: task '900-demo' has no readiness record for the 'feature' template. "
    + 'Next: doflow-run readiness --task-class feature --task-id 900-demo, then gather what it lists until it reports READY. Nothing was changed.',
    'a slug equal to the task id adds nothing');
});

test('the harness note names the harnesses with and without a hook layer, from harnesses.json', () => {
  assert.equal(harnessHookNote({ repoRoot: REPO }),
    'Edit-time check: claude, codex, gemini, kiro, antigravity run this check before each source edit; '
    + 'opencode, pi, copilot have no hook layer, so this refusal is their first check.');
  assert.equal(harnessHookNote({ repoRoot: dir() }), '', 'an unreadable registry gives no note');
});

test('verify\'s readiness check applies only to an open run whose gated stage is pending', () => {
  const root = dir();
  assert.deepEqual(verifyReadinessCheck({ stateRoot: root, taskId: 'T-1', now: NOW }), { applies: false, reason: 'no-run' });

  bugRun(root, 'T-1', { edit: (run) => { run.state = 'COMPLETED'; } });
  assert.deepEqual(verifyReadinessCheck({ stateRoot: root, taskId: 'T-1', now: NOW }), { applies: false, reason: 'run-finished' });

  bugRun(root, 'T-1', { edit: (run) => { run.program.find((x) => x.id === 'implementation').status = 'completed'; } });
  assert.deepEqual(verifyReadinessCheck({ stateRoot: root, taskId: 'T-1', now: NOW }), { applies: false, reason: 'gated-stage-done' });

  bugRun(root, 'T-1');
  const missing = verifyReadinessCheck({ stateRoot: root, taskId: 'T-1', now: NOW });
  assert.deepEqual(missing, {
    applies: true, runTaskId: 'T-1', stage: 'implementation', template: 'bug', ok: false, code: 'missing', record: null,
    message: refusalText('missing', { taskId: 'T-1', template: 'bug' }),
  });
  assert.equal('grace' in missing, false, 'a run with the marker is not in grace');

  record(root, 'T-1');
  const ready = verifyReadinessCheck({ stateRoot: root, taskId: 'T-1', now: NOW });
  assert.equal(ready.applies, true);
  assert.equal(ready.ok, true);
  assert.equal(ready.code, 'ready');
  assert.equal(ready.message, null);
  assert.deepEqual(ready.record, {
    file: path.join(root, '.doflow', 'state', 'readiness', 'T-1.json'), origin: 'current', state: 'READY', taskClass: 'bug', evaluatedAt: new Date(NOW.getTime() - 1000).toISOString(),
  });
});

test('a run keyed by the feature slug is found when none is keyed by the task id', () => {
  const root = dir();
  bugRun(root, '900-demo');
  assert.deepEqual(verifyReadinessCheck({ stateRoot: root, taskId: 'A.1', now: NOW }), { applies: false, reason: 'no-run' });
  const bySlug = verifyReadinessCheck({ stateRoot: root, taskId: 'A.1', slug: '900-demo', now: NOW });
  assert.equal(bySlug.applies, true);
  assert.equal(bySlug.runTaskId, '900-demo');
  assert.equal(bySlug.code, 'missing');
  assert.equal(bySlug.message, refusalText('missing', { taskId: '900-demo', slug: '900-demo', template: 'bug' }));
});

test('a run started before readiness was recorded is in grace; one with the marker, or no run file, is not', () => {
  assert.equal(preFloorGrace({ startedAt: '2026-10-01T00:00:00.000Z' }), true);
  assert.equal(preFloorGrace({ startedAt: '2026-10-01T00:00:00.000Z', readinessFloor: 1 }), false);
  assert.equal(preFloorGrace({ taskId: 'fresh', taskClass: 'bug' }), false, 'a pseudo-run for a fresh task');
  assert.equal(preFloorGrace(null), false);
});

test('every grace warning text', () => {
  const base = { taskId: 'T-1', template: 'bug', startedAt: '2026-10-01T00:00:00.000Z' };
  const text = (why, action) => `doflow gate readiness-before-implementation: warning: task 'T-1' has no READY readiness record for the 'bug' template (${why}), `
    + `but its run started at 2026-10-01T00:00:00.000Z, before DoFlow ${READINESS_FLOOR_SINCE} recorded readiness, so this ${action} proceeds. `
    + `From DoFlow ${PRE_FLOOR_GRACE_ENDS} it is refused. ${NEXT}`;
  assert.equal(READINESS_FLOOR_SINCE, '1.22.0');
  assert.equal(PRE_FLOOR_GRACE_ENDS, '1.23.0');
  assert.equal(graceWarning('missing', { ...base, action: 'handoff' }), text('no record', 'handoff'));
  assert.equal(graceWarning('not-ready', { ...base, record: { state: 'BLOCKED', evaluatedAt: '2026-10-02T00:00:00.000Z' }, action: 'complete-stage' }),
    text('last evaluated BLOCKED at 2026-10-02T00:00:00.000Z', 'complete-stage'));
  assert.equal(graceWarning('wrong-template', { ...base, record: { taskClass: 'feature' }, action: 'verify report' }),
    text("its READY record is for the 'feature' template", 'verify report'));
  assert.equal(graceWarning('unusable', { ...base, detail: 'version 2, this runtime reads 1', action: 'handoff' }),
    text('its record cannot be used (version 2, this runtime reads 1)', 'handoff'));
  assert.throws(() => graceWarning('ambiguous', { ...base, action: 'handoff' }), /no grace warning/);
});

test('verify keeps a run in grace at its status: not ok, with the warning in place of the refusal', () => {
  const root = dir();
  const run = bugRun(root, 'T-1', { floor: false });
  const check = verifyReadinessCheck({ stateRoot: root, taskId: 'T-1', now: NOW });
  assert.equal(check.applies, true);
  assert.equal(check.ok, false);
  assert.equal(check.grace, true);
  assert.equal(check.code, 'missing');
  assert.equal(check.message, graceWarning('missing', { taskId: 'T-1', template: 'bug', startedAt: run.startedAt, action: 'verify report' }));

  record(root, 'T-1', 'NEEDS_EVIDENCE');
  const notReady = verifyReadinessCheck({ stateRoot: root, taskId: 'T-1', now: NOW });
  assert.equal(notReady.grace, true);
  assert.equal(notReady.code, 'not-ready');
  assert.match(notReady.message, /\(last evaluated NEEDS_EVIDENCE at /);

  bugRun(root, 'T-1');
  assert.equal('grace' in verifyReadinessCheck({ stateRoot: root, taskId: 'T-1', now: NOW }), false);
});

test('the grace ends in 1.23.0: this test fails once the version reaches it while the grace is still exported', () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const parts = (v) => v.split(/[.-]/).slice(0, 3).map(Number);
  const [a, b] = [parts(version), parts(PRE_FLOOR_GRACE_ENDS)];
  const reached = a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];
  assert.ok(!(reached && typeof gate.preFloorGrace === 'function'), 'remove the pre-1.22 run grace (058 DEC-017)');
});
