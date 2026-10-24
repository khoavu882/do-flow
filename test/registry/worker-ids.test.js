'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { loadRegistry } = require('../../src/registry/index.ts');
const { WORKER_ID_MAX, workerIdFault, isQualifiedId, classifyWorkerId, shippedWorkerIds, knownWorkerIds } = require('../../src/registry/worker-ids.ts');
const { workerCatalogue } = require('../../src/runtime/worker/catalogue.ts');
const { descriptorDigest } = require('../../src/runtime/worker/readiness.ts');

const ROOT = path.resolve(__dirname, '../..');

test('worker id grammar and catalogue share the built-in registry', () => {
  const registry = loadRegistry({ repoRoot: ROOT });
  assert.equal(registry.validation.ok, true);
  const harnessIds = registry.harnesses.map((harness) => harness.id);
  const knownIds = knownWorkerIds({ registry }).ids;
  const catalogue = workerCatalogue({ registry });

  for (const id of harnessIds) assert.equal(workerIdFault(id), null, id);
  assert.equal(workerIdFault('a'.repeat(WORKER_ID_MAX + 1)).code, 'type');
  for (const id of ['Codex', 'a..b', '-x', '']) assert.equal(workerIdFault(id).code, 'type', id);
  assert.equal(workerIdFault(7).code, 'type');
  for (const id of ['primary', 'held']) assert.equal(workerIdFault(id).code, 'reserved', id);

  assert.equal(workerIdFault('acme.coder'), null);
  assert.equal(isQualifiedId('acme.coder'), true);
  assert.equal(isQualifiedId('codex'), false);
  for (const id of ['acme..coder', 'acme.c', 'a.coder', 'acme--x.coder', `${'a'.repeat(17)}.${'b'.repeat(15)}`]) {
    assert.equal(isQualifiedId(id), false, id);
  }

  assert.equal(classifyWorkerId('agy', knownIds), 'dangling');
  assert.equal(classifyWorkerId('codex', knownIds), 'ok');
  assert.equal(classifyWorkerId('Codex', knownIds), 'malformed');
  assert.equal(classifyWorkerId('primary', knownIds), 'reserved');
  assert.deepEqual(knownIds, harnessIds);
  assert.deepEqual(shippedWorkerIds(registry), harnessIds);
  assert.ok(catalogue.every((entry) => entry.origin === 'builtin'));
  for (const entry of catalogue) {
    const harness = registry.harnesses.find((item) => item.id === entry.id);
    assert.equal(entry.descriptorDigest, descriptorDigest(harness.worker));
  }
});

test('registry loader refuses a reserved harness id', (t) => {
  const copiedRegistry = tempDir(t, 'doflow-worker-ids-');
  fs.cpSync(path.join(ROOT, 'core/registry'), copiedRegistry, { recursive: true });
  const harnessesFile = path.join(copiedRegistry, 'harnesses.json');
  const harnesses = JSON.parse(fs.readFileSync(harnessesFile, 'utf8'));
  harnesses.harnesses[0].id = 'primary';
  fs.writeFileSync(harnessesFile, JSON.stringify(harnesses));
  assert.throws(
    () => loadRegistry({ repoRoot: ROOT, dir: copiedRegistry }),
    /id 'primary' is a reserved worker id/,
  );
});
