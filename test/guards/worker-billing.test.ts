'use strict';

// G58 — every worker descriptor declares a closed-set billing classification (FR-018, IC-012).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadRegistry, validateWorker } = require('../../src/registry/index.ts');

const REPO = path.resolve(__dirname, '../..');
const BILLING: any = ['free', 'metered', 'unknown'];

test('G58: every shipped worker descriptor declares unknown billing', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.ok(registry.harnesses.length > 0);
  for (const harness of registry.harnesses) {
    assert.equal(harness.worker.billing, 'unknown', `${harness.id} worker.billing`);
  }
});

test('G58: validateWorker accepts exactly the closed billing set and rejects missing or other values', (): any => {
  const registry = loadRegistry({ repoRoot: REPO });
  const base = registry.harnesses[0].worker;
  for (const billing of BILLING) {
    const errors: any = [];
    validateWorker({ ...structuredClone(base), billing }, "harness 'fixture'", errors);
    assert.deepEqual(errors, [], `${billing}: ${errors.join('; ')}`);
  }

  for (const value of [undefined, 'paid', null, {}]) {
    const worker = structuredClone(base);
    if (value === undefined) delete worker.billing;
    else worker.billing = value;
    const errors: any = [];
    validateWorker(worker, "harness 'fixture'", errors);
    assert.ok(errors.some((message: any) => message.includes("worker 'billing'")), `${JSON.stringify(value)}: ${errors.join('; ')}`);
  }
});
