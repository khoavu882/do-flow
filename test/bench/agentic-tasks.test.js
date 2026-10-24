'use strict';

// Feature 097 A.1: the agentic task set (IC-001, IC-002, IC-011). Heldout tasks come from a temp
// fixture file, never the real tasks-heldout.json (owned by A.2), via the loader's injectable paths.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.js');
const tasks = require('../../bench/agentic/tasks.ts');

const REPO = path.join(__dirname, '..', '..');
const DEV = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'retrieval', 'tasks', 'dev.json'), 'utf8'));
const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'retrieval', 'snapshot.json'), 'utf8'));
const TASKS_JSON = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'agentic', 'tasks.json'), 'utf8'));
const TMP = suiteTempDir('doflow-agentic-tasks-');

let seq = 0;
function write(name, obj) {
  const file = path.join(TMP, `${++seq}-${name}`);
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

const heldTask = (n, over = {}) => ({
  id: `HC-9${String(n).padStart(2, '0')}`, split: 'holdout', corpus: 'code', class: 'conceptual-discovery',
  query: `how does heldout concept number ${n} behave`,
  qrels: [{ id: 'q1', path: `src/heldout/area${n}/mod.ts`, startLine: n, endLine: n + 3, rel: 2, anchorSha: 'x' }],
  expect: { result: ['RETRIEVED'] }, author: 'worker:fixture', ...over,
});
const heldFile = (over = {}) => ({
  schemaVersion: 1, snapshotId: SNAPSHOT.snapshotId, split: 'holdout',
  tasks: Array.from({ length: 8 }, (_, i) => heldTask(i + 1)), ...over,
});

/** Loads with the real tasks.json/dev.json/snapshot.json unless an override is given. */
function load({ held = heldFile(), cfg, dev, snapshot, heldoutPath } = {}) {
  return tasks.loadTaskSet({
    tasksPath: cfg ? write('tasks.json', cfg) : undefined,
    devPath: dev ? write('dev.json', dev) : undefined,
    snapshotPath: snapshot ? write('snapshot.json', snapshot) : undefined,
    heldoutPath: heldoutPath || write('heldout.json', held),
  });
}
const refusal = (fn, reason) => assert.throws(fn, (e) => e instanceof tasks.UsageError && e.usage === true && e.reason === reason);

test('selection: tasks.json train is the 6 lowest ids per class among code conceptual-discovery and impact-refactor', () => {
  const expected = [];
  for (const cls of ['conceptual-discovery', 'impact-refactor']) {
    const ids = DEV.tasks.filter((t) => t.corpus === 'code' && t.class === cls).map((t) => t.id).sort();
    expected.push(...ids.slice(0, 6));
  }
  assert.deepEqual(TASKS_JSON.train, expected);
  assert.equal(TASKS_JSON.train.length, 12);
  assert.equal(TASKS_JSON.schemaVersion, 1);
  assert.equal(TASKS_JSON.heldoutFile, 'bench/agentic/tasks-heldout.json');
});

test('loader: 12 train tasks (split train, kind = class) then heldout tasks (split heldout) in order', () => {
  const set = load();
  assert.equal(set.train.length, 12);
  assert.equal(set.heldout.length, 8);
  assert.deepEqual(set.tasks, [...set.train, ...set.heldout]);
  assert.deepEqual(set.train.map((t) => t.id), TASKS_JSON.train);
  for (const t of set.train) {
    const raw = DEV.tasks.find((d) => d.id === t.id);
    assert.equal(t.split, 'train');
    assert.equal(t.kind, raw.class);
    assert.equal(t.corpus, 'code');
    assert.equal(t.query, raw.query);
    assert.deepEqual(t.qrels, raw.qrels);
    assert.deepEqual(t.expect, raw.expect);
  }
  for (const t of set.heldout) {
    assert.equal(t.split, 'heldout');
    assert.match(t.id, /^HC-9\d\d$/);
  }
  assert.equal(set.snapshot.snapshotId, SNAPSHOT.snapshotId);
  assert.equal(set.templateSha256, tasks.PROMPT_TEMPLATE_SHA256);
});

test('case key: hand-computed digest for DC-011 and the IC-002 formula recomputed independently', () => {
  const set = load();
  const dc011 = set.train.find((t) => t.id === 'DC-011');
  assert.equal(dc011.key, 'agentic/DC-011@e87b8872');
  for (const t of set.tasks) {
    const body = JSON.stringify({
      query: t.query,
      qrels: t.qrels.map((q) => ({ path: q.path, startLine: q.startLine, endLine: q.endLine, rel: q.rel })),
      dependencies: t.dependencies ?? [],
    });
    assert.equal(t.key, `agentic/${t.id}@${crypto.createHash('sha256').update(body).digest('hex').slice(0, 8)}`);
    assert.equal(tasks.caseKey(t), t.key);
  }
  assert.equal(tasks.KEY_PREFIX, 'agentic/');
});

test('case key: editing one qrel line changes only that task key; anchorSha and qrel id do not', () => {
  const base = load();
  const edited = structuredClone(DEV);
  edited.tasks.find((t) => t.id === 'DC-012').qrels[0].startLine += 1;
  const after = load({ dev: edited });
  const changed = after.tasks.filter((t, i) => t.key !== base.tasks[i].key).map((t) => t.id);
  assert.deepEqual(changed, ['DC-012']);

  const cosmetic = structuredClone(DEV);
  cosmetic.tasks.find((t) => t.id === 'DC-012').qrels[0].anchorSha = 'f'.repeat(64);
  cosmetic.tasks.find((t) => t.id === 'DC-012').qrels[0].id = 'q9';
  assert.deepEqual(load({ dev: cosmetic }).tasks.map((t) => t.key), base.tasks.map((t) => t.key));

  const requery = structuredClone(DEV);
  requery.tasks.find((t) => t.id === 'DC-013').query += ' today';
  assert.deepEqual(load({ dev: requery }).tasks.filter((t, i) => t.key !== base.tasks[i].key).map((t) => t.id), ['DC-013']);
});

test('truth leak: a query holding a qrel basename or path is refused, in train and heldout', () => {
  const trainLeak = structuredClone(DEV);
  trainLeak.tasks.find((t) => t.id === 'DC-011').query = 'where is tmp.js used for isolation';
  refusal(() => load({ dev: trainLeak }), 'truth-leak');

  const pathLeak = structuredClone(DEV);
  pathLeak.tasks.find((t) => t.id === 'DC-012').query = 'read src/state/run-lock.ts please';
  refusal(() => load({ dev: pathLeak }), 'truth-leak');

  const held = heldFile();
  held.tasks[3].query = 'what does mod.ts do';
  refusal(() => load({ held }), 'truth-leak');

  const prompt = tasks.buildPrompt(load().train[0], 'p');
  assert.ok(!prompt.includes('test/helper/tmp.js'));
  const leaky = { ...load().train[0], qrels: [{ path: 'Question', startLine: 1, endLine: 1, rel: 2 }] };
  refusal(() => tasks.buildPrompt(leaky, 'p'), 'truth-leak');
});

test('refusals: a missing or other-class dev id is refused, never defaulted or skipped', () => {
  const missing = structuredClone(DEV);
  missing.tasks = missing.tasks.filter((t) => t.id !== 'DC-014');
  refusal(() => load({ dev: missing }), 'train-id-missing');

  refusal(() => load({ cfg: { ...TASKS_JSON, train: [...TASKS_JSON.train.slice(0, 11), 'DC-999'] } }), 'train-id-missing');
  refusal(() => load({ cfg: { ...TASKS_JSON, train: [...TASKS_JSON.train.slice(0, 11), 'DC-001'] } }), 'train-id-class');

  const otherCorpus = structuredClone(DEV);
  otherCorpus.tasks.find((t) => t.id === 'DC-015').corpus = 'guidance';
  refusal(() => load({ dev: otherCorpus }), 'train-id-class');
});

test('refusals: heldout file, snapshot id, duplicates and schema version', () => {
  refusal(() => load({ heldoutPath: path.join(TMP, 'does-not-exist.json') }), 'heldout-file');
  const garbage = path.join(TMP, 'garbage.json');
  fs.writeFileSync(garbage, '{ nope');
  refusal(() => load({ heldoutPath: garbage }), 'heldout-file');
  refusal(() => load({ held: heldFile({ split: 'dev' }) }), 'heldout-file');
  refusal(() => load({ held: heldFile({ snapshotId: SNAPSHOT.snapshotId + 1 }) }), 'snapshot-mismatch');

  const dup = heldFile();
  dup.tasks[1] = heldTask(1);
  refusal(() => load({ held: dup }), 'duplicate-id');
  const dupTrain = heldFile();
  dupTrain.tasks[0] = heldTask(1, { id: 'DC-011' });
  refusal(() => load({ held: dupTrain }), 'duplicate-id');

  refusal(() => load({ cfg: { ...TASKS_JSON, schemaVersion: 2 } }), 'schema-version');
});

test('prompt: order, arm paragraph exactly once, other arm paragraph never, no truth path', () => {
  const set = load();
  const paraN = 'Search the repository with your own tools.';
  const paraD = 'A code retrieval command is available: doflow retrieve --scope code --query "<text>" --root . (add --json for structured output). Use it alongside your own tools.';
  for (const t of set.tasks) {
    const pn = tasks.buildPrompt(t, paraN);
    const pd = tasks.buildPrompt(t, paraD);
    assert.equal(pn.split(paraN).length - 1, 1);
    assert.ok(!pn.includes(paraD));
    assert.equal(pd.split(paraD).length - 1, 1);
    assert.ok(!pd.includes(paraN));
    for (const q of t.qrels) {
      assert.ok(!pn.includes(q.path) && !pd.includes(q.path));
    }
  }
  assert.equal(
    tasks.buildPrompt(set.train[0], paraN),
    [
      'You are working in a code repository at the current directory. Do not edit any file.',
      'Question: how does the test suite isolate directory creation',
      paraN,
      'Reply with only a JSON object {"files": [...]} listing up to 10 repository-relative file paths that answer the question, most relevant first.',
    ].join('\n\n'),
  );
  for (const bad of [undefined, '', '   ', 5]) assert.throws(() => tasks.buildPrompt(set.train[0], bad), TypeError);
  assert.equal(tasks.promptSha256('abc'), crypto.createHash('sha256').update('abc').digest('hex'));
});

test('template: constants and a literal sha256 that changes only when the template text changes', () => {
  assert.equal(tasks.TEMPLATE_PREAMBLE, 'You are working in a code repository at the current directory. Do not edit any file.');
  assert.ok(tasks.ANSWER_RULE.startsWith('Reply with only a JSON object {"files": [...]}'));
  assert.equal(tasks.PROMPT_TEMPLATE_SHA256, 'b22905d20f62ca1dccfcd93abee917c90d92872d1760ce8105a0862478564d19');
  const text = [tasks.TEMPLATE_PREAMBLE, 'Question: {query}', '{paragraph}', tasks.ANSWER_RULE].join('\n\n');
  assert.equal(crypto.createHash('sha256').update(text).digest('hex'), tasks.PROMPT_TEMPLATE_SHA256);
});
