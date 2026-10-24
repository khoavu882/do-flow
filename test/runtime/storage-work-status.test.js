'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { workStatus, createWorkCache, refreshedWorkCache, RUN_OPEN_STATES } = require('../../src/runtime/storage/work-status.ts');

const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;
const DAY = 24 * 60 * 60 * 1000;

function setup(t) {
  const projectRoot = tempDir(t, 'doflow-storage-work-status-');
  fs.mkdirSync(path.join(projectRoot, '.doflow', 'state'), { recursive: true });
  return projectRoot;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
  return file;
}

function writeRecord(projectRoot, { store = 'evidence', taskId, namespace = null, value = {}, mtimeMs }) {
  const file = writeJson(path.join(projectRoot, '.doflow', 'state', store, ...(namespace ? [namespace] : []), `${taskId}.json`), value);
  if (mtimeMs !== undefined) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

function writeRun(projectRoot, id, value) {
  return writeJson(path.join(projectRoot, '.doflow', 'state', 'orchestration', `${id}.json`), value);
}

function writePlan(projectRoot, feature, text = '- [x] complete\n') {
  const file = path.join(projectRoot, 'agent-docs', 'doflow', feature, 'plan.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function status(projectRoot, options) {
  return workStatus({ projectRoot, store: 'task-evidence', ...options });
}

test('IC-004 exports the closed set of open run states', () => {
  assert.deepEqual(RUN_OPEN_STATES, ['RUNNING', 'AWAITING_GATE']);
});

test('declared record store ids resolve to their physical project-state paths', (t) => {
  const projectRoot = setup(t);
  const mappings = [
    ['task-evidence', 'evidence'],
    ['task-readiness', 'readiness'],
    ['task-research', 'research'],
    ['task-outcome', 'outcome'],
    ['task-retrieval', 'retrieval'],
  ];
  for (const [storeId, physicalPath] of mappings) {
    const taskId = `mapped-${physicalPath}`;
    writeRecord(projectRoot, { store: physicalPath, taskId, value: { version: 1 } });
    assert.deepEqual(workStatus({ projectRoot, store: storeId, taskId, mtimeMs: 19 }), {
      state: 'finished', since: 19, reason: 'no-run', run: null, feature: null,
    }, `${storeId} reads .doflow/state/${physicalPath}`);
  }
});

test('W1 resolves the exact run, namespace run, longest delimited run prefix, or no run', (t) => {
  const projectRoot = setup(t);

  writeRecord(projectRoot, { taskId: 'exact' });
  writeRun(projectRoot, 'exact', { state: 'COMPLETED', updatedAt: '2026-01-01T00:00:00.000Z' });
  writeRun(projectRoot, 'space', { state: 'RUNNING' });
  assert.equal(status(projectRoot, { taskId: 'exact', namespace: 'space', mtimeMs: 1 }).run, 'exact');

  writeRecord(projectRoot, { taskId: 'member', namespace: 'space' });
  assert.deepEqual(status(projectRoot, { taskId: 'member', namespace: 'space', mtimeMs: 1 }), {
    state: 'open', since: null, reason: 'run-open', run: 'space', feature: null,
  });

  writeRecord(projectRoot, { taskId: 'release-A.1-child' });
  writeRun(projectRoot, 'release', { state: 'COMPLETED', updatedAt: '2026-01-01T00:00:00.000Z' });
  writeRun(projectRoot, 'release-A.1', { state: 'REJECTED', updatedAt: '2026-01-02T00:00:00.000Z' });
  assert.equal(status(projectRoot, { taskId: 'release-A.1-child', mtimeMs: 1 }).run, 'release-A.1');

  writeRecord(projectRoot, { taskId: 'standalone' });
  assert.deepEqual(status(projectRoot, { taskId: 'standalone', mtimeMs: 17 }), {
    state: 'finished', since: 17, reason: 'no-run', run: null, feature: null,
  });
});

test('W1 only accepts run prefixes followed by dash or dot', (t) => {
  const projectRoot = setup(t);
  writeRecord(projectRoot, { taskId: 'alphabet' });
  writeRun(projectRoot, 'alpha', { state: 'RUNNING' });
  assert.equal(status(projectRoot, { taskId: 'alphabet', mtimeMs: 5 }).run, null);
});

test('W2 unreadable, invalid JSON, and unknown-state runs are undecidable', async (t) => {
  const projectRoot = setup(t);
  for (const taskId of ['invalid-json', 'unknown-state']) writeRecord(projectRoot, { taskId });
  const invalid = path.join(projectRoot, '.doflow', 'state', 'orchestration', 'invalid-json.json');
  fs.mkdirSync(path.dirname(invalid), { recursive: true });
  fs.writeFileSync(invalid, '{');
  writeRun(projectRoot, 'unknown-state', { state: 'PAUSED' });

  for (const taskId of ['invalid-json', 'unknown-state']) {
    assert.deepEqual(status(projectRoot, { taskId, mtimeMs: 1 }), {
      state: 'undecidable', since: null, reason: 'run-unreadable', run: taskId, feature: null,
    });
  }
});

test('W2 a mode-000 run is undecidable', { skip: process.platform === 'win32' || ROOT_USER }, (t) => {
  const projectRoot = setup(t);
  writeRecord(projectRoot, { taskId: 'unreadable' });
  const file = writeRun(projectRoot, 'unreadable', { state: 'COMPLETED' });
  fs.chmodSync(file, 0);
  t.after(() => { if (fs.existsSync(file)) fs.chmodSync(file, 0o600); });
  assert.deepEqual(status(projectRoot, { taskId: 'unreadable', mtimeMs: 1 }), {
    state: 'undecidable', since: null, reason: 'run-unreadable', run: 'unreadable', feature: null,
  });
});

test('W3 an unreadable record is undecidable', (t) => {
  const projectRoot = setup(t);
  const file = path.join(projectRoot, '.doflow', 'state', 'evidence', 'broken.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{');
  assert.deepEqual(status(projectRoot, { taskId: 'broken', mtimeMs: 1 }), {
    state: 'undecidable', since: null, reason: 'record-unreadable', run: null, feature: null,
  });
});

test('W4 old work stays open while its run is RUNNING or AWAITING_GATE', (t) => {
  const projectRoot = setup(t);
  const now = Date.UTC(2026, 0, 1);
  for (const [taskId, state] of [['active', 'RUNNING'], ['gated', 'AWAITING_GATE']]) {
    writeRecord(projectRoot, { taskId, mtimeMs: now - 120 * DAY });
    writeRun(projectRoot, taskId, { state, updatedAt: new Date(now - 120 * DAY).toISOString() });
    assert.deepEqual(status(projectRoot, { taskId }), {
      state: 'open', since: null, reason: 'run-open', run: taskId, feature: null,
    });
  }
});

test('W5 resolves feature by run, record featureSlug, record slug, namespace, then longest folder prefix', (t) => {
  const projectRoot = setup(t);
  const cases = [
    { taskId: 'from-run', namespace: 'namespace-run', run: { featureSlug: 'run-feature' }, record: { featureSlug: 'record-feature', slug: 'record-slug' }, want: 'run-feature' },
    { taskId: 'from-record-feature', namespace: 'namespace-record', run: {}, record: { featureSlug: 'record-feature', slug: 'record-slug' }, want: 'record-feature' },
    { taskId: 'from-record-slug', run: {}, record: { slug: 'record-slug' }, want: 'record-slug' },
    { taskId: 'from-namespace', namespace: 'namespace-only', run: {}, record: {}, want: 'namespace-only' },
  ];
  for (const item of cases) {
    writeRecord(projectRoot, { taskId: item.taskId, namespace: item.namespace, value: item.record });
    writeRun(projectRoot, item.taskId, { state: 'COMPLETED', updatedAt: '2026-01-01T00:00:00.000Z', ...item.run });
    assert.equal(status(projectRoot, { taskId: item.taskId, namespace: item.namespace, mtimeMs: 1 }).feature, item.want);
  }

  fs.mkdirSync(path.join(projectRoot, 'agent-docs', 'doflow', '061-storage'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'agent-docs', 'doflow', '061-storage-extra'), { recursive: true });
  writeRecord(projectRoot, { taskId: '061-storage-extra-B.1' });
  assert.equal(status(projectRoot, { taskId: '061-storage-extra-B.1', mtimeMs: 1 }).feature, '061-storage-extra');
});

test('W6 an unreadable plan is undecidable', (t) => {
  const projectRoot = setup(t);
  writeRecord(projectRoot, { taskId: 'plan-broken' });
  writeRun(projectRoot, 'plan-broken', { state: 'COMPLETED', featureSlug: 'feature-a', updatedAt: '2026-01-01T00:00:00.000Z' });
  fs.mkdirSync(path.join(projectRoot, 'agent-docs', 'doflow', 'feature-a', 'plan.md'), { recursive: true });
  assert.deepEqual(status(projectRoot, { taskId: 'plan-broken', mtimeMs: 1 }), {
    state: 'undecidable', since: null, reason: 'plan-unreadable', run: 'plan-broken', feature: 'feature-a',
  });
});

test('W7 a terminal run stays open while its feature plan has an unchecked item', (t) => {
  const projectRoot = setup(t);
  const now = Date.UTC(2026, 0, 1);
  writeRecord(projectRoot, { store: 'readiness', taskId: 'old-ready', mtimeMs: now - 90 * DAY });
  writeRun(projectRoot, 'old-ready', { state: 'COMPLETED', featureSlug: 'feature-b', updatedAt: new Date(now - 90 * DAY).toISOString() });
  writePlan(projectRoot, 'feature-b', '# Plan\n- [ ] B.1 unfinished\n');
  assert.deepEqual(workStatus({ projectRoot, store: 'task-readiness', taskId: 'old-ready' }), {
    state: 'open', since: null, reason: 'plan-unchecked', run: 'old-ready', feature: 'feature-b',
  });
});

test('W8 an unchecked task token in another feature plan keeps unassociated work open', (t) => {
  const projectRoot = setup(t);
  writeRecord(projectRoot, { taskId: 'P.7' });
  writePlan(projectRoot, 'other-feature', '- [ ] P.70 not this task\n- [ ] P.7 exact task\n');
  assert.deepEqual(status(projectRoot, { taskId: 'P.7', mtimeMs: 1 }), {
    state: 'open', since: null, reason: 'task-unchecked', run: null, feature: null,
  });
});

test('W9 finished work uses the later run end or record mtime and distinguishes no-run work', (t) => {
  const projectRoot = setup(t);
  const runEnd = Date.UTC(2026, 0, 2);
  writeRecord(projectRoot, { taskId: 'run-later' });
  writeRun(projectRoot, 'run-later', { state: 'REJECTED', updatedAt: new Date(runEnd).toISOString() });
  assert.deepEqual(status(projectRoot, { taskId: 'run-later', mtimeMs: runEnd - DAY }), {
    state: 'finished', since: runEnd, reason: 'run-finished', run: 'run-later', feature: null,
  });

  writeRecord(projectRoot, { taskId: 'record-later' });
  writeRun(projectRoot, 'record-later', { state: 'COMPLETED', updatedAt: new Date(runEnd).toISOString() });
  assert.equal(status(projectRoot, { taskId: 'record-later', mtimeMs: runEnd + DAY }).since, runEnd + DAY);

  writeRecord(projectRoot, { taskId: 'legacy-v1', value: { version: 1, taskId: 'legacy-v1' } });
  assert.deepEqual(status(projectRoot, { taskId: 'legacy-v1', mtimeMs: 41 }), {
    state: 'finished', since: 41, reason: 'no-run', run: null, feature: null,
  });
});

test('a namespaced feature record with no run finishes after its own idle time once its plan is all checked', (t) => {
  const projectRoot = setup(t);
  writeRecord(projectRoot, { taskId: 'B.1', namespace: '061-feature', value: { version: 1 } });
  writePlan(projectRoot, '061-feature');
  assert.deepEqual(status(projectRoot, { taskId: 'B.1', namespace: '061-feature', mtimeMs: 73 }), {
    state: 'finished', since: 73, reason: 'no-run', run: null, feature: '061-feature',
  });
});

test('W6/W7 (AM22): an existing feature folder without plan.md is open work, never finished by age', (t) => {
  const projectRoot = setup(t);
  writeRecord(projectRoot, { taskId: 'B.1', namespace: '061-feature', value: { version: 1 } });
  fs.mkdirSync(path.join(projectRoot, 'agent-docs', 'doflow', '061-feature'), { recursive: true });
  assert.deepEqual(status(projectRoot, { taskId: 'B.1', namespace: '061-feature', mtimeMs: 73 }), {
    state: 'open', since: null, reason: 'plan-missing', run: null, feature: '061-feature',
  });
  fs.mkdirSync(path.join(projectRoot, 'agent-docs', 'doflow', '062-inferred'), { recursive: true });
  writeRecord(projectRoot, { taskId: '062-inferred-A.1' });
  assert.deepEqual(status(projectRoot, { taskId: '062-inferred-A.1', mtimeMs: 73 }), {
    state: 'open', since: null, reason: 'plan-missing', run: null, feature: '062-inferred',
  });
});

test('W6/W7 (AM22): a feature named by a record or run whose folder does not exist is undecidable and kept', (t) => {
  const projectRoot = setup(t);
  writeRecord(projectRoot, { taskId: 'B.1', namespace: 'renamed-feature', value: { version: 1 } });
  assert.deepEqual(status(projectRoot, { taskId: 'B.1', namespace: 'renamed-feature', mtimeMs: 73 }), {
    state: 'undecidable', since: null, reason: 'feature-missing', run: null, feature: 'renamed-feature',
  });
  writeRecord(projectRoot, { taskId: 'gone-run' });
  writeRun(projectRoot, 'gone-run', { state: 'COMPLETED', featureSlug: 'removed-feature', updatedAt: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(status(projectRoot, { taskId: 'gone-run', mtimeMs: 73 }), {
    state: 'undecidable', since: null, reason: 'feature-missing', run: 'gone-run', feature: 'removed-feature',
  });
});

test('W6/W7 (AM22): a refreshed cache rereads the feature folder and plan after selection', (t) => {
  const projectRoot = setup(t);
  writeRecord(projectRoot, { taskId: 'B.1', namespace: '061-feature', value: { version: 1 } });
  const plan = writePlan(projectRoot, '061-feature');
  const cache = createWorkCache({ projectRoot, fsImpl: fs });
  assert.equal(status(projectRoot, { taskId: 'B.1', namespace: '061-feature', mtimeMs: 73, cache }).state, 'finished');
  fs.unlinkSync(plan);
  assert.equal(status(projectRoot, { taskId: 'B.1', namespace: '061-feature', mtimeMs: 73, cache }).state, 'finished', 'one pass reads a plan once');
  assert.equal(status(projectRoot, { taskId: 'B.1', namespace: '061-feature', mtimeMs: 73, cache: refreshedWorkCache(cache) }).reason, 'plan-missing');
  fs.rmdirSync(path.dirname(plan));
  assert.equal(status(projectRoot, { taskId: 'B.1', namespace: '061-feature', mtimeMs: 73, cache: refreshedWorkCache(cache) }).reason, 'feature-missing');
});

test('_claims is stripped for run and feature matching while its own record is read', (t) => {
  const projectRoot = setup(t);
  writeRecord(projectRoot, { taskId: 'A.1_claims', value: { version: 1 } });
  writeRun(projectRoot, 'A.1', { state: 'RUNNING' });
  assert.deepEqual(status(projectRoot, { taskId: 'A.1_claims', mtimeMs: 1 }), {
    state: 'open', since: null, reason: 'run-open', run: 'A.1', feature: null,
  });
});

test('createWorkCache reads each run and plan at most once per pass', (t) => {
  const projectRoot = setup(t);
  writeRecord(projectRoot, { taskId: 'cached-task' });
  const runFile = writeRun(projectRoot, 'cached-task', {
    state: 'COMPLETED', featureSlug: 'cached-feature', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const planFile = writePlan(projectRoot, 'cached-feature');
  const orchestrationFile = writeRun(projectRoot, 'orchestration-only', {
    state: 'COMPLETED', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const reads = new Map();
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property !== 'readFileSync') return target[property];
      return (file, ...args) => {
        const absolute = path.resolve(String(file));
        reads.set(absolute, (reads.get(absolute) || 0) + 1);
        return target.readFileSync(file, ...args);
      };
    },
  });
  const cache = createWorkCache({ projectRoot, fsImpl });
  for (let i = 0; i < 2; i += 1) {
    assert.equal(status(projectRoot, { taskId: 'cached-task', mtimeMs: 1, cache }).state, 'finished');
  }
  assert.equal(workStatus({
    projectRoot, store: 'task-orchestration', taskId: 'orchestration-only', mtimeMs: 1, cache,
  }).state, 'finished');
  assert.equal(reads.get(path.resolve(runFile)), 1, 'run file is cached');
  assert.equal(reads.get(path.resolve(planFile)), 1, 'plan file is cached');
  assert.equal(reads.get(path.resolve(orchestrationFile)), 1, 'a run used as its own record is read once');
});

test('workStatus reads mtime when omitted and every missing record read fails closed', (t) => {
  const projectRoot = setup(t);
  const when = Date.UTC(2025, 5, 1);
  const file = writeRecord(projectRoot, { taskId: 'mtime' });
  fs.utimesSync(file, new Date(when), new Date(when));
  assert.equal(status(projectRoot, { taskId: 'mtime' }).since, fs.statSync(file).mtimeMs);
  assert.equal(status(projectRoot, { taskId: 'missing' }).state, 'undecidable');
  assert.equal(status(projectRoot, { taskId: 'missing' }).reason, 'record-unreadable');
});

test('work-status has no process, network, or HTTP imports', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/runtime/storage/work-status.ts'), 'utf8');
  for (const prohibited of ['node:child_process', 'node:http', 'node:https', 'node:net', 'node:dns']) {
    assert.equal(source.includes(prohibited), false, prohibited);
  }
});

function ledger({ attempts = [], runs } = {}) {
  return { version: 1, revision: 1, planPath: null, tasks: { 'A.1': { nextToken: attempts.length + 1, attempts } },
    ...(runs ? { runs } : {}) };
}

function ledgerStatus(projectRoot, value) {
  writePlan(projectRoot, '080-ledger', '- [x] A.1 done\n');
  writeRecord(projectRoot, { store: 'task-attempts', taskId: '080-ledger', value, mtimeMs: 5 });
  return workStatus({ projectRoot, store: 'task-attempts', taskId: '080-ledger', mtimeMs: 5 });
}

test('IC-028 a paused run keeps its ledger open with every plan box ticked', (t) => {
  const projectRoot = setup(t);
  const value = ledger({ attempts: [{ token: 1, state: 'finished', runKey: 'k' }], runs: { k: { control: 'paused' } } });
  assert.deepEqual(ledgerStatus(projectRoot, value), {
    state: 'open', since: null, reason: 'run-control-open', run: null, feature: null,
  });
});

test('IC-028 a cancelled attempt keeps its ledger open with every plan box ticked', (t) => {
  const projectRoot = setup(t);
  const value = ledger({ attempts: [{ token: 1, state: 'cancelled', runKey: 'k' }], runs: { k: { control: 'running' } } });
  assert.deepEqual(ledgerStatus(projectRoot, value), {
    state: 'open', since: null, reason: 'attempt-open', run: null, feature: null,
  });
});

test('IC-028 a cancel that a resume cleared no longer holds the ledger open (FU-syq560)', (t) => {
  const projectRoot = setup(t);
  const cancel = { at: '2026-10-01T00:00:00.000Z', by: 'user', reason: 'stop' };
  const resume = (extra) => ({ at: '2026-10-02T00:00:00.000Z', action: 'resume', ...extra });
  const finished = { state: 'finished', since: 5, reason: 'no-run', run: null, feature: '080-ledger' };
  const byList = ledger({ attempts: [{ token: 1, state: 'cancelled', runKey: 'k', cancel }], runs: { k: { control: 'running', history: [resume({ cleared: [{ taskId: 'A.1', token: 1 }] })] } } });
  assert.deepEqual(ledgerStatus(projectRoot, byList), finished, 'named in the resume\'s cleared list');
  const byTime = ledger({ attempts: [{ token: 1, state: 'cancelled', runKey: 'k', cancel }], runs: { k: { control: 'running', history: [resume({})] } } });
  assert.deepEqual(ledgerStatus(projectRoot, byTime), finished, 'a resume later than the cancel');
});

test('IC-028 a null attempt beside a cancelled one does not fail the ledger check (C-4)', (t) => {
  const projectRoot = setup(t);
  const cancel = { at: '2026-10-01T00:00:00.000Z', by: 'user', reason: 'stop' };
  const history = [{ at: '2026-10-02T00:00:00.000Z', action: 'resume', cleared: [{ taskId: 'A.1', token: 1 }] }];
  const cleared = ledger({ attempts: [null, { token: 1, state: 'cancelled', runKey: 'k', cancel }], runs: { k: { control: 'running', history } } });
  assert.deepEqual(ledgerStatus(projectRoot, cleared), { state: 'finished', since: 5, reason: 'no-run', run: null, feature: '080-ledger' });
  const uncleared = ledger({ attempts: [null, { token: 1, state: 'cancelled', runKey: 'k', cancel }], runs: { k: { control: 'running', history: [] } } });
  assert.deepEqual(ledgerStatus(projectRoot, uncleared), { state: 'open', since: null, reason: 'attempt-open', run: null, feature: null }, 'an uncleared cancel still holds');
});

test('IC-028 cancelled attempts are paired with their resume by identity, so duplicate or missing tokens never clear an uncleared one (N-3)', (t) => {
  const projectRoot = setup(t);
  const cancelled = (token, runKey) => ({ ...(token === undefined ? {} : { token }), state: 'cancelled', runKey, cancel: { at: '2026-10-01T00:00:00.000Z' } });
  const runs = {
    k: { control: 'running', history: [{ at: '2026-10-02T00:00:00.000Z', action: 'resume' }] },
    k2: { control: 'running', history: [] },
  };
  const open = { state: 'open', since: null, reason: 'attempt-open', run: null, feature: null };
  assert.deepEqual(ledgerStatus(projectRoot, ledger({ attempts: [cancelled(undefined, 'k'), cancelled(undefined, 'k2')], runs })), open, 'no token on either');
  assert.deepEqual(ledgerStatus(projectRoot, ledger({ attempts: [cancelled(1, 'k'), cancelled(1, 'k2')], runs })), open, 'the same token on both');
  assert.deepEqual(ledgerStatus(projectRoot, ledger({ attempts: [cancelled(undefined, 'k')], runs })), { state: 'finished', since: 5, reason: 'no-run', run: null, feature: '080-ledger' }, 'control: a cleared cancel alone still settles');
});

test('IC-028 a cancel no resume cleared, or a different attempt\'s cleared entry, still holds the ledger open', (t) => {
  const projectRoot = setup(t);
  const cancel = { at: '2026-10-03T00:00:00.000Z', by: 'user', reason: 'stop' };
  const open = { state: 'open', since: null, reason: 'attempt-open', run: null, feature: null };
  const earlier = ledger({ attempts: [{ token: 2, state: 'cancelled', runKey: 'k', cancel }], runs: { k: { control: 'running', history: [{ at: '2026-10-02T00:00:00.000Z', action: 'resume', cleared: [{ taskId: 'A.1', token: 1 }] }] } } });
  assert.deepEqual(ledgerStatus(projectRoot, earlier), open, 'the resume predates the cancel and names token 1, not 2');
  const none = ledger({ attempts: [{ token: 1, state: 'cancelled', runKey: 'k', cancel }, { token: 2, state: 'finished', runKey: 'k' }], runs: { k: { control: 'running', history: [] } } });
  assert.deepEqual(ledgerStatus(projectRoot, none), open, 'no resume at all');
});

test('IC-028 a running run with an active attempt keeps its ledger open', (t) => {
  const projectRoot = setup(t);
  const value = ledger({ attempts: [{ token: 1, state: 'active', runKey: 'k' }], runs: { k: { control: 'running' } } });
  assert.equal(ledgerStatus(projectRoot, value).state, 'open');
});

test('IC-028 a running run with no active attempt and every box ticked keeps today\'s answer', (t) => {
  const projectRoot = setup(t);
  const value = ledger({ attempts: [{ token: 1, state: 'finished', runKey: 'k' }], runs: { k: { control: 'running' } } });
  assert.deepEqual(ledgerStatus(projectRoot, value), {
    state: 'finished', since: 5, reason: 'no-run', run: null, feature: '080-ledger',
  });
});

// FU-c2ddw2: since 115 a run of a task id other than its feature's slug lives in orchestration/<slug>/.
function writeNamespacedRun(projectRoot, namespace, id, value) {
  return writeJson(path.join(projectRoot, '.doflow', 'state', 'orchestration', namespace, `${id}.json`), value);
}

test('FU-c2ddw2 a namespaced RUNNING run keeps its record open, found by the record\'s own namespace', (t) => {
  const projectRoot = setup(t);
  writePlan(projectRoot, 'feat-a');
  writeRecord(projectRoot, { taskId: 'task-1', namespace: 'feat-a' });
  writeNamespacedRun(projectRoot, 'feat-a', 'task-1', { state: 'RUNNING', featureSlug: 'feat-a', updatedAt: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(status(projectRoot, { taskId: 'task-1', namespace: 'feat-a', mtimeMs: 1 }), {
    state: 'open', since: null, reason: 'run-open', run: 'task-1', feature: null,
  });
});

test('FU-c2ddw2 a flat record finds its run in whichever namespace holds it, and a gate-paused one is open too', (t) => {
  const projectRoot = setup(t);
  writePlan(projectRoot, 'feat-b');
  writeRecord(projectRoot, { taskId: 'task-2', value: { featureSlug: 'feat-b' } });
  writeNamespacedRun(projectRoot, 'feat-b', 'task-2', { state: 'AWAITING_GATE', featureSlug: 'feat-b' });
  assert.equal(status(projectRoot, { taskId: 'task-2', mtimeMs: 1 }).reason, 'run-open');
  assert.equal(status(projectRoot, { taskId: 'task-2', mtimeMs: 1 }).run, 'task-2');
  // N-1: a flat record that names no feature takes no namespaced copy; it is judged as 135ce230 judged it.
  writeRecord(projectRoot, { taskId: 'task-2b' });
  writeNamespacedRun(projectRoot, 'feat-b', 'task-2b', { state: 'AWAITING_GATE', featureSlug: 'feat-b' });
  assert.equal(status(projectRoot, { taskId: 'task-2b', mtimeMs: 1 }).reason, 'no-run');
});

test('FU-c2ddw2 a delimited-prefix run in a namespace is found as a flat prefix run is', (t) => {
  const projectRoot = setup(t);
  writePlan(projectRoot, 'feat-c');
  writeRecord(projectRoot, { taskId: 'wide-sub', namespace: 'feat-c' });
  writeNamespacedRun(projectRoot, 'feat-c', 'wide', { state: 'RUNNING', featureSlug: 'feat-c' });
  const found = status(projectRoot, { taskId: 'wide-sub', namespace: 'feat-c', mtimeMs: 1 });
  assert.equal(found.reason, 'run-open');
  assert.equal(found.run, 'wide');
});

test('FU-c2ddw2 an orchestration record that is a namespaced run resolves it', (t) => {
  const projectRoot = setup(t);
  writePlan(projectRoot, 'feat-d');
  writeNamespacedRun(projectRoot, 'feat-d', 'task-3', { state: 'RUNNING', featureSlug: 'feat-d' });
  const live = workStatus({ projectRoot, store: 'task-orchestration', taskId: 'task-3', namespace: 'feat-d', mtimeMs: 1 });
  assert.equal(live.state, 'open');
  assert.equal(live.reason, 'run-open');
  writeNamespacedRun(projectRoot, 'feat-d', 'task-4', { state: 'COMPLETED', featureSlug: 'feat-d', updatedAt: '2026-01-01T00:00:00.000Z' });
  const done = workStatus({ projectRoot, store: 'task-orchestration', taskId: 'task-4', namespace: 'feat-d', mtimeMs: 1 });
  // N-1: a finished namespaced copy never decides a record (only a live one keeps it open); the record is judged as 135ce230 judged it.
  assert.equal(done.state, 'finished');
  assert.equal(done.reason, 'no-run');
  assert.equal(done.run, null);
});

test('FU-c2ddw2 the namespaced copy of a run is read before a stale flat seed, and an unreadable one fails closed', (t) => {
  const projectRoot = setup(t);
  writePlan(projectRoot, 'feat-e');
  writeRecord(projectRoot, { taskId: 'task-5', namespace: 'feat-e' });
  writeRun(projectRoot, 'task-5', { state: 'COMPLETED', featureSlug: 'feat-e', updatedAt: '2026-01-01T00:00:00.000Z' });
  writeNamespacedRun(projectRoot, 'feat-e', 'task-5', { state: 'RUNNING', featureSlug: 'feat-e' });
  assert.equal(status(projectRoot, { taskId: 'task-5', namespace: 'feat-e', mtimeMs: 1 }).reason, 'run-open', 'a live namespaced copy beats a finished flat seed');

  writeRecord(projectRoot, { taskId: 'task-6', namespace: 'feat-e' });
  const bad = path.join(projectRoot, '.doflow', 'state', 'orchestration', 'feat-e', 'task-6.json');
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, '{not json');
  assert.deepEqual(status(projectRoot, { taskId: 'task-6', namespace: 'feat-e', mtimeMs: 1 }), {
    state: 'undecidable', since: null, reason: 'run-unreadable', run: 'task-6', feature: null,
  });
});

test('FU-c2ddw2 a lock directory in orchestration is not a run namespace', (t) => {
  const projectRoot = setup(t);
  writeRecord(projectRoot, { taskId: 'task-7' });
  writeNamespacedRun(projectRoot, 'task-7.json.lock', 'task-7', { state: 'RUNNING' });
  assert.equal(status(projectRoot, { taskId: 'task-7', mtimeMs: 1 }).reason, 'no-run');
});

// C-1 (maint-runtime-b review): a record is judged only by a run it owns. A record under feature A's
// namespace never takes feature B's namespaced run of the same task id, and a flat record that two
// namespaces could claim is undecidable rather than guessed.
const storageRegistry = require('../../core/registry/storage.json');
const { runPass } = require('../../src/runtime/storage/engine.ts');
const { recordStillCandidate } = require('../../src/runtime/storage/rules.ts');
const OLD = Date.parse('2026-07-01T00:00:00Z');
const OLD_ISO = '2026-01-01T00:00:00.000Z';

function crossFeatureProject(t, planA = '- [ ] T.5 do it\n') {
  const projectRoot = setup(t);
  writePlan(projectRoot, 'feat-a', planA);
  writePlan(projectRoot, 'feat-b', '- [x] T.5 done\n');
  writeRecord(projectRoot, { taskId: 'T.5', namespace: 'feat-a', mtimeMs: OLD });
  writeNamespacedRun(projectRoot, 'feat-b', 'T.5', { state: 'COMPLETED', featureSlug: 'feat-b', updatedAt: OLD_ISO });
  return projectRoot;
}

test('C-1 a record under feature A never takes feature B\'s namespaced run of the same task id (selection)', (t) => {
  const projectRoot = crossFeatureProject(t);
  assert.deepEqual(status(projectRoot, { taskId: 'T.5', namespace: 'feat-a', mtimeMs: OLD }), {
    state: 'open', since: null, reason: 'plan-unchecked', run: null, feature: 'feat-a',
  });
});

test('C-1 the locked recheck refuses the same cross-feature run', (t) => {
  const projectRoot = crossFeatureProject(t);
  const storeDir = path.join(projectRoot, '.doflow', 'state', 'evidence');
  const store = storageRegistry.stores.find((s) => s.id === 'task-evidence');
  const recheck = (namespace, name) => {
    const info = fs.lstatSync(path.join(storeDir, namespace, name));
    const cache = createWorkCache({ projectRoot });
    return recordStillCandidate(store, { name: `${namespace}/${name}`, reason: 'finished-work', mtimeMs: info.mtimeMs, recordStat: info }, info, {
      fsImpl: fs, roots: { 'project-state': path.join(projectRoot, '.doflow', 'state') }, now: Date.now(),
      settings: { staleTmpHours: 24 }, cache, storeDir,
    });
  };
  assert.equal(recheck('feat-a', 'T.5.json'), false);
  // Control: feature B's own record, with its own finished run and checked plan, still passes the recheck.
  writeRecord(projectRoot, { taskId: 'T.5', namespace: 'feat-b', mtimeMs: OLD });
  assert.equal(recheck('feat-b', 'T.5.json'), true);
});

test('C-1 a delimited-prefix id takes only a prefix run it owns', (t) => {
  const projectRoot = setup(t);
  writePlan(projectRoot, 'feat-a', '- [ ] T.5-x do it\n');
  writePlan(projectRoot, 'feat-b', '- [x] T.5 done\n');
  writeRecord(projectRoot, { taskId: 'T.5-x', namespace: 'feat-a', mtimeMs: OLD });
  writeNamespacedRun(projectRoot, 'feat-b', 'T.5', { state: 'COMPLETED', featureSlug: 'feat-b', updatedAt: OLD_ISO });
  assert.deepEqual(status(projectRoot, { taskId: 'T.5-x', namespace: 'feat-a', mtimeMs: OLD }), {
    state: 'open', since: null, reason: 'plan-unchecked', run: null, feature: 'feat-a',
  });
});

test('C-1 a namespaced record reads its own copy first and the flat run, never another namespace\'s copy', (t) => {
  const projectRoot = setup(t);
  writePlan(projectRoot, 'feat-a');
  writePlan(projectRoot, 'feat-b');
  writeRecord(projectRoot, { taskId: 'T.6', namespace: 'feat-a', mtimeMs: OLD });
  writeNamespacedRun(projectRoot, 'feat-b', 'T.6', { state: 'RUNNING', featureSlug: 'feat-b' });
  assert.equal(status(projectRoot, { taskId: 'T.6', namespace: 'feat-a', mtimeMs: OLD }).run, null, 'another namespace\'s live run is not this record\'s run');
  writeRun(projectRoot, 'T.6', { state: 'RUNNING', featureSlug: 'feat-a' });
  assert.equal(status(projectRoot, { taskId: 'T.6', namespace: 'feat-a', mtimeMs: OLD }).reason, 'run-open', 'the flat run is still read');
  writeNamespacedRun(projectRoot, 'feat-a', 'T.6', { state: 'COMPLETED', featureSlug: 'feat-a', updatedAt: OLD_ISO });
  assert.equal(status(projectRoot, { taskId: 'T.6', namespace: 'feat-a', mtimeMs: OLD }).reason, 'run-open', 'an open copy still wins over a finished one');
});

test('C-1 a flat record that two namespaced copies could claim is undecidable, one claimant is read as before', (t) => {
  const projectRoot = setup(t);
  writePlan(projectRoot, 'feat-a');
  writePlan(projectRoot, 'feat-b');
  writeRecord(projectRoot, { taskId: 'T.7', mtimeMs: OLD });
  writeNamespacedRun(projectRoot, 'feat-a', 'T.7', { state: 'COMPLETED', featureSlug: 'feat-a', updatedAt: OLD_ISO });
  assert.equal(status(projectRoot, { taskId: 'T.7', mtimeMs: OLD }).state, 'finished');
  writeNamespacedRun(projectRoot, 'feat-b', 'T.7', { state: 'COMPLETED', featureSlug: 'feat-b', updatedAt: OLD_ISO });
  assert.deepEqual(status(projectRoot, { taskId: 'T.7', mtimeMs: OLD }), {
    state: 'undecidable', since: null, reason: 'run-unreadable', run: 'T.7', feature: null,
  });
  // The same holds through a delimited prefix.
  writeRecord(projectRoot, { taskId: 'T.7-x', mtimeMs: OLD });
  assert.equal(status(projectRoot, { taskId: 'T.7-x', mtimeMs: OLD }).state, 'undecidable');
});

test('C-1 prune keeps feature A\'s open evidence while feature B\'s same-id run is finished', (t) => {
  const projectRoot = crossFeatureProject(t);
  const roots = Object.fromEntries(Object.entries(storageRegistry.roots).map(([id, r]) => [id, path.join(r.base === 'xdg-config' ? path.join(projectRoot, 'home', '.config') : r.base === 'home' ? path.join(projectRoot, 'home') : projectRoot, ...r.segments)]));
  const evidence = path.join(projectRoot, '.doflow', 'state', 'evidence', 'feat-a', 'T.5.json');
  const pass = () => runPass({ registry: storageRegistry, roots, stores: ['task-evidence', 'task-orchestration'], mode: 'prune',
    setting: Object.fromEntries(Object.keys(roots).map((id) => [id, 'on'])), now: Date.now() });
  pass();
  assert.equal(fs.existsSync(evidence), true, 'feature A\'s evidence for the unchecked task survives');
  // Control: once feature A's plan is checked, the same record is finished work and is pruned.
  writePlan(projectRoot, 'feat-a', '- [x] T.5 do it\n');
  writeRun(projectRoot, 'T.5', { state: 'COMPLETED', featureSlug: 'feat-a', updatedAt: OLD_ISO });
  pass();
  assert.equal(fs.existsSync(evidence), false);
});

// N-1 (maint-runtime-b re-review): a namespaced run copy may only KEEP a record open. Otherwise a record
// is judged exactly as 135ce230 judged it: by the flat run copy alone, the base prefix rules and the
// record's own feature. A flat record takes a namespaced copy only when the namespace is its own feature.
const PRUNE_ROOTS = (projectRoot) => Object.fromEntries(Object.entries(storageRegistry.roots).map(([id, r]) => [id, path.join(r.base === 'xdg-config' ? path.join(projectRoot, 'home', '.config') : r.base === 'home' ? path.join(projectRoot, 'home') : projectRoot, ...r.segments)]));

function prune(projectRoot) {
  const roots = PRUNE_ROOTS(projectRoot);
  runPass({ registry: storageRegistry, roots, stores: ['task-evidence'], mode: 'prune',
    setting: Object.fromEntries(Object.keys(roots).map((id) => [id, 'on'])), now: Date.now() });
}

const recordFile = (projectRoot, namespace, id) => path.join(projectRoot, '.doflow', 'state', 'evidence', ...(namespace ? [namespace] : []), `${id}.json`);
const done = (feature, updatedAt = OLD_ISO) => ({ state: 'COMPLETED', featureSlug: feature, updatedAt });

// Each case: [name, build(projectRoot) -> evidence file, survives at 135ce230 and at head]
const N1_CASES = [
  ['S3 flat legacy record, another feature\'s namespaced run of the same id finished', (p) => {
    writePlan(p, 'feat-a', '- [ ] T.5 x\n'); writePlan(p, 'feat-b', '- [x] T.5 x\n');
    writeNamespacedRun(p, 'feat-b', 'T.5', done('feat-b'));
    return writeRecord(p, { taskId: 'T.5', mtimeMs: OLD });
  }, true],
  ['X1 flat record naming feature A, feature B\'s namespaced run of the same id finished', (p) => {
    writePlan(p, 'A', '- [ ] T.5 x\n'); writePlan(p, 'B', '- [x] T.5 x\n');
    writeNamespacedRun(p, 'B', 'T.5', done('B'));
    return writeRecord(p, { taskId: 'T.5', value: { featureSlug: 'A' }, mtimeMs: OLD });
  }, true],
  ['X4 flat record, a longer prefix run in another feature never beats the flat RUNNING prefix run', (p) => {
    writePlan(p, 'A', '- [x] y\n'); writePlan(p, 'B', '- [x] y\n');
    writeRun(p, 'T.5', { state: 'RUNNING', featureSlug: 'A' });
    writeNamespacedRun(p, 'B', 'T.5-x', done('B'));
    return writeRecord(p, { taskId: 'T.5-x.1', value: { featureSlug: 'A' }, mtimeMs: OLD });
  }, true],
  ['S4 own namespaced run finished never overrides an unreadable flat run', (p) => {
    writePlan(p, 'feat-a', '- [x] T.5 x\n');
    writeNamespacedRun(p, 'feat-a', 'T.5', done('feat-a'));
    fs.writeFileSync(path.join(p, '.doflow', 'state', 'orchestration', 'T.5.json'), '{garbage');
    return writeRecord(p, { taskId: 'T.5', namespace: 'feat-a', mtimeMs: OLD });
  }, true],
  ['S5 own namespaced run finished never overrides a RUNNING flat prefix run', (p) => {
    writePlan(p, 'feat-a', '- [x] T.5-x x\n');
    writeNamespacedRun(p, 'feat-a', 'T.5-x', done('feat-a'));
    writeRun(p, 'T.5', { state: 'RUNNING' });
    return writeRecord(p, { taskId: 'T.5-x', namespace: 'feat-a', mtimeMs: OLD });
  }, true],
  ['X3 own namespaced run finished never overrides the flat run\'s other feature (unchecked)', (p) => {
    writePlan(p, 'A', '- [x] T.5 x\n'); writePlan(p, 'B', '- [ ] T.5 x\n');
    writeNamespacedRun(p, 'A', 'T.5', done('A'));
    writeRun(p, 'T.5', done('B'));
    return writeRecord(p, { taskId: 'T.5', namespace: 'A', mtimeMs: OLD });
  }, true],
  ['X5 a recently updated flat copy sets the idle time, not the older namespaced copy', (p) => {
    writePlan(p, 'A', '- [x] T.5 x\n');
    writeNamespacedRun(p, 'A', 'T.5', done('A'));
    writeRun(p, 'T.5', done('A', new Date(Date.now() - DAY).toISOString()));
    return writeRecord(p, { taskId: 'T.5', namespace: 'A', mtimeMs: OLD });
  }, true],
  // Controls: the shapes 135ce230 also prunes are still pruned, and a live owned copy keeps its record.
  ['S2 control: a flat run copy still judges a namespaced record, as at 135ce230', (p) => {
    writePlan(p, 'feat-a', '- [ ] T.5 x\n'); writePlan(p, 'feat-b', '- [x] T.5 x\n');
    writeRun(p, 'T.5', done('feat-b'));
    return writeRecord(p, { taskId: 'T.5', namespace: 'feat-a', mtimeMs: OLD });
  }, false],
  ['S7 control: no run, plan checked', (p) => {
    writePlan(p, 'feat-a', '- [x] T.5 x\n');
    return writeRecord(p, { taskId: 'T.5', namespace: 'feat-a', mtimeMs: OLD });
  }, false],
  ['S8 an own namespaced RUNNING copy keeps its record', (p) => {
    writePlan(p, 'feat-a', '- [x] T.5 x\n');
    writeNamespacedRun(p, 'feat-a', 'T.5', { state: 'RUNNING', featureSlug: 'feat-a' });
    return writeRecord(p, { taskId: 'T.5', namespace: 'feat-a', mtimeMs: OLD });
  }, true],
  ['S9 a flat record naming its feature keeps while that feature\'s namespaced copy is AWAITING_GATE', (p) => {
    writePlan(p, 'feat-a', '- [x] T.5 x\n');
    writeNamespacedRun(p, 'feat-a', 'T.5', { state: 'AWAITING_GATE', featureSlug: 'feat-a' });
    return writeRecord(p, { taskId: 'T.5', value: { featureSlug: 'feat-a' }, mtimeMs: OLD });
  }, true],
];

for (const [name, build, survives] of N1_CASES) {
  test(`N-1 prune: ${name}`, (t) => {
    const projectRoot = setup(t);
    const file = build(projectRoot);
    prune(projectRoot);
    assert.equal(fs.existsSync(file), survives);
  });
}

test('N-1 the locked recheck agrees with selection for a flat record and for a foreign namespaced run', (t) => {
  const projectRoot = setup(t);
  writePlan(projectRoot, 'feat-a', '- [ ] T.5 x\n'); writePlan(projectRoot, 'feat-b', '- [x] T.5 x\n');
  writeNamespacedRun(projectRoot, 'feat-b', 'T.5', done('feat-b'));
  writeRecord(projectRoot, { taskId: 'T.5', mtimeMs: OLD });
  const storeDir = path.join(projectRoot, '.doflow', 'state', 'evidence');
  const store = storageRegistry.stores.find((s) => s.id === 'task-evidence');
  const info = fs.lstatSync(path.join(storeDir, 'T.5.json'));
  const recheck = () => recordStillCandidate(store, { name: 'T.5.json', reason: 'finished-work', mtimeMs: OLD, recordStat: info }, info, {
    fsImpl: fs, roots: { 'project-state': path.join(projectRoot, '.doflow', 'state') }, now: Date.now(),
    settings: { staleTmpHours: 24 }, cache: createWorkCache({ projectRoot }), storeDir,
  });
  assert.equal(recheck(), false);
  assert.equal(status(projectRoot, { taskId: 'T.5', mtimeMs: OLD }).state, 'open');
});

// ---- Property: whatever the layout, head deletes only what 135ce230 deletes. ----
// `baseDeletes` is a faithful copy of the 135ce230 selection (flat run copies only; W1-W9) for a per-task
// record in the task-evidence store; it does not call the code under test.
const BASE_RUN_STATES = new Set(['RUNNING', 'AWAITING_GATE', 'COMPLETED', 'REJECTED']);
const BASE_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const baseSafe = (v) => typeof v === 'string' && BASE_SAFE.test(v) && !v.includes('..');
function baseDeletes(projectRoot, { id, namespace, mtimeMs, now }) {
  const state = path.join(projectRoot, '.doflow', 'state');
  const ls = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
  const runNames = ls(path.join(state, 'orchestration')).filter((e) => e.name.endsWith('.json')).map((e) => e.name.slice(0, -5));
  let exact = false, ns = false, prefix = null;
  for (const c of runNames) {
    if (c === id) exact = true;
    else if (baseSafe(namespace) && c === namespace) ns = true;
    else if ((id.startsWith(`${c}-`) || id.startsWith(`${c}.`)) && (!prefix || c.length > prefix.length || (c.length === prefix.length && c < prefix))) prefix = c;
  }
  const runId = exact ? id : ns ? namespace : prefix;
  let run = null;
  if (runId) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(state, 'orchestration', `${runId}.json`), 'utf8'));
      if (!(v && typeof v === 'object' && !Array.isArray(v) && BASE_RUN_STATES.has(v.state))) return false;
      run = v;
    } catch { return false; }
  }
  let record;
  try { record = JSON.parse(fs.readFileSync(path.join(state, 'evidence', ...(namespace ? [namespace] : []), `${id}.json`), 'utf8')); } catch { return false; }
  if (run && (run.state === 'RUNNING' || run.state === 'AWAITING_GATE')) return false;
  const str = (o, k) => (o && typeof o === 'object' && typeof o[k] === 'string' && o[k] !== '' ? o[k] : null);
  let feature = str(run, 'featureSlug') || str(record, 'featureSlug') || str(record, 'slug') || (baseSafe(namespace) ? namespace : null);
  const featureDirs = ls(path.join(projectRoot, 'agent-docs', 'doflow')).filter((e) => e.isDirectory() && baseSafe(e.name)).map((e) => e.name);
  if (!feature) {
    let best = null;
    for (const n of featureDirs) if ((id === n || id.startsWith(`${n}-`) || id.startsWith(`${n}.`)) && (!best || n.length > best.length || (n.length === best.length && n < best))) best = n;
    feature = best;
  }
  const readPlanText = (f) => { try { return { text: fs.readFileSync(path.join(projectRoot, 'agent-docs', 'doflow', f, 'plan.md'), 'utf8') }; } catch (e) { return e.code === 'ENOENT' ? { missing: true, folder: fs.existsSync(path.join(projectRoot, 'agent-docs', 'doflow', f)) } : { bad: true }; } };
  if (feature) {
    if (!baseSafe(feature)) return false;
    const plan = readPlanText(feature);
    if (plan.bad) return false;
    if (plan.missing) return false; // folder gone (feature-missing) or plan missing (open): kept either way
    if (/^\s*- \[ \] /m.test(plan.text)) return false;
  } else {
    for (const f of featureDirs) {
      const plan = readPlanText(f);
      if (plan.bad) return false;
      if (plan.missing) continue;
      for (const m of plan.text.matchAll(/^\s*- \[ \] (\S+)/gm)) if (m[1] === id) return false;
    }
  }
  const runEnd = run ? Date.parse(run.updatedAt) : NaN;
  const since = Number.isFinite(runEnd) ? Math.max(runEnd, mtimeMs) : mtimeMs;
  const store = storageRegistry.stores.find((s) => s.id === 'task-evidence');
  return now - since > store.bound.finishedDays * DAY;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const COPY_STATES = ['none', 'none', 'RUNNING', 'AWAITING_GATE', 'COMPLETED', 'COMPLETED-recent', 'unparseable'];
function makeLayout(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const id = pick(['T.5', 'T.5-x', 'T.5-x.1']);
  const runId = () => pick([id, id, 'T.5', 'T.5-x']);
  const flatRecord = rand() < 0.5;
  return {
    id,
    namespace: flatRecord ? null : 'feat-a',
    recordFeature: flatRecord ? pick([null, null, 'feat-a', 'feat-b', 'feat-c']) : pick([null, null, 'feat-b']),
    plans: { 'feat-a': pick(['checked', 'unchecked']), 'feat-b': pick(['checked', 'unchecked']) },
    copies: [
      ...['feat-a', 'feat-b'].map((where) => ({ where, id: runId(), state: pick(COPY_STATES), feature: pick([where, where, 'feat-a', 'feat-b', null]) })),
      { where: '', id: runId(), state: pick(COPY_STATES), feature: pick(['feat-a', 'feat-b', null]) },
    ],
  };
}

function buildLayout(projectRoot, layout) {
  for (const [feature, kind] of Object.entries(layout.plans)) {
    writePlan(projectRoot, feature, kind === 'checked' ? `- [x] ${layout.id} x\n` : `- [ ] ${layout.id} x\n`);
  }
  const seen = new Set();
  for (const copy of layout.copies) {
    if (copy.state === 'none' || seen.has(`${copy.where}/${copy.id}`)) continue;
    seen.add(`${copy.where}/${copy.id}`);
    const file = path.join(projectRoot, '.doflow', 'state', 'orchestration', ...(copy.where ? [copy.where] : []), `${copy.id}.json`);
    if (copy.state === 'unparseable') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{garbage'); continue; }
    const value = { state: copy.state.startsWith('COMPLETED') ? 'COMPLETED' : copy.state };
    if (copy.feature) value.featureSlug = copy.feature;
    if (value.state === 'COMPLETED') value.updatedAt = copy.state === 'COMPLETED-recent' ? new Date(Date.now() - DAY).toISOString() : OLD_ISO;
    writeJson(file, value);
  }
  return writeRecord(projectRoot, { taskId: layout.id, namespace: layout.namespace, value: layout.recordFeature ? { featureSlug: layout.recordFeature } : {}, mtimeMs: OLD });
}

test('N-1 property: over mixed flat, namespaced and foreign layouts, head prunes only what 135ce230 prunes', (t) => {
  const rand = mulberry32(0xC1);
  const base = setup(t);
  let deletedByBoth = 0;
  const LAYOUTS = 400;
  for (let n = 0; n < LAYOUTS; n += 1) {
    const layout = makeLayout(rand);
    const projectRoot = path.join(base, `l${n}`);
    fs.mkdirSync(path.join(projectRoot, '.doflow', 'state'), { recursive: true });
    const file = buildLayout(projectRoot, layout);
    const now = Date.now();
    const baseDeleted = baseDeletes(projectRoot, { id: layout.id, namespace: layout.namespace, mtimeMs: OLD, now });
    prune(projectRoot);
    const headDeleted = !fs.existsSync(file);
    assert.ok(!headDeleted || baseDeleted, `layout ${n} deleted at head but kept at 135ce230: ${JSON.stringify(layout)}`);
    if (baseDeleted && headDeleted) deletedByBoth += 1;
  }
  // The generator reaches both outcomes; a property that never deleted would prove nothing.
  assert.ok(deletedByBoth > 20, `expected many layouts both versions prune, saw ${deletedByBoth}`);
});

// N-4: base never read the run-namespace folders, so a FIFO or a link there must not block retention
// or make a record finishable; it reads as unreadable and the record is kept.
test('N-4 a FIFO in the record\'s run namespace folder neither hangs retention nor lets the record finish', { skip: process.platform === 'win32' }, (t) => {
  const { spawnSync } = require('node:child_process');
  const projectRoot = setup(t);
  writePlan(projectRoot, 'feat-a');
  writeRecord(projectRoot, { taskId: 'T.5', namespace: 'feat-a', mtimeMs: 1 });
  const fifo = path.join(projectRoot, '.doflow', 'state', 'orchestration', 'feat-a', 'T.5.json');
  fs.mkdirSync(path.dirname(fifo), { recursive: true });
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const script = `const { workStatus } = require(${JSON.stringify(path.join(__dirname, '../../src/runtime/storage/work-status.ts'))});
    process.stdout.write(JSON.stringify(workStatus({ projectRoot: ${JSON.stringify(projectRoot)}, store: 'task-evidence', taskId: 'T.5', namespace: 'feat-a', mtimeMs: 1 })));`;
  const ran = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL' });
  assert.equal(ran.error, undefined, `retention blocked on the FIFO: ${ran.error && ran.error.code}`);
  const answer = JSON.parse(ran.stdout);
  assert.notEqual(answer.state, 'finished', 'a record whose run copy cannot be read is kept');
  assert.equal(answer.reason, 'run-unreadable');
  // Control: the same layout with a regular, finished namespaced copy is not read as a hold either way.
  fs.rmSync(fifo);
  writeNamespacedRun(projectRoot, 'feat-a', 'T.5', { state: 'COMPLETED', featureSlug: 'feat-a', updatedAt: '2026-01-01T00:00:00.000Z' });
  const control = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL' });
  assert.notEqual(JSON.parse(control.stdout).reason, 'run-unreadable');
});
