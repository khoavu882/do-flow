'use strict';
// task-state-concurrency.test.js — review R4 (P2): shared evidence and claims could lose writes.
// The review reproduced it exactly as the first test below does: two ledger instances loaded the
// same empty task, each added a distinct observation, each saved; both writes reported success and
// the final ledger held one observation. Persistence now goes through task-state.js — a per-file
// lock around read-merge-write, a monotonic revision, atomic rename, and schema-version
// validation — so overlapping writers append rather than overwrite each other.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger');
const { ClaimsManager } = require('../../src/runtime/claims');
const { readTaskState, SCHEMA_VERSION } = require('../../src/runtime/task-state');

function stateRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-taskstate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("R4 reproduction: two overlapping evidence writers both survive — the review's lost write", (t) => {
  const root = stateRoot(t);
  const task = 'overlap';

  // Two sessions: both load the same (empty) task BEFORE either saves.
  const a = new EvidenceLedger({ repoRoot: root });
  const b = new EvidenceLedger({ repoRoot: root });
  a.load(task);
  b.load(task);
  a.addEvidence({ taskId: task, kind: 'exact-search', content: 'observation A', locator: { file: 'a.js' } });
  b.addEvidence({ taskId: task, kind: 'structural', content: 'observation B', locator: { file: 'b.js' } });
  const file = a.save(task);
  b.save(task);

  const final = new EvidenceLedger({ repoRoot: root });
  assert.equal(final.load(task), 2, 'both observations must survive both saves');
  const contents = final.getAllEvidence().map((e) => e.content).sort();
  assert.deepEqual(contents, ['observation A', 'observation B']);

  const payload = readTaskState(fs, file);
  assert.equal(payload.version, SCHEMA_VERSION);
  assert.equal(payload.revision, 2, 'each completed write bumps the revision, so the overlap is visible');
  assert.equal(payload.evidenceCount, 2);
});

test('R4: two overlapping claims writers both survive; a shared id keeps the saving instance\'s version', (t) => {
  const root = stateRoot(t);
  const task = 'overlap-claims';

  const first = new ClaimsManager({ repoRoot: root });
  first.addClaim({ id: 'claim_shared', taskId: task, statement: 'shared, original' });
  first.save(task);

  const a = new ClaimsManager({ repoRoot: root });
  const b = new ClaimsManager({ repoRoot: root });
  a.load(task);
  b.load(task);
  a.addClaim({ id: 'claim_a', taskId: task, statement: 'from writer A' });
  b.addClaim({ id: 'claim_b', taskId: task, statement: 'from writer B' });
  b.getClaim('claim_shared').statement = 'shared, updated by B';
  a.save(task);
  b.save(task);

  const final = new ClaimsManager({ repoRoot: root });
  assert.equal(final.load(task), 3);
  assert.equal(final.getClaim('claim_a').statement, 'from writer A');
  assert.equal(final.getClaim('claim_b').statement, 'from writer B');
  assert.equal(final.getClaim('claim_shared').statement, 'shared, updated by B',
    'for an id both writers hold, the later save wins — its view was re-evaluated most recently');
});

test('R4: a file from a future schema version is refused by name, not guessed at', (t) => {
  const root = stateRoot(t);
  const dir = path.join(root, '.doflow', 'state', 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'future.json'), JSON.stringify({ version: 99, evidence: [] }));
  const ledger = new EvidenceLedger({ repoRoot: root });
  assert.throws(() => ledger.load('future'), /schema version 99.*reads version 1/s);
});

test('R4: a torn state file is an error naming the file and the recovery, never silent data loss', (t) => {
  const root = stateRoot(t);
  const dir = path.join(root, '.doflow', 'state', 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'torn.json'), '{"version": 1, "evidence": [');
  const ledger = new EvidenceLedger({ repoRoot: root });
  assert.throws(() => ledger.load('torn'), /Failed to load state file.*torn\.json/);
});

test('R4: an interrupted writer leaves the previous state intact plus an ignorable tmp file', (t) => {
  const root = stateRoot(t);
  const task = 'interrupted';
  const ledger = new EvidenceLedger({ repoRoot: root });
  ledger.addEvidence({ taskId: task, kind: 'exact-search', content: 'the durable item' });
  const file = ledger.save(task);
  // A crashed writer's leftovers: a tmp file beside the state file. Loads ignore it.
  fs.writeFileSync(`${file}.99999.tmp`, '{"half": ');
  const reread = new EvidenceLedger({ repoRoot: root });
  assert.equal(reread.load(task), 1);
});

test('R4: a stale lock from a dead writer is broken rather than honoured forever', (t) => {
  const root = stateRoot(t);
  const task = 'stale-lock';
  const ledger = new EvidenceLedger({ repoRoot: root });
  ledger.addEvidence({ taskId: task, kind: 'exact-search', content: 'x' });

  const file = path.join(root, '.doflow', 'state', 'evidence', `${task}.json`);
  fs.mkdirSync(`${file}.lock`, { recursive: true });
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(`${file}.lock`, past, past);

  assert.equal(ledger.save(task), file, 'the save proceeds by breaking the minute-old lock');
  assert.ok(!fs.existsSync(`${file}.lock`), 'the lock is released after the write');
});
