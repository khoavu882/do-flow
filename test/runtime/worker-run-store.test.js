'use strict';

// Feature 081 A.5 (IC-013, DEC-021; FR-019): the worker run store. Insert refuses a second run on
// one (task, token), live or ended; a refused transition writes nothing; `seq` counts applied
// transitions; a torn or future-version file is `store-unreadable` and left as it was; and two
// processes inserting the same token at once through test/helper/race-barrier.js yield one run.
//
// This file is also the race worker's module. race-barrier.js requires the module it is given and
// calls one of its fixed operation names, so when required with `--race-worker` the file exports
// `claim` as the insert under test and registers no tests.

const path = require('node:path');

if (process.argv[2] === '--race-worker') {
  const { insertRun } = require('../../src/runtime/worker/run-store.ts');
  module.exports = { claim: ({ file, record, fsImpl }) => insertRun(file, record, fsImpl) };
  return;
}

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tempDir } = require('../helper/tmp');
const { startWorkers } = require('../helper/race-barrier');
const {
  storeFileFor, newRunId, insertRun, transition, readRuns, RUN_ID,
} = require('../../src/runtime/worker/run-store.ts');

const SLUG = '081-run-store';
const REPS = 50;

function record(overrides = {}) {
  return {
    runId: newRunId(), task: 'A.5', token: 1, harness: 'claude', phase: 'starting',
    createdAt: '2026-10-15T00:00:00.000Z', ...overrides,
  };
}

function storeIn(t) {
  return storeFileFor(tempDir(t, 'doflow-run-store-'), SLUG);
}

test('storeFileFor and newRunId follow IC-013', (t) => {
  const root = tempDir(t, 'doflow-run-store-');
  assert.equal(storeFileFor(root, SLUG), path.join(root, '.doflow', 'state', 'worker-runs', `${SLUG}.json`));
  assert.throws(() => storeFileFor(root, '../escape'), { code: 'usage' });
  const ids = new Set(Array.from({ length: 50 }, newRunId));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, RUN_ID);
  assert.match(newRunId(), /^w-[0-9a-f]{12}$/);
});

test('a second insert on the same task and token is refused, live and ended, naming the first', (t) => {
  const file = storeIn(t);
  const first = record();
  const inserted = insertRun(file, first);
  assert.equal(inserted.applied, true);
  assert.equal(inserted.run.seq, 0);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.slug, SLUG);
  assert.deepEqual(Object.keys(onDisk.runs), [first.runId]);

  const live = insertRun(file, record());
  assert.deepEqual(live, { applied: false, reason: 'run-exists', runId: first.runId, phase: 'starting' });

  assert.equal(transition(file, first.runId, ['starting'], (run) => { run.phase = 'ended'; run.end = { state: 'exited', at: 'x' }; }).applied, true);
  const ended = insertRun(file, record());
  assert.deepEqual(ended, { applied: false, reason: 'run-exists', runId: first.runId, phase: 'ended' });

  assert.equal(insertRun(file, record({ token: 2 })).applied, true);
  assert.equal(insertRun(file, record({ task: 'A.6' })).applied, true);
  assert.equal(Object.keys(readRuns(file)).length, 3);
});

test('a refused transition leaves the file bytes unchanged', (t) => {
  const file = storeIn(t);
  const run = record();
  insertRun(file, run);
  const before = fs.readFileSync(file);
  let called = false;
  const refused = transition(file, run.runId, ['running', 'cancelling'], () => { called = true; });
  assert.equal(refused.applied, false);
  assert.equal(refused.reason, 'phase-not-allowed');
  assert.equal(refused.phase, 'starting');
  assert.equal(refused.run.seq, 0);
  assert.equal(called, false);
  assert.deepEqual(fs.readFileSync(file), before);

  const unknown = transition(file, 'w-000000000000', ['starting'], () => { called = true; });
  assert.deepEqual(unknown, { applied: false, reason: 'unknown-run', runId: 'w-000000000000' });
  assert.equal(called, false);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('seq increments by one per applied transition and not on a refusal', (t) => {
  const file = storeIn(t);
  const run = record();
  insertRun(file, run);
  const launching = transition(file, run.runId, ['starting'], (r) => { r.launchingAt = '2026-10-15T00:00:01.000Z'; });
  assert.equal(launching.run.seq, 1);
  assert.equal(launching.run.launchingAt, '2026-10-15T00:00:01.000Z');
  const running = transition(file, run.runId, ['starting'], (r) => ({ ...r, phase: 'running', worker: { pid: 1, pgid: 1, start: 's' } }));
  assert.equal(running.run.seq, 2);
  assert.equal(transition(file, run.runId, ['starting'], () => {}).applied, false);
  const cancelling = transition(file, run.runId, ['starting', 'running', 'cancelling'], (r) => { r.phase = 'cancelling'; });
  assert.equal(cancelling.run.seq, 3);
  const stored = readRuns(file)[run.runId];
  assert.equal(stored.seq, 3);
  assert.equal(stored.phase, 'cancelling');
  assert.equal(stored.launchingAt, '2026-10-15T00:00:01.000Z');
  assert.deepEqual(stored.worker, { pid: 1, pgid: 1, start: 's' });
  assert.equal(stored.token, 1);
});

for (const [name, text] of [
  ['a torn file', '{"slug": "081-run-store", "runs": {'],
  ['a version 2 file', JSON.stringify({ slug: SLUG, version: 2, revision: 1, runs: {} })],
]) {
  test(`${name} is store-unreadable and unchanged`, (t) => {
    const file = storeIn(t);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    const before = fs.readFileSync(file);
    assert.throws(() => readRuns(file), { code: 'store-unreadable' });
    assert.throws(() => insertRun(file, record()), { code: 'store-unreadable' });
    assert.throws(() => transition(file, 'w-000000000000', ['starting'], () => {}), { code: 'store-unreadable' });
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.existsSync(`${file}.lock`), false);
  });
}

test('two processes inserting the same token at once yield one run', async (t) => {
  const dir = tempDir(t, 'doflow-run-store-race-');
  const file = storeFileFor(dir, SLUG);
  const { race, stop } = startWorkers({
    count: 2,
    modulePath: __filename,
    barrierDir: dir,
    envFor: () => ({
      DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_ATTEMPT: '1', DOFLOW_SESSION_ROLE: 'main',
      DOFLOW_WORKTREE: dir, HOME: dir,
    }),
  });
  t.after(stop);
  for (let rep = 0; rep < REPS; rep += 1) {
    fs.rmSync(file, { force: true });
    const records = [record(), record()];
    const answers = await race(records.map((r, i) => ({ op: 'claim', args: { file, record: r }, skewUs: i === rep % 2 ? rep : 0 })));
    for (const answer of answers) assert.equal(answer.error, undefined, `repetition ${rep}: ${JSON.stringify(answer.error)}`);
    const applied = answers.filter((a) => a.result.applied);
    const refused = answers.filter((a) => !a.result.applied);
    assert.equal(applied.length, 1, `repetition ${rep}: ${JSON.stringify(answers)}`);
    assert.equal(refused[0].result.reason, 'run-exists');
    assert.equal(refused[0].result.runId, applied[0].result.run.runId);
    assert.deepEqual(Object.keys(readRuns(file)), [applied[0].result.run.runId], `repetition ${rep}`);
  }
});
