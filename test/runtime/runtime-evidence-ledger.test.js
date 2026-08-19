'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { EvidenceLedger, VALID_EVIDENCE_KINDS } = require('../../src/runtime/evidence-ledger');

test('EvidenceLedger records evidence with valid kinds and locators', () => {
  const ledger = new EvidenceLedger();
  
  const id = ledger.addEvidence({
    taskId: 'task_001',
    kind: 'exact-search',
    source: { provider: 'native.rg', capability: 'code.exact-search' },
    locator: { file: 'src/runtime/capability-router.js', lineRange: [10, 25] },
    provenance: 'extracted',
    content: 'class CapabilityRouter {',
  });

  assert.ok(id.startsWith('ev_'));
  const retrieved = ledger.getEvidence(id);
  assert.ok(retrieved);
  assert.equal(retrieved.kind, 'exact-search');
  assert.equal(retrieved.provenance, 'extracted');
  assert.equal(retrieved.freshness.status, 'FRESH');
  assert.equal(retrieved.locator.file, 'src/runtime/capability-router.js');
});

test('EvidenceLedger rejects invalid evidence kinds or provenance', () => {
  const ledger = new EvidenceLedger();

  assert.throws(() => {
    ledger.addEvidence({ kind: 'invalid-kind-name' });
  }, /Invalid evidence kind/);

  assert.throws(() => {
    ledger.addEvidence({ kind: 'exact-search', provenance: 'hallucinated' });
  }, /Invalid provenance/);
});

test('EvidenceLedger queries evidence by filter criteria', () => {
  const ledger = new EvidenceLedger();

  ledger.addEvidence({ taskId: 't1', kind: 'exact-search', locator: { file: 'a.js' } });
  ledger.addEvidence({ taskId: 't1', kind: 'structural', locator: { file: 'b.js' } });
  ledger.addEvidence({ taskId: 't2', kind: 'exact-search', locator: { file: 'c.js' } });

  const t1Items = ledger.queryEvidence({ taskId: 't1' });
  assert.equal(t1Items.length, 2);

  const exactItems = ledger.queryEvidence({ kind: 'exact-search' });
  assert.equal(exactItems.length, 2);

  const bItems = ledger.queryEvidence({ file: 'b.js' });
  assert.equal(bItems.length, 1);
});

test('EvidenceLedger invalidates evidence referencing modified files', () => {
  const ledger = new EvidenceLedger();

  const id1 = ledger.addEvidence({ taskId: 't1', kind: 'exact-search', locator: { file: 'src/a.js' } });
  const id2 = ledger.addEvidence({ taskId: 't1', kind: 'exact-search', locator: { file: 'src/b.js' } });

  assert.equal(ledger.getEvidence(id1).freshness.status, 'FRESH');
  assert.equal(ledger.getEvidence(id2).freshness.status, 'FRESH');

  const invalidatedCount = ledger.invalidateFiles(['src/a.js']);
  assert.equal(invalidatedCount, 1);
  assert.equal(ledger.getEvidence(id1).freshness.status, 'STALE');
  assert.equal(ledger.getEvidence(id2).freshness.status, 'FRESH');
});

test('EvidenceLedger saves and loads task evidence to neutral JSON state', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-test-ev-'));
  const ledger1 = new EvidenceLedger({ stateDir: tmpDir });

  ledger1.addEvidence({
    id: 'ev_persist_1',
    taskId: 'task_persist',
    kind: 'documentation',
    source: { provider: 'context7', capability: 'docs.lookup' },
    content: 'API documentation for payment intents',
  });

  const filePath = ledger1.save('task_persist');
  assert.ok(fs.existsSync(filePath));

  const ledger2 = new EvidenceLedger({ stateDir: tmpDir });
  const count = ledger2.load('task_persist');
  assert.equal(count, 1);

  const loaded = ledger2.getEvidence('ev_persist_1');
  assert.ok(loaded);
  assert.equal(loaded.content, 'API documentation for payment intents');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Regression: taskId is interpolated straight into a filename, so an id naming a path resolved
// clean out of the state directory. Read-only today only because nothing calls save() — it becomes
// an arbitrary file write the moment a writer is wired up.
test('a task id that names a path is rejected rather than resolved out of the state dir', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-taskid-'));
  const ledger = new EvidenceLedger({ stateDir: tmpDir });
  for (const bad of ['../../../etc/passwd', '../escape', 'a/b', '.', '..', '', 'x y']) {
    assert.throws(() => ledger.load(bad), /Invalid task id/, `must reject ${JSON.stringify(bad)}`);
    assert.throws(() => ledger.save(bad), /Invalid task id/, `must reject ${JSON.stringify(bad)}`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('ordinary task ids are still accepted', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-taskid-ok-'));
  const ledger = new EvidenceLedger({ stateDir: tmpDir });
  for (const good of ['default', 'test-1', 'FEAT_003.a', '005-evidence-ledger']) {
    assert.equal(ledger.load(good), 0, `${good} should load cleanly (absent file -> 0)`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
