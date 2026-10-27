'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadRegistry } = require('../../src/registry/index.ts');
const {
  workerIdFault, classifyWorkerId, shippedWorkerIds, knownWorkerIds, BUILTIN_WORKER_ID_RE, RESERVED_WORKER_IDS,
} = require('../../src/registry/worker-ids.ts');
const { workerCatalogue, descriptorDigest } = require('../../src/runtime/worker/catalogue.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

test('workerCatalogue equals harness worker blocks in registry order', () => {
  const reg = loadRegistry({ repoRoot: REPO_ROOT });
  const expected = (reg.harnesses || [])
    .filter((h: any) => h.worker && typeof h.worker === 'object')
    .map((h: any) => ({
      id: h.id,
      worker: h.worker,
      origin: 'builtin',
      descriptorDigest: descriptorDigest(h.worker),
    }));

  const actual = workerCatalogue({ registry: reg });
  assert.deepEqual(actual, expected);
});

test('knownWorkerIds equals registry harnesses with worker blocks', () => {
  const reg = loadRegistry({ repoRoot: REPO_ROOT });
  const expectedIds = (reg.harnesses || [])
    .filter((h: any) => h.worker && typeof h.worker === 'object')
    .map((h: any) => h.id);

  const { ids } = knownWorkerIds({ registry: reg });
  assert.deepEqual(ids, expectedIds);
  assert.deepEqual(shippedWorkerIds(reg), expectedIds);
});

test('workerIdFault accepts built-ins and qualified ids only', () => {
  // Built-in harness ids pass
  for (const id of ['claude', 'codex', 'antigravity', 'pi', 'opencode', 'copilot', 'kiro']) {
    assert.equal(workerIdFault(id), null);
  }

  // Valid qualified ids pass
  assert.equal(workerIdFault('acme.coder'), null);
  assert.equal(workerIdFault('my-pkg.worker-1'), null);

  // Reserved ids are caught
  for (const reserved of RESERVED_WORKER_IDS) {
    assert.deepEqual(workerIdFault(reserved), { code: 'reserved', reason: 'worker id is reserved' });
  }

  // Dotted ids that break qualified grammar are rejected
  assert.equal(workerIdFault('a..b')?.code, 'type');
  assert.equal(workerIdFault('pkg.sub.worker')?.code, 'type');
  assert.equal(workerIdFault('.worker')?.code, 'type');
  assert.equal(workerIdFault('pkg.')?.code, 'type');
  assert.equal(workerIdFault('acme..coder')?.code, 'type');
  assert.equal(workerIdFault('acme.c')?.code, 'type');
  assert.equal(workerIdFault('a.coder')?.code, 'type');
  assert.equal(workerIdFault('acme--x.coder')?.code, 'type');
  assert.equal(workerIdFault(`${'a'.repeat(17)}.${'b'.repeat(15)}`)?.code, 'type');

  // Malformed non-dotted ids
  assert.equal(workerIdFault('Codex')?.code, 'type');
  assert.equal(workerIdFault('123abc')?.code, 'type');
  assert.equal(workerIdFault('-invalid')?.code, 'type');
  assert.equal(workerIdFault('a'.repeat(33))?.code, 'type');
  assert.equal(workerIdFault(123)?.code, 'type');
  assert.equal(workerIdFault(null)?.code, 'type');
});

test('classifyWorkerId distinguishes ok, malformed, reserved, and dangling', () => {
  const known = ['codex', 'claude'];
  assert.equal(classifyWorkerId('codex', known), 'ok');
  assert.equal(classifyWorkerId('claude', known), 'ok');
  assert.equal(classifyWorkerId('antigravity', known), 'dangling');
  assert.equal(classifyWorkerId('acme.coder', known), 'dangling');
  assert.equal(classifyWorkerId('primary', known), 'reserved');
  assert.equal(classifyWorkerId('INVALID', known), 'malformed');
});
