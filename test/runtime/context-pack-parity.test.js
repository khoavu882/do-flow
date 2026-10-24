'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { handleContextPackCommand, getCorrectiveTrimFallbackCount } = require('../../src/runtime/context-pack.ts');
const { getRegisteredHarnessIds } = require('../../src/runtime/context/budget.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');

function prepareFixture(t) {
  const root = tempDir(t, 'doflow-fx3-parity-');
  fs.cpSync(path.join(__dirname, '../../bench/perf/fixtures/context-pack-project'), root, { recursive: true });
  return root;
}

function runFixture(root, harness, maxBytes) {
  return runCli({ taskId: 'fx3-parity', taskClass: 'feature', stateRoot: root, slug: 'perf-feature', maxBytes,
    reason: 'FX.3 parity sweep', harness, json: true, noRecord: true });
}

function addEvidence(root, taskId) {
  const ledger = new EvidenceLedger({ repoRoot: root, slug: 'perf-feature' });
  ledger.load(taskId);
  for (let i = 0; i < 30; i += 1) {
    ledger.addEvidence({ taskId, kind: 'exact-search', locator: { file: `src/feature-${i}.ts` },
      content: `Perf fixture evidence ${i + 1}: ${'implementation detail '.repeat(8)}`, freshness: { status: 'FRESH' } });
  }
  ledger.save(taskId);
}

function runCli(options) {
  let out = '';
  const log = console.log;
  const exitCode = process.exitCode;
  console.log = (value) => { out += value; };
  try { return { code: handleContextPackCommand(options), get out() { return out; } }; }
  finally { console.log = log; process.exitCode = exitCode; }
}

test('context-pack-parity: perf fixture preserves digest and exit for all registered harnesses across cap sweep', (t) => {
  const ids = getRegisteredHarnessIds();
  assert.equal(ids.length, 8, 'registry harness set has eight ids');
  const root = prepareFixture(t);
  addEvidence(root, 'fx3-parity');
  const roomy = runFixture(root, ids[0], 50000);
  const mandatorySize = JSON.parse(roomy.out).size.mandatoryBytes;
  const caps = new Set([9760, 10072, 10194]);
  for (let cap = mandatorySize - 100; cap <= mandatorySize + 200; cap += 10) caps.add(cap);
  const mandatoryByForm = new Map();
  const mandatoryAcrossHarnesses = new Map();
  const successful = [];

  for (const cap of [...caps].sort((a, b) => a - b)) {
    let expected;
    for (const id of ids) {
      const result = runFixture(root, id, cap);
      const pack = JSON.parse(result.out);
      const actual = { digest: pack.delivery.packDigest, exitCode: result.code };
      if (!expected) expected = actual;
      assert.deepEqual(actual, expected, `${id} differs at ${cap} B`);
      assert.equal(pack.size.mandatoryBytes + pack.size.optionalBytes, pack.size.totalBytes, `size accounting at ${cap} B`);
      const mandatoryKey = `${id}:${String(cap).length}`;
      if (mandatoryByForm.has(mandatoryKey)) assert.equal(pack.size.mandatoryBytes, mandatoryByForm.get(mandatoryKey), `${id} mandatory bytes changed at ${cap} B`);
      else mandatoryByForm.set(mandatoryKey, pack.size.mandatoryBytes);
      const harnessParityKey = String(cap).length;
      if (mandatoryAcrossHarnesses.has(harnessParityKey)) assert.equal(pack.size.mandatoryBytes, mandatoryAcrossHarnesses.get(harnessParityKey), `${id} mandatory bytes differ across harnesses at ${cap} B`);
      else mandatoryAcrossHarnesses.set(harnessParityKey, pack.size.mandatoryBytes);
      if (pack.overflow) assert.equal(pack.overflow.mandatoryBytes, pack.size.mandatoryBytes);
      if (pack.status === 'OK') successful.push({ cap, bytes: pack.size.totalBytes });
    }
  }
  const slackCase = successful.reduce((best, current) => current.cap - current.bytes > best.cap - best.bytes ? current : best, { cap: 0, bytes: 0 });
  if (slackCase.cap > slackCase.bytes) {
    for (let intermediateCap = slackCase.bytes; intermediateCap <= slackCase.cap; intermediateCap += 1) {
      const candidate = runFixture(root, ids[0], intermediateCap);
      assert.notEqual(candidate.code, 3, `false overflow at ${intermediateCap} B although ${slackCase.bytes} B pack fit at ${slackCase.cap} B`);
    }
  }
  assert.equal(getCorrectiveTrimFallbackCount(), 0, 'counted corrective trim fallback remains unused across the sweep');
});

test('context-pack-parity: CLI pi and antigravity agree through the tight fit boundary', (t) => {
  const root = prepareFixture(t);
  addEvidence(root, 'fx3-parity');
  for (let cap = 9500; cap <= 10000; cap += 1) {
    const first = runFixture(root, 'pi', cap);
    const second = runFixture(root, 'antigravity', cap);
    assert.equal(first.code, second.code, `exit code differs at ${cap} B`);
    assert.equal(JSON.parse(first.out).delivery.packDigest, JSON.parse(second.out).delivery.packDigest, `digest differs at ${cap} B`);
  }
});
