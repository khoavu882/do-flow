'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tempDir } = require('../helper/tmp.ts');
const { ContextPackCompiler, handleContextPackCommand } = require('../../src/runtime/context-pack.ts');
const { resolveBudget, getRegisteredHarnessIds, getRegisteredHarnesses } = require('../../src/runtime/context/budget.ts');
const { createDeliveryEntry, recordDelivery } = require('../../src/runtime/context/delivery-store.ts');
const { buildClaimSupportedItem, buildObjectiveItem, buildAcceptanceCriteriaItem } = require('../../src/runtime/context/compose.ts');

const digest = (text) => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
const fixtureProfiles = (retention = { value: 'supported', source: 'fixture', verifiedOn: '2026-10-13' }) =>
  getRegisteredHarnesses().map((harness) => ({ ...harness, contextProfile: { ...harness.contextProfile, retention } }));

function capturePack(t, options) {
  const output = [];
  const original = console.log;
  const originalExitCode = process.exitCode;
  console.log = (text) => output.push(text);
  try {
    const exitCode = handleContextPackCommand({ json: true, ...options });
    return { exitCode, pack: JSON.parse(output.at(-1)) };
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }
}

function seedDelivery(root, taskId, { items = {}, sources = {}, harness = 'claude' } = {}) {
  const deliveryItems = Object.entries(items).map(([id, itemDigest]) => ({ id, digest: itemDigest, cls: id === 'objective' ? 'mandatory' : 'optional' }));
  const pack = {
    mode: 'full', size: { totalBytes: 1 }, budget: { maxBytes: 225000, source: 'task-class' },
    delivery: { packDigest: digest(`prior:${taskId}:${JSON.stringify(items)}`) }, pointers: [],
    deliveryItems, deliveryAllItems: deliveryItems, deliveryOmissions: [],
  };
  const entry = createDeliveryEntry({ pack, form: 'json', harness, sources });
  recordDelivery({ projectRoot: root, taskId, entry });
  return entry;
}

test('D.3 emits deltas only for a supported fixture profile and keeps every mandatory item inline', () => {
  const compiler = new ContextPackCompiler();
  const profiles = fixtureProfiles();
  const budget = resolveBudget({ taskClass: 'feature', harnessFlag: 'claude', profiles });
  const fixture = {
    taskId: 'D.3', objective: 'Ship safely', acceptanceCriteria: ['Must preserve mandatory context'],
    claims: { supported: [{ id: 'claim-1', statement: 'unchanged fact', evidenceIds: [] }] },
    mandatory: { fields: { objective: 'Ship safely', acceptanceCriteria: ['Must preserve mandatory context'] } },
    budget, harness: 'claude', since: digest('previous'), mode: 'delta',
    deltaSinceEntry: { items: {
      'claim-1': buildClaimSupportedItem({ id: 'claim-1', statement: 'unchanged fact', evidenceIds: [] }).digest,
      'ac:1': buildAcceptanceCriteriaItem('Must preserve mandatory context', 0).digest,
    } },
  };
  const pack = compiler.compileContextPack(fixture);
  assert.equal(pack.mode, 'delta');
  assert.ok(pack.acceptanceCriteria.some((item) => item.text === 'Must preserve mandatory context'));
  assert.deepEqual(pack.delta.unchanged, ['ac:1', 'claim-1']);
  assert.equal(pack.omissions.groups.find((group) => group.reason === 'unchanged')?.ids[0], 'claim-1');
});

test('D.3 reads the prior task delivery and produces a supported-profile delta end to end', (t) => {
  const root = tempDir(t, 'doflow-delta-supported-');
  const profiles = fixtureProfiles();
  const objective = 'Ship safely';
  const prior = seedDelivery(root, 'D.3', { items: { objective: buildObjectiveItem(objective).digest } });
  const result = capturePack(t, { taskId: 'D.3', stateRoot: root, harness: 'claude', profiles, since: prior.packDigest, objective });
  assert.equal(result.exitCode, 1);
  assert.equal(result.pack.mode, 'delta');
  assert.deepEqual(result.pack.delta, { since: prior.packDigest, added: [], changed: [], removed: [], unchanged: ['objective'] });
  assert.equal(result.pack.objective, objective);
});

test('D.3 removal ids render in markdown and deltas never omit mandatory items', () => {
  const compiler = new ContextPackCompiler();
  const pack = compiler.compileContextPack({
    taskId: 'D.3', objective: 'Ship safely', acceptanceCriteria: ['Keep this'],
    mandatory: { fields: { objective: 'Ship safely', acceptanceCriteria: ['Keep this'] } },
    budget: resolveBudget({ taskClass: 'feature' }), since: digest('old'), mode: 'delta',
    deltaSinceEntry: { items: { objective: digest('old objective'), 'ac:1': digest('old AC'), 'file:gone': digest('removed') } },
  });
  assert.deepEqual(pack.delta.removed, ['file:gone']);
  assert.match(compiler.formatMarkdown(pack), /### Removed since sha256:/);
  assert.match(compiler.formatMarkdown(pack), /- file:gone/);
  assert.ok(pack.acceptanceCriteria.length === 1);
});

test('D.3 keeps added optional items inline even when the delta overflows its cap', () => {
  const compiler = new ContextPackCompiler();
  const claim = { id: 'claim-new', statement: 'New fact', evidenceIds: [] };
  const pack = compiler.compileContextPack({
    taskId: 'D.3', claims: { supported: [claim] },
    budget: resolveBudget({ taskClass: 'feature', maxBytes: 1 }),
    since: digest('old'), mode: 'delta', deltaSinceEntry: { items: {} },
  });
  assert.equal(pack.status, 'OVERFLOW');
  assert.deepEqual(pack.delta.added, ['claim-new']);
  assert.equal(pack.claims.supported[0].statement, 'New fact');
});

test('D.3 refuses unknown digests and changed sources before retention checks, recording delta-widened', (t) => {
  const root = tempDir(t, 'doflow-delta-refusal-');
  const profiles = fixtureProfiles();
  const taskId = 'D.3';
  const sourcePath = path.join(root, 'source.txt');
  fs.writeFileSync(sourcePath, 'new contents');
  const sourceRel = 'source.txt';
  const old = seedDelivery(root, taskId, { sources: { [sourceRel]: digest('old contents') } });
  const changed = capturePack(t, { taskId, stateRoot: root, harness: 'claude', profiles, since: old.packDigest, objective: 'Work' });
  assert.equal(changed.pack.mode, 'full');
  assert.equal(changed.pack.delivery.deltaRefused, 'sources-changed');
  const disk = JSON.parse(fs.readFileSync(path.join(root, '.doflow/state/delivery', `${taskId}.json`), 'utf8'));
  assert.equal(disk.deliveries.at(-1).expansions.at(-1).kind, 'delta-widened');
  assert.equal(disk.deliveries.at(-1).expansions.at(-1).reason, 'sources-changed');

  const unknown = capturePack(t, { taskId: 'unknown', stateRoot: root, harness: 'claude', profiles, since: digest('missing'), objective: 'Work' });
  assert.equal(unknown.pack.delivery.deltaRefused, 'since-unknown');
});

test('D.3 refuses production profiles for all eight harnesses with full-pack parity', (t) => {
  const root = tempDir(t, 'doflow-delta-parity-');
  const profiles = fixtureProfiles({ unverified: 'values belong to 085 (A-19)', verifiedOn: '2026-10-13' });
  const ids = getRegisteredHarnessIds();
  assert.equal(ids.length, 8);
  const outputs = [];
  for (const id of ids) {
    const taskId = `T-${id}`;
    const prior = seedDelivery(root, taskId, { harness: id });
    const result = capturePack(t, { taskId, stateRoot: root, harness: id, profiles, since: prior.packDigest, objective: 'Same objective' });
    assert.equal(result.pack.mode, 'full');
    assert.equal(result.pack.delivery.deltaRefused, 'retention-unproven');
    outputs.push({ selection: result.pack.delivery.packDigest, mandatory: result.pack.acceptanceCriteria });
  }
  assert.ok(outputs.every((item) => item.selection === outputs[0].selection));
  assert.ok(outputs.every((item) => JSON.stringify(item.mandatory) === JSON.stringify(outputs[0].mandatory)));
});

test('D.3 validates --since syntax as a usage error', (t) => {
  const root = tempDir(t, 'doflow-delta-syntax-');
  const result = capturePack(t, { taskId: 'D.3', stateRoot: root, since: 'sha256:BAD' });
  assert.equal(result.exitCode, 2);
});
