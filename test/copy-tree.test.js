'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverTree, planTree, applyTree, removeTree, verifyTree } = require('../src/adapters/copy-tree');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-copy-tree-')); }

function seedSource(root, files) {
  const sourceDir = path.join(root, 'source');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(sourceDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return sourceDir;
}

function sha256(text) { return require('node:crypto').createHash('sha256').update(text).digest('hex'); }

test('discoverTree lists nested files with source fingerprints and dest existence', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A', 'nested/b.md': 'B' });
  const destDir = path.join(root, 'dest');
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'a.md'), 'A');

  const { files } = discoverTree({ sourceDir, destDir });
  const byRel = Object.fromEntries(files.map((f) => [f.relPath, f]));
  assert.equal(files.length, 2);
  assert.equal(byRel['a.md'].exists, true);
  assert.equal(byRel['nested/b.md'].exists, false);
  assert.equal(byRel['a.md'].fingerprint, sha256('A'));
});

test('planTree proposes create for every file on a fresh (empty) destination', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A', 'nested/b.md': 'B' });
  const destDir = path.join(root, 'dest');

  const { changes, conflicts } = planTree({ sourceDir, destDir });
  assert.deepEqual(conflicts, []);
  assert.equal(changes.length, 2);
  assert.ok(changes.every((c) => c.operation === 'create'));
});

test('applyTree writes files and preserves the source file mode (hook script +x survives)', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'hook.sh': '#!/usr/bin/env bash\necho hi\n' });
  fs.chmodSync(path.join(sourceDir, 'hook.sh'), 0o755);
  const destDir = path.join(root, 'dest');

  const { changes } = planTree({ sourceDir, destDir });
  const { applied } = applyTree({ changes });
  assert.equal(applied, 1);
  assert.equal(fs.readFileSync(path.join(destDir, 'hook.sh'), 'utf8'), '#!/usr/bin/env bash\necho hi\n');
  assert.equal(fs.statSync(path.join(destDir, 'hook.sh')).mode & 0o777, 0o755);
});

test('re-planning after an unchanged apply reports zero changes (idempotent convergence)', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A' });
  const destDir = path.join(root, 'dest');
  const first = planTree({ sourceDir, destDir });
  applyTree({ changes: first.changes });
  const previousResources = first.changes.map((c) => ({ relPath: c.relPath, fingerprint: c.fingerprint }));

  const second = planTree({ sourceDir, destDir, previousResources });
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.conflicts, []);
});

test('planTree proposes update only for the file whose source content actually changed', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A', 'b.md': 'B' });
  const destDir = path.join(root, 'dest');
  const first = planTree({ sourceDir, destDir });
  applyTree({ changes: first.changes });
  const previousResources = first.changes.map((c) => ({ relPath: c.relPath, fingerprint: c.fingerprint }));

  fs.writeFileSync(path.join(sourceDir, 'a.md'), 'A2');
  const { changes } = planTree({ sourceDir, destDir, previousResources });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].relPath, 'a.md');
  assert.equal(changes[0].operation, 'update');
});

test('planTree proposes remove for a previously-owned file no longer present in source', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A', 'b.md': 'B' });
  const destDir = path.join(root, 'dest');
  const first = planTree({ sourceDir, destDir });
  applyTree({ changes: first.changes });
  const previousResources = first.changes.map((c) => ({ relPath: c.relPath, fingerprint: c.fingerprint }));

  fs.rmSync(path.join(sourceDir, 'b.md'));
  const { changes } = planTree({ sourceDir, destDir, previousResources });
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], { relPath: 'b.md', target: path.join(destDir, 'b.md'), operation: 'remove', fingerprint: sha256('B') });
});

test('removeTree deletes owned files and refuses a file modified since planning', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A', 'b.md': 'B' });
  const destDir = path.join(root, 'dest');
  applyTree({ changes: planTree({ sourceDir, destDir }).changes });
  const previousResources = [{ relPath: 'a.md', fingerprint: sha256('A') }, { relPath: 'b.md', fingerprint: sha256('B') }];

  const { changes } = planTree({ sourceDir, destDir, previousResources, operation: 'remove' });
  fs.writeFileSync(path.join(destDir, 'b.md'), 'TAMPERED');
  // a.md sorts before the tampered b.md in `changes` — removeTree processes it (and deletes it)
  // before reaching b.md and throwing; a throw on one file does not roll back another's already-
  // completed removal, matching Codex's own remove() semantics (no transactional rollback).
  assert.throws(() => removeTree({ changes }), /Refusing to remove modified copy-tree resource: b\.md/);
  assert.equal(fs.existsSync(path.join(destDir, 'a.md')), false);
  assert.equal(fs.existsSync(path.join(destDir, 'b.md')), true);
});

test('planTree reports a conflict (not a silent overwrite) for a destination file modified outside DoFlow', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A' });
  const destDir = path.join(root, 'dest');
  const first = planTree({ sourceDir, destDir });
  applyTree({ changes: first.changes });
  const previousResources = [{ relPath: 'a.md', fingerprint: sha256('A') }];

  fs.writeFileSync(path.join(destDir, 'a.md'), 'HAND-EDITED');
  fs.writeFileSync(path.join(sourceDir, 'a.md'), 'A2');
  const { changes, conflicts } = planTree({ sourceDir, destDir, previousResources });
  assert.equal(changes.length, 0);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /a\.md was modified outside DoFlow/);
});

test('planTree treats an already-present, content-identical file with no ledger record as a safe adoption', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A' });
  const destDir = path.join(root, 'dest');
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'a.md'), 'A'); // e.g. left over from the legacy copy path

  const { changes, conflicts } = planTree({ sourceDir, destDir });
  assert.deepEqual(conflicts, []);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].operation, 'create');
});

test('planTree reports a conflict for a foreign file with no ledger record and different content than source', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A' });
  const destDir = path.join(root, 'dest');
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'a.md'), 'FOREIGN CONTENT');

  const { changes, conflicts } = planTree({ sourceDir, destDir });
  assert.equal(changes.length, 0);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /a\.md was modified outside DoFlow/);
});

test('verifyTree reports owned resources when on-disk content matches source, and a conflict when it does not', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A' });
  const destDir = path.join(root, 'dest');
  applyTree({ changes: planTree({ sourceDir, destDir }).changes });

  const ok = verifyTree({ sourceDir, destDir });
  assert.equal(ok.ok, true);
  assert.equal(ok.resources.length, 1);

  fs.writeFileSync(path.join(destDir, 'a.md'), 'DRIFTED');
  const bad = verifyTree({ sourceDir, destDir });
  assert.equal(bad.ok, false);
  assert.equal(bad.conflicts.length, 1);
});

test('discoverTree throws when the source directory itself is missing', () => {
  const root = scratch();
  assert.throws(() => discoverTree({ sourceDir: path.join(root, 'nope'), destDir: path.join(root, 'dest') }),
    /copy-tree source is missing/);
});

// Regression: a destination-only file with no source counterpart (e.g. the generated
// .doflow/guidance/MCP_INDEX.md, written directly by applyLifecycle rather than through
// applyTree) must never surface as a copy-tree resource, conflict, or removal candidate — every
// enumeration in this module walks the SOURCE tree, never the destination tree independently.
test('discoverTree ignores a destination-only file with no source counterpart (orphan generated file)', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A', 'nested/b.md': 'B' });
  const destDir = path.join(root, 'dest');
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'MCP_INDEX.md'), 'generated, not source-tracked');

  const { files } = discoverTree({ sourceDir, destDir });
  assert.equal(files.length, 2);
  assert.ok(!files.some((f) => f.relPath === 'MCP_INDEX.md'));
});

test('verifyTree reports zero conflicts for a destination-only file with no source counterpart', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A' });
  const destDir = path.join(root, 'dest');
  applyTree({ changes: planTree({ sourceDir, destDir }).changes });
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'MCP_INDEX.md'), 'generated, not source-tracked');

  const result = verifyTree({ sourceDir, destDir });
  assert.equal(result.ok, true);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.resources.length, 1);
  assert.ok(!result.resources.some((r) => r.relPath === 'MCP_INDEX.md'));
});

test('planTree never proposes removal of a destination-only file absent from previousResources', () => {
  const root = scratch();
  const sourceDir = seedSource(root, { 'a.md': 'A' });
  const destDir = path.join(root, 'dest');
  const first = planTree({ sourceDir, destDir });
  applyTree({ changes: first.changes });
  const previousResources = first.changes.map((c) => ({ relPath: c.relPath, fingerprint: c.fingerprint }));
  // Simulate MCP_INDEX.md: present on disk, but never registered as a copy-tree ledger resource
  // because it was written directly via fs, not through applyTree.
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'MCP_INDEX.md'), 'generated, not source-tracked');

  const { changes, conflicts } = planTree({ sourceDir, destDir, previousResources });
  assert.deepEqual(conflicts, []);
  assert.deepEqual(changes, []); // a.md unchanged, no-op; MCP_INDEX.md never considered at all
});

const GUIDANCE_SOURCE = path.join(__dirname, '..', 'core/shared/guidance');
const DOFLOW_CORE = path.join(GUIDANCE_SOURCE, 'DOFLOW_CORE.md');

// The load-bearing contract, asserted structurally rather than as a byte-exact copy of the prose:
// every `@import` in DOFLOW_CORE.md is a path relative to the guidance ROOT, and must land on a
// real file there. Pinning the exact wording instead (as this test used to) made every deliberate
// edit to the doc look like a regression while still failing to catch a genuinely broken path.
test('every always-loaded @import in DOFLOW_CORE.md resolves to a real file in the guidance tree', () => {
  const content = fs.readFileSync(DOFLOW_CORE, 'utf8');
  const imports = content
    .split('\n')
    .filter((line) => line.startsWith('@'))
    .map((line) => line.slice(1).trim());

  assert.ok(imports.length > 0, 'DOFLOW_CORE.md must declare at least one always-loaded import');

  for (const rel of imports) {
    // MCP_INDEX.md is generated per install by applyLifecycle, so it has no core/ source
    // counterpart; its own resolution is guarded in test/mcp-index.test.js instead.
    if (rel === 'MCP_INDEX.md') continue;
    assert.ok(
      fs.existsSync(path.join(GUIDANCE_SOURCE, rel)),
      `DOFLOW_CORE.md imports '@${rel}', which does not exist under core/shared/guidance/`,
    );
  }
});

test('DOFLOW_CORE.md imports the generated per-install MCP index from the guidance root', () => {
  const content = fs.readFileSync(DOFLOW_CORE, 'utf8');
  assert.ok(content.includes('\n@MCP_INDEX.md'), 'MCP_INDEX.md must be imported root-relative');
  assert.ok(!content.includes('@docs/'), 'guidance/docs/ was flattened into the guidance root');
});

// The commented on-demand inventory is deliberately gone. It named modes/, references/ and mcp/
// in a form that read like a load mechanism but that nothing evaluates, so every resource it
// listed went unloaded for as long as it existed. Reachability is now a skill binding, enforced
// by test/guards/consumers.test.js.
test('DOFLOW_CORE.md carries no commented resource inventory', () => {
  const content = fs.readFileSync(DOFLOW_CORE, 'utf8');
  assert.ok(!content.includes('On-demand resources'), 'the inert inventory block must not return');
  const advertised = content.match(/^#\s+\w+.*→\s*@[a-z]+\//gm) ?? [];
  assert.deepEqual(advertised, [], 'a commented "→ @dir/" listing loads nothing; bind the resource to a skill instead');
});

