'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, removeTree } = require('../helper/tmp.ts');
const { createDeliveryEntry, recordDelivery, makeTokenRecord } = require('../../src/runtime/context/delivery-store.ts');
const { groupOmissions } = require('../../src/runtime/context/compose.ts');

function fixtureEntry(digest, firstAt = new Date().toISOString()) {
  return {
    key: `${digest}.json.unstated`, packDigest: digest, form: 'json', harness: null, firstAt,
    mode: 'full', budget: { maxBytes: 1024, source: 'task-class' }, since: null, deltaRefused: null,
    retention: { status: 'unknown', basis: 'test' }, items: {}, mandatoryIds: [], sources: {}, pointers: [],
    bytes: 20, tokens: makeTokenRecord(20), omissions: [], expansions: [],
  };
}

test('context delivery store keeps newest five and preserves the first writer for a key', (t) => {
  const root = tempDir(t, 'doflow-delivery-');
  try {
    for (let i = 0; i < 6; i += 1) {
      const entry = fixtureEntry(`sha256:${String(i).padStart(64, '0')}`, new Date(i * 1000).toISOString());
      recordDelivery({ projectRoot: root, taskId: 'D.2', entry });
    }
    const file = path.join(root, '.doflow/state/delivery', 'D.2.json');
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(disk.deliveries.length, 5);
    assert.equal(disk.deliveries[0].packDigest, `sha256:${String(1).padStart(64, '0')}`);
    const original = disk.deliveries[4].firstAt;
    recordDelivery({ projectRoot: root, taskId: 'D.2', entry: fixtureEntry(disk.deliveries[4].packDigest, 'later') });
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.deliveries[4].firstAt, original);
    assert.equal(after.deliveries.length, 5);
    assert.equal(after.revision, disk.revision, 'an identical delivery does not bump the state revision');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('context delivery refuses missing telemetry, estimated actual basis, and empty expansion reasons', (t) => {
  const root = tempDir(t, 'doflow-delivery-validation-');
  const valid = fixtureEntry(`sha256:${'a'.repeat(64)}`);
  try {
    const noTokens = { ...valid };
    delete noTokens.tokens;
    assert.throws(() => recordDelivery({ projectRoot: root, taskId: 'T1', entry: noTokens }), /tokens\.estimated/);
    assert.throws(() => recordDelivery({ projectRoot: root, taskId: 'T1', entry: { ...valid,
      tokens: { estimated: { value: 5, basis: 'estimated:bytes/4' }, actual: { value: 5, basis: 'estimated:bytes/4' } } } }), /estimated basis/);
    assert.throws(() => recordDelivery({ projectRoot: root, taskId: 'T1', entry: { ...valid,
      expansions: [{ reason: '  ' }] } }), /reason must not be empty/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('context delivery entry hashes ordered item digests and records byte telemetry', () => {
  const pack = {
    mode: 'full', size: { totalBytes: 17 }, budget: { maxBytes: 100, source: 'task-class' },
    delivery: { packDigest: `sha256:${'b'.repeat(64)}` }, pointers: [], omissions: { groups: [] },
    deliveryItems: [
      { id: 'objective', digest: `sha256:${'1'.repeat(64)}`, cls: 'mandatory' },
      { id: 'file:a', digest: `sha256:${'2'.repeat(64)}`, cls: 'optional' },
    ], deliveryOmissions: [],
  };
  const entry = createDeliveryEntry({ pack, form: 'markdown' });
  assert.deepEqual(entry.items, { objective: `sha256:${'1'.repeat(64)}`, 'file:a': `sha256:${'2'.repeat(64)}` });
  assert.deepEqual(entry.mandatoryIds, ['objective']);
  assert.deepEqual(entry.tokens, {
    estimated: { value: 5, basis: 'estimated:bytes/4' },
    actual: { unmeasured: 'no harness reports token usage to an external CLI; profile tokenTelemetry unverified' },
  });
});

test('context delivery compresses consecutive omissions only after recording', () => {
  const omitted = [1, 2, 3].map((n) => ({ id: `ac:${n}`, field: 'acceptanceCriteria', reason: 'budget' }));
  const transient = groupOmissions(omitted);
  assert.deepEqual(transient.groups[0].ids, ['ac:1', 'ac:2', 'ac:3']);
  assert.deepEqual(transient.groups[0].ranges, []);
  const recorded = groupOmissions(omitted, true);
  assert.deepEqual(recorded.groups[0].ids, []);
  assert.deepEqual(recorded.groups[0].ranges, [{ field: 'acceptanceCriteria', from: 'ac:1', to: 'ac:3', count: 3 }]);
});

test('context delivery reports a held lock without persisting or exposing a key', (t) => {
  const root = tempDir(t, 'doflow-delivery-lock-');
  try {
    const entry = fixtureEntry(`sha256:${'c'.repeat(64)}`);
    assert.throws(() => recordDelivery({ projectRoot: root, taskId: 'T1', entry,
      acquire: () => { const error = new Error('store-locked'); error.code = 'store-locked'; throw error; } }), (error) => error.code === 'store-locked');
    assert.equal(fs.existsSync(path.join(root, '.doflow/state/delivery/T1.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('context pack recording failures preserve the readable pack and exit status', (t) => {
  const root = tempDir(t, 'doflow-context-pack-delivery-');
  const cli = path.resolve(__dirname, '../../bin/doflow.js');
  const run = (args) => spawnSync(process.execPath, [cli, 'context-pack', '--task-id', 'T1', '--json', ...args, root], { encoding: 'utf8' });
  try {
    const noRecord = run(['--no-record']);
    assert.equal(noRecord.status, 1);
    assert.equal(JSON.parse(noRecord.stdout).delivery.reason, 'no-record');
    assert.equal(JSON.parse(noRecord.stdout).delivery.key, null);
    assert.equal(fs.existsSync(path.join(root, '.doflow/state/delivery/T1.json')), false);
    const noRecordPack = JSON.parse(noRecord.stdout);
    assert.equal(noRecordPack.accounting.tokens.estimated.value, Math.ceil(Buffer.byteLength(noRecord.stdout) / 4));
    assert.equal('inlineTokensEst' in noRecordPack.accounting, false);

    const recorded = run([]);
    assert.equal(recorded.status, 1);
    const deliveredPack = JSON.parse(recorded.stdout);
    assert.equal(deliveredPack.delivery.recorded, true);
    assert.ok(deliveredPack.delivery.key);
    const deliveryFile = path.join(root, '.doflow/state/delivery/T1.json');
    const diskEntry = JSON.parse(fs.readFileSync(deliveryFile, 'utf8')).deliveries[0];
    assert.equal(diskEntry.bytes, Buffer.byteLength(recorded.stdout));
    assert.equal(diskEntry.tokens.estimated.value, Math.ceil(Buffer.byteLength(recorded.stdout) / 4));
    const firstRevision = JSON.parse(fs.readFileSync(deliveryFile, 'utf8')).revision;
    const repeated = run([]);
    assert.equal(repeated.status, recorded.status);
    assert.equal(JSON.parse(fs.readFileSync(deliveryFile, 'utf8')).revision, firstRevision);

    const lockDir = path.join(root, '.doflow/state/delivery/T1.json.lock');
    fs.mkdirSync(lockDir);
    const locked = run([]);
    assert.equal(locked.status, 1);
    const lockedPack = JSON.parse(locked.stdout);
    assert.equal(lockedPack.delivery.recorded, false);
    assert.equal(lockedPack.delivery.reason, 'store-locked');
    assert.equal(lockedPack.delivery.key, null);
    assert.equal(lockedPack.accounting.tokens.estimated.value, Math.ceil(Buffer.byteLength(locked.stdout) / 4));
    assert.equal('inlineTokensEst' in lockedPack.accounting, false);
    fs.rmSync(lockDir, { recursive: true, force: true });

    if (process.getuid?.() !== 0 && process.platform !== 'win32') {
      fs.rmSync(deliveryFile, { force: true });
      fs.chmodSync(path.dirname(deliveryFile), 0o555);
      const lockedByPermissions = run([]);
      assert.equal(lockedByPermissions.status, noRecord.status);
      assert.ok(lockedByPermissions.stdout.length > 0);
      const readonlyPack = JSON.parse(lockedByPermissions.stdout);
      assert.equal(readonlyPack.delivery.recorded, false);
      assert.equal(readonlyPack.delivery.key, null);
      assert.equal(readonlyPack.delivery.reason, 'store-unwritable');
      fs.chmodSync(path.dirname(deliveryFile), 0o755);
    }

    fs.rmSync(deliveryFile, { force: true });
    for (const [contents, label] of [['{"deliveries":[', 'torn'], ['{"version":2,"deliveries":[]}', 'future']]) {
      fs.writeFileSync(deliveryFile, contents, 'utf8');
      const unreadable = run([]);
      assert.equal(unreadable.status, noRecord.status, `${label} state preserves exit`);
      assert.ok(unreadable.stdout.length > 0, `${label} state preserves pack output`);
      const unreadablePack = JSON.parse(unreadable.stdout);
      assert.equal(unreadablePack.delivery.recorded, false);
      assert.equal(unreadablePack.delivery.key, null);
      assert.equal(unreadablePack.delivery.reason, 'store-unreadable');
    }
  } finally {
    try { fs.chmodSync(path.join(root, '.doflow/state/delivery'), 0o755); } catch { /* absent or already writable */ }
    removeTree(root);
  }
});
