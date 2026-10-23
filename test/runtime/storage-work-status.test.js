'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
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
  writeRecord(projectRoot, { taskId: 'task-2' });
  writeNamespacedRun(projectRoot, 'feat-b', 'task-2', { state: 'AWAITING_GATE', featureSlug: 'feat-b' });
  assert.equal(status(projectRoot, { taskId: 'task-2', mtimeMs: 1 }).reason, 'run-open');
  assert.equal(status(projectRoot, { taskId: 'task-2', mtimeMs: 1 }).run, 'task-2');
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
  assert.equal(done.state, 'finished');
  assert.equal(done.reason, 'run-finished');
  assert.equal(done.run, 'task-4');
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
