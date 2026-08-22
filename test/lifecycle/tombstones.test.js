'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { updateLedger } = require('../../src/lifecycle');
const { defaultLedger, LEDGER_VERSION } = require('../../src/state');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-tombstone-')); }
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function resource(target, identity) {
  return {
    harness: 'codex', scope: 'project', assetId: 'skills.doflow', target,
    ownershipIdentity: `doflow:codex:copy-tree:skills.doflow:${identity}`, kind: 'copy-tree-file',
    identity, fingerprint: null, sourceVersion: 'test', projection: { renderer: 'copy-tree' },
  };
}

function verification(row) {
  return { harness: row.harness, ok: true, statuses: [], conflicts: [], resources: [row] };
}

test('a relocated claim records a tombstone and sweeps the byte-identical stale copy', () => {
  const project = scratch();
  const oldPath = path.join(project, '.codex', 'skills', 'do-x', 'SKILL.md');
  const newPath = path.join(project, '.agents', 'skills', 'do-x', 'SKILL.md');
  fs.mkdirSync(path.dirname(oldPath), { recursive: true });
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  const ownedBytes = '# DoFlow-owned instructions\n';
  fs.writeFileSync(oldPath, ownedBytes);

  const ledger = defaultLedger({ scope: 'project', scopeRoot: project });
  const first = updateLedger({
    ledger, scope: 'project', scopeRoot: project,
    verifications: [verification(resource(oldPath, 'do-x/SKILL.md'))], changes: [],
  });
  assert.deepEqual(first.tombstones.filter((t) => t.toTarget === newPath), []);

  const movedRow = { ...resource(newPath, 'do-x/SKILL.md'), fingerprint: sha256(ownedBytes) };
  // The prior row must carry the verified fingerprint — that is what authorizes the sweep.
  first.resources[0].fingerprint = sha256(ownedBytes);
  // In production the apply step materialises the new location before its verification updates
  // the ledger; simulate that ordering here.
  fs.writeFileSync(newPath, ownedBytes);
  const second = updateLedger({
    ledger: first, scope: 'project', scopeRoot: project,
    verifications: [verification(movedRow)], changes: [],
  });
  assert.equal(second.version, LEDGER_VERSION);
  const tombstone = second.tombstones.find((entry) => entry.toTarget === newPath);
  assert.ok(tombstone, 'the relocation must be journaled');
  assert.equal(tombstone.fromTarget, oldPath);
  assert.ok(tombstone.sweptAt, 'byte-identical stale copy is swept');
  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(fs.existsSync(newPath), true);
});

test('a user-edited stale copy is never swept: it stays, and the tombstone stays visible', () => {
  const project = scratch();
  const oldPath = path.join(project, '.codex', 'skills', 'do-y', 'SKILL.md');
  const newPath = path.join(project, '.agents', 'skills', 'do-y', 'SKILL.md');
  fs.mkdirSync(path.dirname(oldPath), { recursive: true });
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.writeFileSync(oldPath, '# user edits live here\n');

  const ledger = defaultLedger({ scope: 'project', scopeRoot: project });
  const priorRow = { ...resource(oldPath, 'do-y/SKILL.md'), fingerprint: sha256('# something else entirely\n') };
  const seeded = updateLedger({ ledger, scope: 'project', scopeRoot: project, verifications: [verification(priorRow)], changes: [] });

  const moved = updateLedger({
    ledger: seeded, scope: 'project', scopeRoot: project,
    verifications: [verification({ ...resource(newPath, 'do-y/SKILL.md'), fingerprint: sha256('x') })], changes: [],
  });
  const tombstone = moved.tombstones.find((entry) => entry.toTarget === newPath);
  assert.ok(tombstone && !tombstone.sweptAt, 'mismatched bytes must not be swept silently');
  assert.equal(fs.existsSync(oldPath), true, 'user content outranks tidiness');
});

test('re-running the same reconciliation adds no duplicate tombstones', () => {
  const project = scratch();
  const oldPath = path.join(project, '.codex', 'skills', 'do-z', 'SKILL.md');
  const newPath = path.join(project, '.agents', 'skills', 'do-z', 'SKILL.md');
  fs.mkdirSync(path.dirname(newPath), { recursive: true });

  const ledger = defaultLedger({ scope: 'project', scopeRoot: project });
  const seeded = updateLedger({
    ledger, scope: 'project', scopeRoot: project,
    verifications: [verification({ ...resource(oldPath, 'do-z/SKILL.md'), fingerprint: sha256('bytes') })], changes: [],
  });
  const once = updateLedger({
    ledger: seeded, scope: 'project', scopeRoot: project,
    verifications: [verification({ ...resource(newPath, 'do-z/SKILL.md'), fingerprint: sha256('bytes') })], changes: [],
  });
  const twice = updateLedger({
    ledger: once, scope: 'project', scopeRoot: project,
    verifications: [verification({ ...resource(newPath, 'do-z/SKILL.md'), fingerprint: sha256('bytes') })], changes: [],
  });
  assert.equal(
    twice.tombstones.filter((entry) => entry.fromTarget === oldPath && entry.toTarget === newPath).length,
    1,
    'relocation journaling is deduplicated',
  );
});
