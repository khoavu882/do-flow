'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  stateRoot, ledgerPath, defaultLedger, readLedger, writeLedger,
  writeRecoveryRecord, readRecoveryRecord,
} = require('../../src/state/index.ts');
const { tempDir } = require('../helper/tmp.ts');

const DATE = new Date('2026-07-24T12:34:56Z');
function scratch(t: any) { return tempDir(t, 'doflow-state-'); }

test('state roots are neutral and scope-specific', (t) => {
  const root = scratch(t);
  assert.equal(stateRoot({ scope: 'project', projectRoot: root }), path.join(root, '.doflow', 'state'));
  assert.equal(stateRoot({ scope: 'global', homeDir: root }), path.join(root, '.doflow', 'state'));
  assert.throws(() => stateRoot({ scope: 'other', projectRoot: root }), /Invalid state scope/);
});

test('ledger writes atomically and round-trips without a harness directory', (t) => {
  const root = path.join(scratch(t), 'project', '.doflow', 'state');
  const ledger = defaultLedger({ scope: 'project', scopeRoot: path.dirname(path.dirname(root)) });
  ledger.resources.push({ harness: 'antigravity', scope: 'project', assetId: 'guidance.core', target: 'AGENTS.md', ownershipIdentity: 'managed-section' });
  writeLedger(root, ledger);
  assert.deepEqual(readLedger(root), ledger);
  assert.equal(fs.readdirSync(root).filter((file: any) => file.endsWith('.tmp')).length, 0);
  assert.ok(fs.existsSync(ledgerPath(root)));
});

test('recovery records are append-only, atomically readable journals', (t) => {
  const root = path.join(scratch(t), '.doflow', 'state');
  const first = writeRecoveryRecord(root, { changes: [{ operation: 'update', target: '.codex/config.toml' }] }, { now: DATE });
  const second = writeRecoveryRecord(root, { status: 'verified' }, { now: DATE });
  assert.notEqual(first.id, second.id);
  assert.equal(readRecoveryRecord(root, first.id).status, 'pending');
  assert.equal(readRecoveryRecord(root, first.id).changes[0].target, '.codex/config.toml');
  assert.throws(() => readRecoveryRecord(root, '../escape'), /Invalid recovery id/);
});
