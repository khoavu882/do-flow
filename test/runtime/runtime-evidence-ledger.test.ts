'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tempDir } = require('../helper/tmp.ts');
const fs = require('node:fs');
const path = require('node:path');
const { EvidenceLedger, VALID_EVIDENCE_KINDS } = require('../../src/runtime/evidence-ledger.ts');
const { EVIDENCE_SCORE_FIELDS } = require('../../src/runtime/evidence-fields.ts');

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

test('EvidenceLedger saves and loads task evidence to neutral JSON state', (t) => {
  const tmpDir = tempDir(t, 'doflow-runtime-evidence-ledger-');
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
});

// Regression: taskId is interpolated straight into a filename, so an id naming a path resolved
// clean out of the state directory. Read-only today only because nothing calls save() — it becomes
// an arbitrary file write the moment a writer is wired up.
test('a task id that names a path is rejected rather than resolved out of the state dir', (t) => {
  const tmpDir = tempDir(t, 'doflow-runtime-evidence-ledger-taskid-');
  const ledger = new EvidenceLedger({ stateDir: tmpDir });
  for (const bad of ['../../../etc/passwd', '../escape', 'a/b', '.', '..', '', 'x y']) {
    assert.throws(() => ledger.load(bad), /Invalid task id/, `must reject ${JSON.stringify(bad)}`);
    assert.throws(() => ledger.save(bad), /Invalid task id/, `must reject ${JSON.stringify(bad)}`);
  }
});

test('ordinary task ids are still accepted', (t) => {
  const tmpDir = tempDir(t, 'doflow-runtime-evidence-ledger-taskid-ok-');
  const ledger = new EvidenceLedger({ stateDir: tmpDir });
  for (const good of ['default', 'test-1', 'FEAT_003.a', '005-evidence-ledger']) {
    assert.equal(ledger.load(good), 0, `${good} should load cleanly (absent file -> 0)`);
  }
});

test('EvidenceLedger.addEvidence({ score }) throws and registers nothing', () => {
  const ledger = new EvidenceLedger();
  assert.throws(() => {
    ledger.addEvidence({ kind: 'exact-search', score: 0.95 });
  }, /'score' is a retrieval score/);
  assert.equal(ledger.getAllEvidence().length, 0);
});

test('EvidenceLedger.addEvidence({ source: { rank } }) throws and registers nothing', () => {
  const ledger = new EvidenceLedger();
  assert.throws(() => {
    ledger.addEvidence({ kind: 'exact-search', source: { provider: 'native.rg', rank: 1 } });
  }, /'source\.rank' is a retrieval score/);
  assert.equal(ledger.getAllEvidence().length, 0);
});

test('a legacy ledger fixture loads byte-identical without refusal', (t) => {
  const tmpDir = tempDir(t, 'doflow-legacy-ledger-');
  const legacyRecord = {
    taskId: 'legacy-task',
    updatedAt: '2026-01-01T00:00:00.000Z',
    evidenceCount: 1,
    evidence: [
      {
        id: 'ev_legacy_1',
        taskId: 'legacy-task',
        kind: 'exact-search',
        provenance: 'extracted',
        source: { provider: 'legacy-provider', rank: 1 },
        locator: { file: 'legacy.js' },
        score: 0.95,
        freshness: { status: 'FRESH' },
        status: 'active',
      },
    ],
  };
  const filePath = path.join(tmpDir, 'legacy-task.json');
  fs.writeFileSync(filePath, JSON.stringify(legacyRecord, null, 2), 'utf8');

  const ledger = new EvidenceLedger({ stateDir: tmpDir });
  const count = ledger.load('legacy-task');
  assert.equal(count, 1);
  const loaded = ledger.getEvidence('ev_legacy_1');
  assert.deepEqual(loaded, legacyRecord.evidence[0]);
});

test('workflow-orchestrator tools-used items carry no score key and add cleanly to ledger', () => {
  const toolsUsedItem = {
    taskId: 'task_orch',
    kind: 'generated-analysis',
    provenance: 'asserted',
    source: { provider: 'native.mcp', capability: 'tools.consult' },
    content: 'Tools used: sem=used',
    locator: { file: 'docs/report.md', line: 10 },
    establishes: [],
  };
  for (const field of EVIDENCE_SCORE_FIELDS) {
    assert.equal(field in toolsUsedItem, false);
    assert.equal(field in toolsUsedItem.source, false);
  }
  const ledger = new EvidenceLedger();
  const id = ledger.addEvidence(toolsUsedItem);
  assert.ok(id);
  assert.equal(ledger.getEvidence(id).kind, 'generated-analysis');
});
