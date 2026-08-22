'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { STATE_VERSION, LEDGER_VERSION, defaultLedger, upgradeLedger, readLedger, writeLedger } = require('../../src/state');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ledgerv2-')); }

test('new ledgers are written as v2 and carry an empty tombstone log', () => {
  const project = scratch();
  const ledger = defaultLedger({ scope: 'project', scopeRoot: project });
  assert.equal(ledger.version, LEDGER_VERSION);
  assert.deepEqual(ledger.tombstones, []);
  const root = path.join(project, '.doflow', 'state');
  writeLedger(root, ledger);
  assert.deepEqual(readLedger(root), ledger);
});

test('v1 ledgers remain readable and round-trip untouched', () => {
  const project = scratch();
  const legacy = defaultLedger({ scope: 'project', scopeRoot: project });
  delete legacy.tombstones;
  legacy.version = STATE_VERSION;
  const root = path.join(project, '.doflow', 'state');
  writeLedger(root, legacy);
  assert.deepEqual(readLedger(root), legacy);
});

test('upgradeLedger converts v1 in memory, is idempotent, and never mutates its input', () => {
  const project = scratch();
  const v1 = defaultLedger({ scope: 'project', scopeRoot: project });
  delete v1.tombstones;
  v1.version = STATE_VERSION;
  const upgraded = upgradeLedger(v1);
  assert.equal(upgraded.version, LEDGER_VERSION);
  assert.deepEqual(upgraded.tombstones, []);
  assert.equal(upgradeLedger(upgraded), upgraded);
  assert.equal(v1.version, STATE_VERSION);
  assert.ok(!('tombstones' in v1));
});

test('unknown versions are rejected and tombstones must stay an array', () => {
  const project = scratch();
  assert.throws(() => validateVersion(99), /Unsupported neutral ledger version/);
  const root = path.join(project, '.doflow', 'state');
  const broken = defaultLedger({ scope: 'project', scopeRoot: project });
  broken.tombstones = 'not-an-array';
  assert.throws(() => writeLedger(root, broken), /tombstones must be an array/);
});

function validateVersion(version) {
  // Exercise the version guard directly through a minimal well-formed body.
  return require('../../src/state').validateLedger({
    version, scope: 'project', scopeRoot: scratch(), targets: {}, mcpSelections: {},
    resources: [], legacyImports: [],
  });
}
