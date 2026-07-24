'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdapterRegistry } = require('../src/adapters');
const { defaultLedger, readLedger } = require('../src/state');
const { planLifecycle, applyLifecycle, removeLifecycle, normalizeRemovalVerification } = require('../src/lifecycle');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-'));
const registry = {
  harnesses: [{ id: 'fake', displayName: 'Fake', adapter: 'fake', scopes: ['project', 'user'], nativeTargets: {}, capabilities: { instructions: { status: 'supported' } } }],
  assets: [{ id: 'guidance.fake', kind: 'guidance', source: 'ignored', appliesTo: ['fake'], ownership: 'managed-file', projection: { fake: { renderer: 'fake', capability: 'instructions' } } }],
  mcp: [], lifecycle: [],
};

function fakeAdapter({ conflict = false, prerequisite = null } = {}) {
  const calls = [];
  return {
    calls,
    discover(input) { calls.push(['discover', input.harness.id]); return { existing: [] }; },
    render() { return 'native'; },
    plan(input) { return { changes: [{ assetId: 'guidance.fake', target: 'FAKE.md', operation: input.context.operation === 'remove' ? 'remove' : 'create', ownershipIdentity: 'fake:guidance', afterFingerprint: 'after' }], conflicts: conflict ? ['foreign file'] : [], prerequisites: prerequisite ? [prerequisite] : [] }; },
    apply(input) { calls.push(['apply', input.changes.length]); },
    remove(input) { calls.push(['remove', input.changes.length]); },
    verify(input) { calls.push(['verify', input.operation]); return { ok: true, resources: input.operation === 'remove' ? [] : [{ assetId: 'guidance.fake', target: 'FAKE.md', ownershipIdentity: 'fake:guidance', fingerprint: 'verified', sourceVersion: 'test', projection: { renderer: 'fake' } }] }; },
  };
}

test('planning is non-mutating and returns normalized adapter changes', () => {
  const adapter = fakeAdapter();
  const plan = planLifecycle({ registry, adapters: createAdapterRegistry({ fake: adapter }), scope: 'project', scopeRoot: root, targets: ['fake'] });
  assert.equal(plan.safe, true);
  assert.deepEqual(adapter.calls, [['discover', 'fake']]);
  assert.deepEqual(plan.changes[0], { assetId: 'guidance.fake', target: 'FAKE.md', operation: 'create', ownershipIdentity: 'fake:guidance', afterFingerprint: 'after', harness: 'fake' });
  assert.deepEqual(plan.targets[0].adapterInput.assets[0], {
    id: 'guidance.fake', kind: 'guidance', source: 'ignored', ownership: 'managed-file', renderer: 'fake',
    capability: 'instructions', capabilityStatus: 'supported', nativeTarget: null, prerequisites: [],
  });
});

test('apply refuses an empty native plan before journalling or ledger writes', () => {
  const adapter = fakeAdapter();
  adapter.plan = () => ({ changes: [] });
  const adapters = createAdapterRegistry({ fake: adapter });
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-state-'));
  const plan = planLifecycle({ registry, adapters, scope: 'project', scopeRoot: root, targets: ['fake'] });
  assert.throws(() => applyLifecycle({ plan, registry, adapters, stateRoot }), /no required native resources/);
  assert.ok(!fs.existsSync(path.join(stateRoot, 'ledger.json')));
  assert.ok(!fs.existsSync(path.join(stateRoot, 'recovery')));
});

test('apply journals, verifies, then persists only verified neutral ownership', () => {
  const adapter = fakeAdapter();
  const adapters = createAdapterRegistry({ fake: adapter });
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-state-'));
  const ledger = defaultLedger({ scope: 'project', scopeRoot: root });
  const plan = planLifecycle({ registry, adapters, scope: 'project', scopeRoot: root, ledger, targets: ['fake'] });
  const result = applyLifecycle({ plan, registry, adapters, stateRoot, ledger });
  assert.equal(result.verification.ok, true);
  assert.deepEqual(adapter.calls, [['discover', 'fake'], ['apply', 1], ['verify', 'apply']]);
  assert.equal(readLedger(stateRoot).resources[0].fingerprint, 'verified');
  assert.ok(fs.existsSync(path.join(stateRoot, 'recovery', `${result.recovery.id}.json`)));
});

test('conflicts and unmet prerequisites block apply before native mutation', () => {
  for (const options of [{ conflict: true }, { prerequisite: 'review native config' }]) {
    const adapter = fakeAdapter(options);
    const adapters = createAdapterRegistry({ fake: adapter });
    const plan = planLifecycle({ registry, adapters, scope: 'project', scopeRoot: root, targets: ['fake'] });
    assert.equal(plan.safe, false);
    assert.throws(() => applyLifecycle({ plan, registry, adapters, stateRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-state-')) }), /unsafe lifecycle plan/);
    assert.deepEqual(adapter.calls, [['discover', 'fake']]);
  }
});

test('adapter failures are promoted to lifecycle conflicts and fail closed', () => {
  const adapter = fakeAdapter();
  adapter.plan = () => ({ ok: false, changes: [], failures: [['config', { conflicts: ['foreign settings'] }]] });
  const plan = planLifecycle({ registry, adapters: createAdapterRegistry({ fake: adapter }), scope: 'project', scopeRoot: root, targets: ['fake'] });
  assert.equal(plan.safe, false);
  assert.deepEqual(plan.conflicts, [{ harness: 'fake', reason: 'config: foreign settings' }]);
});

test('remove lifecycle asks adapters for a remove plan and applies only after verification', () => {
  const adapter = fakeAdapter();
  const adapters = createAdapterRegistry({ fake: adapter });
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-state-'));
  const ledger = defaultLedger({ scope: 'project', scopeRoot: root });
  ledger.resources.push({ harness: 'fake', scope: 'project', assetId: 'guidance.fake', target: 'FAKE.md', ownershipIdentity: 'fake:guidance', fingerprint: 'owned' });
  const result = removeLifecycle({ registry, adapters, scope: 'project', scopeRoot: root, targets: ['fake'], stateRoot, ledger });
  assert.equal(result.verification.ok, true);
  assert.ok(adapter.calls.some(([name]) => name === 'remove'));
  assert.ok(adapter.calls.some(([name, operation]) => name === 'verify' && operation === 'remove'));
  assert.equal(result.ledger.resources.length, 0, 'ownership is removed only after absence verification succeeds');
  assert.equal(result.verification.verifications[0].statuses[0].status, 'removed');
});

test('a mid-loop adapter throw during apply marks the recovery record failed with the harnesses that completed, instead of leaving it pending forever', () => {
  const multiRegistry = {
    harnesses: [
      { id: 'fake', displayName: 'Fake', adapter: 'fake', scopes: ['project', 'user'], nativeTargets: {}, capabilities: { instructions: { status: 'supported' } } },
      { id: 'fake2', displayName: 'Fake2', adapter: 'fake2', scopes: ['project', 'user'], nativeTargets: {}, capabilities: { instructions: { status: 'supported' } } },
    ],
    assets: [{ id: 'guidance.fake', kind: 'guidance', source: 'ignored', appliesTo: ['fake', 'fake2'], ownership: 'managed-file',
      projection: { fake: { renderer: 'fake', capability: 'instructions' }, fake2: { renderer: 'fake', capability: 'instructions' } } }],
    mcp: [], lifecycle: [],
  };
  const adapter1 = fakeAdapter();
  const adapter2 = fakeAdapter();
  adapter2.apply = () => { throw new Error('disk full'); };
  const adapters = createAdapterRegistry({ fake: adapter1, fake2: adapter2 });
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-state-'));
  const plan = planLifecycle({ registry: multiRegistry, adapters, scope: 'project', scopeRoot: root, targets: ['fake', 'fake2'] });
  assert.throws(() => applyLifecycle({ plan, registry: multiRegistry, adapters, stateRoot }), /disk full/);
  const recoveryDir = path.join(stateRoot, 'recovery');
  const files = fs.readdirSync(recoveryDir);
  assert.equal(files.length, 1, 'one recovery record, updated in place rather than left as a second pending one');
  const record = JSON.parse(fs.readFileSync(path.join(recoveryDir, files[0]), 'utf8'));
  assert.equal(record.status, 'failed');
  assert.deepEqual(record.completedHarnesses, ['fake']);
  assert.equal(record.error, 'disk full');
  assert.ok(!fs.existsSync(path.join(stateRoot, 'ledger.json')), 'ledger must not be updated on a partial failure');
});

test('expected removed absence recomputes a provisional false verification, but unrelated missing remains false', () => {
  const removal = { harness: 'fake', assetId: 'guidance.fake', target: 'FAKE.md', ownershipIdentity: 'fake:guidance', operation: 'remove' };
  const expected = normalizeRemovalVerification({ harness: 'fake', ok: false, resources: [], statuses: [{ ...removal, status: 'missing' }], conflicts: [] }, [removal]);
  assert.equal(expected.ok, true);
  assert.equal(expected.statuses[0].status, 'removed');

  const unrelated = normalizeRemovalVerification({ harness: 'fake', ok: false, resources: [], statuses: [
    { ...removal, status: 'missing' },
    { harness: 'fake', assetId: 'other.asset', target: 'OTHER.md', ownershipIdentity: 'other', status: 'missing' },
  ], conflicts: [] }, [removal]);
  assert.equal(unrelated.ok, false);
  assert.equal(unrelated.statuses[1].status, 'missing');
});
