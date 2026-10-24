'use strict';

/**
 * 097 A.2: the eight heldout localization tasks for the agentic baseline (FR-001, IC-001).
 *
 * The file is a retrieval task file in the existing schema, so the retrieval validator is the single
 * authority on spans and anchors; this test adds the rules that are specific to the agentic set:
 * the class split, the id range, an author that is not a retrieval holdout sealer, and a query that
 * never leaks the answer's path. The path rule is reimplemented locally on purpose: the A.1 loader
 * enforces the same refusal at run time, and a test that imported it would pass or fail with it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tasksLib = require('../../bench/retrieval/lib/tasks.ts');
const snap = require('../../bench/retrieval/lib/snapshot.ts');

const FILE = path.join(__dirname, '..', '..', 'bench', 'agentic', 'tasks-heldout.json');
const HOLDOUT_DIR = path.join(__dirname, '..', '..', 'bench', 'retrieval', 'holdout');
const SPAN_CHECK_NOTE = 'mechanical span check at 3fc988bc by the lead (git show spans, git grep callers); second reader on another model not performed (denied)';
const EXPECTED_IDS =['HC-901', 'HC-902', 'HC-903', 'HC-904', 'HC-905', 'HC-906', 'HC-907', 'HC-908'];

const load = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const allQrels = (task) => [...task.qrels, ...(task.dependencies || [])];

/** Every value stored under a `sealedBy` key, anywhere in a parsed JSON value. */
function sealedByIn(value, out) {
  if (Array.isArray(value)) { for (const v of value) sealedByIn(v, out); return; }
  if (value === null || typeof value !== 'object') return;
  for (const [key, v] of Object.entries(value)) {
    if (key === 'sealedBy' && typeof v === 'string') out.add(v);
    else sealedByIn(v, out);
  }
}

function sealers() {
  const out = new Set();
  for (const name of fs.readdirSync(HOLDOUT_DIR)) {
    if (!/\.seal(ed)?\.json$/.test(name)) continue;
    try { sealedByIn(JSON.parse(fs.readFileSync(path.join(HOLDOUT_DIR, name), 'utf8')), out); } catch { /* a ciphertext or unreadable file names no sealer */ }
  }
  return out;
}

function devIds() {
  return new Set(JSON.parse(fs.readFileSync(snap.DEV_TASKS_PATH, 'utf8')).tasks.map((t) => t.id));
}

const validate = (taskFile) => tasksLib.validateTaskFile(taskFile, {
  split: 'holdout', snapshot: snap.loadSnapshot(), manifest: snap.loadManifest(), corpus: 'code', devIds: devIds(),
});

test('the heldout file validates with zero findings against the pinned snapshot', () => {
  assert.deepEqual(validate(load()), []);
});

test('four conceptual-discovery and four impact-refactor tasks with ids HC-901..HC-908', () => {
  const { tasks } = load();
  assert.deepEqual(tasks.map((t) => t.id), EXPECTED_IDS);
  assert.deepEqual(tasks.filter((t) => t.class === 'conceptual-discovery').map((t) => t.id), EXPECTED_IDS.slice(0, 4));
  assert.deepEqual(tasks.filter((t) => t.class === 'impact-refactor').map((t) => t.id), EXPECTED_IDS.slice(4));
  assert.ok(tasks.every((t) => t.corpus === 'code' && t.split === 'holdout'));
});

test('conceptual tasks stay under the query overlap ceiling; impact tasks carry dependencies', () => {
  for (const task of load().tasks) {
    if (task.class === 'conceptual-discovery') {
      assert.ok(task.queryOverlap <= tasksLib.MAX_CONCEPTUAL_OVERLAP, `${task.id} overlap ${task.queryOverlap}`);
    } else {
      assert.ok(task.dependencies.length >= 2 && task.dependencies.length <= 4, `${task.id} has ${task.dependencies.length} callers`);
    }
  }
});

test('author is set and is not a sealedBy author of a retrieval holdout generation', () => {
  const sealed = sealers();
  assert.ok(sealed.size > 0, 'the seal files name at least one sealer, so the comparison is not vacuous');
  for (const task of load().tasks) {
    assert.ok(typeof task.author === 'string' && task.author.trim() !== '', `${task.id} author`);
    assert.ok(!sealed.has(task.author), `${task.id} author ${task.author} is a retrieval holdout sealer`);
  }
});

test('no query contains a qrel path or basename', () => {
  for (const task of load().tasks) {
    const query = task.query.toLowerCase();
    for (const qrel of allQrels(task)) {
      assert.ok(!query.includes(qrel.path.toLowerCase()), `${task.id} names ${qrel.path}`);
      assert.ok(!query.includes(path.basename(qrel.path).toLowerCase()), `${task.id} names ${path.basename(qrel.path)}`);
    }
  }
});

test('no heldout id is a dev id', () => {
  const dev = devIds();
  for (const task of load().tasks) assert.ok(!dev.has(task.id), task.id);
});

test('every truthSource entry is path:line and matches a qrel path and span', () => {
  for (const task of load().tasks) {
    const spans = allQrels(task);
    // Exactly one free-text entry is allowed: the record that the second reader did not run.
    assert.equal(task.truthSource.filter((e) => e === SPAN_CHECK_NOTE).length, 1, `${task.id} carries the span-check note once`);
    const located = task.truthSource.filter((e) => e !== SPAN_CHECK_NOTE);
    assert.ok(located.length >= spans.length, `${task.id} has a truthSource entry per qrel`);
    for (const entry of located) {
      const m = /^(.+):(\d+)$/.exec(entry);
      assert.ok(m, `${task.id} truthSource ${entry} is not path:line`);
      const line = Number(m[2]);
      assert.ok(spans.some((q) => q.path === m[1] && line >= q.startLine && line <= q.endLine), `${task.id} ${entry} is outside every qrel span`);
    }
  }
});

test('negative control: an altered anchorSha yields an anchor finding, so the validator is live', () => {
  const taskFile = load();
  assert.deepEqual(validate(taskFile), [], 'the unaltered copy is clean');
  const copy = structuredClone(taskFile);
  const qrel = copy.tasks[0].qrels[0];
  qrel.anchorSha = `${qrel.anchorSha.slice(0, -1)}${qrel.anchorSha.endsWith('0') ? '1' : '0'}`;
  const codes = validate(copy).map((f) => f.code);
  assert.ok(codes.includes('E_QREL_ANCHOR'), `expected E_QREL_ANCHOR, got ${codes.join(',')}`);
});
