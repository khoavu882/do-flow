'use strict';
// runtime-outcome.test.js — the task's terminal record and the closed vocabulary it draws from
// (feature 011, plan task B.2, design component C2; FR-011, NFR-001).
//
// Mostly a subprocess suite, for the reason runtime-retrieval-plan.test.js gives: the contract this
// verb ships is exit codes and a record on disk, and a library call proves neither. The two
// in-process assertions are the ones a subprocess cannot make — the exported vocabulary itself, and
// the record path a task id resolves to.
//
// The one property worth stating up front, because three separate tests exist to hold it: this verb
// never re-evaluates readiness and never re-runs verification. It records what a run states it saw,
// validated against the vocabulary the owning module exports, and it measures only the two things
// it can measure without executing anything — how many records the ledger holds, and which declared
// retrieval needs went unreached.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const DISPATCHER = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');

const { OUTCOME_STATES, NOT_RECORDED, outcomePath } = require('../../src/runtime/outcome');

/** A scratch project root. Nothing here needs git — the outcome record stamps no commit. */
function project(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `doflow-outcome-${label}-`));
  const real = fs.realpathSync(dir);
  fs.writeFileSync(path.join(real, 'a.js'), 'module.exports = { x: 1 };\n');
  return real;
}

function run(cwd, args) {
  const res = spawnSync('node', [DOFLOW, ...args], {
    cwd, env: { ...process.env, HOME: cwd }, encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function json(cwd, args) {
  const res = run(cwd, [...args, '--json']);
  try {
    return { ...res, data: JSON.parse(res.stdout) };
  } catch {
    throw new Error(`expected JSON on stdout for '${args.join(' ')}':\n${res.stdout}\n${res.stderr}`);
  }
}

/** Records one evidence item, so a task has a basis for anything but INCONCLUSIVE. */
function addEvidence(cwd, taskId, locator) {
  const written = json(cwd, ['evidence', '--task-id', taskId, '--action', 'add',
    '--kind', 'historical', '--provenance', 'extracted',
    '--provider', 'git.native', '--capability', 'history.search', '--locator', locator]);
  assert.equal(written.status, 0, written.stderr);
  return written.data;
}

function readRecord(cwd, taskId) {
  return JSON.parse(fs.readFileSync(outcomePath(cwd, taskId), 'utf8'));
}

// ── the closed vocabulary (design §4) ────────────────────────────────────────────────────────

test('the terminal vocabulary is exactly four states, and none of them is a number (FR-011)', () => {
  assert.deepEqual(OUTCOME_STATES, ['COMPLETED', 'BLOCKED', 'ABANDONED', 'INCONCLUSIVE']);
  for (const state of OUTCOME_STATES) {
    assert.equal(typeof state, 'string');
    assert.ok(!/\d/.test(state), `${state} must not carry a number — NFR-001 is about the state itself`);
  }
  assert.equal(NOT_RECORDED, 'NOT_RECORDED',
    'an unstated basis needs its own token: absent and READY must never read the same way');
});

test('a state outside the vocabulary is refused, naming the valid set', () => {
  const cwd = project('vocab');
  const res = run(cwd, ['outcome', '--task-id', 'v1', '--action', 'record',
    '--task-class', 'bug', '--state', 'DONE']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown --state 'DONE'/);
  assert.match(res.stderr, /Valid: COMPLETED, BLOCKED, ABANDONED, INCONCLUSIVE/);
  assert.ok(!fs.existsSync(outcomePath(cwd, 'v1')), 'a refused state must write nothing');

  const missing = run(cwd, ['outcome', '--task-id', 'v1', '--action', 'record', '--task-class', 'bug']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /needs --state <state>/);

  const badAction = run(cwd, ['outcome', '--task-id', 'v1', '--action', 'nonsense']);
  assert.equal(badAction.status, 2);
  assert.match(badAction.stderr, /Valid: record, show/);
});

// ── the record shape (design §5) ─────────────────────────────────────────────────────────────

test('a recorded outcome carries the design shape, and recordedAt is stamped by the runtime', () => {
  const cwd = project('shape');
  addEvidence(cwd, 's1', 'a.js:1');
  const before = Date.now();
  const rec = json(cwd, ['outcome', '--task-id', 's1', '--action', 'record', '--task-class', 'bug',
    '--state', 'COMPLETED', '--readiness', 'READY', '--verification', 'PASS']);
  assert.equal(rec.status, 0, rec.stderr);

  const record = readRecord(cwd, 's1');
  assert.equal(record.taskId, 's1');
  assert.equal(record.state, 'COMPLETED');
  assert.deepEqual(Object.keys(record.basis).sort(), ['evidenceCount', 'readiness', 'unreached', 'verification']);
  assert.equal(record.basis.readiness, 'READY');
  assert.equal(record.basis.verification, 'PASS');
  assert.ok(typeof record.writtenByStage === 'string' && record.writtenByStage.length > 0);

  const stamped = Date.parse(record.recordedAt);
  assert.ok(Number.isFinite(stamped), 'recordedAt must be a parseable instant');
  assert.ok(stamped >= before - 1000 && stamped <= Date.now() + 1000,
    'recordedAt must be the moment of the write, not a value carried in from anywhere else');

  // The other half of "never accepted from the caller": there is no surface through which one
  // could arrive. A timestamp flag is not merely ignored — it is not a flag.
  const supplied = run(cwd, ['outcome', '--task-id', 's1', '--action', 'record', '--task-class', 'bug',
    '--state', 'COMPLETED', '--recorded-at', '1999-01-01T00:00:00.000Z']);
  assert.notEqual(supplied.status, 0);
  assert.match(supplied.stderr, /unknown flag '--recorded-at'/);
  assert.equal(readRecord(cwd, 's1').recordedAt, record.recordedAt,
    'the refused run must not have rewritten the record on its way to the refusal');
});

test('evidenceCount is a count of records, not a score (NFR-001)', () => {
  const cwd = project('count');
  addEvidence(cwd, 'c1', 'a.js:1');
  addEvidence(cwd, 'c1', 'a.js:2');
  const rec = json(cwd, ['outcome', '--task-id', 'c1', '--action', 'record', '--task-class', 'bug',
    '--state', 'COMPLETED']);
  assert.equal(rec.data.basis.evidenceCount, 2);

  const record = readRecord(cwd, 'c1');
  const numbers = Object.entries(record.basis).filter(([, v]) => typeof v === 'number').map(([k]) => k);
  assert.deepEqual(numbers, ['evidenceCount'],
    'evidenceCount is the only integer the basis may hold: every other field is a discrete state, '
    + 'because a number invites arithmetic across things never measured on one scale');
  assert.equal(typeof record.state, 'string');
});

// ── INCONCLUSIVE carries verification's meaning ──────────────────────────────────────────────

test('COMPLETED is refused over an empty ledger, naming INCONCLUSIVE (design §4)', () => {
  const cwd = project('inconclusive');
  const refused = run(cwd, ['outcome', '--task-id', 'i1', '--action', 'record', '--task-class', 'bug',
    '--state', 'COMPLETED']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /holds no records/);
  assert.match(refused.stderr, /INCONCLUSIVE is the state that describes a verdict over zero evidence/);
  assert.ok(!fs.existsSync(outcomePath(cwd, 'i1')), 'the refusal must not leave a record behind');

  // The state that does describe it is available over the same empty ledger.
  const recorded = json(cwd, ['outcome', '--task-id', 'i1', '--action', 'record', '--task-class', 'bug',
    '--state', 'INCONCLUSIVE']);
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(recorded.data.state, 'INCONCLUSIVE');
  assert.equal(recorded.data.basis.evidenceCount, 0);
});

// ── the terminal stage is learned, never decided here (design A1) ─────────────────────────────

test('writtenByStage is the workflow engine\'s terminal stage for the class (A1)', () => {
  const cwd = project('terminal');
  const workflow = json(cwd, ['workflow', '--task-class', 'refactor']);
  const terminal = workflow.data.terminalStage.id;

  addEvidence(cwd, 't1', 'a.js:1');
  const rec = json(cwd, ['outcome', '--task-id', 't1', '--action', 'record', '--task-class', 'refactor',
    '--state', 'COMPLETED']);
  assert.equal(rec.data.writtenByStage, terminal,
    'the writer is read from the workflow, so a class whose stages change keeps a correct record '
    + 'without this module knowing anything about that class');

  const nonTerminal = workflow.data.stageIds.find((id) => id !== terminal);
  const refused = run(cwd, ['outcome', '--task-id', 't1', '--action', 'record', '--task-class', 'refactor',
    '--state', 'COMPLETED', '--stage', nonTerminal]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, new RegExp(`stage '${nonTerminal}' is not the terminal stage`));
  assert.match(refused.stderr, new RegExp(`'${terminal}' is`));
});

test('recording without a class is refused, and an unknown class names the valid set', () => {
  const cwd = project('class');
  addEvidence(cwd, 'k1', 'a.js:1');
  const noClass = run(cwd, ['outcome', '--task-id', 'k1', '--action', 'record', '--state', 'COMPLETED']);
  assert.equal(noClass.status, 2);
  assert.match(noClass.stderr, /--task-class is required/);

  const badClass = run(cwd, ['outcome', '--task-id', 'k1', '--action', 'record',
    '--task-class', 'not-a-class', '--state', 'COMPLETED']);
  assert.equal(badClass.status, 2);
  assert.match(badClass.stderr, /Unknown task class 'not-a-class'/);
  assert.match(badClass.stderr, /Valid classes: /);
});

// ── the basis is read, never re-derived ──────────────────────────────────────────────────────

test('a basis verdict outside its owning vocabulary is refused, and an omitted one is NOT_RECORDED', () => {
  const cwd = project('basis');
  addEvidence(cwd, 'b1', 'a.js:1');

  const badReadiness = run(cwd, ['outcome', '--task-id', 'b1', '--action', 'record', '--task-class', 'bug',
    '--state', 'COMPLETED', '--readiness', 'ALMOST']);
  assert.equal(badReadiness.status, 2);
  assert.match(badReadiness.stderr, /unknown --readiness 'ALMOST'/);
  assert.match(badReadiness.stderr, /READY/, 'the refusal names readiness\'s own vocabulary');

  const badVerification = run(cwd, ['outcome', '--task-id', 'b1', '--action', 'record', '--task-class', 'bug',
    '--state', 'COMPLETED', '--verification', 'GREEN']);
  assert.equal(badVerification.status, 2);
  assert.match(badVerification.stderr, /unknown --verification 'GREEN'/);
  assert.match(badVerification.stderr, /PASS, FAIL, INCONCLUSIVE/);

  const rec = json(cwd, ['outcome', '--task-id', 'b1', '--action', 'record', '--task-class', 'bug',
    '--state', 'BLOCKED']);
  assert.equal(rec.data.basis.readiness, NOT_RECORDED);
  assert.equal(rec.data.basis.verification, NOT_RECORDED);
  assert.deepEqual(rec.data.statedByCaller, [],
    'a record must say which half of its basis rests on someone saying so');

  const stated = json(cwd, ['outcome', '--task-id', 'b1', '--action', 'record', '--task-class', 'bug',
    '--state', 'BLOCKED', '--readiness', 'NEEDS_EVIDENCE']);
  assert.deepEqual(stated.data.statedByCaller, ['readiness']);
});

test('unreached items are carried forward from retrieval and from verification', () => {
  const cwd = project('unreached');
  json(cwd, ['retrieval-plan', '--task-id', 'u1', '--action', 'declare',
    '--need', 'inspect-history,locate-known-symbol', '--stage', 'do-design']);
  addEvidence(cwd, 'u1', 'a.js:1');
  // Report links the git-sourced evidence to `inspect-history`; the other need is never asked.
  const report = json(cwd, ['retrieval-plan', '--task-id', 'u1', '--need', 'inspect-history']);
  assert.deepEqual(report.data.unreached, ['locate-known-symbol']);

  const rec = json(cwd, ['outcome', '--task-id', 'u1', '--action', 'record', '--task-class', 'bug',
    '--state', 'BLOCKED', '--verification', 'PASS']);
  assert.ok(rec.data.basis.unreached.includes('retrieval:locate-known-symbol'),
    'a declared lookup that never ran must survive into the terminal record, not vanish with the plan');
  assert.ok(!rec.data.basis.unreached.some((i) => i.startsWith('verification:')),
    'a stated PASS is a verdict that was reached, so verification contributes no gap here');

  // Verification's own half: nothing stated is a gap, and so is a verdict over zero evidence.
  const unstated = json(cwd, ['outcome', '--task-id', 'u1', '--action', 'record', '--task-class', 'bug',
    '--state', 'BLOCKED']);
  assert.ok(unstated.data.basis.unreached.some((i) => i.startsWith('verification:NOT_RECORDED')));

  const text = run(cwd, ['outcome', '--task-id', 'u1']);
  assert.match(text.stdout, /Declared and never reached:/,
    'NFR-004: what nothing reached is stated as prominently as what was decided');
});

// ── show ─────────────────────────────────────────────────────────────────────────────────────

test('show exits 1 when no outcome exists, and 0 for a recorded one whatever the state', () => {
  const cwd = project('show');
  const none = json(cwd, ['outcome', '--task-id', 'w1']);
  assert.equal(none.status, 1, 'a task whose end nobody stated is not a completed task');
  assert.equal(none.data.state, null);

  const text = run(cwd, ['outcome', '--task-id', 'w1']);
  assert.match(text.stdout, /No outcome is recorded for this task/);

  json(cwd, ['outcome', '--task-id', 'w1', '--action', 'record', '--task-class', 'bug', '--state', 'BLOCKED']);
  const shown = json(cwd, ['outcome', '--task-id', 'w1']);
  assert.equal(shown.status, 0,
    'exit 1 means "no outcome was recorded" and nothing else — a recorded BLOCKED answered the '
    + 'question, and overloading the code would make the two indistinguishable');
  assert.equal(shown.data.state, 'BLOCKED');

  // `--action status` is the CLI's shared default and must not read as a usage error here.
  const aliased = json(cwd, ['outcome', '--task-id', 'w1', '--action', 'status']);
  assert.equal(aliased.status, 0);
  assert.equal(aliased.data.state, 'BLOCKED');
});

// ── the refusals every state-writing verb shares ─────────────────────────────────────────────

test('a task id can never name a path (the evidence ledger rule, unchanged)', () => {
  const cwd = project('safe-id');
  const res = run(cwd, ['outcome', '--task-id', '../../etc/passwd', '--action', 'record',
    '--task-class', 'bug', '--state', 'BLOCKED']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Invalid task id/);
  assert.ok(!fs.existsSync(path.join(cwd, '.doflow', 'state', 'outcome')),
    'a refused id must not have created the state directory on its way to the refusal');
});

test('a score-shaped flag is refused by name (NFR-001)', () => {
  const cwd = project('no-scores');
  const refused = run(cwd, ['outcome', '--task-id', 'n1', '--confidence', '0.9']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /'--confidence' is a retrieval score/);
});

// ── the seam ─────────────────────────────────────────────────────────────────────────────────

test('the verb dispatches through the shell seam, not only through the entrypoint', () => {
  const cwd = project('dispatch');
  const show = spawnSync('bash', [DISPATCHER, 'outcome', '--task-id', 'p1', '--json'], {
    cwd, env: { ...process.env, HOME: cwd }, encoding: 'utf8',
  });
  assert.equal(show.status, 1, 'the verb exit code is the dispatcher exit code');
  assert.equal(JSON.parse(show.stdout).state, null);

  const record = spawnSync('bash', [DISPATCHER, 'outcome', '--task-id', 'p1', '--action', 'record',
    '--task-class', 'bug', '--state', 'ABANDONED', '--json'], {
    cwd, env: { ...process.env, HOME: cwd }, encoding: 'utf8',
  });
  assert.equal(record.status, 0, record.stderr);
  assert.equal(JSON.parse(record.stdout).state, 'ABANDONED');
});

test('the dispatcher help lists the verb it now dispatches', () => {
  const help = spawnSync('bash', [DISPATCHER, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^ {2}outcome {2,}\S/m,
    'G12 reads this list as the only verb inventory a user ever sees');
});
